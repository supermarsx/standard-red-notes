import 'reflect-metadata'

import { NextFunction, Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'
import { CrossServiceTokenData } from '@standardnotes/security'

import { CrossServiceTokenCacheInterface } from '../Service/Cache/CrossServiceTokenCacheInterface'
import { ServiceProxyInterface } from '../Service/Proxy/ServiceProxyInterface'
import { RequiredCrossServiceTokenMiddleware } from './RequiredCrossServiceTokenMiddleware'

import { verify } from 'jsonwebtoken'

jest.mock('jsonwebtoken')

describe('AuthMiddleware settings projection', () => {
  const mockedVerify = verify as unknown as jest.Mock

  let serviceProxy: ServiceProxyInterface
  let crossServiceTokenCache: CrossServiceTokenCacheInterface
  let timer: { getTimestampInSeconds: jest.Mock; convertStringDateToSeconds: jest.Mock }
  let logger: { debug: jest.Mock; error: jest.Mock }

  const baseToken = (): CrossServiceTokenData => ({
    user: { uuid: '1-2-3', email: 'test@test.te' },
    roles: [{ uuid: 'r-1', name: 'CORE_USER' } as unknown as CrossServiceTokenData['roles'][number]],
  })

  const createMiddleware = () =>
    // crossServiceTokenCacheTTL = 0 disables the cache path so the handler decodes the token directly.
    new RequiredCrossServiceTokenMiddleware(
      serviceProxy,
      'jwt-secret',
      0,
      crossServiceTokenCache,
      timer as never,
      logger as never,
    )

  const runWith = async (decoded: CrossServiceTokenData): Promise<Record<string, unknown>> => {
    mockedVerify.mockReturnValue(decoded)

    const request = {
      headers: { authorization: 'Bearer token' },
      socket: { remoteAddress: '1.1.1.1' },
    } as unknown as Request

    const locals: Record<string, unknown> = {}
    const response = { locals } as unknown as Response
    const next = jest.fn() as unknown as NextFunction

    await createMiddleware().handler(request, response, next)

    expect(next).toHaveBeenCalled()
    return (locals.settings ?? {}) as Record<string, unknown>
  }

  beforeEach(() => {
    serviceProxy = {
      validateSession: jest.fn().mockResolvedValue({ status: 200, data: { authToken: 'encoded' }, headers: {} }),
    } as unknown as ServiceProxyInterface

    crossServiceTokenCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
    } as unknown as CrossServiceTokenCacheInterface

    timer = {
      getTimestampInSeconds: jest.fn().mockReturnValue(0),
      convertStringDateToSeconds: jest.fn().mockReturnValue(0),
    }

    logger = { debug: jest.fn(), error: jest.fn() }
  })

  it('projects ocr_server_allowed onto locals.settings when the token carries it', async () => {
    const settings = await runWith({ ...baseToken(), ocr_server_allowed: true })
    expect(settings[SettingName.NAMES.OcrServerAllowed]).toBe('true')
  })

  it('does NOT project ocr_server_allowed when the token omits it (fail-closed)', async () => {
    const settings = await runWith(baseToken())
    expect(settings[SettingName.NAMES.OcrServerAllowed]).toBeUndefined()
  })

  it('does NOT project ocr_server_allowed when the token carries a non-true value', async () => {
    const settings = await runWith({ ...baseToken(), ocr_server_allowed: false })
    expect(settings[SettingName.NAMES.OcrServerAllowed]).toBeUndefined()
  })

  it('projects ocr_server_allowed alongside the existing ai/workflows flags (same shape)', async () => {
    const settings = await runWith({
      ...baseToken(),
      ai_enabled: true,
      workflows_enabled: true,
      ocr_server_allowed: true,
    })
    expect(settings[SettingName.NAMES.AiEnabled]).toBe('true')
    expect(settings[SettingName.NAMES.WorkflowsEnabled]).toBe('true')
    expect(settings[SettingName.NAMES.OcrServerAllowed]).toBe('true')
  })

  const runReturningLocals = async (decoded: CrossServiceTokenData): Promise<Record<string, unknown>> => {
    mockedVerify.mockReturnValue(decoded)
    const request = {
      headers: { authorization: 'Bearer token' },
      socket: { remoteAddress: '1.1.1.1' },
    } as unknown as Request
    const locals: Record<string, unknown> = {}
    const response = { locals } as unknown as Response
    const next = jest.fn() as unknown as NextFunction
    await createMiddleware().handler(request, response, next)
    return locals
  }

  it('projects shadowBanned=true onto locals when the token carries shadow_banned', async () => {
    const locals = await runReturningLocals({ ...baseToken(), shadow_banned: true })
    expect(locals.shadowBanned).toBe(true)
  })

  it('projects shadowBanned=false when the token omits shadow_banned', async () => {
    const locals = await runReturningLocals(baseToken())
    expect(locals.shadowBanned).toBe(false)
  })
})

describe('AuthMiddleware client IP for session validation', () => {
  const mockedVerify = verify as unknown as jest.Mock

  let serviceProxy: ServiceProxyInterface
  let crossServiceTokenCache: CrossServiceTokenCacheInterface
  let timer: { getTimestampInSeconds: jest.Mock; convertStringDateToSeconds: jest.Mock }
  let logger: { debug: jest.Mock; error: jest.Mock }

  const createMiddleware = () =>
    // crossServiceTokenCacheTTL = 0 forces the validateSession path (no cache hit).
    new RequiredCrossServiceTokenMiddleware(
      serviceProxy,
      'jwt-secret',
      0,
      crossServiceTokenCache,
      timer as never,
      logger as never,
    )

  beforeEach(() => {
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3', email: 'test@test.te' },
      roles: [{ uuid: 'r-1', name: 'CORE_USER' }],
    })

    serviceProxy = {
      validateSession: jest.fn().mockResolvedValue({ status: 200, data: { authToken: 'encoded' }, headers: {} }),
    } as unknown as ServiceProxyInterface

    crossServiceTokenCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
    } as unknown as CrossServiceTokenCacheInterface

    timer = {
      getTimestampInSeconds: jest.fn().mockReturnValue(0),
      convertStringDateToSeconds: jest.fn().mockReturnValue(0),
    }

    logger = { debug: jest.fn(), error: jest.fn() }
  })

  const runWithRequest = async (request: Partial<Request>): Promise<string | undefined> => {
    const response = { locals: {} } as unknown as Response
    const next = jest.fn() as unknown as NextFunction

    await createMiddleware().handler(request as Request, response, next)

    const call = (serviceProxy.validateSession as jest.Mock).mock.calls[0]?.[0]
    return call?.requestMetadata?.ip as string | undefined
  }

  it('uses request.ip (TRUST_PROXY-resolved) and ignores a spoofed X-Forwarded-For', async () => {
    const ip = await runWithRequest({
      headers: { authorization: 'Bearer token', 'x-forwarded-for': '9.9.9.9, 8.8.8.8' } as never,
      socket: { remoteAddress: '1.1.1.1' } as never,
      ip: '2.2.2.2',
    })

    expect(ip).toBe('2.2.2.2')
  })

  it('falls back to the socket remote address when request.ip is undefined', async () => {
    const ip = await runWithRequest({
      headers: { authorization: 'Bearer token' } as never,
      socket: { remoteAddress: '1.1.1.1' } as never,
    })

    expect(ip).toBe('1.1.1.1')
  })
})
