import {
  ControllerContainerInterface,
  MapperInterface,
  RoleName,
  SettingName,
  Username,
  Uuid,
} from '@standardnotes/domain-core'
import { BaseHttpController, results } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { Role } from '@standardnotes/security'

import { Group } from '../../../Domain/Group/Group'
import { GroupHttpProjection } from '../../Http/Projection/GroupHttpProjection'
import { CreateGroup } from '../../../Domain/UseCase/CreateGroup/CreateGroup'
import { ListGroups } from '../../../Domain/UseCase/ListGroups/ListGroups'
import { DeleteGroup } from '../../../Domain/UseCase/DeleteGroup/DeleteGroup'
import { AddUserToGroup } from '../../../Domain/UseCase/AddUserToGroup/AddUserToGroup'
import { RemoveUserFromGroup } from '../../../Domain/UseCase/RemoveUserFromGroup/RemoveUserFromGroup'
import { SetGroupRoles } from '../../../Domain/UseCase/SetGroupRoles/SetGroupRoles'
import { ListGroupMembers } from '../../../Domain/UseCase/ListGroupMembers/ListGroupMembers'
import { GetUserEffectivePermissions } from '../../../Domain/UseCase/GetUserEffectivePermissions/GetUserEffectivePermissions'

import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { GetSetting } from './../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { QueryAuditLog } from '../../../Domain/UseCase/QueryAuditLog/QueryAuditLog'
import { AuditLogEntry } from '../../../Domain/AuditLog/AuditLogEntry'
import { AuditLogEntryHttpProjection } from '../../Http/Projection/AuditLogEntryHttpProjection'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { WebhookDispatcherInterface } from '../../../Domain/Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../../../Domain/Webhook/WebhookEvent'
import { EmailBackupFrequency, ListedAuthorSecretsData } from '@standardnotes/settings'
import { GetRegularSubscriptionForUser } from '../../../Domain/UseCase/GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../../../Domain/UseCase/GetSubscriptionSetting/GetSubscriptionSetting'
import { SetSubscriptionSettingValue } from '../../../Domain/UseCase/SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { RoleServiceInterface } from '../../../Domain/Role/RoleServiceInterface'
import { FixStorageQuotaForUser } from '../../../Domain/UseCase/FixStorageQuotaForUser/FixStorageQuotaForUser'

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
  // Standard Red Notes: admin view/override of a user's SERVER-SIDE OCR opt-in
  // ('true' to allow the client to send decrypted PDF page images to the gateway
  // OCR endpoint — which leaves end-to-end encryption; anything else disables).
  // Reuses the same get/set feature-flag endpoints; value is validated below.
  SettingName.NAMES.OcrServerAllowed,
  // Standard Red Notes: admin gate for a user's scheduled Nextcloud backups
  // ('true' to allow the trigger job to upload this user's E2E-encrypted backup
  // artifact to their configured Nextcloud; anything else disables). Mirrors
  // OcrServerAllowed; the trigger additionally requires per-user completeness and
  // the operator master switch. Reuses the same get/set feature-flag endpoints;
  // value is validated below.
  SettingName.NAMES.NextcloudBackupAllowed,
  // Standard Red Notes: admin VIEW of a user's Nextcloud backup cadence so the
  // admin panel can show/agree the user's backup state. Carries no secret. The app
  // PASSWORD is deliberately absent here — it stays SENSITIVE and is never returned
  // to the admin; only a read-only "configured?" status is surfaced (see
  // getUserFeatureFlags).
  SettingName.NAMES.NextcloudBackupFrequency,
  // Standard Red Notes: admin gate for the WORKFLOWS (n8n automation) feature
  // ('true' to allow this user to pair with and reach the workflows engine
  // through the api-gateway; anything else disables). Mirrors OcrServerAllowed:
  // OFF by default, composed with the operator master switch WORKFLOWS_ENABLED
  // env at the api-gateway. Reuses the same get/set feature-flag endpoints;
  // value is validated below.
  SettingName.NAMES.WorkflowsEnabled,
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
    // Standard Red Notes: audit-log dependencies. Optional so existing tests that
    // construct this controller with the original arity keep compiling; the
    // audit-log query endpoint requires them and fails gracefully when absent,
    // and the audit-write hooks are individually guarded.
    protected queryAuditLog?: QueryAuditLog,
    protected auditLogEntryHttpMapper?: MapperInterface<AuditLogEntry, AuditLogEntryHttpProjection>,
    protected auditLogWriter?: AuditLogWriterInterface,
    private controllerContainer?: ControllerContainerInterface,
    // Standard Red Notes: optional outbound-webhook dispatcher. When wired, the
    // admin mutation endpoints fire the `admin.action` webhook alongside their
    // audit-log write. Best-effort so it can never fail the admin operation.
    // Placed here (right after controllerContainer, before the group deps) so the
    // home-server container binding — which stops at controllerContainer and omits
    // the trailing group params — can still provide it.
    protected webhookDispatcher?: WebhookDispatcherInterface,
    // Standard Red Notes: per-user SERVER storage-limit dependencies. The upload
    // limit (FILE_UPLOAD_BYTES_LIMIT) is a SUBSCRIPTION setting — GetSetting/
    // SetSettingValue reject it — so it needs its own read/write path against the
    // user's regular subscription. Optional so existing tests that construct this
    // controller with the original arity keep compiling; the storage-limit
    // endpoints fail gracefully when absent. Placed before the group deps for the
    // same home-server container-binding reason as webhookDispatcher above.
    protected doGetRegularSubscription?: GetRegularSubscriptionForUser,
    protected doGetSubscriptionSetting?: GetSubscriptionSetting,
    protected doSetSubscriptionSettingValue?: SetSubscriptionSettingValue,
    // Standard Red Notes: direct admin-role grant/revoke + panel equivalents of
    // the srn-admin CLI's reset-mfa and fix-quota commands. Optional so existing
    // tests that construct this controller with the original arity keep
    // compiling; the endpoints fail gracefully when absent. Placed before the
    // group deps for the same home-server container-binding reason as
    // webhookDispatcher above.
    protected roleService?: RoleServiceInterface,
    protected doFixStorageQuota?: FixStorageQuotaForUser,
    // Standard Red Notes: read-only env master switches surfaced to the admin
    // panel (through getRegistrationFlag). `undefined` means "not wired" and is
    // reported as null so the client can render an "unknown" state.
    protected registrationDisabledByEnv?: boolean,
    protected nextcloudBackupsEnabledByEnv?: boolean,
    // Standard Red Notes: RBAC groups / effective-permissions dependencies.
    // Optional so existing tests that construct this controller with the original
    // arity keep compiling; the group endpoints fail gracefully when absent.
    protected doCreateGroup?: CreateGroup,
    protected doListGroups?: ListGroups,
    protected doDeleteGroup?: DeleteGroup,
    protected doAddUserToGroup?: AddUserToGroup,
    protected doRemoveUserFromGroup?: RemoveUserFromGroup,
    protected doSetGroupRoles?: SetGroupRoles,
    protected doListGroupMembers?: ListGroupMembers,
    protected doGetUserEffectivePermissions?: GetUserEffectivePermissions,
    protected groupHttpMapper?: MapperInterface<Group, GroupHttpProjection>,
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
      this.controllerContainer.register('admin.getAuditLog', this.getAuditLog.bind(this))
      this.controllerContainer.register('admin.listGroups', this.listGroups.bind(this))
      this.controllerContainer.register('admin.createGroup', this.createGroup.bind(this))
      this.controllerContainer.register('admin.deleteGroup', this.deleteGroup.bind(this))
      this.controllerContainer.register('admin.setGroupRoles', this.setGroupRoles.bind(this))
      this.controllerContainer.register('admin.listGroupMembers', this.listGroupMembers.bind(this))
      this.controllerContainer.register('admin.addUserToGroup', this.addUserToGroup.bind(this))
      this.controllerContainer.register('admin.removeUserFromGroup', this.removeUserFromGroup.bind(this))
      this.controllerContainer.register('admin.getAvailableRoles', this.getAvailableRoles.bind(this))
      this.controllerContainer.register(
        'admin.getUserEffectivePermissions',
        this.getUserEffectivePermissions.bind(this),
      )
      this.controllerContainer.register('admin.setUserAdminRole', this.setUserAdminRole.bind(this))
      this.controllerContainer.register('admin.resetUserMFA', this.resetUserMFA.bind(this))
      this.controllerContainer.register('admin.fixUserQuota', this.fixUserQuota.bind(this))
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
      return this.json({ error: { message: 'Admin role required.' } }, 403)
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
      return this.json({ error: { message: 'Admin role required.' } }, 403)
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

    // Standard Red Notes: read-only "configured?" status for the Nextcloud app
    // password so the admin can SEE whether the user has finished setting up their
    // backup destination — WITHOUT ever exposing the credential. We probe with
    // `decrypted: false` so GetSetting only confirms the setting EXISTS and never
    // decrypts/returns the value; the app password stays SENSITIVE and withheld.
    const appPasswordResult = await this.doGetSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.NextcloudBackupAppPassword,
      allowSensitiveRetrieval: true,
      decrypted: false,
    })
    const nextcloudAppPasswordConfigured = !appPasswordResult.isFailed()

    // Standard Red Notes: per-user SERVER storage limit/usage. FILE_UPLOAD_BYTES_LIMIT
    // and FILE_UPLOAD_BYTES_USED are SUBSCRIPTION settings, so they are read from the
    // user's regular subscription rather than through GetSetting. Semantics:
    //   - uploadBytesLimit -1 means unlimited (the files server skips the space check
    //     for -1; the limit is embedded into valet tokens at token-creation time).
    //   - uploadBytesLimit null means the setting was never written; the plan default
    //     applies (in this fork registration always seeds it via ActivatePremiumFeatures).
    //   - hasSubscription false means no regular subscription record exists; such
    //     accounts get an unlimited (-1) valet token and the limit cannot be managed.
    let storage: {
      hasSubscription: boolean
      uploadBytesLimit: number | null
      uploadBytesUsed: number | null
    } | null = null
    if (this.doGetRegularSubscription !== undefined && this.doGetSubscriptionSetting !== undefined) {
      storage = { hasSubscription: false, uploadBytesLimit: null, uploadBytesUsed: null }
      const regularSubscriptionOrError = await this.doGetRegularSubscription.execute({ userUuid })
      if (!regularSubscriptionOrError.isFailed()) {
        const regularSubscription = regularSubscriptionOrError.getValue()
        storage.hasSubscription = true
        for (const [key, settingName] of [
          ['uploadBytesLimit', SettingName.NAMES.FileUploadBytesLimit],
          ['uploadBytesUsed', SettingName.NAMES.FileUploadBytesUsed],
        ] as const) {
          const settingOrError = await this.doGetSubscriptionSetting.execute({
            userSubscriptionUuid: regularSubscription.uuid,
            settingName,
            allowSensitiveRetrieval: false,
          })
          if (!settingOrError.isFailed()) {
            const rawValue = settingOrError.getValue().setting.props.value
            const parsedValue = rawValue === null ? Number.NaN : Number(rawValue)
            storage[key] = Number.isFinite(parsedValue) ? parsedValue : null
          }
        }
      }
    }

    return this.json({
      userUuid,
      flags,
      nextcloudAppPasswordConfigured,
      storage,
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
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    const { userUuid } = request.params as Record<string, string>
    const { name, value } = request.body as { name?: string; value?: string | null }

    // Standard Red Notes: the per-user SERVER storage limit is a SUBSCRIPTION
    // setting and takes a dedicated write path (SetSettingValue rejects
    // subscription settings). It is deliberately NOT in ADMIN_MANAGEABLE_SETTINGS
    // because that list is read/written through the plain-setting use cases.
    if (name === SettingName.NAMES.FileUploadBytesLimit) {
      return this.setUserStorageLimit(request, response)
    }

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

    // Standard Red Notes: the server-OCR opt-in is a strict boolean flag; only
    // 'true' or 'false' are accepted so the gateway gate reads an unambiguous value.
    if (name === SettingName.NAMES.OcrServerAllowed && value != null && value !== 'true' && value !== 'false') {
      return this.json({ error: { message: `Invalid OCR server-allowed value '${value}'. Use 'true' or 'false'.` } }, 400)
    }

    // Standard Red Notes: the Nextcloud-backup admin gate is likewise a strict
    // boolean flag; only 'true' or 'false' are accepted so the trigger job reads
    // an unambiguous value.
    if (name === SettingName.NAMES.NextcloudBackupAllowed && value != null && value !== 'true' && value !== 'false') {
      return this.json(
        { error: { message: `Invalid Nextcloud backup-allowed value '${value}'. Use 'true' or 'false'.` } },
        400,
      )
    }

    // Standard Red Notes: the workflows admin gate is likewise a strict boolean
    // flag; only 'true' or 'false' are accepted so the api-gateway gate (and the
    // cross-service token minting) reads an unambiguous value.
    if (name === SettingName.NAMES.WorkflowsEnabled && value != null && value !== 'true' && value !== 'false') {
      return this.json(
        { error: { message: `Invalid workflows-enabled value '${value}'. Use 'true' or 'false'.` } },
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

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.SettingChanged,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      // Record WHICH setting changed but never the value: some settings are
      // sensitive (e.g. backup app passwords) and must not be audited in clear.
      metadata: { name },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.SettingChanged,
      targetUuid: userUuid,
      // E2E-safe: setting NAME only, never its value.
      metadata: { name },
    })

    return this.json({ success: true, userUuid, name, value: value ?? null })
  }

  /**
   * Standard Red Notes: set a user's SERVER storage limit (FILE_UPLOAD_BYTES_LIMIT,
   * integer bytes; -1 = unlimited — the only value the files server treats as
   * unlimited). Reached through setUserFeatureFlag, so the admin role has already
   * been verified. The value is written as a subscription setting on the user's
   * regular subscription; CreateValetToken reads it fresh from the database on
   * every valet-token creation (no cache), so the new limit is honored by every
   * NEW upload valet token. Tokens issued before the change keep the old embedded
   * limit until they expire (valet-token TTL). No quota recalculation is needed:
   * FILE_UPLOAD_BYTES_USED tracking is independent of the limit.
   */
  private async setUserStorageLimit(request: Request, response?: Response): Promise<results.JsonResult> {
    const { userUuid } = request.params as Record<string, string>
    const { value } = request.body as { value?: string | null }

    if (this.doGetRegularSubscription === undefined || this.doSetSubscriptionSettingValue === undefined) {
      return this.json({ error: { message: 'Storage limit management is not available.' } }, 500)
    }

    const trimmedValue = typeof value === 'string' ? value.trim() : value
    if (
      typeof trimmedValue !== 'string' ||
      !/^-?\d+$/.test(trimmedValue) ||
      !Number.isSafeInteger(Number(trimmedValue)) ||
      Number(trimmedValue) < -1
    ) {
      return this.json(
        {
          error: {
            message: `Invalid storage limit '${value}'. Provide an integer number of bytes, or -1 for unlimited.`,
          },
        },
        400,
      )
    }
    const normalizedValue = `${Number(trimmedValue)}`

    const regularSubscriptionOrError = await this.doGetRegularSubscription.execute({ userUuid })
    if (regularSubscriptionOrError.isFailed()) {
      return this.json(
        {
          error: {
            message:
              'User has no regular subscription record. Accounts without one are already treated as unlimited by the files server.',
          },
        },
        400,
      )
    }
    const regularSubscription = regularSubscriptionOrError.getValue()

    const result = await this.doSetSubscriptionSettingValue.execute({
      userSubscriptionUuid: regularSubscription.uuid,
      settingName: SettingName.NAMES.FileUploadBytesLimit,
      value: normalizedValue,
    })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.SettingChanged,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      // Setting name only, mirroring setUserFeatureFlag's audit policy.
      metadata: { name: SettingName.NAMES.FileUploadBytesLimit },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.SettingChanged,
      targetUuid: userUuid,
      metadata: { name: SettingName.NAMES.FileUploadBytesLimit },
    })

    return this.json({
      success: true,
      userUuid,
      name: SettingName.NAMES.FileUploadBytesLimit,
      value: normalizedValue,
    })
  }

  /**
   * Standard Red Notes: read a user's current ban status for the admin panel.
   */
  async getUserBanStatus(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
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
      return this.json({ error: { message: 'Admin role required.' } }, 403)
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

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.BanChanged,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      metadata: { banned, banReason: banReason ?? null },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.BanChanged,
      targetUuid: userUuid,
      metadata: { banned, banReason: banReason ?? null },
    })

    return this.json({
      success: true,
      uuid: user.uuid,
      banned: user.isBanned(),
      bannedAt: user.bannedAt ? user.bannedAt.toISOString() : null,
      banReason: user.banReason ?? null,
    })
  }

  /**
   * Standard Red Notes: grant or revoke the admin role (INTERNAL_TEAM_USER) on a
   * user, the HTTP surface of the srn-admin CLI's grant-admin / revoke-admin.
   * Body: { granted: boolean }. Self-revocation is refused so an admin cannot
   * accidentally lock the panel for themselves (and potentially the instance —
   * the CLI remains the recovery path either way).
   */
  async setUserAdminRole(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.roleService === undefined) {
      return this.json({ error: { message: 'Role management is not available.' } }, 500)
    }

    const { userUuid } = request.params as Record<string, string>
    const { granted } = request.body as { granted?: boolean }

    if (typeof granted !== 'boolean') {
      return this.json({ error: { message: 'A boolean `granted` flag is required.' } }, 400)
    }

    const uuidOrError = Uuid.create(userUuid)
    if (uuidOrError.isFailed()) {
      return this.json({ error: { message: 'Invalid user uuid.' } }, 400)
    }
    const uuid = uuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(uuid)
    if (!user) {
      return this.json({ error: { message: `No user with uuid '${userUuid}'.` } }, 400)
    }

    if (!granted && this.actorUuid(response) === userUuid) {
      return this.json(
        {
          error: {
            message:
              'You cannot revoke your own admin role from the panel. Ask another admin, or use the srn-admin CLI.',
          },
        },
        400,
      )
    }

    const roleNameOrError = RoleName.create(RoleName.NAMES.InternalTeamUser)
    /* istanbul ignore if -- the canonical role name always parses */
    if (roleNameOrError.isFailed()) {
      return this.json({ error: { message: roleNameOrError.getError() } }, 500)
    }
    const roleName = roleNameOrError.getValue()

    if (granted) {
      await this.roleService.addRoleToUser(uuid, roleName)
    } else {
      await this.roleService.removeRoleFromUser(uuid, roleName)
    }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      metadata: { role: RoleName.NAMES.InternalTeamUser, granted },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetUuid: userUuid,
      metadata: { role: RoleName.NAMES.InternalTeamUser, granted },
    })

    return this.json({ success: true, userUuid, role: RoleName.NAMES.InternalTeamUser, granted })
  }

  /**
   * Standard Red Notes: admin-gated "reset 2FA" — clears the user's MFA secret
   * (and thereby the recovery-code requirement), mirroring the srn-admin CLI's
   * reset-mfa. Unlike the internal (ungated) deleteMFASetting route, this
   * enforces the admin role, writes an audit entry and fires the admin webhook.
   */
  async resetUserMFA(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    const { userUuid } = request.params as Record<string, string>

    const result = await this.doDeleteSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.MfaSecret,
      softDelete: true,
    })

    if (!result.success) {
      return this.json({ error: { message: 'No 2FA configuration found for this user.' } }, 400)
    }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.MfaReset,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      // Setting NAME only, never a value (the secret is sensitive).
      metadata: { name: SettingName.NAMES.MfaSecret },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.MfaReset,
      targetUuid: userUuid,
      metadata: { name: SettingName.NAMES.MfaSecret },
    })

    return this.json({ success: true, userUuid })
  }

  /**
   * Standard Red Notes: admin-gated "fix quota" — recalculates the user's
   * FILE_UPLOAD_BYTES_USED from their actual stored files, mirroring the
   * srn-admin CLI's fix-quota. The recalculation is asynchronous (the use case
   * zeroes the counter and publishes a FileQuotaRecalculationRequested event the
   * files worker answers), so the fresh value appears on a later
   * feature-flags read once processing completes.
   */
  async fixUserQuota(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doFixStorageQuota === undefined) {
      return this.json({ error: { message: 'Quota recalculation is not available.' } }, 500)
    }

    const { userUuid } = request.params as Record<string, string>

    const uuidOrError = Uuid.create(userUuid)
    if (uuidOrError.isFailed()) {
      return this.json({ error: { message: 'Invalid user uuid.' } }, 400)
    }

    const user = await this.userRepository.findOneByUuid(uuidOrError.getValue())
    if (!user) {
      return this.json({ error: { message: `No user with uuid '${userUuid}'.` } }, 400)
    }

    const result = await this.doFixStorageQuota.execute({ userEmail: user.email })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.QuotaRecalculated,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      metadata: { name: SettingName.NAMES.FileUploadBytesUsed },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.QuotaRecalculated,
      targetUuid: userUuid,
      metadata: { name: SettingName.NAMES.FileUploadBytesUsed },
    })

    return this.json({ success: true, userUuid })
  }

  /**
   * Standard Red Notes: admin-only query over the audit log. Supports filtering
   * by actor uuid, action, and an inclusive created_at date range (ISO-8601),
   * plus limit/offset pagination. Returns the matching page newest-first along
   * with the total match count.
   */
  async getAuditLog(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    if (this.queryAuditLog === undefined || this.auditLogEntryHttpMapper === undefined) {
      return this.json({ error: { message: 'Audit log is not available.' } }, 500)
    }
    const auditLogEntryHttpMapper = this.auditLogEntryHttpMapper

    const query = request.query as Record<string, string | undefined>

    const result = await this.queryAuditLog.execute({
      actorUuid: query.actorUuid,
      action: query.action,
      from: query.from,
      to: query.to,
      limit: query.limit !== undefined ? Number.parseInt(query.limit, 10) : undefined,
      offset: query.offset !== undefined ? Number.parseInt(query.offset, 10) : undefined,
    })

    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const { entries, total, limit, offset } = result.getValue()

    return this.json({
      entries: entries.map((entry) => auditLogEntryHttpMapper.toProjection(entry)),
      total,
      limit,
      offset,
    })
  }

  private actorUuid(response?: Response): string | null {
    return (response?.locals as { user?: { uuid: string } } | undefined)?.user?.uuid ?? null
  }

  private clientIp(request: Request): string | null {
    return (request.headers['x-forwarded-for'] as string | undefined) ?? request.ip ?? null
  }

  /**
   * Standard Red Notes: best-effort `admin.action` outbound webhook, fired
   * alongside the admin audit-log write. There is no admin domain event on the
   * internal event bus, so the dispatch is colocated with the audit write (the
   * canonical record of an admin mutation). The payload is E2E-safe: it carries
   * the acting admin uuid, the affected user uuid and non-sensitive metadata
   * (action name, setting name, ban flag) — never tokens, passwords or setting
   * values. The affected user is used as the webhook `userUuid` so a user-scoped
   * webhook of that user is notified of admin actions on their account, while
   * global webhooks receive every admin action. Failures are swallowed so an
   * admin operation can never be broken by a webhook delivery problem.
   */
  private async dispatchAdminActionWebhook(params: {
    actorUuid: string | null
    action: string
    targetUuid: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    if (this.webhookDispatcher === undefined) {
      return
    }

    try {
      await this.webhookDispatcher.dispatch(WebhookEvent.AdminAction, {
        userUuid: params.targetUuid,
        metadata: {
          action: params.action,
          actorUuid: params.actorUuid,
          targetType: 'user',
          targetUuid: params.targetUuid,
          performedAt: new Date().toISOString(),
          ...(params.metadata ?? {}),
        },
      })
    } catch {
      // Best-effort: the dispatcher already logs its own delivery failures.
    }
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
      return this.json({ error: { message: 'Admin role required.' } }, 403)
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

    return this.json({
      registrationDisabled,
      // Standard Red Notes: read-only env master switches for the admin panel's
      // Server tab. `null` means the value was not wired into this deployment
      // (older binding) and the client renders an "unknown" state.
      //   - registrationDisabledByEnv: the boot-time DISABLE_USER_REGISTRATION
      //     env (signup is blocked when EITHER it or the persisted flag is set).
      //   - nextcloudBackupsEnabledByEnv: the NEXTCLOUD_BACKUPS_ENABLED operator
      //     master switch gating scheduled Nextcloud backups instance-wide.
      env: {
        registrationDisabled: this.registrationDisabledByEnv ?? null,
        nextcloudBackupsEnabled: this.nextcloudBackupsEnabledByEnv ?? null,
      },
    })
  }

  /**
   * Standard Red Notes: set the instance-wide "registration disabled" flag.
   * See getRegistrationFlag for the persistence/enforcement caveats and TODO.
   */
  async setRegistrationFlag(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
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

  /**
   * Standard Red Notes: list every known role name so the admin panel can present
   * the roles a group may confer. Backed by the canonical RoleName.NAMES so it
   * stays in sync with the role model.
   */
  async getAvailableRoles(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    return this.json({ roleNames: Object.values(RoleName.NAMES) })
  }

  /**
   * Standard Red Notes: list all RBAC groups (with their conferred role names).
   */
  async listGroups(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doListGroups === undefined || this.groupHttpMapper === undefined) {
      return this.json({ error: { message: 'Groups are not available.' } }, 500)
    }
    const groupHttpMapper = this.groupHttpMapper

    const result = await this.doListGroups.execute()
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ groups: result.getValue().map((group) => groupHttpMapper.toProjection(group)) })
  }

  /**
   * Standard Red Notes: create an RBAC group. Body: { name, description?,
   * roleNames? }.
   */
  async createGroup(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doCreateGroup === undefined || this.groupHttpMapper === undefined) {
      return this.json({ error: { message: 'Groups are not available.' } }, 500)
    }

    const { name, description, roleNames } = request.body as {
      name?: string
      description?: string | null
      roleNames?: string[]
    }

    const result = await this.doCreateGroup.execute({
      name: name ?? '',
      description: description ?? null,
      roleNames: roleNames ?? [],
    })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ group: this.groupHttpMapper.toProjection(result.getValue()) })
  }

  /**
   * Standard Red Notes: delete an RBAC group (and its membership / role rows).
   */
  async deleteGroup(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doDeleteGroup === undefined) {
      return this.json({ error: { message: 'Groups are not available.' } }, 500)
    }

    const { groupUuid } = request.params as Record<string, string>

    const result = await this.doDeleteGroup.execute({ groupUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ success: true, groupUuid })
  }

  /**
   * Standard Red Notes: replace the full set of role names a group confers.
   * Body: { roleNames: string[] }.
   */
  async setGroupRoles(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doSetGroupRoles === undefined || this.groupHttpMapper === undefined) {
      return this.json({ error: { message: 'Groups are not available.' } }, 500)
    }

    const { groupUuid } = request.params as Record<string, string>
    const { roleNames } = request.body as { roleNames?: string[] }

    const result = await this.doSetGroupRoles.execute({ groupUuid, roleNames: roleNames ?? [] })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ group: this.groupHttpMapper.toProjection(result.getValue()) })
  }

  /**
   * Standard Red Notes: list a group's members (uuid + email).
   */
  async listGroupMembers(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doListGroupMembers === undefined) {
      return this.json({ error: { message: 'Groups are not available.' } }, 500)
    }

    const { groupUuid } = request.params as Record<string, string>

    const result = await this.doListGroupMembers.execute({ groupUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ members: result.getValue() })
  }

  /**
   * Standard Red Notes: add a user to a group. Body: { userUuid }.
   */
  async addUserToGroup(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doAddUserToGroup === undefined) {
      return this.json({ error: { message: 'Groups are not available.' } }, 500)
    }

    const { groupUuid } = request.params as Record<string, string>
    const { userUuid } = request.body as { userUuid?: string }

    const result = await this.doAddUserToGroup.execute({ groupUuid, userUuid: userUuid ?? '' })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ success: true, groupUuid, userUuid: result.getValue() })
  }

  /**
   * Standard Red Notes: remove a user from a group.
   */
  async removeUserFromGroup(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doRemoveUserFromGroup === undefined) {
      return this.json({ error: { message: 'Groups are not available.' } }, 500)
    }

    const { groupUuid, userUuid } = request.params as Record<string, string>

    const result = await this.doRemoveUserFromGroup.execute({ groupUuid, userUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ success: true, groupUuid, userUuid: result.getValue() })
  }

  /**
   * Standard Red Notes: compute a user's effective roles/permissions =
   * (direct roles) ∪ (roles conferred by their groups), with permissions
   * resolved through the existing role -> permission mapping.
   */
  async getUserEffectivePermissions(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doGetUserEffectivePermissions === undefined) {
      return this.json({ error: { message: 'Effective permissions are not available.' } }, 500)
    }

    const { userUuid } = request.params as Record<string, string>

    const result = await this.doGetUserEffectivePermissions.execute({ userUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json(result.getValue())
  }
}
