import { SubscriptionRefundedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { OfflineUserSubscriptionRepositoryInterface } from '../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { RoleServiceInterface } from '../Role/RoleServiceInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { UserSubscription } from '../Subscription/UserSubscription'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'

import { SubscriptionRefundedEventHandler } from './SubscriptionRefundedEventHandler'

describe('SubscriptionRefundedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface
  let roleService: RoleServiceInterface
  let logger: Logger

  const subscriptionId = 42
  const timestamp = 1_600_000_000
  const userEmail = 'user@example.com'
  const subscriptionName = 'PRO_PLAN'
  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid, email: userEmail } as jest.Mocked<User>

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<SubscriptionRefundedEvent>

  const fullPayload = { subscriptionId, timestamp, userEmail, subscriptionName }

  const createHandler = () =>
    new SubscriptionRefundedEventHandler(
      userRepository,
      userSubscriptionRepository,
      offlineUserSubscriptionRepository,
      roleService,
      logger,
    )

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)

    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.updateEndsAt = jest.fn().mockResolvedValue(undefined)
    userSubscriptionRepository.findBySubscriptionId = jest
      .fn()
      .mockResolvedValue([{ userUuid } as jest.Mocked<UserSubscription>])

    offlineUserSubscriptionRepository = {} as jest.Mocked<OfflineUserSubscriptionRepositoryInterface>
    offlineUserSubscriptionRepository.updateEndsAt = jest.fn().mockResolvedValue(undefined)

    roleService = {} as jest.Mocked<RoleServiceInterface>
    roleService.removeUserRoleBasedOnSubscription = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.warn = jest.fn()
  })

  it('should do nothing but log if the subscription id is missing', async () => {
    await createHandler().handle(eventWith({ userEmail, timestamp }))

    expect(userSubscriptionRepository.updateEndsAt).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionRefundedEventHandler.handle',
      subscriptionId: undefined,
      userId: userEmail,
    })
  })

  it('should end the offline subscription without touching roles', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(offlineUserSubscriptionRepository.updateEndsAt).toHaveBeenCalledWith(subscriptionId, timestamp, timestamp)
    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(roleService.removeUserRoleBasedOnSubscription).not.toHaveBeenCalled()
  })

  it('should do nothing if the user email is not a valid username', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, userEmail: '' }))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(userSubscriptionRepository.updateEndsAt).not.toHaveBeenCalled()
  })

  it('should not end anything if the user is not found', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(userSubscriptionRepository.updateEndsAt).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with email: ${userEmail}`)
  })

  it('should end the subscription and remove the role from every subscription user', async () => {
    await createHandler().handle(eventWith(fullPayload))

    expect(userSubscriptionRepository.updateEndsAt).toHaveBeenCalledWith(subscriptionId, timestamp, timestamp)
    expect(roleService.removeUserRoleBasedOnSubscription).toHaveBeenCalledWith(user, subscriptionName)
  })

  it('should skip a subscription row whose user uuid is malformed', async () => {
    userSubscriptionRepository.findBySubscriptionId = jest
      .fn()
      .mockResolvedValue([{ userUuid: 'not-a-uuid' } as jest.Mocked<UserSubscription>])

    await createHandler().handle(eventWith(fullPayload))

    expect(userRepository.findOneByUuid).not.toHaveBeenCalled()
    expect(roleService.removeUserRoleBasedOnSubscription).not.toHaveBeenCalled()
  })

  it('should skip a subscription row whose user no longer exists', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(roleService.removeUserRoleBasedOnSubscription).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with uuid: ${userUuid}`)
  })
})
