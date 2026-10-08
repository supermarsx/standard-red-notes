import { NextFunction, Request, Response } from 'express'
import {
  buildDefaultRateLimitRules,
  createRateLimitMiddleware,
  isWithinRateLimit,
  normalizeRateLimitPath,
  RateLimitRedis,
  realtimeReconnectLimit,
  REALTIME_RECONNECT_LIMIT_MULTIPLIER,
  REALTIME_RECONNECT_MIN_LIMIT,
  SECOND_FACTOR_PATHS,
  SESSION_REFRESH_PATHS,
} from './RateLimitMiddleware'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const buildRequest = (overrides: Partial<Request> = {}): Request => {
  return {
    method: 'POST',
    path: '/v1/login',
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' },
    headers: {},
    ...overrides,
  } as unknown as Request
}

const buildResponse = (): {
  response: Response
  status: jest.Mock
  send: jest.Mock
  setHeader: jest.Mock
} => {
  const send = jest.fn()
  const status = jest.fn().mockReturnValue({ send })
  const setHeader = jest.fn()
  const response = { status, send, setHeader } as unknown as Response

  return { response, status, send, setHeader }
}

const buildRedis = (overrides: Partial<RateLimitRedis> = {}): RateLimitRedis => {
  const counts: Record<string, number> = {}
  return {
    incr: jest.fn((key: string) => {
      counts[key] = (counts[key] ?? 0) + 1
      return Promise.resolve(counts[key])
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    ttl: jest.fn(() => Promise.resolve(42)),
    ...overrides,
  }
}

const limits = { windowSeconds: 60, loginMax: 2, registrationMax: 1 }

describe('RateLimitMiddleware', () => {
  describe('isWithinRateLimit', () => {
    it('allows counts up to and including the limit', () => {
      expect(isWithinRateLimit(1, 2)).toBe(true)
      expect(isWithinRateLimit(2, 2)).toBe(true)
    })
    it('blocks counts beyond the limit', () => {
      expect(isWithinRateLimit(3, 2)).toBe(false)
    })
  })

  describe('normalizeRateLimitPath', () => {
    it('strips trailing slashes but keeps root', () => {
      expect(normalizeRateLimitPath('/v1/users/')).toBe('/v1/users')
      expect(normalizeRateLimitPath('/v1/users')).toBe('/v1/users')
      expect(normalizeRateLimitPath('/')).toBe('/')
    })
  })

  describe('buildDefaultRateLimitRules', () => {
    const rules = buildDefaultRateLimitRules(limits)
    const matchesAny = (method: string, path: string) => rules.some((r) => r.match(method, path))

    it('matches the login tier', () => {
      expect(matchesAny('POST', '/v1/login')).toBe(true)
      expect(matchesAny('POST', '/v2/login')).toBe(true)
      expect(matchesAny('POST', '/v1/recovery/login')).toBe(true)
      expect(matchesAny('POST', '/v1/recovery/login-params')).toBe(true)
      expect(matchesAny('POST', '/v1/account-recovery/lookup')).toBe(true)
    })
    it('matches the sensitive tier', () => {
      expect(matchesAny('POST', '/v1/users')).toBe(true)
      expect(matchesAny('POST', '/v1/mcp-tokens/authenticate')).toBe(true)
      expect(matchesAny('POST', '/v1/mfa/magic-link/request')).toBe(true)
    })
    it('matches only GET on the exact public subscription callback path', () => {
      const callback = rules.find((rule) => rule.bucket === 'assistant-pairing-callback')
      expect(callback?.limit).toBe(limits.loginMax)
      expect(matchesAny('GET', '/v1/assistant/subscription/callback')).toBe(true)
      expect(matchesAny('POST', '/v1/assistant/subscription/callback')).toBe(false)
      expect(matchesAny('GET', '/v1/assistant/subscription/callback/extra')).toBe(false)
    })
    it('does not match authenticated/other paths or unrelated GET methods', () => {
      expect(matchesAny('POST', '/v1/items/sync')).toBe(false)
      expect(matchesAny('GET', '/v1/login')).toBe(false)
    })
  })

  /**
   * Standard Red Notes: BUCKET MEMBERSHIP PER AUTH PATH.
   *
   * No test used to state, path by path, which bucket an auth endpoint lands in.
   * The suite asserted that the login tier matched the paths it was written with
   * and that a handful of unrelated paths matched nothing — which is a test of the
   * list against itself, and says nothing about whether every endpoint that checks
   * a credential is inside some bucket. That blind spot is how `/v1/login-params`
   * and `/v2/login-params` — the second-factor gate, where VerifyMFA accepts or
   * rejects a 6-digit TOTP, a magic-link code, an app password or a trusted-device
   * token with no session required — sat in NO bucket while `/v1/login` right next
   * to them sat in `auth-login`. The old suite went further and asserted the gap
   * was correct: `expect(matchesAny('POST', '/v1/login-params')).toBe(false)` under
   * the heading "does not match authenticated/other paths". It is not an
   * authenticated path.
   *
   * So this table asserts the BUCKET NAME for every credential-checking auth path.
   * An endpoint that falls out of its bucket fails here with `undefined`, and one
   * that silently changes tier fails with the wrong name. Adding a new auth
   * endpoint means adding a row, which is the point.
   */
  describe('bucket membership per auth path', () => {
    const rules = buildDefaultRateLimitRules(limits)
    const bucketFor = (method: string, path: string): string | undefined =>
      rules.find((rule) => rule.match(method, path))?.bucket

    it.each([
      ['POST', '/v1/login', 'auth-login'],
      ['POST', '/v2/login', 'auth-login'],
      ['POST', '/v1/recovery/login', 'auth-login'],
      ['POST', '/v1/recovery/login-params', 'auth-login'],
      ['POST', '/v1/account-recovery/lookup', 'auth-login'],
      // The MFA gate. v1 declares GET, v2 declares POST; both verbs are covered on
      // both paths so moving or adding a verb cannot drop the gate out again.
      ['GET', '/v1/login-params', 'auth-second-factor'],
      ['POST', '/v1/login-params', 'auth-second-factor'],
      ['GET', '/v2/login-params', 'auth-second-factor'],
      ['POST', '/v2/login-params', 'auth-second-factor'],
      // Session refresh. It accepts a refresh token, so it is a credential
      // endpoint; only v1 exists today and it declares POST, so both verbs are
      // covered on both version prefixes for the same reason as the MFA gate.
      ['POST', '/v1/sessions/refresh', 'auth-session-refresh'],
      ['GET', '/v1/sessions/refresh', 'auth-session-refresh'],
      ['POST', '/v2/sessions/refresh', 'auth-session-refresh'],
      ['GET', '/v2/sessions/refresh', 'auth-session-refresh'],
      ['POST', '/v1/users', 'auth-sensitive'],
      ['POST', '/v1/mcp-tokens/authenticate', 'auth-sensitive'],
      ['POST', '/v1/mfa/magic-link/request', 'auth-sensitive'],
      ['POST', '/v1/users/email-confirmation/resend', 'auth-sensitive'],
      ['GET', '/v1/assistant/subscription/callback', 'assistant-pairing-callback'],
      ['POST', '/v1/sockets/tokens', 'realtime-tokens'],
      ['POST', '/v1/sockets/sync/ticket', 'realtime-tokens'],
      ['POST', '/sockets/tokens', 'realtime-tokens'],
    ])('%s %s is metered by the %s bucket', (method, path, bucket) => {
      expect(bucketFor(method, path)).toEqual(bucket)
    })

    it('meters the second-factor gate at the login ceiling, in its own bucket', () => {
      const secondFactor = rules.find((rule) => rule.bucket === 'auth-second-factor')

      // Its own bucket, so second-factor retries and sign-in attempts never eat
      // each other's allowance; the login ceiling, so a person who mistypes a code
      // a few times is nowhere near it.
      expect(secondFactor).toBeDefined()
      expect(secondFactor?.limit).toEqual(limits.loginMax)
      expect(secondFactor?.windowSeconds).toEqual(limits.windowSeconds)
      expect(secondFactor?.subject).toBeUndefined()
    })

    it('covers every path that reaches the second-factor gate', () => {
      expect([...SECOND_FACTOR_PATHS]).toEqual(['/v1/login-params', '/v2/login-params'])
      for (const path of SECOND_FACTOR_PATHS) {
        expect(bucketFor('GET', path)).toEqual('auth-second-factor')
        expect(bucketFor('POST', path)).toEqual('auth-second-factor')
      }
    })

    it('does not spill onto neighbouring paths or unrelated verbs', () => {
      expect(bucketFor('DELETE', '/v1/login-params')).toBeUndefined()
      expect(bucketFor('GET', '/v1/login-params/extra')).toBeUndefined()
      expect(bucketFor('GET', '/v1/login')).toBeUndefined()
      // Recovery key params is a different endpoint and keeps its login-tier place.
      expect(bucketFor('POST', '/v1/recovery/login-params')).toEqual('auth-login')
    })

    /**
     * Standard Red Notes: SESSION REFRESH IS A CREDENTIAL ENDPOINT.
     *
     * `POST /v1/sessions/refresh` takes a refresh token and hands back a rotated
     * session pair, with no access-token session in front of it — and it sat in no
     * bucket at all, so it had no per-address ceiling of any kind. The membership
     * table above is what makes that kind of omission visible, which is why these
     * rows live in it rather than in a spec of their own.
     *
     * THE CEILING IS THE WHOLE DESIGN HERE, because a limit that strands a real
     * user is worse than no limit: a throttled refresh means the access token
     * expires and the client cannot sync. Two things make a legitimate burst
     * bigger than you would guess:
     *
     *   - SEVERAL TABS OR DEVICES SHARE ONE ADDRESS. Each browser tab is its own
     *     app instance with its own in-flight-refresh deduplication, so N tabs
     *     behind one NAT can issue N refreshes within the same second.
     *   - A SUPERSEDED REFRESH TOKEN STAYS REPLAYABLE FOR 120s BY DESIGN, so a
     *     client whose response was dropped legitimately retries the same token.
     *     That cooldown replay must stay inside the allowance.
     *
     * Against that, the legitimate STEADY-STATE rate is almost nothing: refresh is
     * reactive (the client refreshes only after a 498 on some other request) and
     * ACCESS_TOKEN_AGE defaults to 5 184 000 seconds — sixty days. So the ceiling
     * is set at six times the login tier with a floor of 30 per window, which is
     * unreachable by legitimate traffic and still caps an unauthenticated flood.
     */
    it('meters session refresh well above the login ceiling, in its own bucket', () => {
      const refresh = rules.find((rule) => rule.bucket === 'auth-session-refresh')

      expect(refresh).toBeDefined()
      expect(refresh?.windowSeconds).toEqual(limits.windowSeconds)
      // Keyed on the client IP like every other auth bucket here: keying on the
      // presented credential would let a caller rotate the header for a fresh
      // allowance, and a cookie-session refresh presents no bearer at all.
      expect(refresh?.subject).toBeUndefined()
      // Strictly more generous than the login tier, which is the property that
      // keeps several tabs behind one address out of a 429.
      expect(refresh?.limit).toBeGreaterThan(limits.loginMax)
    })

    it.each([
      [2, 30],
      [5, 30],
      [10, 60],
      [100, 600],
    ])('derives a refresh ceiling of %i -> %i per window, never below the floor', (loginMax, expected) => {
      const scaled = buildDefaultRateLimitRules({ windowSeconds: 60, loginMax, registrationMax: 5 })
      const refresh = scaled.find((rule) => rule.bucket === 'auth-session-refresh')

      expect(refresh?.limit).toEqual(expected)
    })

    it('covers every path that reaches session refresh', () => {
      expect([...SESSION_REFRESH_PATHS]).toEqual(['/v1/sessions/refresh', '/v2/sessions/refresh'])
      for (const path of SESSION_REFRESH_PATHS) {
        expect(bucketFor('GET', path)).toEqual('auth-session-refresh')
        expect(bucketFor('POST', path)).toEqual('auth-session-refresh')
      }
    })

    it('leaves the authenticated session-management routes alone', () => {
      // Listing and revoking sessions sit behind the cross-service token
      // middleware and are not credential checks; they must not be dragged in.
      expect(bucketFor('GET', '/v1/sessions')).toBeUndefined()
      expect(bucketFor('DELETE', '/v1/sessions')).toBeUndefined()
      expect(bucketFor('DELETE', '/v1/sessions/0ff0a1ce-0000-4000-8000-000000000000')).toBeUndefined()
      expect(bucketFor('DELETE', '/v1/sessions/refresh')).toBeUndefined()
      expect(bucketFor('POST', '/v1/sessions/refresh/extra')).toBeUndefined()
    })
  })

  describe('createRateLimitMiddleware', () => {
    const config = { enabled: true, rules: buildDefaultRateLimitRules(limits) }

    it('is a no-op pass-through when disabled', async () => {
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()
      const middleware = createRateLimitMiddleware({
        redis: buildRedis(),
        config: { ...config, enabled: false },
        logger: { warn: jest.fn() },
      })
      middleware(buildRequest(), response, next)
      await flush()
      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })

    it('is a no-op pass-through when Redis is unavailable', async () => {
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()
      const middleware = createRateLimitMiddleware({ redis: undefined, config, logger: { warn: jest.fn() } })
      middleware(buildRequest(), response, next)
      await flush()
      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })

    it('passes requests through while under the limit', async () => {
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()
      const middleware = createRateLimitMiddleware({ redis: buildRedis(), config, logger: { warn: jest.fn() } })
      // loginMax = 2 -> first two requests allowed
      middleware(buildRequest(), response, next)
      await flush()
      middleware(buildRequest(), response, next)
      await flush()
      expect(next).toHaveBeenCalledTimes(2)
      expect(status).not.toHaveBeenCalled()
    })

    it('returns 429 with Retry-After once the limit is exceeded', async () => {
      const next: NextFunction = jest.fn()
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger: { warn: jest.fn() } })
      let res = buildResponse()
      middleware(buildRequest(), res.response, next)
      await flush()
      res = buildResponse()
      middleware(buildRequest(), res.response, next)
      await flush()
      // 3rd login request (limit 2) -> blocked
      res = buildResponse()
      middleware(buildRequest(), res.response, next)
      await flush()
      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '42')
      expect(next).toHaveBeenCalledTimes(2)
    })

    /**
     * Standard Red Notes: the membership table above asserts which bucket the rule
     * set PUTS this path in; this asserts that a real refresh request actually
     * REACHES that bucket through the middleware — that the normalized path, the
     * verb and the Redis key all line up — and that the generous ceiling leaves
     * room for the legitimate bursts the endpoint has to tolerate (several tabs
     * behind one address, plus the by-design 120-second cooldown replay of a
     * superseded refresh token).
     */
    it('meters a real session-refresh request in the refresh bucket, with room for a burst', async () => {
      const next: NextFunction = jest.fn()
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger: { warn: jest.fn() } })
      const refreshRequest = (): Request => buildRequest({ method: 'POST', path: '/v1/sessions/refresh' })
      // The ceiling in play: loginMax is 2 here, so the floor (30) applies.
      const ceiling = buildDefaultRateLimitRules(limits).find((rule) => rule.bucket === 'auth-session-refresh')?.limit
      expect(ceiling).toEqual(30)

      for (let attempt = 0; attempt < (ceiling as number); attempt++) {
        middleware(refreshRequest(), buildResponse().response, next)
        await flush()
      }

      // It landed in the refresh bucket and nowhere else — a 31st login request
      // would have been throttled long ago at loginMax 2.
      expect(redis.expire).toHaveBeenCalledWith('rl:auth-session-refresh:1.2.3.4', 60)
      expect(redis.incr).toHaveBeenCalledWith('rl:auth-session-refresh:1.2.3.4')
      expect(next).toHaveBeenCalledTimes(ceiling as number)

      const overTheTop = buildResponse()
      middleware(refreshRequest(), overTheTop.response, next)
      await flush()

      expect(overTheTop.status).toHaveBeenCalledWith(429)
      expect(next).toHaveBeenCalledTimes(ceiling as number)
    })

    it('sets the TTL only on the first request of a window', async () => {
      const next: NextFunction = jest.fn()
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger: { warn: jest.fn() } })
      middleware(buildRequest(), buildResponse().response, next)
      await flush()
      middleware(buildRequest(), buildResponse().response, next)
      await flush()
      expect(redis.expire).toHaveBeenCalledTimes(1)
      expect(redis.expire).toHaveBeenCalledWith('rl:auth-login:1.2.3.4', 60)
    })

    it('separates buckets by rule and by IP', async () => {
      const next: NextFunction = jest.fn()
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger: { warn: jest.fn() } })
      middleware(buildRequest({ path: '/v1/users', ip: '9.9.9.9' } as Partial<Request>), buildResponse().response, next)
      await flush()
      expect(redis.incr).toHaveBeenCalledWith('rl:auth-sensitive:9.9.9.9')
    })

    it('keys on the TRUST_PROXY-resolved request.ip and IGNORES a spoofed X-Forwarded-For', async () => {
      // The bypass-prevention property: a direct client cannot dodge the limit by
      // forging X-Forwarded-For when no proxy is trusted — the key stays request.ip.
      const next: NextFunction = jest.fn()
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({ redis, config, logger: { warn: jest.fn() } })
      middleware(
        buildRequest({ ip: '2.2.2.2', headers: { 'x-forwarded-for': '9.9.9.9' } } as Partial<Request>),
        buildResponse().response,
        next,
      )
      await flush()
      expect(redis.incr).toHaveBeenCalledWith('rl:auth-login:2.2.2.2')
    })

    it('keys on CLIENT_IP_HEADER when configured', async () => {
      const next: NextFunction = jest.fn()
      const redis = buildRedis()
      const middleware = createRateLimitMiddleware({
        redis,
        config,
        logger: { warn: jest.fn() },
        clientIpHeader: 'x-real-ip',
      })
      middleware(
        buildRequest({ ip: '2.2.2.2', headers: { 'x-real-ip': '203.0.113.5' } } as Partial<Request>),
        buildResponse().response,
        next,
      )
      await flush()
      expect(redis.incr).toHaveBeenCalledWith('rl:auth-login:203.0.113.5')
    })

    it('FAILS OPEN (calls next, no 429) when Redis throws', async () => {
      const next: NextFunction = jest.fn()
      const warn = jest.fn()
      const redis = buildRedis({ incr: jest.fn(() => Promise.reject(new Error('redis-credential-sentinel'))) })
      const { response, status } = buildResponse()
      const middleware = createRateLimitMiddleware({ redis, config, logger: { warn } })
      middleware(buildRequest(), response, next)
      await flush()
      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('Rate limiter failed open.', expect.objectContaining({ errorType: 'Error' }))
      expect(JSON.stringify(warn.mock.calls)).not.toContain('redis-credential-sentinel')
    })
  })
})

