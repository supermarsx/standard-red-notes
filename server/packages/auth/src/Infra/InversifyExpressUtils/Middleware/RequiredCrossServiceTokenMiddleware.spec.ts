import { CrossServiceTokenData, TokenDecoderInterface } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'

import { RequiredCrossServiceTokenMiddleware } from './RequiredCrossServiceTokenMiddleware'

describe('RequiredCrossServiceTokenMiddleware legacy compatibility', () => {
  it('accepts a valid v1 token at the general authentication boundary', async () => {
    const tokenDecoder = {
      decodeToken: jest.fn().mockReturnValue({
        user: { uuid: 'user-1', email: 'user@example.test' },
        roles: [],
        version: 1,
      } satisfies CrossServiceTokenData),
    } as unknown as jest.Mocked<TokenDecoderInterface<CrossServiceTokenData>>
    const middleware = new RequiredCrossServiceTokenMiddleware(tokenDecoder, { debug: jest.fn() } as never)
    const request = {
      headers: {
        'x-auth-token': 'legacy-token',
      },
    } as unknown as Request
    const response = {
      locals: {},
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response
    const next = jest.fn() as NextFunction

    await middleware.handler(request, response, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(response.locals).toEqual(
      expect.objectContaining({
        user: { uuid: 'user-1', email: 'user@example.test' },
        authTokenVersion: 1,
      }),
    )
  })
})
