import { Readable } from 'stream'
import { createReadStream, promises } from 'fs'
import { inject, injectable } from 'inversify'

import { FileDownloaderInterface } from '../../Domain/Services/FileDownloaderInterface'
import TYPES from '../../Bootstrap/Types'

@injectable()
export class FSFileDownloader implements FileDownloaderInterface {
  constructor(@inject(TYPES.Files_FILE_UPLOAD_PATH) private fileUploadPath: string) {}

  async listFiles(userUuid: string): Promise<{ name: string; size: number }[]> {
    const filesList = []

    const files = await promises.readdir(`${this.fileUploadPath}/${userUuid}`)
    for (const file of files) {
      const fileStat = await promises.stat(`${this.fileUploadPath}/${userUuid}/${file}`)
      filesList.push({
        name: file,
        size: fileStat.size,
      })
    }

    return filesList
  }

  async getFileSize(filePath: string, _abortSignal?: AbortSignal): Promise<number> {
    // fs.stat has no AbortSignal overload. The use-case race still bounds the
    // request; unlike S3, the in-flight filesystem stat itself cannot be canceled.
    return (await promises.stat(`${this.fileUploadPath}/${filePath}`)).size
  }

  async createDownloadStream(
    filePath: string,
    startRange: number,
    endRange: number,
    abortSignal?: AbortSignal,
  ): Promise<Readable> {
    return Promise.resolve(
      createReadStream(`${this.fileUploadPath}/${filePath}`, { start: startRange, end: endRange, signal: abortSignal }),
    )
  }
}
