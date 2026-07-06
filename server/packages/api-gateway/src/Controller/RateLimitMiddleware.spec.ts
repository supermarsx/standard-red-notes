import { NextFunction, Request, Response } from 'express'
import {
  buildDefaultRateLimitRules,
  createRateLimitMiddleware,
  isWithinRateLimit,
  normalizeRateLimitPath,
  RateLimitRedis,
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
    })
    it('matches the sensitive tier', () => {
      expect(matchesAny('POST', '/v1/users')).toBe(true)
      expect(matchesAny('POST', '/v1/mcp-tokens/authenticate')).toBe(true)
      expect(matchesAny('POST', '/v1/mfa/magic-link/request')).toBe(true)
    })
    it('does not match authenticated/other paths or non-POST methods', () => {
      expect(matchesAny('POST', '/v1/items/sync')).toBe(false)
      expect(matchesAny('GET', '/v1/login')).toBe(false)
      expect(matchesAny('POST', '/v1/login-params')).toBe(false)
    })
  })

  describe('createRateLimitMiddleware', () => {
    const config = { enabled: true, rules: buildDefaultRateLimitRules(limits) }

    it('is a no-op pass-through when disabled', async () => {
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()
      const middleware = createRateLimitMiddleware({ redis: buildRedis(), config: { ...config, enabled: false }, logger: { warn: jest.fn() } })
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
      const redis = buildRedis({ incr: jest.fn(() => Promise.reject(new Error('redis down'))) })
      const { response, status } = buildResponse()
      const middleware = createRateLimitMiddleware({ redis, config, logger: { warn } })
      middleware(buildRequest(), response, next)
      await flush()
      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    })
  })
})
