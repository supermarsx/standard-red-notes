import { SubscriptionReassignedEvent } from '@standardnotes/domain-events'
import { Result, SettingName } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { ApplyDefaultSubscriptionSettings } from '../UseCase/ApplyDefaultSubscriptionSettings/ApplyDefaultSubscriptionSettings'
import { RoleServiceInterface } from '../Role/RoleServiceInterface'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { UserSubscription } from '../Subscription/UserSubscription'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'
import { UserSubscriptionType } from '../Subscription/UserSubscriptionType'

import { SubscriptionReassignedEventHandler } from './SubscriptionReassignedEventHandler'

describe('SubscriptionReassignedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let userSubscriptionRepository: UserSubscriptionRepositoryInterface
  let roleService: RoleServiceInterface
  let logger: Logger
  let applyDefaultSubscriptionSettings: ApplyDefaultSubscriptionSettings
  let setSettingValue: SetSettingValue

  const subscriptionId = 42
  const timestamp = 1_600_000_000
  const subscriptionExpiresAt = 1_700_000_000
  const userEmail = 'newowner@example.com'
  const subscriptionName = 'PRO_PLAN'
  const extensionKey = 'ext-key'
  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid, email: userEmail } as jest.Mocked<User>

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<SubscriptionReassignedEvent>

  const fullPayload = { subscriptionId, timestamp, subscriptionExpiresAt, userEmail, subscriptionName, extensionKey }

  const createHandler = () =>
    new SubscriptionReassignedEventHandler(
      userRepository,
      userSubscriptionRepository,
      roleService,
      logger,
      applyDefaultSubscriptionSettings,
      setSettingValue,
    )

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)

    userSubscriptionRepository = {} as jest.Mocked<UserSubscriptionRepositoryInterface>
    userSubscriptionRepository.save = jest
      .fn()
      .mockImplementation((subscription: UserSubscription) => Promise.resolve({ ...subscription, uuid: 'sub-uuid' }))

    roleService = {} as jest.Mocked<RoleServiceInterface>
    roleService.addUserRoleBasedOnSubscription = jest.fn().mockResolvedValue(undefined)

    applyDefaultSubscriptionSettings = {} as jest.Mocked<ApplyDefaultSubscriptionSettings>
    applyDefaultSubscriptionSettings.execute = jest.fn().mockResolvedValue(Result.ok('applied'))

    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.ok('set'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.warn = jest.fn()
  })

  it('should do nothing but log if the subscription id is missing', async () => {
    await createHandler().handle(eventWith({ userEmail, timestamp }))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Subscription ID is missing', {
      codeTag: 'SubscriptionReassignedEventHandler.handle',
      subscriptionId: undefined,
      userId: userEmail,
    })
  })

  it('should do nothing if the new owner email is not a valid username', async () => {
    await createHandler().handle(eventWith({ ...fullPayload, userEmail: '' }))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
  })

  it('should not create a subscription if the new owner has no account', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(fullPayload))

    expect(userSubscriptionRepository.save).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with email: ${userEmail}`)
  })

  it('should create an active regular subscription for the new owner', async () => {
    await createHandler().handle(eventWith(fullPayload))

    const saved = (userSubscriptionRepository.save as jest.Mock).mock.calls[0][0] as UserSubscription
    expect(saved).toBeInstanceOf(UserSubscription)
    expect(saved.planName).toEqual(subscriptionName)
    expect(saved.userUuid).toEqual(userUuid)
    expect(saved.createdAt).toEqual(timestamp)
    expect(saved.updatedAt).toEqual(timestamp)
    expect(saved.endsAt).toEqual(subscriptionExpiresAt)
    expect(saved.cancelled).toBe(false)
    expect(saved.subscriptionId).toEqual(subscriptionId)
    expect(saved.subscriptionType).toEqual(UserSubscriptionType.Regular)
  })

  it('should grant the role, store the extension key and apply the default settings', async () => {
    await createHandler().handle(eventWith(fullPayload))

    expect(roleService.addUserRoleBasedOnSubscription).toHaveBeenCalledWith(user, subscriptionName)
    expect(setSettingValue.execute).toHaveBeenCalledWith({
      userUuid,
      settingName: SettingName.NAMES.ExtensionKey,
      value: extensionKey,
    })
    expect(applyDefaultSubscriptionSettings.execute).toHaveBeenCalledWith({
      subscriptionPlanName: subscriptionName,
      userUuid,
      userSubscriptionUuid: 'sub-uuid',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log but keep going if the extension key could not be stored', async () => {
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

    await createHandler().handle(eventWith(fullPayload))

    expect(logger.error).toHaveBeenCalledWith(`Could not set extension key for user ${userUuid}`)
    expect(applyDefaultSubscriptionSettings.execute).toHaveBeenCalledTimes(1)
  })

  it('should log if the default subscription settings could not be applied', async () => {
    applyDefaultSubscriptionSettings.execute = jest.fn().mockResolvedValue(Result.fail('settings oops'))

    await createHandler().handle(eventWith(fullPayload))

    expect(logger.error).toHaveBeenCalledWith(
      `Could not apply default subscription settings for user ${userUuid}: settings oops`,
    )
  })
})
