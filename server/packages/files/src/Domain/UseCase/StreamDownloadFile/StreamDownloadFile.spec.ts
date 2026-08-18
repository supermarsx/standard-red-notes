import 'reflect-metadata'

import { Readable } from 'stream'
import { Logger } from 'winston'
import { FileDownloaderInterface } from '../../Services/FileDownloaderInterface'

import { StreamDownloadFile } from './StreamDownloadFile'
import { ValetTokenRepositoryInterface } from '../../ValetToken/ValetTokenRepositoryInterface'

describe('StreamDownloadFile', () => {
  let fileDownloader: FileDownloaderInterface
  let logger: Logger
  const valetToken = 'valet-token'
  let valetTokenRepository: ValetTokenRepositoryInterface

  const createUseCase = () => new StreamDownloadFile(fileDownloader, valetTokenRepository, logger)

  beforeEach(() => {
    valetTokenRepository = {} as jest.Mocked<ValetTokenRepositoryInterface>
    valetTokenRepository.markAsUsed = jest.fn()

    fileDownloader = {} as jest.Mocked<FileDownloaderInterface>
    fileDownloader.createDownloadStream = jest.fn().mockReturnValue(new Readable())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should stream download file contents from S3', async () => {
    const result = await createUseCase().execute({
      ownerUuid: '2-3-4',
      resourceRemoteIdentifier: '1-2-3',
      startRange: 0,
      endRange: 200,
      endRangeOfFile: 300,
      valetToken,
    })

    expect(result.success).toBeTruthy()
  })

  it('should mark valet token as used if the last chunk is being streamed', async () => {
    const result = await createUseCase().execute({
      ownerUuid: '2-3-4',
      resourceRemoteIdentifier: '1-2-3',
      startRange: 0,
      endRange: 200,
      endRangeOfFile: 200,
      valetToken,
    })

    expect(result.success).toBeTruthy()

    expect(valetTokenRepository.markAsUsed).toHaveBeenCalledWith(valetToken)
  })

  it('should not stream download file contents from S3 if it fails', async () => {
    fileDownloader.createDownloadStream = jest.fn().mockImplementation(() => {
      throw new Error('oops')
    })

    const result = await createUseCase().execute({
      ownerUuid: '2-3-4',
      resourceRemoteIdentifier: '1-2-3',
      startRange: 0,
      endRange: 200,
      endRangeOfFile: 200,
      valetToken,
    })

    expect(result.success).toBeFalsy()
  })

  it('bounds a hung stream acquisition and forwards cancellation to storage', async () => {
    const abortController = new AbortController()
    let started!: () => void
    const operationStarted = new Promise<void>((resolve) => (started = resolve))
    let receivedSignal: AbortSignal | undefined
    fileDownloader.createDownloadStream = jest.fn((_path, _start, _end, abortSignal) => {
      receivedSignal = abortSignal
      started()
      return new Promise<Readable>(() => undefined)
    })

    const resultPromise = createUseCase().execute({
      ownerUuid: '2-3-4',
      resourceRemoteIdentifier: '1-2-3',
      startRange: 0,
      endRange: 200,
      endRangeOfFile: 300,
      valetToken,
      abortSignal: abortController.signal,
    })
    await operationStarted
    abortController.abort()
    const result = await resultPromise

    expect(receivedSignal).toBe(abortController.signal)
    expect(result.success).toBe(false)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('destroys an acquired stream when final-chunk token persistence hangs past cancellation', async () => {
    const abortController = new AbortController()
    const readStream = new Readable()
    const destroy = jest.spyOn(readStream, 'destroy')
    fileDownloader.createDownloadStream = jest.fn().mockResolvedValue(readStream)
    let started!: () => void
    const persistenceStarted = new Promise<void>((resolve) => (started = resolve))
    valetTokenRepository.markAsUsed = jest.fn(() => {
      started()
      return new Promise<void>(() => undefined)
    })

    const resultPromise = createUseCase().execute({
      ownerUuid: '2-3-4',
      resourceRemoteIdentifier: '1-2-3',
      startRange: 0,
      endRange: 200,
      endRangeOfFile: 200,
      valetToken,
      abortSignal: abortController.signal,
    })
    await persistenceStarted
    abortController.abort()
    const result = await resultPromise

    expect(result.success).toBe(false)
    expect(destroy).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('destroys a stream when cancellation wins the acquisition handoff', async () => {
    const abortController = new AbortController()
    const readStream = new Readable()
    const destroy = jest.spyOn(readStream, 'destroy')
    const originalRemoveEventListener = abortController.signal.removeEventListener.bind(abortController.signal)
    const removeEventListener = jest
      .spyOn(abortController.signal, 'removeEventListener')
      .mockImplementation((type, listener, options) => {
        originalRemoveEventListener(type, listener, options)
        abortController.abort()
      })
    fileDownloader.createDownloadStream = jest.fn().mockResolvedValue(readStream)

    const result = await createUseCase().execute({
      ownerUuid: '2-3-4',
      resourceRemoteIdentifier: '1-2-3',
      startRange: 0,
      endRange: 200,
      endRangeOfFile: 300,
      valetToken,
      abortSignal: abortController.signal,
    })

    expect(result.success).toBe(false)
    expect(destroy).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    removeEventListener.mockRestore()
  })
})
