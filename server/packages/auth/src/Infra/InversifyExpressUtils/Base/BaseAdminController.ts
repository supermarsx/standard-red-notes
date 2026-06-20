import { ControllerContainerInterface, RoleName, SettingName, Username } from '@standardnotes/domain-core'
import { BaseHttpController, results } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { Role } from '@standardnotes/security'

import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { GetSetting } from './../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { EmailBackupFrequency, ListedAuthorSecretsData } from '@standardnotes/settings'

/**
 * Standard Red Notes: settings an admin (INTERNAL_TEAM_USER) is allowed to set
 * on behalf of another user via the admin panel. Keep this allow-list tight so
 * the admin endpoints can never be used to mutate arbitrary/sensitive settings.
 */
const ADMIN_MANAGEABLE_SETTINGS: string[] = [
  SettingName.NAMES.AiEnabled,
  SettingName.NAMES.AiRequestLimit,
  // Standard Red Notes: admin override of a user's scheduled email-backup cadence.
  // Reuses the same get/set feature-flag endpoints; value is validated below.
  SettingName.NAMES.EmailBackupFrequency,
  // Standard Red Notes: admin view/override of a user's per-account email-reminder
  // opt-in ('true' to allow emailing reminders that the user opts into; anything
  // else disables). Reuses the same get/set feature-flag endpoints.
  SettingName.NAMES.EmailRemindersEnabled,
]

/**
 * Standard Red Notes: per-setting value validators for admin-managed settings.
 * Only settings with stricter-than-free-form constraints need an entry.
 */
const VALID_EMAIL_BACKUP_FREQUENCIES: string[] = Object.values(EmailBackupFrequency)

