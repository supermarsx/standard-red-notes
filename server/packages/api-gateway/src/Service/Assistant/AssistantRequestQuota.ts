import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import * as IORedis from 'ioredis'

import { ProviderEvent } from './providers/types'

export const ASSISTANT_REQUEST_USAGE_TTL_SECONDS = 26 * 60 * 60
export const ASSISTANT_REQUEST_RESERVATION_TTL_MS = 60_000
export const ASSISTANT_REQUEST_RESERVATION_RENEWAL_MS = 20_000

type AssistantRequestQuotaKeys = {
  committed: string
  pending: string
  ledger: string
}

// These three keys share one Redis Cluster hash tag. The legacy pre-lease
// integer is read before this script and supplied as a rolling-deploy baseline.
// Admission stays O(expired leases), not O(all requests made that day).
const RESERVE_SCRIPT = `
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, reservation_id in ipairs(expired) do
  redis.call('HDEL', KEYS[3], reservation_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)

local committed = tonumber(redis.call('GET', KEYS[1]) or '0') + tonumber(ARGV[4])
local state = redis.call('HGET', KEYS[3], ARGV[5])
if state == 'pending' then
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), ARGV[5])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  redis.call('EXPIRE', KEYS[3], ARGV[2])
  return { 1, committed + redis.call('ZCARD', KEYS[2]) }
end
if state == 'committed' then
  return { 1, committed + redis.call('ZCARD', KEYS[2]) }
end

local active = committed + redis.call('ZCARD', KEYS[2])
if active >= tonumber(ARGV[1]) then
  return { 0, active }
end

redis.call('HSET', KEYS[3], ARGV[5], 'pending')
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return { 1, active + 1 }
`

const REFRESH_SCRIPT = `
if redis.call('HGET', KEYS[2], ARGV[2]) ~= 'pending' then return 0 end
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[2]) or '0')
if expires_at <= now then
  redis.call('HDEL', KEYS[2], ARGV[2])
  redis.call('ZREM', KEYS[1], ARGV[2])
  return 0
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`

const COMMIT_SCRIPT = `
local state = redis.call('HGET', KEYS[3], ARGV[2])
local committed = tonumber(redis.call('GET', KEYS[1]) or '0')
if state == 'committed' then return { 1, committed } end
if state ~= 'pending' then return { 0, committed } end
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[2]) or '0')
if expires_at <= now then
  redis.call('HDEL', KEYS[3], ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[2])
  return { 0, committed }
end
redis.call('HSET', KEYS[3], ARGV[2], 'committed')
redis.call('ZREM', KEYS[2], ARGV[2])
committed = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[1])
return { 1, committed }
`

const RELEASE_SCRIPT = `
local state = redis.call('HGET', KEYS[2], ARGV[1])
if not state then return 1 end
if state == 'committed' then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`

export function assistantRequestUsageKey(userUuid: string, dayKey: string): string {
  return `ai-usage:${userUuid}:${dayKey}`
}

function assistantRequestQuotaKeys(userUuid: string, dayKey: string): AssistantRequestQuotaKeys {
  const scope = `ai-usage:{${userUuid}:${dayKey}}`
  return {
    committed: `${scope}:committed`,
    pending: `${scope}:pending`,
    ledger: `${scope}:ledger`,
  }
}

