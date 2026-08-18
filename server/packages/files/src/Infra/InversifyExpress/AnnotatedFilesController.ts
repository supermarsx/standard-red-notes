import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { inject } from 'inversify'
import { Writable } from 'stream'
import { ValetTokenOperation } from '@standardnotes/security'
import { Logger } from 'winston'

import TYPES from '../../Bootstrap/Types'
import { UploadFileChunk } from '../../Domain/UseCase/UploadFileChunk/UploadFileChunk'
import { StreamDownloadFile } from '../../Domain/UseCase/StreamDownloadFile/StreamDownloadFile'
import { CreateUploadSession } from '../../Domain/UseCase/CreateUploadSession/CreateUploadSession'
import { FinishUploadSession } from '../../Domain/UseCase/FinishUploadSession/FinishUploadSession'
import {
  FILE_DATA_NOT_FOUND_MESSAGE,
  FILE_STORAGE_UNAVAILABLE_MESSAGE,
  GetFileMetadata,
} from '../../Domain/UseCase/GetFileMetadata/GetFileMetadata'
import { RemoveFile } from '../../Domain/UseCase/RemoveFile/RemoveFile'
import { ValetTokenResponseLocals } from './Middleware/ValetTokenResponseLocals'
import { executeAbortable, FileDownloadAbortedError } from '../../Domain/UseCase/AbortableOperation'
import {
  FILE_DOWNLOAD_RETRY_AFTER_SECONDS,
  FILE_DOWNLOAD_TIMEOUT_CODE,
  FILE_DOWNLOAD_TIMEOUT_MESSAGE,
  FILE_STORAGE_UNAVAILABLE_CODE,
  FileDownloadRequestLifecycle,
  pipeFileDownload,
} from './FileDownloadRequestLifecycle'

@controller('/v1/files', TYPES.Files_ValetTokenAuthMiddleware)
export class AnnotatedFilesController extends BaseHttpController {
  constructor(
    @inject(TYPES.Files_UploadFileChunk) private uploadFileChunk: UploadFileChunk,
    @inject(TYPES.Files_CreateUploadSession) private createUploadSession: CreateUploadSession,
    @inject(TYPES.Files_FinishUploadSession) private finishUploadSession: FinishUploadSession,
    @inject(TYPES.Files_StreamDownloadFile) private streamDownloadFile: StreamDownloadFile,
    @inject(TYPES.Files_GetFileMetadata) private getFileMetadata: GetFileMetadata,
    @inject(TYPES.Files_RemoveFile) private removeFile: RemoveFile,
    @inject(TYPES.Files_MAX_CHUNK_BYTES) private maxChunkBytes: number,
    @inject(TYPES.Files_FILE_DOWNLOAD_DEADLINE_MS) private fileDownloadDeadlineMs: number,
    @inject(TYPES.Files_Logger) private logger: Logger,
  ) {
    super()
  }

  @httpPost('/upload/create-session')
  async startUpload(
    _request: Request,
    response: Response,
  ): Promise<results.BadRequestErrorMessageResult | results.JsonResult> {
    if (response.locals.permittedOperation !== ValetTokenOperation.Write) {
      return this.badRequest('Not permitted for this operation')
    }

    const result = await this.createUploadSession.execute({
      ownerUuid: response.locals.userUuid,
      resourceRemoteIdentifier: response.locals.permittedResources[0].remoteIdentifier,
    })

    if (!result.success) {
      return this.badRequest(result.message)
    }

    return this.json({ success: true, uploadId: result.uploadId })
  }

  @httpPost('/upload/chunk')
  async uploadChunk(
    request: Request,
    response: Response,
  ): Promise<results.BadRequestErrorMessageResult | results.JsonResult> {
    if (response.locals.permittedOperation !== ValetTokenOperation.Write) {
      return this.badRequest('Not permitted for this operation')
    }

    const chunkId = +(request.headers['x-chunk-id'] as string)
    if (!chunkId) {
      return this.badRequest('Missing x-chunk-id header in request.')
    }

    const result = await this.uploadFileChunk.execute({
      ownerUuid: response.locals.userUuid,
      resourceRemoteIdentifier: response.locals.permittedResources[0].remoteIdentifier,
      resourceUnencryptedFileSize: response.locals.permittedResources[0].unencryptedFileSize,
      chunkId,
      data: request.body,
    })

    if (!result.success) {
      return this.badRequest(result.message)
    }

    return this.json({ success: true, message: 'Chunk uploaded successfully' })
  }

