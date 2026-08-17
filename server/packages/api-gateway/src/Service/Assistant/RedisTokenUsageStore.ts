import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import * as IORedis from 'ioredis'

import { ASSISTANT_REQUEST_RESERVATION_RENEWAL_MS, ASSISTANT_REQUEST_RESERVATION_TTL_MS } from './AssistantRequestQuota'
import { FIVE_HOUR_WINDOW_MS, TokenUsageEntry, TokenWindowId, WEEKLY_WINDOW_MS } from './tokenMetering'

export const SUBSCRIPTION_USAGE_SUBJECT = '__subscription__'

export function subscriptionUsageSubject(subscriptionId: string): string {
  return `${SUBSCRIPTION_USAGE_SUBJECT}:${subscriptionId}`
}

const KEY_TTL_SECONDS = Math.ceil(WEEKLY_WINDOW_MS / 1000) + 60 * 60
const TOKEN_BUCKET_MS = 5 * 60 * 1000
const PENDING_FIELD = '__pending'
const LEGACY_MIGRATED_FIELD = '__legacy_migrated'

type TokenQuotaKeys = {
  buckets: string
  pending: string
  ledger: string
}

// Usage is bucketed at five-minute resolution. That retains a conservative
// rolling window for at most one extra bucket while bounding every admission to
// 2,017 fields instead of scanning an unbounded week of request tombstones.
const RESERVE_SCRIPT = `
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local five_cutoff = now - ${FIVE_HOUR_WINDOW_MS}
local week_cutoff = now - ${WEEKLY_WINDOW_MS}
local bucket_width = ${TOKEN_BUCKET_MS}
local entries = redis.call('HGETALL', KEYS[1])
local five_used = tonumber(redis.call('HGET', KEYS[1], '${PENDING_FIELD}') or '0')
local weekly_used = five_used
local oldest_five = 0
local oldest_week = 0

for index = 1, #entries, 2 do
  local field = entries[index]
  if string.sub(field, 1, 2) ~= '__' then
    local bucket = tonumber(field) or 0
    local tokens = tonumber(entries[index + 1]) or 0
    if bucket + bucket_width <= week_cutoff then
      redis.call('HDEL', KEYS[1], field)
    elseif tokens > 0 then
      weekly_used = weekly_used + tokens
      if oldest_week == 0 or bucket < oldest_week then oldest_week = bucket end
      if bucket + bucket_width > five_cutoff then
        five_used = five_used + tokens
        if oldest_five == 0 or bucket < oldest_five then oldest_five = bucket end
      end
    end
  end
end

local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, reservation_id in ipairs(expired) do
  local state = redis.call('HGET', KEYS[3], reservation_id)
  if state and string.sub(state, 1, 8) == 'pending:' then
    local separator = string.find(state, ':', 9)
    local reserved = separator and tonumber(string.sub(state, 9, separator - 1)) or 0
    five_used = five_used - reserved
    weekly_used = weekly_used - reserved
    redis.call('HINCRBY', KEYS[1], '${PENDING_FIELD}', -reserved)
  end
  redis.call('HDEL', KEYS[3], reservation_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)

local reservation_id = ARGV[6]
local state = redis.call('HGET', KEYS[3], reservation_id)
if state and string.sub(state, 1, 8) == 'pending:' then
  local separator = string.find(state, ':', 9)
  local reserved = separator and tonumber(string.sub(state, 9, separator - 1)) or 0
  local granted = separator and tonumber(string.sub(state, separator + 1)) or 0
  return { 1, 0, five_used, weekly_used, 0, granted, reserved }
end
if state then return { 0, 3, five_used, weekly_used, now, 0, 0 } end

local prompt = tonumber(ARGV[4])
local requested_output = tonumber(ARGV[5])
local capacity = prompt + requested_output
local five_limit = tonumber(ARGV[1])
local weekly_limit = tonumber(ARGV[2])
if five_limit > 0 then capacity = math.min(capacity, five_limit - five_used) end
if weekly_limit > 0 then capacity = math.min(capacity, weekly_limit - weekly_used) end

if capacity <= prompt then
  local window = 1
  local reset_at = oldest_five > 0 and oldest_five + bucket_width + ${FIVE_HOUR_WINDOW_MS} or now
  if weekly_limit > 0 and (five_limit <= 0 or weekly_limit - weekly_used <= five_limit - five_used) then
    window = 2
    reset_at = oldest_week > 0 and oldest_week + bucket_width + ${WEEKLY_WINDOW_MS} or now
  end
  local earliest_pending = tonumber(redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')[2] or '0')
  if earliest_pending > 0 and (reset_at == now or earliest_pending < reset_at) then reset_at = earliest_pending end
  return { 0, window, five_used, weekly_used, reset_at, 0, 0 }
end

local granted_output = math.min(requested_output, capacity - prompt)
local reserved = prompt + granted_output
redis.call('HINCRBY', KEYS[1], '${PENDING_FIELD}', reserved)
redis.call('HSET', KEYS[3], reservation_id, 'pending:' .. reserved .. ':' .. granted_output)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), reservation_id)
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('EXPIRE', KEYS[2], ARGV[7])
redis.call('EXPIRE', KEYS[3], ARGV[7])
return { 1, 0, five_used + reserved, weekly_used + reserved, 0, granted_output, reserved }
`

