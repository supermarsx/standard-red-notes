import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'crypto'

import { validateEmailRecipient } from './EmailDeliveryConfig'

export const EMAIL_QUEUE_ENVELOPE_CONTEXT = 'standard-red-notes/email-delivery-queue/v1'
export const EMAIL_QUEUE_PROTOCOL_CONTEXT = 'standard-red-notes/email-delivery-queue-protocol/v3'
export const EMAIL_QUEUE_DEFAULT_KEY_PREFIX = 'srn:email:{delivery}'
export const EMAIL_QUEUE_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export const EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES = 25 * 1024 * 1024
export const EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
/** @deprecated Runtime publishers must use emailQueueWorkerReadinessValue. */
export const EMAIL_QUEUE_WORKER_READINESS_VALUE = 'v1'

const ALGORITHM = 'aes-256-gcm'
const ENVELOPE_ALGORITHM = 'A256GCM'
const IDEMPOTENCY_CONTEXT = 'standard-red-notes/email-delivery-idempotency/v1'
const READINESS_CONTEXT = 'standard-red-notes/email-delivery-readiness/v1'
const NAMESPACE_CONTEXT = 'standard-red-notes/email-delivery-namespace/v1'
const SUPERSESSION_CONTEXT = 'standard-red-notes/email-delivery-supersession/v1'
const MAX_SUBJECT_LENGTH = 998
const MAX_BODY_LENGTH = 5_000_000
const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_MESSAGE_BYTES = 20 * 1024 * 1024

export type EmailQueueSource = 'reminder' | 'published-reminder' | 'account' | 'backup' | 'test' | 'other'

export interface EmailQueueAttachment {
  filename: string
  contentType?: string
  contentBase64: string
}

export interface EmailQueueMessage {
  to: string
  subject: string
  text?: string
  html?: string
  attachments?: EmailQueueAttachment[]
}

export interface EmailQueueDeliveryPolicy {
  expiresAt?: number
  retryMode?: 'bounded' | 'indefinite'
  supersessionKey?: string
}

/** Canonical wire object consumed by the gateway delivery worker. */
export interface EmailQueueJob {
  id: string
  source: EmailQueueSource
  message: EmailQueueMessage
  attempt: number
  maxAttempts: number
  createdAt: number
  nextAttemptAt: number
  lastRelayId?: string
  lastFailureClass?: string
  deadAt?: number
  expiresAt?: number
  retryMode?: 'bounded' | 'indefinite'
  supersessionKey?: string
}

export interface EncryptedEmailQueueEnvelope {
  v: 1
  alg: 'A256GCM'
  iv: string
  tag: string
  ciphertext: string
}

export interface EmailQueueRedisKeys {
  jobs: string
  ready: string
  leased: string
  dead: string
  expiry: string
  claims: string
  bytes: string
  supersessions: string
  jobSupersessions: string
  idempotency: string
  idempotencyExpiry: string
}

export interface EmailQueueProducerRedis {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>
  get?(key: string): Promise<unknown>
  hget?(key: string, field: string): Promise<unknown>
  waitaof?(localAofFiles: number, replicaAofFiles: number, timeoutMs: number): Promise<unknown>
  call?(command: string, ...args: Array<string | number>): Promise<unknown>
  /** Present on ioredis Cluster. Keyless WAITAOF cannot safely follow a keyed write there. */
  nodes?(role?: string): unknown[]
}

export type EmailQueueAofRedis = Pick<EmailQueueProducerRedis, 'waitaof' | 'call' | 'nodes'>

export type EmailQueueDeliveryStatus =
  'pending' | 'provider-accepted' | 'dead' | 'quarantined' | 'discarded' | 'superseded' | 'missing'

export type EmailQueueCancellationResult = 'cancelled' | 'provider-accepted' | 'in-flight'

export interface RedisEncryptedEmailQueueProducerOptions {
  keyPrefix?: string
  retentionMs?: number
  maxAttempts?: number
  maxJobBytes?: number
  maxTotalBytes?: number
  clock?: () => number
  randomId?: () => string
}