  @httpPost('/upload/close-session')
  public async finishUpload(
    _request: Request,
    response: Response,
  ): Promise<results.BadRequestErrorMessageResult | results.JsonResult> {
    const locals = response.locals as ValetTokenResponseLocals
    if (locals.permittedOperation !== ValetTokenOperation.Write) {
      return this.badRequest('Not permitted for this operation')
    }

    const result = await this.finishUploadSession.execute({
      userUuid: locals.userUuid,
      resourceRemoteIdentifier: locals.permittedResources[0].remoteIdentifier,
      uploadBytesLimit: locals.uploadBytesLimit,
      uploadBytesUsed: locals.uploadBytesUsed,
      valetToken: locals.valetToken,
    })

    if (result.isFailed()) {
      this.logger.error('Operation failed.', safeErrorLogMetadata(result.getError()))

      return this.badRequest(result.getError())
    }

    return this.json({ success: true, message: 'File uploaded successfully' })
  }

  @httpDelete('/')
  async remove(
    _request: Request,
    response: Response,
  ): Promise<results.BadRequestErrorMessageResult | results.JsonResult> {
    const locals = response.locals as ValetTokenResponseLocals
    if (locals.permittedOperation !== ValetTokenOperation.Delete) {
      return this.badRequest('Not permitted for this operation')
    }

    const result = await this.removeFile.execute({
      userInput: {
        userUuid: locals.userUuid,
        resourceRemoteIdentifier: locals.permittedResources[0].remoteIdentifier,
        regularSubscriptionUuid: locals.regularSubscriptionUuid,
      },
      valetToken: locals.valetToken,
    })

    if (result.isFailed()) {
      return this.badRequest(result.getError())
    }

    return this.json({ success: true, message: 'File removed successfully' })
  }

  @httpGet('/')
  async download(request: Request, response: Response): Promise<results.JsonResult | (() => Writable)> {
    const locals = response.locals as ValetTokenResponseLocals
    if (locals.permittedOperation !== ValetTokenOperation.Read) {
      return this.fileDownloadError('Not permitted for this operation', 400)
    }

    const range = request.headers['range']
    if (!range) {
      return this.fileDownloadError('File download requires range header to be set.', 400)
    }

    let chunkSize = +(request.headers['x-chunk-size'] as string)
    if (!chunkSize || chunkSize > this.maxChunkBytes) {
      chunkSize = this.maxChunkBytes
    }

    const lifecycle = new FileDownloadRequestLifecycle(request, response, this.fileDownloadDeadlineMs)
    try {
      const fileMetadataOrError = await executeAbortable(
        () =>
          this.getFileMetadata.execute({
            ownerUuid: locals.userUuid,
            resourceRemoteIdentifier: locals.permittedResources[0].remoteIdentifier,
            abortSignal: lifecycle.signal,
          }),
        lifecycle.signal,
      )
      this.throwIfDownloadAborted(lifecycle)

      if (fileMetadataOrError.isFailed()) {
        const message = fileMetadataOrError.getError()
        const isMissing = message === FILE_DATA_NOT_FOUND_MESSAGE
        lifecycle.dispose()
        return this.fileDownloadError(
          isMissing ? message : FILE_STORAGE_UNAVAILABLE_MESSAGE,
          isMissing ? 404 : 503,
          response,
        )
      }
      const fileSize = fileMetadataOrError.getValue()
      const endRangeOfFile = fileSize - 1

      // Parse "bytes=start-end" properly. The previous Number(range.replace(/\D/g, ''))
      // stripped ALL non-digits, so bytes=100-200 collapsed to 100200 and any bound
      // check was skipped. Validate 0 <= start <= end < fileSize and respond 416 on
      // an unsatisfiable range BEFORE any 206 header is written.
      const parsedRange = parseByteRange(range, fileSize, chunkSize)
      if (parsedRange === null) {
        lifecycle.dispose()
        response.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
        })

        return () => response.end() as unknown as Writable
      }
      const { startRange, endRange } = parsedRange

