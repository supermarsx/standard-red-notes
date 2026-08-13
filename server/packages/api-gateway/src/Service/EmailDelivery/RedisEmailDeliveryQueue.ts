import { randomUUID } from 'crypto'

import {
  ClaimedEmail,
  EmailAttemptLog,
  EmailAttemptLogStore,
  EmailAttemptLogView,
  EmailDeliveryQueue,
  Page,
  QueuedEmail,
  QueueItemView,
  QueueState,
} from './Types'

export interface EmailQueueRedis {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>
  zrange(key: string, start: number, stop: number, withScores?: 'WITHSCORES'): Promise<string[]>
  zrevrange(key: string, start: number, stop: number, withScores?: 'WITHSCORES'): Promise<string[]>
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>
  hget(key: string, field: string): Promise<string | null>
  zscore(key: string, member: string): Promise<string | null>
}

export interface RedisEmailDeliveryQueueOptions {
  keyPrefix?: string
  leaseMs?: number
  retentionMs?: number
  deadLetterRetentionMs?: number
  clock?: () => number
  randomId?: () => string
}

const DEFAULT_LEASE_MS = 2 * 60 * 1_000
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const DEFAULT_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_PAGE_SIZE = 100

const ENQUEUE_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
return 1
`

const CLAIM_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(expired) do
  if redis.call('HEXISTS', KEYS[1], id) == 1 then
    redis.call('ZADD', KEYS[2], ARGV[1], id)
  end
  redis.call('ZREM', KEYS[3], id)
  redis.call('HDEL', KEYS[6], id)
end

local stale = redis.call('ZRANGEBYSCORE', KEYS[5], '-inf', ARGV[1], 'LIMIT', 0, 200)
for _, id in ipairs(stale) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZREM', KEYS[4], id)
  redis.call('ZREM', KEYS[5], id)
  redis.call('HDEL', KEYS[6], id)
  redis.call('HDEL', KEYS[1], id)
end

local candidates = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(candidates) do
  local payload = redis.call('HGET', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
  if payload then
    redis.call('ZADD', KEYS[3], ARGV[2], id)
    redis.call('HSET', KEYS[6], id, ARGV[3])
    return { id, payload }
  end
  redis.call('ZREM', KEYS[5], id)
end
return {}
`

const SETTLE_SCRIPT = `
if redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[2] or not redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  return 0
end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
if ARGV[3] == 'ack' then
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[4], ARGV[1])
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('HDEL', KEYS[1], ARGV[1])
elseif ARGV[3] == 'retry' then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
  redis.call('ZADD', KEYS[5], ARGV[6], ARGV[1])
  redis.call('ZREM', KEYS[4], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
  redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])
  redis.call('ZADD', KEYS[5], ARGV[6], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
end
return 1
`

const MAINTENANCE_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(expired) do
  if redis.call('HEXISTS', KEYS[1], id) == 1 then redis.call('ZADD', KEYS[2], ARGV[1], id) end
  redis.call('ZREM', KEYS[3], id)
  redis.call('HDEL', KEYS[6], id)
end
local stale = redis.call('ZRANGEBYSCORE', KEYS[5], '-inf', ARGV[1], 'LIMIT', 0, 500)
for _, id in ipairs(stale) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZREM', KEYS[4], id)
  redis.call('ZREM', KEYS[5], id)
  redis.call('HDEL', KEYS[6], id)
  redis.call('HDEL', KEYS[1], id)
end
return #stale
`

const REQUEUE_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 or redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
return 1
`

const DISCARD_SCRIPT = `
local existed = redis.call('HEXISTS', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[5], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
return existed
`

export class RedisEmailDeliveryQueue implements EmailDeliveryQueue {
  private readonly keys: [string, string, string, string, string, string]
  private readonly leaseMs: number
  private readonly retentionMs: number
  private readonly deadLetterRetentionMs: number
  private readonly clock: () => number
  private readonly randomId: () => string

