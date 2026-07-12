import { Request, Response } from 'express'
import { inject } from 'inversify'
import { controller, httpDelete, httpGet, httpPost, httpPut, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { BaseAdminController } from './Base/BaseAdminController'
import { CreateOfflineSubscriptionToken } from '../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { CreateSubscriptionToken } from '../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { DeleteSetting } from '../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetSetting } from './../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { SetUserBanStatus } from '../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { SetUserSuspension } from '../../Domain/UseCase/SetUserSuspension/SetUserSuspension'
import { DeleteAccount } from '../../Domain/UseCase/DeleteAccount/DeleteAccount'
import { QueryAuditLog } from '../../Domain/UseCase/QueryAuditLog/QueryAuditLog'
import { AuditLogEntry } from '../../Domain/AuditLog/AuditLogEntry'
import { AuditLogEntryHttpProjection } from '../Http/Projection/AuditLogEntryHttpProjection'
import { AuditLogWriterInterface } from '../../Domain/AuditLog/AuditLogWriterInterface'
import { WebhookDispatcherInterface } from '../../Domain/Webhook/WebhookDispatcherInterface'
import { MapperInterface } from '@standardnotes/domain-core'
import { UserRepositoryInterface } from '../../Domain/User/UserRepositoryInterface'
import { LockRepositoryInterface } from '../../Domain/User/LockRepositoryInterface'
import { Group } from '../../Domain/Group/Group'
import { GroupHttpProjection } from '../Http/Projection/GroupHttpProjection'
import { CreateGroup } from '../../Domain/UseCase/CreateGroup/CreateGroup'
import { ListGroups } from '../../Domain/UseCase/ListGroups/ListGroups'
import { DeleteGroup } from '../../Domain/UseCase/DeleteGroup/DeleteGroup'
import { AddUserToGroup } from '../../Domain/UseCase/AddUserToGroup/AddUserToGroup'
import { RemoveUserFromGroup } from '../../Domain/UseCase/RemoveUserFromGroup/RemoveUserFromGroup'
import { SetGroupRoles } from '../../Domain/UseCase/SetGroupRoles/SetGroupRoles'
import { ListGroupMembers } from '../../Domain/UseCase/ListGroupMembers/ListGroupMembers'
import { GetUserEffectivePermissions } from '../../Domain/UseCase/GetUserEffectivePermissions/GetUserEffectivePermissions'
import { ListRolesWithPermissions } from '../../Domain/UseCase/ListRolesWithPermissions/ListRolesWithPermissions'
import { SetRolePermissions } from '../../Domain/UseCase/SetRolePermissions/SetRolePermissions'
import { CreateCustomRole } from '../../Domain/UseCase/CreateCustomRole/CreateCustomRole'
import { DeleteCustomRole } from '../../Domain/UseCase/DeleteCustomRole/DeleteCustomRole'
import { GetPermissionCatalog } from '../../Domain/UseCase/GetPermissionCatalog/GetPermissionCatalog'
import { GetRoleHolders } from '../../Domain/UseCase/GetRoleHolders/GetRoleHolders'
import { ResolveRoleSetPermissions } from '../../Domain/UseCase/ResolveRoleSetPermissions/ResolveRoleSetPermissions'
import { GetRegularSubscriptionForUser } from '../../Domain/UseCase/GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../../Domain/UseCase/GetSubscriptionSetting/GetSubscriptionSetting'
import { SetSubscriptionSettingValue } from '../../Domain/UseCase/SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { RoleServiceInterface } from '../../Domain/Role/RoleServiceInterface'
import { FixStorageQuotaForUser } from '../../Domain/UseCase/FixStorageQuotaForUser/FixStorageQuotaForUser'
import { CreateSignupInviteLink } from '../../Domain/UseCase/CreateSignupInviteLink/CreateSignupInviteLink'
import { ListSignupInviteLinks } from '../../Domain/UseCase/ListSignupInviteLinks/ListSignupInviteLinks'
import { RevokeSignupInviteLink } from '../../Domain/UseCase/RevokeSignupInviteLink/RevokeSignupInviteLink'

@controller('/admin')
export class AnnotatedAdminController extends BaseAdminController {
  constructor(
    @inject(TYPES.Auth_DeleteSetting) override doDeleteSetting: DeleteSetting,
    @inject(TYPES.Auth_GetSetting) override doGetSetting: GetSetting,
    @inject(TYPES.Auth_UserRepository) override userRepository: UserRepositoryInterface,
    @inject(TYPES.Auth_CreateSubscriptionToken) override createSubscriptionToken: CreateSubscriptionToken,
    @inject(TYPES.Auth_CreateOfflineSubscriptionToken)
    override createOfflineSubscriptionToken: CreateOfflineSubscriptionToken,
    @inject(TYPES.Auth_SetSettingValue) override setSettingValue: SetSettingValue,
    @inject(TYPES.Auth_SetUserBanStatus) override setUserBanStatus: SetUserBanStatus,
    @inject(TYPES.Auth_QueryAuditLog) override queryAuditLog: QueryAuditLog,
    @inject(TYPES.Auth_AuditLogEntryHttpMapper)
    override auditLogEntryHttpMapper: MapperInterface<AuditLogEntry, AuditLogEntryHttpProjection>,
    @inject(TYPES.Auth_AuditLogWriter) override auditLogWriter: AuditLogWriterInterface,
    @inject(TYPES.Auth_WebhookDispatcher) override webhookDispatcher: WebhookDispatcherInterface,
    // Standard Red Notes: per-user SERVER storage-limit dependencies (the upload
    // limit is a subscription setting; see BaseAdminController).
    @inject(TYPES.Auth_GetRegularSubscriptionForUser)
    override doGetRegularSubscription: GetRegularSubscriptionForUser,
    @inject(TYPES.Auth_GetSubscriptionSetting) override doGetSubscriptionSetting: GetSubscriptionSetting,
    @inject(TYPES.Auth_SetSubscriptionSettingValue)
    override doSetSubscriptionSettingValue: SetSubscriptionSettingValue,
    // Standard Red Notes: admin-role grant/revoke + reset-mfa/fix-quota panel ops.
    @inject(TYPES.Auth_RoleService) override roleService: RoleServiceInterface,
    @inject(TYPES.Auth_FixStorageQuotaForUser) override doFixStorageQuota: FixStorageQuotaForUser,
    // Standard Red Notes: read-only env master switches for the admin panel.
    @inject(TYPES.Auth_DISABLE_USER_REGISTRATION) override registrationDisabledByEnv: boolean,
    @inject(TYPES.Auth_NEXTCLOUD_BACKUPS_ENABLED) override nextcloudBackupsEnabledByEnv: boolean,
    @inject(TYPES.Auth_CreateGroup) override doCreateGroup: CreateGroup,
    @inject(TYPES.Auth_ListGroups) override doListGroups: ListGroups,
    @inject(TYPES.Auth_DeleteGroup) override doDeleteGroup: DeleteGroup,
    @inject(TYPES.Auth_AddUserToGroup) override doAddUserToGroup: AddUserToGroup,
    @inject(TYPES.Auth_RemoveUserFromGroup) override doRemoveUserFromGroup: RemoveUserFromGroup,
    @inject(TYPES.Auth_SetGroupRoles) override doSetGroupRoles: SetGroupRoles,
    @inject(TYPES.Auth_ListGroupMembers) override doListGroupMembers: ListGroupMembers,
    @inject(TYPES.Auth_GetUserEffectivePermissions)
    override doGetUserEffectivePermissions: GetUserEffectivePermissions,
    @inject(TYPES.Auth_GroupHttpMapper) override groupHttpMapper: MapperInterface<Group, GroupHttpProjection>,
    // Standard Red Notes: RBAC role management (read all roles + edit a role's
    // permission assignments). See BaseAdminController.
    @inject(TYPES.Auth_ListRolesWithPermissions) override doListRolesWithPermissions: ListRolesWithPermissions,
    @inject(TYPES.Auth_SetRolePermissions) override doSetRolePermissions: SetRolePermissions,
    // Standard Red Notes: EXTENSIVE RBAC management use cases (custom roles +
    // catalog browser + role inspector + effective-permissions simulator).
    @inject(TYPES.Auth_CreateCustomRole) override doCreateCustomRole: CreateCustomRole,
    @inject(TYPES.Auth_DeleteCustomRole) override doDeleteCustomRole: DeleteCustomRole,
    @inject(TYPES.Auth_GetPermissionCatalog) override doGetPermissionCatalog: GetPermissionCatalog,
    @inject(TYPES.Auth_GetRoleHolders) override doGetRoleHolders: GetRoleHolders,
    @inject(TYPES.Auth_ResolveRoleSetPermissions) override doResolveRoleSetPermissions: ResolveRoleSetPermissions,
    // Standard Red Notes: failed-login lock repository for the anti-abuse
    // "Locked accounts" list + unlock endpoints.
    @inject(TYPES.Auth_LockRepository) override lockRepository: LockRepositoryInterface,
    // Standard Red Notes: admin SUSPEND/UNSUSPEND + admin-initiated DELETE
    // (delete reuses the existing cross-service DeleteAccount pipeline).
    @inject(TYPES.Auth_SetUserSuspension) override doSetUserSuspension: SetUserSuspension,
    @inject(TYPES.Auth_DeleteAccount) override doDeleteAccount: DeleteAccount,
    // Standard Red Notes: SIGNUP INVITE LINKS admin surface (create/list/revoke).
    @inject(TYPES.Auth_CreateSignupInviteLink) override doCreateSignupInviteLink: CreateSignupInviteLink,
    @inject(TYPES.Auth_ListSignupInviteLinks) override doListSignupInviteLinks: ListSignupInviteLinks,
    @inject(TYPES.Auth_RevokeSignupInviteLink) override doRevokeSignupInviteLink: RevokeSignupInviteLink,
  ) {
    super(
      doDeleteSetting,
      doGetSetting,
      userRepository,
      createSubscriptionToken,
      createOfflineSubscriptionToken,
      setSettingValue,
      setUserBanStatus,
      queryAuditLog,
      auditLogEntryHttpMapper,
      auditLogWriter,
      undefined,
      webhookDispatcher,
      doGetRegularSubscription,
      doGetSubscriptionSetting,
      doSetSubscriptionSettingValue,
      roleService,
      doFixStorageQuota,
      registrationDisabledByEnv,
      nextcloudBackupsEnabledByEnv,
      doCreateGroup,
      doListGroups,
      doDeleteGroup,
      doAddUserToGroup,
      doRemoveUserFromGroup,
      doSetGroupRoles,
      doListGroupMembers,
      doGetUserEffectivePermissions,
      groupHttpMapper,
      doListRolesWithPermissions,
      doSetRolePermissions,
      doCreateCustomRole,
      doDeleteCustomRole,
      doGetPermissionCatalog,
      doGetRoleHolders,
      doResolveRoleSetPermissions,
      lockRepository,
      doSetUserSuspension,
      doDeleteAccount,
      doCreateSignupInviteLink,
      doListSignupInviteLinks,
      doRevokeSignupInviteLink,
    )
  }

  @httpGet('/user/:email')
  override async getUser(request: Request): Promise<results.JsonResult> {
    return super.getUser(request)
  }

  @httpGet('/users/:userUuid/listed-code')
  override async getListedCode(request: Request): Promise<results.JsonResult> {
    return super.getListedCode(request)
  }

  @httpDelete('/users/:userUuid/mfa')
  override async deleteMFASetting(request: Request): Promise<results.JsonResult> {
    return super.deleteMFASetting(request)
  }

  @httpPost('/users/:userUuid/subscription-token')
  override async createToken(request: Request): Promise<results.JsonResult> {
    return super.createToken(request)
  }

  @httpPost('/users/:email/offline-subscription-token')
  override async createOfflineToken(request: Request): Promise<results.JsonResult | results.BadRequestResult> {
    return super.createOfflineToken(request)
  }

  @httpPost('/users/:userUuid/email-backups')
  override async disableEmailBackups(
    request: Request,
  ): Promise<results.BadRequestErrorMessageResult | results.OkResult> {
    return super.disableEmailBackups(request)
  }

  // Standard Red Notes: every admin-panel route below attaches the required
  // cross-service-token middleware. It decodes the X-Auth-Token the api-gateway
  // forwards onto response.locals (user + roles), which is what the
  // BaseAdminController's requestorIsAdmin() gate and the audit-log actor
  // attribution read. Without it locals.roles stays empty and every admin
  // endpoint 403s even for genuine ADMIN_USER admins. The six legacy
  // internal routes above are deliberately left as-is: they predate the panel,
  // are not reachable through the public gateway, and stay internal-only.
  @httpGet('/lookup-user/:email', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async lookupUser(request: Request, response: Response): Promise<results.JsonResult> {
    return super.lookupUser(request, response)
  }

  @httpGet('/users/:userUuid/feature-flags', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getUserFeatureFlags(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserFeatureFlags(request, response)
  }

  @httpPut('/users/:userUuid/feature-flags', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setUserFeatureFlag(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setUserFeatureFlag(request, response)
  }

  @httpGet('/users/:email/ban-status', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getUserBanStatus(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserBanStatus(request, response)
  }

  @httpPut('/users/:userUuid/ban-status', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setUserBanStatusEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setUserBanStatusEndpoint(request, response)
  }

  // Standard Red Notes: SUSPENSION — a reversible admin hold, separate from ban.
  @httpGet('/users/:email/suspension-status', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getUserSuspensionStatus(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserSuspensionStatus(request, response)
  }

  @httpPut('/users/:userUuid/suspension', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setUserSuspensionEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setUserSuspensionEndpoint(request, response)
  }

  @httpGet('/registration', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getRegistrationFlag(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getRegistrationFlag(request, response)
  }

  @httpPut('/registration', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setRegistrationFlag(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setRegistrationFlag(request, response)
  }

  @httpGet('/audit-log', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getAuditLog(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getAuditLog(request, response)
  }

  // NOTE: exact '/users' — distinct from the '/users/:userUuid/...' sub-routes.
  @httpGet('/users', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getUsers(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUsers(request, response)
  }

  @httpGet('/roles', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getAvailableRoles(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getAvailableRoles(request, response)
  }

  // NOTE: '/roles/detailed' — distinct from the '/roles' name-list above and
  // from '/roles/:roleUuid/permissions' below.
  @httpGet('/roles/detailed', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async listRolesWithPermissions(request: Request, response: Response): Promise<results.JsonResult> {
    return super.listRolesWithPermissions(request, response)
  }

  @httpPut('/roles/:roleUuid/permissions', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setRolePermissions(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setRolePermissions(request, response)
  }

  // Standard Red Notes: the permission CATALOG browser (grouped + granted-by).
  @httpGet('/permissions', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getPermissionCatalog(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getPermissionCatalog(request, response)
  }

  // Standard Red Notes: effective-permissions SIMULATOR for a set of role names.
  // NOTE: static '/roles/resolve-permissions' — declared before the '/roles'
  // create route and distinct from the ':roleUuid' param routes.
  @httpPost('/roles/resolve-permissions', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async resolveRoleSetPermissions(request: Request, response: Response): Promise<results.JsonResult> {
    return super.resolveRoleSetPermissions(request, response)
  }

  // Standard Red Notes: create an admin-defined CUSTOM role (group-conferrable).
  @httpPost('/roles', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async createCustomRole(request: Request, response: Response): Promise<results.JsonResult> {
    return super.createCustomRole(request, response)
  }

  // Standard Red Notes: role INSPECTOR — who holds a role (direct users + groups).
  @httpGet('/roles/:roleUuid/holders', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getRoleHolders(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getRoleHolders(request, response)
  }

  // Standard Red Notes: delete an admin-created CUSTOM role (built-ins guarded).
  @httpDelete('/roles/:roleUuid', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async deleteCustomRole(request: Request, response: Response): Promise<results.JsonResult> {
    return super.deleteCustomRole(request, response)
  }

  @httpGet('/groups', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async listGroups(request: Request, response: Response): Promise<results.JsonResult> {
    return super.listGroups(request, response)
  }

  @httpPost('/groups', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async createGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.createGroup(request, response)
  }

  @httpDelete('/groups/:groupUuid', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async deleteGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.deleteGroup(request, response)
  }

  @httpPut('/groups/:groupUuid/roles', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setGroupRoles(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setGroupRoles(request, response)
  }

  @httpGet('/groups/:groupUuid/members', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async listGroupMembers(request: Request, response: Response): Promise<results.JsonResult> {
    return super.listGroupMembers(request, response)
  }

  @httpPost('/groups/:groupUuid/members', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async addUserToGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.addUserToGroup(request, response)
  }

  @httpDelete('/groups/:groupUuid/members/:userUuid', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async removeUserFromGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.removeUserFromGroup(request, response)
  }

  @httpGet('/users/:userUuid/effective-permissions', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getUserEffectivePermissions(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserEffectivePermissions(request, response)
  }

  @httpPut('/users/:userUuid/admin-role', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setUserAdminRole(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setUserAdminRole(request, response)
  }

  // NOTE: '/users/:userUuid/mfa-secret', not '/users/:userUuid/mfa' — the latter
  // is the pre-existing internal (ungated) deleteMFASetting route above.
  @httpDelete('/users/:userUuid/mfa-secret', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async resetUserMFA(request: Request, response: Response): Promise<results.JsonResult> {
    return super.resetUserMFA(request, response)
  }

  // Standard Red Notes: admin-initiated HARD DELETE of a user. Declared AFTER
  // every specific '/users/:userUuid/...' delete above (mfa, mfa-secret) so the
  // bare ':userUuid' path can never shadow them. Reuses the cross-service
  // DeleteAccount pipeline; body must carry a matching `confirmEmail`.
  @httpDelete('/users/:userUuid', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async deleteUser(request: Request, response: Response): Promise<results.JsonResult> {
    return super.deleteUser(request, response)
  }

  @httpPost('/users/:userUuid/fix-quota', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async fixUserQuota(request: Request, response: Response): Promise<results.JsonResult> {
    return super.fixUserQuota(request, response)
  }

  // Standard Red Notes: anti-abuse "Locked accounts" list + unlock. The gateway
  // proxies /v1/admin/anti-abuse/locked-accounts and /v1/admin/anti-abuse/unlock
  // here; both re-gate on the ADMIN_USER role in the base controller.
  @httpGet('/anti-abuse/locked-accounts', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  async getLockedAccountsEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getLockedAccounts(request, response)
  }

  @httpPost('/anti-abuse/unlock', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  async unlockAccountEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.unlockAccount(request, response)
  }

  // Standard Red Notes: SIGNUP INVITE LINKS — create / list / soft-revoke. The
  // gateway proxies /v1/admin/invite-links* here; all re-gate on ADMIN_USER in
  // the base controller. NOTE: the ':uuid' revoke is declared last so the bare
  // param path never shadows the exact '/invite-links'.
  @httpPost('/invite-links', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  async createInviteLinkEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.createInviteLink(request, response)
  }

  @httpGet('/invite-links', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  async listInviteLinksEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.listInviteLinks(request, response)
  }

  @httpDelete('/invite-links/:uuid', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  async revokeInviteLinkEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.revokeInviteLink(request, response)
  }
}
