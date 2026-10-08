import 'reflect-metadata'

import { CrossServiceTokenData, TokenDecoderInterface } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'

import { ApiGatewayAuthMiddleware } from './ApiGatewayAuthMiddleware'

/**
 * Standard Red Notes: this spec exists because the file it covers was outside
 * this package's coverage denominator, behind a flat `'/Infra/'` entry in
 * `coveragePathIgnorePatterns`. It is the only thing standing between an
 * unauthenticated request and every revisions route, and it decides
 * `readOnlyAccess` — so it is exactly the kind of file a floor should see, and
 * the directory could only be brought into the denominator once it had a test.
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
    expect(response.send).toHaveBeenCalledWith({
      error: { tag: 'invalid-auth', message: 'Invalid login credentials.' },
    })
    expect(tokenDecoder.decodeToken).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a request whose token does not decode', async () => {
    request.headers['x-auth-token'] = 'not-a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(undefined)

    await createMiddleware().handler(request, response, next)

    expect(tokenDecoder.decodeToken).toHaveBeenCalledWith('not-a-token')
    expect(response.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
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

  // Both of these default rather than pass `undefined` through: a `??` that
  // defaulted the wrong way would hand a read-only session write access, or a
  // downstream `.includes()` a crash.
  it('defaults readOnlyAccess to false and belongsToSharedVaults to empty', async () => {
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(token())

    await createMiddleware().handler(request, response, next)

    expect(response.locals.readOnlyAccess).toBe(false)
    expect(response.locals.belongsToSharedVaults).toEqual([])
  })

  it('carries a read-only session and shared vault membership through', async () => {
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(
      token({
        session: { uuid: '2-3-4', readonly_access: true },
        belongs_to_shared_vaults: ['vault-1'],
      } as unknown as Partial<CrossServiceTokenData>),
    )

    await createMiddleware().handler(request, response, next)

    expect(response.locals.readOnlyAccess).toBe(true)
    expect(response.locals.belongsToSharedVaults).toEqual(['vault-1'])
    expect(next).toHaveBeenCalled()
  })

  it('hands a decoder failure to the express error handler instead of answering 401', async () => {
    const error = new Error('decoder exploded')
    request.headers['x-auth-token'] = 'a-token'
    tokenDecoder.decodeToken = jest.fn().mockImplementation(() => {
      throw error
    })

    await createMiddleware().handler(request, response, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(response.status).not.toHaveBeenCalled()
  })
})
