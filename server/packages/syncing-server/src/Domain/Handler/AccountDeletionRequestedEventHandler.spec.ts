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
    expect(logger.error).toHaveBeenCalledWith(
      'Operation failed.',
      expect.objectContaining({
        errorType: 'Error',
        userId: 'not-a-uuid',
        codeTag: 'AccountDeletionRequestedEventHandler',
      }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Expected a valid uuid')
  })

  it('rejects for retry and does not log completion when the user cannot be removed from other vaults', async () => {
    removeUserFromSharedVaults.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await expect(createHandler().handle(event())).rejects.toThrow('Failed to remove user from shared vaults.')

    expect(logger.error).toHaveBeenCalledWith(
      'Account deletion cleanup operation failed.',
      expect.objectContaining({
        errorType: 'Error',
        operation: 'remove-user-from-shared-vaults',
        userId: userUuid,
      }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Oops')
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('runs independent cleanup before rejecting for retry when shared vault deletion fails', async () => {
    deleteSharedVaults.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await expect(createHandler().handle(event())).rejects.toThrow('Failed to delete shared vaults.')

    expect(logger.error).toHaveBeenCalledWith(
      'Account deletion cleanup operation failed.',
      expect.objectContaining({
        errorType: 'Error',
        operation: 'delete-shared-vaults',
        userId: userUuid,
      }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Oops')
    expect(itemRepository.deleteByUserUuidInSharedVaults).not.toHaveBeenCalled()
    expect(removeUserFromSharedVaults.execute).toHaveBeenCalledWith({ userUuid })
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('retains the first failure after attempting every independent cleanup', async () => {
    itemRepository.deleteByUserUuidAndNotInSharedVault = jest.fn().mockRejectedValue(Error('database unavailable'))
    deleteSharedVaults.execute = jest.fn().mockResolvedValue(Result.fail('vault deletion failed'))
    removeUserFromSharedVaults.execute = jest.fn().mockResolvedValue(Result.fail('membership removal failed'))

    await expect(createHandler().handle(event())).rejects.toThrow('Failed to delete items outside shared vaults.')

    expect(deleteSharedVaults.execute).toHaveBeenCalledWith({ ownerUuid: userUuid, allowSurviving: true })
    expect(removeUserFromSharedVaults.execute).toHaveBeenCalledWith({ userUuid })
    expect(logger.error).toHaveBeenCalledWith(
      'Account deletion cleanup operation failed.',
      expect.objectContaining({
        errorType: 'Error',
        operation: 'delete-shared-vaults',
        userId: userUuid,
      }),
    )
    expect(logger.error).toHaveBeenCalledWith(
      'Account deletion cleanup operation failed.',
      expect.objectContaining({
        errorType: 'Error',
        operation: 'remove-user-from-shared-vaults',
        userId: userUuid,
      }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('database unavailable')
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('vault deletion failed')
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('membership removal failed')
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('still removes the user from other vaults when deleted-vault item cleanup rejects', async () => {
    const deletedVaultUuid = Uuid.create(sharedVaultUuid).getValue()
    deleteSharedVaults.execute = jest.fn().mockResolvedValue(Result.ok(new Map([[deletedVaultUuid, []]])))
    itemRepository.deleteByUserUuidInSharedVaults = jest.fn().mockRejectedValue(Error('database unavailable'))

    await expect(createHandler().handle(event())).rejects.toThrow('Failed to delete items from shared vaults.')

    expect(removeUserFromSharedVaults.execute).toHaveBeenCalledWith({ userUuid })
    expect(logger.error).toHaveBeenCalledWith(
      'Account deletion cleanup operation failed.',
      expect.objectContaining({
        errorType: 'Error',
        operation: 'delete-items-from-shared-vaults',
        userId: userUuid,
      }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('database unavailable')
    expect(logger.info).not.toHaveBeenCalled()
  })
})
