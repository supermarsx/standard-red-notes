import * as IORedis from 'ioredis'

import { AssistantRequestOutcome, assistantRequestUsageKey, RedisAssistantRequestQuota } from './AssistantRequestQuota'

class FakeRedis {
  readonly values = new Map<string, number>()
  readonly expirations = new Map<string, number>()
  releaseCalls = 0
  failNextRelease = false

  async eval(script: string, _numberOfKeys: number, key: string, ...args: Array<string | number>): Promise<unknown> {
    if (script.includes("redis.call('INCR'")) {
      const limit = Number(args[0])
      const ttl = Number(args[1])
      const incremented = (this.values.get(key) ?? 0) + 1
      this.values.set(key, incremented)
      if (incremented === 1) {
        this.expirations.set(key, ttl)
      }
      if (incremented > limit) {
        const current = incremented - 1
        this.values.set(key, current)
        return [0, current]
      }
      return [1, incremented]
    }

    this.releaseCalls += 1
    if (this.failNextRelease) {
      this.failNextRelease = false
      throw new Error('redis unavailable')
    }
    const current = this.values.get(key) ?? 0
    const next = Math.max(0, current - 1)
    this.values.set(key, next)
    return next
  }
}

const USER_UUID = 'user-1'
const DAY_KEY = '2026-08-13'

describe('RedisAssistantRequestQuota', () => {
  it('admits at most the limit under concurrent reservation and keeps successful charges', async () => {
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
    for (const decision of admitted) {
      if (decision.allowed) {
        decision.reservation.commit()
      }
    }
    expect(redis.values.get(assistantRequestUsageKey(USER_UUID, DAY_KEY))).toBe(2)
    expect(redis.expirations.get(assistantRequestUsageKey(USER_UUID, DAY_KEY))).toBe(1234)
    await expect(quota.reserve(USER_UUID, DAY_KEY, 2)).resolves.toMatchObject({ allowed: false, used: 2 })
  })

  it('returns a failed request reservation so a later successful request can use it', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const first = await quota.reserve(USER_UUID, DAY_KEY, 1)
    expect(first.allowed).toBe(true)
    if (!first.allowed) {
      throw new Error('expected first reservation to be admitted')
    }

    await first.reservation.release()
    expect(redis.values.get(assistantRequestUsageKey(USER_UUID, DAY_KEY))).toBe(0)

    const replacement = await quota.reserve(USER_UUID, DAY_KEY, 1)
    expect(replacement.allowed).toBe(true)
    if (replacement.allowed) {
      replacement.reservation.commit()
    }
    expect(redis.values.get(assistantRequestUsageKey(USER_UUID, DAY_KEY))).toBe(1)
  })

  it('releases once when failure paths race or repeat', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }

    await Promise.all([decision.reservation.release(), decision.reservation.release(), decision.reservation.release()])

    expect(redis.releaseCalls).toBe(1)
    expect(redis.values.get(assistantRequestUsageKey(USER_UUID, DAY_KEY))).toBe(0)
  })

  it('keeps a failed Redis refund retryable and never underflows the counter', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)
    const decision = await quota.reserve(USER_UUID, DAY_KEY, 1)
    if (!decision.allowed) {
      throw new Error('expected reservation to be admitted')
    }
    redis.failNextRelease = true

    await expect(decision.reservation.release()).rejects.toThrow('redis unavailable')
    await expect(decision.reservation.release()).resolves.toBeUndefined()
    await expect(decision.reservation.release()).resolves.toBeUndefined()

    expect(redis.releaseCalls).toBe(2)
    expect(redis.values.get(assistantRequestUsageKey(USER_UUID, DAY_KEY))).toBe(0)
  })

  it('rejects invalid limits before touching Redis', async () => {
    const redis = new FakeRedis()
    const quota = new RedisAssistantRequestQuota(redis as unknown as IORedis.Redis)

    await expect(quota.reserve(USER_UUID, DAY_KEY, 0)).rejects.toThrow('positive safe integer')
    await expect(quota.reserve(USER_UUID, DAY_KEY, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      'positive safe integer',
    )
    expect(redis.values.size).toBe(0)
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
