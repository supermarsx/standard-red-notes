import { FileQuotaRecalculatedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { UpdateStorageQuotaUsedForUser } from '../UseCase/UpdateStorageQuotaUsedForUser/UpdateStorageQuotaUsedForUser'

import { FileQuotaRecalculatedEventHandler } from './FileQuotaRecalculatedEventHandler'

describe('FileQuotaRecalculatedEventHandler', () => {
  let updateStorageQuota: UpdateStorageQuotaUsedForUser
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const event = {
    payload: { userUuid, totalFileByteSize: 4096 },
  } as jest.Mocked<FileQuotaRecalculatedEvent>

  const createHandler = () => new FileQuotaRecalculatedEventHandler(updateStorageQuota, logger)

  beforeEach(() => {
    updateStorageQuota = {} as jest.Mocked<UpdateStorageQuotaUsedForUser>
    updateStorageQuota.execute = jest.fn().mockResolvedValue(Result.ok('updated'))

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.error = jest.fn()
  })

  it('should set the quota to the recalculated absolute total', async () => {
    await createHandler().handle(event)

    expect(updateStorageQuota.execute).toHaveBeenCalledWith({ userUuid, bytesUsed: 4096 })
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('Storage quota updated', {
      userId: userUuid,
      totalFileByteSize: 4096,
      codeTag: 'FileQuotaRecalculatedEventHandler',
    })
  })

  it('should not log success when the update fails', async () => {
    updateStorageQuota.execute = jest.fn().mockResolvedValue(Result.fail('quota oops'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Could not update storage quota', {
      userId: userUuid,
      codeTag: 'FileQuotaRecalculatedEventHandler',
    })
    expect(logger.info).not.toHaveBeenCalledWith('Storage quota updated', expect.anything())
  })
})
