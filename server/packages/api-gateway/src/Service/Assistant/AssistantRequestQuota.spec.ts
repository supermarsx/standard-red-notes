import * as IORedis from 'ioredis'

import { AssistantRequestOutcome, assistantRequestUsageKey, RedisAssistantRequestQuota } from './AssistantRequestQuota'

type QuotaOperation = 'reserve' | 'refresh' | 'commit' | 'release'
type ReservationState = 'pending' | 'committed' | 'released'

class FakeRedis {
  readonly values = new Map<string, number>()
  readonly legacyValues = new Map<string, number>()
  readonly pending = new Map<string, Map<string, number>>()
  readonly ledgers = new Map<string, Map<string, ReservationState>>()
  readonly expirations = new Map<string, number>()
  readonly calls: QuotaOperation[] = []
  failBefore = new Set<QuotaOperation>()
  failAlways = new Set<QuotaOperation>()
  hangAlways = new Set<QuotaOperation>()
  loseReplyAfterApply = new Set<QuotaOperation>()
  redisNow = 1_000_000

  async get(key: string): Promise<string | null> {
    const value = this.legacyValues.get(key) ?? this.values.get(key)
    return value === undefined ? null : String(value)
  }

  committedUsage(): number {
    return [...this.values.values()].reduce((total, value) => total + value, 0)
  }

  async eval(script: string, numberOfKeys: number, ...raw: Array<string | number>): Promise<unknown> {
    const keys = raw.slice(0, numberOfKeys).map(String)
    const args = raw.slice(numberOfKeys)
    const operation: QuotaOperation = script.includes("redis.call('ZRANGEBYSCORE'")
      ? 'reserve'
      : script.includes("redis.call('INCR'")
        ? 'commit'
        : script.includes("redis.call('ZSCORE'")
          ? 'refresh'
          : 'release'
    this.calls.push(operation)

    if (this.failAlways.has(operation) || this.failBefore.delete(operation)) {
      throw new Error(`redis ${operation} unavailable`)
    }
    if (this.hangAlways.has(operation)) {
      return new Promise<unknown>(() => {
        // Simulate an ioredis command whose connection never settles.
      })
    }

    const result =
      operation === 'reserve'
        ? this.reserve(keys, args)
        : operation === 'commit'
          ? this.commit(keys, args)
          : operation === 'refresh'
            ? this.refresh(keys, args)
            : this.release(keys, args)

    if (this.loseReplyAfterApply.delete(operation)) {
      throw new Error(`redis ${operation} reply lost`)
    }

    return result
  }

  private reserve(keys: string[], args: Array<string | number>): [number, number] {
    const [usageKey, pendingKey, ledgerKey] = keys
    const [limitRaw, ttlRaw, leaseTtlRaw, legacyRaw, reservationIdRaw] = args
    const limit = Number(limitRaw)
    const ttl = Number(ttlRaw)
    const leaseTtl = Number(leaseTtlRaw)
    const reservationId = String(reservationIdRaw)
    const pending = this.mapFor(this.pending, pendingKey)
    const ledger = this.mapFor(this.ledgers, ledgerKey)

    for (const [id, expiresAt] of pending) {
      if (expiresAt <= this.redisNow) {
        if (ledger.get(id) === 'pending') {
          ledger.set(id, 'released')
        }
        pending.delete(id)
      }
    }

    const committed = (this.values.get(usageKey) ?? 0) + Number(legacyRaw)
    const state = ledger.get(reservationId)
    if (state === 'pending') {
      pending.set(reservationId, this.redisNow + leaseTtl)
      return [1, committed + pending.size]
    }
    if (state === 'committed') {
      return [1, committed + pending.size]
    }
    if (state) {
      return [0, committed + pending.size]
    }

    const active = committed + pending.size
    if (active >= limit) {
      return [0, active]
    }

    ledger.set(reservationId, 'pending')
    pending.set(reservationId, this.redisNow + leaseTtl)
    this.expirations.set(pendingKey, ttl)
    this.expirations.set(ledgerKey, ttl)
    return [1, active + 1]
  }

