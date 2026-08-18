import { inject, injectable } from 'inversify'
import { Logger } from 'winston'
import TYPES from '../../../Bootstrap/Types'
import { FileDownloaderInterface } from '../../Services/FileDownloaderInterface'
import { UseCaseInterface } from '../UseCaseInterface'
import { StreamDownloadFileDTO } from './StreamDownloadFileDTO'
import { StreamDownloadFileResponse } from './StreamDownloadFileResponse'
import { ValetTokenRepositoryInterface } from '../../ValetToken/ValetTokenRepositoryInterface'
import { executeAbortable } from '../AbortableOperation'
import { Readable } from 'stream'

@injectable()
export class StreamDownloadFile implements UseCaseInterface {
  constructor(
    @inject(TYPES.Files_FileDownloader) private fileDownloader: FileDownloaderInterface,
    @inject(TYPES.Files_ValetTokenRepository) private valetTokenRepository: ValetTokenRepositoryInterface,
    @inject(TYPES.Files_Logger) private logger: Logger,
  ) {}

  async execute(dto: StreamDownloadFileDTO): Promise<StreamDownloadFileResponse> {
    let readStream: Readable | undefined
    try {
      readStream = await executeAbortable(
        () =>
          this.fileDownloader.createDownloadStream(
            `${dto.ownerUuid}/${dto.resourceRemoteIdentifier}`,
            dto.startRange,
            dto.endRange,
            dto.abortSignal,
          ),
        dto.abortSignal,
      )

      if (dto.endRange === dto.endRangeOfFile) {
        await executeAbortable(() => this.valetTokenRepository.markAsUsed(dto.valetToken), dto.abortSignal)
      }
      if (dto.abortSignal?.aborted) {
        throw new Error('File download aborted after stream acquisition')
      }

      return {
        success: true,
        readStream,
      }
    } catch (_error) {
      readStream?.destroy()
      if (!dto.abortSignal?.aborted) {
        this.logger.error(
          `Could not create a download stream for resource: ${dto.ownerUuid}/${dto.resourceRemoteIdentifier}`,
        )
      }

      return {
        success: false,
        message: 'Could not create download stream',
      }
    }
  }
}
