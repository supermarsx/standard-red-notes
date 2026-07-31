import 'reflect-metadata'

import { AxiosInstance } from 'axios'
import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'
import { verify } from 'jsonwebtoken'

import { WebSocketAuthMiddleware } from './WebSocketAuthMiddleware'

jest.mock('jsonwebtoken')

describe('WebSocketAuthMiddleware', () => {
  const mockedVerify = verify as unknown as jest.Mock

  let httpClient: AxiosInstance
  let logger: Logger
  let request: Request
  let response: Response
  let locals: Record<string, unknown>
  let next: NextFunction
  let status: jest.Mock
  let send: jest.Mock
  let setHeader: jest.Mock

  const createMiddleware = () => new WebSocketAuthMiddleware(httpClient, 'https://auth', 'jwt-secret', logger)

  beforeEach(() => {
    mockedVerify.mockReset()
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3', email: 'test@test.te' },
      session: { uuid: 's-1' },
      roles: [{ uuid: 'r-1', name: 'CORE_USER' }],
    })

    httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, data: { authToken: 'cross-service-token' }, headers: {} }),
    } as unknown as AxiosInstance

    logger = { debug: jest.fn(), error: jest.fn() } as unknown as Logger

    request = { headers: { authorization: 'Bearer abc' } } as unknown as Request

    send = jest.fn()
    status = jest.fn().mockReturnValue({ send })
    setHeader = jest.fn()
    locals = {}
    response = { locals, status, send, setHeader } as unknown as Response

    next = jest.fn() as unknown as NextFunction
  })

  it('rejects a request with no Authorization header without calling auth', async () => {
    request = { headers: {} } as unknown as Request

    await createMiddleware().handler(request, response, next)

    expect(status).toHaveBeenCalledWith(401)
    expect(send).toHaveBeenCalledWith({ error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } })
    expect(httpClient.request).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('validates the token against the auth server sockets endpoint, forwarding the Authorization header', async () => {
    await createMiddleware().handler(request, response, next)

    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://auth/sockets/tokens/validate',
        headers: { Authorization: 'Bearer abc', Accept: 'application/json' },
      }),
    )
  })

  it('treats every status below 500 as a non-throwing response so upstream 4xx bodies are forwarded', async () => {
    await createMiddleware().handler(request, response, next)

    const validateStatus = (httpClient.request as jest.Mock).mock.calls[0][0].validateStatus as (s: number) => boolean

    expect(validateStatus(200)).toBe(true)
    expect(validateStatus(401)).toBe(true)
    expect(validateStatus(499)).toBe(true)
    expect(validateStatus(500)).toBe(false)
    expect(validateStatus(199)).toBe(false)
  })

  it('projects the decoded token onto response.locals and continues the chain on success', async () => {
    await createMiddleware().handler(request, response, next)

    expect(mockedVerify).toHaveBeenCalledWith('cross-service-token', 'jwt-secret', { algorithms: ['HS256'] })
    expect(locals).toEqual({
      authToken: 'cross-service-token',
      user: { uuid: '1-2-3', email: 'test@test.te' },
      session: { uuid: 's-1' },
      roles: [{ uuid: 'r-1', name: 'CORE_USER' }],
    })
    expect(next).toHaveBeenCalled()
  })

  it('preserves a safe non-200 auth tag/status/content-type and does NOT continue the chain', async () => {
    ;(httpClient.request as jest.Mock).mockResolvedValue({
      status: 401,
      data: { error: { tag: 'invalid-auth' } },
      headers: { 'content-type': 'application/json' },
    })

    await createMiddleware().handler(request, response, next)

    expect(status).toHaveBeenCalledWith(401)
    expect(send).toHaveBeenCalledWith({ error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } })
    expect(setHeader).toHaveBeenCalledWith('content-type', 'application/json')
    expect(next).not.toHaveBeenCalled()
    expect(locals).toEqual({})
  })

  it('preserves a safe non-200 auth response when content-type is absent', async () => {
    ;(httpClient.request as jest.Mock).mockResolvedValue({
      status: 401,
      data: { error: { tag: 'invalid-auth' } },
      headers: {},
    })

    await createMiddleware().handler(request, response, next)

    expect(status).toHaveBeenCalledWith(401)
    expect(send).toHaveBeenCalledWith({
      error: { tag: 'invalid-auth', message: 'Invalid login credentials.' },
    })
    expect(setHeader).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('does NOT populate locals when the cross service token fails verification', async () => {
    mockedVerify.mockImplementation(() => {
      throw new Error('bad signature')
    })

    await createMiddleware().handler(request, response, next)

    expect(locals).toEqual({})
    expect(next).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(500)
    expect(send).toHaveBeenCalledWith({
      error: {
        tag: 'service-unavailable',
        message: 'The requested service is temporarily unavailable.',
      },
    })
  })

  it('responds 500 with a stable public error when a non-axios error is thrown', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('socket hang up'))

    await createMiddleware().handler(request, response, next)

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

  it('does not serialize an axios error response body or mirror its content-type', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue({
      isAxiosError: true,
      code: 'ECONNREFUSED',
      response: { data: { error: 'nope' }, headers: { 'content-type': 'application/problem+json' } },
    })

    await createMiddleware().handler(request, response, next)

    expect(setHeader).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(500)
    expect(send).toHaveBeenCalledWith({
      error: {
        tag: 'service-unavailable',
        message: 'The requested service is temporarily unavailable.',
      },
    })
  })

  it('uses an upstream 5xx response status while keeping the body private', async () => {
    ;(httpClient.request as jest.Mock).mockRejectedValue({
      isAxiosError: true,
      code: '503',
      response: { status: 503, data: { error: 'unavailable' }, headers: {} },
    })

    await createMiddleware().handler(request, response, next)

    expect(status).toHaveBeenCalledWith(503)
    expect(send).toHaveBeenCalledWith({
      error: {
        tag: 'service-unavailable',
        message: 'The requested service is temporarily unavailable.',
      },
    })
  })

  it('never logs authorization, cookies, upstream bodies, circular axios config, or raw error messages', async () => {
    const error: Record<string, unknown> = {
      name: 'AxiosError',
      code: 'ERR_BAD_RESPONSE',
      message: 'access-token-sentinel',
      response: {
        status: 503,
        data: { encryptedContent: 'encrypted-content-sentinel' },
        headers: { 'set-cookie': 'cookie-sentinel' },
      },
      config: {
        headers: {
          Authorization: 'Bearer access-token-sentinel',
          Cookie: 'cookie-sentinel',
        },
      },
    }
    error.circular = error
    ;(httpClient.request as jest.Mock).mockRejectedValue(error)

    await createMiddleware().handler(request, response, next)

    const serializedLogs = JSON.stringify({
      error: (logger.error as jest.Mock).mock.calls,
      debug: (logger.debug as jest.Mock).mock.calls,
    })
    expect(serializedLogs).not.toContain('access-token-sentinel')
    expect(serializedLogs).not.toContain('encrypted-content-sentinel')
    expect(serializedLogs).not.toContain('cookie-sentinel')
  })
})
