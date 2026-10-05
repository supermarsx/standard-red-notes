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

  const createUseCase = () =>
    new UpdateStorageQuotaUsedForUser(
      userRepository,
      getRegularSubscription,
      getSharedSubscription,
      getSubscriptionSetting,
      setSubscriptonSettingValue,
      logger,
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
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('FOREIGN KEY constraint failed'))
  })

  it('contains a thrown READ of the existing total as well', async () => {
    getSubscriptionSetting.execute = jest.fn().mockRejectedValue(new Error('database unavailable'))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      bytesUsed: 123,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('database unavailable'))
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
