import { Logger } from 'winston'
import { FileDownloaderInterface } from '../../Services/FileDownloaderInterface'
import { GetFileMetadataDTO } from './GetFileMetadataDTO'
import { Result, safeErrorLogMetadata, UseCaseInterface } from '@standardnotes/domain-core'
import { executeAbortable } from '../AbortableOperation'

export const FILE_DATA_NOT_FOUND_MESSAGE = 'Encrypted file data was not found on this server.'
export const FILE_STORAGE_UNAVAILABLE_MESSAGE = 'Encrypted file storage is temporarily unavailable.'

function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const candidate = error as {
    code?: unknown
    name?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  const code = typeof candidate.code === 'string' ? candidate.code : undefined
  const name = typeof candidate.name === 'string' ? candidate.name : undefined

  return (
    code === 'ENOENT' ||
    code === 'NoSuchKey' ||
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  )
}

export class GetFileMetadata implements UseCaseInterface<number> {
  constructor(
    private fileDownloader: FileDownloaderInterface,
    private logger: Logger,
  ) {}

  async execute(dto: GetFileMetadataDTO): Promise<Result<number>> {
    try {
      const size = await executeAbortable(
        () => this.fileDownloader.getFileSize(`${dto.ownerUuid}/${dto.resourceRemoteIdentifier}`, dto.abortSignal),
        dto.abortSignal,
      )

      return Result.ok(size)
    } catch (error) {
      if (!dto.abortSignal?.aborted) {
        this.logger.error(
          `Could not get file metadata for resource: ${dto.ownerUuid}/${dto.resourceRemoteIdentifier}`,
          safeErrorLogMetadata(error),
        )
      }

      return Result.fail(isFileNotFoundError(error) ? FILE_DATA_NOT_FOUND_MESSAGE : FILE_STORAGE_UNAVAILABLE_MESSAGE)
    }
  }
}
