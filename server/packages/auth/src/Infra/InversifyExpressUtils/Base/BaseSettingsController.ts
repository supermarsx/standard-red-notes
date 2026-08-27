import { ControllerContainerInterface, MapperInterface, SettingName } from '@standardnotes/domain-core'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ErrorTag } from '@standardnotes/responses'
import { Request, Response } from 'express'
import { Logger } from 'winston'

import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetSetting } from '../../../Domain/UseCase/GetSetting/GetSetting'
import { GetAllSettingsForUser } from '../../../Domain/UseCase/GetAllSettingsForUser/GetAllSettingsForUser'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { GetMfaSecret } from '../../../Domain/UseCase/GetMfaSecret/GetMfaSecret'
import { ValidateMfaToken } from '../../../Domain/UseCase/ValidateMfaToken/ValidateMfaToken'
import { Setting } from '../../../Domain/Setting/Setting'
import { SubscriptionSetting } from '../../../Domain/Setting/SubscriptionSetting'
import { SubscriptionSettingHttpRepresentation } from '../../../Mapping/Http/SubscriptionSettingHttpRepresentation'
import { SettingHttpRepresentation } from '../../../Mapping/Http/SettingHttpRepresentation'
import { TriggerPostSettingUpdateActions } from '../../../Domain/UseCase/TriggerPostSettingUpdateActions/TriggerPostSettingUpdateActions'
import { ResponseLocals } from '../ResponseLocals'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { SettingsAssociationServiceInterface } from '../../../Domain/Setting/SettingsAssociationServiceInterface'
import { auditActorUuid, auditClientIp } from './auditRequestAttribution'

