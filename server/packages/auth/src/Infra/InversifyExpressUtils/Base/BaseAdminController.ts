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
import { ListRolesWithPermissions } from '../../../Domain/UseCase/ListRolesWithPermissions/ListRolesWithPermissions'
import { SetRolePermissions } from '../../../Domain/UseCase/SetRolePermissions/SetRolePermissions'
import { CreateCustomRole } from '../../../Domain/UseCase/CreateCustomRole/CreateCustomRole'
import { DeleteCustomRole } from '../../../Domain/UseCase/DeleteCustomRole/DeleteCustomRole'
import { GetPermissionCatalog } from '../../../Domain/UseCase/GetPermissionCatalog/GetPermissionCatalog'
import { GetRoleHolders } from '../../../Domain/UseCase/GetRoleHolders/GetRoleHolders'
import { ResolveRoleSetPermissions } from '../../../Domain/UseCase/ResolveRoleSetPermissions/ResolveRoleSetPermissions'

import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { GetSetting } from './../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { AdminUserSort, UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { LockRepositoryInterface } from '../../../Domain/User/LockRepositoryInterface'
import { BanType, User } from '../../../Domain/User/User'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { SetUserSuspension } from '../../../Domain/UseCase/SetUserSuspension/SetUserSuspension'
import { DeleteAccount } from '../../../Domain/UseCase/DeleteAccount/DeleteAccount'
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
import { CANONICAL_ADMIN_ROLES, CANONICAL_ADMIN_ROLE_NAMES } from '../../../Domain/Role/CanonicalRoles'
import { FixStorageQuotaForUser } from '../../../Domain/UseCase/FixStorageQuotaForUser/FixStorageQuotaForUser'
import { CreateSignupInviteLink } from '../../../Domain/UseCase/CreateSignupInviteLink/CreateSignupInviteLink'
import { ListSignupInviteLinks } from '../../../Domain/UseCase/ListSignupInviteLinks/ListSignupInviteLinks'
import { RevokeSignupInviteLink } from '../../../Domain/UseCase/RevokeSignupInviteLink/RevokeSignupInviteLink'
import { SignupInviteLink } from '../../../Domain/SignupInvite/SignupInviteLink'

