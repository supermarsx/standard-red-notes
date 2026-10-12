import { DavBridgeRefusal } from './DavBridgeRefusal'
import { DavRelayLimiter, DavRelayLimits, DavSharedCounterStore, DEFAULT_DAV_RELAY_LIMITS } from './DavRelayLimiter'

const refusalOf = (action: () => unknown): DavBridgeRefusal => {
  try {
    action()
  } catch (error) {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    throw error
  }
  throw new Error('expected a refusal, and nothing was thrown')
}

const refusalFrom = async (action: Promise<unknown>): Promise<DavBridgeRefusal> => {
  try {
    await action
  } catch (error) {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    throw error
  }
  throw new Error('expected a refusal, and the call resolved')
}

describe('DavRelayLimiter', () => {
  let now: number
  const clock = (): number => now
  const limits = (overrides: Partial<DavRelayLimits> = {}): DavRelayLimits => ({
    ...DEFAULT_DAV_RELAY_LIMITS,
    ...overrides,
  })

  beforeEach(() => {
    now = 1_000_000_000
  })

  it('ships the limits the contract states', () => {
    expect(DEFAULT_DAV_RELAY_LIMITS).toEqual({
      budgets: {
        requests: { max: 600, windowSeconds: 600 },
        writes: { max: 60, windowSeconds: 60 },
        validations: { max: 10, windowSeconds: 3600 },
      },
      concurrentPerAccount: 2,
      concurrentPerOrigin: 4,
      concurrentTotal: 32,
      breakerFailures: 5,
      breakerOpenSeconds: 300,
    })
  })

  describe('budgets', () => {
    it('allows exactly the budget, refuses the next request, and says how long to wait', async () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let request = 0; request < 600; request++) {
        await limiter.consume('alice', 'requests')
      }
      now += 100_000

      const refusal = await refusalFrom(limiter.consume('alice', 'requests'))

      expect(refusal.tag).toBe('dav-rate-limited')
      expect(refusal.httpStatus).toBe(429)
      expect(refusal.extra).toEqual({ budget: 'requests', retryAfterSeconds: 500 })
      expect(refusal.retryAfterSeconds).toBe(500)
    })

    it('opens a new window when the old one has run out', async () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let request = 0; request < 10; request++) {
        await limiter.consume('alice', 'validations')
      }
      await expect(limiter.consume('alice', 'validations')).rejects.toBeInstanceOf(DavBridgeRefusal)

      now += 3_599_000
      await expect(limiter.consume('alice', 'validations')).rejects.toBeInstanceOf(DavBridgeRefusal)

      now += 1_000
      await expect(limiter.consume('alice', 'validations')).resolves.toBeUndefined()
    })

    it("keeps users and budgets apart: one user's spent budget is nobody else's", async () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let request = 0; request < 10; request++) {
        await limiter.consume('alice', 'validations')
      }

      await expect(limiter.consume('alice', 'validations')).rejects.toBeInstanceOf(DavBridgeRefusal)
      await expect(limiter.consume('bob', 'validations')).resolves.toBeUndefined()
      await expect(limiter.consume('alice', 'requests')).resolves.toBeUndefined()
      await expect(limiter.consume('alice', 'writes')).resolves.toBeUndefined()
    })

    it('does not count a refused attempt against the next window', async () => {
      const limiter = new DavRelayLimiter(
        limits({ budgets: { ...DEFAULT_DAV_RELAY_LIMITS.budgets, writes: { max: 2, windowSeconds: 60 } } }),
        undefined,
        clock,
      )
      await limiter.consume('alice', 'writes')
      await limiter.consume('alice', 'writes')
      for (let attempt = 0; attempt < 50; attempt++) {
        await expect(limiter.consume('alice', 'writes')).rejects.toBeInstanceOf(DavBridgeRefusal)
      }

      now += 60_000
      await limiter.consume('alice', 'writes')
      await limiter.consume('alice', 'writes')
      await expect(limiter.consume('alice', 'writes')).rejects.toBeInstanceOf(DavBridgeRefusal)
    })
  })

  describe('a shared counter store', () => {
    const tight = limits({ budgets: { ...DEFAULT_DAV_RELAY_LIMITS.budgets, requests: { max: 3, windowSeconds: 600 } } })

    it('makes two gateway processes share one budget (the incr/expire contract)', async () => {
      const counters = new Map<string, number>()
      const expiries = new Map<string, number>()
      const shared: DavSharedCounterStore = {
        incr: async (key) => {
          counters.set(key, (counters.get(key) ?? 0) + 1)
          return counters.get(key) as number
        },
        expire: async (key, seconds) => {
          expiries.set(key, seconds)
        },
        ttl: async () => 417,
      }
      const first = new DavRelayLimiter(tight, shared, clock)
      const second = new DavRelayLimiter(tight, shared, clock)

      await first.consume('alice', 'requests')
      await second.consume('alice', 'requests')
      await first.consume('alice', 'requests')
      const refusal = await refusalFrom(second.consume('alice', 'requests'))

      // The second process has only seen two requests itself. The shared count says four.
      expect(refusal.tag).toBe('dav-rate-limited')
      expect(refusal.extra).toEqual({ budget: 'requests', retryAfterSeconds: 417 })
      expect([...counters.keys()]).toEqual(['dav-bridge:requests:alice'])
      // The horizon is attached on the first hit, so the counter cannot live for ever.
      expect(expiries.get('dav-bridge:requests:alice')).toBe(600)
    })

    it('uses the window contract when the store offers it', async () => {
      const calls: Array<[string, number]> = []
      let count = 0
      const shared: DavSharedCounterStore = {
        incrementInWindow: async (key, windowSeconds) => {
          calls.push([key, windowSeconds])
          return ++count
        },
        ttl: async () => 12,
      }
      const limiter = new DavRelayLimiter(tight, shared, clock)
      const other = new DavRelayLimiter(tight, shared, clock)

      await limiter.consume('alice', 'requests')
      await other.consume('alice', 'requests')
      await limiter.consume('alice', 'requests')

      expect((await refusalFrom(other.consume('alice', 'requests'))).extra).toEqual({
        budget: 'requests',
        retryAfterSeconds: 12,
      })
      expect(calls[0]).toEqual(['dav-bridge:requests:alice', 600])
    })

    it('FAILS CLOSED when the shared store errors: the in-process budget still applies', async () => {
      const shared: DavSharedCounterStore = {
        incr: async () => {
          throw new Error('redis is down')
        },
        expire: async () => {
          throw new Error('redis is down')
        },
      }
      const limiter = new DavRelayLimiter(tight, shared, clock)

      await limiter.consume('alice', 'requests')
      await limiter.consume('alice', 'requests')
      await limiter.consume('alice', 'requests')

      expect((await refusalFrom(limiter.consume('alice', 'requests'))).tag).toBe('dav-rate-limited')
    })

    it('gives a counter that lost its expiry a horizon instead of refusing for ever', async () => {
      const expire = jest.fn().mockResolvedValue(1)
      const shared: DavSharedCounterStore = { incr: async () => 9_999, expire, ttl: async () => -1 }
      const limiter = new DavRelayLimiter(tight, shared, clock)

      const refusal = await refusalFrom(limiter.consume('alice', 'requests'))

      expect(refusal.extra).toEqual({ budget: 'requests', retryAfterSeconds: 600 })
      expect(expire).toHaveBeenCalledWith('dav-bridge:requests:alice', 600)
    })

    it('falls back to the whole window as the wait when the store cannot say', async () => {
      const shared: DavSharedCounterStore = {
        incr: async () => 9_999,
        ttl: async () => {
          throw new Error('redis is down')
        },
      }

      expect((await refusalFrom(new DavRelayLimiter(tight, shared, clock).consume('alice', 'requests'))).extra).toEqual(
        {
          budget: 'requests',
          retryAfterSeconds: 600,
        },
      )
    })
  })

  describe('concurrency', () => {
    it('allows two requests per account and refuses the third until one finishes', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      const first = limiter.acquire('alice|a1', 'https://one.example')
      limiter.acquire('alice|a1', 'https://one.example')

      const refusal = refusalOf(() => limiter.acquire('alice|a1', 'https://one.example'))
      expect(refusal.tag).toBe('dav-busy')
      expect(refusal.httpStatus).toBe(429)
      expect(refusal.logTag).toBe('busy-account')
      expect(refusal.retryAfterSeconds).toBe(1)

      first()
      expect(() => limiter.acquire('alice|a1', 'https://one.example')).not.toThrow()
    })

    it('allows four requests per origin across accounts and users', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (const account of ['alice|a1', 'alice|a2', 'bob|b1', 'carol|c1']) {
        limiter.acquire(account, 'https://shared.example')
      }

      expect(refusalOf(() => limiter.acquire('dave|d1', 'https://shared.example')).logTag).toBe('busy-origin')
      expect(() => limiter.acquire('dave|d1', 'https://other.example')).not.toThrow()
    })

    it('allows thirty-two requests on the whole server', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      const releases: Array<() => void> = []
      for (let index = 0; index < 32; index++) {
        releases.push(limiter.acquire(`user${index}|a`, `https://host${index}.example`))
      }
      expect(limiter.activeRequests()).toBe(32)

      expect(refusalOf(() => limiter.acquire('late|a', 'https://late.example')).logTag).toBe('busy-server')

      releases[0]()
      expect(limiter.activeRequests()).toBe(31)
      expect(() => limiter.acquire('late|a', 'https://late.example')).not.toThrow()
    })

    it('gives a slot back once however often release is called', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      const release = limiter.acquire('alice|a1', 'https://one.example')

      release()
      release()
      release()

      expect(limiter.activeRequests()).toBe(0)
      limiter.acquire('alice|a1', 'https://one.example')
      limiter.acquire('alice|a1', 'https://one.example')
      expect(() => limiter.acquire('alice|a1', 'https://one.example')).toThrow(DavBridgeRefusal)
    })

    it('takes no slot when it refuses', () => {
      const limiter = new DavRelayLimiter(limits({ concurrentPerAccount: 1 }), undefined, clock)
      const release = limiter.acquire('alice|a1', 'https://one.example')
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(() => limiter.acquire('alice|a1', 'https://one.example')).toThrow(DavBridgeRefusal)
      }

      expect(limiter.activeRequests()).toBe(1)
      release()
      expect(limiter.activeRequests()).toBe(0)
    })
  })

  describe('circuit breaker', () => {
    const origin = 'https://cloud.example.org'

    it('stays closed for four failures and opens on the fifth, for five minutes', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let failure = 0; failure < 4; failure++) {
        limiter.recordFailure('alice', origin)
        expect(() => limiter.assertCircuitClosed('alice', origin)).not.toThrow()
      }
      limiter.recordFailure('alice', origin)

      const refusal = refusalOf(() => limiter.assertCircuitClosed('alice', origin))
      expect(refusal.tag).toBe('dav-remote-circuit-open')
      expect(refusal.httpStatus).toBe(503)
      expect(refusal.extra).toEqual({ retryAfterSeconds: 300 })

      now += 299_000
      expect(refusalOf(() => limiter.assertCircuitClosed('alice', origin)).extra).toEqual({ retryAfterSeconds: 1 })

      now += 1_000
      expect(() => limiter.assertCircuitClosed('alice', origin)).not.toThrow()
    })

    it('counts consecutive failures only: a success in between starts over', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let round = 0; round < 10; round++) {
        for (let failure = 0; failure < 4; failure++) {
          limiter.recordFailure('alice', origin)
        }
        limiter.recordSuccess('alice', origin)
      }

      expect(() => limiter.assertCircuitClosed('alice', origin)).not.toThrow()
    })

    it('re-opens at once when the trial request after the open period fails too', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let failure = 0; failure < 5; failure++) {
        limiter.recordFailure('alice', origin)
      }
      now += 300_000
      expect(() => limiter.assertCircuitClosed('alice', origin)).not.toThrow()

      limiter.recordFailure('alice', origin)

      expect(refusalOf(() => limiter.assertCircuitClosed('alice', origin)).extra).toEqual({ retryAfterSeconds: 300 })
    })

    it('closes after a success', () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let failure = 0; failure < 5; failure++) {
        limiter.recordFailure('alice', origin)
      }
      now += 300_000
      limiter.recordSuccess('alice', origin)
      for (let failure = 0; failure < 4; failure++) {
        limiter.recordFailure('alice', origin)
      }

      expect(() => limiter.assertCircuitClosed('alice', origin)).not.toThrow()
    })

    it("is per user: one user's failures do not close an origin for anyone else", () => {
      const limiter = new DavRelayLimiter(limits(), undefined, clock)
      for (let failure = 0; failure < 50; failure++) {
        limiter.recordFailure('mallory', origin)
      }

      expect(() => limiter.assertCircuitClosed('mallory', origin)).toThrow(DavBridgeRefusal)
      expect(() => limiter.assertCircuitClosed('alice', origin)).not.toThrow()
      expect(() => limiter.assertCircuitClosed('mallory', 'https://other.example')).not.toThrow()
    })
  })
})