export class BaseSettingsController extends BaseHttpController {
  constructor(
    protected doGetSettings: GetAllSettingsForUser,
    protected doGetSetting: GetSetting,
    protected setSettingValue: SetSettingValue,
    protected triggerPostSettingUpdateActions: TriggerPostSettingUpdateActions,
    protected doDeleteSetting: DeleteSetting,
    protected doGetMfaSecret: GetMfaSecret,
    protected validateMfaToken: ValidateMfaToken,
    protected settingHttMapper: MapperInterface<Setting, SettingHttpRepresentation>,
    protected subscriptionSettingHttpMapper: MapperInterface<
      SubscriptionSetting,
      SubscriptionSettingHttpRepresentation
    >,
    protected logger: Logger,
    // Standard Red Notes: optional so an older wiring that omits them still
    // boots. When present, a user changing one of their OWN SENSITIVE settings
    // is recorded on the same audit path the admin write path already uses.
    protected auditLogWriter?: AuditLogWriterInterface,
    protected settingsAssociationService?: SettingsAssociationServiceInterface,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.users.getSettings', this.getSettings.bind(this))
      this.controllerContainer.register('auth.users.getSetting', this.getSetting.bind(this))
      this.controllerContainer.register('auth.users.updateSetting', this.updateSetting.bind(this))
      this.controllerContainer.register('auth.users.deleteSetting', this.deleteSetting.bind(this))
      this.controllerContainer.register('auth.users.getMfaSecret', this.getMfaSecret.bind(this))
    }
  }

  async getSettings(request: Request, response: Response): Promise<results.JsonResult> {
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

    const { userUuid } = request.params as Record<string, string>
    const result = await this.doGetSettings.execute({ userUuid })
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
    const settingsAndSubscriptionSettings = result.getValue()

    const settingsHttpRepresentation = settingsAndSubscriptionSettings.settings.map((settingAndValue) => ({
      ...this.settingHttMapper.toProjection(settingAndValue.setting),
      value: settingAndValue.decryptedValue,
    }))

    const subscriptionSettingsHttpRepresentation = settingsAndSubscriptionSettings.subscriptionSettings.map(
      (settingAndValue) => ({
        ...this.subscriptionSettingHttpMapper.toProjection(settingAndValue.setting),
        value: settingAndValue.decryptedValue,
      }),
    )

    const httpRepresentation = settingsHttpRepresentation.concat(subscriptionSettingsHttpRepresentation)

    return this.json({
      success: true,
      settings: httpRepresentation,
    })
  }

  async getSetting(request: Request, response: Response): Promise<results.JsonResult> {
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

    const { userUuid, settingName } = request.params as Record<string, string>
    if (settingName.toUpperCase() === SettingName.NAMES.NextcloudBackupDeliveryState) {
      return this.json(
        {
          error: {
            message: 'Operation not allowed.',
          },
        },
        401,
      )
    }
    const serverPassword = request.headers['x-server-password'] as string | undefined
    const resultOrError = await this.doGetSetting.execute({
      allowSensitiveRetrieval: true,
      userUuid,
      decrypted: true,
      settingName: settingName.toUpperCase(),
      serverPassword,
      authTokenVersion: locals.authTokenVersion,
      shouldVerifyUserServerPassword: true,
    })
    if (resultOrError.isFailed()) {
      // Standard Red Notes: reading an optional, unset setting is a normal case
      // (e.g. the Conflicts / Search panes read admin-provided client defaults
      // that most accounts never have set). Treat "not found" as an empty 200 so
      // clients can fall back to their own default without the request showing up
      // as a console-spamming 400. Genuine errors (invalid name, sensitivity,
      // subscription-only, password) still return 400.
      const errorMessage = resultOrError.getError()
      if (errorMessage.includes('not found')) {
        return this.json({
          success: true,
        })
      }

      return this.json(
        {
          error: {
            message: errorMessage,
          },
        },
        400,
      )
    }

    const settingAndValue = resultOrError.getValue()

    if (settingAndValue.setting.props.sensitive) {
      return this.json({
        success: true,
      })
    }

    const settingHttpReprepesentation = {
      ...this.settingHttMapper.toProjection(settingAndValue.setting),
      value: settingAndValue.decryptedValue,
    }

    return this.json({
      success: true,
      setting: settingHttpReprepesentation,
    })
  }

  async updateSetting(request: Request, response: Response): Promise<results.JsonResult | results.StatusCodeResult> {
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

    const { name, value, totpToken } = request.body

    if (typeof name === 'string' && name.toUpperCase() === SettingName.NAMES.NextcloudBackupDeliveryState) {
      return this.json(
        {
          error: {
            message: 'Operation not allowed.',
          },
        },
        401,
      )
    }

    if (name === SettingName.NAMES.MfaSecret) {
      const validationResult = await this.validateMfaToken.execute({
        userUuid: locals.user.uuid,
        totpToken,
        authTokenVersion: locals.authTokenVersion,
      })

      if (validationResult.isFailed()) {
        // A rejected 2FA change is a stronger security signal than an accepted
        // one — the session holder could not produce a valid current token. The
        // rejected token itself is never recorded.
        await this.auditLogWriter?.write({
          actorUuid: auditActorUuid(response),
          action: AuditAction.MfaChangeFailed,
          targetType: 'user',
          targetUuid: locals.user.uuid,
          ip: auditClientIp(request),
          metadata: { name: SettingName.NAMES.MfaSecret, enabling: true },
        })

        return this.json(
          {
            error: {
              message: validationResult.getError(),
            },
          },
          400,
        )
      }
    }

    const result = await this.setSettingValue.execute({
      settingName: name,
      value,
      userUuid: locals.user.uuid,
      checkUserPermissions: true,
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
    const setting = result.getValue()

    await this.auditSensitiveSettingChange({
      request,
      response,
      userUuid: locals.user.uuid,
      settingName: setting.props.name,
      // SetSettingValue has already classified this write, so trust its verdict
      // rather than re-deriving it.
      sensitive: setting.props.sensitive,
      deleted: false,
    })

    const triggerResult = await this.triggerPostSettingUpdateActions.execute({
      updatedSettingName: setting.props.name,
      userUuid: locals.user.uuid,
      userEmail: locals.user.email,
      unencryptedValue: value,
    })
    if (triggerResult.isFailed()) {
      this.logger.error('Failed to trigger post-setting-update actions.')
    }

    // Settings projected into cross-service tokens (including CalDAV, AI,
    // workflows, and OCR) must take effect on the very next gateway request.
    // Both HTTP and gRPC gateway proxies consume this header synchronously.
    response.setHeader('x-invalidate-cache', locals.user.uuid)

    return this.json({
      success: true,
      setting: setting.props.sensitive ? undefined : this.settingHttMapper.toProjection(setting),
    })
  }

  async deleteSetting(request: Request, response: Response): Promise<results.JsonResult> {
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

    const { userUuid, settingName } = request.params as Record<string, string>
    if (settingName.toUpperCase() === SettingName.NAMES.NextcloudBackupDeliveryState) {
      return this.json(
        {
          error: {
            message: 'Operation not allowed.',
          },
        },
        401,
      )
    }
    const serverPassword = request.headers['x-server-password'] as string | undefined

    const result = await this.doDeleteSetting.execute({
      userUuid,
      settingName,
      serverPassword,
      authTokenVersion: locals.authTokenVersion,
      shouldVerifyUserServerPassword: true,
      allowClientImmutable: false,
    })

    if (result.success) {
      await this.auditSensitiveSettingChange({
        request,
        response,
        userUuid: locals.user.uuid,
        settingName: settingName.toUpperCase(),
        sensitive: this.settingIsSensitive(settingName.toUpperCase()),
        deleted: true,
      })

      if (settingName.toUpperCase() === SettingName.NAMES.EmailRemindersEnabled) {
        const triggerResult = await this.triggerPostSettingUpdateActions.execute({
          updatedSettingName: SettingName.NAMES.EmailRemindersEnabled,
          userUuid: locals.user.uuid,
          userEmail: locals.user.email,
          unencryptedValue: null,
        })
        if (triggerResult.isFailed()) {
          this.logger.error('Failed to trigger post-setting-update actions.')
        }
      }
      response.setHeader('x-invalidate-cache', locals.user.uuid)
      return this.json(result)
    }

    return this.json(result, 400)
  }

  async getMfaSecret(request: Request, response: Response): Promise<results.JsonResult> {
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

    const userUuid = locals.user.uuid
    const result = await this.doGetMfaSecret.execute({ userUuid })

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

    return this.json({
      success: true,
      secret: result.getValue().secret,
    })
  }

  /**
   * Standard Red Notes: the server's own classification of a setting, used on
   * the delete path where the persisted row is already gone by the time we log.
   * Falls back to "not sensitive" when the association service is not wired or
   * the name is not a known setting — an unclassifiable name is never promoted
   * into the security log on a guess.
   */
  private settingIsSensitive(settingName: string): boolean {
    if (this.settingsAssociationService === undefined) {
      return false
    }

    const settingNameOrError = SettingName.create(settingName)
    if (settingNameOrError.isFailed()) {
      return false
    }

    return this.settingsAssociationService.getSensitivityForSetting(settingNameOrError.getValue())
  }

  /**
   * Standard Red Notes: record a user changing one of their OWN settings, but
   * only when that setting is SENSITIVE. Auditing every setting write would bury
   * the security log under routine preference churn; the sensitive ones (the
   * TOTP secret, backup credentials, extension keys) are the ones an attacker
   * would touch.
   *
   * Turning 2FA on or off is recorded under its own action rather than as a
   * generic setting change, because "MFA disabled" is the line a reader of this
   * log is actually scanning for.
   *
   * The VALUE is never passed to this method, so no secret can reach the log
   * even by accident — only the setting NAME.
   */
  private async auditSensitiveSettingChange(params: {
    request: Request
    response: Response
    userUuid: string
    settingName: string
    sensitive: boolean
    deleted: boolean
  }): Promise<void> {
    const isMfaSecret = params.settingName === SettingName.NAMES.MfaSecret

    if (!params.sensitive && !isMfaSecret) {
      return
    }

    const action = isMfaSecret
      ? params.deleted
        ? AuditAction.MfaDisabled
        : AuditAction.MfaEnabled
      : params.deleted
        ? AuditAction.SettingDeleted
        : AuditAction.SettingChanged

    await this.auditLogWriter?.write({
      actorUuid: auditActorUuid(params.response),
      action,
      targetType: 'setting',
      targetUuid: params.userUuid,
      ip: auditClientIp(params.request),
      metadata: { name: params.settingName, selfInitiated: true },
    })
  }
}
