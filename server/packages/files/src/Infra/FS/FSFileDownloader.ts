import { Readable } from 'stream'
import { createReadStream, promises } from 'fs'
import { inject, injectable } from 'inversify'

import { FileDownloaderInterface } from '../../Domain/Services/FileDownloaderInterface'
import TYPES from '../../Bootstrap/Types'

@injectable()
export class FSFileDownloader implements FileDownloaderInterface {
  constructor(@inject(TYPES.Files_FILE_UPLOAD_PATH) private fileUploadPath: string) {}

  /**
   * Standard Red Notes: every file stored for one account, for the quota recount.
   *
   * *** AN ACCOUNT WITH NO DIRECTORY HAS NO FILES. *** The directory is created
   * by the first upload, so an account that has never uploaded has none -- and
   * this used to let `readdir`'s ENOENT escape. The recount then failed instead
   * of answering zero. Measured on a running all-in-one container, where the
   * event bus is in-process and the throw travels all the way back to the
   * request: `POST /v1/admin/users/:uuid/fix-quota` answered a bare 500 for every
   * account that had never uploaded, and the admin pane said "Failed to fix
   * storage quota". On the multi-container build the same throw died in the
   * files worker's log while the request answered `success: true` and no figure
   * was ever written. The S3 implementation never had the problem: listing an
   * empty prefix is simply an empty list.
   *
   * *** BUT A MISSING STORAGE ROOT IS NOT "NO FILES". *** Zero is a measurement,
   * and it is only true if the place the files would be is there to look in. If
   * the upload root itself is gone (an unmounted volume, a wrong path) this still
   * rejects, because answering `[]` would have every account recounted to a
   * confident zero on a deployment that has lost its storage.
   */
  async listFiles(userUuid: string): Promise<{ name: string; size: number }[]> {
    const filesList = []

    let files: string[]
    try {
      files = await promises.readdir(`${this.fileUploadPath}/${userUuid}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      await promises.access(this.fileUploadPath)

      return []
    }
    for (const file of files) {
      // Attempt-owned files are not published uploads and can temporarily share
      // an inode with their final destination during atomic publication.
      if (/^\..+\.[0-9a-f-]{36}\.partial$/i.test(file)) {
        continue
      }
      const fileStat = await promises.stat(`${this.fileUploadPath}/${userUuid}/${file}`)
      if (!fileStat.isFile()) {
        continue
      }
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