const REFRESH_SCRIPT = `
local state = redis.call('HGET', KEYS[2], ARGV[2])
if not state or string.sub(state, 1, 8) ~= 'pending:' then return 0 end
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[2]) or '0')
if expires_at <= now then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`

const COMMIT_SCRIPT = `
local state = redis.call('HGET', KEYS[3], ARGV[3])
if state and string.sub(state, 1, 10) == 'committed:' then return { 1, 0 } end
if not state or string.sub(state, 1, 8) ~= 'pending:' then return { 0, 0 } end
local separator = string.find(state, ':', 9)
local reserved = separator and tonumber(string.sub(state, 9, separator - 1)) or 0
local actual = tonumber(ARGV[1])
if actual > reserved then return { -1, reserved } end
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[3]) or '0')
if expires_at <= now then return { 0, reserved } end
local bucket = math.floor(now / ${TOKEN_BUCKET_MS}) * ${TOKEN_BUCKET_MS}
redis.call('HINCRBY', KEYS[1], '${PENDING_FIELD}', -reserved)
redis.call('HINCRBY', KEYS[1], tostring(bucket), actual)
redis.call('HSET', KEYS[3], ARGV[3], 'committed:' .. actual)
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return { 1, reserved - actual }
`

const RELEASE_SCRIPT = `
local state = redis.call('HGET', KEYS[3], ARGV[1])
if not state then return 1 end
if string.sub(state, 1, 10) == 'committed:' then return 0 end
if string.sub(state, 1, 8) == 'pending:' then
  local separator = string.find(state, ':', 9)
  local reserved = separator and tonumber(string.sub(state, 9, separator - 1)) or 0
  redis.call('HINCRBY', KEYS[1], '${PENDING_FIELD}', -reserved)
end
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return 1
`

const RECORD_SCRIPT = `
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local bucket = math.floor(now / ${TOKEN_BUCKET_MS}) * ${TOKEN_BUCKET_MS}
redis.call('HINCRBY', KEYS[1], tostring(bucket), ARGV[1])
local cutoff = now - ${WEEKLY_WINDOW_MS}
local entries = redis.call('HGETALL', KEYS[1])
for index = 1, #entries, 2 do
  if string.sub(entries[index], 1, 2) ~= '__' then
    local old_bucket = tonumber(entries[index]) or 0
    if old_bucket + ${TOKEN_BUCKET_MS} <= cutoff then redis.call('HDEL', KEYS[1], entries[index]) end
  end
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return now
`

