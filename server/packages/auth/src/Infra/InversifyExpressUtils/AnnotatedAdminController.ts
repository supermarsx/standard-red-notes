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

  @httpGet('/lookup-user/:email')
  override async lookupUser(request: Request, response: Response): Promise<results.JsonResult> {
    return super.lookupUser(request, response)
  }

  @httpGet('/users/:userUuid/feature-flags')
  override async getUserFeatureFlags(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserFeatureFlags(request, response)
  }

  @httpPut('/users/:userUuid/feature-flags')
  override async setUserFeatureFlag(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setUserFeatureFlag(request, response)
  }

  @httpGet('/users/:email/ban-status')
  override async getUserBanStatus(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserBanStatus(request, response)
  }

  @httpPut('/users/:userUuid/ban-status')
  override async setUserBanStatusEndpoint(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setUserBanStatusEndpoint(request, response)
  }

  @httpGet('/registration')
  override async getRegistrationFlag(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getRegistrationFlag(request, response)
  }

  @httpPut('/registration')
  override async setRegistrationFlag(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setRegistrationFlag(request, response)
  }

  @httpGet('/audit-log')
  override async getAuditLog(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getAuditLog(request, response)
  }

  @httpGet('/roles')
  override async getAvailableRoles(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getAvailableRoles(request, response)
  }

  @httpGet('/groups')
  override async listGroups(request: Request, response: Response): Promise<results.JsonResult> {
    return super.listGroups(request, response)
  }

  @httpPost('/groups')
  override async createGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.createGroup(request, response)
  }

  @httpDelete('/groups/:groupUuid')
  override async deleteGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.deleteGroup(request, response)
  }

  @httpPut('/groups/:groupUuid/roles')
  override async setGroupRoles(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setGroupRoles(request, response)
  }

  @httpGet('/groups/:groupUuid/members')
  override async listGroupMembers(request: Request, response: Response): Promise<results.JsonResult> {
    return super.listGroupMembers(request, response)
  }

  @httpPost('/groups/:groupUuid/members')
  override async addUserToGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.addUserToGroup(request, response)
  }

  @httpDelete('/groups/:groupUuid/members/:userUuid')
  override async removeUserFromGroup(request: Request, response: Response): Promise<results.JsonResult> {
    return super.removeUserFromGroup(request, response)
  }

  @httpGet('/users/:userUuid/effective-permissions')
  override async getUserEffectivePermissions(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserEffectivePermissions(request, response)
  }
}
