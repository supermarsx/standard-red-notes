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
import { QueryAuditLog } from '../../Domain/UseCase/QueryAuditLog/QueryAuditLog'
import { AuditLogEntry } from '../../Domain/AuditLog/AuditLogEntry'
import { AuditLogEntryHttpProjection } from '../Http/Projection/AuditLogEntryHttpProjection'
import { AuditLogWriterInterface } from '../../Domain/AuditLog/AuditLogWriterInterface'
import { WebhookDispatcherInterface } from '../../Domain/Webhook/WebhookDispatcherInterface'
import { MapperInterface } from '@standardnotes/domain-core'
import { UserRepositoryInterface } from '../../Domain/User/UserRepositoryInterface'
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
import { GetRegularSubscriptionForUser } from '../../Domain/UseCase/GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../../Domain/UseCase/GetSubscriptionSetting/GetSubscriptionSetting'
import { SetSubscriptionSettingValue } from '../../Domain/UseCase/SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { RoleServiceInterface } from '../../Domain/Role/RoleServiceInterface'
import { FixStorageQuotaForUser } from '../../Domain/UseCase/FixStorageQuotaForUser/FixStorageQuotaForUser'

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
  // endpoint 403s even for genuine INTERNAL_TEAM_USER admins. The six legacy
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

  @httpPost('/users/:userUuid/fix-quota', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async fixUserQuota(request: Request, response: Response): Promise<results.JsonResult> {
    return super.fixUserQuota(request, response)
  }
}
