import { TimerInterface } from '@standardnotes/time'
import {
  NotificationPayload,
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  Uuid,
} from '@standardnotes/domain-core'
import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { SharedVaultRepositoryInterface } from '../../../SharedVault/SharedVaultRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { AddUserToSharedVault } from './AddUserToSharedVault'
import { SharedVault } from '../../../SharedVault/SharedVault'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { AddNotificationsForUsers } from '../../Messaging/AddNotificationsForUsers/AddNotificationsForUsers'

describe('AddUserToSharedVault', () => {
  let sharedVaultRepository: SharedVaultRepositoryInterface
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface
  let timer: TimerInterface
  let sharedVault: SharedVault
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let addNotificationsForUsers: AddNotificationsForUsers

  const validUuid = '00000000-0000-0000-0000-000000000000'

  const createUseCase = () =>
    new AddUserToSharedVault(
      sharedVaultRepository,
      sharedVaultUserRepository,
      timer,
      domainEventFactory,
      domainEventPublisher,
      addNotificationsForUsers,
    )

  beforeEach(() => {
    sharedVault = {} as jest.Mocked<SharedVault>

    sharedVaultRepository = {} as jest.Mocked<SharedVaultRepositoryInterface>
    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(sharedVault)

    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.save = jest.fn()
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(123456789)

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createUserAddedToSharedVaultEvent = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<DomainEventInterface>)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    addNotificationsForUsers = {} as jest.Mocked<AddNotificationsForUsers>
    addNotificationsForUsers.execute = jest.fn().mockReturnValue(Result.ok())
  })

  it('should return a failure result if the shared vault uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: 'invalid-uuid',
      userUuid: validUuid,
      permission: 'read',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Given value is not a valid uuid: invalid-uuid')
  })

  it('should return a failure result if the user uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: 'invalid-uuid',
      permission: 'read',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Given value is not a valid uuid: invalid-uuid')
  })

  it('should return a failure result if the permission is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'test',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Invalid shared vault user permission test')
  })

  it('should return a failure result if the shared vault does not exist', async () => {
    const useCase = createUseCase()

    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValueOnce(null)

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Attempting to add a shared vault user to a non-existent shared vault')
  })

  it('should return a failure result if creating the shared vault user fails', async () => {
    const useCase = createUseCase()

    const mockSharedVaultUser = jest.spyOn(SharedVaultUser, 'create')
    mockSharedVaultUser.mockImplementation(() => {
      return Result.fail('Oops')
    })

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Oops')

    mockSharedVaultUser.mockRestore()
  })

  it('should return a failure if add notification for users fails', async () => {
    addNotificationsForUsers.execute = jest.fn().mockReturnValue(Result.fail('Oops'))

    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Oops')
  })

  it('should return error if notification payload could not be created', async () => {
    const mock = jest.spyOn(NotificationPayload, 'create')
    mock.mockReturnValue(Result.fail('Oops'))

    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Oops')

    mock.mockRestore()
  })

  it('should add a user to a shared vault', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
    })

    expect(result.isFailed()).toBe(false)
    // The existing-member lookup really was consulted, and found nothing — so the success below is
    // the "no duplicate yet" branch rather than a branch that never ran.
    expect(sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid).toHaveBeenCalledTimes(1)
    await expect(
      (sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid as jest.Mock).mock.results[0].value,
    ).resolves.toBeNull()
    expect(sharedVaultUserRepository.save).toHaveBeenCalled()
  })

  it('should refuse to add a user who is already a member of the shared vault', async () => {
    const existingMembership = SharedVaultUser.create({
      userUuid: Uuid.create(validUuid).getValue(),
      sharedVaultUuid: Uuid.create(validUuid).getValue(),
      permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Write).getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
      isDesignatedSurvivor: false,
    }).getValue()

    // Precondition: the membership fixture really is a membership of this vault for this user, so a
    // refusal below cannot come from an empty or mismatched fixture.
    expect(existingMembership.props.userUuid.value).toEqual(validUuid)
    expect(existingMembership.props.sharedVaultUuid.value).toEqual(validUuid)

    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(existingMembership)

    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('User is already a member of this shared vault')

    // The lookup really was made for the vault and user being added.
    const lookupArguments = (sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid as jest.Mock).mock.calls[0][0]
    expect(lookupArguments.userUuid.value).toEqual(validUuid)
    expect(lookupArguments.sharedVaultUuid.value).toEqual(validUuid)

    // No second row, and no membership side effects announcing an addition that did not happen.
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    expect(addNotificationsForUsers.execute).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should refuse the duplicate even when the shared vault existence check is skipped', async () => {
    const existingMembership = SharedVaultUser.create({
      userUuid: Uuid.create(validUuid).getValue(),
      sharedVaultUuid: Uuid.create(validUuid).getValue(),
      permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Admin).getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
      isDesignatedSurvivor: false,
    }).getValue()

    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(null)
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(existingMembership)

    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
      skipSharedVaultExistenceCheck: true,
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('User is already a member of this shared vault')
    expect(sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid).toHaveBeenCalledTimes(1)
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it('should add a user to a shared vault and skip checking if shared vault exists to avoid race conditions', async () => {
    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValueOnce(null)

    const useCase = createUseCase()

    const result = await useCase.execute({
      sharedVaultUuid: validUuid,
      userUuid: validUuid,
      permission: 'read',
      skipSharedVaultExistenceCheck: true,
    })

    expect(result.isFailed()).toBe(false)
    expect(sharedVaultUserRepository.save).toHaveBeenCalled()
  })
})