export class BaseAdminController extends BaseHttpController {
  constructor(
    protected doDeleteSetting: DeleteSetting,
    protected doGetSetting: GetSetting,
    protected userRepository: UserRepositoryInterface,
    protected createSubscriptionToken: CreateSubscriptionToken,
    protected createOfflineSubscriptionToken: CreateOfflineSubscriptionToken,
    protected setSettingValue: SetSettingValue,
    protected setUserBanStatus: SetUserBanStatus,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('admin.getUser', this.getUser.bind(this))
      this.controllerContainer.register('admin.deleteMFASetting', this.deleteMFASetting.bind(this))
      this.controllerContainer.register('admin.createToken', this.createToken.bind(this))
      this.controllerContainer.register('admin.createOfflineToken', this.createOfflineToken.bind(this))
      this.controllerContainer.register('admin.disableEmailBackups', this.disableEmailBackups.bind(this))
      this.controllerContainer.register('admin.lookupUser', this.lookupUser.bind(this))
      this.controllerContainer.register('admin.getUserFeatureFlags', this.getUserFeatureFlags.bind(this))
      this.controllerContainer.register('admin.setUserFeatureFlag', this.setUserFeatureFlag.bind(this))
      this.controllerContainer.register('admin.getRegistrationFlag', this.getRegistrationFlag.bind(this))
      this.controllerContainer.register('admin.setRegistrationFlag', this.setRegistrationFlag.bind(this))
      this.controllerContainer.register('admin.getUserBanStatus', this.getUserBanStatus.bind(this))
      this.controllerContainer.register('admin.setUserBanStatus', this.setUserBanStatusEndpoint.bind(this))
    }
  }

  /**
   * Standard Red Notes: enforce the INTERNAL_TEAM_USER role for admin-only
   * endpoints. The api-gateway AuthMiddleware decodes the cross-service token and
   * places the roles (by name) on `response.locals.roles`, which is forwarded to
   * this controller both over HTTP and in the home-server DirectCall path.
   */
  protected requestorIsAdmin(response?: Response): boolean {
    const roles = ((response?.locals as { roles?: Role[] } | undefined)?.roles ?? []) as Role[]

    return roles.some((role) => role.name === RoleName.NAMES.InternalTeamUser)
  }

  async getUser(request: Request): Promise<results.JsonResult> {
    const usernameOrError = Username.create((request.params.email as string) ?? '', { skipValidation: true })
    if (usernameOrError.isFailed()) {
      return this.json(
        {
          error: {
            message: 'Missing email parameter.',
          },
        },
        400,
      )
    }
    const username = usernameOrError.getValue()

    const user = await this.userRepository.findOneByUsernameOrEmail(username)

    if (!user) {
      return this.json(
        {
          error: {
            message: `No user with email '${username.value}'.`,
          },
        },
        400,
      )
    }

    return this.json({
      uuid: user.uuid,
    })
  }

  async deleteMFASetting(request: Request): Promise<results.JsonResult> {
    const { userUuid } = request.params as Record<string, string>
    const { uuid, updatedAt } = request.body

    const result = await this.doDeleteSetting.execute({
      uuid,
      userUuid,
      settingName: SettingName.NAMES.MfaSecret,
      timestamp: updatedAt,
      softDelete: true,
    })

    if (result.success) {
      return this.json(result)
    }

    return this.json(result, 400)
  }

  async getListedCode(request: Request): Promise<results.JsonResult> {
    const { userUuid } = request.params as Record<string, string>

    const result = await this.doGetSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.ListedAuthorSecrets,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })

    if (result.isFailed()) {
      return this.json('No listed code found', 404)
    }

    const decryptedValue = result.getValue().decryptedValue

    if (!decryptedValue) {
      return this.json({ error: 'No listed code found' }, 404)
    }

    const data: ListedAuthorSecretsData = JSON.parse(decryptedValue as string)

    return this.json(data)
  }

  async createToken(request: Request): Promise<results.JsonResult> {
    const { userUuid } = request.params as Record<string, string>
    const result = await this.createSubscriptionToken.execute({
      userUuid,
    })

    return this.json({
      token: result.subscriptionToken.token,
    })
  }

  async createOfflineToken(request: Request): Promise<results.JsonResult | results.BadRequestResult> {
    const { email } = request.params as Record<string, string>
    const result = await this.createOfflineSubscriptionToken.execute({
      userEmail: email,
    })

    if (!result.success) {
      return this.badRequest()
    }

    return this.json({
      token: result.offlineSubscriptionToken.token,
    })
  }

  async disableEmailBackups(request: Request): Promise<results.BadRequestErrorMessageResult | results.OkResult> {
    const { userUuid } = request.params as Record<string, string>

    const result = await this.doDeleteSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.EmailBackupFrequency,
    })

    if (result.success) {
      return this.ok()
    }

    return this.badRequest('No email backups found')
  }

  /**
   * Standard Red Notes: admin-gated user lookup by email used by the in-app
   * admin panel. Unlike the internal `getUser`, this enforces the
   * INTERNAL_TEAM_USER role before resolving the user's uuid.
   */
  async lookupUser(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    return this.getUser(request)
  }

  /**
   * Standard Red Notes: read the admin-managed per-user feature flags
   * (AI_ENABLED, AI_REQUEST_LIMIT) for a given user. Defaults are returned when a
   * setting has never been written for the user.
   */
  async getUserFeatureFlags(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    const { userUuid } = request.params as Record<string, string>

    const flags: Record<string, string | null> = {}
    for (const settingName of ADMIN_MANAGEABLE_SETTINGS) {
      const result = await this.doGetSetting.execute({
        userUuid,
        settingName,
        allowSensitiveRetrieval: false,
        decrypted: true,
      })

      flags[settingName] = result.isFailed() ? null : (result.getValue().decryptedValue ?? null)
    }

    return this.json({
      userUuid,
      flags,
    })
  }

  /**
   * Standard Red Notes: set an admin-managed per-user feature flag. Only the
   * flags in ADMIN_MANAGEABLE_SETTINGS may be written through this endpoint.
   * `checkUserPermissions` is intentionally false here because the admin (not the
   * target user) is performing the action; access is gated by the role check.
   */
  async setUserFeatureFlag(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    const { userUuid } = request.params as Record<string, string>
    const { name, value } = request.body as { name?: string; value?: string | null }

    if (!name || !ADMIN_MANAGEABLE_SETTINGS.includes(name)) {
      return this.json({ error: { message: `Setting ${name} is not admin-manageable.` } }, 400)
    }

    // Standard Red Notes: validate the email-backup cadence value so the admin
    // panel can only set a real frequency (disabled | daily | weekly | monthly).
    if (
      name === SettingName.NAMES.EmailBackupFrequency &&
      value != null &&
      !VALID_EMAIL_BACKUP_FREQUENCIES.includes(value)
    ) {
      return this.json(
        { error: { message: `Invalid email backup frequency '${value}'.` } },
        400,
      )
    }

    const result = await this.setSettingValue.execute({
      settingName: name,
      value: value ?? null,
      userUuid,
      checkUserPermissions: false,
    })

    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ success: true, userUuid, name, value: value ?? null })
  }

  /**
   * Standard Red Notes: read a user's current ban status for the admin panel.
   */
  async getUserBanStatus(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    const usernameOrError = Username.create((request.params.email as string) ?? '', { skipValidation: true })
    if (usernameOrError.isFailed()) {
      return this.json({ error: { message: 'Missing email parameter.' } }, 400)
    }

    const user = await this.userRepository.findOneByUsernameOrEmail(usernameOrError.getValue())
    if (!user) {
      return this.json({ error: { message: `No user with email '${usernameOrError.getValue().value}'.` } }, 400)
    }

    return this.json({
      uuid: user.uuid,
      email: user.email,
      banned: user.isBanned(),
      bannedAt: user.bannedAt ? user.bannedAt.toISOString() : null,
      banReason: user.banReason ?? null,
    })
  }

  /**
   * Standard Red Notes: ban or unban a user by uuid. Admin-only. The body must
   * carry a boolean `banned` flag and may include an optional `banReason`.
   * Enforcement happens in SignIn (new sign-ins) and AuthenticateUser (existing
   * sessions), so a ban takes effect on the user's next authenticated request.
   */
  async setUserBanStatusEndpoint(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    const { userUuid } = request.params as Record<string, string>
    const { banned, banReason } = request.body as { banned?: boolean; banReason?: string | null }

    if (typeof banned !== 'boolean') {
      return this.json({ error: { message: 'A boolean `banned` flag is required.' } }, 400)
    }

    const result = await this.setUserBanStatus.execute({
      userUuid,
      banned,
      banReason: banReason ?? null,
    })

    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const user = result.getValue()

    return this.json({
      success: true,
      uuid: user.uuid,
      banned: user.isBanned(),
      bannedAt: user.bannedAt ? user.bannedAt.toISOString() : null,
      banReason: user.banReason ?? null,
    })
  }

  /**
   * Standard Red Notes: read the instance-wide "registration disabled" flag.
   *
   * NOTE: this flag is persisted as a setting on the admin's own user record so
   * the admin panel can display/toggle it and the value survives restarts.
   * Actual enforcement at signup time is still governed by the
   * DISABLE_USER_REGISTRATION env var (read at boot in Register.ts).
   *
   * TODO(standard-red-notes): have the Register use case consult this persisted
   * flag at runtime (e.g. via a GetSetting lookup against a well-known admin
   * record) so toggling here takes effect without a redeploy.
   */
  async getRegistrationFlag(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    const adminUuid = (response?.locals as { user?: { uuid: string } } | undefined)?.user?.uuid
    if (!adminUuid) {
      return this.json({ error: { message: 'Missing admin context.' } }, 400)
    }

    const result = await this.doGetSetting.execute({
      userUuid: adminUuid,
      settingName: SettingName.NAMES.RegistrationDisabled,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })

    const registrationDisabled = result.isFailed() ? false : result.getValue().decryptedValue === 'true'

    return this.json({ registrationDisabled })
  }

  /**
   * Standard Red Notes: set the instance-wide "registration disabled" flag.
   * See getRegistrationFlag for the persistence/enforcement caveats and TODO.
   */
  async setRegistrationFlag(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    const adminUuid = (response?.locals as { user?: { uuid: string } } | undefined)?.user?.uuid
    if (!adminUuid) {
      return this.json({ error: { message: 'Missing admin context.' } }, 400)
    }

    const { registrationDisabled } = request.body as { registrationDisabled?: boolean }

    const result = await this.setSettingValue.execute({
      settingName: SettingName.NAMES.RegistrationDisabled,
      value: registrationDisabled ? 'true' : 'false',
      userUuid: adminUuid,
      checkUserPermissions: false,
    })

    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ success: true, registrationDisabled: Boolean(registrationDisabled) })
  }
}