export interface ValidatedEmailQueueProducerLimits {
  retentionMs: number
  maxAttempts: number
  maxJobBytes: number
  maxTotalBytes: number
}

export type EmailQueueCompatibilityOptions = Pick<
  RedisEncryptedEmailQueueProducerOptions,
  'retentionMs' | 'maxAttempts' | 'maxJobBytes' | 'maxTotalBytes'
>

const ENQUEUE_SCRIPT = `
local existing_record = redis.call('HGET', KEYS[10], ARGV[1])
if existing_record then
  local separator = string.find(existing_record, ':', 1, true)
  local state = separator and string.sub(existing_record, 1, separator - 1) or ''
  local fingerprint = separator and string.sub(existing_record, separator + 1) or ''
  if (state == 'd' or state == 'x') and fingerprint == '*' then return -4 end
  if fingerprint ~= ARGV[7] then return -3 end
  if state == 'a' or state == 's' then return 2 end
  return -4
end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return -3
end
local payload_bytes = string.len(ARGV[2])
if payload_bytes > tonumber(ARGV[5]) then
  return -1
end
local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0')
if total_bytes < 0 then total_bytes = 0 end
local previous_id = false
local previous_payload_bytes = 0
if ARGV[8] ~= '' then
  previous_id = redis.call('HGET', KEYS[8], ARGV[8])
  if previous_id and previous_id ~= ARGV[1] and not redis.call('ZSCORE', KEYS[3], previous_id) then
    previous_payload_bytes = redis.call('HSTRLEN', KEYS[1], previous_id)
  end
end
local idempotency_record = 'a:' .. ARGV[7]
local idempotency_bytes = string.len(ARGV[1]) + string.len(idempotency_record) + 128
local projected_total = total_bytes - previous_payload_bytes + payload_bytes + idempotency_bytes
if projected_total > tonumber(ARGV[6]) then return -2 end
if previous_id and previous_id ~= ARGV[1] and previous_payload_bytes > 0 then
    redis.call('HDEL', KEYS[1], previous_id)
    redis.call('ZREM', KEYS[2], previous_id)
    redis.call('ZREM', KEYS[4], previous_id)
    redis.call('ZREM', KEYS[5], previous_id)
    redis.call('HDEL', KEYS[6], previous_id)
    redis.call('HDEL', KEYS[9], previous_id)
    local previous_record = redis.call('HGET', KEYS[10], previous_id)
    if previous_record then
      local separator = string.find(previous_record, ':', 1, true)
      local fingerprint = separator and string.sub(previous_record, separator + 1) or ''
      redis.call('HSET', KEYS[10], previous_id, 'x:' .. fingerprint)
      redis.call('ZADD', KEYS[11], ARGV[10], previous_id)
    end
  end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
if tonumber(ARGV[4]) > 0 then
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
else
  redis.call('ZREM', KEYS[5], ARGV[1])
end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
redis.call('SET', KEYS[7], projected_total)
if ARGV[8] ~= '' then
  redis.call('HSET', KEYS[8], ARGV[8], ARGV[1])
  redis.call('HSET', KEYS[9], ARGV[1], ARGV[8])
end
redis.call('HSET', KEYS[10], ARGV[1], idempotency_record)
if tonumber(ARGV[9]) > 0 then
  redis.call('ZADD', KEYS[11], ARGV[9], ARGV[1])
else
  redis.call('ZREM', KEYS[11], ARGV[1])
end
return 1
`

