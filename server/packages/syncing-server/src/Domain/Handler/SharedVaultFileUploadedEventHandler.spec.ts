import 'reflect-metadata'
import { NotificationType, Result } from '@standardnotes/domain-core'
import { SharedVaultFileUploadedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { AddNotificationsForUsers } from '../UseCase/Messaging/AddNotificationsForUsers/AddNotificationsForUsers'
import { UpdateStorageQuotaUsedInSharedVault } from '../UseCase/SharedVaults/UpdateStorageQuotaUsedInSharedVault/UpdateStorageQuotaUsedInSharedVault'

import { SharedVaultFileUploadedEventHandler } from './SharedVaultFileUploadedEventHandler'

describe('SharedVaultFileUploadedEventHandler', () => {
  let updateStorageQuotaUsedInSharedVault: UpdateStorageQuotaUsedInSharedVault
  let addNotificationsForUsers: AddNotificationsForUsers
  let logger: Logger

  const sharedVaultUuid = '00000000-0000-0000-0000-000000000001'

  const createHandler = () =>
    new SharedVaultFileUploadedEventHandler(updateStorageQuotaUsedInSharedVault, addNotificationsForUsers, logger)

  const event = (uuid = sharedVaultUuid) =>
    ({
      payload: { sharedVaultUuid: uuid, fileByteSize: 2048 },
    }) as jest.Mocked<SharedVaultFileUploadedEvent>

  beforeEach(() => {
    updateStorageQuotaUsedInSharedVault = {} as jest.Mocked<UpdateStorageQuotaUsedInSharedVault>
    updateStorageQuotaUsedInSharedVault.execute = jest.fn().mockResolvedValue(Result.ok())

    addNotificationsForUsers = {} as jest.Mocked<AddNotificationsForUsers>
    addNotificationsForUsers.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('adds the uploaded file size to the shared vault quota', async () => {
    await createHandler().handle(event())

    expect(updateStorageQuotaUsedInSharedVault.execute).toHaveBeenCalledWith({ sharedVaultUuid, bytesUsed: 2048 })
  })

  it('notifies the vault members that a file was uploaded', async () => {
    await createHandler().handle(event())

    expect(addNotificationsForUsers.execute).toHaveBeenCalledWith({
      sharedVaultUuid,
      type: NotificationType.TYPES.SharedVaultFileUploaded,
      payload: expect.anything(),
      version: '1.0',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('does not adjust the quota when the shared vault uuid is malformed', async () => {
    await createHandler().handle(event('not-a-uuid'))

    expect(updateStorageQuotaUsedInSharedVault.execute).not.toHaveBeenCalled()
    expect(addNotificationsForUsers.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it('does not notify anyone when the quota could not be updated', async () => {
    updateStorageQuotaUsedInSharedVault.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(addNotificationsForUsers.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Failed to update storage quota used in shared vault: Oops')
  })

  it('logs a failure to notify the vault members', async () => {
    addNotificationsForUsers.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(logger.error).toHaveBeenCalledWith('Failed to add notification for users: Oops')
  })
})
