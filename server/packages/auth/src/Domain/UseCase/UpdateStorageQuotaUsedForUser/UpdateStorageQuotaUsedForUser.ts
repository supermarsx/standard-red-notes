import { Result, SettingName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { safeErrorLogMetadata } from '../../Logging/SafeLog'
import { UserSubscription } from '../../Subscription/UserSubscription'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { UpdateStorageQuotaUsedForUserDTO } from './UpdateStorageQuotaUsedForUserDTO'
import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../GetSubscriptionSetting/GetSubscriptionSetting'
import { SetSubscriptionSettingValue } from '../SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { Logger } from 'winston'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'

export class UpdateStorageQuotaUsedForUser implements UseCaseInterface<void> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private getRegularSubscription: GetRegularSubscriptionForUser,
    private getSharedSubscription: GetSharedSubscriptionForUser,
    private getSubscriptionSetting: GetSubscriptionSetting,
    private setSubscriptonSettingValue: SetSubscriptionSettingValue,
    private logger: Logger,
    private domainEventFactory: DomainEventFactoryInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
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
      await this.updateUploadBytesUsedSetting(sharedSubscription.uuid, dto, null)
    }

    // Standard Red Notes: whose files a recalculation would be OF, when the
    // arithmetic below has nothing to stand on (see `updateUploadBytesUsedSetting`).
    // Only when the recount would be the right answer: the delta is about the
    // account's own storage (a vault file is stored under the vault, so the
    // recount would not contain it), and the account is the sole contributor to
    // its own total (under a shared subscription the owner's figure is several
    // accounts' bytes, and one member's recount is not that sum).
    const recalculateFor = sharedSubscription === undefined && dto.ownFiles === true ? user.uuid : null

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

      await this.updateUploadBytesUsedSetting(user.uuid, dto, recalculateFor)

      return Result.ok()
    }
    const regularSubscription = regularSubscriptionOrError.getValue()

    await this.updateUploadBytesUsedSetting(regularSubscription.uuid, dto, recalculateFor)

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
   *
   * *** A DELTA IS ONLY A TOTAL WHEN THERE IS A TOTAL TO APPLY IT TO. ***
   *
   * This used to start from `'0'` when no figure was stored and clamp a negative
   * result to `0`, and both invented a measurement. Measured on a running
   * all-in-one container whose socket upload lane had counted nothing: an account
   * held 800,034 bytes in two files and no figure; it deleted one file, the
   * removal arrived here as `-300017` against nothing, and `0` was STORED beside
   * the 500,017 bytes still on disk. The admin space report then printed a
   * measured "files 0 B" and a total with no lower-bound mark — where a moment
   * earlier it had said, truthfully, "Not reported". The mirror image is quieter
   * and just as wrong: the first counted upload after uncounted ones stores its
   * own size as the account's total.
   *
   * So when the base is absent (or is not a number), or the books would go below
   * zero — proof that the stored figure is short — the delta is NOT applied.
   * For an account that alone feeds its total, the files service is asked to
   * recount what is actually stored (the same FILE_QUOTA_RECALCULATION_REQUESTED
   * the admin's Recalculate storage quota sends), and its answer comes back
   * through this use case as an ABSOLUTE write. Both lanes publish only after the
   * file is durable and a removal only after it is gone, so that count already
   * includes the change that triggered it. If the request cannot be delivered
   * the figure stays absent, which is true.
   *
   * `recalculateForUserUuid === null` (a shared subscription, or a shared-vault
   * file billed to its owner) keeps the plain arithmetic, with one exception: a
   * removal against no figure at all writes nothing, because the only thing it
   * could write is that same invented zero.
   */
  private async updateUploadBytesUsedSetting(
    userSubscriptionUuid: string,
    dto: UpdateStorageQuotaUsedForUserDTO,
    recalculateForUserUuid: string | null,
  ): Promise<void> {
    try {
      let bytesAlreadyUsed: number | null = 0

      // An ABSOLUTE write does not read the current total at all: the figure it
      // was handed IS the total, and reading first would only widen the window in
      // which a concurrent upload can be counted twice.
      if (!dto.absolute) {
        bytesAlreadyUsed = null
        const bytesUsedSettingExists = await this.getSubscriptionSetting.execute({
          userSubscriptionUuid,
          settingName: SettingName.NAMES.FileUploadBytesUsed,
          allowSensitiveRetrieval: false,
        })

        if (!bytesUsedSettingExists.isFailed()) {
          const stored = +(bytesUsedSettingExists.getValue().setting.props.value as string)
          bytesAlreadyUsed = Number.isFinite(stored) ? stored : null
        }
      }

      const bytesUsedNewTotal = (bytesAlreadyUsed ?? 0) + dto.bytesUsed
      if (bytesAlreadyUsed === null || bytesUsedNewTotal < 0) {
        if (recalculateForUserUuid !== null) {
          await this.domainEventPublisher.publish(
            this.domainEventFactory.createFileQuotaRecalculationRequestedEvent({ userUuid: recalculateForUserUuid }),
          )

          return
        }
        if (bytesAlreadyUsed === null && dto.bytesUsed < 0) {
          return
        }
      }

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
      // A driver's message quotes SQL and values; the class and code are enough
      // to tell a constraint from an outage.
      this.logger.error(
        `Could not set file upload bytes used for subscription ${userSubscriptionUuid}`,
        safeErrorLogMetadata(error),
      )
    }
  }
}
