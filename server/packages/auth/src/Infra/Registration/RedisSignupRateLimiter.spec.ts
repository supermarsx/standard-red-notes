import * as IORedis from 'ioredis'

import { RedisSignupRateLimiter } from './RedisSignupRateLimiter'

/**
 * Stateful in-memory fake of the slice of ioredis this limiter uses. It models
 * real INCR / EXPIRE(NX) / TTL semantics so the "stranded key with no TTL" state
 * (the permanent-lockout bug) can be reproduced faithfully:
 *   - incr:  creates the key with no TTL when absent, else bumps the counter.
 *   - expire(key, s, 'NX'): sets a TTL ONLY when the key currently has none
 *     (returns 1) and is a no-op when a TTL already exists (returns 0). Without
 *     'NX' it always (re)sets the TTL.
 *   - ttl: -2 (no key), -1 (key exists but no TTL), else remaining seconds.
 */
class FakeRedis {
  private values = new Map<string, number>()
  private ttls = new Map<string, number>()

  async incr(key: string): Promise<number> {
    const next = (this.values.get(key) ?? 0) + 1
    this.values.set(key, next)

    return next
  }

  async expire(key: string, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT'): Promise<number> {
    if (!this.values.has(key)) {
      return 0
    }
    if (mode === 'NX' && this.ttls.has(key)) {
      return 0
    }
    if (mode === 'XX' && !this.ttls.has(key)) {
      return 0
    }
    this.ttls.set(key, seconds)

    return 1
  }

  async ttl(key: string): Promise<number> {
    if (!this.values.has(key)) {
      return -2
    }
    if (!this.ttls.has(key)) {
      return -1
    }

    return this.ttls.get(key) as number
  }

  /**
   * Force the exact real-world stranded state: the key exists from a prior INCR
   * but its EXPIRE never landed (process restart in the INCR→EXPIRE gap, or a
   * transient Redis error on the EXPIRE), so it has NO TTL and will live forever.
   */
  strandWithoutTtl(key: string, count: number): void {
    this.values.set(key, count)
    this.ttls.delete(key)
  }

  /** Simulate time passing within the window (TTL decays but stays positive). */
  advanceTtlTo(key: string, seconds: number): void {
    this.ttls.set(key, seconds)
  }
}

describe('RedisSignupRateLimiter', () => {
  let fake: FakeRedis
  let limiter: RedisSignupRateLimiter

  beforeEach(() => {
    fake = new FakeRedis()
    limiter = new RedisSignupRateLimiter(fake as unknown as IORedis.Redis)
  })

  it('arms the window TTL on the first increment of a fresh key', async () => {
    const key = 'signup:ip:203.0.113.5'

    expect(await fake.ttl(key)).toEqual(-2)

    const count = await limiter.incrementAndCount(key, 60)

    expect(count).toEqual(1)
    expect(await fake.ttl(key)).toEqual(60)
  })

  // *** Regression for the permanent-IP-lockout bug (finding D). ***
  // A key that exists with NO TTL (its EXPIRE was lost) must get its TTL re-armed
  // on the NEXT call, so the counter can eventually reset instead of climbing
  // across windows forever. This is the false-green test: pre-fix the TTL stays
  // -1 here (TTL was armed only when the post-incr count was 1), so the key lives
  // forever and, once past the cap, refuses the IP permanently.
  it('re-arms the TTL of a stranded no-TTL key on the next increment (self-heal)', async () => {
    const key = 'signup:ip:198.51.100.9'
    fake.strandWithoutTtl(key, 5)

    expect(await fake.ttl(key)).toEqual(-1)

    const count = await limiter.incrementAndCount(key, 60)

    expect(count).toEqual(6)
    // The key can now expire and reset — no permanent lockout.
    expect(await fake.ttl(key)).toBeGreaterThan(0)
    expect(await fake.ttl(key)).toEqual(60)
  })

  it('does NOT slide the window on later hits (NX leaves a live TTL untouched)', async () => {
    const key = 'signup:ip:192.0.2.1'

    await limiter.incrementAndCount(key, 60)
    // 40s later, still inside the window.
    fake.advanceTtlTo(key, 40)

    await limiter.incrementAndCount(key, 60)

    // NX must not reset it back to 60 — fixed window, not sliding.
    expect(await fake.ttl(key)).toEqual(40)
  })

  it('never leaves any key without a TTL across a burst of increments', async () => {
    const key = 'signup:ip:192.0.2.7'

    for (let i = 0; i < 25; i++) {
      await limiter.incrementAndCount(key, 60)
      expect(await fake.ttl(key)).toBeGreaterThan(0)
    }
  })

  it('does not attempt to arm a TTL when windowSeconds is not positive', async () => {
    const expireSpy = jest.spyOn(fake, 'expire')
    const key = 'signup:ip:192.0.2.42'

    const count = await limiter.incrementAndCount(key, 0)

    expect(count).toEqual(1)
    expect(expireSpy).not.toHaveBeenCalled()
    expect(await fake.ttl(key)).toEqual(-1)
  })

  it('returns null (fail-open) without touching Redis when the key is empty', async () => {
    const incrSpy = jest.spyOn(fake, 'incr')

    const count = await limiter.incrementAndCount('', 60)

    expect(count).toBeNull()
    expect(incrSpy).not.toHaveBeenCalled()
  })

  it('fails open (returns null) when INCR throws', async () => {
    jest.spyOn(fake, 'incr').mockRejectedValueOnce(new Error('redis down'))

    const count = await limiter.incrementAndCount('signup:ip:192.0.2.99', 60)

    expect(count).toBeNull()
  })

  it('fails open (returns null) when the EXPIRE itself throws', async () => {
    jest.spyOn(fake, 'expire').mockRejectedValueOnce(new Error('expire failed'))

    const count = await limiter.incrementAndCount('signup:ip:192.0.2.123', 60)

    expect(count).toBeNull()
  })
})
