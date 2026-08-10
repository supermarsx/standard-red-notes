import { constants } from 'fs'
import { access, statfs } from 'fs/promises'

import { StorageReadinessInterface } from '../../Domain/Services/StorageReadinessInterface'

export type FileAccess = (path: string, mode: number) => Promise<void>
export type FileSystemStats = { bavail: number | bigint }
export type FileSystemStat = (path: string) => Promise<FileSystemStats>

export class FSStorageReadiness implements StorageReadinessInterface {
  constructor(
    private readonly uploadPath: string,
    private readonly accessFn: FileAccess = access,
    private readonly statfsFn: FileSystemStat = statfs,
  ) {}

  async check(): Promise<void> {
    await this.accessFn(this.uploadPath, constants.R_OK | constants.W_OK)
    const stats = await this.statfsFn(this.uploadPath)
    const hasAvailableBlocks = typeof stats.bavail === 'bigint' ? stats.bavail > 0n : stats.bavail > 0
    if (!hasAvailableBlocks) {
      throw new Error('File upload filesystem has no available blocks')
    }
  }
}
