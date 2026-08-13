import * as IORedis from 'ioredis'

import { ProviderEvent } from './providers/types'

// Daily counters outlive their UTC bucket slightly so a request settling around
// midnight can still release the exact reservation it acquired.
export const ASSISTANT_REQUEST_USAGE_TTL_SECONDS = 26 * 60 * 60

const RESERVE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if count > tonumber(ARGV[1]) then
  local current = redis.call('DECR', KEYS[1])
  return { 0, current }
end
return { 1, count }
`

const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then
  return 0
end
return redis.call('DECR', KEYS[1])
`

export function assistantRequestUsageKey(userUuid: string, dayKey: string): string {
  return `ai-usage:${userUuid}:${dayKey}`
}

/**
 * One admitted request. A reservation is charged up front so concurrent calls
 * cannot race past the ceiling, then released exactly once unless the provider
 * completed successfully.
 */
export class AssistantRequestQuotaReservation {
  private committed = false
  private released = false
  private releasePromise?: Promise<void>

  constructor(
    private readonly quota: RedisAssistantRequestQuota,
    private readonly key: string,
  ) {}

  /** Keep this reservation as one completed request. Idempotent. */
  commit(): void {
    if (this.released) {
      return
    }
    this.committed = true
  }

  /**
   * Return a failed/aborted reservation. Concurrent or repeated calls share one
   * Redis operation; a Redis failure leaves it retryable instead of pretending
   * the refund succeeded.
   */
  async release(): Promise<void> {
    if (this.committed || this.released) {
      return
    }
    if (this.releasePromise) {
      return this.releasePromise
    }

    this.releasePromise = this.quota
      .release(this.key)
      .then(() => {
        this.released = true
      })
      .finally(() => {
        this.releasePromise = undefined
      })

    return this.releasePromise
  }
}

export type AssistantRequestQuotaDecision =
  { allowed: true; used: number; reservation: AssistantRequestQuotaReservation } | { allowed: false; used: number }

/** Redis-backed, concurrency-safe daily assistant request admission. */
export class RedisAssistantRequestQuota {
  constructor(
    private readonly redis: IORedis.Redis,
    private readonly ttlSeconds: number = ASSISTANT_REQUEST_USAGE_TTL_SECONDS,
  ) {}

  async reserve(userUuid: string, dayKey: string, limit: number): Promise<AssistantRequestQuotaDecision> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('Assistant request quota limit must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds <= 0) {
      throw new Error('Assistant request quota TTL must be a positive safe integer.')
    }

    const key = assistantRequestUsageKey(userUuid, dayKey)
    const raw = await this.redis.eval(RESERVE_SCRIPT, 1, key, limit, this.ttlSeconds)
    const [allowed, used] = parseReserveResult(raw)

    return allowed
      ? { allowed: true, used, reservation: new AssistantRequestQuotaReservation(this, key) }
      : { allowed: false, used }
  }

  /** @internal Called only by an admitted reservation. */
  async release(key: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, key)
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

/**
 * Tracks whether a provider stream earned its daily request charge. Merely
 * opening a stream, yielding partial text, throwing, timing out, or ending after
 * a client abort is not success: a non-error finish event is required.
 */
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
