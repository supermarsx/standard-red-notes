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

  it('accepts the subscription token from the request body when the query string omits it', async () => {
    await createMiddleware().handler(
      makeRequest({ query: {} as never, body: { subscription_token: 'from-body' } }),
      response,
      next,
    )

    expect((httpClient.request as jest.Mock).mock.calls[0][0].url).toBe(
      'https://auth/subscription-tokens/from-body/validate',
    )
    expect(next).toHaveBeenCalled()
  })

  it('marks the request as SubscriptionToken and validates against the online endpoint without an offline email', async () => {
    await createMiddleware().handler(makeRequest(), response, next)

    expect(locals.tokenAuthenticationMethod).toBe(TokenAuthenticationMethod.SubscriptionToken)
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://auth/subscription-tokens/sub-token/validate',
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
        url: 'https://auth/offline/subscription-tokens/sub-token/validate',
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

  it('forwards a non-200 auth response verbatim and does NOT continue the chain', async () => {
    ;(httpClient.request as jest.Mock).mockResolvedValue({
      status: 402,
      data: { error: { tag: 'no-subscription' } },
      headers: { 'content-type': 'application/json' },
    })

    await createMiddleware().handler(makeRequest(), response, next)

    expect(setHeader).toHaveBeenCalledWith('content-type', 'application/json')
    expect(status).toHaveBeenCalledWith(402)
    expect(send).toHaveBeenCalledWith({ error: { tag: 'no-subscription' } })
    expect(next).not.toHaveBeenCalled()
    expect(locals.authToken).toBeUndefined()
  })

  it('responds 500 with the plain message when a non-axios error is thrown', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('socket hang up'))

    await createMiddleware().handler(makeRequest(), response, next)

    expect(status).toHaveBeenCalledWith(500)
    expect(send).toHaveBeenCalledWith('socket hang up')
    expect(setHeader).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('serializes the axios error body, mirrors its content-type and uses a numeric error code as status', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue({
      isAxiosError: true,
      code: '503',
      response: { data: { error: 'unavailable' }, headers: { 'content-type': 'application/problem+json' } },
    })

    await createMiddleware().handler(makeRequest(), response, next)

    expect(setHeader).toHaveBeenCalledWith('content-type', 'application/problem+json')
    expect(status).toHaveBeenCalledWith(503)
    expect(send).toHaveBeenCalledWith(JSON.stringify({ error: 'unavailable' }))
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
})
