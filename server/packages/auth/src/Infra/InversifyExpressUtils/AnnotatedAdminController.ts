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
import { UserRepositoryInterface } from '../../Domain/User/UserRepositoryInterface'

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
  ) {
    super(
      doDeleteSetting,
      doGetSetting,
      userRepository,
      createSubscriptionToken,
      createOfflineSubscriptionToken,
      setSettingValue,
      setUserBanStatus,
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
}