const CANCEL_SCRIPT = `
if redis.call('ZSCORE', KEYS[3], ARGV[1]) then return -1 end
local existing_record = redis.call('HGET', KEYS[10], ARGV[1])
if existing_record then
  local separator = string.find(existing_record, ':', 1, true)
  local state = separator and string.sub(existing_record, 1, separator - 1) or ''
  local fingerprint = separator and string.sub(existing_record, separator + 1) or ''
  local valid_state = state == 'a' or state == 's' or state == 'f' or state == 'q' or state == 'd' or state == 'x'
  local valid_wildcard = (state == 'd' or state == 'x') and fingerprint == '*'
  local valid_fingerprint = string.len(fingerprint) == 64 and not string.find(fingerprint, '[^0-9a-f]')
  if not valid_state or (not valid_wildcard and not valid_fingerprint) then return -3 end
  if state == 's' then return 2 end
end
local payload_bytes = redis.call('HSTRLEN', KEYS[1], ARGV[1])
local previous_record_bytes = 0
if existing_record then
  previous_record_bytes = string.len(ARGV[1]) + string.len(existing_record) + 128
end
local cancellation_record = 'd:*'
local cancellation_record_bytes = string.len(ARGV[1]) + string.len(cancellation_record) + 128
local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0') or 0
if total_bytes < 0 then total_bytes = 0 end
local remaining_bytes = total_bytes - payload_bytes - previous_record_bytes
if remaining_bytes < 0 then remaining_bytes = 0 end
local projected_total = remaining_bytes + cancellation_record_bytes
if projected_total > tonumber(ARGV[3]) and projected_total > total_bytes then return -2 end
local supersession = redis.call('HGET', KEYS[9], ARGV[1])
if supersession and redis.call('HGET', KEYS[8], supersession) == ARGV[1] then
  redis.call('HDEL', KEYS[8], supersession)
end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[5], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
redis.call('HDEL', KEYS[9], ARGV[1])
redis.call('HSET', KEYS[10], ARGV[1], cancellation_record)
redis.call('ZADD', KEYS[11], ARGV[2], ARGV[1])
redis.call('SET', KEYS[7], projected_total)
return 1
`

export function emailQueueRedisKeys(prefix = EMAIL_QUEUE_DEFAULT_KEY_PREFIX): EmailQueueRedisKeys {
  if (!prefix || prefix.length > 256 || /[\r\n\0]/.test(prefix)) {
    throw new Error('Email delivery queue key prefix is invalid.')
  }
  return {
    jobs: `${prefix}:jobs`,
    ready: `${prefix}:ready`,
    leased: `${prefix}:leased`,
    dead: `${prefix}:dead`,
    expiry: `${prefix}:expiry`,
    claims: `${prefix}:claims`,
    bytes: `${prefix}:bytes`,
    supersessions: `${prefix}:supersessions`,
    jobSupersessions: `${prefix}:job-supersessions`,
    idempotency: `${prefix}:idempotency`,
    idempotencyExpiry: `${prefix}:idempotency-expiry`,
  }
}

export function emailQueueWorkerReadinessKey(prefix = EMAIL_QUEUE_DEFAULT_KEY_PREFIX): string {
  emailQueueRedisKeys(prefix)

  return `${prefix}:ready-worker`
}

export function emailQueueCompatibilityIdentity(
  stableSecret: string,
  options: EmailQueueCompatibilityOptions = {},
): string {
  const readinessKey = deriveEmailQueueKey(stableSecret, READINESS_CONTEXT)
  const limits = validateEmailQueueProducerLimits(options)
  const contract = JSON.stringify({
    protocol: EMAIL_QUEUE_PROTOCOL_CONTEXT,
    retentionMs: limits.retentionMs,
    maxAttempts: limits.maxAttempts,
    maxJobBytes: limits.maxJobBytes,
    maxTotalBytes: limits.maxTotalBytes,
  })

  return createHmac('sha256', readinessKey).update(contract, 'utf8').digest('base64url')
}

export function emailQueueCompatibleKeyPrefix(
  stableSecret: string,
  basePrefix = EMAIL_QUEUE_DEFAULT_KEY_PREFIX,
  options: EmailQueueCompatibilityOptions = {},
): string {
  emailQueueRedisKeys(basePrefix)
  // Validate the supplied policy even though mutable safety limits do not
  // select storage. Limits remain in the readiness value so mixed producer /
  // worker versions fail closed during a rolling change, while already queued
  // work stays visible and processable after both sides adopt the new policy.
  validateEmailQueueProducerLimits(options)
  const namespaceIdentity = createHmac('sha256', deriveEmailQueueKey(stableSecret, NAMESPACE_CONTEXT))
    .update(EMAIL_QUEUE_PROTOCOL_CONTEXT, 'utf8')
    .digest('base64url')

  return `${basePrefix}:compat:${namespaceIdentity}`
}

