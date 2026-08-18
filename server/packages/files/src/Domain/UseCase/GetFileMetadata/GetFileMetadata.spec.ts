import { Logger } from 'winston'
import { FileDownloaderInterface } from '../../Services/FileDownloaderInterface'

import { FILE_DATA_NOT_FOUND_MESSAGE, FILE_STORAGE_UNAVAILABLE_MESSAGE, GetFileMetadata } from './GetFileMetadata'

describe('GetFileMetadata', () => {
  let fileDownloader: FileDownloaderInterface
  let logger: Logger

  const createUseCase = () => new GetFileMetadata(fileDownloader, logger)

  beforeEach(() => {
    fileDownloader = {} as jest.Mocked<FileDownloaderInterface>
    fileDownloader.getFileSize = jest.fn().mockReturnValue(123)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should return the file metadata', async () => {
    const result = await createUseCase().execute({ resourceRemoteIdentifier: '1-2-3', ownerUuid: '2-3-4' })
    expect(result.getValue()).toEqual(123)
  })

  it('classifies a missing filesystem object without leaking the storage error', async () => {
    fileDownloader.getFileSize = jest.fn().mockImplementation(() => {
      throw Object.assign(new Error('private filesystem path'), { code: 'ENOENT' })
    })

    const result = await createUseCase().execute({ resourceRemoteIdentifier: '1-2-3', ownerUuid: '2-3-4' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe(FILE_DATA_NOT_FOUND_MESSAGE)
  })

  it('classifies a missing S3 object from its HTTP status', async () => {
    fileDownloader.getFileSize = jest.fn().mockRejectedValue({
      name: 'S3ServiceException',
      $metadata: { httpStatusCode: 404 },
    })

    const result = await createUseCase().execute({ resourceRemoteIdentifier: '1-2-3', ownerUuid: '2-3-4' })

    expect(result.getError()).toBe(FILE_DATA_NOT_FOUND_MESSAGE)
  })

  it('classifies other storage failures as unavailable', async () => {
    fileDownloader.getFileSize = jest.fn().mockRejectedValue(new Error('storage credentials rejected'))

    const result = await createUseCase().execute({ resourceRemoteIdentifier: '1-2-3', ownerUuid: '2-3-4' })

    expect(result.getError()).toBe(FILE_STORAGE_UNAVAILABLE_MESSAGE)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('2-3-4/1-2-3'), expect.any(Object))
  })

  it.each([['storage failed'], [{ code: 'Other', name: 42 }]])(
    'classifies a non-file storage rejection without assuming an Error shape',
    async (storageFailure) => {
      const abortController = new AbortController()
      fileDownloader.getFileSize = jest.fn().mockRejectedValue(storageFailure)

      const result = await createUseCase().execute({
        resourceRemoteIdentifier: '1-2-3',
        ownerUuid: '2-3-4',
        abortSignal: abortController.signal,
      })

      expect(result.getError()).toBe(FILE_STORAGE_UNAVAILABLE_MESSAGE)
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('2-3-4/1-2-3'), expect.any(Object))
    },
  )

  it('fails immediately when metadata lookup starts with an already-aborted signal', async () => {
    const abortController = new AbortController()
    abortController.abort()

    const result = await createUseCase().execute({
      resourceRemoteIdentifier: '1-2-3',
      ownerUuid: '2-3-4',
      abortSignal: abortController.signal,
    })

    expect(result.getError()).toBe(FILE_STORAGE_UNAVAILABLE_MESSAGE)
    expect(fileDownloader.getFileSize).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('bounds a metadata implementation that ignores cancellation while forwarding the signal', async () => {
    const abortController = new AbortController()
    let started!: () => void
    const operationStarted = new Promise<void>((resolve) => (started = resolve))
    let rejectStorage!: (error: Error) => void
    let receivedSignal: AbortSignal | undefined
    fileDownloader.getFileSize = jest.fn((_path, abortSignal) => {
      receivedSignal = abortSignal
      started()
      return new Promise<number>((_resolve, reject) => {
        rejectStorage = reject
      })
    })

    const resultPromise = createUseCase().execute({
      resourceRemoteIdentifier: '1-2-3',
      ownerUuid: '2-3-4',
      abortSignal: abortController.signal,
    })
    await operationStarted
    abortController.abort()
    const result = await resultPromise

    expect(receivedSignal).toBe(abortController.signal)
    expect(result.getError()).toBe(FILE_STORAGE_UNAVAILABLE_MESSAGE)
    expect(logger.error).not.toHaveBeenCalled()

    rejectStorage(new Error('late storage rejection'))
    await Promise.resolve()
    await Promise.resolve()
  })
})
