import { SubscriptionRenewedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { OfflineUserSubscription } from '../Subscription/OfflineUserSubscription'
import { OfflineUserSubscriptionRepositoryInterface } from '../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { RoleServiceInterface } from '../Role/RoleServiceInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { UserSubscription } from '../Subscription/UserSubscription'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'

import { SubscriptionRenewedEventHandler } from './SubscriptionRenewedEventHandler'

describe('SubscriptionRenewedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface
  let roleService: RoleServiceInterface
  let logger: Logger

  const subscriptionId = 42
  const timestamp = 1_600_000_000
  const subscriptionExpiresAt = 1_700_000_000
  const userEmail = 'user@example.com'
  const subscriptionName = 'PRO_PLAN'
  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid, email: userEmail } as jest.Mocked<User>

  let offlineSubscription: OfflineUserSubscription

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<SubscriptionRenewedEvent>

  const fullPayload = { subscriptionId, timestamp, subscriptionExpiresAt, userEmail, subscriptionName }

  const createHandler = () =>
    new SubscriptionRenewedEventHandler(
      userRepository,
      userSubscriptionRepository,
      offlineUserSubscriptionRepository,
      roleService,
      logger,
    )

  beforeEach(() => {
    offlineSubscription = { endsAt: 1, updatedAt: 1 } as OfflineUserSubscription

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)

    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.updateEndsAt = jest.fn().mockResolvedValue(undefined)
    userSubscriptionRepository.findBySubscriptionId = jest
      .fn()
      .mockResolvedValue([{ userUuid } as jest.Mocked<UserSubscription>])

    offlineUserSubscriptionRepository = {} as jest.Mocked<OfflineUserSubscriptionRepositoryInterface>
    offlineUserSubscriptionRepository.findOneBySubscriptionId = jest.fn().mockResolvedValue(offlineSubscription)
    offlineUserSubscriptionRepository.save = jest.fn().mockResolvedValue(offlineSubscription)

    roleService = {} as jest.Mocked<RoleServiceInterface>
    roleService.addUserRoleBasedOnSubscription = jest.fn().mockResolvedValue(undefined)
    roleService.setOfflineUserRole = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.warn = jest.fn()
  })

  it('should do nothing but log if the subscription id is missing', async () => {
    await createHandler().handle(eventWith({ userEmail, timestamp }))

    expect(userSubscriptionRepository.updateEndsAt).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionRenewedEventHandler.handle',
      subscriptionId: undefined,
      userId: userEmail,
    })
  })

  it('should extend the offline subscription and refresh the offline role', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(offlineSubscription.endsAt).toEqual(subscriptionExpiresAt)
    expect(offlineSubscription.updatedAt).toEqual(timestamp)
    expect(offlineUserSubscriptionRepository.save).toHaveBeenCalledWith(offlineSubscription)
    expect(roleService.setOfflineUserRole).toHaveBeenCalledWith(offlineSubscription)
    expect(userSubscriptionRepository.updateEndsAt).not.toHaveBeenCalled()
  })

  it('should not save anything if the offline subscription is unknown', async () => {
    offlineUserSubscriptionRepository.findOneBySubscriptionId = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith({ ...fullPayload, offline: true }))

    expect(offlineUserSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(roleService.setOfflineUserRole).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find offline user subscription with id: ${subscriptionId}`)
  })

  it('should extend the online subscription and re-grant the role to every subscription user', async () => {
    await createHandler().handle(eventWith(fullPayload))

    expect(userSubscriptionRepository.updateEndsAt).toHaveBeenCalledWith(
      subscriptionId,
      subscriptionExpiresAt,
      timestamp,
    )
    expect(roleService.addUserRoleBasedOnSubscription).toHaveBeenCalledWith(user, subscriptionName)
  })

  it('should still extend the subscription but grant no role if the email is not a valid username', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, userEmail: '' }))

    expect(userSubscriptionRepository.updateEndsAt).toHaveBeenCalledTimes(1)
    expect(roleService.addUserRoleBasedOnSubscription).not.toHaveBeenCalled()
  })

  it('should grant no role if the user is not found', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(roleService.addUserRoleBasedOnSubscription).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with email: ${userEmail}`)
  })

  it('should skip a subscription row whose user uuid is malformed', async () => {
    userSubscriptionRepository.findBySubscriptionId = jest
      .fn()
      .mockResolvedValue([{ userUuid: 'not-a-uuid' } as jest.Mocked<UserSubscription>])

    await createHandler().handle(eventWith(fullPayload))

    expect(userRepository.findOneByUuid).not.toHaveBeenCalled()
    expect(roleService.addUserRoleBasedOnSubscription).not.toHaveBeenCalled()
  })

  it('should skip a subscription row whose user no longer exists', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(roleService.addUserRoleBasedOnSubscription).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with uuid: ${userUuid}`)
  })
})