// N41: the realtime control plane (token mint, sync ticket) sat outside every
// bucket. It is counted per SESSION when a bearer credential is presented, so a
// reconnect storm is charged to the session that causes it and a busy NAT does
// not starve everyone behind it; anonymous calls fall back to the IP.
describe('RateLimitMiddleware realtime-tokens bucket (N41)', () => {
  const rules = buildDefaultRateLimitRules(limits)
  const realtime = rules.find((rule) => rule.bucket === 'realtime-tokens')

  it('matches POST on the three realtime control-plane paths only', () => {
    expect(realtime).toBeDefined()
    for (const path of ['/v1/sockets/tokens', '/v1/sockets/sync/ticket', '/sockets/tokens']) {
      expect(realtime?.match('POST', path)).toBe(true)
      expect(realtime?.match('GET', path)).toBe(false)
    }
    expect(realtime?.match('POST', '/v1/sockets/sync/capabilities')).toBe(false)
    // The CEILING is asserted in the reconnection-ceiling describe below; this
    // case owns path/verb matching only.
    expect(realtime?.windowSeconds).toBe(limits.windowSeconds)
  })

  it('keys the counter on a digest of the bearer credential, never on the credential itself', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const middleware = createRateLimitMiddleware({
      redis,
      config: { enabled: true, rules },
      logger: { warn: jest.fn() },
    })

    middleware(
      buildRequest({ path: '/v1/sockets/tokens', headers: { authorization: 'Bearer session-secret' } as never }),
      buildResponse().response,
      next,
    )
    await flush()

    const key = (redis.incr as jest.Mock).mock.calls[0][0] as string
    expect(key).toMatch(/^rl:realtime-tokens:session:[0-9a-f]{32}$/)
    expect(key).not.toContain('session-secret')
    expect(next).toHaveBeenCalled()
  })

  it('throttles one session while another session from the same IP keeps its allowance', async () => {
    const redis = buildRedis()
    const middleware = createRateLimitMiddleware({
      redis,
      config: { enabled: true, rules },
      logger: { warn: jest.fn() },
    })
    const call = async (authorization: string) => {
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()
      middleware(buildRequest({ path: '/v1/sockets/sync/ticket', headers: { authorization } as never }), response, next)
      await flush()
      return { next, status }
    }

    // Drive session `a` to its own ceiling (no longer the login tier's -- see
    // realtimeReconnectLimit), then one past it.
    const allowance = realtimeReconnectLimit(limits.loginMax)
    for (let attempt = 0; attempt < allowance; attempt++) {
      await call('Bearer a')
    }
    const overrun = await call('Bearer a')
    const other = await call('Bearer b')

    expect(overrun.status).toHaveBeenCalledWith(429)
    expect(other.next).toHaveBeenCalled()
  })

  it('falls back to the client IP when no bearer credential is presented', async () => {
    const redis = buildRedis()
    const middleware = createRateLimitMiddleware({
      redis,
      config: { enabled: true, rules },
      logger: { warn: jest.fn() },
    })

    middleware(buildRequest({ path: '/sockets/tokens', headers: {} }), buildResponse().response, jest.fn())
    await flush()

    expect((redis.incr as jest.Mock).mock.calls[0][0]).toBe('rl:realtime-tokens:1.2.3.4')
  })
})

