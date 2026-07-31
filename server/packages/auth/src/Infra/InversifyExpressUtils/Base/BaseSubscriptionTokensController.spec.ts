import { Request } from 'express'

import { AuthenticateSubscriptionToken } from '../../../Domain/UseCase/AuthenticateSubscriptionToken/AuthenticateSubscriptionToken'
import { BaseSubscriptionTokensController } from './BaseSubscriptionTokensController'

describe('BaseSubscriptionTokensController token transport', () => {
  let authenticateToken: jest.Mocked<Pick<AuthenticateSubscriptionToken, 'execute'>>
  let controller: BaseSubscriptionTokensController

  beforeEach(() => {
    authenticateToken = {
      execute: jest.fn().mockResolvedValue({ success: false }),
    }
    controller = new BaseSubscriptionTokensController(
      {} as never,
      authenticateToken as unknown as AuthenticateSubscriptionToken,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      60,
    )
  })

  it('accepts the fixed-route x-subscription-token header', async () => {
    await controller.validate({
      headers: { 'x-subscription-token': 'header-token-sentinel' },
      params: {},
    } as unknown as Request)

    expect(authenticateToken.execute).toHaveBeenCalledWith({ token: 'header-token-sentinel' })
  })

  it('retains the legacy path token contract for retrocompatibility', async () => {
    await controller.validate({
      headers: {},
      params: { token: 'legacy-path-token' },
    } as unknown as Request)

    expect(authenticateToken.execute).toHaveBeenCalledWith({ token: 'legacy-path-token' })
  })

  it('prefers the fixed-route header and rejects a missing credential without invoking authentication', async () => {
    await controller.validate({
      headers: { 'x-subscription-token': 'header-token' },
      params: { token: 'legacy-path-token' },
    } as unknown as Request)
    expect(authenticateToken.execute).toHaveBeenCalledWith({ token: 'header-token' })

    authenticateToken.execute.mockClear()
    const result = await controller.validate({ headers: {}, params: {} } as unknown as Request)

    expect(result.statusCode).toBe(401)
    expect(authenticateToken.execute).not.toHaveBeenCalled()
  })
})
