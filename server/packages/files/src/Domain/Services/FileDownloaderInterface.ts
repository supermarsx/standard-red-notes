import { Readable } from 'stream'

export interface FileDownloaderInterface {
  createDownloadStream(
    filePath: string,
    startRange: number,
    endRange: number,
    abortSignal?: AbortSignal,
  ): Promise<Readable>
  getFileSize(filePath: string, abortSignal?: AbortSignal): Promise<number>
  listFiles(userUuid: string): Promise<{ name: string; size: number }[]>
}