/** Redis-safe keyed identity; never persist a caller-supplied correlation key. */
export function emailQueueSupersessionIdentity(stableSecret: string, supersessionKey: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supersessionKey)) {
    throw new Error('Email delivery supersession key is invalid.')
  }

  return createHmac('sha256', deriveEmailQueueKey(stableSecret, SUPERSESSION_CONTEXT))
    .update(supersessionKey, 'utf8')
    .digest('base64url')
}

/**
 * Non-secret worker identity shared by the producer and consumer runtime. It
 * binds readiness to both the stable server key and this queue wire schema, so
 * a worker using a different key or schema can never advertise compatibility.
 */
export function emailQueueWorkerReadinessValue(
  stableSecret: string,
  options: EmailQueueCompatibilityOptions = {},
): string {
  return `${EMAIL_QUEUE_WORKER_READINESS_VALUE}:${emailQueueCompatibilityIdentity(stableSecret, options)}`
}

export function encryptEmailQueuePayload(plaintext: string, stableSecret: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('Email queue payload must be a string.')
  }
  const key = deriveEmailQueueKey(stableSecret)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(EMAIL_QUEUE_ENVELOPE_CONTEXT, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope: EncryptedEmailQueueEnvelope = {
    v: 1,
    alg: ENVELOPE_ALGORITHM,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }

  return JSON.stringify(envelope)
}

