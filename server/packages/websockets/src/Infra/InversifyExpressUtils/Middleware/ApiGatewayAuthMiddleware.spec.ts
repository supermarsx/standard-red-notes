import 'reflect-metadata'

import { CrossServiceTokenData, TokenDecoderInterface } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'

import { ApiGatewayAuthMiddleware } from './ApiGatewayAuthMiddleware'

/**
 * Standard Red Notes: this spec exists because the file it covers had NO test
 * at all and was outside this package's coverage denominator, behind a flat
 * `'/InversifyExpressUtils/'` entry in `coveragePathIgnorePatterns`. With that
 * entry in place the package reported `All files 100 | 100 | 100 | 100` while
 * the one thing standing between an unauthenticated request and every
 * `/sockets` route was neither tested nor measured.
 *
 * The directory could only be brought into the denominator once this existed,
 * so the tests come first and the config change second. Each case below is a
 * behavioural assertion on what the middleware DECIDES — not a line-toucher:
 * every one of them fails if the corresponding decision is inverted.
 */
describe('ApiGatewayAuthMiddleware', () => {
  let tokenDecoder: TokenDecoderInterface<CrossServiceTokenData>
  let logger: Logger
  let request: Request
  let response: Response
  let next: NextFunction

  const createMiddleware = () => new ApiGatewayAuthMiddleware(tokenDecoder, logger)

  const token = (overrides: Partial<CrossServiceTokenData> = {}): CrossServiceTokenData =>
    ({
      user: { uuid: '1-2-3', email: 'test@test.te' },
      session: { uuid: '2-3-4' },
      roles: [{ uuid: '3-4-5', name: 'CORE_USER' }],
      ...overrides,
    }) as unknown as CrossServiceTokenData

  const unauthorizedBody = {
    error: {
      tag: 'invalid-auth',
      message: 'Invalid login credentials.',
    },
  }

  beforeEach(() => {
    tokenDecoder = {} as jest.Mocked<TokenDecoderInterface<CrossServiceTokenData>>
    tokenDecoder.decodeToken = jest.fn()

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()

    request = { headers: {} } as jest.Mocked<Request>
    response = { locals: {} } as jest.Mocked<Response>
    response.status = jest.fn().mockReturnThis()
    response.send = jest.fn()
    next = jest.fn()
  })

  it('rejects a request that carries no x-auth-token header', async () => {
    await createMiddleware().handler(request, response, next)

    expect(response.status).toHaveBeenCalledWith(401)
    expect(response.send).toHaveBeenCalledWith(unauthorizedBody)
    // The decoder must not even be consulted: a missing header is not a token
    // to be parsed, and reaching the decoder is how a `''` header turns into a
    // decoder-dependent answer.
    expect(tokenDecoder.decodeToken).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(response.locals.user).toBeUndefined()
  })

  it('rejects a request whose token does not decode', async () => {
    request.headers['x-auth-token'] = 'not-a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(undefined)

    await createMiddleware().handler(request, response, next)

    expect(tokenDecoder.decodeToken).toHaveBeenCalledWith('not-a-token')
    expect(response.status).toHaveBeenCalledWith(401)
    expect(response.send).toHaveBeenCalledWith(unauthorizedBody)
    expect(next).not.toHaveBeenCalled()
    expect(response.locals.session).toBeUndefined()
  })

  // A token that decodes but carries no session is NOT a usable identity here:
  // every route downstream reads `response.locals.session.uuid`, so letting it
  // through would be a crash at best and an unattributed connection at worst.
  it('rejects a decoded token that carries no session', async () => {
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(token({ session: undefined }))

    await createMiddleware().handler(request, response, next)

    expect(response.status).toHaveBeenCalledWith(401)
    expect(response.send).toHaveBeenCalledWith(unauthorizedBody)
    expect(next).not.toHaveBeenCalled()
    expect(response.locals.user).toBeUndefined()
  })

  it('projects the decoded token onto response locals and continues', async () => {
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(token())

    await createMiddleware().handler(request, response, next)

    expect(response.locals.user).toEqual({ uuid: '1-2-3', email: 'test@test.te' })
    expect(response.locals.session).toEqual({ uuid: '2-3-4' })
    expect(response.locals.roles).toEqual([{ uuid: '3-4-5', name: 'CORE_USER' }])
    expect(response.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  // `?? false` rather than passing `undefined` through: a downstream check
  // written as `if (readOnlyAccess)` reads `undefined` as "writable", so a `??`
  // that defaulted the other way — or was dropped — would silently hand a
  // read-only session write access.
  it('defaults readOnlyAccess to false when the session does not say', async () => {
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(token())

    await createMiddleware().handler(request, response, next)

    expect(response.locals.readOnlyAccess).toBe(false)
  })

  it('carries a read-only session through as readOnlyAccess true', async () => {
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(
      token({
        session: { uuid: '2-3-4', readonly_access: true },
      } as unknown as Partial<CrossServiceTokenData>),
    )

    await createMiddleware().handler(request, response, next)

    expect(response.locals.readOnlyAccess).toBe(true)
    expect(next).toHaveBeenCalled()
  })

  // A decoder that throws must not be read as "authenticated". It must also not
  // be answered with a 401 of this middleware's own making: that would turn a
  // server-side fault (a missing key, a malformed JWT secret) into a client
  // error the caller would retry forever. It goes to the express error handler.
  it('hands a decoder failure to the express error handler instead of answering 401', async () => {
    const error = new Error('decoder exploded')
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockImplementation(() => {
      throw error
    })

    await createMiddleware().handler(request, response, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(response.status).not.toHaveBeenCalled()
    expect(response.locals.user).toBeUndefined()
  })

  // `execute()` is what the route adapter actually calls; `handler()` is what
  // this file defines. Pinning the delegation means a future `execute` override
  // that forgot to call `handler` would fail here rather than silently disable
  // authentication on every `/sockets` route.
  it('enforces the same rejection through execute(), the route-facing entry point', async () => {
    await createMiddleware().execute(request, response, next)

    expect(response.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
