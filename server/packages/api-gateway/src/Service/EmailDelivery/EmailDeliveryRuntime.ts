import {
  EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
  EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
  EMAIL_QUEUE_DEFAULT_RETENTION_MS,
  EmailQueueCompatibilityOptions,
  RedisEncryptedEmailQueueProducer,
  ValidatedEmailQueueProducerLimits,
  confirmEmailQueueAofPersistence,
  emailQueueCompatibleKeyPrefix,
  emailQueueWorkerReadinessValue,
  emailQueueWorkerReadinessKey,
  validateEmailQueueProducerLimits,
} from '@standardnotes/domain-core'

import {
  DeliveryResult,
  ReminderDeliveryCancellationResult,
  ReminderDeliveryContext,
  ReminderDeliveryProvider,
} from '../ReminderDelivery/Types'

const MEBIBYTE = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1_000
const REDIS_CAPACITY_HEADROOM_BYTES = 64 * MEBIBYTE
const READINESS_HEARTBEAT_MS = 5_000
const READINESS_TTL_MS = 12_000

export interface EmailDeliveryRuntimeRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>
  del(key: string): Promise<unknown>
  config?(command: 'GET', parameter: 'maxmemory'): Promise<unknown>
  waitaof?(localAofFiles: number, replicaAofFiles: number, timeoutMs: number): Promise<unknown>
  call?(command: string, ...args: Array<string | number>): Promise<unknown>
  nodes?(): unknown[]
}

export interface EmailDeliveryRuntimeLogger {
  info(message: string, metadata?: Record<string, unknown>): void
  warn(message: string, metadata?: Record<string, unknown>): void
  error(message: string, metadata?: Record<string, unknown>): void
}

export interface EmailDeliveryWorkerLifecycle {
  start(): boolean
  stop(): Promise<void>
}

export interface EmailDeliveryRuntimeOptions {
  worker: {
    intervalMs: number
    batchSize: number
  }
  delivery: {
    maxAttempts: number
    retryBaseMs: number
    retryMaxMs: number
    leaseHeartbeatMs: number
  }
  queue: {
    leaseMs: number
    retentionMs: number
    deadLetterRetentionMs: number
    maxJobBytes: number
    maxTotalBytes: number
  }
  logs: {
    retentionMs: number
    maximumEntries: number
  }
}

/**
 * Parses reliability controls once at startup. A malformed override fails boot
 * instead of being silently ignored, while the defaults remain shared with the
 * auth-side encrypted queue producer wherever the two processes must agree.
 */
export function resolveEmailDeliveryRuntimeOptions(
  read: (name: string) => string | undefined,
): EmailDeliveryRuntimeOptions {
  const leaseMs = integerSetting(read, 'EMAIL_QUEUE_LEASE_MS', 120_000, 1_000, 60 * 60 * 1_000)
  const maxJobBytes = integerSetting(
    read,
    'EMAIL_QUEUE_MAX_JOB_BYTES',
    EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
    1_024,
    1024 * MEBIBYTE,
  )
  const maxTotalBytes = integerSetting(
    read,
    'EMAIL_QUEUE_MAX_TOTAL_BYTES',
    EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
    1_024,
    10 * 1024 * MEBIBYTE,
  )
  if (maxTotalBytes < maxJobBytes) {
    throw new Error('EMAIL_QUEUE_MAX_TOTAL_BYTES must be at least EMAIL_QUEUE_MAX_JOB_BYTES.')
  }

  const retryBaseMs = integerSetting(read, 'EMAIL_DELIVERY_RETRY_BASE_MS', 30_000, 1_000, DAY_MS)
  const retryMaxMs = integerSetting(read, 'EMAIL_DELIVERY_RETRY_MAX_MS', 6 * 60 * 60 * 1_000, 1_000, 7 * DAY_MS)
  if (retryMaxMs < retryBaseMs) {
    throw new Error('EMAIL_DELIVERY_RETRY_MAX_MS must be at least EMAIL_DELIVERY_RETRY_BASE_MS.')
  }
  const retentionMs = integerSetting(
    read,
    'EMAIL_QUEUE_RETENTION_MS',
    EMAIL_QUEUE_DEFAULT_RETENTION_MS,
    1_000,
    90 * DAY_MS,
  )
  if (retentionMs <= retryMaxMs) {
    throw new Error('EMAIL_QUEUE_RETENTION_MS must be greater than EMAIL_DELIVERY_RETRY_MAX_MS.')
  }

  return {
    worker: {
      intervalMs: integerSetting(read, 'EMAIL_DELIVERY_WORKER_INTERVAL_MS', 5_000, 250, 60 * 60 * 1_000),
      batchSize: integerSetting(read, 'EMAIL_DELIVERY_WORKER_BATCH_SIZE', 25, 1, 500),
    },
    delivery: {
      maxAttempts: integerSetting(read, 'EMAIL_QUEUE_MAX_ATTEMPTS', 5, 1, 100),
      retryBaseMs,
      retryMaxMs,
      leaseHeartbeatMs: Math.min(30_000, Math.max(10, Math.floor(leaseMs / 3))),
    },
    queue: {
      leaseMs,
      retentionMs,
      deadLetterRetentionMs: integerSetting(read, 'EMAIL_QUEUE_DEAD_RETENTION_MS', 30 * DAY_MS, 1_000, 90 * DAY_MS),
      maxJobBytes,
      maxTotalBytes,
    },
    logs: {
      retentionMs: integerSetting(read, 'EMAIL_DELIVERY_LOG_RETENTION_MS', 30 * DAY_MS, 1_000, 90 * DAY_MS),
      maximumEntries: integerSetting(read, 'EMAIL_DELIVERY_LOG_MAX_ENTRIES', 10_000, 1, 100_000),
    },
  }
}

