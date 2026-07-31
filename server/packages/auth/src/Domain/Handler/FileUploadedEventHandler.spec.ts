import { FileUploadedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { UpdateStorageQuotaUsedForUser } from '../UseCase/UpdateStorageQuotaUsedForUser/UpdateStorageQuotaUsedForUser'

import { FileUploadedEventHandler } from './FileUploadedEventHandler'

describe('FileUploadedEventHandler', () => {
  let updateStorageQuotaUsedForUser: UpdateStorageQuotaUsedForUser
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const event = {
    payload: { userUuid, fileByteSize: 123 },
  } as jest.Mocked<FileUploadedEvent>

  const createHandler = () => new FileUploadedEventHandler(updateStorageQuotaUsedForUser, logger)

  beforeEach(() => {
    updateStorageQuotaUsedForUser = {} as jest.Mocked<UpdateStorageQuotaUsedForUser>
    updateStorageQuotaUsedForUser.execute = jest.fn().mockResolvedValue(Result.ok('updated'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should add the uploaded file size to the storage quota used', async () => {
    await createHandler().handle(event)

    expect(updateStorageQuotaUsedForUser.execute).toHaveBeenCalledWith({ userUuid, bytesUsed: 123 })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error if the quota update fails', async () => {
    updateStorageQuotaUsedForUser.execute = jest.fn().mockResolvedValue(Result.fail('quota oops'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Failed to update storage quota after a file was uploaded.')
  })
})
