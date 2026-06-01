import 'reflect-metadata'

import { GetUserOfflineSubscription } from './GetUserOfflineSubscription'
import { SubscriptionName } from '@standardnotes/common'
import { OfflineUserSubscriptionRepositoryInterface } from '../../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { OfflineUserSubscription } from '../../Subscription/OfflineUserSubscription'
import { TimerInterface } from '@standardnotes/time'

describe('GetUserOfflineSubscription', () => {
  let userSubscription: OfflineUserSubscription
  let offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface
  let timer: TimerInterface

  const createUseCase = () => new GetUserOfflineSubscription(offlineUserSubscriptionRepository)
  const createIncludedUseCase = () =>
    new GetUserOfflineSubscription(offlineUserSubscriptionRepository, 'included', timer, 36500)

  beforeEach(() => {
    userSubscription = {
      planName: SubscriptionName.ProPlan,
    } as jest.Mocked<OfflineUserSubscription>

    offlineUserSubscriptionRepository = {} as jest.Mocked<OfflineUserSubscriptionRepositoryInterface>
    offlineUserSubscriptionRepository.findOneByEmail = jest.fn().mockReturnValue(userSubscription)

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(111)
    timer.getUTCDateNDaysAhead = jest.fn().mockReturnValue(new Date(2))
    timer.convertDateToMicroseconds = jest.fn().mockReturnValue(222)
  })

  it('should return user offline subscription', async () => {
    expect(await createUseCase().execute({ userEmail: 'test@test.com' })).toEqual({
      success: true,
      subscription: {
        planName: SubscriptionName.ProPlan,
      },
    })
  })

  it('should return a full included offline subscription without querying stored subscriptions', async () => {
    expect(await createIncludedUseCase().execute({ userEmail: 'test@test.com' })).toEqual({
      success: true,
      subscription: {
        uuid: '00000000-0000-0000-0000-000000000000',
        email: 'test@test.com',
        planName: SubscriptionName.ProPlan,
        endsAt: 222,
        createdAt: 111,
        updatedAt: 111,
        cancelled: false,
        subscriptionId: expect.any(Number),
        roles: expect.any(Promise),
      },
    })

    expect(offlineUserSubscriptionRepository.findOneByEmail).not.toHaveBeenCalled()
    expect(timer.getUTCDateNDaysAhead).toHaveBeenCalledWith(36500)
  })
})
