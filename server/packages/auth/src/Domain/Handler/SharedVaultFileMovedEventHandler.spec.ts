import { SharedVaultFileMovedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { UpdateStorageQuotaUsedForUser } from '../UseCase/UpdateStorageQuotaUsedForUser/UpdateStorageQuotaUsedForUser'

import { SharedVaultFileMovedEventHandler } from './SharedVaultFileMovedEventHandler'

describe('SharedVaultFileMovedEventHandler', () => {
  let updateStorageQuotaUsedForUser: UpdateStorageQuotaUsedForUser
  let logger: Logger

  const fromOwnerUuid = '00000000-0000-0000-0000-000000000000'
  const toOwnerUuid = '11111111-1111-1111-1111-111111111111'

  const event = {
    payload: {
      from: { ownerUuid: fromOwnerUuid },
      to: { ownerUuid: toOwnerUuid },
      fileByteSize: 700,
    },
  } as unknown as jest.Mocked<SharedVaultFileMovedEvent>

  const createHandler = () => new SharedVaultFileMovedEventHandler(updateStorageQuotaUsedForUser, logger)

  beforeEach(() => {
    updateStorageQuotaUsedForUser = {} as jest.Mocked<UpdateStorageQuotaUsedForUser>
    updateStorageQuotaUsedForUser.execute = jest.fn().mockResolvedValue(Result.ok('updated'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should move the bytes from the source owner to the destination owner', async () => {
    await createHandler().handle(event)

    expect(updateStorageQuotaUsedForUser.execute).toHaveBeenCalledTimes(2)
    expect(updateStorageQuotaUsedForUser.execute).toHaveBeenNthCalledWith(1, {
      userUuid: fromOwnerUuid,
      bytesUsed: -700,
    })
    expect(updateStorageQuotaUsedForUser.execute).toHaveBeenNthCalledWith(2, { userUuid: toOwnerUuid, bytesUsed: 700 })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should still credit the destination owner if subtracting from the source owner fails', async () => {
    updateStorageQuotaUsedForUser.execute = jest
      .fn()
      .mockResolvedValueOnce(Result.fail('subtract oops'))
      .mockResolvedValueOnce(Result.ok('updated'))

    await createHandler().handle(event)

    expect(updateStorageQuotaUsedForUser.execute).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Failed to update storage quota used for user: subtract oops')
  })

  it('should log an error if crediting the destination owner fails', async () => {
    updateStorageQuotaUsedForUser.execute = jest
      .fn()
      .mockResolvedValueOnce(Result.ok('updated'))
      .mockResolvedValueOnce(Result.fail('add oops'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Failed to update storage quota used for user: add oops')
  })
})
