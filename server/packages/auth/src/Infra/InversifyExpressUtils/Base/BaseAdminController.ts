import { ControllerContainerInterface, MapperInterface, RoleName, SettingName, Username } from '@standardnotes/domain-core'
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

    return this.json({
      userUuid,
      flags,
      nextcloudAppPasswordConfigured,
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
   * Standard Red Notes: admin-only query over the audit log. Supports filtering
   * by actor uuid, action, and an inclusive created_at date range (ISO-8601),
   * plus limit/offset pagination. Returns the matching page newest-first along
   * with the total match count.
   */
  async getAuditLog(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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

  /**
   * Standard Red Notes: list every known role name so the admin panel can present
   * the roles a group may confer. Backed by the canonical RoleName.NAMES so it
   * stays in sync with the role model.
   */
  async getAvailableRoles(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
    }

    return this.json({ roleNames: Object.values(RoleName.NAMES) })
  }

  /**
   * Standard Red Notes: list all RBAC groups (with their conferred role names).
   */
  async listGroups(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
      return this.json({ error: { message: 'Operation not allowed.' } }, 401)
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