// The ceiling for that bucket is its OWN, not the login tier's. It was
// `loginMax`, and on compose that made the RECOVERY endpoint the thing that
// broke: measured after a gateway restart, the eleventh mint answered 429 with
// `Retry-After: 60` and the socket stayed down 60,557 ms. See
// realtimeReconnectLimit for why the login dimension is the wrong one here and
// what the new figure still protects.
describe('RateLimitMiddleware realtime reconnection ceiling', () => {
  const rules = buildDefaultRateLimitRules(limits)
  const realtime = rules.find((rule) => rule.bucket === 'realtime-tokens')

  it("gives the bucket its own ceiling rather than the login tier's", () => {
    expect(realtime?.limit).toBe(realtimeReconnectLimit(limits.loginMax))
    expect(realtime?.limit).toBeGreaterThan(limits.loginMax)
    expect(realtime?.windowSeconds).toBe(limits.windowSeconds)
  })

  it('floors the ceiling so hardening the login tier cannot break recovery, and scales when it is raised', () => {
    // An operator who hardens login must not thereby make reconnection the thing
    // that fails; one who raises it has a busy server and gets headroom here too.
    expect(realtimeReconnectLimit(3)).toBe(REALTIME_RECONNECT_MIN_LIMIT)
    expect(realtimeReconnectLimit(1)).toBe(REALTIME_RECONNECT_MIN_LIMIT)
    expect(realtimeReconnectLimit(50)).toBe(50 * REALTIME_RECONNECT_LIMIT_MULTIPLIER)
    expect(realtimeReconnectLimit(50)).toBeGreaterThan(REALTIME_RECONNECT_MIN_LIMIT)
  })

  it('lets one session re-ticket far past the login ceiling without a 429', async () => {
    const redis = buildRedis()
    const middleware = createRateLimitMiddleware({
      redis,
      config: { enabled: true, rules },
      logger: { warn: jest.fn() },
    })
    const mint = async (authorization: string) => {
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()
      middleware(buildRequest({ path: '/v1/sockets/sync/ticket', headers: { authorization } as never }), response, next)
      await flush()
      return { next, status }
    }

    // The old ceiling was `loginMax`. A reconnect round that re-tickets every
    // socket a session may hold has to clear it by a wide margin, so walk the
    // whole allowance and assert nothing was refused on the way.
    const allowance = realtimeReconnectLimit(limits.loginMax)
    for (let attempt = 0; attempt < allowance; attempt++) {
      const result = await mint('Bearer recovering')
      expect(result.status).not.toHaveBeenCalledWith(429)
      expect(result.next).toHaveBeenCalled()
    }

    // Still a limit, and still per session: the next mint is refused and a
    // different session on the same address is untouched.
    const overrun = await mint('Bearer recovering')
    expect(overrun.status).toHaveBeenCalledWith(429)
    const other = await mint('Bearer someone-else')
    expect(other.next).toHaveBeenCalled()
    expect(other.status).not.toHaveBeenCalledWith(429)
  })
})
