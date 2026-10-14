import { StorageComponent, StorageScope } from '@standardnotes/domain-core'
import { FileDownloaderInterface } from './FileDownloaderInterface'

export class FileStorageUsage {
  constructor(
    private downloader: FileDownloaderInterface,
    readonly secret: string,
  ) {}
  async measure(scope: StorageScope): Promise<StorageComponent> {
    let bytes = 0,
      count = 0
    for (const owner of new Set([scope.userUuid, ...scope.vaultUuids])) {
      const files = await this.downloader.listFiles(owner)
      for (const file of files) {
        if (!Number.isSafeInteger(file.size) || file.size < 0) {
          throw new Error('File size unavailable')
        }
        bytes += file.size
        count++
        if (!Number.isSafeInteger(bytes)) {
          throw new Error('Storage total exceeds exact numeric range')
        }
      }
    }
    return { bytes, count, complete: true }
  }
}
