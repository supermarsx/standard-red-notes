import { SharedVaultFileRemovedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { UpdateStorageQuotaUsedForUser } from '../UseCase/UpdateStorageQuotaUsedForUser/UpdateStorageQuotaUsedForUser'

import { SharedVaultFileRemovedEventHandler } from './SharedVaultFileRemovedEventHandler'

describe('SharedVaultFileRemovedEventHandler', () => {
  let updateStorageQuotaUsedForUser: UpdateStorageQuotaUsedForUser
  let logger: Logger

  const vaultOwnerUuid = '00000000-0000-0000-0000-000000000000'

  const event = {
    payload: { vaultOwnerUuid, removerUuid: 'someone-else', fileByteSize: 500 },
  } as unknown as jest.Mocked<SharedVaultFileRemovedEvent>

  const createHandler = () => new SharedVaultFileRemovedEventHandler(updateStorageQuotaUsedForUser, logger)

  beforeEach(() => {
    updateStorageQuotaUsedForUser = {} as jest.Mocked<UpdateStorageQuotaUsedForUser>
    updateStorageQuotaUsedForUser.execute = jest.fn().mockResolvedValue(Result.ok('updated'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should credit the removal back to the vault owner, not the remover', async () => {
    await createHandler().handle(event)

    expect(updateStorageQuotaUsedForUser.execute).toHaveBeenCalledWith({ userUuid: vaultOwnerUuid, bytesUsed: -500 })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error if the quota update fails', async () => {
    updateStorageQuotaUsedForUser.execute = jest.fn().mockResolvedValue(Result.fail('quota oops'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Failed to update storage quota used for user: quota oops')
  })
})
