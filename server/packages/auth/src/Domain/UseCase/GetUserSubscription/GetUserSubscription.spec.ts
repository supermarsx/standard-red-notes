import 'reflect-metadata'
import { GetUserSubscription } from './GetUserSubscription'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { User } from '../../User/User'
import { UserSubscriptionRepositoryInterface } from '../../Subscription/UserSubscriptionRepositoryInterface'
import { UserSubscription } from '../../Subscription/UserSubscription'
import { SubscriptionName } from '@standardnotes/common'
import { TimerInterface } from '@standardnotes/time'
import { UserSubscriptionType } from '../../Subscription/UserSubscriptionType'

describe('GetUserSubscription', () => {
  let user: User
  let userSubscription: UserSubscription
  let userRepository: UserRepositoryInterface
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let timer: TimerInterface

  const createUseCase = () => new GetUserSubscription(userRepository, userSubscriptionRepository)
  const createIncludedUseCase = () =>
    new GetUserSubscription(userRepository, userSubscriptionRepository, 'included', timer, 36500)

  beforeEach(() => {
    user = {
      uuid: '00000000-0000-0000-0000-000000000000',
      email: '00000000-0000-0000-0000-000000000000@example.com',
    } as jest.Mocked<User>
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockReturnValue(user)

    userSubscription = {
      planName: SubscriptionName.ProPlan,
    } as jest.Mocked<UserSubscription>
    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.findOneByUserUuid = jest.fn().mockReturnValue(userSubscription)

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(111)
    timer.getUTCDateNDaysAhead = jest.fn().mockReturnValue(new Date(2))
    timer.convertDateToMicroseconds = jest.fn().mockReturnValue(222)
  })

  it('should fail if a user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockReturnValue(null)

    expect(await createUseCase().execute({ userUuid: '00000000-0000-0000-0000-000000000000' })).toEqual({
      success: false,
      error: {
        message: 'User 00000000-0000-0000-0000-000000000000 not found.',
      },
    })
  })

  it('should fail if a user uuid is invalid', async () => {
    expect(await createUseCase().execute({ userUuid: 'invalid' })).toEqual({
      success: false,
      error: {
        message: 'Given value is not a valid uuid: invalid',
      },
    })
  })

  it('should return user subscription', async () => {
    expect(await createUseCase().execute({ userUuid: '00000000-0000-0000-0000-000000000000' })).toEqual({
      success: true,
      user: { uuid: '00000000-0000-0000-0000-000000000000', email: '00000000-0000-0000-0000-000000000000@example.com' },
      subscription: {
        planName: SubscriptionName.ProPlan,
      },
    })
  })

  it('should return a full included subscription without querying stored subscriptions', async () => {
    expect(await createIncludedUseCase().execute({ userUuid: '00000000-0000-0000-0000-000000000000' })).toEqual({
      success: true,
      user: {
        uuid: '00000000-0000-0000-0000-000000000000',
        email: '00000000-0000-0000-0000-000000000000@example.com',
      },
      subscription: {
        uuid: '00000000-0000-0000-0000-000000000000',
        planName: SubscriptionName.ProPlan,
        endsAt: 222,
        createdAt: 111,
        updatedAt: 111,
        renewedAt: 111,
        cancelled: false,
        subscriptionId: expect.any(Number),
        subscriptionType: UserSubscriptionType.Regular,
        userUuid: '00000000-0000-0000-0000-000000000000',
      },
    })

    expect(userSubscriptionRepository.findOneByUserUuid).not.toHaveBeenCalled()
    expect(timer.getUTCDateNDaysAhead).toHaveBeenCalledWith(36500)
  })
})
