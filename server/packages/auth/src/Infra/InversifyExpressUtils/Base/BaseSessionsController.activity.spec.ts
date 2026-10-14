import 'reflect-metadata'
import { Request, Response } from 'express'
import { BaseSessionsController } from './BaseSessionsController'

describe('session activity and admin boundaries', () => {
  const build = () => {
    const activity = { record: jest.fn().mockResolvedValue({ active: true }), list: jest.fn().mockResolvedValue([]) }
    const mfa = {
      status: jest.fn().mockResolvedValue({ totpConfigured: false }),
      reset: jest.fn().mockResolvedValue({ totpConfigured: false }),
    }
    return {
      activity,
      mfa,
      controller: new BaseSessionsController(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        activity as never,
        mfa as never,
      ),
    }
  }
  const response = (admin = false) =>
    ({
      locals: {
        user: { uuid: 'own-user' },
        session: { uuid: 'own-session' },
        roles: admin ? [{ name: 'ADMIN_USER' }] : [],
      },
    }) as unknown as Response
  it('derives identity from authenticated locals, rejects unsafe device ids and never trusts body identities/time', async () => {
    const { controller, activity } = build()
    await controller.recordActivity(
      {
        body: { device_id: 'profile-a', userUuid: 'victim', sessionUuid: 'victim-session', last_seen_at: 'tomorrow' },
      } as Request,
      response(),
    )
    expect(activity.record).toHaveBeenCalledWith('own-user', 'own-session', 'profile-a')
    expect(
      (await controller.recordActivity({ body: { device_id: '../escape' } } as Request, response())).statusCode,
    ).toBe(400)
    expect(activity.record).toHaveBeenCalledTimes(1)
  })
  it('refuses all-factor resets from readonly admin credentials', async () => {
    const { controller, mfa } = build()
    const request = {
      params: { userUuid: 'target' },
      body: { intent: 'reset_all_factors', userUuid: 'target' },
    } as unknown as Request
    const readOnly = response(true)
    readOnly.locals.readOnlyAccess = true
    expect((await controller.resetUserMfa(request, readOnly)).statusCode).toBe(403)
    expect(mfa.reset).not.toHaveBeenCalled()
  })
  it('rejects missing admin session-list targets before querying account activity', async () => {
    const { controller, activity } = build()
    expect((await controller.getUserSessions({ params: {} } as Request, response(true))).statusCode).toBe(400)
    expect(activity.list).not.toHaveBeenCalled()
  })

  it('refuses non-admin session/status/reset reads and missing or mismatched reset intent before mutation', async () => {
    const { controller, activity, mfa } = build()
    const request = { params: { userUuid: 'target' }, body: {} } as unknown as Request
    expect((await controller.getUserSessions(request, response())).statusCode).toBe(403)
    expect((await controller.getUserMfaStatus(request, response())).statusCode).toBe(403)
    expect((await controller.resetUserMfa(request, response())).statusCode).toBe(403)
    expect((await controller.resetUserMfa(request, response(true))).statusCode).toBe(400)
    request.body = { intent: 'reset_all_factors', userUuid: 'wrong' }
    expect((await controller.resetUserMfa(request, response(true))).statusCode).toBe(400)
    expect(activity.list).not.toHaveBeenCalled()
    expect(mfa.reset).not.toHaveBeenCalled()
    request.body = { intent: 'reset_all_factors', userUuid: 'target' }
    expect((await controller.resetUserMfa(request, response(true))).statusCode).toBe(200)
    expect(mfa.reset).toHaveBeenCalledWith('target', 'own-user', undefined)
  })
})