export function decryptEmailQueuePayload(serializedEnvelope: string, stableSecret: string): string {
  try {
    const envelope = parseEnvelope(serializedEnvelope)
    const decipher = createDecipheriv(ALGORITHM, deriveEmailQueueKey(stableSecret), fromBase64Url(envelope.iv, 12))
    decipher.setAAD(Buffer.from(EMAIL_QUEUE_ENVELOPE_CONTEXT, 'utf8'))
    decipher.setAuthTag(fromBase64Url(envelope.tag, 16))
    return Buffer.concat([decipher.update(fromBase64Url(envelope.ciphertext)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Email queue payload authentication failed.')
  }
}

export class EmailQueueCipher {
  constructor(private readonly stableSecret: string) {
    deriveEmailQueueKey(stableSecret)
  }

  encrypt(plaintext: string): string {
    return encryptEmailQueuePayload(plaintext, this.stableSecret)
  }

  decrypt(serializedEnvelope: string): string {
    return decryptEmailQueuePayload(serializedEnvelope, this.stableSecret)
  }
}

/**
 * Minimal cross-process producer. Its canonical queue keys and job envelope
 * match RedisEmailDeliveryQueue. A short-lived sidecar key keeps a keyed logical
 * payload fingerprint so a deterministic delivery id is idempotent without
 * exposing recipient, subject, body, or attachment data to Redis.
 */
export class RedisEncryptedEmailQueueProducer {
  private readonly keys: EmailQueueRedisKeys
  private readonly readinessKey: string
  private readonly readinessValue: string
  private readonly cipher: EmailQueueCipher
  private readonly idempotencyKey: Buffer
  private readonly retentionMs: number
  private readonly maxAttempts: number
  private readonly maxJobBytes: number
  private readonly maxTotalBytes: number
  private readonly clock: () => number
  private readonly randomId: () => string
  private readonly stableSecret: string

  constructor(
    private readonly redis: EmailQueueProducerRedis,
    stableSecret: string,
    options: RedisEncryptedEmailQueueProducerOptions = {},
  ) {
    const limits = validateEmailQueueProducerLimits(options)
    const compatiblePrefix = emailQueueCompatibleKeyPrefix(stableSecret, options.keyPrefix, limits)
    this.keys = emailQueueRedisKeys(compatiblePrefix)
    this.readinessKey = emailQueueWorkerReadinessKey(compatiblePrefix)
    this.readinessValue = emailQueueWorkerReadinessValue(stableSecret, limits)
    this.cipher = new EmailQueueCipher(stableSecret)
    this.idempotencyKey = deriveEmailQueueKey(stableSecret, IDEMPOTENCY_CONTEXT)
    this.retentionMs = limits.retentionMs
    this.maxAttempts = limits.maxAttempts
    this.maxJobBytes = limits.maxJobBytes
    this.maxTotalBytes = limits.maxTotalBytes
    this.clock = options.clock ?? (() => Date.now())
    this.randomId = options.randomId ?? (() => randomUUID())
    this.stableSecret = stableSecret
  }

  async isReady(): Promise<boolean> {
    if (isRedisClusterTopology(this.redis) || !this.redis.get) {
      return false
    }

    try {
      return (await this.redis.get(this.readinessKey)) === this.readinessValue
    } catch {
      return false
    }
  }

  async getDeliveryStatus(deliveryId: string): Promise<EmailQueueDeliveryStatus> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deliveryId)) {
      throw new Error('Email delivery queue job is invalid.')
    }
    if (!this.redis.hget) {
      throw new Error('The email delivery queue status is unavailable.')
    }
    try {
      const record = await this.redis.hget(this.keys.idempotency, deliveryId)
      if (record === null || record === undefined) {
        return 'missing'
      }
      if (typeof record !== 'string' || !/^(?:[asfqdx]:[0-9a-f]{64}|[dx]:\*)$/.test(record)) {
        throw new Error('Invalid status.')
      }
      const statuses: Record<string, Exclude<EmailQueueDeliveryStatus, 'missing'>> = {
        a: 'pending',
        s: 'provider-accepted',
        f: 'dead',
        q: 'quarantined',
        d: 'discarded',
        x: 'superseded',
      }

      return statuses[record[0]]
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid status.') {
        throw new Error('The email delivery queue returned an invalid status.')
      }
      throw new Error('The email delivery queue status is unavailable.')
    }
  }

  async cancelDelivery(deliveryId: string): Promise<EmailQueueCancellationResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deliveryId)) {
      throw new Error('Email delivery queue job is invalid.')
    }
    const now = this.clock()
    const cancellationExpiresAt = now + this.retentionMs
    if (!validTimestamp(now) || !validTimestamp(cancellationExpiresAt)) {
      throw new Error('The email delivery queue clock is invalid.')
    }
    if (isRedisClusterTopology(this.redis)) {
      throw new Error('The email delivery queue cannot safely confirm AOF persistence in Redis Cluster mode.')
    }
    const keys = Object.values(this.keys)
    await confirmEmailQueueAofPersistence(this.redis)
    const result = Number(
      await this.redis.eval(CANCEL_SCRIPT, keys.length, ...keys, deliveryId, cancellationExpiresAt, this.maxTotalBytes),
    )
    if (result === -1) {
      return 'in-flight'
    }
    if (result === 2) {
      return 'provider-accepted'
    }
    if (result === -2) {
      throw new Error('The email delivery queue has no capacity for the cancellation fence.')
    }
    if (result === -3) {
      throw new Error('The email delivery queue returned an invalid cancellation state.')
    }
    if (result !== 1) {
      throw new Error('The email delivery queue returned an invalid cancellation result.')
    }
    await confirmEmailQueueAofPersistence(this.redis)
    return 'cancelled'
  }

  async enqueue(
    message: EmailQueueMessage,
    source: EmailQueueSource = 'other',
    deliveryId?: string,
    policy: EmailQueueDeliveryPolicy = {},
  ): Promise<EmailQueueJob> {
    const now = this.clock()
    const job: EmailQueueJob = {
      id: deliveryId ?? this.randomId(),
      source,
      message: validateEmailQueueMessage(message),
      attempt: 0,
      maxAttempts: this.maxAttempts,
      createdAt: now,
      nextAttemptAt: now,
      ...(policy.expiresAt !== undefined ? { expiresAt: policy.expiresAt } : {}),
      ...(policy.retryMode !== undefined ? { retryMode: policy.retryMode } : {}),
      ...(policy.supersessionKey !== undefined ? { supersessionKey: policy.supersessionKey } : {}),
    }
    await this.enqueueJob(job)
    return job
  }

  async enqueueJob(job: EmailQueueJob): Promise<void> {
    validateEmailQueueJob(job)
    if (isRedisClusterTopology(this.redis)) {
      throw new Error('The email delivery queue cannot safely confirm AOF persistence in Redis Cluster mode.')
    }
    const expiresAt = job.retryMode === 'indefinite' ? 0 : Math.max(job.createdAt, job.nextAttemptAt) + this.retentionMs
    const idempotencyExpiresAt = job.retryMode === 'indefinite' ? 0 : expiresAt
    const serializedJob = JSON.stringify(job)
    // AES-GCM envelope/base64 overhead is deterministic enough to calculate by
    // encrypting, but reject its upper bound before allocating ciphertext.
    const maximumEnvelopeBytes = Math.ceil(Buffer.byteLength(serializedJob, 'utf8') / 3) * 4 + 256
    if (maximumEnvelopeBytes > this.maxJobBytes) {
      throw new Error('The encrypted email delivery job exceeds the per-job storage limit.')
    }
    const keys = Object.values(this.keys)
    await confirmEmailQueueAofPersistence(this.redis)
    const encryptedJob = this.cipher.encrypt(serializedJob)
    const stored = await this.redis.eval(
      ENQUEUE_SCRIPT,
      keys.length,
      ...keys,
      job.id,
      encryptedJob,
      job.nextAttemptAt,
      expiresAt,
      this.maxJobBytes,
      this.maxTotalBytes,
      this.logicalPayloadFingerprint(job),
      job.supersessionKey ? emailQueueSupersessionIdentity(this.stableSecret, job.supersessionKey) : '',
      idempotencyExpiresAt,
      job.createdAt + this.retentionMs,
    )
    if (Number(stored) === -1) {
      throw new Error('The encrypted email delivery job exceeds the per-job storage limit.')
    }
    if (Number(stored) === -2) {
      throw new Error('The email delivery queue has reached its encrypted storage budget.')
    }
    if (Number(stored) === -3) {
      throw new Error('The email delivery id is already bound to a different message.')
    }
    if (Number(stored) === -4) {
      throw new Error('The email delivery id was cancelled or superseded and cannot be replayed.')
    }
    if (![1, 2].includes(Number(stored))) {
      throw new Error('The email delivery queue returned an invalid enqueue result.')
    }

    await confirmEmailQueueAofPersistence(this.redis)
  }

  private logicalPayloadFingerprint(job: EmailQueueJob): string {
    const message = validateEmailQueueMessage(job.message)
    const logicalPayload = {
      source: job.source,
      message: {
        to: message.to,
        subject: message.subject,
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.html !== undefined ? { html: message.html } : {}),
        ...(message.attachments !== undefined
          ? {
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
                contentBase64: attachment.contentBase64,
              })),
            }
          : {}),
      },
      ...(job.expiresAt !== undefined ? { expiresAt: job.expiresAt } : {}),
      ...(job.retryMode !== undefined ? { retryMode: job.retryMode } : {}),
      ...(job.supersessionKey !== undefined ? { supersessionKey: job.supersessionKey } : {}),
    }

    return createHmac('sha256', this.idempotencyKey).update(JSON.stringify(logicalPayload), 'utf8').digest('hex')
  }
}

