import 'reflect-metadata'

import { AxiosInstance } from 'axios'
import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'
import { verify } from 'jsonwebtoken'

import { SubscriptionTokenAuthMiddleware } from './SubscriptionTokenAuthMiddleware'
import { TokenAuthenticationMethod } from './TokenAuthenticationMethod'

jest.mock('jsonwebtoken')

describe('SubscriptionTokenAuthMiddleware', () => {
  const mockedVerify = verify as unknown as jest.Mock

  let httpClient: AxiosInstance
  let logger: Logger
  let response: Response
  let locals: Record<string, unknown>
  let next: NextFunction
  let status: jest.Mock
  let send: jest.Mock
  let setHeader: jest.Mock

  const createMiddleware = () => new SubscriptionTokenAuthMiddleware(httpClient, 'https://auth', 'jwt-secret', logger)

  const makeRequest = (overrides: Partial<Request> = {}): Request =>
    ({
      query: { subscription_token: 'sub-token' },
      body: {},
      headers: {},
      ...overrides,
    }) as unknown as Request

  beforeEach(() => {
    mockedVerify.mockReset()
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3', email: 'test@test.te' },
      roles: [{ uuid: 'r-1', name: 'CORE_USER' }],
      userEmail: 'offline@test.te',
      featuresToken: 'features-token',
    })

    httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, data: { authToken: 'auth-token' }, headers: {} }),
    } as unknown as AxiosInstance

    logger = { debug: jest.fn(), error: jest.fn() } as unknown as Logger

    send = jest.fn()
    status = jest.fn().mockReturnValue({ send })
    setHeader = jest.fn()
    locals = {}
    response = { locals, status, send, setHeader } as unknown as Response

    next = jest.fn() as unknown as NextFunction
  })

  it('rejects with 401 when no subscription token is present in query or body', async () => {
    await createMiddleware().handler(makeRequest({ query: {} as never }), response, next)

    expect(status).toHaveBeenCalledWith(401)
    expect(send).toHaveBeenCalledWith({ error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } })
    expect(httpClient.request).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('preserves the exact 401 contract when the body is undefined', async () => {
    await createMiddleware().handler(
      makeRequest({ query: {} as never, body: undefined as unknown as Request['body'] }),
      response,
      next,
    )

    expect(status).toHaveBeenCalledWith(401)
    expect(send).toHaveBeenCalledWith({
      error: {
        tag: 'invalid-auth',
        message: 'Invalid login credentials.',
      },
    })
    expect(setHeader).not.toHaveBeenCalled()
    expect(httpClient.request).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts the subscription token from the request body when the query string omits it', async () => {
    await createMiddleware().handler(
      makeRequest({ query: {} as never, body: { subscription_token: 'from-body' } }),
      response,
      next,
    )

    const config = (httpClient.request as jest.Mock).mock.calls[0][0]
    expect(config.url).toBe('https://auth/subscription-tokens/validate')
    expect(config.headers['x-subscription-token']).toBe('from-body')
    expect(next).toHaveBeenCalled()
  })

  it('marks the request as SubscriptionToken and validates against the online endpoint without an offline email', async () => {
    await createMiddleware().handler(makeRequest(), response, next)

    expect(locals.tokenAuthenticationMethod).toBe(TokenAuthenticationMethod.SubscriptionToken)
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://auth/subscription-tokens/validate',
        headers: {
          Accept: 'application/json',
          'x-subscription-token': 'sub-token',
        },
        data: { email: undefined },
      }),
    )
  })

  it('switches to the offline endpoint and method when x-offline-email is present', async () => {
    await createMiddleware().handler(
      makeRequest({ headers: { 'x-offline-email': 'offline@test.te' } as never }),
      response,
      next,
    )

    expect(locals.tokenAuthenticationMethod).toBe(TokenAuthenticationMethod.OfflineSubscriptionToken)
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://auth/offline/subscription-tokens/validate',
        headers: {
          Accept: 'application/json',
          'x-subscription-token': 'sub-token',
        },
        data: { email: 'offline@test.te' },
      }),
    )
  })

  it('projects the decoded online token as user + roles onto locals', async () => {
    await createMiddleware().handler(makeRequest(), response, next)

    expect(mockedVerify).toHaveBeenCalledWith('auth-token', 'jwt-secret', { algorithms: ['HS256'] })
    expect(locals.authToken).toBe('auth-token')
    expect(locals.user).toEqual({ uuid: '1-2-3', email: 'test@test.te' })
    expect(locals.roles).toEqual([{ uuid: 'r-1', name: 'CORE_USER' }])
    expect(locals.offlineAuthToken).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  it('projects the decoded offline token as offlineAuthToken + userEmail + featuresToken onto locals', async () => {
    await createMiddleware().handler(
      makeRequest({ headers: { 'x-offline-email': 'offline@test.te' } as never }),
      response,
      next,
    )

    expect(locals.offlineAuthToken).toBe('auth-token')
    expect(locals.userEmail).toBe('offline@test.te')
    expect(locals.featuresToken).toBe('features-token')
    expect(locals.user).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  it('treats every status below 500 as a non-throwing response', async () => {
    await createMiddleware().handler(makeRequest(), response, next)

    const validateStatus = (httpClient.request as jest.Mock).mock.calls[0][0].validateStatus as (s: number) => boolean

    expect(validateStatus(200)).toBe(true)
    expect(validateStatus(499)).toBe(true)
    expect(validateStatus(500)).toBe(false)
    expect(validateStatus(199)).toBe(false)
  })

  it('preserves an allowlisted non-200 auth tag/status/content-type and does NOT continue the chain', async () => {
    ;(httpClient.request as jest.Mock).mockResolvedValue({
      status: 402,
      data: { error: { tag: 'no-subscription' } },
      headers: { 'content-type': 'application/json' },
    })

    await createMiddleware().handler(makeRequest(), response, next)

    expect(status).toHaveBeenCalledWith(402)
    expect(send).toHaveBeenCalledWith({ error: { tag: 'no-subscription' } })
    expect(setHeader).toHaveBeenCalledWith('content-type', 'application/json')
    expect(next).not.toHaveBeenCalled()
    expect(locals.authToken).toBeUndefined()
  })

  it('preserves a safe 402 tag when the upstream content-type header is absent', async () => {
    ;(httpClient.request as jest.Mock).mockResolvedValue({
      status: 402,
      data: { error: { tag: 'no-subscription' } },
      headers: {},
    })

    await createMiddleware().handler(makeRequest(), response, next)

    expect(status).toHaveBeenCalledWith(402)
    expect(send).toHaveBeenCalledWith({ error: { tag: 'no-subscription' } })
    expect(setHeader).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('responds with a stable public error when a non-axios error is thrown', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('socket hang up'))

    await createMiddleware().handler(makeRequest(), response, next)

    expect(status).toHaveBeenCalledWith(500)
    expect(send).toHaveBeenCalledWith({
      error: {
        tag: 'service-unavailable',
        message: 'The requested service is temporarily unavailable.',
      },
    })
    expect(setHeader).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('does not serialize an axios error body or mirror its content type', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue({
      isAxiosError: true,
      code: '503',
      response: {
        status: 503,
        data: { error: 'unavailable' },
        headers: { 'content-type': 'application/problem+json' },
      },
    })

    await createMiddleware().handler(makeRequest(), response, next)

    expect(setHeader).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(503)
    expect(send).toHaveBeenCalledWith({
      error: {
        tag: 'service-unavailable',
        message: 'The requested service is temporarily unavailable.',
      },
    })
  })

  it('falls back to 500 when the axios error code is not numeric', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue({
      isAxiosError: true,
      code: 'ECONNREFUSED',
      response: { data: { error: 'down' }, headers: {} },
    })

    await createMiddleware().handler(makeRequest(), response, next)

    expect(status).toHaveBeenCalledWith(500)
  })

  it('keeps the subscription credential out of the fixed URL, request body, and all log arguments', async () => {
    const sentinel = 'subscription-token-sentinel'
    const error: Record<string, unknown> = {
      name: 'AxiosError',
      code: 'ERR_BAD_RESPONSE',
      message: `request failed for ${sentinel}`,
      response: {
        status: 503,
        data: {
          accessToken: 'access-token-sentinel',
          encryptedContent: 'encrypted-content-sentinel',
        },
        headers: {
          'set-cookie': 'cookie-sentinel',
        },
      },
      config: {
        headers: {
          Authorization: 'Bearer access-token-sentinel',
          'x-subscription-token': sentinel,
        },
      },
    }
    error.circular = error
    ;(httpClient.request as jest.Mock).mockRejectedValue(error)

    await createMiddleware().handler(makeRequest({ query: { subscription_token: sentinel } as never }), response, next)

    const config = (httpClient.request as jest.Mock).mock.calls[0][0]
    expect(config.url).toBe('https://auth/subscription-tokens/validate')
    expect(config.url).not.toContain(sentinel)
    expect(JSON.stringify(config.data)).not.toContain(sentinel)
    expect(config.headers['x-subscription-token']).toBe(sentinel)

    const serializedLogs = JSON.stringify({
      error: (logger.error as jest.Mock).mock.calls,
      debug: (logger.debug as jest.Mock).mock.calls,
    })
    expect(serializedLogs).not.toContain(sentinel)
    expect(serializedLogs).not.toContain('access-token-sentinel')
    expect(serializedLogs).not.toContain('encrypted-content-sentinel')
    expect(serializedLogs).not.toContain('cookie-sentinel')
  })
})