      // Open and validate the storage stream before committing success headers.
      const result = await executeAbortable(
        () =>
          this.streamDownloadFile.execute({
            ownerUuid: locals.userUuid,
            resourceRemoteIdentifier: locals.permittedResources[0].remoteIdentifier,
            startRange,
            endRange,
            endRangeOfFile,
            valetToken: locals.valetToken,
            abortSignal: lifecycle.signal,
          }),
        lifecycle.signal,
      )
      this.throwIfDownloadAborted(lifecycle, result.success ? result.readStream : undefined)

      if (!result.success) {
        lifecycle.dispose()
        return this.fileDownloadError(FILE_STORAGE_UNAVAILABLE_MESSAGE, 503, response)
      }

      response.writeHead(206, {
        'Content-Range': `bytes ${startRange}-${endRange}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': endRange - startRange + 1,
        'Content-Type': 'application/octet-stream',
      })

      return () => pipeFileDownload(result.readStream, response, lifecycle, this.logger)
    } catch (error) {
      if (lifecycle.clientDisconnected) {
        return this.closedDownloadResponse(response)
      }
      if (response.headersSent) {
        lifecycle.dispose()
        response.destroy(error instanceof Error ? error : undefined)
        return this.closedDownloadResponse(response)
      }

      const timedOut = lifecycle.timedOut || error instanceof FileDownloadAbortedError
      lifecycle.dispose()
      if (timedOut) {
        this.logger.warn('File download deadline exceeded before success headers were written.', {
          code: FILE_DOWNLOAD_TIMEOUT_CODE,
          deadlineMs: this.fileDownloadDeadlineMs,
          stage: 'metadata-or-stream-acquisition',
        })
        return this.fileDownloadError(FILE_DOWNLOAD_TIMEOUT_MESSAGE, 503, response, FILE_DOWNLOAD_TIMEOUT_CODE)
      }

      this.logger.error('File download preparation failed.', safeErrorLogMetadata(error))
      return this.fileDownloadError(FILE_STORAGE_UNAVAILABLE_MESSAGE, 503, response)
    }
  }

  private throwIfDownloadAborted(lifecycle: FileDownloadRequestLifecycle, readStream?: NodeJS.ReadableStream): void {
    if (lifecycle.signal.aborted) {
      if (readStream && 'destroy' in readStream && typeof readStream.destroy === 'function') {
        readStream.destroy()
      }
      throw new FileDownloadAbortedError()
    }
  }

  private closedDownloadResponse(response: Response): () => Writable {
    return () => response as unknown as Writable
  }

  private fileDownloadError(
    message: string,
    statusCode: number,
    response?: Response,
    code = FILE_STORAGE_UNAVAILABLE_CODE,
  ): results.JsonResult {
    if (statusCode === 503) {
      response?.setHeader('Retry-After', FILE_DOWNLOAD_RETRY_AFTER_SECONDS.toString())
      return this.json({ error: { message, code, retryable: true } }, statusCode)
    }
    return this.json({ error: { message } }, statusCode)
  }
}

// Parses an HTTP Range header of the form "bytes=start-end" (end optional) and
// clamps the served window to `chunkSize` and the file bounds. Returns null when
// the range is malformed or unsatisfiable (start out of [0, fileSize)), which the
// caller maps to a 416 response.
function parseByteRange(
  rangeHeader: string | string[],
  fileSize: number,
  chunkSize: number,
): { startRange: number; endRange: number } | null {
  const value = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!match) {
    return null
  }

  const startRange = Number(match[1])
  const explicitEnd = match[2] === '' ? undefined : Number(match[2])

  if (!Number.isFinite(startRange) || startRange < 0 || startRange >= fileSize) {
    return null
  }

  const endRangeOfFile = fileSize - 1
  let endRange = startRange + chunkSize - 1
  if (explicitEnd !== undefined) {
    endRange = Math.min(endRange, explicitEnd)
  }
  endRange = Math.min(endRange, endRangeOfFile)

  if (endRange < startRange) {
    return null
  }

  return { startRange, endRange }
}
