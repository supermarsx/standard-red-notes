import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { ValetTokenOperation } from '@standardnotes/security'
import { Request, Response } from 'express'
import { results } from 'inversify-express-utils'
import { Readable, Writable } from 'stream'
import { Logger } from 'winston'

import { CreateUploadSession } from '../../Domain/UseCase/CreateUploadSession/CreateUploadSession'
import { FinishUploadSession } from '../../Domain/UseCase/FinishUploadSession/FinishUploadSession'
import { GetFileMetadata } from '../../Domain/UseCase/GetFileMetadata/GetFileMetadata'
import { MoveFile } from '../../Domain/UseCase/MoveFile/MoveFile'
import { RemoveFile } from '../../Domain/UseCase/RemoveFile/RemoveFile'
import { StreamDownloadFile } from '../../Domain/UseCase/StreamDownloadFile/StreamDownloadFile'
import { UploadFileChunk } from '../../Domain/UseCase/UploadFileChunk/UploadFileChunk'
import { FileDownloadAbortedError } from '../../Domain/UseCase/AbortableOperation'
import { AnnotatedSharedVaultFilesController } from './AnnotatedSharedVaultFilesController'

describe('AnnotatedSharedVaultFilesController', () => {
  let uploadFileChunk: UploadFileChunk
  let createUploadSession: CreateUploadSession
  let finishUploadSession: FinishUploadSession
  let streamDownloadFile: StreamDownloadFile
  let getFileMetadata: GetFileMetadata
  let removeFile: RemoveFile
  let moveFile: MoveFile
  let logger: Logger
  let request: Request
  let response: Response
  let readStream: Readable

  const maxChunkBytes = 100_000
  const fileDownloadDeadlineMs = 30_000
  const valetTokenData = {
    sharedVaultUuid: 'shared-vault-uuid',
    vaultOwnerUuid: 'vault-owner-uuid',
    permittedOperation: ValetTokenOperation.Write,
    remoteIdentifier: 'remote-identifier',
    unencryptedFileSize: 123,
    uploadBytesUsed: 400,
    uploadBytesLimit: 1_000,
    moveOperation: {
      type: 'shared-vault-to-user' as const,
      from: {
        sharedVaultUuid: 'shared-vault-uuid',
        ownerUuid: 'vault-owner-uuid',
      },
      to: {
        ownerUuid: 'target-owner-uuid',
      },
    },
  }

  const createController = () =>
    new AnnotatedSharedVaultFilesController(
      uploadFileChunk,
      createUploadSession,
      finishUploadSession,
      streamDownloadFile,
      getFileMetadata,
      removeFile,
      moveFile,
      maxChunkBytes,
      fileDownloadDeadlineMs,
      logger,
    )

  const expectBadRequest = (result: unknown) => {
    expect(result).toBeInstanceOf(results.BadRequestErrorMessageResult)
  }

  const expectJsonError = (result: unknown, statusCode: number, message: string) => {
    expect(result).toBeInstanceOf(results.JsonResult)
    expect(result).toEqual(expect.objectContaining({ statusCode }))
    expect((result as results.JsonResult).json).toEqual({ error: expect.objectContaining({ message }) })
  }

  beforeEach(() => {
    uploadFileChunk = { execute: jest.fn().mockResolvedValue({ success: true }) } as unknown as UploadFileChunk
    createUploadSession = {
      execute: jest.fn().mockResolvedValue({ success: true, uploadId: 'upload-id' }),
    } as unknown as CreateUploadSession
    finishUploadSession = { execute: jest.fn().mockResolvedValue(Result.ok()) } as unknown as FinishUploadSession
    getFileMetadata = { execute: jest.fn().mockResolvedValue(Result.ok(555_555)) } as unknown as GetFileMetadata
    removeFile = { execute: jest.fn().mockResolvedValue(Result.ok()) } as unknown as RemoveFile
    moveFile = { execute: jest.fn().mockResolvedValue(Result.ok()) } as unknown as MoveFile

    readStream = {
      pipe: jest.fn().mockReturnValue(new Writable()),
      once: jest.fn().mockReturnThis(),
      removeListener: jest.fn().mockReturnThis(),
      destroy: jest.fn().mockReturnThis(),
    } as unknown as Readable
    streamDownloadFile = {
      execute: jest.fn().mockResolvedValue({ success: true, readStream }),
    } as unknown as StreamDownloadFile

    logger = {
      error: jest.fn(),
      warn: jest.fn(),
    } as unknown as Logger

    request = {
      body: Buffer.from([123]),
      headers: {},
      once: jest.fn().mockReturnThis(),
      removeListener: jest.fn().mockReturnThis(),
    } as Request
    response = {
      locals: {
        valetToken: 'valet-token',
        valetTokenData: structuredClone(valetTokenData),
      },
      destroy: jest.fn().mockReturnThis(),
      end: jest.fn().mockReturnValue(new Writable()),
      once: jest.fn().mockReturnThis(),
      removeListener: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      writeHead: jest.fn().mockReturnThis(),
    } as unknown as Response
  })

  describe('moveFileRequest', () => {
    it('moves the resource described by the valet token', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Move

      await createController().moveFileRequest(request, response)

      expect(moveFile.execute).toHaveBeenCalledWith({
        moveType: 'shared-vault-to-user',
        from: valetTokenData.moveOperation.from,
        to: valetTokenData.moveOperation.to,
        resourceRemoteIdentifier: valetTokenData.remoteIdentifier,
      })
    })

    it('rejects a non-move token', async () => {
      expectBadRequest(await createController().moveFileRequest(request, response))
      expect(moveFile.execute).not.toHaveBeenCalled()
    })

    it('rejects a move token without move data', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Move
      response.locals.valetTokenData.moveOperation = undefined

      expectBadRequest(await createController().moveFileRequest(request, response))
      expect(moveFile.execute).not.toHaveBeenCalled()
    })

    it('returns the move failure', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Move
      moveFile.execute = jest.fn().mockResolvedValue(Result.fail('move failed'))

      expectBadRequest(await createController().moveFileRequest(request, response))
    })
  })

  describe('startUpload', () => {
    it('creates an upload owned by the shared vault', async () => {
      await createController().startUpload(request, response)

      expect(createUploadSession.execute).toHaveBeenCalledWith({
        ownerUuid: valetTokenData.sharedVaultUuid,
        resourceRemoteIdentifier: valetTokenData.remoteIdentifier,
      })
    })

    it('rejects a non-write token', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Read

      expectBadRequest(await createController().startUpload(request, response))
      expect(createUploadSession.execute).not.toHaveBeenCalled()
    })

    it('returns an upload-session failure', async () => {
      createUploadSession.execute = jest.fn().mockResolvedValue({ success: false, message: 'create failed' })

      expectBadRequest(await createController().startUpload(request, response))
    })
  })

  describe('uploadChunk', () => {
    it('uploads a numbered chunk for the shared-vault resource', async () => {
      request.headers['x-chunk-id'] = '2'

      await createController().uploadChunk(request, response)

      expect(uploadFileChunk.execute).toHaveBeenCalledWith({
        ownerUuid: valetTokenData.sharedVaultUuid,
        resourceRemoteIdentifier: valetTokenData.remoteIdentifier,
        resourceUnencryptedFileSize: valetTokenData.unencryptedFileSize,
        chunkId: 2,
        data: request.body,
      })
    })

    it('rejects a non-write token', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Read

      expectBadRequest(await createController().uploadChunk(request, response))
      expect(uploadFileChunk.execute).not.toHaveBeenCalled()
    })

    it('rejects a missing chunk id', async () => {
      expectBadRequest(await createController().uploadChunk(request, response))
      expect(uploadFileChunk.execute).not.toHaveBeenCalled()
    })

    it('returns a chunk-upload failure', async () => {
      request.headers['x-chunk-id'] = '2'
      uploadFileChunk.execute = jest.fn().mockResolvedValue({ success: false, message: 'upload failed' })

      expectBadRequest(await createController().uploadChunk(request, response))
    })
  })

  describe('finishUpload', () => {
    it('closes the shared-vault upload with quota context', async () => {
      await createController().finishUpload(request, response)

      expect(finishUploadSession.execute).toHaveBeenCalledWith({
        userUuid: valetTokenData.vaultOwnerUuid,
        sharedVaultUuid: valetTokenData.sharedVaultUuid,
        resourceRemoteIdentifier: valetTokenData.remoteIdentifier,
        uploadBytesLimit: valetTokenData.uploadBytesLimit,
        uploadBytesUsed: valetTokenData.uploadBytesUsed,
        valetToken: 'valet-token',
      })
    })

    it('rejects a non-write token', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Read

      expectBadRequest(await createController().finishUpload(request, response))
      expect(finishUploadSession.execute).not.toHaveBeenCalled()
    })

    it('rejects a token without an upload limit', async () => {
      response.locals.valetTokenData.uploadBytesLimit = undefined

      expectBadRequest(await createController().finishUpload(request, response))
      expect(finishUploadSession.execute).not.toHaveBeenCalled()
    })

    it('logs a safe classification and returns a close-session failure', async () => {
      finishUploadSession.execute = jest.fn().mockResolvedValue(Result.fail('close failed'))

      expectBadRequest(await createController().finishUpload(request, response))
      expect(logger.error).toHaveBeenCalledWith('Operation failed.', expect.objectContaining({ errorType: 'Error' }))
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('close failed')
    })
  })

  describe('remove', () => {
    beforeEach(() => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Delete
    })

    it('removes the shared-vault resource', async () => {
      await createController().remove(request, response)

      expect(removeFile.execute).toHaveBeenCalledWith({
        vaultInput: {
          sharedVaultUuid: valetTokenData.sharedVaultUuid,
          vaultOwnerUuid: valetTokenData.vaultOwnerUuid,
          resourceRemoteIdentifier: valetTokenData.remoteIdentifier,
        },
        valetToken: 'valet-token',
      })
    })

    it('rejects a non-delete token', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Read

      expectBadRequest(await createController().remove(request, response))
      expect(removeFile.execute).not.toHaveBeenCalled()
    })

    it('returns a removal failure', async () => {
      removeFile.execute = jest.fn().mockResolvedValue(Result.fail('remove failed'))

      expectBadRequest(await createController().remove(request, response))
    })
  })

  describe('download', () => {
    beforeEach(() => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Read
      request.headers.range = 'bytes=0-'
    })

    it('streams a bounded byte range and passes the valet token to storage', async () => {
      const streamResponse = (await createController().download(request, response)) as () => Writable

      expect(streamDownloadFile.execute).toHaveBeenCalledWith({
        ownerUuid: valetTokenData.sharedVaultUuid,
        resourceRemoteIdentifier: valetTokenData.remoteIdentifier,
        startRange: 0,
        endRange: 99_999,
        valetToken: 'valet-token',
        endRangeOfFile: 555_554,
        abortSignal: expect.any(AbortSignal),
      })
      expect(response.writeHead).toHaveBeenCalledWith(206, {
        'Content-Range': 'bytes 0-99999/555555',
        'Accept-Ranges': 'bytes',
        'Content-Length': 100_000,
        'Content-Type': 'application/octet-stream',
      })
      expect(streamResponse()).toBeInstanceOf(Writable)
    })

    it('rejects a non-read token', async () => {
      response.locals.valetTokenData.permittedOperation = ValetTokenOperation.Write

      expectJsonError(await createController().download(request, response), 400, 'Not permitted for this operation')
      expect(getFileMetadata.execute).not.toHaveBeenCalled()
    })

    it('rejects a missing range header', async () => {
      delete request.headers.range

      expectJsonError(
        await createController().download(request, response),
        400,
        'File download requires range header to be set.',
      )
      expect(getFileMetadata.execute).not.toHaveBeenCalled()
    })

    it('uses a valid custom chunk size', async () => {
      request.headers['x-chunk-size'] = '50'

      await createController().download(request, response)

      expect(streamDownloadFile.execute).toHaveBeenCalledWith(expect.objectContaining({ startRange: 0, endRange: 49 }))
    })

    it('caps an oversized custom chunk size', async () => {
      request.headers['x-chunk-size'] = '200000'

      await createController().download(request, response)

      expect(streamDownloadFile.execute).toHaveBeenCalledWith(
        expect.objectContaining({ startRange: 0, endRange: 99_999 }),
      )
    })

    it.each([
      ['Encrypted file data was not found on this server.', 404],
      ['Encrypted file storage is temporarily unavailable.', 503],
    ])('maps a metadata failure to its public download contract', async (message, statusCode) => {
      getFileMetadata.execute = jest.fn().mockResolvedValue(Result.fail(message))

      expectJsonError(await createController().download(request, response), statusCode, message)
      expect(streamDownloadFile.execute).not.toHaveBeenCalled()
      if (statusCode === 503) {
        expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1')
      }
    })

    it.each([['not-a-range'], ['bytes=999999-'], ['bytes=10-9'], [`bytes=${'9'.repeat(400)}-`]])(
      'returns 416 for an unsatisfiable range %s',
      async (range) => {
        request.headers.range = range

        const endResponse = (await createController().download(request, response)) as () => Writable
        endResponse()

        expect(response.writeHead).toHaveBeenCalledWith(416, {
          'Content-Range': 'bytes */555555',
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
        })
        expect(streamDownloadFile.execute).not.toHaveBeenCalled()
        expect(response.end).toHaveBeenCalled()
      },
    )

    it('honors an explicit range end supplied as a header array', async () => {
      request.headers.range = ['bytes=10-19']

      await createController().download(request, response)

      expect(streamDownloadFile.execute).toHaveBeenCalledWith(expect.objectContaining({ startRange: 10, endRange: 19 }))
    })

    it('clamps the final range to the end of the file', async () => {
      request.headers.range = 'bytes=555500-'

      await createController().download(request, response)

      expect(streamDownloadFile.execute).toHaveBeenCalledWith(
        expect.objectContaining({ startRange: 555_500, endRange: 555_554 }),
      )
    })

    it('returns a storage stream failure before writing success headers', async () => {
      streamDownloadFile.execute = jest.fn().mockResolvedValue({ success: false, message: 'stream failed' })

      expectJsonError(
        await createController().download(request, response),
        503,
        'Encrypted file storage is temporarily unavailable.',
      )
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1')
      expect(response.writeHead).not.toHaveBeenCalled()
    })

    it('closes without success headers when the client disconnects at the stream-acquisition handoff', async () => {
      streamDownloadFile.execute = jest.fn().mockImplementation(({ abortSignal }) => {
        const originalRemoveEventListener = abortSignal.removeEventListener.bind(abortSignal)
        jest.spyOn(abortSignal, 'removeEventListener').mockImplementation((type, listener, options) => {
          originalRemoveEventListener(type, listener, options)
          const disconnect = (request.once as jest.Mock).mock.calls.find(([event]) => event === 'aborted')[1] as () => void
          disconnect()
        })
        return { success: true, readStream }
      })

      const closedResponse = (await createController().download(request, response)) as () => Writable

      expect(response.writeHead).not.toHaveBeenCalled()
      expect(readStream.destroy).toHaveBeenCalled()
      expect(closedResponse()).toBe(response)
    })

    it('destroys an already-headed response when download preparation rejects', async () => {
      const failure = new Error('metadata failed after headers')
      Object.assign(response, { headersSent: true })
      getFileMetadata.execute = jest.fn().mockRejectedValue(failure)

      const closedResponse = (await createController().download(request, response)) as () => Writable

      expect(response.destroy).toHaveBeenCalledWith(failure)
      expect(closedResponse()).toBe(response)
    })

    it('returns a retryable timeout when preparation is aborted before success headers', async () => {
      getFileMetadata.execute = jest.fn().mockRejectedValue(new FileDownloadAbortedError())

      const httpResponse = await createController().download(request, response)

      expectJsonError(httpResponse, 503, 'Encrypted file download timed out. Please try again.')
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1')
      expect(logger.warn).toHaveBeenCalledWith(
        'File download deadline exceeded before success headers were written.',
        expect.objectContaining({ code: 'file_download_timed_out' }),
      )
    })

    it('returns a retryable storage error for an unexpected preparation rejection', async () => {
      getFileMetadata.execute = jest.fn().mockRejectedValue('metadata backend failed')

      const httpResponse = await createController().download(request, response)

      expectJsonError(httpResponse, 503, 'Encrypted file storage is temporarily unavailable.')
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1')
      expect(logger.error).toHaveBeenCalledWith('File download preparation failed.', expect.any(Object))
    })

    it('destroys both sides when the source stream errors', async () => {
      const streamResponse = (await createController().download(request, response)) as () => Writable
      streamResponse()
      const errorHandler = (readStream.once as jest.Mock).mock.calls.find(([event]) => event === 'error')[1]

      errorHandler(new Error('stream failed'))

      expect(logger.error).toHaveBeenCalledWith(
        'Error while streaming file download.',
        expect.objectContaining({ errorType: 'Error' }),
      )
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('stream failed')
      expect(readStream.destroy).toHaveBeenCalled()
      expect(response.destroy).toHaveBeenCalledWith(expect.any(Error))
    })

    it('destroys the source stream when the response closes', async () => {
      const streamResponse = (await createController().download(request, response)) as () => Writable
      streamResponse()
      const closeHandler = (response.once as jest.Mock).mock.calls.find(([event]) => event === 'close')[1]

      closeHandler()

      expect(readStream.destroy).toHaveBeenCalled()
    })
  })
})
