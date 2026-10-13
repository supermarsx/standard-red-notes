import {
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'
import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { AddSharedVaultUser } from './AddSharedVaultUser'

describe('AddSharedVaultUser', () => {
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface

  const createUseCase = () => new AddSharedVaultUser(sharedVaultUserRepository)

  beforeEach(() => {
    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.save = jest.fn()
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)
  })

  const existingRow = (updatedAt: number): SharedVaultUser =>
    SharedVaultUser.create(
      {
        userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
        sharedVaultUuid: Uuid.create('11111111-1111-1111-1111-111111111111').getValue(),
        permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Read).getValue(),
        timestamps: Timestamps.create(1, updatedAt).getValue(),
        isDesignatedSurvivor: true,
      },
      new UniqueEntityId('22222222-2222-2222-2222-222222222222'),
    ).getValue()

  // SQS is at-least-once: a redelivered add used to insert a SECOND row, which
  // then survived the removal and kept a removed member in the token.
  it('updates the existing row for the pair instead of inserting another one', async () => {
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(existingRow(2))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '11111111-1111-1111-1111-111111111111',
      permission: 'write',
      createdAt: 1,
      updatedAt: 3,
    })

    expect(result.isFailed()).toBe(false)
    expect(sharedVaultUserRepository.save).toHaveBeenCalledTimes(1)
    const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
    expect(saved.id.toString()).toEqual('22222222-2222-2222-2222-222222222222')
    expect(saved.props.permission.value).toEqual('write')
    expect(saved.props.timestamps.updatedAt).toEqual(3)
    expect(saved.props.isDesignatedSurvivor).toBe(true)
  })

  it('leaves a newer row alone when an older add is redelivered', async () => {
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(existingRow(10))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '11111111-1111-1111-1111-111111111111',
      permission: 'write',
      createdAt: 1,
      updatedAt: 3,
    })

    expect(result.isFailed()).toBe(false)
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it('should save shared vault user', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      permission: 'read',
      createdAt: 1,
      updatedAt: 2,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(sharedVaultUserRepository.save).toHaveBeenCalled()
  })

  it('should fail when user uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: 'invalid',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      permission: 'read',
      createdAt: 1,
      updatedAt: 2,
    })

    expect(result.isFailed()).toBeTruthy()
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when shared vault uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: 'invalid',
      permission: 'read',
      createdAt: 1,
      updatedAt: 2,
    })

    expect(result.isFailed()).toBeTruthy()
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when permission is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      permission: 'invalid',
      createdAt: 1,
      updatedAt: 2,
    })

    expect(result.isFailed()).toBeTruthy()
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when timestamps are invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      permission: 'read',
      createdAt: 'invalid' as unknown as number,
      updatedAt: 1,
    })

    expect(result.isFailed()).toBeTruthy()
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when shared vault user is invalid', async () => {
    const mock = jest.spyOn(SharedVaultUser, 'create')
    mock.mockReturnValue(Result.fail('Oops'))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
      permission: 'read',
      createdAt: 2,
      updatedAt: 1,
    })

    expect(result.isFailed()).toBeTruthy()

    mock.mockRestore()
  })
})