  constructor(
    private readonly redis: EmailQueueRedis,
    options: RedisEmailDeliveryQueueOptions = {},
  ) {
    // The hash tag keeps every Lua key in one Redis Cluster slot.
    const prefix = options.keyPrefix ?? 'srn:email:{delivery}'
    this.keys = [
      `${prefix}:jobs`,
      `${prefix}:ready`,
      `${prefix}:leased`,
      `${prefix}:dead`,
      `${prefix}:expiry`,
      `${prefix}:claims`,
    ]
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS, 60 * 60 * 1_000)
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS, 90 * 24 * 60 * 60 * 1_000)
    this.deadLetterRetentionMs = positiveInteger(
      options.deadLetterRetentionMs,
      DEFAULT_DEAD_RETENTION_MS,
      90 * 24 * 60 * 60 * 1_000,
    )
    this.clock = options.clock ?? (() => Date.now())
    this.randomId = options.randomId ?? (() => randomUUID())
  }

  async enqueue(job: QueuedEmail): Promise<void> {
    assertQueuedEmail(job)
    const stored = await this.redis.eval(
      ENQUEUE_SCRIPT,
      this.keys.length,
      ...this.keys,
      job.id,
      JSON.stringify(job),
      job.nextAttemptAt,
      job.createdAt + this.retentionMs,
    )
    if (Number(stored) !== 1) {
      throw new Error('An email delivery job with this id already exists.')
    }
  }

  async claim(): Promise<ClaimedEmail | null> {
    const now = this.clock()
    const token = this.randomId()
    const result = await this.redis.eval(CLAIM_SCRIPT, this.keys.length, ...this.keys, now, now + this.leaseMs, token)
    const values = arrayResult(result)
    if (values.length === 0) {
      return null
    }
    const id = String(values[0])
    const job = parseQueuedEmail(String(values[1]))
    if (job.id !== id) {
      throw new Error('Email delivery queue data is inconsistent.')
    }

    return { job, token, leaseExpiresAt: now + this.leaseMs }
  }

  async acknowledge(claim: ClaimedEmail): Promise<boolean> {
    return this.settle('ack', claim)
  }

  async retry(claim: ClaimedEmail, job: QueuedEmail): Promise<boolean> {
    assertSameJob(claim, job)
    assertQueuedEmail(job)
    return this.settle('retry', claim, job, job.nextAttemptAt, this.clock() + this.retentionMs)
  }

  async deadLetter(claim: ClaimedEmail, job: QueuedEmail): Promise<boolean> {
    assertSameJob(claim, job)
    assertQueuedEmail(job)
    const deadAt = job.deadAt ?? this.clock()
    return this.settle('dead', claim, { ...job, deadAt }, deadAt, deadAt + this.deadLetterRetentionMs)
  }

  async list(state: QueueState, limit = 50, cursor?: string): Promise<Page<QueueItemView>> {
    const boundedLimit = pageSize(limit)
    const offset = decodeCursor(cursor)
    await this.redis.eval(MAINTENANCE_SCRIPT, this.keys.length, ...this.keys, this.clock())
    const key = this.stateKey(state)
    const raw =
      state === 'dead'
        ? await this.redis.zrevrange(key, offset, offset + boundedLimit, 'WITHSCORES')
        : await this.redis.zrange(key, offset, offset + boundedLimit, 'WITHSCORES')
    const pairs = scoredMembers(raw)
    const visible = pairs.slice(0, boundedLimit)
    const payloads = visible.length > 0 ? await this.redis.hmget(this.keys[0], ...visible.map(({ id }) => id)) : []
    const items: QueueItemView[] = []
    for (let index = 0; index < visible.length; index++) {
      const payload = payloads[index]
      if (!payload) {
        continue
      }
      const job = parseQueuedEmail(payload)
      items.push(toQueueView(job, state, visible[index].score))
    }

    return {
      items,
      ...(pairs.length > boundedLimit ? { nextCursor: encodeCursor(offset + boundedLimit) } : {}),
    }
  }

  async requeue(id: string): Promise<QueueItemView | null> {
    const payload = await this.redis.hget(this.keys[0], id)
    if (!payload) {
      return null
    }
    const now = this.clock()
    const current = parseQueuedEmail(payload)
    const job: QueuedEmail = {
      ...current,
      attempt: 0,
      nextAttemptAt: now,
    }
    delete job.deadAt
    delete job.lastFailureClass
    const changed = await this.redis.eval(
      REQUEUE_SCRIPT,
      this.keys.length,
      ...this.keys,
      id,
      JSON.stringify(job),
      now,
      now + this.retentionMs,
    )

    return Number(changed) === 1 ? toQueueView(job, 'ready', now) : null
  }

  async discard(id: string): Promise<boolean> {
    const discarded = await this.redis.eval(DISCARD_SCRIPT, this.keys.length, ...this.keys, id)
    return Number(discarded) === 1
  }

  private async settle(
    operation: 'ack' | 'retry' | 'dead',
    claim: ClaimedEmail,
    job?: QueuedEmail,
    score = 0,
    expiresAt = 0,
  ): Promise<boolean> {
    const changed = await this.redis.eval(
      SETTLE_SCRIPT,
      this.keys.length,
      ...this.keys,
      claim.job.id,
      claim.token,
      operation,
      job ? JSON.stringify(job) : '',
      score,
      expiresAt,
    )

    return Number(changed) === 1
  }

  private stateKey(state: QueueState): string {
    return state === 'ready' ? this.keys[1] : state === 'leased' ? this.keys[2] : this.keys[3]
  }
}

export interface RedisEmailAttemptLogOptions {
  keyPrefix?: string
  retentionMs?: number
  maximumEntries?: number
}

const LOG_SCRIPT = `
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[3], 'LIMIT', 0, 500)
for _, id in ipairs(stale) do redis.call('ZREM', KEYS[1], id); redis.call('HDEL', KEYS[2], id) end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
local size = redis.call('ZCARD', KEYS[1])
if size > tonumber(ARGV[5]) then
  local overflow = redis.call('ZRANGE', KEYS[1], 0, size - tonumber(ARGV[5]) - 1)
  for _, id in ipairs(overflow) do redis.call('ZREM', KEYS[1], id); redis.call('HDEL', KEYS[2], id) end
end
return 1
`

