import 'reflect-metadata'

import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'

import { ServerSettingsResolver } from '../Service/ServerSettings/ServerSettingsResolver'
import { RateLimitRedis } from './RateLimitMiddleware'
import { UserRateLimitMiddleware } from './UserRateLimitMiddleware'

describe('UserRateLimitMiddleware', () => {
  let logger: Logger
  let serverSettingsResolver: jest.Mocked<ServerSettingsResolver>

  const rateLimitConfig = {
    enabled: true,
    windowSeconds: 60,
    loginMax: 10,
    registrationMax: 5,
    userWindowSeconds: 60,
    userMax: 0,
    adaptiveEscalation: false,
  }

  const createMiddleware = (redis?: RateLimitRedis) =>
    new UserRateLimitMiddleware(serverSettingsResolver, logger, redis)

  const run = (
    middleware: UserRateLimitMiddleware,
    response: Response = { locals: { user: { uuid: 'user-1' } }, setHeader: jest.fn() } as unknown as Response,
  ): Promise<{ next: jest.Mock; response: Response }> => {
    const next = jest.fn() as unknown as NextFunction
    const request = { method: 'POST', path: '/v1/assistant/stream', headers: {} } as unknown as Request
    middleware.handler(request, response, next)

    // The wrapped limiter runs an async IIFE; flush the microtask queue.
    return new Promise((resolve) => setImmediate(() => resolve({ next: next as jest.Mock, response })))
  }

  beforeEach(() => {
    logger = { warn: jest.fn() } as unknown as Logger
    serverSettingsResolver = {
      resolveRateLimitConfig: jest.fn().mockResolvedValue({ ...rateLimitConfig }),
    } as unknown as jest.Mocked<ServerSettingsResolver>
  })

  it('passes through when the per-user tier is disabled (userMax 0, the default)', async () => {
    const redis: RateLimitRedis = { incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() }
    const { next } = await run(createMiddleware(redis))

    expect(next).toHaveBeenCalled()
    expect(redis.incr).not.toHaveBeenCalled()
  })

  it('is a no-op pass-through when Redis is unavailable', async () => {
    const { next } = await run(createMiddleware(undefined))

    expect(next).toHaveBeenCalled()
    expect(serverSettingsResolver.resolveRateLimitConfig).not.toHaveBeenCalled()
  })

  it('enforces the per-user tier (429) once the user exceeds the configured max', async () => {
    serverSettingsResolver.resolveRateLimitConfig.mockResolvedValue({ ...rateLimitConfig, userMax: 1 })
    const redis: RateLimitRedis = {
      incr: jest.fn().mockResolvedValue(2), // second request in the window > max 1
      expire: jest.fn(),
      ttl: jest.fn().mockResolvedValue(60),
    }
    const status = jest.fn().mockReturnThis()
    const send = jest.fn()
    const response = {
      locals: { user: { uuid: 'user-1' } },
      setHeader: jest.fn(),
      status,
      send,
    } as unknown as Response
    const { next } = await run(createMiddleware(redis), response)

    expect(status).toHaveBeenCalledWith(429)
    expect(next).not.toHaveBeenCalled()
    expect(redis.incr).toHaveBeenCalledWith('rl:user:assistant:user-1')
  })

  it('passes through an enabled tier while the user is within budget', async () => {
    serverSettingsResolver.resolveRateLimitConfig.mockResolvedValue({ ...rateLimitConfig, userMax: 5 })
    const redis: RateLimitRedis = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn(),
      ttl: jest.fn(),
    }
    const { next } = await run(createMiddleware(redis))

    expect(next).toHaveBeenCalled()
  })
})
