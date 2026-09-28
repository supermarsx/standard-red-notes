import 'reflect-metadata'

import { NextFunction, Request, Response } from 'express'

import { LoginLockGuard } from '../../../Domain/User/LoginLockGuard'
import { LockMiddleware } from './LockMiddleware'

describe('LockMiddleware', () => {
  let loginLockGuard: LoginLockGuard
  let request: Request
  let response: Response
  let next: NextFunction

  const createMiddleware = () => new LockMiddleware(loginLockGuard)

  // jest.config sets resetMocks: true globally, so implementations are set here.
  beforeEach(() => {
    loginLockGuard = {
      evaluate: jest.fn().mockResolvedValue({ allowed: true, delaySeconds: 0, exemption: 'none', attempts: 0 }),
    } as unknown as jest.Mocked<LoginLockGuard>

    request = {
      body: { email: 'test@test.te' },
      headers: {},
      path: '/pkce_sign_in',
      originalUrl: '/auth/pkce_sign_in',
    } as unknown as Request

    response = { locals: {} } as unknown as Response
    response.status = jest.fn().mockReturnThis()
    response.send = jest.fn()
    next = jest.fn()
  })

  it('should return 423 when the guard refuses', async () => {
    loginLockGuard.evaluate = jest
      .fn()
      .mockResolvedValue({ allowed: false, delaySeconds: 0, exemption: 'none', attempts: 12 })

    await createMiddleware().handler(request, response, next)

    expect(response.status).toHaveBeenCalledWith(423)
    expect(next).not.toHaveBeenCalled()
  })

  it('should let the request pass when the guard allows', async () => {
    await createMiddleware().handler(request, response, next)

    expect(response.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  it('should pass the identifier, client address and route kind to the guard', async () => {
    request.headers['x-origin-ip'] = '203.0.113.9'

    await createMiddleware().handler(request, response, next)

    expect(loginLockGuard.evaluate).toHaveBeenCalledWith({
      identifier: 'test@test.te',
      clientIp: '203.0.113.9',
      isRecoveryRoute: false,
    })
  })

  it('should fall back to the username when no email is supplied', async () => {
    request.body = { username: 'test' }

    await createMiddleware().handler(request, response, next)

    expect(loginLockGuard.evaluate).toHaveBeenCalledWith(expect.objectContaining({ identifier: 'test' }))
  })

  it('should flag the recovery route so the guard can exempt it from hard refusal', async () => {
    request.path = '/recovery/login'
    request.originalUrl = '/auth/recovery/login'

    await createMiddleware().handler(request, response, next)

    expect(loginLockGuard.evaluate).toHaveBeenCalledWith(expect.objectContaining({ isRecoveryRoute: true }))
  })

  /**
   * The controller consults the same guard, because middleware does not run on
   * the DirectCall topology. Without this marker a request on the HTTP topology
   * would be evaluated twice and stalled for twice the back-off.
   */
  it('should mark the response so the controller does not evaluate a second time', async () => {
    await createMiddleware().handler(request, response, next)

    expect((response.locals as Record<string, unknown>).loginLockEvaluated).toEqual(true)
  })

  it('should pass the error to next middleware if one occurs', async () => {
    const error = new Error('Ooops')
    loginLockGuard.evaluate = jest.fn().mockRejectedValue(error)

    await createMiddleware().handler(request, response, next)

    expect(response.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(error)
  })

  /**
   * The delay is the load-bearing anti-brute-force mitigation, and it must apply
   * to a refusal as well as to a pass — otherwise a refused attacker discovers
   * they are locked out faster than a legitimate user discovers they are not.
   */
  it('should stall for the delay the guard returned, on both outcomes', async () => {
    jest.useFakeTimers()
    try {
      for (const allowed of [true, false]) {
        loginLockGuard.evaluate = jest
          .fn()
          .mockResolvedValue({ allowed, delaySeconds: 4, exemption: 'none', attempts: 9 })
        next = jest.fn()
        response.status = jest.fn().mockReturnThis()

        let settled = false
        const handled = createMiddleware()
          .handler(request, response, next)
          .then(() => {
            settled = true
          })

        // Let the guard's promise resolve without advancing the clock.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        expect(settled).toEqual(false)

        jest.advanceTimersByTime(4000)
        await handled
        expect(settled).toEqual(true)
      }
    } finally {
      jest.useRealTimers()
    }
  })
})