const READ_BUCKETS_SCRIPT = `
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local cutoff = now - ${WEEKLY_WINDOW_MS}
local entries = redis.call('HGETALL', KEYS[1])
local result = {}
for index = 1, #entries, 2 do
  if string.sub(entries[index], 1, 2) ~= '__' then
    local bucket = tonumber(entries[index]) or 0
    local tokens = tonumber(entries[index + 1]) or 0
    if bucket + ${TOKEN_BUCKET_MS} > cutoff and tokens > 0 then
      table.insert(result, bucket .. ':' .. tokens .. ':bucket')
    end
  end
end
return result
`

const MIGRATE_LEGACY_SCRIPT = `
if redis.call('HGET', KEYS[1], '${LEGACY_MIGRATED_FIELD}') then return 0 end
for index = 1, #ARGV - 1, 2 do
  local tokens = tonumber(ARGV[index + 1]) or 0
  if tokens > 0 then redis.call('HINCRBY', KEYS[1], ARGV[index], tokens) end
end
redis.call('HSET', KEYS[1], '${LEGACY_MIGRATED_FIELD}', '1')
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return 1
`

export interface TokenUsageStore {
  record(subject: string, tokens: number, now: number): Promise<void>
  entriesWithinWeek(subject: string, now: number): Promise<TokenUsageEntry[]>
}

export interface AssistantTokenQuotaLimits {
  fiveHour: number
  weekly: number
}

export type AssistantTokenQuotaDecision =
  | {
      allowed: true
      fiveHourUsed: number
      weeklyUsed: number
      maxOutputTokens: number
      reservedTokens: number
      reservation: AssistantTokenQuotaReservation
    }
  | {
      allowed: false
      window: TokenWindowId
      usedTokens: number
      limitTokens: number
      resetsAt: string
    }

export class AssistantTokenQuotaReservation {
  private state: 'pending' | 'committed' | 'released' = 'pending'
  private commitPromise?: Promise<void>
  private releasePromise?: Promise<void>
  private refreshPromise?: Promise<boolean>
  private heartbeat?: ReturnType<typeof setInterval>
  private heartbeatDeadline?: ReturnType<typeof setTimeout>
  private heartbeatPromise?: Promise<void>
  private leaseLost = false
  private onLeaseLost?: () => void
  private confirmedUntil: number

  constructor(
    private readonly store: RedisTokenUsageStore,
    private readonly keys: TokenQuotaKeys,
    private readonly reservationId: string,
    reservedAt: number,
    private readonly leaseTtlMs: number,
    private readonly renewalMs: number,
  ) {
    this.confirmedUntil = reservedAt + leaseTtlMs
  }

  async commit(actualTokens: number): Promise<void> {
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) {
      throw new Error('Assistant token usage must be a non-negative safe integer.')
    }
    if (this.state === 'committed') {
      return
    }
    if (this.state === 'released') {
      throw new Error('Assistant token quota reservation was already released.')
    }
    if (this.releasePromise) {
      await this.releasePromise
      throw new Error('Assistant token quota reservation was already released.')
    }
    if (this.commitPromise) {
      return this.commitPromise
    }

