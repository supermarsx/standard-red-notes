import { UpdateStorageQuotaUsedForUser } from './UpdateStorageQuotaUsedForUser'

import { UserSubscription } from '../../Subscription/UserSubscription'
import { UserSubscriptionType } from '../../Subscription/UserSubscriptionType'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'
import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../GetSubscriptionSetting/GetSubscriptionSetting'
import { SetSubscriptionSettingValue } from '../SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { Logger } from 'winston'
import { Result, SettingName, Timestamps, Uuid } from '@standardnotes/domain-core'
import { SubscriptionSetting } from '../../Setting/SubscriptionSetting'
import { EncryptionVersion } from '../../Encryption/EncryptionVersion'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { DomainEventPublisherInterface, FileQuotaRecalculationRequestedEvent } from '@standardnotes/domain-events'

describe('UpdateStorageQuotaUsedForUser', () => {
  let userRepository: UserRepositoryInterface
  let user: User
  let regularSubscription: UserSubscription
  let sharedSubscription: UserSubscription
  let getSharedSubscription: GetSharedSubscriptionForUser
  let getRegularSubscription: GetRegularSubscriptionForUser
  let getSubscriptionSetting: GetSubscriptionSetting
  let setSubscriptonSettingValue: SetSubscriptionSettingValue
  let logger: Logger
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface

  const createUseCase = () =>
    new UpdateStorageQuotaUsedForUser(
      userRepository,
      getRegularSubscription,
      getSharedSubscription,
      getSubscriptionSetting,
      setSubscriptonSettingValue,
      logger,
      domainEventFactory,
      domainEventPublisher,
    )

  beforeEach(() => {
    user = {
      uuid: '123',
    } as jest.Mocked<User>

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockReturnValue(user)

    regularSubscription = {
      uuid: '00000000-0000-0000-0000-000000000000',
      subscriptionType: UserSubscriptionType.Regular,
      userUuid: '123',
    } as jest.Mocked<UserSubscription>

    sharedSubscription = {
      uuid: '2-3-4',
      subscriptionType: UserSubscriptionType.Shared,
      userUuid: '123',
    } as jest.Mocked<UserSubscription>

    getSharedSubscription = {} as jest.Mocked<GetSharedSubscriptionForUser>
    getSharedSubscription.execute = jest.fn().mockReturnValue(Result.ok(sharedSubscription))

    getRegularSubscription = {} as jest.Mocked<GetRegularSubscriptionForUser>
    getRegularSubscription.execute = jest.fn().mockReturnValue(Result.ok(regularSubscription))

    getSubscriptionSetting = {} as jest.Mocked<GetSubscriptionSetting>
    getSubscriptionSetting.execute = jest.fn().mockReturnValue(Result.fail('not found'))

    setSubscriptonSettingValue = {} as jest.Mocked<SetSubscriptionSettingValue>
    setSubscriptonSettingValue.execute = jest.fn().mockReturnValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createFileQuotaRecalculationRequestedEvent = jest.fn(
      (dto: { userUuid: string }) =>
        ({
          type: 'FILE_QUOTA_RECALCULATION_REQUESTED',
          payload: dto,
        }) as jest.Mocked<FileQuotaRecalculationRequestedEvent>,
    )

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()
  })

  /**
   * *** THE FALSE ZERO, AND ITS QUIETER TWIN. ***
   *
   * Measured on a running all-in-one container whose socket upload lane counted
   * nothing: an account with 800,034 bytes in two files and NO stored figure
   * deleted one file; `-300017` arrived here against nothing; `0` was stored
   * beside 500,017 bytes still on disk, and the admin space report printed a
   * measured "files 0 B" where it had truthfully said "Not reported".
   *
   * A delta is only a total when there is a total to apply it to. With none, the
   * files service is asked to recount what is actually stored, and nothing is
   * written here in the meantime.
   */
  describe('a figure it cannot know', () => {
    const userUuid = '00000000-0000-0000-0000-000000000000'
    // What FILE_UPLOADED / FILE_REMOVED hand over: a delta about the account's own storage.
    const ownFile = (bytesUsed: number) => ({ userUuid, bytesUsed, ownFiles: true })
    // What the shared-vault handlers hand over: a delta billed to the owner, stored under the vault.
    const vaultFile = (bytesUsed: number) => ({ userUuid, bytesUsed })

    const recalculationFor = (subject: string) => ({
      type: 'FILE_QUOTA_RECALCULATION_REQUESTED',
      payload: { userUuid: subject },
    })

    const storedFigure = (value: string | null) =>
      Result.ok({
        setting: SubscriptionSetting.create({
          name: SettingName.NAMES.FileUploadBytesUsed,
          sensitive: false,
          serverEncryptionVersion: EncryptionVersion.Unencrypted,
          timestamps: Timestamps.create(123, 123).getValue(),
          userSubscriptionUuid: Uuid.create(userUuid).getValue(),
          value,
        }).getValue(),
      })

    describe('for an account with no subscription row', () => {
      beforeEach(() => {
        getRegularSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))
        getSharedSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))
      })

      it('never stores a zero when a file is removed and no figure is stored', async () => {
        const result = await createUseCase().execute(ownFile(-300017))

        expect(result.isFailed()).toBeFalsy()
        expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
        // '123' is the user's uuid in this fixture: the recount is of THEIR files.
        expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
        expect(domainEventPublisher.publish).toHaveBeenCalledWith(recalculationFor('123'))
      })

      it('does not store an upload’s own size as the total when no figure is stored', async () => {
        const result = await createUseCase().execute(ownFile(500017))

        expect(result.isFailed()).toBeFalsy()
        // Files stored before anything was counting are on disk too, and 500017
        // would read as a measurement of all of them.
        expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
        expect(domainEventPublisher.publish).toHaveBeenCalledWith(recalculationFor('123'))
      })

      it('asks for a recount rather than clamping to zero when a removal exceeds the stored figure', async () => {
        getSubscriptionSetting.execute = jest.fn().mockReturnValue(storedFigure('345'))

        await createUseCase().execute(ownFile(-1234))

        // 345 - 1234 proves the stored figure was short; zero is not what is left.
        expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
        expect(domainEventPublisher.publish).toHaveBeenCalledWith(recalculationFor('123'))
      })

      it('treats a stored value that is not a number as no figure at all', async () => {
        getSubscriptionSetting.execute = jest.fn().mockReturnValue(storedFigure('not-a-number'))

        await createUseCase().execute(ownFile(10))

        // It used to write the string 'NaN' as the account's usage.
        expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
        expect(domainEventPublisher.publish).toHaveBeenCalledWith(recalculationFor('123'))
      })

      it('writes the recount’s own answer as given and does not ask again', async () => {
        const result = await createUseCase().execute({ userUuid, bytesUsed: 500017, absolute: true })

        expect(result.isFailed()).toBeFalsy()
        expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
          settingName: 'FILE_UPLOAD_BYTES_USED',
          value: '500017',
          userSubscriptionUuid: '123',
        })
        // An absolute total is the answer to the question; asking again from
        // inside it would never terminate on the in-process bus.
        expect(domainEventPublisher.publish).not.toHaveBeenCalled()
      })

      it('keeps exact arithmetic, and asks nobody, while a figure is stored', async () => {
        getSubscriptionSetting.execute = jest.fn().mockReturnValue(storedFigure('800034'))

        await createUseCase().execute(ownFile(-300017))

        expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
          settingName: 'FILE_UPLOAD_BYTES_USED',
          value: '500017',
          userSubscriptionUuid: '123',
        })
        expect(domainEventPublisher.publish).not.toHaveBeenCalled()
      })

      it('leaves the figure absent, and the caller unharmed, when the recount cannot be requested', async () => {
        domainEventPublisher.publish = jest.fn().mockRejectedValue(new Error('no transport'))

        const result = await createUseCase().execute(ownFile(-300017))

        expect(result.isFailed()).toBeFalsy()
        expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledTimes(1)
      })

      /**
       * A vault file is billed to the vault's OWNER but stored under the VAULT,
       * and the recount sums the owner's own storage only. Answering a vault
       * delta with a recount would lose the very file that asked for it -- so a
       * vault delta is never recounted, whatever is or is not stored.
       */
      it('counts a vault upload from nothing rather than recounting storage that does not hold it', async () => {
        await createUseCase().execute(vaultFile(500017))

        expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
          settingName: 'FILE_UPLOAD_BYTES_USED',
          value: '500017',
          userSubscriptionUuid: '123',
        })
        expect(domainEventPublisher.publish).not.toHaveBeenCalled()
      })

      it('still never stores a zero when a vault file is removed and no figure is stored', async () => {
        await createUseCase().execute(vaultFile(-300017))

        expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
        expect(domainEventPublisher.publish).not.toHaveBeenCalled()
      })
    })

    it('asks for the recount under a regular subscription too, keyed on the user and not on the subscription', async () => {
      getSharedSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))

      await createUseCase().execute(ownFile(500017))

      expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
      expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
      expect(domainEventPublisher.publish).toHaveBeenCalledWith(recalculationFor('123'))
    })

    /**
     * Under a shared subscription the owner's figure is several accounts' bytes,
     * and one member's recounted total is not that sum -- so no recount, and the
     * old arithmetic. Except for the one thing it could only get wrong.
     */
    it('writes nothing, and asks for nothing, when a shared subscriber removes a file and no figure is stored', async () => {
      const result = await createUseCase().execute(ownFile(-300017))

      expect(result.isFailed()).toBeFalsy()
      expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
      expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    })

    it('still counts a shared subscriber’s first upload on both scopes without a recount', async () => {
      await createUseCase().execute(ownFile(123))

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledTimes(2)
      expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    })
  })

  it('should create a bytes used setting if one does not exist', async () => {
    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      bytesUsed: 123,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
      settingName: 'FILE_UPLOAD_BYTES_USED',
      value: '123',
      userSubscriptionUuid: '00000000-0000-0000-0000-000000000000',
    })
  })

  it('should log, but not fail, when the bytes used setting cannot be persisted', async () => {
    setSubscriptonSettingValue.execute = jest.fn().mockReturnValue(Result.fail('database unavailable'))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      bytesUsed: 123,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(logger.error).toHaveBeenCalledWith(
      'Could not set file upload bytes used for subscription 00000000-0000-0000-0000-000000000000',
    )
  })

  /**
   * *** A FAILED QUOTA WRITE MUST NOT COST THE USER THEIR FILE. ***
   *
   * On the single-container topology the event bus is
   * `DirectCallDomainEventPublisher`, which AWAITS its handlers inside
   * `publish()`. So a throw here travels back out of the files service's
   * `FinishUploadSession` — which catches everything and answers
   * `Could not finish upload session` — and the upload returns 400. That is
   * exactly what a live upload did when a database constraint refused the INSERT:
   * a missing bookkeeping figure became a refused file.
   *
   * The failed `Result` was already handled; only a THROW was not. Both are now
   * contained, and the ordering is the point: losing the total costs the quota,
   * which the diagnostics pane reports as a degradation; losing the upload costs
   * the file.
   */
  it('contains a thrown write so an upload is never refused over bookkeeping', async () => {
    setSubscriptonSettingValue.execute = jest.fn().mockRejectedValue(new Error('FOREIGN KEY constraint failed'))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      bytesUsed: 123,
    })

    expect(result.isFailed()).toBeFalsy()
    // Logged by subscription and error class, never by the driver's text,
    // which quotes SQL and values.
    expect(logger.error).toHaveBeenCalledWith(
      'Could not set file upload bytes used for subscription 00000000-0000-0000-0000-000000000000',
      { errorType: 'Error' },
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('FOREIGN KEY')
  })

  it('contains a thrown READ of the existing total as well', async () => {
    getSubscriptionSetting.execute = jest.fn().mockRejectedValue(new Error('database unavailable'))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      bytesUsed: 123,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(logger.error).toHaveBeenCalledWith(
      'Could not set file upload bytes used for subscription 00000000-0000-0000-0000-000000000000',
      { errorType: 'Error' },
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('database unavailable')
  })

  it('should not do anything if a user uuid is invalid', async () => {
    const result = await createUseCase().execute({
      userUuid: 'invalid',
      bytesUsed: 123,
    })
    expect(result.isFailed()).toBeTruthy()

    expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
  })

  it('should not do anything if a user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockReturnValue(null)

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      bytesUsed: 123,
    })
    expect(result.isFailed()).toBeTruthy()

    expect(setSubscriptonSettingValue.execute).not.toHaveBeenCalled()
  })

  describe('updating existing quota', () => {
    beforeEach(() => {
      getSubscriptionSetting.execute = jest.fn().mockReturnValue(
        Result.ok({
          setting: SubscriptionSetting.create({
            name: SettingName.NAMES.FileUploadBytesUsed,
            sensitive: false,
            serverEncryptionVersion: EncryptionVersion.Unencrypted,
            timestamps: Timestamps.create(123, 123).getValue(),
            userSubscriptionUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
            value: '345',
          }).getValue(),
        }),
      )
    })

    /**
     * *** THE DEFECT THIS TEST USED TO PIN IN PLACE. ***
     *
     * It asserted that an account with no `user_subscriptions` row has its usage
     * total silently dropped. On the default `included` entitlement mode NO
     * account has such a row — `Register` only creates one under
     * `provisioned-full`, while `GetUserSubscription` synthesises a PRO_PLAN
     * subscription for the client regardless — so this was every upload on every
     * default deployment, and FILE_UPLOAD_BYTES_USED did not exist for anybody.
     *
     * The total now lands under the USER's own uuid, which is the identity
     * `createIncludedSubscription` already hands the client as the synthetic
     * subscription's uuid, the identity the self-scoped settings endpoint reads
     * from, and the identity `CreateValetToken`'s free branch reads its byte
     * figures from. No new table, no second counter, the same +/- arithmetic.
     */
    it('writes the total under the user when there is no subscription row to key it on', async () => {
      getRegularSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))
      getSharedSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))

      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: 123,
      })
      expect(result.isFailed()).toBeFalsy()

      // '123' is the user's uuid in this fixture, NOT the subscription's — which
      // is the whole point, and is asserted as a distinct value from the
      // subscription uuid every other test in this file writes to.
      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '468',
        userSubscriptionUuid: '123',
      })
      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledTimes(1)
    })

    /**
     * A DELETE MUST REACH THE SAME SCOPE AS THE UPLOAD, or the counter drifts up
     * forever and the quota becomes unenforceable from a total nobody is
     * decrementing. FILE_REMOVED arrives as a negative `bytesUsed`, and this
     * asserts the subtraction on the row-less scope specifically — the one the
     * upload path only just started writing to.
     */
    it('subtracts on the same user-scoped total when a file is removed', async () => {
      getRegularSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))
      getSharedSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))

      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: -123,
      })
      expect(result.isFailed()).toBeFalsy()

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '222',
        userSubscriptionUuid: '123',
      })
    })

    /**
     * *** THE ONE CASE THAT STILL FAILS, AND MUST. ***
     *
     * A shared subscriber whose share OWNER has no regular subscription is a
     * genuinely broken share. The invitee's own total was already written above,
     * and falling back to a user scope on top of a shared one would count the same
     * bytes twice.
     */
    it('still fails for a shared subscription whose owner has no regular subscription', async () => {
      getRegularSubscription.execute = jest.fn().mockReturnValue(Result.fail('error'))

      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: 123,
      })
      expect(result.isFailed()).toBeTruthy()

      // The shared total was written, and nothing was written for the user uuid.
      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '468',
        userSubscriptionUuid: '2-3-4',
      })
      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledTimes(1)
    })

    it('should add bytes used setting if one does exist', async () => {
      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: 123,
      })
      expect(result.isFailed()).toBeFalsy()

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '468',
        userSubscriptionUuid: '00000000-0000-0000-0000-000000000000',
      })
    })

    /**
     * *** AN ABSOLUTE WRITE REPLACES THE TOTAL AND DOES NOT READ IT. ***
     *
     * This is the recalculation path: the FILES service summed the bytes actually
     * on disk for this owner, so the figure IS the total. Asserted against a
     * fixture whose existing total is 345 — an ADD would answer 1345 — and the
     * read is asserted to have been SKIPPED, because reading first only widens
     * the window in which a concurrent upload is counted twice.
     */
    it('replaces the total rather than adding to it when the write is absolute', async () => {
      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: 1000,
        absolute: true,
      })
      expect(result.isFailed()).toBeFalsy()

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '1000',
        userSubscriptionUuid: '00000000-0000-0000-0000-000000000000',
      })
      expect(getSubscriptionSetting.execute).not.toHaveBeenCalled()
    })

    it('should subtract bytes used setting if one does exist', async () => {
      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: -123,
      })
      expect(result.isFailed()).toBeFalsy()

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '222',
        userSubscriptionUuid: '00000000-0000-0000-0000-000000000000',
      })
    })

    it('should not subtract below 0', async () => {
      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: -1234,
      })
      expect(result.isFailed()).toBeFalsy()

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '0',
        userSubscriptionUuid: '00000000-0000-0000-0000-000000000000',
      })
    })

    it('should update a bytes used setting on both regular and shared subscription', async () => {
      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        bytesUsed: 123,
      })
      expect(result.isFailed()).toBeFalsy()

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '468',
        userSubscriptionUuid: '00000000-0000-0000-0000-000000000000',
      })

      expect(setSubscriptonSettingValue.execute).toHaveBeenCalledWith({
        settingName: 'FILE_UPLOAD_BYTES_USED',
        value: '468',
        userSubscriptionUuid: '2-3-4',
      })
    })
  })
})