  private refresh(keys: string[], args: Array<string | number>): number {
    const [pendingKey, ledgerKey] = keys
    const [leaseTtlRaw, reservationIdRaw, ttlRaw] = args
    const leaseTtl = Number(leaseTtlRaw)
    const reservationId = String(reservationIdRaw)
    const pending = this.mapFor(this.pending, pendingKey)
    const ledger = this.mapFor(this.ledgers, ledgerKey)
    if (ledger.get(reservationId) !== 'pending') {
      return 0
    }
    if ((pending.get(reservationId) ?? 0) <= this.redisNow) {
      ledger.set(reservationId, 'released')
      pending.delete(reservationId)
      return 0
    }

    pending.set(reservationId, this.redisNow + leaseTtl)
    this.expirations.set(pendingKey, Number(ttlRaw))
    this.expirations.set(ledgerKey, Number(ttlRaw))
    return 1
  }

  private commit(keys: string[], args: Array<string | number>): [number, number] {
    const [usageKey, pendingKey, ledgerKey] = keys
    const [ttlRaw, reservationIdRaw] = args
    const reservationId = String(reservationIdRaw)
    const pending = this.mapFor(this.pending, pendingKey)
    const ledger = this.mapFor(this.ledgers, ledgerKey)
    const committed = this.values.get(usageKey) ?? 0
    const state = ledger.get(reservationId)
    if (state === 'committed') {
      return [1, committed]
    }
    if (state !== 'pending') {
      return [0, committed]
    }
    if ((pending.get(reservationId) ?? 0) <= this.redisNow) {
      ledger.set(reservationId, 'released')
      pending.delete(reservationId)
      return [0, committed]
    }

    ledger.set(reservationId, 'committed')
    pending.delete(reservationId)
    const next = committed + 1
    this.values.set(usageKey, next)
    this.expirations.set(usageKey, Number(ttlRaw))
    return [1, next]
  }

  private release(keys: string[], args: Array<string | number>): number {
    const [pendingKey, ledgerKey] = keys
    const [reservationIdRaw, ttlRaw] = args
    const reservationId = String(reservationIdRaw)
    const pending = this.mapFor(this.pending, pendingKey)
    const ledger = this.mapFor(this.ledgers, ledgerKey)
    const state = ledger.get(reservationId)
    if (!state || state === 'released') {
      return 1
    }
    if (state === 'committed') {
      return 0
    }

    ledger.set(reservationId, 'released')
    pending.delete(reservationId)
    this.expirations.set(pendingKey, Number(ttlRaw))
    this.expirations.set(ledgerKey, Number(ttlRaw))
    return 1
  }

  private mapFor<T>(container: Map<string, Map<string, T>>, key: string): Map<string, T> {
    let value = container.get(key)
    if (!value) {
      value = new Map()
      container.set(key, value)
    }
    return value
  }
}

const USER_UUID = 'user-1'
const DAY_KEY = '2026-08-13'
const USAGE_KEY = assistantRequestUsageKey(USER_UUID, DAY_KEY)

