import { SubscriptionName } from '@standardnotes/common'
import { TimerInterface } from '@standardnotes/time'
import { TokenEncoderInterface, ValetTokenData } from '@standardnotes/security'
import { CreateValetTokenResponseData } from '@standardnotes/responses'

import { UseCaseInterface } from '../UseCaseInterface'

import { CreateValetTokenDTO } from './CreateValetTokenDTO'
import { SubscriptionSettingsAssociationServiceInterface } from '../../Setting/SubscriptionSettingsAssociationServiceInterface'
import { CreateValetTokenPayload } from '../../ValetToken/CreateValetTokenPayload'
import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'
import { GetSubscriptionSetting } from '../GetSubscriptionSetting/GetSubscriptionSetting'
import { SettingName } from '@standardnotes/domain-core'
import { UserSubscription } from '../../Subscription/UserSubscription'

export class CreateValetToken implements UseCaseInterface {
  constructor(
    private tokenEncoder: TokenEncoderInterface<ValetTokenData>,
    private subscriptionSettingsAssociationService: SubscriptionSettingsAssociationServiceInterface,
    private getRegularSubscription: GetRegularSubscriptionForUser,
    private getSharedSubscription: GetSharedSubscriptionForUser,
    private getSubscriptionSetting: GetSubscriptionSetting,
    private timer: TimerInterface,
    private valetTokenTTL: number,
  ) {}

  async execute(dto: CreateValetTokenDTO): Promise<CreateValetTokenResponseData> {
    const { userUuid, ...payload } = dto
    const currentTimestamp = this.timer.getTimestampInMicroseconds()

    const sharedSubscription = await this.getEligibleSharedSubscription(userUuid)
    const ownersRegularSubscription = await this.getSharedOwnersRegularSubscription(sharedSubscription)
    const mostRecentSubscription = await this.getMostRecentSubscription(dto.userUuid, ownersRegularSubscription)

    if (!this.isValidWritePayload(payload)) {
      return {
        success: false,
        reason: 'invalid-parameters',
      }
    }

    // Single-tier, fully-free instance: an account without an active subscription
    // is granted UNLIMITED file storage (uploadBytesLimit = -1) instead of being
    // blocked. The valet token is HMAC-signed and self-contained, so the
    // files-server trusts the limit without a backing subscription record.
    if (mostRecentSubscription === undefined || mostRecentSubscription.endsAt < currentTimestamp) {
      const freeTokenData: ValetTokenData = {
        userUuid: dto.userUuid,
        permittedOperation: dto.operation,
        permittedResources: dto.resources,
        uploadBytesUsed: 0,
        uploadBytesLimit: -1,
        sharedSubscriptionUuid: undefined,
        regularSubscriptionUuid: `free-${dto.userUuid}`,
      }
      return {
        success: true,
        valetToken: this.tokenEncoder.encodeExpirableToken(freeTokenData, this.valetTokenTTL),
      }
    }

    const regularSubscription = mostRecentSubscription
    const selectedSharedSubscription =
      ownersRegularSubscription?.uuid === regularSubscription.uuid ? sharedSubscription : undefined

    let uploadBytesUsed = 0
    const uploadBytesUsedSettingOrError = await this.getSubscriptionSetting.execute({
      userSubscriptionUuid: regularSubscription.uuid,
      settingName: SettingName.NAMES.FileUploadBytesUsed,
      allowSensitiveRetrieval: false,
    })
    if (!uploadBytesUsedSettingOrError.isFailed()) {
      const uploadBytesUsedSetting = uploadBytesUsedSettingOrError.getValue()
      uploadBytesUsed = +(uploadBytesUsedSetting.setting.props.value as string)
    }

    const defaultUploadBytesLimitForSubscription = await this.subscriptionSettingsAssociationService.getFileUploadLimit(
      regularSubscription.planName as SubscriptionName,
    )
    let uploadBytesLimit = defaultUploadBytesLimitForSubscription
    const overwriteWithUserUploadBytesLimitSettingOrError = await this.getSubscriptionSetting.execute({
      userSubscriptionUuid: regularSubscription.uuid,
      settingName: SettingName.NAMES.FileUploadBytesLimit,
      allowSensitiveRetrieval: false,
    })
    if (!overwriteWithUserUploadBytesLimitSettingOrError.isFailed()) {
      const overwriteWithUserUploadBytesLimitSetting = overwriteWithUserUploadBytesLimitSettingOrError.getValue()
      uploadBytesLimit = +(overwriteWithUserUploadBytesLimitSetting.setting.props.value as string)
    }

    const tokenData: ValetTokenData = {
      userUuid: dto.userUuid,
      permittedOperation: dto.operation,
      permittedResources: dto.resources,
      uploadBytesUsed,
      uploadBytesLimit,
      sharedSubscriptionUuid: selectedSharedSubscription?.uuid,
      regularSubscriptionUuid: regularSubscription.uuid,
    }

    const valetToken = this.tokenEncoder.encodeExpirableToken(tokenData, this.valetTokenTTL)

    return { success: true, valetToken }
  }

  private async getEligibleSharedSubscription(userUuid: string): Promise<UserSubscription | undefined> {
    const sharedSubscriptionOrError = await this.getSharedSubscription.execute({ userUuid })
    if (sharedSubscriptionOrError.isFailed()) {
      return undefined
    }

    const sharedSubscription = sharedSubscriptionOrError.getValue()
    const sharedSubscriptionId = sharedSubscription?.subscriptionId ?? undefined

    return sharedSubscription !== undefined && sharedSubscriptionId !== undefined ? sharedSubscription : undefined
  }

  private async getSharedOwnersRegularSubscription(
    activeSharedSubscription: UserSubscription | undefined,
  ): Promise<UserSubscription | undefined> {
    const sharedSubscriptionId = activeSharedSubscription?.subscriptionId ?? undefined
    if (sharedSubscriptionId === undefined) {
      return undefined
    }

    const regularSubscriptionFromSharedOrError = await this.getRegularSubscription.execute({
      subscriptionId: sharedSubscriptionId,
    })
    if (regularSubscriptionFromSharedOrError.isFailed()) {
      return undefined
    }

    return regularSubscriptionFromSharedOrError.getValue()
  }

  private async getMostRecentSubscription(
    userUuid: string,
    ownersRegularSubscription: UserSubscription | undefined,
  ): Promise<UserSubscription | undefined> {
    const regularSubscriptionByUserOrError = await this.getRegularSubscription.execute({
      userUuid,
    })
    const usersRegularSubscription = regularSubscriptionByUserOrError.isFailed()
      ? undefined
      : regularSubscriptionByUserOrError.getValue()

    if (ownersRegularSubscription === undefined) {
      return usersRegularSubscription
    }
    if (usersRegularSubscription === undefined) {
      return ownersRegularSubscription
    }

    return ownersRegularSubscription.endsAt >= usersRegularSubscription.endsAt
      ? ownersRegularSubscription
      : usersRegularSubscription
  }

  private isValidWritePayload(payload: CreateValetTokenPayload) {
    if (payload.operation === 'write') {
      for (const resource of payload.resources) {
        if (resource.unencryptedFileSize === undefined) {
          return false
        }
      }
    }

    return true
  }
}
