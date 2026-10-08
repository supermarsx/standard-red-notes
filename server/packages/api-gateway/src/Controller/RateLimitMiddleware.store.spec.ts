import { NextFunction, Request, Response } from 'express'

import {
  buildDefaultRateLimitRules,
  createRateLimitMiddleware,
  createUserRateLimitMiddleware,
  RateLimitRedis,
  RateLimitWindowStore,
} from './RateLimitMiddleware'

/**
 * Standard Red Notes: WHICH COUNTER CONTRACT THE LIMITER USES.
 *
 * The no-Redis arm counts in a table whose horizon lives in the row, so it cannot
 * survive `INCR` and `EXPIRE` arriving as two separate calls -- a row written by
 * the first and missed by the second has no horizon, and a rate-limit row that
 * never expires is a permanent lockout. It therefore offers the one-step
 * {@link RateLimitWindowStore} contract, and the limiter prefers it.
 *
 * The other half of that bargain is what these specs mostly exist for: an ioredis
 * client has no `incrementInWindow`, so every Redis topology must keep taking the
 * `incr`/`expire` path with the same key, the same window and the same number of
 * calls it always did. A mutation that reverses the preference, or that routes a
 * Redis client down the one-step path, has to fail here.
 */

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const buildRequest = (overrides: Partial<Request> = {}): Request =>
  ({
    method: 'POST',
    path: '/v1/login',
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' },
    headers: {},
    ...overrides,
  }) as unknown as Request

const buildResponse = (): {
  response: Response
  status: jest.Mock
  send: jest.Mock
  setHeader: jest.Mock
  headers: Record<string, string>
} => {
  const send = jest.fn()
  const status = jest.fn().mockReturnValue({ send })
  const headers: Record<string, string> = {}
  const setHeader = jest.fn((name: string, value: string) => {
    headers[name] = value
  })
  const response = { status, send, setHeader } as unknown as Response

  return { response, status, send, setHeader, headers }
}

