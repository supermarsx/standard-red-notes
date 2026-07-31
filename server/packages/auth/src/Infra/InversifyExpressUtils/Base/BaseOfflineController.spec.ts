import { Request } from 'express'
import { Logger } from 'winston'

import { AuthenticateOfflineSubscriptionToken } from '../../../Domain/UseCase/AuthenticateOfflineSubscriptionToken/AuthenticateOfflineSubscriptionToken'
import { BaseOfflineController } from './BaseOfflineController'

describe('BaseOfflineController subscription token transport', () => {
  let authenticateToken: jest.Mocked<Pick<AuthenticateOfflineSubscriptionToken, 'execute'>>
  let controller: BaseOfflineController

  beforeEach(() => {
    authenticateToken = {
      execute: jest.fn().mockResolvedValue({ success: false }),
    }
    controller = new BaseOfflineController(
      {} as never,
      {} as never,
      {} as never,
      authenticateToken as unknown as AuthenticateOfflineSubscriptionToken,
      {} as never,
      60,
      { debug: jest.fn() } as unknown as Logger,
    )
  })

  it('accepts the fixed-route x-subscription-token header', async () => {
    await controller.validate({
      headers: { 'x-subscription-token': 'header-token-sentinel' },
      params: {},
      body: { email: 'person@example.test' },
    } as unknown as Request)

    expect(authenticateToken.execute).toHaveBeenCalledWith({
      token: 'header-token-sentinel',
      userEmail: 'person@example.test',
    })
  })

  it('retains the legacy path token contract for retrocompatibility', async () => {
    await controller.validate({
      headers: {},
      params: { token: 'legacy-path-token' },
      body: { email: 'person@example.test' },
    } as unknown as Request)

    expect(authenticateToken.execute).toHaveBeenCalledWith({
      token: 'legacy-path-token',
      userEmail: 'person@example.test',
    })
  })

  it('rejects a missing credential without invoking authentication', async () => {
    const result = await controller.validate({
      headers: {},
      params: {},
      body: { email: 'person@example.test' },
    } as unknown as Request)

    expect(result.statusCode).toBe(401)
    expect(authenticateToken.execute).not.toHaveBeenCalled()
  })
})
