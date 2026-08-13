import {
  EmailQueueDeliveryPolicy,
  EmailQueueProducerRedis,
  EmailQueueSource,
  isRedisClusterTopology,
  RedisEncryptedEmailQueueProducer,
  RedisEncryptedEmailQueueProducerOptions,
  ValidatedEmailQueueProducerLimits,
  validateEmailQueueProducerLimits,
} from '@standardnotes/domain-core'
import { Logger } from 'winston'

import {
  EmailDeliveryCancellationResult,
  EmailDeliveryStatus,
  EmailSenderInterface,
  SendEmailOptions,
} from './EmailSenderInterface'

interface DurableEmailProducer {
  isReady(): Promise<boolean>
  getDeliveryStatus(deliveryId: string): Promise<EmailDeliveryStatus>
  cancelDelivery(deliveryId: string): Promise<EmailDeliveryCancellationResult>
  enqueue(
    message: {
      to: string
      subject: string
      text?: string
      html?: string
      attachments?: Array<{ filename: string; contentType?: string; contentBase64: string }>
    },
    source?: EmailQueueSource,
    deliveryId?: string,
    policy?: EmailQueueDeliveryPolicy,
  ): Promise<unknown>
}

/**
 * Auth-side durable email adapter. A successful result means Redis atomically
 * accepted an authenticated encrypted job; the gateway worker owns provider
 * delivery, retry, fallback, rate limiting, and redacted attempt telemetry.
 */
export class QueuedEmailSender implements EmailSenderInterface {
  readonly acceptanceMode = 'durable-queue' as const

  constructor(
    private readonly producer: DurableEmailProducer,
    private readonly logger: Logger,
    private readonly defaultSource: EmailQueueSource = 'account',
  ) {}

  static create(
    redis: ConstructorParameters<typeof RedisEncryptedEmailQueueProducer>[0],
    stableServerEncryptionSecret: string,
    logger: Logger,
    defaultSource: EmailQueueSource = 'account',
    producerOptions: RedisEncryptedEmailQueueProducerOptions = {},
  ): QueuedEmailSender {
    return new QueuedEmailSender(
      new RedisEncryptedEmailQueueProducer(
        redis,
        stableServerEncryptionSecret,
        producerOptions,
      ) as unknown as DurableEmailProducer,
      logger,
      defaultSource,
    )
  }

  async isConfigured(): Promise<boolean> {
    try {
      return await this.producer.isReady()
    } catch {
      return false
    }
  }

  async getDeliveryStatus(deliveryId: string): Promise<EmailDeliveryStatus> {
    try {
      return await this.producer.getDeliveryStatus(deliveryId)
    } catch (error) {
      this.logger.error('Failed to read durable email delivery status', {
        codeTag: 'QueuedEmailSender',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      throw new Error('Durable email delivery status is unavailable.')
    }
  }

  async cancelDelivery(deliveryId: string): Promise<EmailDeliveryCancellationResult> {
    try {
      return await this.producer.cancelDelivery(deliveryId)
    } catch (error) {
      this.logger.error('Failed to cancel durable email delivery', {
        codeTag: 'QueuedEmailSender',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      throw new Error('Durable email delivery cancellation is unavailable.')
    }
  }

  async sendEmail(to: string, subject: string, body: string, options?: SendEmailOptions): Promise<boolean> {
    try {
      if (!(await this.producer.isReady())) {
        this.logger.error('Durable email delivery worker is not ready', {
          codeTag: 'QueuedEmailSender',
        })
        return false
      }

      await this.producer.enqueue(
        {
          to,
          subject,
          ...(options?.html ? { html: body } : { text: body }),
          ...(options?.attachments && options.attachments.length > 0
            ? {
                attachments: options.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  contentType: attachment.contentType,
                  contentBase64: attachment.content.toString('base64'),
                })),
              }
            : {}),
        },
        options?.deliverySource ?? this.defaultSource,
        options?.deliveryId,
        {
          ...(options?.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
          ...(options?.retryMode !== undefined ? { retryMode: options.retryMode } : {}),
          ...(options?.supersessionKey !== undefined ? { supersessionKey: options.supersessionKey } : {}),
        },
      )
      return true
    } catch (error) {
      this.logger.error('Failed to enqueue email for durable delivery', {
        codeTag: 'QueuedEmailSender',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      return false
    }
  }
}

export function createAuthEmailSender(options: {
  redis?: EmailQueueProducerRedis
  stableServerEncryptionSecret?: string
  legacySmtpSender: EmailSenderInterface
  logger: Logger
  defaultSource?: EmailQueueSource
  producerOptions?: RedisEncryptedEmailQueueProducerOptions
}): EmailSenderInterface {
  validateEmailQueueProducerLimits(options.producerOptions ?? {})

  if (options.redis && isRedisClusterTopology(options.redis)) {
    options.logger.warn(
      'Durable email queue is disabled for Redis Cluster because node-local AOF persistence cannot be safely confirmed; using the legacy direct SMTP sender.',
      { codeTag: 'EmailDeliveryBootstrap' },
    )
    return options.legacySmtpSender
  }

  if (options.redis && /^[0-9a-fA-F]{64}$/.test(options.stableServerEncryptionSecret ?? '')) {
    return QueuedEmailSender.create(
      options.redis,
      options.stableServerEncryptionSecret as string,
      options.logger,
      options.defaultSource,
      options.producerOptions,
    )
  }

  options.logger.warn('Durable email queue prerequisites are unavailable; using the legacy direct SMTP sender.', {
    codeTag: 'EmailDeliveryBootstrap',
  })
  return options.legacySmtpSender
}

export function emailQueueProducerOptionsFromEnvironment(values: {
  maxAttempts?: string
  retentionMs?: string
  maxJobBytes?: string
  maxTotalBytes?: string
}): ValidatedEmailQueueProducerLimits {
  const numeric = (value: string | undefined): number | undefined => {
    return value === undefined || value === '' ? undefined : Number(value)
  }
  const options = {
    maxAttempts: numeric(values.maxAttempts),
    retentionMs: numeric(values.retentionMs),
    maxJobBytes: numeric(values.maxJobBytes),
    maxTotalBytes: numeric(values.maxTotalBytes),
  }

  return validateEmailQueueProducerLimits(options)
}

/**
 * Conservative upper bound for one raw attachment after base64, JSON and the
 * authenticated queue envelope's second base64 expansion. Keeping headroom for
 * headers/body prevents a configured backup cap from becoming a guaranteed
 * queue rejection or large avoidable allocation.
 */
export function maximumRawAttachmentBytesForQueue(maxJobBytes: number): number {
  if (!Number.isSafeInteger(maxJobBytes) || maxJobBytes < 1_024) {
    throw new Error('EMAIL_QUEUE_MAX_JOB_BYTES is invalid.')
  }
  return Math.max(0, Math.floor((maxJobBytes - 64 * 1_024) * (9 / 16)))
}

export function parseEmailAttachmentMaximumBytes(value: string | undefined): number {
  const raw = value?.trim()
  if (!raw) {
    return 10 * 1024 * 1024
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('EMAIL_ATTACHMENT_MAX_BYTE_SIZE must be a positive whole number.')
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed > 1024 * 1024 * 1024) {
    throw new Error('EMAIL_ATTACHMENT_MAX_BYTE_SIZE must be at most 1073741824 bytes.')
  }
  return parsed
}
