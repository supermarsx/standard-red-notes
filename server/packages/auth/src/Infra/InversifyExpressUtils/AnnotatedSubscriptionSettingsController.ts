import { Request, Response } from 'express'
import { inject } from 'inversify'
import { controller, httpGet, httpPut, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { BaseSubscriptionSettingsController } from './Base/BaseSubscriptionSettingsController'
import { GetSharedOrRegularSubscriptionForUser } from '../../Domain/UseCase/GetSharedOrRegularSubscriptionForUser/GetSharedOrRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../../Domain/UseCase/GetSubscriptionSetting/GetSubscriptionSetting'
import { MapperInterface } from '@standardnotes/domain-core'
import { SubscriptionSetting } from '../../Domain/Setting/SubscriptionSetting'
import { SubscriptionSettingHttpRepresentation } from '../../Mapping/Http/SubscriptionSettingHttpRepresentation'
import { SetSubscriptionSettingValue } from '../../Domain/UseCase/SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { TriggerPostSettingUpdateActions } from '../../Domain/UseCase/TriggerPostSettingUpdateActions/TriggerPostSettingUpdateActions'
import { Logger } from 'winston'
import { ResolveFileQuotaScope } from '../../Domain/UseCase/ResolveFileQuotaScope/ResolveFileQuotaScope'
import { SubscriptionSettingsAssociationServiceInterface } from '../../Domain/Setting/SubscriptionSettingsAssociationServiceInterface'

@controller('/users/:userUuid')
export class AnnotatedSubscriptionSettingsController extends BaseSubscriptionSettingsController {
  constructor(
    @inject(TYPES.Auth_GetSubscriptionSetting) override doGetSetting: GetSubscriptionSetting,
    @inject(TYPES.Auth_GetSharedOrRegularSubscriptionForUser)
    override getSharedOrRegularSubscription: GetSharedOrRegularSubscriptionForUser,
    @inject(TYPES.Auth_SetSubscriptionSettingValue) override setSubscriptionSettingValue: SetSubscriptionSettingValue,
    @inject(TYPES.Auth_TriggerPostSettingUpdateActions)
    override triggerPostSettingUpdateActions: TriggerPostSettingUpdateActions,
    @inject(TYPES.Auth_SubscriptionSettingHttpMapper)
    override subscriptionSettingMapper: MapperInterface<SubscriptionSetting, SubscriptionSettingHttpRepresentation>,
    @inject(TYPES.Auth_Logger) override logger: Logger,
    // Standard Red Notes: the file-quota scope resolver + the plan-default
    // allowance source, so this (multi-container) route answers the same
    // effective allowance the single-container one does. See
    // BaseSubscriptionSettingsController.getSubscriptionSetting.
    @inject(TYPES.Auth_ResolveFileQuotaScope) override resolveFileQuotaScope: ResolveFileQuotaScope,
    @inject(TYPES.Auth_SubscriptionSettingsAssociationService)
    override subscriptionSettingsAssociationService: SubscriptionSettingsAssociationServiceInterface,
  ) {
    super(
      doGetSetting,
      getSharedOrRegularSubscription,
      setSubscriptionSettingValue,
      triggerPostSettingUpdateActions,
      subscriptionSettingMapper,
      logger,
      undefined,
      resolveFileQuotaScope,
      subscriptionSettingsAssociationService,
    )
  }

  @httpGet('/subscription-settings/:subscriptionSettingName', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getSubscriptionSetting(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getSubscriptionSetting(request, response)
  }

  @httpPut('/subscription-settings', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async updateSubscriptionSetting(
    request: Request,
    response: Response,
  ): Promise<results.JsonResult | results.StatusCodeResult> {
    return super.updateSubscriptionSetting(request, response)
  }
}
