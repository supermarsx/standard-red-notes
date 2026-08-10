import 'reflect-metadata'

import { Request, Response } from 'express'

import { CookieFactoryInterface } from '../../../Domain/Auth/Cookies/CookieFactoryInterface'
import { RefreshSessionToken } from '../../../Domain/UseCase/RefreshSessionToken'
import { BaseSessionController } from './BaseSessionController'

describe('BaseSessionController refresh', () => {
  it('preserves the generic 400 invalid-refresh contract and emits no cookie for a policy rejection', async () => {
    const refreshSessionToken = {
      execute: jest.fn().mockResolvedValue({
        success: false,
        errorTag: 'invalid-refresh-token',
        errorMessage: 'The refresh token is not valid.',
      }),
    } as unknown as jest.Mocked<RefreshSessionToken>
    const cookieFactory = {
      createCookieHeaderValue: jest.fn(),
    } as unknown as jest.Mocked<CookieFactoryInterface>
    const controller = new BaseSessionController({} as never, {} as never, refreshSessionToken, cookieFactory)
    const request = {
      body: {
        access_token: 'existing-access-token',
        refresh_token: 'existing-refresh-token',
        api: '20200115',
      },
      headers: {},
    } as unknown as Request
    const response = { setHeader: jest.fn() } as unknown as Response

    const result = await controller.refresh(request, response)

    expect(result.statusCode).toBe(400)
    expect(result.json).toEqual({
      error: {
        tag: 'invalid-refresh-token',
        message: 'The refresh token is not valid.',
      },
    })
    expect(response.setHeader).not.toHaveBeenCalled()
    expect(cookieFactory.createCookieHeaderValue).not.toHaveBeenCalled()
  })
})