export class RedisEmailAttemptLog implements EmailAttemptLogStore {
  private readonly keys: [string, string]
  private readonly retentionMs: number
  private readonly maximumEntries: number

  constructor(
    private readonly redis: EmailQueueRedis,
    options: RedisEmailAttemptLogOptions = {},
  ) {
    const prefix = options.keyPrefix ?? 'srn:email:{delivery}'
    this.keys = [`${prefix}:logs`, `${prefix}:log-entries`]
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS, 90 * 24 * 60 * 60 * 1_000)
    this.maximumEntries = positiveInteger(options.maximumEntries, 10_000, 100_000)
  }

  async record(entry: EmailAttemptLog): Promise<void> {
    assertLogEntry(entry)
    await this.redis.eval(
      LOG_SCRIPT,
      this.keys.length,
      ...this.keys,
      entry.id,
      JSON.stringify(entry),
      entry.createdAt - this.retentionMs,
      entry.createdAt,
      this.maximumEntries,
    )
  }

  async list(
    limit = 50,
    cursor?: string,
    query: { relayId?: string; outcome?: EmailAttemptLog['outcome'] } = {},
  ): Promise<Page<EmailAttemptLogView>> {
    const boundedLimit = pageSize(limit)
    let offset = decodeCursor(cursor)
    const items: EmailAttemptLogView[] = []
    let hasMore = false
    // Read bounded chunks so filters do not force an unbounded Redis scan.
    for (let pages = 0; pages < 10 && items.length < boundedLimit; pages++) {
      const raw = await this.redis.zrevrange(this.keys[0], offset, offset + boundedLimit, 'WITHSCORES')
      const pairs = scoredMembers(raw)
      if (pairs.length === 0) {
        break
      }
      const batch = pairs.slice(0, boundedLimit)
      const payloads = await this.redis.hmget(this.keys[1], ...batch.map(({ id }) => id))
      for (const payload of payloads) {
        if (!payload) {
          continue
        }
        const entry = parseLogEntry(payload)
        if (
          (!query.relayId || entry.relayId === query.relayId) &&
          (!query.outcome || entry.outcome === query.outcome)
        ) {
          items.push(entry)
          if (items.length === boundedLimit) {
            break
          }
        }
      }
      offset += batch.length
      hasMore = pairs.length > boundedLimit
      if (!hasMore) {
        break
      }
    }

    return { items, ...(hasMore ? { nextCursor: encodeCursor(offset) } : {}) }
  }
}

function assertQueuedEmail(job: QueuedEmail): void {
  if (
    !job.id ||
    job.id.length > 128 ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 0 ||
    !Number.isSafeInteger(job.maxAttempts) ||
    job.maxAttempts < 1 ||
    job.maxAttempts > 100 ||
    !Number.isSafeInteger(job.createdAt) ||
    !Number.isSafeInteger(job.nextAttemptAt)
  ) {
    throw new Error('Email delivery job is invalid.')
  }
}

function assertSameJob(claim: ClaimedEmail, job: QueuedEmail): void {
  if (claim.job.id !== job.id) {
    throw new Error('A claimed email can settle only its own job.')
  }
}

function parseQueuedEmail(value: string): QueuedEmail {
  const parsed = JSON.parse(value) as QueuedEmail
  assertQueuedEmail(parsed)
  return parsed
}

function assertLogEntry(entry: EmailAttemptLog): void {
  if (
    !entry.id ||
    !entry.jobId ||
    !entry.relayId ||
    !Number.isSafeInteger(entry.attempt) ||
    entry.attempt < 1 ||
    !Number.isSafeInteger(entry.durationMs) ||
    entry.durationMs < 0 ||
    !Number.isSafeInteger(entry.createdAt)
  ) {
    throw new Error('Email delivery attempt log is invalid.')
  }
}

function parseLogEntry(value: string): EmailAttemptLog {
  const parsed = JSON.parse(value) as EmailAttemptLog
  assertLogEntry(parsed)
  return parsed
}

function toQueueView(job: QueuedEmail, state: QueueState, score: number): QueueItemView {
  return {
    id: job.id,
    state,
    source: job.source,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    ...(state === 'ready' ? { nextAttemptAt: score } : {}),
    ...(state === 'leased' ? { leaseExpiresAt: score } : {}),
    ...(job.lastRelayId ? { lastRelayId: job.lastRelayId } : {}),
    ...(job.lastFailureClass ? { lastFailureClass: job.lastFailureClass } : {}),
  }
}

function arrayResult(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function scoredMembers(values: string[]): Array<{ id: string; score: number }> {
  const result: Array<{ id: string; score: number }> = []
  for (let index = 0; index + 1 < values.length; index += 2) {
    const score = Number(values[index + 1])
    if (Number.isFinite(score)) {
      result.push({ id: values[index], score })
    }
  }
  return result
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('Email delivery queue options are invalid.')
  }
  return value
}

function pageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Email delivery page size is invalid.')
  }
  return Math.min(value, MAX_PAGE_SIZE)
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0
  }
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Email delivery cursor is invalid.')
  }
  return value
}
