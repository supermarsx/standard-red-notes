import {
  Uuid,
  Timestamps,
  Result,
  NotificationPayload,
  SharedVaultUserPermission,
  SharedVaultUser,
  UniqueEntityId,
} from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { InviteRealtimeDomainEventProducer } from '../../../Invite/InviteRealtimeDomainEventProducer'
import { SharedVault } from '../../../SharedVault/SharedVault'
import { SharedVaultRepositoryInterface } from '../../../SharedVault/SharedVaultRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { RemoveUserFromSharedVault } from './RemoveUserFromSharedVault'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { AddNotificationsForUsers } from '../../Messaging/AddNotificationsForUsers/AddNotificationsForUsers'
import { AddNotificationForUser } from '../../Messaging/AddNotificationForUser/AddNotificationForUser'

describe('RemoveUserFromSharedVault', () => {
  let sharedVaultRepository: SharedVaultRepositoryInterface
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface
  let addNotificationsForUsers: AddNotificationsForUsers
  let addNotificationForUser: AddNotificationForUser
  let sharedVault: SharedVault
  let sharedVaultUser: SharedVaultUser
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface

  const createUseCase = () =>
    new RemoveUserFromSharedVault(
      sharedVaultUserRepository,
      sharedVaultRepository,
      addNotificationsForUsers,
      addNotificationForUser,
      domainEventFactory,
      domainEventPublisher,
    )

  beforeEach(() => {
    sharedVault = SharedVault.create({
      fileUploadBytesUsed: 2,
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()
    sharedVaultRepository = {} as jest.Mocked<SharedVaultRepositoryInterface>
    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(sharedVault)
    sharedVaultRepository.remove = jest.fn()

    sharedVaultUser = SharedVaultUser.create({
      permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Read).getValue(),
      sharedVaultUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
      isDesignatedSurvivor: false,
    }).getValue()
    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(sharedVaultUser)
    sharedVaultUserRepository.remove = jest.fn()

    addNotificationsForUsers = {} as jest.Mocked<AddNotificationsForUsers>
    addNotificationsForUsers.execute = jest.fn().mockReturnValue(Result.ok())

    addNotificationForUser = {} as jest.Mocked<AddNotificationForUser>
    addNotificationForUser.execute = jest.fn().mockReturnValue(Result.ok())

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createUserRemovedFromSharedVaultEvent = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<DomainEventInterface>)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()
  })

  it('should remove user from shared vault', async () => {
    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(sharedVaultUserRepository.remove).toHaveBeenCalledWith(sharedVaultUser)
  })

  it('should return error when shared vault is not found', async () => {
    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(null)

    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Shared vault not found')
  })

  it('should return error when shared vault user is not found', async () => {
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)

    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('User is not a member of the shared vault')
  })

  it('should return error when user is not owner of shared vault', async () => {
    sharedVault = SharedVault.create({
      fileUploadBytesUsed: 2,
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000002').getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()
    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(sharedVault)

    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Only owner can remove other users from shared vault')
  })

  it('should remove shared vault user if user is owner and is being force removed', async () => {
    sharedVault = SharedVault.create({
      fileUploadBytesUsed: 2,
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000002').getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()
    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(sharedVault)

    const useCase = createUseCase()
    await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000002',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
      forceRemoveOwner: true,
    })

    expect(sharedVaultUserRepository.remove).toHaveBeenCalledWith(sharedVaultUser)
  })

  it('should return error when user is owner of shared vault', async () => {
    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Owner cannot be removed from shared vault')
  })

  it('should return error if shared vault uuid is invalid', async () => {
    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: 'invalid',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Given value is not a valid uuid: invalid')
  })

  it('should return error if user uuid is invalid', async () => {
    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: 'invalid',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Given value is not a valid uuid: invalid')
  })

  it('should return error if originator uuid is invalid', async () => {
    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: 'invalid',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Given value is not a valid uuid: invalid')
  })

  it('should add notification for user', async () => {
    const useCase = createUseCase()
    await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(addNotificationsForUsers.execute).toHaveBeenCalled()
  })

  it('should return error if notification could not be added', async () => {
    addNotificationsForUsers.execute = jest.fn().mockResolvedValue(Result.fail('Could not add notification'))

    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
  })

  it('should return error if notification could not be added for the user removed', async () => {
    addNotificationForUser.execute = jest.fn().mockResolvedValue(Result.fail('Could not add notification'))

    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
  })

  it('should return error if notification payload could not be created', async () => {
    const mock = jest.spyOn(NotificationPayload, 'create')
    mock.mockReturnValue(Result.fail('Oops'))

    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Oops')

    mock.mockRestore()
  })

  it('should return error if self notification payload could not be created', async () => {
    const mock = jest.spyOn(NotificationPayload, 'create')
    mock.mockReturnValueOnce(Result.ok()).mockReturnValueOnce(Result.fail('Oops'))

    const useCase = createUseCase()
    const result = await useCase.execute({
      originatorUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Oops')

    mock.mockRestore()
  })

  /**
   * Membership revision contract (t92 C12, t90 D8): the revision is the
   * microsecond timestamp of the removal as a decimal string, strictly greater
   * than the row's own `updatedAt`, so the client's per-membership
   * strictly-greater fence applies the revocation instead of dropping it as a
   * duplicate. The literal fixture `{ revision: '1789150108395094', membershipUuid }`
   * is shared with the client fence spec.
   */
  describe('membership revision', () => {
    const MEMBERSHIP_UUID = '30000000-0000-4000-8000-000000000011'
    const ROW_UPDATED_AT_MICROSECONDS = 1789150108395093
    const REMOVAL_MICROSECONDS = 1789150108395094
    const OWNER_UUID = '00000000-0000-0000-0000-000000000000'
    const MEMBER_UUID = '00000000-0000-0000-0000-000000000001'
    const revokeByOwner = { originatorUuid: OWNER_UUID, sharedVaultUuid: OWNER_UUID, userUuid: MEMBER_UUID }

    let timer: TimerInterface
    let producer: InviteRealtimeDomainEventProducer

    const createRealtimeUseCase = (withTimer = true) =>
      new RemoveUserFromSharedVault(
        sharedVaultUserRepository,
        sharedVaultRepository,
        addNotificationsForUsers,
        addNotificationForUser,
        domainEventFactory,
        domainEventPublisher,
        undefined,
        producer,
        withTimer ? timer : undefined,
      )

    const recordedInput = () =>
      (producer.recordSharedVaultMembership as jest.Mock).mock.calls[0][0] as { revision: string; action: string }

    beforeEach(() => {
      sharedVaultUser = SharedVaultUser.create(
        {
          ...sharedVaultUser.props,
          userUuid: Uuid.create(MEMBER_UUID).getValue(),
          timestamps: Timestamps.create(ROW_UPDATED_AT_MICROSECONDS, ROW_UPDATED_AT_MICROSECONDS).getValue(),
        },
        new UniqueEntityId(MEMBERSHIP_UUID),
      ).getValue()
      sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(sharedVaultUser)
      sharedVaultUserRepository.findBySharedVaultUuid = jest.fn().mockResolvedValue([sharedVaultUser])

      timer = {} as jest.Mocked<TimerInterface>
      timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(REMOVAL_MICROSECONDS)

      producer = {} as jest.Mocked<InviteRealtimeDomainEventProducer>
      producer.recordSharedVaultMembership = jest.fn().mockResolvedValue(undefined)
    })

    it('emits the removal time from the Timer as the revision, in the canonical shape', async () => {
      const result = await createRealtimeUseCase().execute(revokeByOwner)

      expect(result.isFailed()).toBe(false)
      expect(producer.recordSharedVaultMembership).toHaveBeenCalledTimes(1)
      expect(producer.recordSharedVaultMembership).toHaveBeenCalledWith({
        action: 'revoked',
        sharedVaultUuid: OWNER_UUID,
        memberUserUuid: MEMBER_UUID,
        membershipUuid: MEMBERSHIP_UUID,
        revision: '1789150108395094',
        affectedUserUuids: [MEMBER_UUID, MEMBER_UUID],
      })
      const { revision } = recordedInput()
      expect(revision).toMatch(/^[1-9]\d{0,31}$/)
      expect(BigInt(revision) > BigInt(sharedVaultUser.props.timestamps.updatedAt)).toBe(true)
    })

    it('captures the revision before the membership row is removed', async () => {
      await createRealtimeUseCase().execute(revokeByOwner)

      const [timerCall] = (timer.getTimestampInMicroseconds as jest.Mock).mock.invocationCallOrder
      const [removeCall] = (sharedVaultUserRepository.remove as jest.Mock).mock.invocationCallOrder
      expect(timerCall).toBeLessThan(removeCall)
    })

    it('stays strictly greater than the row updatedAt when the clock is behind it', async () => {
      timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(ROW_UPDATED_AT_MICROSECONDS - 5_000_000)

      await createRealtimeUseCase().execute(revokeByOwner)

      expect(recordedInput().revision).toBe(String(ROW_UPDATED_AT_MICROSECONDS + 1))
    })

    it('falls back to the wall clock when no Timer is injected and still moves past the row', async () => {
      await createRealtimeUseCase(false).execute(revokeByOwner)

      const { revision } = recordedInput()
      expect(revision).toMatch(/^[1-9]\d{0,31}$/)
      expect(BigInt(revision) > BigInt(ROW_UPDATED_AT_MICROSECONDS)).toBe(true)
    })

    it('reports a self-removal as left with the same revision rule', async () => {
      await createRealtimeUseCase().execute({ ...revokeByOwner, originatorUuid: MEMBER_UUID })

      expect(recordedInput()).toEqual(expect.objectContaining({ action: 'left', revision: '1789150108395094' }))
    })
  })
})