    this.commitPromise = this.store
      .commitReservation(this.keys, this.reservationId, actualTokens)
      .then((result) => {
        if (result === 'exceeded') {
          throw new Error('Assistant token usage exceeded its reserved upper bound.')
        }
        if (result === 'expired') {
          this.state = 'released'
          throw new Error('Assistant token quota reservation expired before it could be committed.')
        }
        this.state = 'committed'
      })
      .finally(() => {
        this.commitPromise = undefined
      })
    return this.commitPromise
  }

  async release(): Promise<void> {
    if (this.state === 'released' || this.state === 'committed') {
      return
    }
    if (this.commitPromise) {
      await this.commitPromise
      return
    }
    if (this.releasePromise) {
      return this.releasePromise
    }
    this.releasePromise = this.store
      .releaseReservation(this.keys, this.reservationId)
      .then((released) => {
        this.state = released ? 'released' : 'committed'
      })
      .finally(() => {
        this.releasePromise = undefined
      })
    return this.releasePromise
  }

  async refresh(): Promise<boolean> {
    if (this.state !== 'pending') {
      return false
    }
    if (this.refreshPromise) {
      return this.refreshPromise
    }
    const refreshStartedAt = performance.now()
    this.refreshPromise = this.store
      .refreshReservation(this.keys, this.reservationId)
      .then((refreshed) => {
        if (refreshed) {
          this.confirmedUntil = refreshStartedAt + this.leaseTtlMs
        } else if (this.state === 'pending') {
          this.state = 'released'
        }
        return refreshed
      })
      .finally(() => {
        this.refreshPromise = undefined
      })
    return this.refreshPromise
  }

  startHeartbeat(onLeaseLost: () => void): void {
    if (this.heartbeat || this.state !== 'pending') {
      return
    }
    this.onLeaseLost = onLeaseLost
    this.scheduleHeartbeatDeadline()
    this.heartbeat = setInterval(() => {
      if (this.heartbeatPromise) {
        return
      }
      this.heartbeatPromise = this.refresh()
        .then((refreshed) => {
          if (!refreshed) {
            this.notifyLeaseLost()
          } else {
            this.scheduleHeartbeatDeadline()
          }
        })
        .catch(() => {
          if (performance.now() >= this.confirmedUntil) {
            this.notifyLeaseLost()
          }
        })
        .finally(() => {
          this.heartbeatPromise = undefined
        })
    }, this.renewalMs)
    this.heartbeat.unref?.()
  }

  async stopHeartbeat(): Promise<void> {
    this.clearHeartbeatTimer()
    this.onLeaseLost = undefined
    if (this.heartbeatPromise && !this.leaseLost) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.heartbeatPromise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, Math.min(this.renewalMs, 1_000))
          timeout.unref?.()
        }),
      ])
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    if (this.heartbeatDeadline) {
      clearTimeout(this.heartbeatDeadline)
      this.heartbeatDeadline = undefined
    }
  }

  private scheduleHeartbeatDeadline(): void {
    if (!this.onLeaseLost || this.leaseLost) {
      return
    }
    if (this.heartbeatDeadline) {
      clearTimeout(this.heartbeatDeadline)
    }
    const remaining = Math.max(0, this.confirmedUntil - performance.now())
    this.heartbeatDeadline = setTimeout(() => this.notifyLeaseLost(), remaining)
    this.heartbeatDeadline.unref?.()
  }

  private notifyLeaseLost(): void {
    if (this.leaseLost) {
      return
    }
    this.leaseLost = true
    this.clearHeartbeatTimer()
    this.onLeaseLost?.()
  }
}

export class RedisTokenUsageStore implements TokenUsageStore {
  private readonly legacyMigrationPromises = new Map<string, Promise<void>>()

  constructor(
    private readonly redis: IORedis.Redis,
    private readonly leaseTtlMs = ASSISTANT_REQUEST_RESERVATION_TTL_MS,
    private readonly renewalMs = ASSISTANT_REQUEST_RESERVATION_RENEWAL_MS,
  ) {}

