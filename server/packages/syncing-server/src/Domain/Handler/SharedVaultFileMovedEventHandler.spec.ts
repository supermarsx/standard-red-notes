import 'reflect-metadata'
import { NotificationType, Result } from '@standardnotes/domain-core'
import { SharedVaultFileMovedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { AddNotificationsForUsers } from '../UseCase/Messaging/AddNotificationsForUsers/AddNotificationsForUsers'
import { UpdateStorageQuotaUsedInSharedVault } from '../UseCase/SharedVaults/UpdateStorageQuotaUsedInSharedVault/UpdateStorageQuotaUsedInSharedVault'

import { SharedVaultFileMovedEventHandler } from './SharedVaultFileMovedEventHandler'

describe('SharedVaultFileMovedEventHandler', () => {
  let updateStorageQuotaUsedInSharedVault: UpdateStorageQuotaUsedInSharedVault
  let addNotificationsForUsers: AddNotificationsForUsers
  let logger: Logger

  const sourceVaultUuid = '00000000-0000-0000-0000-000000000001'
  const targetVaultUuid = '00000000-0000-0000-0000-000000000002'

  const createHandler = () =>
    new SharedVaultFileMovedEventHandler(updateStorageQuotaUsedInSharedVault, addNotificationsForUsers, logger)

  const event = (from?: string, to?: string) =>
    ({
      payload: {
        from: { sharedVaultUuid: from },
        to: { sharedVaultUuid: to },
        fileByteSize: 2048,
      },
    }) as jest.Mocked<SharedVaultFileMovedEvent>

  beforeEach(() => {
    updateStorageQuotaUsedInSharedVault = {} as jest.Mocked<UpdateStorageQuotaUsedInSharedVault>
    updateStorageQuotaUsedInSharedVault.execute = jest.fn().mockResolvedValue(Result.ok())

    addNotificationsForUsers = {} as jest.Mocked<AddNotificationsForUsers>
    addNotificationsForUsers.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('moves the quota from the source vault to the target vault', async () => {
    await createHandler().handle(event(sourceVaultUuid, targetVaultUuid))

    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenNthCalledWith(1, {
      sharedVaultUuid: sourceVaultUuid,
      bytesUsed: -2048,
    })
    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenNthCalledWith(2, {
      sharedVaultUuid: targetVaultUuid,
      bytesUsed: 2048,
    })
  })

  it('notifies both vaults with the removal and the upload', async () => {
    await createHandler().handle(event(sourceVaultUuid, targetVaultUuid))

    expect(addNotificationsForUsers.execute).toHaveBeenNthCalledWith(1, {
      sharedVaultUuid: sourceVaultUuid,
      type: NotificationType.TYPES.SharedVaultFileRemoved,
      payload: expect.anything(),
      version: '1.0',
    })
    expect(addNotificationsForUsers.execute).toHaveBeenNthCalledWith(2, {
      sharedVaultUuid: targetVaultUuid,
      type: NotificationType.TYPES.SharedVaultFileUploaded,
      payload: expect.anything(),
      version: '1.0',
    })
  })

  it('only credits the target vault when the file came from outside any vault', async () => {
    await createHandler().handle(event(undefined, targetVaultUuid))

    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenCalledTimes(1)
    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenCalledWith({
      sharedVaultUuid: targetVaultUuid,
      bytesUsed: 2048,
    })
  })

  it('only debits the source vault when the file left for outside any vault', async () => {
    await createHandler().handle(event(sourceVaultUuid, undefined))

    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenCalledTimes(1)
    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenCalledWith({
      sharedVaultUuid: sourceVaultUuid,
      bytesUsed: -2048,
    })
  })

  it('does nothing when the move involves no shared vault at all', async () => {
    await createHandler().handle(event(undefined, undefined))

    expect(updateStorageQuotaUsedInSharedVault.execute).not.toHaveBeenCalled()
    expect(addNotificationsForUsers.execute).not.toHaveBeenCalled()
  })

  it('abandons the move when the source vault uuid is malformed', async () => {
    await createHandler().handle(event('not-a-uuid', targetVaultUuid))

    expect(updateStorageQuotaUsedInSharedVault.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it('abandons the move when the target vault uuid is malformed', async () => {
    await createHandler().handle(event(sourceVaultUuid, 'not-a-uuid'))

    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenCalledTimes(1)
    expect(addNotificationsForUsers.execute).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })

  it('does not credit the target vault when debiting the source vault failed', async () => {
    updateStorageQuotaUsedInSharedVault.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event(sourceVaultUuid, targetVaultUuid))

    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenCalledTimes(1)
    expect(addNotificationsForUsers.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Failed to update storage quota used in shared vault: Oops')
  })

  it('stops after the source vault when crediting the target vault failed', async () => {
    updateStorageQuotaUsedInSharedVault.execute = jest
      .fn()
      .mockResolvedValueOnce(Result.ok())
      .mockResolvedValueOnce(Result.fail('Oops'))

    await createHandler().handle(event(sourceVaultUuid, targetVaultUuid))

    expect(addNotificationsForUsers.execute).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Failed to update storage quota used in shared vault: Oops')
  })

  it('logs a failure to notify either vault', async () => {
    addNotificationsForUsers.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event(sourceVaultUuid, targetVaultUuid))

    expect(logger.error).toHaveBeenNthCalledWith(1, 'Failed to add notification for users: Oops')
    expect(logger.error).toHaveBeenNthCalledWith(2, 'Failed to add notification for users: Oops')
  })
})
