import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { inject } from 'inversify'
import { Writable } from 'stream'
import { ValetTokenOperation } from '@standardnotes/security'
import { Logger } from 'winston'

import TYPES from '../../Bootstrap/Types'
import { CreateUploadSession } from '../../Domain/UseCase/CreateUploadSession/CreateUploadSession'
import { FinishUploadSession } from '../../Domain/UseCase/FinishUploadSession/FinishUploadSession'
import { GetFileMetadata } from '../../Domain/UseCase/GetFileMetadata/GetFileMetadata'
import { MoveFile } from '../../Domain/UseCase/MoveFile/MoveFile'
import { RemoveFile } from '../../Domain/UseCase/RemoveFile/RemoveFile'
import { StreamDownloadFile } from '../../Domain/UseCase/StreamDownloadFile/StreamDownloadFile'
import { UploadFileChunk } from '../../Domain/UseCase/UploadFileChunk/UploadFileChunk'
import { SharedVaultValetTokenResponseLocals } from './Middleware/SharedVaultValetTokenResponseLocals'

@controller('/v1/shared-vault/files', TYPES.Files_SharedVaultValetTokenAuthMiddleware)
export class AnnotatedSharedVaultFilesController extends BaseHttpController {
  constructor(
    @inject(TYPES.Files_UploadFileChunk) private uploadFileChunk: UploadFileChunk,
    @inject(TYPES.Files_CreateUploadSession) private createUploadSession: CreateUploadSession,
    @inject(TYPES.Files_FinishUploadSession) private finishUploadSession: FinishUploadSession,
    @inject(TYPES.Files_StreamDownloadFile) private streamDownloadFile: StreamDownloadFile,
    @inject(TYPES.Files_GetFileMetadata) private getFileMetadata: GetFileMetadata,
    @inject(TYPES.Files_RemoveFile) private removeFile: RemoveFile,
    @inject(TYPES.Files_MoveFile) private moveFile: MoveFile,
    @inject(TYPES.Files_MAX_CHUNK_BYTES) private maxChunkBytes: number,
    @inject(TYPES.Files_Logger) private logger: Logger,
  ) {
    super()
  }

  @httpPost('/move')
  async moveFileRequest(
    _request: Request,
    response: Response,
  ): Promise<results.BadRequestErrorMessageResult | results.JsonResult> {
    const locals = response.locals as SharedVaultValetTokenResponseLocals
    if (locals.valetTokenData.permittedOperation !== ValetTokenOperation.Move) {
      return this.badRequest('Not permitted for this operation')
    }

    const moveOperation = locals.valetTokenData.moveOperation
    if (!moveOperation) {
      return this.badRequest('Missing move operation data')
    }

    const result = await this.moveFile.execute({
      moveType: moveOperation.type,
      from: moveOperation.from,
      to: moveOperation.to,
      resourceRemoteIdentifier: locals.valetTokenData.remoteIdentifier,
    })

    if (result.isFailed()) {
      return this.badRequest(result.getError())
    }

    return this.json({ success: true })
  }