/**
 * Owns the queue consumer's liveness contract. The shared Redis marker means
 * both "a consumer is alive" and "at least one valid relay is enabled"; auth
 * producers therefore fail closed instead of accepting undeliverable mail.
 */
export class EmailDeliveryRuntime {
  private heartbeat: NodeJS.Timeout | undefined
  private started = false
  private workerRunning = false
  private acceptingEmails = false
  private readinessState: 'unknown' | 'ready' | 'unconfigured' | 'error' = 'unknown'
  private refreshInFlight: Promise<void> | undefined
  private readonly queueCompatibility: ValidatedEmailQueueProducerLimits

  constructor(
    private readonly redis: EmailDeliveryRuntimeRedis,
    private readonly worker: EmailDeliveryWorkerLifecycle,
    private readonly relayConfigured: () => Promise<boolean>,
    queueCompatibility: EmailQueueCompatibilityOptions,
    private readonly stableSecret: string,
    private readonly logger: EmailDeliveryRuntimeLogger,
  ) {
    this.queueCompatibility = validateEmailQueueProducerLimits(queueCompatibility)
    emailQueueWorkerReadinessValue(stableSecret, this.queueCompatibility)
  }

  async start(): Promise<boolean> {
    if (this.started) {
      return false
    }
    if (!(await this.redisCapacityIsSafe())) {
      await this.removeReadinessBestEffort()
      return false
    }
    this.started = true
    await this.refreshReadiness()
    this.heartbeat = setInterval(() => void this.refreshReadiness(), READINESS_HEARTBEAT_MS)
    this.heartbeat.unref?.()
    return true
  }

  isAcceptingEmails(): boolean {
    return this.started && this.acceptingEmails
  }

  async refreshReadiness(): Promise<void> {
    if (!this.started) {
      return
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    const operation = this.performReadinessRefresh()
    const tracked = operation.finally(() => {
      if (this.refreshInFlight === tracked) {
        this.refreshInFlight = undefined
      }
    })
    this.refreshInFlight = tracked
    return tracked
  }

  async stop(): Promise<void> {
    this.started = false
    this.acceptingEmails = false
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    // Begin the worker drain before awaiting a readiness refresh. This prevents
    // an in-flight provider failure from advancing to another relay while the
    // process is already shutting down.
    await this.stopWorker()
    await this.refreshInFlight
    // A refresh that crossed the stop boundary may have started the worker;
    // close that race before returning.
    await this.stopWorker()
    await this.removeReadinessBestEffort()
  }

  private async performReadinessRefresh(): Promise<void> {
    const readinessKey = emailQueueWorkerReadinessKey(
      emailQueueCompatibleKeyPrefix(this.stableSecret, undefined, this.queueCompatibility),
    )
    try {
      if (!(await this.relayConfigured())) {
        this.acceptingEmails = false
        await this.stopWorker()
        this.logReadinessTransition('unconfigured', 'Email delivery worker is waiting for an enabled relay profile.')
        return
      }

      if (!this.workerRunning) {
        if (!this.worker.start()) {
          this.acceptingEmails = false
          throw new Error('Email delivery worker refused to start.')
        }
        this.workerRunning = true
      }

      await this.redis.set(
        readinessKey,
        emailQueueWorkerReadinessValue(this.stableSecret, this.queueCompatibility),
        'PX',
        READINESS_TTL_MS,
      )
      await confirmEmailQueueAofPersistence(this.redis)
      this.acceptingEmails = true
      this.logReadinessTransition('ready', 'Email delivery worker is ready.')
    } catch (error) {
      this.acceptingEmails = false
      await this.removeReadinessBestEffort()
      await this.stopWorker()
      if (this.readinessState !== 'error') {
        this.logger.error('Email delivery readiness refresh failed.', {
          codeTag: 'EmailDeliveryReadiness',
          errorName: errorName(error),
        })
      }
      this.readinessState = 'error'
    }
  }

  private logReadinessTransition(
    next: Exclude<EmailDeliveryRuntime['readinessState'], 'unknown' | 'error'>,
    message: string,
  ): void {
    if (this.readinessState !== next) {
      this.logger.info(message, { codeTag: 'EmailDeliveryReadiness', state: next })
    }
    this.readinessState = next
  }

  private async redisCapacityIsSafe(): Promise<boolean> {
    if (!this.redis.config) {
      this.logger.warn('Redis maxmemory could not be inspected; bounded email queue limits remain enforced.', {
        codeTag: 'EmailDeliveryRedisCapacity',
        errorName: 'UnsupportedOperation',
      })
      return true
    }
    try {
      const maxmemory = parseRedisMaxmemory(await this.redis.config('GET', 'maxmemory'))
      if (maxmemory > 0 && maxmemory <= this.queueCompatibility.maxTotalBytes + REDIS_CAPACITY_HEADROOM_BYTES) {
        this.logger.error('Email delivery worker is disabled because Redis capacity is below the safety floor.', {
          codeTag: 'EmailDeliveryRedisCapacity',
          errorName: 'InsufficientCapacity',
        })
        return false
      }
    } catch (error) {
      // Managed Redis commonly denies CONFIG. The queue still has a strict
      // encrypted-byte budget, so continue with that bound and a redacted warning.
      this.logger.warn('Redis maxmemory could not be inspected; bounded email queue limits remain enforced.', {
        codeTag: 'EmailDeliveryRedisCapacity',
        errorName: errorName(error),
      })
    }
    return true
  }

  private async removeReadinessBestEffort(): Promise<void> {
    // Readiness is fleet-owned. A stopping/unconfigured replica must not delete
    // a healthy compatible replica's marker; its own last heartbeat expires
    // after the short TTL instead.
  }

  private async stopWorker(): Promise<void> {
    if (!this.workerRunning) {
      return
    }
    try {
      await this.worker.stop()
    } finally {
      this.workerRunning = false
    }
  }
}

/**
 * The auth producer uses node-local Redis durability primitives which cannot be
 * proven through ioredis Cluster routing. Keep both producer and consumer on
 * legacy SMTP together instead of exposing a split-brain advanced capability.
 */
export function supportsAdvancedEmailDeliveryRedis(redis: unknown): boolean {
  return (
    typeof redis === 'object' &&
    redis !== null &&
    !('nodes' in redis && typeof (redis as { nodes?: unknown }).nodes === 'function')
  )
}

/** Queues explicitly published reminder mail through the same durable path. */
export class QueuedReminderEmailProvider implements ReminderDeliveryProvider {
  readonly channel = 'email' as const