export async function confirmEmailQueueAofPersistence(redis: EmailQueueAofRedis, timeoutMs = 5_000): Promise<void> {
  if (isRedisClusterTopology(redis)) {
    throw new Error('The email delivery queue cannot safely confirm AOF persistence in Redis Cluster mode.')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('The email delivery queue AOF persistence timeout is invalid.')
  }
  const waitForAof = redis.waitaof
    ? () => redis.waitaof!(1, 0, timeoutMs)
    : redis.call
      ? () => redis.call!('WAITAOF', 1, 0, timeoutMs)
      : undefined
  if (!waitForAof) {
    throw new Error('The email delivery queue cannot confirm local AOF persistence.')
  }
  try {
    const persistedLocalAofFiles = await waitForAof()
    if (!Array.isArray(persistedLocalAofFiles) || persistedLocalAofFiles.length < 2) {
      throw new Error('Local AOF persistence returned an invalid result.')
    }
    const persistedCount = Number(persistedLocalAofFiles[0])
    const persistedReplicaCount = Number(persistedLocalAofFiles[1])
    if (
      !Number.isSafeInteger(persistedCount) ||
      persistedCount < 1 ||
      !Number.isSafeInteger(persistedReplicaCount) ||
      persistedReplicaCount < 0
    ) {
      throw new Error('Local AOF persistence was not confirmed.')
    }
  } catch {
    // The Lua transaction remains queued and idempotently retryable. Never
    // report acceptance until Redis confirms that the write reached local AOF.
    throw new Error('The email delivery queue could not confirm local AOF persistence.')
  }
}

