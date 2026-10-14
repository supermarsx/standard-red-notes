import { ControllerContainerInterface, RoleName } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { AuthenticateRequest } from '../../../Domain/UseCase/AuthenticateRequest'
import { CreateCrossServiceToken } from '../../../Domain/UseCase/CreateCrossServiceToken/CreateCrossServiceToken'
import { GetActiveSessionsForUser } from '../../../Domain/UseCase/GetActiveSessionsForUser'
import { CustomProjectorInterface } from '../../../Projection/ProjectorInterface'
import { Session } from '../../../Domain/Session/Session'
import { BaseHttpController, results } from 'inversify-express-utils'
import { User } from '../../../Domain/User/User'
import { SessionProjector } from '../../../Projection/SessionProjector'
import { AdminMfaService } from '../../../Domain/Session/AdminMfaService'
import { SessionActivityService, SESSION_DEVICE_ID } from '../../../Domain/Session/SessionActivityService'
import { ResponseLocals } from '../ResponseLocals'

export class BaseSessionsController extends BaseHttpController {
  constructor(
    protected getActiveSessionsForUser: GetActiveSessionsForUser,
    protected authenticateRequest: AuthenticateRequest,
    protected sessionProjector: CustomProjectorInterface<Session>,
    protected createCrossServiceToken: CreateCrossServiceToken,
    private controllerContainer?: ControllerContainerInterface,
    protected activity?: SessionActivityService,
    protected adminMfa?: AdminMfaService,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.sessions.list', this.getSessions.bind(this))
      this.controllerContainer.register('auth.sessions.activity', this.recordActivity.bind(this))
      this.controllerContainer.register('admin.sessions.list', this.getUserSessions.bind(this))
      this.controllerContainer.register('admin.mfa.status', this.getUserMfaStatus.bind(this))
      this.controllerContainer.register('admin.mfa.resetAll', this.resetUserMfa.bind(this))
      this.controllerContainer.register('auth.sessions.validate', this.validate.bind(this))
    }
  }

  async validate(request: Request): Promise<results.JsonResult> {
    const authCookies = new Map<string, string[]>()
    request.headers.cookie?.split(';').forEach((cookie) => {
      const parts = cookie.split('=')
      if (parts.length === 2 && parts[0].trim().startsWith('access_token_')) {
        const existingCookies = authCookies.get(parts[0].trim())
        if (existingCookies) {
          existingCookies.push(parts[1].trim())
          authCookies.set(parts[0].trim(), existingCookies)
        } else {
          authCookies.set(parts[0].trim(), [parts[1].trim()])
        }
      }
    })

    const authenticateRequestResponse = await this.authenticateRequest.execute({
      authTokenFromHeaders: request.body.authTokenFromHeaders,
      authCookies,
      requestMetadata: {
        snjs: request.headers['x-snjs-version'] as string,
        application: request.headers['x-application-version'] as string,
        url: request.headers['x-origin-url'] as string,
        method: request.headers['x-origin-method'] as string,
        userAgent: request.headers['x-origin-user-agent'] as string,
        secChUa: request.headers['x-origin-sec-ch-ua'] as string,
      },
    })

    if (!authenticateRequestResponse.success) {
      return this.json(
        {
          error: {
            tag: authenticateRequestResponse.errorTag,
            message: authenticateRequestResponse.errorMessage,
          },
        },
        authenticateRequestResponse.responseCode,
      )
    }

    const user = authenticateRequestResponse.user as User

    const sharedVaultOwnerContext = request.body.sharedVaultOwnerContext as string | undefined

    const resultOrError = await this.createCrossServiceToken.execute({
      user,
      session: authenticateRequestResponse.session,
      sharedVaultOwnerContext,
      applicationVersion: request.headers['x-application-version'] as string,
    })
    if (resultOrError.isFailed()) {
      return this.json(
        {
          error: {
            message: resultOrError.getError(),
          },
        },
        resultOrError.getError() === 'Could not verify shared-vault memberships' ? 503 : 400,
      )
    }

    return this.json({ authToken: resultOrError.getValue() })
  }

  async getUserMfaStatus(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    if (!locals.roles?.some((role) => role.name === RoleName.NAMES.AdminUser)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (!this.adminMfa) {
      return this.json({ error: { message: 'MFA status unavailable.' } }, 503)
    }
    const status = await this.adminMfa.status(request.params.userUuid as string)
    return status ? this.json(status) : this.json({ error: { message: 'Account not found.' } }, 404)
  }

  async resetUserMfa(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    if (!locals.roles?.some((role) => role.name === RoleName.NAMES.AdminUser)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (locals.readOnlyAccess || locals.session?.readonly_access) {
      return this.json({ error: { message: 'Writable admin session required.' } }, 403)
    }
    const userUuid = request.params.userUuid as string
    if (request.body?.intent !== 'reset_all_factors' || request.body?.userUuid !== userUuid) {
      return this.json({ error: { message: 'Explicit target-bound reset intent required.' } }, 400)
    }
    if (!this.adminMfa) {
      return this.json({ error: { message: 'MFA reset unavailable.' } }, 503)
    }
    try {
      const status = await this.adminMfa.reset(userUuid, locals.user.uuid, request.ip)
      return status
        ? this.json({ success: true, userUuid, scope: 'all_factors', status })
        : this.json({ error: { message: 'Account not found.' } }, 404)
    } catch {
      return this.json(
        { error: { message: 'MFA reset could not be completed. Retry after checking account status.' } },
        503,
      )
    }
  }

  async recordActivity(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    const deviceId = request.body?.device_id
    if (typeof deviceId !== 'string' || !SESSION_DEVICE_ID.test(deviceId)) {
      return this.json({ error: { message: 'Invalid device identifier.' } }, 400)
    }
    if (!locals.session?.uuid) {
      return this.json({ error: { message: 'Authenticated session required.' } }, 401)
    }
    if (!this.activity) {
      return this.json({ error: { message: 'Session activity unavailable.' } }, 503)
    }
    const result = await this.activity.record(locals.user.uuid, locals.session.uuid, deviceId)
    return result ? this.json(result) : this.json({ error: { message: 'Session is no longer open.' } }, 401)
  }

  async getUserSessions(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    if (!locals.roles?.some((role) => role.name === RoleName.NAMES.AdminUser)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (typeof request.params.userUuid !== 'string' || !request.params.userUuid) {
      return this.json({ error: { message: 'Target account required.' } }, 400)
    }
    if (!this.activity) {
      return this.json({ error: { message: 'Session activity unavailable.' } }, 503)
    }
    return this.json(await this.activity.list(request.params.userUuid as string, locals.session?.uuid))
  }

  async getSessions(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    if (locals.readOnlyAccess) {
      return this.json([])
    }

    if (this.activity) {
      return this.json(await this.activity.list(locals.user.uuid, locals.session?.uuid))
    }

    const useCaseResponse = await this.getActiveSessionsForUser.execute({
      userUuid: locals.user.uuid,
    })

    return this.json(
      useCaseResponse.sessions.map((session) =>
        this.sessionProjector.projectCustom(
          SessionProjector.CURRENT_SESSION_PROJECTION.toString(),
          session,
          locals.session,
        ),
      ),
    )
  }
}
