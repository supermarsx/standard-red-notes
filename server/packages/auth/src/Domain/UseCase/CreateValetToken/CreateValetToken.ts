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
    //
    // *** THE TWO BYTE FIGURES ARE NO LONGER HARD-CODED, SO THE ENFORCED
    // ALLOWANCE AND THE REPORTED ALLOWANCE ARE THE SAME NUMBER. ***
    //
    // They were `0` and `-1` unconditionally, which made this branch the sole
    // authority on a row-less account's allowance and made any figure anyone
    // reported about it a guess. They are now read from the SAME scope the
    // self-scoped settings controller reports from and the SAME scope
    // `UpdateStorageQuotaUsedForUser` writes to — the subscription row's uuid when
    // one exists (expired included, which is the other way into this branch), the
    // user's own uuid when none does. Absent settings keep the previous values
    // exactly: usage 0, allowance -1 (unlimited). What changes is that an explicit
    // per-account FILE_UPLOAD_BYTES_LIMIT now actually binds here, so the admin
    // Users tab's storage limit stops being decorative for these accounts.
    if (mostRecentSubscription === undefined || mostRecentSubscription.endsAt < currentTimestamp) {
      const freeScopeUuid = mostRecentSubscription?.uuid ?? dto.userUuid

      const freeTokenData: ValetTokenData = {
        userUuid: dto.userUuid,
        permittedOperation: dto.operation,
        permittedResources: dto.resources,
        uploadBytesUsed: (await this.readByteSetting(freeScopeUuid, SettingName.NAMES.FileUploadBytesUsed)) ?? 0,
        uploadBytesLimit: (await this.readByteSetting(freeScopeUuid, SettingName.NAMES.FileUploadBytesLimit)) ?? -1,
        sharedSubscriptionUuid: undefined,
        regularSubscriptionUuid: `free-${dto.userUuid}`,
      }
      return {
        success: true,
        // UNIQUE per mint: a valet credential is single use at the files
        // service and at the multi-container adapter, so two mints of these
        // identical claims inside one second must not be the same string.
        valetToken: this.tokenEncoder.encodeUniqueExpirableToken(freeTokenData, this.valetTokenTTL),
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

    // UNIQUE per mint -- see the free branch above.
    const valetToken = this.tokenEncoder.encodeUniqueExpirableToken(tokenData, this.valetTokenTTL)

    return { success: true, valetToken }
  }

  /**
   * One FILE_UPLOAD_BYTES_* setting as a finite number, or `undefined` when there
   * is no row and when the row's value is not a number.
   *
   * A non-numeric stored value answers `undefined` rather than `NaN`: `NaN` in a
   * valet token's `uploadBytesLimit` compares false against every bound, which
   * would turn a corrupt setting into a silently unenforceable one.
   */
  private async readByteSetting(userSubscriptionUuid: string, settingName: string): Promise<number | undefined> {
    const settingOrError = await this.getSubscriptionSetting.execute({
      userSubscriptionUuid,
      settingName,
      allowSensitiveRetrieval: false,
    })
    if (settingOrError.isFailed()) {
      return undefined
    }

    const value = +(settingOrError.getValue().setting.props.value as string)

    return Number.isFinite(value) ? value : undefined
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