export function isRedisClusterTopology(redis: { nodes?(role?: string): unknown[] }): boolean {
  return typeof redis.nodes === 'function'
}

export function validateEmailQueueProducerLimits(
  options: Pick<
    RedisEncryptedEmailQueueProducerOptions,
    'retentionMs' | 'maxAttempts' | 'maxJobBytes' | 'maxTotalBytes'
  >,
): ValidatedEmailQueueProducerLimits {
  const retentionMs = boundedInteger(
    options.retentionMs,
    EMAIL_QUEUE_DEFAULT_RETENTION_MS,
    1_000,
    90 * 24 * 60 * 60 * 1_000,
  )
  const maxAttempts = boundedInteger(options.maxAttempts, 5, 1, 100)
  const maxJobBytes = boundedInteger(options.maxJobBytes, EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES, 1_024, 1024 * 1024 * 1024)
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes,
    EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
    maxJobBytes,
    10 * 1024 * 1024 * 1024,
  )

  return { retentionMs, maxAttempts, maxJobBytes, maxTotalBytes }
}

export function validateEmailQueueJob(job: EmailQueueJob): void {
  if (
    !job ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) ||
    !['reminder', 'published-reminder', 'account', 'backup', 'test', 'other'].includes(job.source) ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 0 ||
    !Number.isSafeInteger(job.maxAttempts) ||
    job.maxAttempts < 1 ||
    job.maxAttempts > 100 ||
    (job.retryMode !== 'indefinite' && job.attempt > job.maxAttempts) ||
    !validTimestamp(job.createdAt) ||
    !validTimestamp(job.nextAttemptAt) ||
    (job.deadAt !== undefined && !validTimestamp(job.deadAt)) ||
    (job.expiresAt !== undefined && (!validTimestamp(job.expiresAt) || job.expiresAt < job.createdAt)) ||
    (job.retryMode !== undefined && !['bounded', 'indefinite'].includes(job.retryMode)) ||
    (job.supersessionKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.supersessionKey))
  ) {
    throw new Error('Email delivery queue job is invalid.')
  }
  validateEmailQueueMessage(job.message)
}

