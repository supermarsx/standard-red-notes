import { decryptEmailQueuePayload, emailQueueWorkerReadinessValue } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { EmailSenderInterface } from './EmailSenderInterface'
import {
  createAuthEmailSender,
  emailQueueProducerOptionsFromEnvironment,
  maximumRawAttachmentBytesForQueue,
  parseEmailAttachmentMaximumBytes,
  QueuedEmailSender,
} from './QueuedEmailSender'

const SECRET = 'a'.repeat(64)

describe('QueuedEmailSender', () => {
  let logger: jest.Mocked<Logger>

  beforeEach(() => {
    logger = { error: jest.fn(), warn: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  it('maps auth HTML and attachments onto the canonical durable queue wire message', async () => {
    const producer = {
      isReady: jest.fn().mockResolvedValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn(),
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
    }
    const sender = new QueuedEmailSender(producer, logger, 'account')

    await expect(
      sender.sendEmail('person@example.com', 'Your backup', '<p>Attached</p>', {
        html: true,
        deliverySource: 'backup',
        deliveryId: 'backup-stable-id',
        attachments: [
          { filename: 'backup.json', contentType: 'application/json', content: Buffer.from('private backup') },
        ],
      }),
    ).resolves.toBe(true)

    expect(producer.enqueue).toHaveBeenCalledWith(
      {
        to: 'person@example.com',
        subject: 'Your backup',
        html: '<p>Attached</p>',
        attachments: [
          {
            filename: 'backup.json',
            contentType: 'application/json',
            contentBase64: Buffer.from('private backup').toString('base64'),
          },
        ],
      },
      'backup',
      'backup-stable-id',
      {},
    )
    expect(sender.acceptanceMode).toBe('durable-queue')
  })

  it('requires worker readiness for configuration and every send', async () => {
    const producer = {
      isReady: jest.fn().mockResolvedValue(false),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn(),
      enqueue: jest.fn(),
    }
    const sender = new QueuedEmailSender(producer, logger)

    await expect(sender.isConfigured()).resolves.toBe(false)
    await expect(sender.sendEmail('person@example.com', 'subject', 'body')).resolves.toBe(false)
    expect(producer.isReady).toHaveBeenCalledTimes(2)
    expect(producer.enqueue).not.toHaveBeenCalled()
  })

  it('fails configuration closed when the readiness check throws', async () => {
    const sender = new QueuedEmailSender(
      {
        isReady: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
        getDeliveryStatus: jest.fn(),
        cancelDelivery: jest.fn(),
        enqueue: jest.fn(),
      },
      logger,
    )

    await expect(sender.isConfigured()).resolves.toBe(false)
  })

  it.each(['pending', 'provider-accepted', 'dead', 'quarantined', 'discarded', 'superseded', 'missing'] as const)(
    'exposes the redacted durable delivery status %s',
    async (status) => {
      const producer = {
        isReady: jest.fn(),
        getDeliveryStatus: jest.fn().mockResolvedValue(status),
        cancelDelivery: jest.fn(),
        enqueue: jest.fn(),
      }
      const sender = new QueuedEmailSender(producer, logger)

      await expect(sender.getDeliveryStatus('reminder-safe-id')).resolves.toBe(status)
      expect(producer.getDeliveryStatus).toHaveBeenCalledWith('reminder-safe-id')
    },
  )

  it('fails status lookup closed without logging the deterministic delivery id', async () => {
    const producer = {
      isReady: jest.fn(),
      getDeliveryStatus: jest.fn().mockRejectedValue(new Error('redis details')),
      cancelDelivery: jest.fn(),
      enqueue: jest.fn(),
    }
    const sender = new QueuedEmailSender(producer, logger)

    await expect(sender.getDeliveryStatus('private-delivery-id')).rejects.toThrow(
      'Durable email delivery status is unavailable.',
    )
    expect(logger.error).toHaveBeenCalledWith('Failed to read durable email delivery status', {
      codeTag: 'QueuedEmailSender',
      errorName: 'Error',
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-delivery-id')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('redis details')
  })

  it.each(['cancelled', 'provider-accepted', 'in-flight'] as const)(
    'exposes the durable cancellation result %s',
    async (cancellationResult) => {
      const producer = {
        isReady: jest.fn(),
        getDeliveryStatus: jest.fn(),
        cancelDelivery: jest.fn().mockResolvedValue(cancellationResult),
        enqueue: jest.fn(),
      }
      const sender = new QueuedEmailSender(producer, logger)

      await expect(sender.cancelDelivery('reminder-safe-id')).resolves.toBe(cancellationResult)
      expect(producer.cancelDelivery).toHaveBeenCalledWith('reminder-safe-id')
    },
  )

  it('fails cancellation closed without logging the deterministic delivery id', async () => {
    const producer = {
      isReady: jest.fn(),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn().mockRejectedValue(new Error('redis private detail')),
      enqueue: jest.fn(),
    }
    const sender = new QueuedEmailSender(producer, logger)

    await expect(sender.cancelDelivery('private-delivery-id')).rejects.toThrow(
      'Durable email delivery cancellation is unavailable.',
    )
    expect(logger.error).toHaveBeenCalledWith('Failed to cancel durable email delivery', {
      codeTag: 'QueuedEmailSender',
      errorName: 'Error',
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-delivery-id')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('redis private detail')
  })

  it('does not bypass a configured durable queue with SMTP when Redis rejects enqueue', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(emailQueueWorkerReadinessValue(SECRET)),
      eval: jest.fn().mockRejectedValue(new Error('redis unavailable private@example.com')),
      waitaof: jest.fn().mockResolvedValue([1, 0]),
    }
    const legacy = {
      acceptanceMode: 'provider' as const,
      sendEmail: jest.fn().mockResolvedValue(true),
      isConfigured: jest.fn().mockReturnValue(true),
    } as jest.Mocked<EmailSenderInterface>
    const sender = createAuthEmailSender({
      redis,
      stableServerEncryptionSecret: SECRET,
      legacySmtpSender: legacy,
      logger,
    })

    await expect(sender.sendEmail('private@example.com', 'Private subject', 'Private body')).resolves.toBe(false)
    expect(legacy.sendEmail).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private@example.com')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Private')
  })

  it('stores no recipient, body, subject, or attachment plaintext in Redis', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(emailQueueWorkerReadinessValue(SECRET)),
      eval: jest.fn().mockResolvedValue(1),
      waitaof: jest.fn().mockResolvedValue([1, 0]),
    }
    const legacy = {
      acceptanceMode: 'provider' as const,
      sendEmail: jest.fn(),
      isConfigured: jest.fn(),
    } as unknown as EmailSenderInterface
    const sender = createAuthEmailSender({
      redis,
      stableServerEncryptionSecret: SECRET,
      legacySmtpSender: legacy,
      logger,
    })

    await sender.sendEmail('private@example.com', 'Private subject', 'Private body', {
      attachments: [{ filename: 'secret.txt', contentType: 'text/plain', content: Buffer.from('Private attachment') }],
    })

    const args = redis.eval.mock.calls[0]
    const keyCount = Number(args[1])
    const storedEnvelope = String(args[2 + keyCount + 1])
    const rawRedisCall = JSON.stringify(args)
    expect(rawRedisCall).not.toContain('private@example.com')
    expect(rawRedisCall).not.toContain('Private')
    expect(rawRedisCall).not.toContain('secret.txt')
    expect(JSON.parse(decryptEmailQueuePayload(storedEnvelope, SECRET))).toEqual(
      expect.objectContaining({
        source: 'account',
        message: expect.objectContaining({ to: 'private@example.com', text: 'Private body' }),
      }),
    )
  })

  it.each([
    ['Redis is absent', undefined, SECRET],
    ['the stable key is absent', { eval: jest.fn() }, undefined],
    ['the stable key is malformed', { eval: jest.fn() }, 'not-a-64-hex-key'],
  ])('uses direct SMTP only when %s', async (_reason, redis, secret) => {
    const legacy = {
      acceptanceMode: 'provider' as const,
      sendEmail: jest.fn().mockResolvedValue(true),
      isConfigured: jest.fn().mockReturnValue(true),
    } as jest.Mocked<EmailSenderInterface>
    const sender = createAuthEmailSender({
      redis,
      stableServerEncryptionSecret: secret,
      legacySmtpSender: legacy,
      logger,
    })

    expect(sender).toBe(legacy)
    await expect(sender.sendEmail('person@example.com', 'subject', 'body')).resolves.toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      'Durable email queue prerequisites are unavailable; using the legacy direct SMTP sender.',
      { codeTag: 'EmailDeliveryBootstrap' },
    )
  })

  it('uses direct SMTP at bootstrap for Redis Cluster with an explicit durability warning', () => {
    const redis = {
      eval: jest.fn(),
      nodes: jest.fn().mockReturnValue([]),
    }
    const legacy = {
      acceptanceMode: 'provider' as const,
      sendEmail: jest.fn(),
      isConfigured: jest.fn(),
    }

    const sender = createAuthEmailSender({
      redis,
      stableServerEncryptionSecret: SECRET,
      legacySmtpSender: legacy,
      logger,
    })

    expect(sender).toBe(legacy)
    expect(logger.warn).toHaveBeenCalledWith(
      'Durable email queue is disabled for Redis Cluster because node-local AOF persistence cannot be safely confirmed; using the legacy direct SMTP sender.',
      { codeTag: 'EmailDeliveryBootstrap' },
    )
  })

  it('maps production environment limits and applies domain-core defaults', () => {
    expect(emailQueueProducerOptionsFromEnvironment({})).toEqual({
      maxAttempts: 5,
      retentionMs: 2_592_000_000,
      maxJobBytes: 26_214_400,
      maxTotalBytes: 67_108_864,
    })
    expect(
      emailQueueProducerOptionsFromEnvironment({
        maxAttempts: '8',
        retentionMs: '1000',
        maxJobBytes: '2048',
        maxTotalBytes: '4096',
      }),
    ).toEqual({ maxAttempts: 8, retentionMs: 1_000, maxJobBytes: 2_048, maxTotalBytes: 4_096 })
  })

  it.each([
    [{ maxAttempts: '0' }],
    [{ maxAttempts: 'not-a-number' }],
    [{ retentionMs: '999' }],
    [{ maxJobBytes: '1023' }],
    [{ maxJobBytes: '4096', maxTotalBytes: '2048' }],
  ])('rejects invalid production environment limits at startup: %p', (values) => {
    expect(() => emailQueueProducerOptionsFromEnvironment(values)).toThrow('Email delivery queue options are invalid.')
  })

  it('validates queue limits before Redis Cluster fallback', () => {
    expect(() =>
      createAuthEmailSender({
        redis: { eval: jest.fn(), nodes: jest.fn().mockReturnValue([]) },
        stableServerEncryptionSecret: SECRET,
        legacySmtpSender: {
          acceptanceMode: 'provider',
          sendEmail: jest.fn(),
          isConfigured: jest.fn(),
        },
        logger,
        producerOptions: { maxAttempts: 0 },
      }),
    ).toThrow('Email delivery queue options are invalid.')
  })

  it('validates the backup attachment byte setting and queue-encoding headroom', () => {
    expect(parseEmailAttachmentMaximumBytes(undefined)).toBe(10 * 1024 * 1024)
    expect(parseEmailAttachmentMaximumBytes(' 2048 ')).toBe(2_048)
    expect(() => parseEmailAttachmentMaximumBytes('0')).toThrow('positive whole number')
    expect(() => parseEmailAttachmentMaximumBytes('1.5')).toThrow('positive whole number')
    expect(() => parseEmailAttachmentMaximumBytes(String(1024 * 1024 * 1024 + 1))).toThrow('at most')

    const queueBound = maximumRawAttachmentBytesForQueue(25 * 1024 * 1024)
    expect(queueBound).toBeGreaterThan(10 * 1024 * 1024)
    expect(queueBound).toBeLessThan(15 * 1024 * 1024)
    expect(() => maximumRawAttachmentBytesForQueue(1_023)).toThrow('EMAIL_QUEUE_MAX_JOB_BYTES')
  })
})