  async reserve(
    subject: string,
    promptTokens: number,
    requestedMaxOutputTokens: number,
    limits: AssistantTokenQuotaLimits,
  ): Promise<AssistantTokenQuotaDecision> {
    this.validateReservation(promptTokens, requestedMaxOutputTokens, limits)
    await this.ensureLegacyMigrated(subject)
    const keys = this.quotaKeys(subject)
    const reservationId = randomUUID()
    const reserveStartedAt = performance.now()
    const raw = await this.redis.eval(
      RESERVE_SCRIPT,
      3,
      keys.buckets,
      keys.pending,
      keys.ledger,
      limits.fiveHour,
      limits.weekly,
      this.leaseTtlMs,
      promptTokens,
      requestedMaxOutputTokens,
      reservationId,
      KEY_TTL_SECONDS,
    )
    const [allowed, windowCode, fiveHourUsed, weeklyUsed, resetAt, grantedOutput, reservedTokens] =
      parseReservationResult(raw)
    if (!allowed) {
      const window: TokenWindowId = windowCode === 1 ? 'fiveHour' : 'weekly'
      return {
        allowed: false,
        window,
        usedTokens: window === 'fiveHour' ? fiveHourUsed : weeklyUsed,
        limitTokens: window === 'fiveHour' ? limits.fiveHour : limits.weekly,
        resetsAt: new Date(resetAt).toISOString(),
      }
    }

    return {
      allowed: true,
      fiveHourUsed,
      weeklyUsed,
      maxOutputTokens: grantedOutput,
      reservedTokens,
      reservation: new AssistantTokenQuotaReservation(
        this,
        keys,
        reservationId,
        reserveStartedAt,
        this.leaseTtlMs,
        this.renewalMs,
      ),
    }
  }

  async record(subject: string, tokens: number, _now: number): Promise<void> {
    const rounded = Math.round(tokens)
    if (rounded <= 0) {
      return
    }
    if (!Number.isSafeInteger(rounded)) {
      throw new Error('Assistant token usage must be a safe integer.')
    }
    await this.ensureLegacyMigrated(subject)
    await this.redis.eval(RECORD_SCRIPT, 1, this.quotaKeys(subject).buckets, rounded, KEY_TTL_SECONDS)
  }

  async entriesWithinWeek(subject: string, now: number): Promise<TokenUsageEntry[]> {
    void now
    await this.ensureLegacyMigrated(subject)
    const rawBuckets = await this.redis.eval(READ_BUCKETS_SCRIPT, 1, this.quotaKeys(subject).buckets)
    if (!Array.isArray(rawBuckets)) {
      throw new Error('Assistant token usage returned an invalid Redis result.')
    }
    const buckets = rawBuckets
      .map((member) => parseMember(String(member)))
      .filter((entry): entry is TokenUsageEntry => entry !== null)
    return buckets
  }

  async refreshReservation(keys: TokenQuotaKeys, reservationId: string): Promise<boolean> {
    const raw = await this.redis.eval(
      REFRESH_SCRIPT,
      2,
      keys.pending,
      keys.ledger,
      this.leaseTtlMs,
      reservationId,
      KEY_TTL_SECONDS,
    )
    return parseBooleanResult(raw, 'refresh')
  }

