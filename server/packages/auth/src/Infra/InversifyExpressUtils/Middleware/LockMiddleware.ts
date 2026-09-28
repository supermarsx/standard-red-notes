import { NextFunction, Request, Response } from 'express'
import { inject, injectable } from 'inversify'
import { BaseMiddleware } from 'inversify-express-utils'
import TYPES from '../../../Bootstrap/Types'
import { LoginLockGuard } from '../../../Domain/User/LoginLockGuard'
import { resolveLoginLockRequest, sleepSeconds } from './LoginLockRequest'

/**
 * Standard Red Notes: the Express arm of failed-login lockout enforcement.
 *
 * The decision itself lives in LoginLockGuard, which the sign-in controller also
 * consults — middleware is NOT on every path. Under the DirectCall
 * (single-container) topology the gateway calls Service.handleRequest, which
 * invokes the registered controller method directly and runs no middleware at
 * all, so enforcement kept only here would be absent on that topology entirely.
 *
 * On the way through, this marks `response.locals` so the controller does not
 * evaluate the guard a second time and stall the request twice.
 */
@injectable()
export class LockMiddleware extends BaseMiddleware {
  constructor(@inject(TYPES.Auth_LoginLockGuard) private loginLockGuard: LoginLockGuard) {
    super()
  }

  async handler(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const decision = await this.loginLockGuard.evaluate(resolveLoginLockRequest(request))

      if (response.locals !== undefined) {
        ;(response.locals as Record<string, unknown>).loginLockEvaluated = true
      }

      // The delay applies to refusals and to every exemption alike: an exemption
      // buys an attacker patience, never speed.
      await sleepSeconds(decision.delaySeconds)

      if (!decision.allowed) {
        response.status(423).send({
          error: {
            message: 'Too many successive login requests. Please try your request again later.',
          },
        })

        return
      }

      return next()
    } catch (error) {
      return next(error)
    }
  }
}
