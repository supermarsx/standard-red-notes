import { Result, SettingName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { UserSubscription } from '../../Subscription/UserSubscription'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { UpdateStorageQuotaUsedForUserDTO } from './UpdateStorageQuotaUsedForUserDTO'
import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../GetSubscriptionSetting/GetSubscriptionSetting'
import { SetSubscriptionSettingValue } from '../SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { Logger } from 'winston'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'

export class UpdateStorageQuotaUsedForUser implements UseCaseInterface<void> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private getRegularSubscription: GetRegularSubscriptionForUser,
    private getSharedSubscription: GetSharedSubscriptionForUser,
    private getSubscriptionSetting: GetSubscriptionSetting,
    private setSubscriptonSettingValue: SetSubscriptionSettingValue,
    private logger: Logger,
  ) {}

  async execute(dto: UpdateStorageQuotaUsedForUserDTO): Promise<Result<void>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail(`Could not find user with uuid: ${userUuid.value}`)
    }

    const sharedSubscriptionOrError = await this.getSharedSubscription.execute({
      userUuid: user.uuid,
    })
    let sharedSubscription: UserSubscription | undefined
    if (!sharedSubscriptionOrError.isFailed()) {
      sharedSubscription = sharedSubscriptionOrError.getValue()
      await this.updateUploadBytesUsedSetting(sharedSubscription.uuid, dto)
    }

    const regularSubscriptionOrError = await this.getRegularSubscription.execute({
      userUuid: sharedSubscription ? undefined : user.uuid,
      subscriptionId: sharedSubscription ? (sharedSubscription.subscriptionId as number) : undefined,
    })
    if (regularSubscriptionOrError.isFailed()) {
      /**
       * *** THIS RETURN USED TO BE A `Result.fail`, AND IT IS WHY SELF-HOSTED
       * ACCOUNTS HAD NO USAGE FIGURE AT ALL. ***
       *
       * The default entitlement mode on this fork is `included`
       * (`Container.ts`: `STANDARD_RED_ENTITLEMENT_MODE` defaults to it), under
       * which `Register` never calls `ActivatePremiumFeatures` and therefore NEVER
       * creates a `user_subscriptions` row — while `GetUserSubscription` still
       * synthesises a PRO_PLAN subscription for the client. Every upload, every
       * delete and every quota recalculation reached this branch, logged nothing
       * and wrote nothing, so `FILE_UPLOAD_BYTES_USED` did not exist for any
       * account on any default deployment.
       *
       * A row-less account's bookkeeping now lands under the USER's own uuid —
       * the same identity `createIncludedSubscription` hands the client as its
       * synthetic subscription uuid, and the identity `CreateValetToken` reads its
       * free-token byte figures from. Nothing is invented: it is the same table,
       * the same setting name and the same +/- arithmetic, which is what keeps
       * uploads and deletes symmetrical.
       *
       * A shared subscriber whose share OWNER has no regular subscription is a
       * genuinely broken share and still fails: the invitee's own total was
       * already written above, and inventing a second scope on top of a shared one
       * would double-count.
       */
      if (sharedSubscription !== undefined) {
        return Result.fail(`Could not find regular user subscription for user with uuid: ${userUuid.value}`)
      }

      await this.updateUploadBytesUsedSetting(user.uuid, dto)

      return Result.ok()
    }
    const regularSubscription = regularSubscriptionOrError.getValue()

    await this.updateUploadBytesUsedSetting(regularSubscription.uuid, dto)

    return Result.ok()
  }

  /**
   * *** THIS MUST NEVER THROW, AND A LIVE UPLOAD IS WHAT PROVED IT. ***
   *
   * On the single-container topology the domain-event bus is `DirectCallDomainEventPublisher`,
   * which `await`s its handlers inside the publisher — so an exception raised here
   * travels back out of `FinishUploadSession`'s own try/catch and the UPLOAD
   * answers `400 Could not finish upload session`. The failed `Result` below was
   * already handled; a throw was not, and a database constraint refusing the
   * INSERT turned a missing bookkeeping figure into a refused file upload.
   *
   * The ordering is deliberate: losing a usage total costs the quota, which cannot
   * be enforced or warned about from a figure nobody is keeping — and the client's
   * diagnostics pane reports exactly that, as a degradation. Losing the upload
   * costs the user their file. So the write is contained, logged by SETTING NAME
   * and scope uuid only, and the caller continues.
   */
  private async updateUploadBytesUsedSetting(
    userSubscriptionUuid: string,
    dto: UpdateStorageQuotaUsedForUserDTO,
  ): Promise<void> {
    try {
      let bytesAlreadyUsed = '0'

      // An ABSOLUTE write does not read the current total at all: the figure it
      // was handed IS the total, and reading first would only widen the window in
      // which a concurrent upload can be counted twice.
      if (!dto.absolute) {
        const bytesUsedSettingExists = await this.getSubscriptionSetting.execute({
          userSubscriptionUuid,
          settingName: SettingName.NAMES.FileUploadBytesUsed,
          allowSensitiveRetrieval: false,
        })

        if (!bytesUsedSettingExists.isFailed()) {
          const bytesUsedSetting = bytesUsedSettingExists.getValue()
          bytesAlreadyUsed = bytesUsedSetting.setting.props.value as string
        }
      }

      const bytesUsedNewTotal = +bytesAlreadyUsed + dto.bytesUsed
      const bytesUsedValue = bytesUsedNewTotal < 0 ? 0 : bytesUsedNewTotal

      const result = await this.setSubscriptonSettingValue.execute({
        userSubscriptionUuid,
        settingName: SettingName.NAMES.FileUploadBytesUsed,
        value: bytesUsedValue.toString(),
      })

      if (result.isFailed()) {
        this.logger.error(`Could not set file upload bytes used for subscription ${userSubscriptionUuid}`)
      }
    } catch (error) {
      this.logger.error(
        `Could not set file upload bytes used for subscription ${userSubscriptionUuid}: ${(error as Error).message}`,
      )
    }
  }
}