describe('RedisAssistantRequestQuota', () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('admits at most the limit under concurrency and charges only awaited commits', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234)

    const decisions = await Promise.all([
      quota.reserve(USER_UUID, DAY_KEY, 2),
      quota.reserve(USER_UUID, DAY_KEY, 2),
      quota.reserve(USER_UUID, DAY_KEY, 2),
    ])
    const admitted = decisions.filter((decision) => decision.allowed)

    expect(admitted).toHaveLength(2)
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1)
    expect(redis.committedUsage()).toBe(0)
    for (const decision of admitted) {
      if (decision.allowed) {
        await decision.reservation.commit()
      }
    }
    expect(redis.committedUsage()).toBe(2)
    expect([...redis.expirations.values()]).toContain(1234)
    await expect(quota.reserve(USER_UUID, DAY_KEY, 2)).resolves.toMatchObject({ allowed: false, used: 2 })
  })

  it('releases a failed request without ever incrementing committed usage', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const first = await quota.reserve(USER_UUID, DAY_KEY, 1)
    expect(first.allowed).toBe(true)
    if (!first.allowed) {
      throw new Error('expected first reservation to be admitted')
    }

    await first.reservation.release()
    expect(redis.committedUsage()).toBe(0)

    const replacement = await quota.reserve(USER_UUID, DAY_KEY, 1)
    expect(replacement.allowed).toBe(true)
    if (replacement.allowed) {
      await replacement.reservation.commit()
    }
    expect(redis.committedUsage()).toBe(1)
  })

  it('releases once when failure paths race or repeat', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }

    await Promise.all([decision.reservation.release(), decision.reservation.release(), decision.reservation.release()])

    expect(redis.calls.filter((operation) => operation === 'release')).toHaveLength(1)
    expect(redis.committedUsage()).toBe(0)
  })

  it('keeps a failed Redis release retryable', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }
    redis.failBefore.add('release')

    await expect(decision.reservation.release()).rejects.toThrow('redis release unavailable')
    await expect(decision.reservation.release()).resolves.toBeUndefined()
    await expect(decision.reservation.release()).resolves.toBeUndefined()

    expect(redis.calls.filter((operation) => operation === 'release')).toHaveLength(2)
    expect(redis.committedUsage()).toBe(0)
  })

  it('makes a lost commit reply idempotent without charging twice', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }
    redis.loseReplyAfterApply.add('commit')

    await expect(decision.reservation.commit()).rejects.toThrow('redis commit reply lost')
    await expect(decision.reservation.commit()).resolves.toBeUndefined()

    expect(redis.calls.filter((operation) => operation === 'commit')).toHaveLength(2)
    expect(redis.committedUsage()).toBe(1)
  })

  it('makes a lost release reply retryable without resurrecting or charging the request', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }
    redis.loseReplyAfterApply.add('release')

    await expect(decision.reservation.release()).rejects.toThrow('redis release reply lost')
    await expect(decision.reservation.release()).resolves.toBeUndefined()

    expect(redis.committedUsage()).toBe(0)
    await expect(quota.reserve(USER_UUID, DAY_KEY, 1)).resolves.toMatchObject({ allowed: true })
  })

  it('reclaims a crashed process lease before admitting replacement work', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234, 1_000, 200)
    const abandoned = await quota.reserve(USER_UUID, DAY_KEY, 1)

    expect(abandoned.allowed).toBe(true)
    await expect(quota.reserve(USER_UUID, DAY_KEY, 1)).resolves.toMatchObject({ allowed: false, used: 1 })

    redis.redisNow += 1_001
    await expect(quota.reserve(USER_UUID, DAY_KEY, 1)).resolves.toMatchObject({ allowed: true, used: 1 })
    expect(redis.committedUsage()).toBe(0)
  })

  it('refuses to commit an expired lease', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234, 1_000, 200)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }

    redis.redisNow += 1_001
    await expect(decision.reservation.commit()).rejects.toThrow('expired before it could be committed')
    expect(redis.committedUsage()).toBe(0)
  })

  it('uses Redis time rather than a gateway wall clock to decide lease expiry', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234, 1_000, 200)

    await expect(quota.reserve(USER_UUID, DAY_KEY, 1)).resolves.toMatchObject({ allowed: true })
    await expect(quota.reserve(USER_UUID, DAY_KEY, 1)).resolves.toMatchObject({ allowed: false, used: 1 })
  })

  it('preserves the prior integer counter as a rolling-deploy baseline', async () => {
    const redis = new FakeRedis()
    redis.legacyValues.set(USAGE_KEY, 2)
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234)

    await expect(quota.committedUsage(USER_UUID, DAY_KEY)).resolves.toBe(2)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 3)
    expect(decision.allowed).toBe(true)
    if (!decision.allowed) {
      throw new Error('expected migration reservation to be admitted')
    }
    await decision.reservation.commit()

    expect(redis.legacyValues.has(USAGE_KEY)).toBe(true)
    await expect(quota.committedUsage(USER_UUID, DAY_KEY)).resolves.toBe(3)
  })

  it('renews a live lease and awaits the final heartbeat before settling', async () => {
    jest.useFakeTimers({ now: 1_000_000 })
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234, 1_000, 200)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }
    const onLeaseLost = jest.fn()

    decision.reservation.startHeartbeat(onLeaseLost)
    await jest.advanceTimersByTimeAsync(800)
    await decision.reservation.stopHeartbeat()
    await jest.advanceTimersByTimeAsync(500)
    await expect(decision.reservation.commit()).resolves.toBeUndefined()

    expect(redis.calls.filter((operation) => operation === 'refresh').length).toBeGreaterThanOrEqual(1)
    expect(onLeaseLost).not.toHaveBeenCalled()
    expect(redis.committedUsage()).toBe(1)
  })

  it('fails a live request closed after Redis cannot renew through the confirmed lease deadline', async () => {
    jest.useFakeTimers({ now: 1_000_000 })
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234, 1_000, 200)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }
    const onLeaseLost = jest.fn()
    redis.failAlways.add('refresh')

    decision.reservation.startHeartbeat(onLeaseLost)
    await jest.advanceTimersByTimeAsync(1_000)
    await decision.reservation.stopHeartbeat()

    expect(onLeaseLost).toHaveBeenCalledTimes(1)
    expect(redis.calls.filter((operation) => operation === 'refresh').length).toBeGreaterThanOrEqual(1)
  })

  it('uses an independent watchdog when a Redis heartbeat never settles', async () => {
    jest.useFakeTimers({ now: 1_000_000 })
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234, 1_000, 200)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }
    const onLeaseLost = jest.fn()
    redis.hangAlways.add('refresh')

    decision.reservation.startHeartbeat(onLeaseLost)
    await jest.advanceTimersByTimeAsync(1_500)
    await decision.reservation.stopHeartbeat()

    expect(onLeaseLost).toHaveBeenCalledTimes(1)
    expect(redis.calls.filter((operation) => operation === 'refresh')).toHaveLength(1)
  })

  it('rejects invalid limits and lease settings before touching Redis', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)

    await expect(quota.reserve(USER_UUID, DAY_KEY, 0)).rejects.toThrow('positive safe integer')
    await expect(quota.reserve(USER_UUID, DAY_KEY, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      'positive safe integer',
    )
    await expect(
      new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis, 1234, 1_000, 1_000).reserve(
        USER_UUID,
        DAY_KEY,
        1,
      ),
    ).rejects.toThrow('renewal interval')
    expect(redis.calls).toHaveLength(0)
  })
})

