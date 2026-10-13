import { SharedVaultUser } from '@standardnotes/domain-core'

import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { RemoveSharedVaultUser } from './RemoveSharedVaultUser'

describe('RemoveSharedVaultUser', () => {
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface

  const createUseCase = () => new RemoveSharedVaultUser(sharedVaultUserRepository)

  beforeEach(() => {
    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<SharedVaultUser>)
    sharedVaultUserRepository.findByUserUuid = jest.fn().mockReturnValue([{} as jest.Mocked<SharedVaultUser>])
    sharedVaultUserRepository.remove = jest.fn()
    sharedVaultUserRepository.removeByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(1)
  })

  // A duplicate row left by a redelivered add used to survive the removal (one
  // row was found and deleted), keeping a removed member in the token.
  it('removes every row for the member and vault pair', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '11111111-1111-1111-1111-111111111111',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(sharedVaultUserRepository.removeByUserUuidAndSharedVaultUuid).toHaveBeenCalledTimes(1)
    const [dto] = (sharedVaultUserRepository.removeByUserUuidAndSharedVaultUuid as jest.Mock).mock.calls[0]
    expect(dto.userUuid.value).toEqual('00000000-0000-0000-0000-000000000000')
    expect(dto.sharedVaultUuid.value).toEqual('11111111-1111-1111-1111-111111111111')
    expect(sharedVaultUserRepository.remove).not.toHaveBeenCalled()
  })

  it('should remove all shared vault users', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(sharedVaultUserRepository.remove).toHaveBeenCalled()
  })

  it('should fail when user uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: 'invalid',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(sharedVaultUserRepository.remove).not.toHaveBeenCalled()
  })

  it('should fail when shared vault uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: 'invalid',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(sharedVaultUserRepository.remove).not.toHaveBeenCalled()
    expect(sharedVaultUserRepository.removeByUserUuidAndSharedVaultUuid).not.toHaveBeenCalled()
  })

  // The mirror already agrees with the event; a redelivered removal is not a failure.
  it('succeeds when the mirror has no row for the pair', async () => {
    sharedVaultUserRepository.removeByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(0)

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBe(false)
  })
})