/**
 * Standard Red Notes: settings an admin (ADMIN_USER) is allowed to set
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
    // Standard Red Notes: RBAC ROLE management (the roles themselves, not just
    // group->role links). Roles are enum + migration bound, so this is a SAFE
    // subset: read every role with its permissions + edit which seeded
    // permissions a role grants. There is deliberately no create/delete — new
    // role TYPES require a migration. Optional so existing constructions (home
    // server, tests) keep compiling; the endpoints fail gracefully when absent.
    protected doListRolesWithPermissions?: ListRolesWithPermissions,
    protected doSetRolePermissions?: SetRolePermissions,
    // Standard Red Notes: EXTENSIVE RBAC management. Additive + optional so every
    // existing construction (home server, tests) keeps compiling and the
    // endpoints fail gracefully (500 "not available") when a dep is absent.
    //   - custom ROLE TYPES (create/delete) — the SAFE subset: a custom role is a
    //     plain roles-table row conferred ONLY via groups (group -> effective-
    //     permissions -> token resolves role NAMES against the DB, never the
    //     RoleName enum). Built-ins are guarded server-side.
    //   - the permission CATALOG browser, role-holders inspector and role-set
    //     effective-permissions simulator (all read-only).
    protected doCreateCustomRole?: CreateCustomRole,
    protected doDeleteCustomRole?: DeleteCustomRole,
    protected doGetPermissionCatalog?: GetPermissionCatalog,
    protected doGetRoleHolders?: GetRoleHolders,
    protected doResolveRoleSetPermissions?: ResolveRoleSetPermissions,
    // Standard Red Notes: failed-login lock repository, backing the anti-abuse
    // "Locked accounts" list + unlock. Optional so existing constructions (home
    // server, tests) keep compiling; the endpoints degrade gracefully when absent
    // or when the bound repository (TypeORM cache) cannot list locks.
    protected lockRepository?: LockRepositoryInterface,
    // Standard Red Notes: admin SUSPEND/UNSUSPEND + admin-initiated DELETE.
    // Optional trailing deps so every existing construction (tests, home server,
    // microservice) keeps compiling; the endpoints fail gracefully (500 "not
    // available") when a dep is absent. Delete reuses the EXISTING cross-service
    // DeleteAccount pipeline — no hand-rolled multi-service deletion.
    protected doSetUserSuspension?: SetUserSuspension,
    protected doDeleteAccount?: DeleteAccount,
    // Standard Red Notes: SIGNUP INVITE LINKS admin surface (create/list/revoke).
    // Optional trailing deps so every existing construction (tests, home server,
    // microservice) keeps compiling; the endpoints fail gracefully (500 "not
    // available") when a dep is absent.
    protected doCreateSignupInviteLink?: CreateSignupInviteLink,
    protected doListSignupInviteLinks?: ListSignupInviteLinks,
    protected doRevokeSignupInviteLink?: RevokeSignupInviteLink,
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
      this.controllerContainer.register('admin.getUserSuspensionStatus', this.getUserSuspensionStatus.bind(this))
      this.controllerContainer.register('admin.setUserSuspension', this.setUserSuspensionEndpoint.bind(this))
      this.controllerContainer.register('admin.deleteUser', this.deleteUser.bind(this))
      this.controllerContainer.register('admin.getAuditLog', this.getAuditLog.bind(this))
      this.controllerContainer.register('admin.getUsers', this.getUsers.bind(this))
      this.controllerContainer.register('admin.listGroups', this.listGroups.bind(this))
      this.controllerContainer.register('admin.createGroup', this.createGroup.bind(this))
      this.controllerContainer.register('admin.deleteGroup', this.deleteGroup.bind(this))
      this.controllerContainer.register('admin.setGroupRoles', this.setGroupRoles.bind(this))
      this.controllerContainer.register('admin.listGroupMembers', this.listGroupMembers.bind(this))
      this.controllerContainer.register('admin.addUserToGroup', this.addUserToGroup.bind(this))
      this.controllerContainer.register('admin.removeUserFromGroup', this.removeUserFromGroup.bind(this))
      this.controllerContainer.register('admin.getAvailableRoles', this.getAvailableRoles.bind(this))
      this.controllerContainer.register('admin.listRolesWithPermissions', this.listRolesWithPermissions.bind(this))
      this.controllerContainer.register('admin.setRolePermissions', this.setRolePermissions.bind(this))
      this.controllerContainer.register('admin.createCustomRole', this.createCustomRole.bind(this))
      this.controllerContainer.register('admin.deleteCustomRole', this.deleteCustomRole.bind(this))
      this.controllerContainer.register('admin.getPermissionCatalog', this.getPermissionCatalog.bind(this))
      this.controllerContainer.register('admin.getRoleHolders', this.getRoleHolders.bind(this))
      this.controllerContainer.register('admin.resolveRoleSetPermissions', this.resolveRoleSetPermissions.bind(this))
      this.controllerContainer.register(
        'admin.getUserEffectivePermissions',
        this.getUserEffectivePermissions.bind(this),
      )
      this.controllerContainer.register('admin.setUserAdminRole', this.setUserAdminRole.bind(this))
      this.controllerContainer.register('admin.resetUserMFA', this.resetUserMFA.bind(this))
      this.controllerContainer.register('admin.fixUserQuota', this.fixUserQuota.bind(this))
      this.controllerContainer.register('admin.getLockedAccounts', this.getLockedAccounts.bind(this))
      this.controllerContainer.register('admin.unlockAccount', this.unlockAccount.bind(this))
    }
  }

  /**
   * Standard Red Notes: enforce the ADMIN_USER role for admin-only
   * endpoints. The api-gateway AuthMiddleware decodes the cross-service token and
   * places the roles (by name) on `response.locals.roles`, which is forwarded to
   * this controller both over HTTP and in the home-server DirectCall path.
   */
  protected requestorIsAdmin(response?: Response): boolean {
    const roles = ((response?.locals as { roles?: Role[] } | undefined)?.roles ?? []) as Role[]

    return roles.some((role) => role.name === RoleName.NAMES.AdminUser)
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
   * ADMIN_USER role before resolving the user's uuid.
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
      banType: user.effectiveBanType(),
      bannedUntil: user.bannedUntil ? new Date(user.bannedUntil).toISOString() : null,
      shadowBanned: user.isShadowBanned(),
    })
  }

  /**
   * Standard Red Notes: ban or unban a user by uuid. Admin-only. The body must
   * carry a boolean `banned` flag and may include:
   *   - `banReason` (text),
   *   - `banType` ('temporary' | 'permanent' | 'shadow'; default 'permanent'),
   *   - for a temporary ban, EITHER `bannedUntil` (an ISO-8601 timestamp) OR
   *     `durationMinutes` (a positive number of minutes from now).
   * The plain legacy body ({ banned, banReason }) keeps producing a permanent
   * ban unchanged. Enforcement of permanent / active-temporary bans happens in
   * SignIn + AuthenticateUser; a shadow ban lets the user connect but silently
   * degrades their sync (projected via the cross-service token).
   */
  async setUserBanStatusEndpoint(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    const { userUuid } = request.params as Record<string, string>
    const { banned, banReason, banType, bannedUntil, durationMinutes } = request.body as {
      banned?: boolean
      banReason?: string | null
      banType?: string | null
      bannedUntil?: string | null
      durationMinutes?: number | string | null
    }

    if (typeof banned !== 'boolean') {
      return this.json({ error: { message: 'A boolean `banned` flag is required.' } }, 400)
    }

    let resolvedBanType: BanType | undefined = undefined
    let resolvedBannedUntil: Date | null = null
    if (banned) {
      resolvedBanType = (banType ?? 'permanent') as BanType
      if (resolvedBanType !== 'permanent' && resolvedBanType !== 'temporary' && resolvedBanType !== 'shadow') {
        return this.json(
          { error: { message: `Invalid ban type '${banType}'. Use 'temporary', 'permanent' or 'shadow'.` } },
          400,
        )
      }

      if (resolvedBanType === 'temporary') {
        if (durationMinutes !== undefined && durationMinutes !== null && durationMinutes !== '') {
          const minutes = Number(durationMinutes)
          if (!Number.isFinite(minutes) || minutes <= 0) {
            return this.json({ error: { message: '`durationMinutes` must be a positive number.' } }, 400)
          }
          resolvedBannedUntil = new Date(Date.now() + minutes * 60_000)
        } else if (bannedUntil) {
          resolvedBannedUntil = new Date(bannedUntil)
          if (Number.isNaN(resolvedBannedUntil.getTime())) {
            return this.json({ error: { message: '`bannedUntil` is not a valid date.' } }, 400)
          }
        } else {
          return this.json(
            { error: { message: 'A temporary ban requires `bannedUntil` (ISO date) or `durationMinutes`.' } },
            400,
          )
        }
      }
    }

    const result = await this.setUserBanStatus.execute({
      userUuid,
      banned,
      banReason: banReason ?? null,
      banType: resolvedBanType ?? null,
      bannedUntil: resolvedBannedUntil,
    })

    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const user = result.getValue()

    const auditMetadata = {
      banned,
      banReason: banReason ?? null,
      banType: user.effectiveBanType(),
      bannedUntil: user.bannedUntil ? new Date(user.bannedUntil).toISOString() : null,
    }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.BanChanged,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      metadata: auditMetadata,
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.BanChanged,
      targetUuid: userUuid,
      metadata: auditMetadata,
    })

    return this.json({
      success: true,
      uuid: user.uuid,
      banned: user.isBanned(),
      bannedAt: user.bannedAt ? user.bannedAt.toISOString() : null,
      banReason: user.banReason ?? null,
      banType: user.effectiveBanType(),
      bannedUntil: user.bannedUntil ? new Date(user.bannedUntil).toISOString() : null,
      shadowBanned: user.isShadowBanned(),
    })
  }

  /**
   * Standard Red Notes: whether the given target is the LAST remaining
   * administrator — used by the suspend + delete guards so an admin can never
   * lock every administrator out of the instance. Returns false unless the
   * target actually holds ADMIN_USER (removing/holding a non-admin never
   * threatens the admin population), then counts admins via the same
   * findUsersForAdmin role filter (bounded LIMIT 2 — we only care whether the
   * total is ≤ 1).
   */
  private async targetIsLastAdmin(user: User): Promise<boolean> {
    const targetRoles = await user.roles
    const targetIsAdmin = targetRoles.some((role) => role.name === RoleName.NAMES.AdminUser)
    if (!targetIsAdmin) {
      return false
    }

    const admins = await this.userRepository.findUsersForAdmin({
      role: RoleName.NAMES.AdminUser,
      limit: 2,
      offset: 0,
      sort: 'createdAt',
    })

    return admins.total <= 1
  }

  /**
   * Standard Red Notes: read a user's current SUSPENSION status for the admin
   * panel. Mirrors getUserBanStatus (by email).
   */
  async getUserSuspensionStatus(request: Request, response?: Response): Promise<results.JsonResult> {
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
      suspended: user.isSuspended(),
      suspendedAt: user.suspendedAt ? new Date(user.suspendedAt).toISOString() : null,
      suspendedReason: user.suspendedReason ?? null,
    })
  }

  /**
   * Standard Red Notes: SUSPEND or UNSUSPEND a user by uuid. Admin-only. The
   * body must carry a boolean `suspended` flag and may include `suspendedReason`.
   * Suspension is a reversible administrative hold, SEPARATE from a ban; it is
   * folded into User.isAccessBlocked() so SignIn + AuthenticateUser reject the
   * user, and the use-case additionally revokes their sessions on suspend for
   * immediacy. The suspend-only guards mirror delete: an admin cannot suspend
   * their own account, nor the last remaining administrator.
   */
  async setUserSuspensionEndpoint(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doSetUserSuspension === undefined) {
      return this.json({ error: { message: 'Account suspension is not available.' } }, 500)
    }

    const { userUuid } = request.params as Record<string, string>
    const { suspended, suspendedReason } = request.body as { suspended?: boolean; suspendedReason?: string | null }

    if (typeof suspended !== 'boolean') {
      return this.json({ error: { message: 'A boolean `suspended` flag is required.' } }, 400)
    }

    const uuidOrError = Uuid.create(userUuid)
    if (uuidOrError.isFailed()) {
      return this.json({ error: { message: 'Invalid user uuid.' } }, 400)
    }

    const user = await this.userRepository.findOneByUuid(uuidOrError.getValue())
    if (!user) {
      return this.json({ error: { message: `No user with uuid '${userUuid}'.` } }, 400)
    }

    // Guards apply only when SUSPENDING; unsuspending is always safe.
    if (suspended) {
      if (this.actorUuid(response) === userUuid) {
        return this.json(
          { error: { message: 'You cannot suspend your own account from the admin panel.' } },
          400,
        )
      }
      if (await this.targetIsLastAdmin(user)) {
        return this.json({ error: { message: 'Cannot suspend the last remaining administrator.' } }, 400)
      }
    }

    const result = await this.doSetUserSuspension.execute({
      userUuid,
      suspended,
      suspendedReason: suspendedReason ?? null,
    })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const savedUser = result.getValue()

    const auditMetadata = {
      suspended,
      suspendedReason: savedUser.suspendedReason ?? null,
    }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.SuspensionChanged,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      metadata: auditMetadata,
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.SuspensionChanged,
      targetUuid: userUuid,
      metadata: auditMetadata,
    })

    return this.json({
      success: true,
      uuid: savedUser.uuid,
      suspended: savedUser.isSuspended(),
      suspendedAt: savedUser.suspendedAt ? new Date(savedUser.suspendedAt).toISOString() : null,
      suspendedReason: savedUser.suspendedReason ?? null,
    })
  }

  /**
   * Standard Red Notes: admin-initiated HARD DELETE of a target account by uuid.
   * Admin-only. Reuses the EXISTING cross-service DeleteAccount pipeline (no
   * password verification, no hand-rolled multi-service deletion): it publishes
   * AccountDeletionRequestedEvent, whose handlers remove the auth row + sessions
   * and the other services' data. Guards: cannot delete self, cannot delete the
   * last administrator, and a `confirmEmail` in the body MUST match the target's
   * email (belt-and-suspenders for the type-the-email UI dialog so a bare API
   * call can never nuke the wrong account). Returns once the event is published.
   */
  async deleteUser(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doDeleteAccount === undefined) {
      return this.json({ error: { message: 'Account deletion is not available.' } }, 500)
    }

    const { userUuid } = request.params as Record<string, string>
    const { confirmEmail } = request.body as { confirmEmail?: string }

    const uuidOrError = Uuid.create(userUuid)
    if (uuidOrError.isFailed()) {
      return this.json({ error: { message: 'Invalid user uuid.' } }, 400)
    }

    const user = await this.userRepository.findOneByUuid(uuidOrError.getValue())
    if (!user) {
      return this.json({ error: { message: `No user with uuid '${userUuid}'.` } }, 400)
    }

    if (this.actorUuid(response) === userUuid) {
      return this.json(
        { error: { message: 'You cannot delete your own account from the admin panel.' } },
        400,
      )
    }

    if (await this.targetIsLastAdmin(user)) {
      return this.json({ error: { message: 'Cannot delete the last remaining administrator.' } }, 400)
    }

    if (
      typeof confirmEmail !== 'string' ||
      confirmEmail.trim().toLowerCase() !== (user.email ?? '').trim().toLowerCase()
    ) {
      return this.json({ error: { message: 'Confirmation email does not match.' } }, 400)
    }

    const email = user.email

    const result = await this.doDeleteAccount.execute({ userUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const auditMetadata = { email }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.AccountDeleted,
      targetType: 'user',
      targetUuid: userUuid,
      ip: this.clientIp(request),
      metadata: auditMetadata,
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.AccountDeleted,
      targetUuid: userUuid,
      metadata: auditMetadata,
    })

    return this.json({ success: true, userUuid, email })
  }

  /**
   * Standard Red Notes: grant or revoke the admin role (ADMIN_USER) on a
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

    const roleNameOrError = RoleName.create(RoleName.NAMES.AdminUser)
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
      metadata: { role: RoleName.NAMES.AdminUser, granted },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetUuid: userUuid,
      metadata: { role: RoleName.NAMES.AdminUser, granted },
    })

    return this.json({ success: true, userUuid, role: RoleName.NAMES.AdminUser, granted })
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

  /**
   * Standard Red Notes: admin-only paginated + filtered user list for the admin
   * panel's Users tab. Read-only, so no audit entry. Delegates the heavy lifting
   * to the User repository's findUsersForAdmin (COUNT + LIMIT/OFFSET + batched
   * enrichment — never loads all users). Query params:
   *   - limit (default 100, MAX 1500), offset (default 0)
   *   - sort: createdAt | email | updatedAt (default createdAt, desc)
   *   - email (contains, case-insensitive), createdAfter/createdBefore (epoch ms)
   *   - role (has role), banned (true|false), subscription (active|inactive|none)
   */
  async getUsers(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    const query = request.query as Record<string, string | undefined>

    const MAX_LIMIT = 1500
    let limit = query.limit !== undefined ? Number.parseInt(query.limit, 10) : 100
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 100
    }
    limit = Math.min(limit, MAX_LIMIT)

    let offset = query.offset !== undefined ? Number.parseInt(query.offset, 10) : 0
    if (!Number.isFinite(offset) || offset < 0) {
      offset = 0
    }

    const sort: AdminUserSort =
      query.sort === 'email' || query.sort === 'updatedAt' || query.sort === 'createdAt' ? query.sort : 'createdAt'

    const parseEpoch = (value: string | undefined): number | undefined => {
      if (value === undefined || value === '') {
        return undefined
      }
      const parsed = Number.parseInt(value, 10)

      return Number.isFinite(parsed) ? parsed : undefined
    }

    const subscription =
      query.subscription === 'active' || query.subscription === 'inactive' || query.subscription === 'none'
        ? query.subscription
        : undefined

    const banned = query.banned === 'true' ? true : query.banned === 'false' ? false : undefined

    const result = await this.userRepository.findUsersForAdmin({
      limit,
      offset,
      sort,
      email: query.email !== undefined && query.email.trim() !== '' ? query.email.trim() : undefined,
      createdAfter: parseEpoch(query.createdAfter),
      createdBefore: parseEpoch(query.createdBefore),
      role: query.role !== undefined && query.role.trim() !== '' ? query.role.trim() : undefined,
      banned,
      subscription,
    })

    return this.json({
      users: result.rows,
      total: result.total,
      limit,
      offset,
    })
  }

  /**
   * Standard Red Notes: anti-abuse "Locked accounts" list. Admin-gated (403 for
   * non-admins). Read-only, so no audit entry. Returns the currently-tracked
   * failed-login locks (identifier + counters + TTL + locked flag) via the lock
   * repository's SCAN-based listing. Degrades to `available:false` with an empty
   * list when the repository is absent or cannot list (TypeORM cache topology).
   */
  async getLockedAccounts(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    if (!this.lockRepository || !this.lockRepository.listLockedAccounts) {
      return this.json({ available: false, accounts: [] })
    }

    try {
      const accounts = await this.lockRepository.listLockedAccounts()

      return this.json({ available: true, accounts })
    } catch {
      // A cache read error must not 5xx the panel — report the feature as
      // available but the list as momentarily empty.
      return this.json({ available: true, accounts: [] })
    }
  }

  /**
   * Standard Red Notes: anti-abuse "unlock account". Admin-gated (403 for
   * non-admins), audited (AccountUnlocked). Clears BOTH failed-login lock tiers
   * for the given identifier (a user uuid or email, from the request body so
   * emails with dots/@ are carried safely) so the account can sign in again.
   */
  async unlockAccount(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    if (!this.lockRepository) {
      return this.json({ error: { message: 'Account lockout management is not available on this deployment.' } }, 503)
    }

    const identifier = (request.body as { identifier?: unknown }).identifier
    if (typeof identifier !== 'string' || identifier.trim() === '') {
      return this.json({ error: { message: 'identifier must be a non-empty string.' } }, 400)
    }
    const trimmed = identifier.trim()

    await this.lockRepository.resetLockCounter(trimmed)

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.AccountUnlocked,
      targetType: 'user',
      // The identifier can be a uuid or an email; record it as metadata rather
      // than assuming a uuid target.
      targetUuid: null,
      ip: this.clientIp(request),
      metadata: { identifier: trimmed },
    })

    return this.json({ success: true, identifier: trimmed })
  }

  private actorUuid(response?: Response): string | null {
    return (response?.locals as { user?: { uuid: string } } | undefined)?.user?.uuid ?? null
  }

  private clientIp(request: Request): string | null {
    // Prefer the gateway-resolved `x-origin-ip` (set by HttpServiceProxy from the
    // trusted proxy chain) over the raw, client-spoofable `x-forwarded-for`. Fall
    // back to x-forwarded-for / request.ip only when x-origin-ip is absent (e.g.
    // a non-gateway/local request). Audit metadata only — not a security gate.
    return (
      (request.headers['x-origin-ip'] as string | undefined) ??
      (request.headers['x-forwarded-for'] as string | undefined) ??
      request.ip ??
      null
    )
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
   * The flag is persisted as a setting on the admin's own user record so the admin
   * panel can display/toggle it and the value survives restarts. Enforcement at
   * signup time is governed by EITHER the boot-time DISABLE_USER_REGISTRATION env
   * var OR this persisted flag: Register consults it at runtime (see
   * Register.registrationDisabledBySetting), counting REGISTRATION_DISABLED='true'
   * rows OWNED BY AN ADMIN. Because the flag is written on the (admin) requestor's
   * own record here — and the setting is CLIENT_IMMUTABLE so only this admin path
   * may write it — this per-admin read is consistent with the admin-scoped count
   * Register uses, and toggling takes effect without a redeploy.
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
   * See getRegistrationFlag for the persistence/enforcement details.
   *
   * The write goes through SetSettingValue with checkUserPermissions:false, which
   * bypasses the client-permission gate — this is what still allows an admin to
   * write REGISTRATION_DISABLED even though the setting is CLIENT_IMMUTABLE (the
   * ordinary user-settings PUT path, which passes checkUserPermissions:true, is
   * therefore the only path that is refused). Access here is gated by the
   * ADMIN_USER role check above.
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
   * Standard Red Notes: the DEFINITIVE role taxonomy the admin panel exposes —
   * exactly the canonical four (Admin / Full / Core / Vaults users), with their
   * human labels, in display order. This is what a group may confer. PLUS_USER
   * and any legacy seeded role are intentionally NOT listed here.
   */
  async getAvailableRoles(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }

    return this.json({
      roleNames: CANONICAL_ADMIN_ROLE_NAMES,
      roles: CANONICAL_ADMIN_ROLES,
    })
  }

  /**
   * Standard Red Notes: list every role with the permissions it grants, plus the
   * seeded permission catalog for the editor. Read-only, so no audit entry.
   *
   * FEASIBILITY NOTE surfaced to the client via `builtInRoleNames`: roles are
   * enum + migration bound, so all roles are built-in and new role TYPES require
   * a migration. Only a role's permission ASSIGNMENTS are editable at runtime
   * (see setRolePermissions).
   */
  async listRolesWithPermissions(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doListRolesWithPermissions === undefined) {
      return this.json({ error: { message: 'Role management is not available.' } }, 500)
    }

    const result = await this.doListRolesWithPermissions.execute()
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json(result.getValue())
  }

  /**
   * Standard Red Notes: replace the set of permissions a role grants. Body:
   * { permissionNames: string[] }, all of which must exist in the catalog.
   *
   * BUILT-IN GUARD (server-side): this only ever mutates the role_permissions
   * join table of an EXISTING role addressed by uuid — it can never create,
   * rename or delete a role, and every permission must already exist in the
   * catalog. Audit-logged as a role change with targetType 'role'.
   */
  async setRolePermissions(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doSetRolePermissions === undefined) {
      return this.json({ error: { message: 'Role management is not available.' } }, 500)
    }

    const { roleUuid } = request.params as Record<string, string>
    const { permissionNames } = request.body as { permissionNames?: string[] }

    const result = await this.doSetRolePermissions.execute({
      roleUuid,
      permissionNames: permissionNames ?? [],
    })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const role = result.getValue()

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetType: 'role',
      targetUuid: role.uuid,
      ip: this.clientIp(request),
      metadata: { role: role.name, permissionNames: role.permissionNames },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetUuid: role.uuid,
      metadata: { role: role.name, permissionNames: role.permissionNames },
    })

    return this.json({ role })
  }

  /**
   * Standard Red Notes: create an admin-defined CUSTOM role. Body:
   * { name, description?, permissionNames? }. The SAFE subset of custom roles —
   * a custom role is a plain roles-table row conferred ONLY through groups.
   * Server-side guards (in the use case): the name is normalized, can never
   * shadow a built-in role, must be unique, and every permission must exist in
   * the catalog. Audit-logged as a role change (targetType 'role').
   */
  async createCustomRole(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doCreateCustomRole === undefined) {
      return this.json({ error: { message: 'Custom role management is not available.' } }, 500)
    }

    const { name, description, permissionNames } = request.body as {
      name?: string
      description?: string | null
      permissionNames?: string[]
    }

    const result = await this.doCreateCustomRole.execute({
      name: name ?? '',
      description: description ?? null,
      permissionNames: permissionNames ?? [],
    })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const role = result.getValue()

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetType: 'role',
      targetUuid: role.uuid,
      ip: this.clientIp(request),
      metadata: { role: role.name, created: true, permissionNames: role.permissionNames },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetUuid: role.uuid,
      metadata: { role: role.name, created: true },
    })

    return this.json({ role })
  }

  /**
   * Standard Red Notes: delete an admin-created CUSTOM role. The use case guards
   * that a built-in role can never be deleted and that the role is unused (no
   * group confers it, no user holds it directly). Audit-logged.
   */
  async deleteCustomRole(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doDeleteCustomRole === undefined) {
      return this.json({ error: { message: 'Custom role management is not available.' } }, 500)
    }

    const { roleUuid } = request.params as Record<string, string>

    const result = await this.doDeleteCustomRole.execute({ roleUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const deleted = result.getValue()

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetType: 'role',
      targetUuid: deleted.uuid,
      ip: this.clientIp(request),
      metadata: { role: deleted.name, deleted: true },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.RoleChanged,
      targetUuid: deleted.uuid,
      metadata: { role: deleted.name, deleted: true },
    })

    return this.json({ success: true, roleUuid: deleted.uuid, name: deleted.name })
  }

  /**
   * Standard Red Notes: the permission CATALOG browser — every seeded permission
   * with its derived category and the roles that grant it. Read-only.
   */
  async getPermissionCatalog(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doGetPermissionCatalog === undefined) {
      return this.json({ error: { message: 'Permission catalog is not available.' } }, 500)
    }

    const result = await this.doGetPermissionCatalog.execute()
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json(result.getValue())
  }

  /**
   * Standard Red Notes: role INSPECTOR — who holds a role: the count of users
   * assigned it directly plus the groups that confer it. Read-only.
   */
  async getRoleHolders(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doGetRoleHolders === undefined) {
      return this.json({ error: { message: 'Role inspector is not available.' } }, 500)
    }

    const { roleUuid } = request.params as Record<string, string>

    const result = await this.doGetRoleHolders.execute({ roleUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json(result.getValue())
  }

  /**
   * Standard Red Notes: effective-permissions SIMULATOR — resolve an arbitrary
   * set of role names to the union of the permissions they grant. Body:
   * { roleNames: string[] }. Read-only.
   */
  async resolveRoleSetPermissions(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doResolveRoleSetPermissions === undefined) {
      return this.json({ error: { message: 'Permission simulator is not available.' } }, 500)
    }

    const { roleNames } = request.body as { roleNames?: string[] }

    const result = await this.doResolveRoleSetPermissions.execute({ roleNames: roleNames ?? [] })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json(result.getValue())
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

  /**
   * Standard Red Notes: the admin/creator-facing projection of an invite link.
   * NEVER includes the raw token (shown only once at create). `status`/
   * `remainingUses` are derived against `now`.
   */
  protected inviteLinkView(link: SignupInviteLink, now: Date): Record<string, unknown> {
    return {
      uuid: link.id.toString(),
      label: link.props.label,
      maxUses: link.props.maxUses,
      usedCount: link.props.usedCount,
      remainingUses: link.remainingUses(),
      expiresAt: link.props.expiresAt ? link.props.expiresAt.toISOString() : null,
      revoked: link.props.revoked,
      status: link.status(now),
      defaultRole: link.props.defaultRole,
      allowedDomain: link.props.allowedDomain,
      autoApprove: link.props.autoApprove,
      createdByKind: link.props.createdByKind,
      createdByUserUuid: link.props.createdByUserUuid,
      createdAt: link.props.createdAt.toISOString(),
    }
  }

  /**
   * Standard Red Notes: create a signup INVITE link (admin). Returns the raw
   * token + relative path exactly ONCE — the web admin composes the absolute URL
   * from window.location.origin. Admin-gated + audited + webhook.
   */
  async createInviteLink(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doCreateSignupInviteLink === undefined) {
      return this.json({ error: { message: 'Signup invite links are not available.' } }, 500)
    }

    const { maxUses, expiresInHours, label, defaultRole, allowedDomain, autoApprove } = request.body as {
      maxUses?: number
      expiresInHours?: number | null
      label?: string | null
      defaultRole?: string | null
      allowedDomain?: string | null
      autoApprove?: boolean
    }

    const result = await this.doCreateSignupInviteLink.execute({
      creatorKind: 'admin',
      adminUuid: this.actorUuid(response),
      maxUses,
      expiresInHours,
      label,
      defaultRole,
      allowedDomain,
      autoApprove,
    })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const { link, token } = result.getValue()

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.InviteLinkCreated,
      targetType: 'signup_invite_link',
      targetUuid: link.id.toString(),
      ip: this.clientIp(request),
      // Never the raw token — only non-sensitive metadata.
      metadata: { maxUses: link.props.maxUses, allowedDomain: link.props.allowedDomain },
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.InviteLinkCreated,
      targetUuid: link.id.toString(),
      metadata: { maxUses: link.props.maxUses },
    })

    const now = new Date()

    return this.json({
      inviteLink: {
        ...this.inviteLinkView(link, now),
        token,
        path: `/?invite=${encodeURIComponent(token)}`,
      },
    })
  }

  /**
   * Standard Red Notes: list every signup invite link (admin). Read-only, so no
   * audit entry. Never returns the raw token.
   */
  async listInviteLinks(_request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doListSignupInviteLinks === undefined) {
      return this.json({ error: { message: 'Signup invite links are not available.' } }, 500)
    }

    const result = await this.doListSignupInviteLinks.execute({})
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const now = new Date()

    return this.json({ inviteLinks: result.getValue().map((link) => this.inviteLinkView(link, now)) })
  }

  /**
   * Standard Red Notes: soft-revoke a signup invite link by uuid (admin).
   * Admin-gated + audited + webhook.
   */
  async revokeInviteLink(request: Request, response?: Response): Promise<results.JsonResult> {
    if (!this.requestorIsAdmin(response)) {
      return this.json({ error: { message: 'Admin role required.' } }, 403)
    }
    if (this.doRevokeSignupInviteLink === undefined) {
      return this.json({ error: { message: 'Signup invite links are not available.' } }, 500)
    }

    const { uuid } = request.params as Record<string, string>

    const result = await this.doRevokeSignupInviteLink.execute({ uuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    await this.auditLogWriter?.write({
      actorUuid: this.actorUuid(response),
      action: AuditAction.InviteLinkRevoked,
      targetType: 'signup_invite_link',
      targetUuid: uuid,
      ip: this.clientIp(request),
    })

    await this.dispatchAdminActionWebhook({
      actorUuid: this.actorUuid(response),
      action: AuditAction.InviteLinkRevoked,
      targetUuid: uuid,
    })

    return this.json({ success: true, uuid })
  }
}
