import 'reflect-metadata'
import { Result, Uuid } from '@standardnotes/domain-core'
import { AccountDeletionRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DeleteSharedVaults } from '../UseCase/SharedVaults/DeleteSharedVaults/DeleteSharedVaults'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { RemoveUserFromSharedVaults } from '../UseCase/SharedVaults/RemoveUserFromSharedVaults/RemoveUserFromSharedVaults'

import { AccountDeletionRequestedEventHandler } from './AccountDeletionRequestedEventHandler'

describe('AccountDeletionRequestedEventHandler', () => {
  let itemRepository: ItemRepositoryInterface
  let deleteSharedVaults: DeleteSharedVaults
  let removeUserFromSharedVaults: RemoveUserFromSharedVaults
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000002'

  const createHandler = () =>
    new AccountDeletionRequestedEventHandler(itemRepository, deleteSharedVaults, removeUserFromSharedVaults, logger)

  const event = (uuid = userUuid) => ({ payload: { userUuid: uuid } }) as jest.Mocked<AccountDeletionRequestedEvent>

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.deleteByUserUuidAndNotInSharedVault = jest.fn()
    itemRepository.deleteByUserUuidInSharedVaults = jest.fn()

    deleteSharedVaults = {} as jest.Mocked<DeleteSharedVaults>
    deleteSharedVaults.execute = jest.fn().mockResolvedValue(Result.ok(new Map()))

    removeUserFromSharedVaults = {} as jest.Mocked<RemoveUserFromSharedVaults>
    removeUserFromSharedVaults.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.debug = jest.fn()
    logger.info = jest.fn()
  })

  it('deletes the items the user owns outside any shared vault', async () => {
    await createHandler().handle(event())

    expect(itemRepository.deleteByUserUuidAndNotInSharedVault).toHaveBeenCalledWith(Uuid.create(userUuid).getValue())
    expect(deleteSharedVaults.execute).toHaveBeenCalledWith({ ownerUuid: userUuid, allowSurviving: true })
    expect(removeUserFromSharedVaults.execute).toHaveBeenCalledWith({ userUuid })
    expect(logger.info).toHaveBeenCalledWith('Finished account cleanup', { userId: userUuid })
  })

  it('does not issue a shared vault item deletion when no vault was deleted', async () => {
    await createHandler().handle(event())

    expect(itemRepository.deleteByUserUuidInSharedVaults).not.toHaveBeenCalled()
  })

  it('deletes the items held in each shared vault that was deleted', async () => {
    const deletedVaultUuid = Uuid.create(sharedVaultUuid).getValue()
    deleteSharedVaults.execute = jest.fn().mockResolvedValue(Result.ok(new Map([[deletedVaultUuid, []]])))

    await createHandler().handle(event())

    expect(itemRepository.deleteByUserUuidInSharedVaults).toHaveBeenCalledWith(Uuid.create(userUuid).getValue(), [
      deletedVaultUuid,
    ])
  })

  it('deletes nothing when the user uuid is malformed', async () => {
    await createHandler().handle(event('not-a-uuid'))

    expect(itemRepository.deleteByUserUuidAndNotInSharedVault).not.toHaveBeenCalled()
    expect(deleteSharedVaults.execute).not.toHaveBeenCalled()
    expect(removeUserFromSharedVaults.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), {
      userId: 'not-a-uuid',
      codeTag: 'AccountDeletionRequestedEventHandler',
    })
  })

  it('logs, but still finishes the cleanup, when the user cannot be removed from other vaults', async () => {
    removeUserFromSharedVaults.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(logger.error).toHaveBeenCalledWith('Failed to remove user from shared vaults: Oops', { userId: userUuid })
    expect(logger.info).toHaveBeenCalledWith('Finished account cleanup', { userId: userUuid })
  })

  // BUG (reported, not fixed): the handler logs the DeleteSharedVaults failure and then calls
  // `deletingVaultsResult.getValue()` unconditionally, which throws on a failed Result. The
  // intended "log and carry on" path is therefore dead: the account cleanup aborts before the
  // user is removed from the shared vaults they do not own. This test pins the CURRENT
  // behaviour so the eventual fix is a deliberate, visible change.
  it('currently aborts the whole cleanup when the shared vaults cannot be deleted', async () => {
    deleteSharedVaults.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await expect(createHandler().handle(event())).rejects.toThrow('Cannot get value of an unsuccessfull result: Oops')

    expect(logger.error).toHaveBeenCalledWith('Failed to delete shared vaults: Oops', { userId: userUuid })
    expect(removeUserFromSharedVaults.execute).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