export function validateEmailQueueMessage(message: EmailQueueMessage): EmailQueueMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Email delivery queue message is invalid.')
  }
  const to = validateEmailRecipient(message?.to)
  if (!to || /[\r\n\0]/.test(message.to)) {
    throw new Error('A valid recipient email address is required.')
  }
  if (
    typeof message.subject !== 'string' ||
    !message.subject ||
    message.subject.length > MAX_SUBJECT_LENGTH ||
    /[\r\n\0]/.test(message.subject)
  ) {
    throw new Error('The email subject is invalid.')
  }
  if (message.text === undefined && message.html === undefined) {
    throw new Error('An email text or HTML body is required.')
  }
  if (
    (message.text !== undefined && typeof message.text !== 'string') ||
    (message.html !== undefined && typeof message.html !== 'string')
  ) {
    throw new Error('The email body is invalid.')
  }
  if ((message.text?.length ?? 0) > MAX_BODY_LENGTH || (message.html?.length ?? 0) > MAX_BODY_LENGTH) {
    throw new Error('The email body is too large.')
  }
  const initialMessageBytes =
    Buffer.byteLength(message.text ?? '', 'utf8') + Buffer.byteLength(message.html ?? '', 'utf8')
  if (initialMessageBytes > MAX_TOTAL_MESSAGE_BYTES) {
    throw new Error('The email message exceeds the aggregate content limit.')
  }
  const attachments = message.attachments ?? []
  if (!Array.isArray(attachments)) {
    throw new Error('Email attachments are invalid.')
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error('The email has too many attachments.')
  }
  let totalMessageBytes = initialMessageBytes
  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      typeof attachment.filename !== 'string' ||
      !attachment.filename ||
      attachment.filename.length > 255 ||
      /[\r\n\0/\\]/.test(attachment.filename) ||
      (attachment.contentType !== undefined &&
        (!/^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType) || attachment.contentType.length > 127))
    ) {
      throw new Error('An email attachment has invalid metadata.')
    }
    if (typeof attachment.contentBase64 !== 'string') {
      throw new Error('An email attachment has invalid or oversized content.')
    }
    const paddingBytes = attachment.contentBase64.endsWith('==') ? 2 : attachment.contentBase64.endsWith('=') ? 1 : 0
    const estimatedDecodedBytes = Math.floor((attachment.contentBase64.length * 3) / 4) - paddingBytes
    if (estimatedDecodedBytes < 0 || estimatedDecodedBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error('An email attachment has invalid or oversized content.')
    }
    if (totalMessageBytes + estimatedDecodedBytes > MAX_TOTAL_MESSAGE_BYTES) {
      throw new Error('The email message exceeds the aggregate content limit.')
    }
    const bytes = Buffer.from(attachment.contentBase64, 'base64')
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== attachment.contentBase64) {
      throw new Error('An email attachment has invalid or oversized content.')
    }
    totalMessageBytes += bytes.byteLength
    if (totalMessageBytes > MAX_TOTAL_MESSAGE_BYTES) {
      throw new Error('The email message exceeds the aggregate content limit.')
    }
  }

  return {
    ...message,
    to,
    ...(attachments.length > 0 ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}),
  }
}

function deriveEmailQueueKey(stableSecret: string, context = EMAIL_QUEUE_ENVELOPE_CONTEXT): Buffer {
  if (typeof stableSecret !== 'string' || !/^[0-9a-fA-F]{64}$/.test(stableSecret)) {
    throw new Error('A 32-byte hexadecimal stable server encryption secret is required for the email queue.')
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(stableSecret, 'hex'),
      Buffer.from('standard-red-notes/server-runtime', 'utf8'),
      Buffer.from(context, 'utf8'),
      32,
    ),
  )
}

function parseEnvelope(value: string): EncryptedEmailQueueEnvelope {
  const parsed = JSON.parse(value) as Partial<EncryptedEmailQueueEnvelope>
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.alg !== ENVELOPE_ALGORITHM ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.ciphertext !== 'string' ||
    Object.keys(parsed).some((key) => !['v', 'alg', 'iv', 'tag', 'ciphertext'].includes(key))
  ) {
    throw new Error('Invalid envelope.')
  }
  return parsed as EncryptedEmailQueueEnvelope
}

function fromBase64Url(value: string, exactBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('Invalid encoding.')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value || (exactBytes !== undefined && decoded.byteLength !== exactBytes)) {
    throw new Error('Invalid encoding.')
  }
  return decoded
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error('Email delivery queue options are invalid.')
  }
  return resolved
}