  @httpPost('/upload/create-session')
  async startUpload(
    _request: Request,
    response: Response,
  ): Promise<results.BadRequestErrorMessageResult | results.JsonResult> {
    const locals = response.locals as SharedVaultValetTokenResponseLocals
    if (locals.valetTokenData.permittedOperation !== ValetTokenOperation.Write) {
      return this.badRequest('Not permitted for this operation')
    }

    const result = await this.createUploadSession.execute({
      ownerUuid: locals.valetTokenData.sharedVaultUuid,
      resourceRemoteIdentifier: locals.valetTokenData.remoteIdentifier,
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
    const locals = response.locals as SharedVaultValetTokenResponseLocals
    if (locals.valetTokenData.permittedOperation !== ValetTokenOperation.Write) {
      return this.badRequest('Not permitted for this operation')
    }

    const chunkId = +(request.headers['x-chunk-id'] as string)
    if (!chunkId) {
      return this.badRequest('Missing x-chunk-id header in request.')
    }

    const result = await this.uploadFileChunk.execute({
      ownerUuid: locals.valetTokenData.sharedVaultUuid,
      resourceRemoteIdentifier: locals.valetTokenData.remoteIdentifier,
      resourceUnencryptedFileSize: locals.valetTokenData.unencryptedFileSize as number,
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
    const locals = response.locals as SharedVaultValetTokenResponseLocals
    if (locals.valetTokenData.permittedOperation !== ValetTokenOperation.Write) {
      return this.badRequest('Not permitted for this operation')
    }

    if (locals.valetTokenData.uploadBytesLimit === undefined) {
      return this.badRequest('Missing upload bytes limit')
    }

    const result = await this.finishUploadSession.execute({
      userUuid: locals.valetTokenData.vaultOwnerUuid,
      sharedVaultUuid: locals.valetTokenData.sharedVaultUuid,
      resourceRemoteIdentifier: locals.valetTokenData.remoteIdentifier,
      uploadBytesLimit: locals.valetTokenData.uploadBytesLimit,
      uploadBytesUsed: locals.valetTokenData.uploadBytesUsed,
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
    const locals = response.locals as SharedVaultValetTokenResponseLocals
    if (locals.valetTokenData.permittedOperation !== ValetTokenOperation.Delete) {
      return this.badRequest('Not permitted for this operation')
    }

    const result = await this.removeFile.execute({
      vaultInput: {
        sharedVaultUuid: locals.valetTokenData.sharedVaultUuid,
        vaultOwnerUuid: locals.valetTokenData.vaultOwnerUuid,
        resourceRemoteIdentifier: locals.valetTokenData.remoteIdentifier,
      },
      valetToken: locals.valetToken,
    })

    if (result.isFailed()) {
      return this.badRequest(result.getError())
    }

    return this.json({ success: true, message: 'File removed successfully' })
  }

  @httpGet('/')
  async download(
    request: Request,
    response: Response,
  ): Promise<results.BadRequestErrorMessageResult | (() => Writable)> {
    const locals = response.locals as SharedVaultValetTokenResponseLocals
    if (locals.valetTokenData.permittedOperation !== ValetTokenOperation.Read) {
      return this.badRequest('Not permitted for this operation')
    }

    const range = request.headers['range']
    if (!range) {
      return this.badRequest('File download requires range header to be set.')
    }

    let chunkSize = +(request.headers['x-chunk-size'] as string)
    if (!chunkSize || chunkSize > this.maxChunkBytes) {
      chunkSize = this.maxChunkBytes
    }

    const fileMetadataOrError = await this.getFileMetadata.execute({
      ownerUuid: locals.valetTokenData.sharedVaultUuid,
      resourceRemoteIdentifier: locals.valetTokenData.remoteIdentifier,
    })

    if (fileMetadataOrError.isFailed()) {
      return this.badRequest(fileMetadataOrError.getError())
    }
    const fileSize = fileMetadataOrError.getValue()
    const endRangeOfFile = fileSize - 1

    // Parse "bytes=start-end" properly. The previous Number(range.replace(/\D/g, ''))
    // stripped ALL non-digits, so bytes=100-200 collapsed to 100200 and any bound
    // check was skipped. Validate 0 <= start <= end < fileSize and respond 416 on
    // an unsatisfiable range BEFORE any 206 header is written.
    const parsedRange = parseByteRange(range, fileSize, chunkSize)
    if (parsedRange === null) {
      response.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      })

      return () => response.end() as unknown as Writable
    }
    const { startRange, endRange } = parsedRange

    // Open/validate the storage read stream BEFORE writing the 206 headers.
    // Previously writeHead(206) was sent first, so a subsequent this.badRequest
    // threw ERR_HTTP_HEADERS_SENT (headers already flushed).
    const result = await this.streamDownloadFile.execute({
      ownerUuid: locals.valetTokenData.sharedVaultUuid,
      resourceRemoteIdentifier: locals.valetTokenData.remoteIdentifier,
      startRange,
      endRange,
      valetToken: locals.valetToken,
      endRangeOfFile,
    })

    if (!result.success) {
      return this.badRequest(result.message)
    }

    // Content-Range total is the FULL file size, not the last byte index.
    const headers = {
      'Content-Range': `bytes ${startRange}-${endRange}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': endRange - startRange + 1,
      'Content-Type': 'application/octet-stream',
    }

    response.writeHead(206, headers)

    const readStream = result.readStream

    return () => {
      // A mid-transfer S3/FS read error emits 'error' on the source; without a
      // listener that is an unhandled exception that crashes the process. Log it
      // and tear both streams down. Also destroy the read stream if the client
      // disconnects, so we do not leak storage sockets.
      readStream.on('error', (error: Error) => {
        this.logger.error('Error while streaming file download.', safeErrorLogMetadata(error))
        readStream.destroy()
        response.destroy(error)
      })
      response.on('close', () => {
        readStream.destroy()
      })

      return readStream.pipe(response)
    }
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