describe('AssistantRequestOutcome', () => {
  it('charges only a stream that reaches a non-error finish event', () => {
    const outcome = new AssistantRequestOutcome()
    outcome.observe({ kind: 'text-delta', delta: 'hello' })

    expect(outcome.shouldConsumeAllowance).toBe(false)

    outcome.observe({ kind: 'finish', stopReason: 'end_turn' })

    expect(outcome.shouldConsumeAllowance).toBe(true)
  })

  it('does not charge provider error events even if a finish event follows', () => {
    const outcome = new AssistantRequestOutcome()
    outcome.observe({ kind: 'error', message: 'upstream rejected the request' })
    outcome.observe({ kind: 'finish', stopReason: 'end_turn' })

    expect(outcome.shouldConsumeAllowance).toBe(false)
  })

  it('does not charge an explicit error finish', () => {
    const outcome = new AssistantRequestOutcome()
    outcome.observe({ kind: 'finish', stopReason: 'error' })

    expect(outcome.shouldConsumeAllowance).toBe(false)
  })

  it('does not charge a throw, timeout, abort, or truncated stream without successful completion', () => {
    const outcome = new AssistantRequestOutcome()
    outcome.observe({ kind: 'text-delta', delta: 'partial' })
    outcome.markFailed()

    expect(outcome.shouldConsumeAllowance).toBe(false)
  })

  it('lets a late failure override an earlier finish defensively', () => {
    const outcome = new AssistantRequestOutcome()
    outcome.observe({ kind: 'finish', stopReason: 'end_turn' })
    outcome.markFailed()

    expect(outcome.shouldConsumeAllowance).toBe(false)
  })
})
