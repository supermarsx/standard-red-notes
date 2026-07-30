import { ClientDisplayableError } from '@standardnotes/responses'
import { FileDownloadProgress } from '../Types/FileDownloadProgress'
import { Deferred } from '@standardnotes/utils'
import { FileContent } from '@standardnotes/models'
import { FilesApiInterface } from '../Api/FilesApiInterface'

export type AbortSignal = 'aborted'
export type AbortFunction = () => void
type OnEncryptedBytes = (
  encryptedBytes: Uint8Array,
  progress: FileDownloadProgress,
  abort: AbortFunction,
) => Promise<void>

export type FileDownloaderResult = ClientDisplayableError | AbortSignal | undefined

type DownloadRunState = {
  aborted: boolean
  abortDeferred: ReturnType<typeof Deferred<AbortSignal>>
  totalBytesDownloaded: number
}

export class FileDownloader {
  private activeRun: DownloadRunState | undefined

  constructor(
    private file: {
      uuid: string
      shared_vault_uuid: string | undefined
      encryptedChunkSizes: FileContent['encryptedChunkSizes']
      remoteIdentifier: FileContent['remoteIdentifier']
    },
    private readonly api: FilesApiInterface,
    private readonly valetToken: string,
  ) {}

  private getProgress(totalBytesDownloaded: number): FileDownloadProgress {
    const encryptedSize = this.file.encryptedChunkSizes.reduce((total, chunk) => total + chunk, 0)
    const encryptedBytesRemaining = Math.max(0, encryptedSize - totalBytesDownloaded)
    const percentComplete = encryptedSize === 0 ? 100 : Math.min(100, (totalBytesDownloaded / encryptedSize) * 100.0)

    return {
      encryptedFileSize: encryptedSize,
      encryptedBytesDownloaded: totalBytesDownloaded,
      encryptedBytesRemaining,
      percentComplete,
      source: 'network',
    }
  }

  public async run(onEncryptedBytes: OnEncryptedBytes): Promise<FileDownloaderResult> {
    if (this.activeRun !== undefined) {
      throw new Error('FileDownloader cannot run more than one download at a time')
    }

    const state: DownloadRunState = {
      aborted: false,
      abortDeferred: Deferred<AbortSignal>(),
      totalBytesDownloaded: 0,
    }
    this.activeRun = state

    try {
      return await this.performDownload(onEncryptedBytes, state)
    } finally {
      if (this.activeRun === state) {
        this.activeRun = undefined
      }
    }
  }

  private async performDownload(
    onEncryptedBytes: OnEncryptedBytes,
    state: DownloadRunState,
  ): Promise<FileDownloaderResult> {
    const chunkIndex = 0
    const startRange = 0

    const onRemoteBytesReceived = async (bytes: Uint8Array) => {
      if (state.aborted) {
        return
      }

      state.totalBytesDownloaded += bytes.byteLength

      await onEncryptedBytes(bytes, this.getProgress(state.totalBytesDownloaded), () => this.abortRun(state))
    }

    const downloadPromise = this.api.downloadFile({
      file: this.file,
      chunkIndex,
      valetToken: this.valetToken,
      contentRangeStart: startRange,
      onBytesReceived: onRemoteBytesReceived,
      ownershipType: this.file.shared_vault_uuid ? 'shared-vault' : 'user',
    })

    const result = await Promise.race([state.abortDeferred.promise, downloadPromise])

    return result
  }

  public abort(): void {
    if (this.activeRun !== undefined) {
      this.abortRun(this.activeRun)
    }
  }

  private abortRun(state: DownloadRunState): void {
    state.aborted = true
    state.abortDeferred.resolve('aborted')
  }
}