  async commitReservation(
    keys: TokenQuotaKeys,
    reservationId: string,
    actualTokens: number,
  ): Promise<'committed' | 'expired' | 'exceeded'> {
    const raw = await this.redis.eval(
      COMMIT_SCRIPT,
      3,
      keys.buckets,
      keys.pending,
      keys.ledger,
      actualTokens,
      KEY_TTL_SECONDS,
      reservationId,
    )
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error('Assistant token quota commit returned an invalid Redis result.')
    }
    const status = Number(raw[0])
    if (status === -1) {
      return 'exceeded'
    }
    if (status === 0) {
      return 'expired'
    }
    if (status === 1) {
      return 'committed'
    }
    throw new Error('Assistant token quota commit returned an invalid Redis result.')
  }

  async releaseReservation(keys: TokenQuotaKeys, reservationId: string): Promise<boolean> {
    const raw = await this.redis.eval(
      RELEASE_SCRIPT,
      3,
      keys.buckets,
      keys.pending,
      keys.ledger,
      reservationId,
      KEY_TTL_SECONDS,
    )
    return parseBooleanResult(raw, 'release')
  }

  private quotaKeys(subject: string): TokenQuotaKeys {
    const scope = `ai-token-quota:{${subject}}`
    return {
      buckets: `${scope}:buckets`,
      pending: `${scope}:pending`,
      ledger: `${scope}:ledger`,
    }
  }

  private legacyKey(subject: string): string {
    return `ai-token-usage:${subject}`
  }

  private async legacyEntries(subject: string, now: number): Promise<TokenUsageEntry[]> {
    const raw = await this.redis.zrangebyscore(this.legacyKey(subject), now - WEEKLY_WINDOW_MS, '+inf')
    return raw.map(parseMember).filter((entry): entry is TokenUsageEntry => entry !== null)
  }

  private async ensureLegacyMigrated(subject: string): Promise<void> {
    const existing = this.legacyMigrationPromises.get(subject)
    if (existing) {
      return existing
    }

    const migration = (async (): Promise<void> => {
      const bucketKey = this.quotaKeys(subject).buckets
      if ((await this.redis.hget(bucketKey, LEGACY_MIGRATED_FIELD)) === '1') {
        return
      }
      const entries = await this.legacyEntries(subject, Date.now())
      const buckets = new Map<number, number>()
      for (const entry of entries) {
        const bucket = Math.floor(entry.ts / TOKEN_BUCKET_MS) * TOKEN_BUCKET_MS
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + Math.round(entry.tokens))
      }
      const args: Array<string | number> = []
      for (const [bucket, tokens] of [...buckets.entries()].sort(([left], [right]) => left - right)) {
        args.push(bucket, tokens)
      }
      args.push(KEY_TTL_SECONDS)
      await this.redis.eval(MIGRATE_LEGACY_SCRIPT, 1, bucketKey, ...args)
    })()
    this.legacyMigrationPromises.set(subject, migration)
    try {
      await migration
    } catch (error) {
      this.legacyMigrationPromises.delete(subject)
      throw error
    }
  }

  private validateReservation(
    promptTokens: number,
    requestedMaxOutputTokens: number,
    limits: AssistantTokenQuotaLimits,
  ): void {
    if (!Number.isSafeInteger(promptTokens) || promptTokens <= 0) {
      throw new Error('Assistant prompt token bound must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0) {
      throw new Error('Assistant maximum output tokens must be a positive safe integer.')
    }
    for (const limit of [limits.fiveHour, limits.weekly]) {
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new Error('Assistant token quota limits must be non-negative safe integers.')
      }
    }
    if (limits.fiveHour <= 0 && limits.weekly <= 0) {
      throw new Error('At least one assistant token quota limit must be enabled.')
    }
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new Error('Assistant token quota lease TTL must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.renewalMs) || this.renewalMs <= 0 || this.renewalMs >= this.leaseTtlMs) {
      throw new Error('Assistant token quota renewal interval must be shorter than its lease TTL.')
    }
  }
}

function parseReservationResult(raw: unknown): [boolean, number, number, number, number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 7) {
    throw new Error('Assistant token quota returned an invalid Redis result.')
  }
  const values = raw.map(Number)
  if (
    !values.every(Number.isSafeInteger) ||
    (values[0] !== 0 && values[0] !== 1) ||
    values.slice(1).some((value) => value < 0)
  ) {
    throw new Error('Assistant token quota returned an invalid Redis result.')
  }
  return [values[0] === 1, values[1], values[2], values[3], values[4], values[5], values[6]]
}

function parseBooleanResult(raw: unknown, operation: string): boolean {
  const result = Number(raw)
  if (result !== 0 && result !== 1) {
    throw new Error(`Assistant token quota ${operation} returned an invalid Redis result.`)
  }
  return result === 1
}

function parseMember(member: string): TokenUsageEntry | null {
  const [tsPart, tokensPart] = member.split(':')
  const ts = Number(tsPart)
  const tokens = Number(tokensPart)
  if (!Number.isFinite(ts) || !Number.isFinite(tokens)) {
    return null
  }
  return { ts, tokens }
}