export class AssistantRequestQuotaReservation {
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
    private readonly quota: RedisAssistantRequestQuota,
    private readonly keys: AssistantRequestQuotaKeys,
    private readonly reservationId: string,
    reservedAt: number,
    private readonly leaseTtlMs: number,
    private readonly renewalMs: number,
  ) {
    this.confirmedUntil = reservedAt + leaseTtlMs
  }

  async commit(): Promise<void> {
    if (this.state === 'committed') {
      return
    }
    if (this.state === 'released') {
      throw new Error('Assistant request quota reservation was already released.')
    }
    if (this.releasePromise) {
      await this.releasePromise
      throw new Error('Assistant request quota reservation was already released.')
    }
    if (this.commitPromise) {
      return this.commitPromise
    }

    this.commitPromise = this.quota
      .commit(this.keys, this.reservationId)
      .then((committed) => {
        if (!committed) {
          this.state = 'released'
          throw new Error('Assistant request quota reservation expired before it could be committed.')
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

    this.releasePromise = this.quota
      .release(this.keys, this.reservationId)
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
    this.refreshPromise = this.quota
      .refresh(this.keys, this.reservationId)
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

export type AssistantRequestQuotaDecision =
  { allowed: true; used: number; reservation: AssistantRequestQuotaReservation } | { allowed: false; used: number }

export class RedisAssistantRequestQuota {
  constructor(
    private readonly redis: IORedis.Redis,
    private readonly ttlSeconds: number = ASSISTANT_REQUEST_USAGE_TTL_SECONDS,
    private readonly leaseTtlMs: number = ASSISTANT_REQUEST_RESERVATION_TTL_MS,
    private readonly renewalMs: number = ASSISTANT_REQUEST_RESERVATION_RENEWAL_MS,
  ) {}

  async reserve(userUuid: string, dayKey: string, limit: number): Promise<AssistantRequestQuotaDecision> {
    this.validateConfiguration(limit)
    const legacyRaw = await this.redis.get(assistantRequestUsageKey(userUuid, dayKey))
    const legacyCommitted = legacyRaw === null ? 0 : Number(legacyRaw)
    if (!Number.isSafeInteger(legacyCommitted) || legacyCommitted < 0) {
      throw new Error('Assistant request quota legacy usage returned an invalid Redis result.')
    }

    const keys = assistantRequestQuotaKeys(userUuid, dayKey)
    const reservationId = randomUUID()
    const reserveStartedAt = performance.now()
    const raw = await this.redis.eval(
      RESERVE_SCRIPT,
      3,
      keys.committed,
      keys.pending,
      keys.ledger,
      limit,
      this.ttlSeconds,
      this.leaseTtlMs,
      legacyCommitted,
      reservationId,
    )
    const [allowed, used] = parseReserveResult(raw)
    return allowed
      ? {
          allowed: true,
          used,
          reservation: new AssistantRequestQuotaReservation(
            this,
            keys,
            reservationId,
            reserveStartedAt,
            this.leaseTtlMs,
            this.renewalMs,
          ),
        }
      : { allowed: false, used }
  }

  async committedUsage(userUuid: string, dayKey: string): Promise<number> {
    const keys = assistantRequestQuotaKeys(userUuid, dayKey)
    const [legacyRaw, committedRaw] = await Promise.all([
      this.redis.get(assistantRequestUsageKey(userUuid, dayKey)),
      this.redis.get(keys.committed),
    ])
    const values = [legacyRaw, committedRaw].map((raw) => (raw === null ? 0 : Number(raw)))
    if (!values.every((used) => Number.isSafeInteger(used) && used >= 0)) {
      throw new Error('Assistant request quota usage returned an invalid Redis result.')
    }
    return values[0] + values[1]
  }

  async refresh(keys: AssistantRequestQuotaKeys, reservationId: string): Promise<boolean> {
    const raw = await this.redis.eval(
      REFRESH_SCRIPT,
      2,
      keys.pending,
      keys.ledger,
      this.leaseTtlMs,
      reservationId,
      this.ttlSeconds,
    )
    return parseBooleanResult(raw, 'refresh')
  }

  async commit(keys: AssistantRequestQuotaKeys, reservationId: string): Promise<boolean> {
    const raw = await this.redis.eval(
      COMMIT_SCRIPT,
      3,
      keys.committed,
      keys.pending,
      keys.ledger,
      this.ttlSeconds,
      reservationId,
    )
    const [committed] = parseReserveResult(raw)
    return committed
  }

  async release(keys: AssistantRequestQuotaKeys, reservationId: string): Promise<boolean> {
    const raw = await this.redis.eval(RELEASE_SCRIPT, 2, keys.pending, keys.ledger, reservationId, this.ttlSeconds)
    return parseBooleanResult(raw, 'release')
  }

  private validateConfiguration(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('Assistant request quota limit must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds <= 0) {
      throw new Error('Assistant request quota TTL must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new Error('Assistant request quota reservation TTL must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.renewalMs) || this.renewalMs <= 0 || this.renewalMs >= this.leaseTtlMs) {
      throw new Error('Assistant request quota renewal interval must be shorter than its reservation TTL.')
    }
  }
}

function parseReserveResult(raw: unknown): [allowed: boolean, used: number] {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error('Assistant request quota returned an invalid Redis result.')
  }
  const allowed = Number(raw[0])
  const used = Number(raw[1])
  if ((allowed !== 0 && allowed !== 1) || !Number.isSafeInteger(used) || used < 0) {
    throw new Error('Assistant request quota returned an invalid Redis result.')
  }
  return [allowed === 1, used]
}

function parseBooleanResult(raw: unknown, operation: string): boolean {
  const result = Number(raw)
  if (result !== 0 && result !== 1) {
    throw new Error(`Assistant request quota ${operation} returned an invalid Redis result.`)
  }
  return result === 1
}

export class AssistantRequestOutcome {
  private successfulFinish = false
  private failed = false

  observe(event: ProviderEvent): void {
    if (event.kind === 'error') {
      this.failed = true
      return
    }
    if (event.kind === 'finish') {
      if (event.stopReason === 'error') {
        this.failed = true
      } else {
        this.successfulFinish = true
      }
    }
  }

  markFailed(): void {
    this.failed = true
  }

  get shouldConsumeAllowance(): boolean {
    return this.successfulFinish && !this.failed
  }
}