  constructor(
    private readonly producer: Pick<
      RedisEncryptedEmailQueueProducer,
      'isReady' | 'enqueue' | 'getDeliveryStatus' | 'cancelDelivery'
    >,
    private readonly runtime: Pick<EmailDeliveryRuntime, 'isAcceptingEmails'>,
  ) {}

  async send(destination: string, message: string, context?: ReminderDeliveryContext): Promise<DeliveryResult> {
    if (!context?.deliveryId) {
      return { ok: false, reason: 'The reminder is missing its durable delivery identity.' }
    }
    try {
      const status = await this.producer.getDeliveryStatus(context.deliveryId)
      if (status === 'provider-accepted') {
        return { ok: true }
      }
      if (status === 'pending') {
        return { ok: false, pending: true, reason: 'The reminder is awaiting provider acceptance.' }
      }
      if (status !== 'missing') {
        return { ok: false, reason: `The reminder email reached terminal queue state ${status}.` }
      }
      if (!this.runtime.isAcceptingEmails()) {
        return { ok: false, notConfigured: true, reason: 'Email delivery has no ready relay worker.' }
      }
      if (!(await this.producer.isReady())) {
        return { ok: false, notConfigured: true, reason: 'Email delivery has no ready relay worker.' }
      }
      await this.producer.enqueue(
        { to: destination, subject: 'Reminder', text: message },
        'published-reminder',
        context.deliveryId,
      )
      return { ok: false, pending: true, reason: 'The reminder is awaiting provider acceptance.' }
    } catch {
      return { ok: false, reason: 'The reminder could not be accepted by the email delivery queue.' }
    }
  }

  async cancel(context: ReminderDeliveryContext): Promise<ReminderDeliveryCancellationResult> {
    try {
      const result = await this.producer.cancelDelivery(context.deliveryId)
      if (result === 'in-flight') {
        return {
          ok: false,
          inFlight: true,
          reason: 'The reminder email is already in flight and cannot be cancelled safely.',
        }
      }
      return { ok: true, ...(result === 'provider-accepted' ? { providerAccepted: true } : {}) }
    } catch {
      return { ok: false, reason: 'The reminder email cancellation could not be persisted.' }
    }
  }
}

function integerSetting(
  read: (name: string) => string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = read(name)?.trim()
  if (!raw) {
    return fallback
  }
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be a whole number between ${minimum} and ${maximum}.`)
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a whole number between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function parseRedisMaxmemory(value: unknown): number {
  const candidate = Array.isArray(value)
    ? value.find((entry, index) => index > 0 && typeof entry === 'string' && /^\d+$/.test(entry))
    : undefined
  if (typeof candidate !== 'string') {
    throw new Error('Redis returned an invalid maxmemory response.')
  }
  const parsed = Number(candidate)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Redis returned an invalid maxmemory response.')
  }
  return parsed
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : 'UnknownError'
}
