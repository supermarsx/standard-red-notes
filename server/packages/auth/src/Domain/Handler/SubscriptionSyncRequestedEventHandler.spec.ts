import { ContentDecoderInterface } from '@standardnotes/common'
import { Result, SettingName } from '@standardnotes/domain-core'
import { SubscriptionSyncRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { ApplyDefaultSubscriptionSettings } from '../UseCase/ApplyDefaultSubscriptionSettings/ApplyDefaultSubscriptionSettings'
import { OfflineSettingName } from '../Setting/OfflineSettingName'
import { OfflineSettingServiceInterface } from '../Setting/OfflineSettingServiceInterface'
import { OfflineUserSubscription } from '../Subscription/OfflineUserSubscription'
import { OfflineUserSubscriptionRepositoryInterface } from '../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { RenewSharedSubscriptions } from '../UseCase/RenewSharedSubscriptions/RenewSharedSubscriptions'
import { RoleServiceInterface } from '../Role/RoleServiceInterface'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { UserSubscription } from '../Subscription/UserSubscription'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'
import { UserSubscriptionType } from '../Subscription/UserSubscriptionType'

import { SubscriptionSyncRequestedEventHandler } from './SubscriptionSyncRequestedEventHandler'

describe('SubscriptionSyncRequestedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface
  let roleService: RoleServiceInterface
  let applyDefaultSubscriptionSettings: ApplyDefaultSubscriptionSettings
  let setSettingValue: SetSettingValue
  let offlineSettingService: OfflineSettingServiceInterface
  let contentDecoder: ContentDecoderInterface
  let renewSharedSubscriptions: RenewSharedSubscriptions
  let logger: Logger

  const subscriptionId = 42
  const timestamp = 1_600_000_000
  const subscriptionExpiresAt = 1_700_000_000
  const userEmail = 'user@example.com'
  const subscriptionName = 'PRO_PLAN'
  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid, email: userEmail } as jest.Mocked<User>

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<SubscriptionSyncRequestedEvent>

  const fullPayload = {
    subscriptionId,
    timestamp,
    subscriptionExpiresAt,
    userEmail,
    subscriptionName,
    canceled: false,
    offlineFeaturesToken: 'raw-token',
  }

  const createHandler = () =>
    new SubscriptionSyncRequestedEventHandler(
      userRepository,
      userSubscriptionRepository,
      offlineUserSubscriptionRepository,
      roleService,
      applyDefaultSubscriptionSettings,
      setSettingValue,
      offlineSettingService,
      contentDecoder,
      renewSharedSubscriptions,
      logger,
    )

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)

    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.findBySubscriptionIdAndType = jest.fn().mockResolvedValue([])
    userSubscriptionRepository.save = jest
      .fn()
      .mockImplementation((subscription: UserSubscription) => Promise.resolve({ ...subscription, uuid: 'sub-uuid' }))

    offlineUserSubscriptionRepository = {} as jest.Mocked<OfflineUserSubscriptionRepositoryInterface>
    offlineUserSubscriptionRepository.findOneBySubscriptionId = jest.fn().mockResolvedValue(null)
    offlineUserSubscriptionRepository.save = jest
      .fn()
      .mockImplementation((subscription: OfflineUserSubscription) => Promise.resolve(subscription))

    roleService = {} as jest.Mocked<RoleServiceInterface>
    roleService.addUserRoleBasedOnSubscription = jest.fn().mockResolvedValue(undefined)
    roleService.setOfflineUserRole = jest.fn().mockResolvedValue(undefined)

    applyDefaultSubscriptionSettings = {} as jest.Mocked<ApplyDefaultSubscriptionSettings>
    applyDefaultSubscriptionSettings.execute = jest.fn().mockResolvedValue(Result.ok('applied'))

    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.ok('set'))

    offlineSettingService = {} as jest.Mocked<OfflineSettingServiceInterface>
    offlineSettingService.createOrUpdate = jest.fn().mockResolvedValue(undefined)

    contentDecoder = {} as jest.Mocked<ContentDecoderInterface>
    contentDecoder.decode = jest.fn().mockReturnValue({ extensionKey: 'decoded-key' })

    renewSharedSubscriptions = {} as jest.Mocked<RenewSharedSubscriptions>
    renewSharedSubscriptions.execute = jest.fn().mockResolvedValue(Result.ok('renewed'))

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.warn = jest.fn()
    logger.error = jest.fn()
  })

  it('should do nothing but log if the subscription id is missing', async () => {
    await createHandler().handle(eventWith({ userEmail, timestamp }))

    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(offlineUserSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionSyncRequestedEventHandler.handle',
      subscriptionId: undefined,
    })
  })

  describe('offline subscription', () => {
    const offlinePayload = { ...fullPayload, offline: true }

    it('should create the offline subscription when none exists yet', async () => {
      await createHandler().handle(eventWith(offlinePayload))

      const saved = (offlineUserSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as OfflineUserSubscription
      expect(saved).toBeInstanceOf(OfflineUserSubscription)
      expect(saved.planName).toEqual(subscriptionName)
      expect(saved.email).toEqual(userEmail)
      expect(saved.endsAt).toEqual(subscriptionExpiresAt)
      expect(saved.subscriptionId).toEqual(subscriptionId)
      expect(roleService.setOfflineUserRole).toHaveBeenCalledWith(saved)
    })

    it('should update the existing offline subscription in place instead of creating a second one', async () => {
      const existing = { planName: 'OLD', subscriptionId } as OfflineUserSubscription
      offlineUserSubscriptionRepository.findOneBySubscriptionId = jest.fn().mockResolvedValue(existing)

      await createHandler().handle(eventWith(offlinePayload))

      const saved = (offlineUserSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as OfflineUserSubscription
      expect(saved).toBe(existing)
      expect(saved.planName).toEqual(subscriptionName)
    })

    it('should store the decoded offline features token', async () => {
      await createHandler().handle(eventWith(offlinePayload))

      expect(contentDecoder.decode).toHaveBeenCalledWith('raw-token', 0)
      expect(offlineSettingService.createOrUpdate).toHaveBeenCalledWith({
        email: userEmail,
        name: OfflineSettingName.FeaturesToken,
        value: 'decoded-key',
      })
    })

    it('should stop before storing a setting when the features token has no extension key', async () => {
      contentDecoder.decode = jest.fn().mockReturnValue({})

      await createHandler().handle(eventWith(offlinePayload))

      expect(offlineSettingService.createOrUpdate).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith('Could not decode offline features token')
    })

    it('should log but keep going if renewing shared offline subscriptions fails', async () => {
      renewSharedSubscriptions.execute = jest.fn().mockResolvedValue(Result.fail('renew oops'))

      await createHandler().handle(eventWith(offlinePayload))

      expect(logger.error).toHaveBeenCalledWith('Could not renew shared offline subscriptions for a user.', {
        subscriptionId,
      })
      expect(roleService.setOfflineUserRole).toHaveBeenCalledTimes(1)
    })

    it('should never touch the online path', async () => {
      await createHandler().handle(eventWith(offlinePayload))

      expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
      expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    })
  })

  describe('online subscription', () => {
    it('should skip validation of the email but stop if it still cannot be parsed', async () => {
      await createHandler().handle(eventWith({ ...fullPayload, userEmail: '' }))

      expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
      expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    })

    it('should accept an email that would fail strict username validation', async () => {
      await createHandler().handle(eventWith({ ...fullPayload, userEmail: 'not-an-email' }))

      expect(userRepository.findOneByUsernameOrEmail).toHaveBeenCalledTimes(1)
    })

    it('should not create a subscription if the user has no account', async () => {
      userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

      await createHandler().handle(eventWith(fullPayload))

      expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(`Could not find user with email: ${userEmail}`, { subscriptionId })
    })

    it('should create a regular subscription when none exists for the id', async () => {
      await createHandler().handle(eventWith(fullPayload))

      const saved = (userSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as UserSubscription
      expect(saved).toBeInstanceOf(UserSubscription)
      expect(saved.userUuid).toEqual(userUuid)
      expect(saved.planName).toEqual(subscriptionName)
      expect(saved.endsAt).toEqual(subscriptionExpiresAt)
      expect(saved.subscriptionType).toEqual(UserSubscriptionType.Regular)
      expect(userSubscriptionRepository.findBySubscriptionIdAndType).toHaveBeenCalledWith(
        subscriptionId,
        UserSubscriptionType.Regular,
      )
    })

    it('should update the existing subscription in place when exactly one matches', async () => {
      const existing = { planName: 'OLD' } as UserSubscription
      userSubscriptionRepository.findBySubscriptionIdAndType = jest.fn().mockResolvedValue([existing])

      await createHandler().handle(eventWith(fullPayload))

      const saved = (userSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as UserSubscription
      expect(saved).toBe(existing)
      expect(saved.planName).toEqual(subscriptionName)
    })

    it('should create a fresh subscription rather than guess when several match the id', async () => {
      const first = { planName: 'ONE' } as UserSubscription
      const second = { planName: 'TWO' } as UserSubscription
      userSubscriptionRepository.findBySubscriptionIdAndType = jest.fn().mockResolvedValue([first, second])

      await createHandler().handle(eventWith(fullPayload))

      const saved = (userSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as UserSubscription
      expect(saved).not.toBe(first)
      expect(saved).not.toBe(second)
      expect(saved).toBeInstanceOf(UserSubscription)
    })

    it('should grant the role, apply the default settings and store the extension key', async () => {
      await createHandler().handle(eventWith(fullPayload))

      expect(roleService.addUserRoleBasedOnSubscription).toHaveBeenCalledWith(user, subscriptionName)
      expect(applyDefaultSubscriptionSettings.execute).toHaveBeenCalledWith({
        userSubscriptionUuid: 'sub-uuid',
        userUuid,
        subscriptionPlanName: subscriptionName,
      })
      expect(setSettingValue.execute).toHaveBeenCalledWith({
        userUuid,
        settingName: SettingName.NAMES.ExtensionKey,
        value: subscriptionName,
      })
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('should log but keep going if renewing the shared subscriptions fails', async () => {
      renewSharedSubscriptions.execute = jest.fn().mockResolvedValue(Result.fail('renew oops'))

      await createHandler().handle(eventWith(fullPayload))

      expect(logger.error).toHaveBeenCalledWith('Could not renew shared subscriptions for a user.', {
        userId: userUuid,
      })
      expect(roleService.addUserRoleBasedOnSubscription).toHaveBeenCalledTimes(1)
    })

    it('should log if the default subscription settings could not be applied', async () => {
      applyDefaultSubscriptionSettings.execute = jest.fn().mockResolvedValue(Result.fail('settings oops'))

      await createHandler().handle(eventWith(fullPayload))

      expect(logger.error).toHaveBeenCalledWith('Could not apply default subscription settings for a user.', {
        userId: userUuid,
      })
    })

    it('should log if the extension key could not be stored', async () => {
      setSettingValue.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

      await createHandler().handle(eventWith(fullPayload))

      expect(logger.error).toHaveBeenCalledWith(`Could not set extension key for user ${userUuid}`)
    })
  })
})
