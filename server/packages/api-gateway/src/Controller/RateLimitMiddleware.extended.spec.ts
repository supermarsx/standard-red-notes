import { NextFunction, Request, Response } from 'express'

import {
  buildDefaultRateLimitRules,
  createRateLimitMiddleware,
  createUserRateLimitMiddleware,
  RateLimitConfig,
  RateLimitRedis,
} from './RateLimitMiddleware'
import { IpAclDecision } from './IpAccessList'

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
  locals: Record<string, unknown>
} => {
  const send = jest.fn()
  const status = jest.fn().mockReturnValue({ send })
  const setHeader = jest.fn()
  const locals: Record<string, unknown> = {}
  const response = { status, send, setHeader, locals } as unknown as Response

  return { response, status, send, setHeader, locals }
}

const buildRedis = (overrides: Partial<RateLimitRedis> = {}): RateLimitRedis => {
  const counts: Record<string, number> = {}
  return {
    incr: jest.fn((key: string) => {
      counts[key] = (counts[key] ?? 0) + 1
      return Promise.resolve(counts[key])
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    ttl: jest.fn(() => Promise.resolve(30)),
    ...overrides,
  }
}

const limits = { windowSeconds: 60, loginMax: 2, registrationMax: 1 }
const staticConfig: RateLimitConfig = { enabled: true, rules: buildDefaultRateLimitRules(limits) }

describe('RateLimitMiddleware (config provider + IP lists + headers)', () => {
  it('resolves the config from an async provider per request', async () => {
    const provider = jest.fn(async (): Promise<RateLimitConfig> => staticConfig)
    const next: NextFunction = jest.fn()
    const middleware = createRateLimitMiddleware({ redis: buildRedis(), config: provider, logger: { warn: jest.fn() } })
    middleware(buildRequest(), buildResponse().response, next)
    await flush()
    expect(provider).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('fails open (next) when config resolution throws', async () => {
    const provider = jest.fn(async (): Promise<RateLimitConfig> => {
      throw new Error('overlay broken')
    })
    const next: NextFunction = jest.fn()
    const warn = jest.fn()
    const { status } = buildResponse()
    const middleware = createRateLimitMiddleware({ redis: buildRedis(), config: provider, logger: { warn } })
    middleware(buildRequest(), buildResponse().response, next)
    await flush()
    expect(next).toHaveBeenCalledTimes(1)
    expect(status).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('rejects a blocklisted IP with 403 and records the block, before any tier', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const recordBlock = jest.fn(() => Promise.resolve())
    const ipAccessList = { classify: jest.fn((): Promise<IpAclDecision> => Promise.resolve('blocked')) }
    const { response, status, send } = buildResponse()
    const middleware = createRateLimitMiddleware({
      redis,
      config: staticConfig,
      logger: { warn: jest.fn() },
      ipAccessList,
      metrics: { recordThrottle: jest.fn(() => Promise.resolve()), recordBlock },
    })
    middleware(buildRequest(), response, next)
    await flush()
    expect(status).toHaveBeenCalledWith(403)
    expect(send).toHaveBeenCalled()
    expect(recordBlock).toHaveBeenCalled()
    expect(redis.incr).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('bypasses tiers for an allowlisted IP (no counter touched)', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const ipAccessList = { classify: jest.fn((): Promise<IpAclDecision> => Promise.resolve('allowed')) }
    const middleware = createRateLimitMiddleware({
      redis,
      config: staticConfig,
      logger: { warn: jest.fn() },
      ipAccessList,
    })
    middleware(buildRequest(), buildResponse().response, next)
    await flush()
    expect(next).toHaveBeenCalledTimes(1)
    expect(redis.incr).not.toHaveBeenCalled()
  })

  it('continues to the tiers (fail-open) when the IP-list lookup throws', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const warn = jest.fn()
    const ipAccessList = { classify: jest.fn((): Promise<IpAclDecision> => Promise.reject(new Error('redis down'))) }
    const middleware = createRateLimitMiddleware({
      redis,
      config: staticConfig,
      logger: { warn },
      ipAccessList,
    })
    middleware(buildRequest(), buildResponse().response, next)
    await flush()
    expect(warn).toHaveBeenCalled()
    expect(redis.incr).toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('sets X-RateLimit-Limit/-Remaining on an allowed request', async () => {
    const next: NextFunction = jest.fn()
    const { response, setHeader } = buildResponse()
    const middleware = createRateLimitMiddleware({ redis: buildRedis(), config: staticConfig, logger: { warn: jest.fn() } })
    middleware(buildRequest(), response, next)
    await flush()
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '2')
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '1')
  })

  it('sets Retry-After + full X-RateLimit-* and fires onThrottle/metrics on 429', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const recordThrottle = jest.fn(() => Promise.resolve())
    const onThrottle = jest.fn()
    const middleware = createRateLimitMiddleware({
      redis,
      config: staticConfig,
      logger: { warn: jest.fn() },
      metrics: { recordThrottle, recordBlock: jest.fn(() => Promise.resolve()) },
      onThrottle,
      now: () => 1_000_000_000, // 1e9 ms -> 1e6 s
    })
    // loginMax = 2 -> third request is throttled
    middleware(buildRequest(), buildResponse().response, next)
    await flush()
    middleware(buildRequest(), buildResponse().response, next)
    await flush()
    const third = buildResponse()
    middleware(buildRequest(), third.response, next)
    await flush()

    expect(third.status).toHaveBeenCalledWith(429)
    expect(third.setHeader).toHaveBeenCalledWith('Retry-After', '30')
    expect(third.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '2')
    expect(third.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0')
    expect(third.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', String(1_000_000 + 30))
    expect(recordThrottle).toHaveBeenCalledWith({ bucket: 'auth-login', ip: '1.2.3.4', method: 'POST', path: '/v1/login' })
    expect(onThrottle).toHaveBeenCalledWith('1.2.3.4', 'auth-login')
  })
})

describe('createUserRateLimitMiddleware (per-user tier)', () => {
  const userConfig = { bucket: 'assistant', windowSeconds: 60, max: 2 }

  it('is a pass-through when max <= 0', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const middleware = createUserRateLimitMiddleware({
      redis,
      config: { ...userConfig, max: 0 },
      logger: { warn: jest.fn() },
    })
    const res = buildResponse()
    res.locals.user = { uuid: 'user-1' }
    middleware(buildRequest(), res.response, next)
    await flush()
    expect(next).toHaveBeenCalledTimes(1)
    expect(redis.incr).not.toHaveBeenCalled()
  })

  it('passes through when there is no authenticated user on locals', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const middleware = createUserRateLimitMiddleware({ redis, config: userConfig, logger: { warn: jest.fn() } })
    middleware(buildRequest(), buildResponse().response, next)
    await flush()
    expect(next).toHaveBeenCalledTimes(1)
    expect(redis.incr).not.toHaveBeenCalled()
  })

  it('limits per user uuid and 429s beyond the max', async () => {
    const redis = buildRedis()
    const next: NextFunction = jest.fn()
    const middleware = createUserRateLimitMiddleware({ redis, config: userConfig, logger: { warn: jest.fn() } })
    const run = (): Promise<void> => {
      const res = buildResponse()
      res.locals.user = { uuid: 'user-1' }
      return Promise.resolve(middleware(buildRequest(), res.response, next)).then(flush)
    }
    await run()
    await run()
    const res = buildResponse()
    res.locals.user = { uuid: 'user-1' }
    middleware(buildRequest(), res.response, next)
    await flush()
    expect(res.status).toHaveBeenCalledWith(429)
    expect(redis.incr).toHaveBeenCalledWith('rl:user:assistant:user-1')
    expect(next).toHaveBeenCalledTimes(2)
  })
})
