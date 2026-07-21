import 'reflect-metadata'

import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'
import { verify } from 'jsonwebtoken'
import { IAuthClient } from '@standardnotes/grpc'
import { RoleName } from '@standardnotes/domain-core'

import { GRPCWebSocketAuthMiddleware } from './GRPCWebSocketAuthMiddleware'

jest.mock('jsonwebtoken')

describe('GRPCWebSocketAuthMiddleware', () => {
  const mockedVerify = verify as unknown as jest.Mock

  let authClient: IAuthClient
  let logger: Logger
  let request: Request
  let response: Response
  let locals: Record<string, unknown>
  let next: NextFunction
  let status: jest.Mock
  let send: jest.Mock
  let setHeader: jest.Mock

  const createMiddleware = () => new GRPCWebSocketAuthMiddleware(authClient, 'jwt-secret', logger)

  /** Builds the grpc ServiceError shape the middleware reads: metadata.get(key) returns a list. */
  const grpcError = (entries: Record<string, string[]>) =>
    ({
      metadata: { get: (key: string) => entries[key] ?? [] },
    }) as never

  /** Resolves validateWebsocket with a successful ConnectionValidationResponse carrying `token`. */
  const respondWithToken = (token: string) => {
    ;(authClient.validateWebsocket as jest.Mock).mockImplementation((_request, callback) => {
      callback(null, { getCrossServiceToken: () => token })
    })
  }

  beforeEach(() => {
    mockedVerify.mockReset()
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3', email: 'test@test.te' },
      session: { uuid: 's-1', readonly_access: false },
      roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
      hasContentLimit: false,
    })

    authClient = { validateWebsocket: jest.fn() } as unknown as IAuthClient
    respondWithToken('cross-service-token')

    logger = { debug: jest.fn(), error: jest.fn() } as unknown as Logger

    request = { headers: { authorization: 'Bearer abc' } } as unknown as Request

    send = jest.fn()
    status = jest.fn().mockReturnValue({ send })
    setHeader = jest.fn()
    locals = {}
    response = { locals, status, send, setHeader } as unknown as Response

    next = jest.fn() as unknown as NextFunction
  })

  it('rejects a request with no Authorization header without calling the auth service', async () => {
    request = { headers: {} } as unknown as Request

    await createMiddleware().handler(request, response, next)

    expect(status).toHaveBeenCalledWith(401)
    expect(send).toHaveBeenCalledWith({ error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } })
    expect(authClient.validateWebsocket).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('sends the raw Authorization header value to the auth service as the token', async () => {
    await createMiddleware().handler(request, response, next)

    const sentRequest = (authClient.validateWebsocket as jest.Mock).mock.calls[0][0]
    expect(sentRequest.getToken()).toBe('Bearer abc')
  })

  it('projects the decoded token onto response.locals and continues the chain', async () => {
    await createMiddleware().handler(request, response, next)

    expect(mockedVerify).toHaveBeenCalledWith('cross-service-token', 'jwt-secret', { algorithms: ['HS256'] })
    expect(locals.authToken).toBe('cross-service-token')
    expect(locals.user).toEqual({ uuid: '1-2-3', email: 'test@test.te' })
    expect(locals.roles).toEqual([{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }])
    expect(next).toHaveBeenCalled()
  })

  it('marks a single CORE_USER role as a free user', async () => {
    await createMiddleware().handler(request, response, next)

    expect(locals.isFreeUser).toBe(true)
  })

  it('does NOT mark a user as free when a paid role sits alongside CORE_USER', async () => {
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3' },
      session: { uuid: 's-1' },
      roles: [
        { uuid: 'r-1', name: RoleName.NAMES.CoreUser },
        { uuid: 'r-2', name: RoleName.NAMES.PlusUser },
      ],
    })

    await createMiddleware().handler(request, response, next)

    expect(locals.isFreeUser).toBe(false)
  })

  it('does NOT mark a user as free when the single role is not CORE_USER', async () => {
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3' },
      session: { uuid: 's-1' },
      roles: [{ uuid: 'r-2', name: RoleName.NAMES.PlusUser }],
    })

    await createMiddleware().handler(request, response, next)

    expect(locals.isFreeUser).toBe(false)
  })

  it('propagates readonly_access from the session', async () => {
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3' },
      session: { uuid: 's-1', readonly_access: true },
      roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
    })

    await createMiddleware().handler(request, response, next)

    expect(locals.readOnlyAccess).toBe(true)
  })

  it('defaults readOnlyAccess to false when the token carries no session (fail-closed)', async () => {
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3' },
      roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
    })

    await createMiddleware().handler(request, response, next)

    expect(locals.readOnlyAccess).toBe(false)
  })

  it('forwards an auth error carrying a response code as that status, without continuing the chain', async () => {
    ;(authClient.validateWebsocket as jest.Mock).mockImplementation((_request, callback) => {
      callback(
        grpcError({
          'x-auth-error-response-code': ['401'],
          'x-auth-error-message': ['Invalid login credentials.'],
          'x-auth-error-tag': ['invalid-auth'],
        }),
        undefined,
      )
    })

    await createMiddleware().handler(request, response, next)

    expect(setHeader).toHaveBeenCalledWith('content-type', 'application/json')
    expect(status).toHaveBeenCalledWith(401)
    expect(send).toHaveBeenCalledWith({ error: { message: 'Invalid login credentials.', tag: 'invalid-auth' } })
    expect(next).not.toHaveBeenCalled()
    expect(locals).toEqual({})
  })

  it('responds 500 when the auth error carries no response code metadata', async () => {
    ;(authClient.validateWebsocket as jest.Mock).mockImplementation((_request, callback) => {
      callback(Object.assign(new Error('upstream down'), grpcError({})), undefined)
    })

    await createMiddleware().handler(request, response, next)

    expect(status).toHaveBeenCalledWith(500)
    expect(send).toHaveBeenCalledWith(
      "Unfortunately, we couldn't handle your request. Please try again or contact our support if the error persists.",
    )
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('upstream down'))
    expect(next).not.toHaveBeenCalled()
  })

  it('responds 500 when the auth client throws synchronously', async () => {
    ;(authClient.validateWebsocket as jest.Mock).mockImplementation(() => {
      throw new Error('channel closed')
    })

    await createMiddleware().handler(request, response, next)

    expect(status).toHaveBeenCalledWith(500)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('channel closed'))
    expect(next).not.toHaveBeenCalled()
  })

  it('does NOT populate locals or continue when the cross service token fails verification', async () => {
    mockedVerify.mockImplementation(() => {
      throw new Error('invalid signature')
    })

    await createMiddleware().handler(request, response, next)

    expect(locals).toEqual({})
    expect(status).toHaveBeenCalledWith(500)
    expect(next).not.toHaveBeenCalled()
  })
})
