import { SubscriptionStateFetchedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { OfflineUserSubscription } from '../Subscription/OfflineUserSubscription'
import { OfflineUserSubscriptionRepositoryInterface } from '../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { UserSubscription } from '../Subscription/UserSubscription'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'

import { SubscriptionStateFetchedEventHandler } from './SubscriptionStateFetchedEventHandler'

describe('SubscriptionStateFetchedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface
  let logger: Logger

  const subscriptionId = 42
  const subscriptionExpiresAt = 1_700_000_000
  const userEmail = 'user@example.com'
  const subscriptionName = 'PRO_PLAN'
  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid, email: userEmail } as jest.Mocked<User>

  let subscription: UserSubscription
  let offlineSubscription: OfflineUserSubscription

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<SubscriptionStateFetchedEvent>

  const fullPayload = { subscriptionId, subscriptionExpiresAt, userEmail, subscriptionName, canceled: true }

  const createHandler = () =>
    new SubscriptionStateFetchedEventHandler(
      userRepository,
      userSubscriptionRepository,
      offlineUserSubscriptionRepository,
      logger,
    )

  beforeEach(() => {
    subscription = { subscriptionId, planName: 'OLD', endsAt: 1, cancelled: false } as UserSubscription
    offlineSubscription = {
      subscriptionId,
      planName: 'OLD',
      email: 'old@example.com',
      endsAt: 1,
      cancelled: false,
    } as OfflineUserSubscription

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)

    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.findOneByUserUuidAndSubscriptionId = jest.fn().mockResolvedValue(subscription)
    userSubscriptionRepository.save = jest.fn().mockResolvedValue(subscription)

    offlineUserSubscriptionRepository = {} as jest.Mocked<OfflineUserSubscriptionRepositoryInterface>
    offlineUserSubscriptionRepository.findOneByEmailAndSubscriptionId = jest.fn().mockResolvedValue(offlineSubscription)
    offlineUserSubscriptionRepository.save = jest.fn().mockResolvedValue(offlineSubscription)

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.warn = jest.fn()
    logger.error = jest.fn()
  })

  it('should do nothing but log if the subscription id is missing', async () => {
    await createHandler().handle(eventWith({ userEmail }))

    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(userSubscriptionRepository.findOneByUserUuidAndSubscriptionId).not.toHaveBeenCalled()
    expect(offlineUserSubscriptionRepository.findOneByEmailAndSubscriptionId).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionStateFetchedEventHandler.handle',
      subscriptionId: undefined,
    })
  })

  it('should reject subscription id zero without querying either repository', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, subscriptionId: 0 }))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(userSubscriptionRepository.findOneByUserUuidAndSubscriptionId).not.toHaveBeenCalled()
    expect(offlineUserSubscriptionRepository.findOneByEmailAndSubscriptionId).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionStateFetchedEventHandler.handle',
      subscriptionId: 0,
    })
  })

  it('should copy the fetched state onto the offline subscription', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(offlineSubscription.planName).toEqual(subscriptionName)
    expect(offlineSubscription.email).toEqual(userEmail)
    expect(offlineSubscription.endsAt).toEqual(subscriptionExpiresAt)
    expect(offlineSubscription.cancelled).toBe(true)
    expect(offlineSubscription.subscriptionId).toEqual(subscriptionId)
    expect(offlineUserSubscriptionRepository.save).toHaveBeenCalledWith(offlineSubscription)
    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
  })

  it('should warn when the stored offline subscription id differs from the fetched one', async () => {
    offlineSubscription.subscriptionId = 7

    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(logger.warn).toHaveBeenCalledWith('Subscription IDs do not match', {
      previousSubscriptionId: 7,
      subscriptionId,
    })
    // It still adopts the fetched id.
    expect(offlineSubscription.subscriptionId).toEqual(subscriptionId)
  })

  it('should not save anything if the offline subscription is not found', async () => {
    offlineUserSubscriptionRepository.findOneByEmailAndSubscriptionId = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(offlineUserSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Offline subscription not found', { subscriptionId })
  })

  it('should do nothing if the user email is not a valid username', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, userEmail: '' }))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
  })

  it('should not save anything if the user is not found', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with email: ${userEmail}`, { subscriptionId })
  })

  it('should not save anything if the user has no matching subscription', async () => {
    userSubscriptionRepository.findOneByUserUuidAndSubscriptionId = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription not found', { userId: userUuid, subscriptionId })
  })

  it('should copy the fetched state onto the online subscription', async () => {
    await createHandler().handle(eventWith(fullPayload))

    expect(subscription.planName).toEqual(subscriptionName)
    expect(subscription.endsAt).toEqual(subscriptionExpiresAt)
    expect(subscription.cancelled).toBe(true)
    expect(userSubscriptionRepository.save).toHaveBeenCalledWith(subscription)
  })

  it('should warn when the stored online subscription id differs from the fetched one', async () => {
    subscription.subscriptionId = 7

    await createHandler().handle(eventWith(fullPayload))

    expect(logger.warn).toHaveBeenCalledWith('Subscription IDs do not match', {
      previousSubscriptionId: 7,
      subscriptionId,
    })
    expect(subscription.subscriptionId).toEqual(subscriptionId)
  })

  it('should look both subscriptions up with the subscription id from the event', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))
    expect(offlineUserSubscriptionRepository.findOneByEmailAndSubscriptionId).toHaveBeenCalledWith(
      userEmail,
      subscriptionId,
    )

    await createHandler().handle(eventWith(fullPayload))
    expect(userSubscriptionRepository.findOneByUserUuidAndSubscriptionId).toHaveBeenCalledWith(userUuid, subscriptionId)
  })
})