/** An ioredis-shaped client: `incr` + `expire`, and NO `incrementInWindow`. */
const buildRedis = (): RateLimitRedis & { counts: Record<string, number> } => {
  const counts: Record<string, number> = {}

  return {
    counts,
    incr: jest.fn((key: string) => {
      counts[key] = (counts[key] ?? 0) + 1

      return Promise.resolve(counts[key])
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    ttl: jest.fn(() => Promise.resolve(37)),
  }
}

/** A one-step store, the shape CacheEntryRateLimitStore implements. */
const buildWindowStore = (): RateLimitWindowStore & {
  counts: Record<string, number>
  incr: jest.Mock
  expire: jest.Mock
} => {
  const counts: Record<string, number> = {}

  return {
    counts,
    incrementInWindow: jest.fn((key: string) => {
      counts[key] = (counts[key] ?? 0) + 1

      return Promise.resolve(counts[key])
    }),
    ttl: jest.fn(() => Promise.resolve(23)),
    // Present but must never be reached: a store that implements the one-step
    // contract has no business being driven two steps at a time.
    incr: jest.fn(() => Promise.resolve(99)),
    expire: jest.fn(() => Promise.resolve(1)),
  }
}

const limits = { windowSeconds: 60, loginMax: 2, registrationMax: 1 }
const config = { enabled: true, rules: buildDefaultRateLimitRules(limits) }
const logger = { warn: jest.fn() }

describe('RateLimitMiddleware counter contract', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('with an ioredis client (every Redis topology)', () => {
    it('increments with incr and arms the window with expire on the first hit only', async () => {
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger })

      for (let hit = 0; hit < 3; hit++) {
        middleware(buildRequest(), buildResponse().response, jest.fn())
        await flush()
      }

      expect(redis.incr).toHaveBeenCalledTimes(3)
      expect(redis.incr).toHaveBeenCalledWith('rl:auth-login:1.2.3.4')
      expect(redis.expire).toHaveBeenCalledTimes(1)
      expect(redis.expire).toHaveBeenCalledWith('rl:auth-login:1.2.3.4', 60)
    })

    /**
     * Standard Red Notes: THE WINDOW MUST NOT SLIDE WHILE A CLIENT KEEPS KNOCKING.
     *
     * A fixed-window counter arms its horizon on the FIRST increment only. Re-arm
     * it on every increment and the limit stops being "N per interval" and becomes
     * "N, then refused for as long as you keep knocking" -- a permanent lockout for
     * the honest client who retries politely, and no obstacle at all to an attacker
     * who backs off. On registration that is a new user who simply cannot sign up,
     * with no error that explains why.
     *
     * A spec that only proves the limit FIRES passes straight over that bug, which
     * is why this one keeps hitting well past the ceiling and counts the arming
     * calls rather than the refusals.
     */
    it('arms the window exactly once no matter how long the client keeps knocking', async () => {
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger })

      // Ceiling is 2; hits 3..12 are all refusals, and not one of them may re-arm.
      for (let hit = 0; hit < 12; hit++) {
        middleware(buildRequest(), buildResponse().response, jest.fn())
        await flush()
      }

      expect(redis.incr).toHaveBeenCalledTimes(12)
      expect(redis.expire).toHaveBeenCalledTimes(1)
      expect(redis.expire).toHaveBeenCalledWith('rl:auth-login:1.2.3.4', 60)
    })

    it('refuses the hit past the ceiling with 429 and the Redis ttl as Retry-After', async () => {
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger })
      const next = jest.fn()

      for (let hit = 0; hit < 2; hit++) {
        middleware(buildRequest(), buildResponse().response, next)
        await flush()
      }
      expect(next).toHaveBeenCalledTimes(2)

      const refused = buildResponse()
      middleware(buildRequest(), refused.response, next)
      await flush()

      expect(next).toHaveBeenCalledTimes(2)
      expect(refused.status).toHaveBeenCalledWith(429)
      expect(refused.headers['Retry-After']).toEqual('37')
    })
  })

  describe('with a one-step window store (the no-Redis arm)', () => {
    it('increments and arms the window in a single call, never two', async () => {
      const store = buildWindowStore()
      const middleware = createRateLimitMiddleware({ redis: store, config, logger })

      for (let hit = 0; hit < 3; hit++) {
        middleware(buildRequest(), buildResponse().response, jest.fn())
        await flush()
      }

      expect(store.incrementInWindow).toHaveBeenCalledTimes(3)
      expect(store.incrementInWindow).toHaveBeenNthCalledWith(1, 'rl:auth-login:1.2.3.4', 60)
      expect(store.incr).not.toHaveBeenCalled()
      expect(store.expire).not.toHaveBeenCalled()
    })

    it('refuses the hit past the ceiling with 429 and the store ttl as Retry-After', async () => {
      const store = buildWindowStore()
      const middleware = createRateLimitMiddleware({ redis: store, config, logger })
      const next = jest.fn()

      for (let hit = 0; hit < 2; hit++) {
        middleware(buildRequest(), buildResponse().response, next)
        await flush()
      }
      expect(next).toHaveBeenCalledTimes(2)

      const refused = buildResponse()
      middleware(buildRequest(), refused.response, next)
      await flush()

      expect(next).toHaveBeenCalledTimes(2)
      expect(refused.status).toHaveBeenCalledWith(429)
      expect(refused.headers['Retry-After']).toEqual('23')
      expect(refused.headers['X-RateLimit-Limit']).toEqual('2')
      expect(refused.headers['X-RateLimit-Remaining']).toEqual('0')
    })

    it('passes each rule its OWN window, not one window for every bucket', async () => {
      const store = buildWindowStore()
      const middleware = createRateLimitMiddleware({
        redis: store,
        config: {
          enabled: true,
          rules: [
            { bucket: 'short', limit: 5, windowSeconds: 10, match: (_m, p) => p === '/short' },
            { bucket: 'long', limit: 5, windowSeconds: 3600, match: (_m, p) => p === '/long' },
          ],
        },
        logger,
      })

      middleware(buildRequest({ path: '/short' }), buildResponse().response, jest.fn())
      await flush()
      middleware(buildRequest({ path: '/long' }), buildResponse().response, jest.fn())
      await flush()

      expect(store.incrementInWindow).toHaveBeenNthCalledWith(1, 'rl:short:1.2.3.4', 10)
      expect(store.incrementInWindow).toHaveBeenNthCalledWith(2, 'rl:long:1.2.3.4', 3600)
    })

    it('fails open when the store throws, rather than refusing a legitimate login', async () => {
      const store = buildWindowStore()
      store.incrementInWindow = jest.fn(() => Promise.reject(new Error('database is locked')))
      const middleware = createRateLimitMiddleware({ redis: store, config, logger })
      const next = jest.fn()
      const { status } = buildResponse()

      middleware(buildRequest(), buildResponse().response, next)
      await flush()

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })

    it('still counts per bucket, so one bucket cannot spend another allowance', async () => {
      const store = buildWindowStore()
      const middleware = createRateLimitMiddleware({ redis: store, config, logger })

      // registrationMax is 1, so /v1/users refuses its SECOND hit even though
      // /v1/login has already consumed its own allowance.
      for (let hit = 0; hit < 2; hit++) {
        middleware(buildRequest(), buildResponse().response, jest.fn())
        await flush()
      }

      const firstRegistration = buildResponse()
      middleware(buildRequest({ path: '/v1/users' }), firstRegistration.response, jest.fn())
      await flush()
      expect(firstRegistration.status).not.toHaveBeenCalled()

      const secondRegistration = buildResponse()
      middleware(buildRequest({ path: '/v1/users' }), secondRegistration.response, jest.fn())
      await flush()
      expect(secondRegistration.status).toHaveBeenCalledWith(429)
    })
  })

  describe('the pass-through, which is all a store-less deployment can do', () => {
    it('calls next for a rate-limited path when no store exists at all', async () => {
      const middleware = createRateLimitMiddleware({ redis: undefined, config, logger })
      const next = jest.fn()
      const { response, status, setHeader } = buildResponse()

      middleware(buildRequest(), response, next)
      await flush()

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
      // The observable signature of the pass-through, and what the live probe
      // measured on the single container before this arm had a store: not merely
      // no 429, but no X-RateLimit-* header on the ALLOWED response either.
      expect(setHeader).not.toHaveBeenCalled()
    })
  })

  describe('the per-user tier takes the same two contracts', () => {
    const userConfig = { bucket: 'assistant', windowSeconds: 60, max: 2 }

    it('drives an ioredis client with incr and expire', async () => {
      const redis = buildRedis()
      const middleware = createUserRateLimitMiddleware({ redis, config: userConfig, logger })
      const { response } = buildResponse()
      ;(response as unknown as { locals: unknown }).locals = { user: { uuid: 'user-1' } }

      middleware(buildRequest(), response, jest.fn())
      await flush()

      expect(redis.incr).toHaveBeenCalledWith('rl:user:assistant:user-1')
      expect(redis.expire).toHaveBeenCalledWith('rl:user:assistant:user-1', 60)
    })

    it('drives a window store in one call, and refuses past the ceiling', async () => {
      const store = buildWindowStore()
      const middleware = createUserRateLimitMiddleware({ redis: store, config: userConfig, logger })
      const next = jest.fn()

      const request = buildRequest()
      for (let hit = 0; hit < 2; hit++) {
        const allowed = buildResponse()
        ;(allowed.response as unknown as { locals: unknown }).locals = { user: { uuid: 'user-1' } }
        middleware(request, allowed.response, next)
        await flush()
      }
      expect(next).toHaveBeenCalledTimes(2)

      const refused = buildResponse()
      ;(refused.response as unknown as { locals: unknown }).locals = { user: { uuid: 'user-1' } }
      middleware(request, refused.response, next)
      await flush()

      expect(store.incrementInWindow).toHaveBeenCalledTimes(3)
      expect(store.incrementInWindow).toHaveBeenNthCalledWith(1, 'rl:user:assistant:user-1', 60)
      expect(store.incr).not.toHaveBeenCalled()
      expect(store.expire).not.toHaveBeenCalled()
      expect(refused.status).toHaveBeenCalledWith(429)
      expect(refused.headers['Retry-After']).toEqual('23')
    })
  })

  describe('the escalation hook stays on the throttle, whichever store counts', () => {
    it('fires onThrottle for a window store too', async () => {
      const store = buildWindowStore()
      const onThrottle = jest.fn()
      const middleware = createRateLimitMiddleware({ redis: store, config, logger, onThrottle })

      for (let hit = 0; hit < 3; hit++) {
        middleware(buildRequest(), buildResponse().response, jest.fn() as NextFunction)
        await flush()
      }

      expect(onThrottle).toHaveBeenCalledTimes(1)
      expect(onThrottle).toHaveBeenCalledWith('1.2.3.4', 'auth-login')
    })
  })

  /**
   * Standard Red Notes: A BROKEN TELEMETRY HOOK MUST NOT SPEND A REFUSAL.
   *
   * Both install sites built `onThrottle` around `escalationRedis.set`, where
   * `escalationRedis` is the ioredis client -- `undefined` on the no-Redis arm. A
   * throw from the hook escaped into the limiter's fail-open catch, which calls
   * `next()`: the 429 was never sent and the request was ALLOWED, while the log
   * said only "Rate limiter failed open." It stayed invisible for as long as that
   * arm had no counter and so never throttled. Measured the moment it did: the
   * 11th login answered 401 while carrying a correct `Retry-After: 49` on the same
   * response -- the limiter had decided to refuse and then let the request pass.
   *
   * The install sites no longer pass a hook they cannot serve. These specs are the
   * structural half: no hook, present or future, can convert a refusal into a pass.
   */
  describe('a throwing telemetry hook', () => {
    it('still answers 429 when onThrottle throws', async () => {
      const store = buildWindowStore()
      const onThrottle = jest.fn(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'set')")
      })
      const middleware = createRateLimitMiddleware({ redis: store, config, logger, onThrottle })
      const next = jest.fn()

      for (let hit = 0; hit < 2; hit++) {
        middleware(buildRequest(), buildResponse().response, next)
        await flush()
      }
      expect(next).toHaveBeenCalledTimes(2)

      const refused = buildResponse()
      middleware(buildRequest(), refused.response, next)
      await flush()

      expect(refused.status).toHaveBeenCalledWith(429)
      expect(refused.headers['Retry-After']).toEqual('23')
      // The refusal is NOT spent: next() was not called a third time.
      expect(next).toHaveBeenCalledTimes(2)
    })

    it('still answers 429 when the metrics sink throws synchronously', async () => {
      const store = buildWindowStore()
      const metrics = {
        recordThrottle: jest.fn(() => {
          throw new Error('metrics store exploded')
        }),
        recordBlock: jest.fn(() => Promise.resolve()),
      }
      const middleware = createRateLimitMiddleware({ redis: store, config, logger, metrics })
      const next = jest.fn()

      for (let hit = 0; hit < 2; hit++) {
        middleware(buildRequest(), buildResponse().response, next)
        await flush()
      }

      const refused = buildResponse()
      middleware(buildRequest(), refused.response, next)
      await flush()

      expect(refused.status).toHaveBeenCalledWith(429)
      expect(next).toHaveBeenCalledTimes(2)
    })

    it('reports the hook failure without reporting the limiter as failed open', async () => {
      const store = buildWindowStore()
      const warn = jest.fn()
      const onThrottle = jest.fn(() => {
        throw new Error('escalation client missing')
      })
      const middleware = createRateLimitMiddleware({
        redis: store,
        config,
        logger: { warn },
        onThrottle,
      })

      for (let hit = 0; hit < 3; hit++) {
        middleware(buildRequest(), buildResponse().response, jest.fn())
        await flush()
      }

      const messages = warn.mock.calls.map((call) => call[0] as string)
      expect(messages).toContain('Rate-limit throttle telemetry failed.')
      expect(messages).not.toContain('Rate limiter failed open.')
    })

    it('answers 429 when NO hook is installed at all, which is the no-Redis shape', async () => {
      const store = buildWindowStore()
      const middleware = createRateLimitMiddleware({
        redis: store,
        config,
        logger,
        onThrottle: undefined,
        metrics: undefined,
      })
      const next = jest.fn()

      for (let hit = 0; hit < 2; hit++) {
        middleware(buildRequest(), buildResponse().response, next)
        await flush()
      }

      const refused = buildResponse()
      middleware(buildRequest(), refused.response, next)
      await flush()

      expect(refused.status).toHaveBeenCalledWith(429)
      expect(next).toHaveBeenCalledTimes(2)
    })
  })
})
