import { SubscriptionPurchasedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { ApplyDefaultSubscriptionSettings } from '../UseCase/ApplyDefaultSubscriptionSettings/ApplyDefaultSubscriptionSettings'
import { OfflineUserSubscription } from '../Subscription/OfflineUserSubscription'
import { OfflineUserSubscriptionRepositoryInterface } from '../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { RenewSharedSubscriptions } from '../UseCase/RenewSharedSubscriptions/RenewSharedSubscriptions'
import { RoleServiceInterface } from '../Role/RoleServiceInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { UserSubscription } from '../Subscription/UserSubscription'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'
import { UserSubscriptionType } from '../Subscription/UserSubscriptionType'

import { SubscriptionPurchasedEventHandler } from './SubscriptionPurchasedEventHandler'

describe('SubscriptionPurchasedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let applyDefaultSubscriptionSettings: ApplyDefaultSubscriptionSettings
  let offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface
  let roleService: RoleServiceInterface
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
    ({ payload }) as unknown as jest.Mocked<SubscriptionPurchasedEvent>

  const fullPayload = { subscriptionId, timestamp, subscriptionExpiresAt, userEmail, subscriptionName }

  const createHandler = () =>
    new SubscriptionPurchasedEventHandler(
      userRepository,
      userSubscriptionRepository,
      applyDefaultSubscriptionSettings,
      offlineUserSubscriptionRepository,
      roleService,
      renewSharedSubscriptions,
      logger,
    )

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)

    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.save = jest
      .fn()
      .mockImplementation((subscription: UserSubscription) => Promise.resolve({ ...subscription, uuid: 'sub-uuid' }))

    offlineUserSubscriptionRepository = {} as jest.Mocked<OfflineUserSubscriptionRepositoryInterface>
    offlineUserSubscriptionRepository.save = jest
      .fn()
      .mockImplementation((subscription: OfflineUserSubscription) => Promise.resolve(subscription))

    applyDefaultSubscriptionSettings = {} as jest.Mocked<ApplyDefaultSubscriptionSettings>
    applyDefaultSubscriptionSettings.execute = jest.fn().mockResolvedValue(Result.ok('applied'))

    renewSharedSubscriptions = {} as jest.Mocked<RenewSharedSubscriptions>
    renewSharedSubscriptions.execute = jest.fn().mockResolvedValue(Result.ok('renewed'))

    roleService = {} as jest.Mocked<RoleServiceInterface>
    roleService.addUserRoleBasedOnSubscription = jest.fn().mockResolvedValue(undefined)
    roleService.setOfflineUserRole = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.warn = jest.fn()
  })

  it('should do nothing but log if the subscription id is missing', async () => {
    await createHandler().handle(eventWith({ userEmail, timestamp }))

    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(offlineUserSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionPurchasedEventHandler.handle',
      subscriptionId: undefined,
      userId: userEmail,
    })
  })

  it('should create an offline subscription and set the offline role', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    const saved = (offlineUserSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as OfflineUserSubscription
    expect(saved).toBeInstanceOf(OfflineUserSubscription)
    expect(saved.planName).toEqual(subscriptionName)
    expect(saved.email).toEqual(userEmail)
    expect(saved.createdAt).toEqual(timestamp)
    expect(saved.endsAt).toEqual(subscriptionExpiresAt)
    expect(saved.cancelled).toBe(false)
    expect(saved.subscriptionId).toEqual(subscriptionId)

    expect(roleService.setOfflineUserRole).toHaveBeenCalledWith(saved)
    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
  })

  it('should renew shared offline subscriptions from the buyer email', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(renewSharedSubscriptions.execute).toHaveBeenCalledWith({
      inviterEmail: userEmail,
      newSubscriptionId: subscriptionId,
      newSubscriptionName: subscriptionName,
      newSubscriptionExpiresAt: subscriptionExpiresAt,
      timestamp,
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should still set the offline role if renewing shared offline subscriptions fails', async () => {
    renewSharedSubscriptions.execute = jest.fn().mockResolvedValue(Result.fail('renew oops'))

    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(logger.error).toHaveBeenCalledWith('Could not renew shared offline subscriptions: renew oops', {
      subscriptionId,
    })
    expect(roleService.setOfflineUserRole).toHaveBeenCalledTimes(1)
  })

  it('should do nothing if the buyer email is not a valid username', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, userEmail: '' }))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
  })

  it('should not create a subscription if the buyer has no account', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with email: ${userEmail}`)
  })

  it('should create an active regular subscription for the buyer', async () => {
    await createHandler().handle(eventWith(fullPayload))

    const saved = (userSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as UserSubscription
    expect(saved).toBeInstanceOf(UserSubscription)
    expect(saved.planName).toEqual(subscriptionName)
    expect(saved.userUuid).toEqual(userUuid)
    expect(saved.createdAt).toEqual(timestamp)
    expect(saved.updatedAt).toEqual(timestamp)
    expect(saved.endsAt).toEqual(subscriptionExpiresAt)
    expect(saved.cancelled).toBe(false)
    expect(saved.subscriptionType).toEqual(UserSubscriptionType.Regular)
  })

  it('should grant the role and apply the default settings against the saved subscription uuid', async () => {
    await createHandler().handle(eventWith(fullPayload))

    expect(roleService.addUserRoleBasedOnSubscription).toHaveBeenCalledWith(user, subscriptionName)
    expect(applyDefaultSubscriptionSettings.execute).toHaveBeenCalledWith({
      userSubscriptionUuid: 'sub-uuid',
      userUuid,
      subscriptionPlanName: subscriptionName,
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log but keep going if renewing the shared subscriptions fails', async () => {
    renewSharedSubscriptions.execute = jest.fn().mockResolvedValue(Result.fail('renew oops'))

    await createHandler().handle(eventWith(fullPayload))

    expect(logger.error).toHaveBeenCalledWith(`Could not renew shared subscriptions for user ${userUuid}: renew oops`)
    expect(roleService.addUserRoleBasedOnSubscription).toHaveBeenCalledTimes(1)
  })

  it('should log if the default subscription settings could not be applied', async () => {
    applyDefaultSubscriptionSettings.execute = jest.fn().mockResolvedValue(Result.fail('settings oops'))

    await createHandler().handle(eventWith(fullPayload))

    expect(logger.error).toHaveBeenCalledWith(
      `Could not apply default subscription settings for user ${userUuid}: settings oops`,
    )
  })
})
