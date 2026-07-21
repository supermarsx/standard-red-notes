import { SubscriptionCancelledEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { OfflineUserSubscriptionRepositoryInterface } from '../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'

import { SubscriptionCancelledEventHandler } from './SubscriptionCancelledEventHandler'

describe('SubscriptionCancelledEventHandler', () => {
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface
  let logger: Logger

  const subscriptionId = 42
  const timestamp = 1_600_000_000

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<SubscriptionCancelledEvent>

  const createHandler = () =>
    new SubscriptionCancelledEventHandler(userSubscriptionRepository, offlineUserSubscriptionRepository, logger)

  beforeEach(() => {
    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.updateCancelled = jest.fn().mockResolvedValue(undefined)

    offlineUserSubscriptionRepository = {} as jest.Mocked<OfflineUserSubscriptionRepositoryInterface>
    offlineUserSubscriptionRepository.updateCancelled = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should do nothing but log if the subscription id is missing', async () => {
    await createHandler().handle(eventWith({ userEmail: 'user@example.com', timestamp }))

    expect(userSubscriptionRepository.updateCancelled).not.toHaveBeenCalled()
    expect(offlineUserSubscriptionRepository.updateCancelled).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionCancelledEventHandler.handle',
      subscriptionId: undefined,
      userId: 'user@example.com',
    })
  })

  it('should mark the online subscription cancelled', async () => {
    await createHandler().handle(eventWith({ subscriptionId, timestamp }))

    expect(userSubscriptionRepository.updateCancelled).toHaveBeenCalledWith(subscriptionId, true, timestamp)
    expect(offlineUserSubscriptionRepository.updateCancelled).not.toHaveBeenCalled()
  })

  it('should mark the offline subscription cancelled instead when the event is offline', async () => {
    await createHandler().handle(eventWith({ subscriptionId, timestamp, offline: true }))

    expect(offlineUserSubscriptionRepository.updateCancelled).toHaveBeenCalledWith(subscriptionId, true, timestamp)
    expect(userSubscriptionRepository.updateCancelled).not.toHaveBeenCalled()
  })
})
