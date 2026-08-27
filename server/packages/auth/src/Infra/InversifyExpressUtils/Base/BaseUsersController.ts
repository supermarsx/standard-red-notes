import { ControllerContainerInterface, Username } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { BaseHttpController, results } from 'inversify-express-utils'

import { ChangeCredentials } from '../../../Domain/UseCase/ChangeCredentials/ChangeCredentials'
import { ClearLoginAttempts } from '../../../Domain/UseCase/ClearLoginAttempts'
import { DeleteAccount } from '../../../Domain/UseCase/DeleteAccount/DeleteAccount'
import { GetUserSubscription } from '../../../Domain/UseCase/GetUserSubscription/GetUserSubscription'
import { IncreaseLoginAttempts } from '../../../Domain/UseCase/IncreaseLoginAttempts'
import { ErrorTag } from '@standardnotes/responses'
import { ResponseLocals } from '../ResponseLocals'
import { CookieFactoryInterface } from '../../../Domain/Auth/Cookies/CookieFactoryInterface'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { auditActorUuid, auditClientIp } from './auditRequestAttribution'

export class BaseUsersController extends BaseHttpController {
  constructor(
    protected doDeleteAccount: DeleteAccount,
    protected doGetUserSubscription: GetUserSubscription,
    protected clearLoginAttempts: ClearLoginAttempts,
    protected increaseLoginAttempts: IncreaseLoginAttempts,
    protected changeCredentialsUseCase: ChangeCredentials,
    protected cookieFactory: CookieFactoryInterface,
    // Standard Red Notes: optional so an older wiring that omits it still boots;
    // when present, credential changes and self-serve account deletion are
    // recorded on the same audit path the admin surface already uses.
    protected auditLogWriter?: AuditLogWriterInterface,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.users.getSubscription', this.getSubscription.bind(this))
      this.controllerContainer.register('auth.users.updateCredentials', this.changeCredentials.bind(this))
      this.controllerContainer.register('auth.users.delete', this.deleteAccount.bind(this))
    }
  }

  async deleteAccount(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    if (locals.readOnlyAccess) {
      return this.json(
        {
          error: {
            tag: ErrorTag.ReadOnlyAccess,
            message: 'Session has read-only access.',
          },
        },
        401,
      )
    }

    if (request.params.userUuid !== locals.user.uuid) {
      return this.json(
        {
          error: {
            message: 'Operation not allowed.',
          },
        },
        401,
      )
    }

    const result = await this.doDeleteAccount.execute({
      userUuid: request.params.userUuid as string,
      serverPassword: request.headers['x-server-password'] as string | undefined,
      authTokenVersion: locals.authTokenVersion,
      shouldVerifyUserServerPassword: true,
    })

    if (result.isFailed()) {
      return this.json(
        {
          error: {
            message: result.getError(),
          },
        },
        400,
      )
    }

    // Standard Red Notes: the user erasing their own account is the most
    // destructive thing they can do to it. The admin path already records
    // AccountDeleted; `selfInitiated` distinguishes the two in the log.
    await this.auditLogWriter?.write({
      actorUuid: locals.user.uuid,
      action: AuditAction.AccountDeleted,
      targetType: 'user',
      targetUuid: request.params.userUuid as string,
      ip: auditClientIp(request),
      metadata: { selfInitiated: true },
    })

    return this.json({ message: result.getValue() }, 200)
  }

  async getSubscription(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    if (request.params.userUuid !== locals.user.uuid) {
      return this.json(
        {
          error: {
            message: 'Operation not allowed.',
          },
        },
        401,
      )
    }

    const result = await this.doGetUserSubscription.execute({
      userUuid: request.params.userUuid as string,
    })

    if (result.success) {
      return this.json(result)
    }

    return this.json(result, 400)
  }

  async changeCredentials(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    if (locals.readOnlyAccess) {
      return this.json(
        {
          error: {
            tag: ErrorTag.ReadOnlyAccess,
            message: 'Session has read-only access.',
          },
        },
        401,
      )
    }

    if (!request.body.current_password) {
      return this.json(
        {
          error: {
            message:
              'Your current password is required to change your password. Please update your application if you do not see this option.',
          },
        },
        400,
      )
    }

    if (!request.body.new_password) {
      return this.json(
        {
          error: {
            message: 'Your new password is required to change your password. Please try again.',
          },
        },
        400,
      )
    }

    if (!request.body.pw_nonce) {
      return this.json(
        {
          error: {
            message: 'The change password request is missing new auth parameters. Please try again.',
          },
        },
        400,
      )
    }
    const usernameOrError = Username.create(locals.user.email, { skipValidation: true })
    if (usernameOrError.isFailed()) {
      return this.json(
        {
          error: {
            message: 'Invalid username.',
          },
        },
        400,
      )
    }
    const username = usernameOrError.getValue()

    const changeCredentialsResult = await this.changeCredentialsUseCase.execute({
      userUuid: locals.user.uuid,
      username,
      apiVersion: request.body.api,
      currentPassword: request.body.current_password,
      newPassword: request.body.new_password,
      newEmail: request.body.new_email,
      pwNonce: request.body.pw_nonce,
      kpCreated: request.body.created,
      kpOrigination: request.body.origination,
      updatedWithUserAgent: request.headers['user-agent'] as string,
      protocolVersion: request.body.version,
      snjs: request.headers['x-snjs-version'] as string,
      application: request.headers['x-application-version'] as string,
    })

    // What the request ASKED to change, recorded whether or not it succeeded.
    // Derived from the request shape only — never from the submitted values, so
    // no password, nonce or address can reach the log.
    const requestedChange = {
      passwordChanged: true,
      emailChanged: typeof request.body.new_email === 'string' && request.body.new_email.length > 0,
    }

    if (changeCredentialsResult.isFailed()) {
      await this.increaseLoginAttempts.execute({ email: locals.user.email })

      // A rejected credential change on a live session is a stronger signal than
      // a successful one: it means the session holder could not produce the
      // account's current password.
      await this.auditLogWriter?.write({
        actorUuid: auditActorUuid(response),
        action: AuditAction.CredentialsChangeFailed,
        targetType: 'user',
        targetUuid: locals.user.uuid,
        ip: auditClientIp(request),
        metadata: requestedChange,
      })

      return this.json(
        {
          error: {
            message: changeCredentialsResult.getError(),
          },
        },
        401,
      )
    }

    await this.clearLoginAttempts.execute({ email: locals.user.email })

    await this.auditLogWriter?.write({
      actorUuid: auditActorUuid(response),
      action: AuditAction.CredentialsChanged,
      targetType: 'user',
      targetUuid: locals.user.uuid,
      ip: auditClientIp(request),
      // WHICH credentials changed, never what they changed to.
      metadata: requestedChange,
    })

    const changeCredentialsResultValue = changeCredentialsResult.getValue()
    const session = changeCredentialsResultValue.session

    response.setHeader('x-invalidate-cache', locals.user.uuid)
    if (session) {
      response.setHeader(
        'Set-Cookie',
        this.cookieFactory.createCookieHeaderValue({
          sessionUuid: session.uuid,
          accessToken: changeCredentialsResultValue.cookies?.accessToken as string,
          refreshToken: changeCredentialsResultValue.cookies?.refreshToken as string,
          refreshTokenExpiration: session.refreshExpiration,
        }),
      )
      return this.json({
        session: changeCredentialsResultValue.response?.sessionBody,
        key_params: changeCredentialsResultValue.response?.keyParams,
        user: changeCredentialsResultValue.response?.user,
      })
    }

    return this.json(changeCredentialsResultValue.legacyResponse)
  }
}
