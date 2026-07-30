import { ClientDisplayableError } from '@standardnotes/responses'
import { FileDownloadProgress } from '../Types/FileDownloadProgress'
import { Deferred } from '@standardnotes/utils'
import { FileContent } from '@standardnotes/models'
import { FilesApiInterface } from '../Api/FilesApiInterface'

export type AbortSignal = 'aborted'
export type AbortFunction = (error?: ClientDisplayableError) => void
type OnEncryptedBytes = (
  encryptedBytes: Uint8Array,
  progress: FileDownloadProgress,
  abort: AbortFunction,
) => Promise<void>

export type FileDownloaderResult = ClientDisplayableError | AbortSignal | undefined

type DownloadRunState = {
  aborted: boolean
  abortDeferred: ReturnType<typeof Deferred<AbortSignal | ClientDisplayableError>>
  terminalResult?: AbortSignal | ClientDisplayableError
  chunksDownloaded: number
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
    const encryptedBytesRemaining = encryptedSize - totalBytesDownloaded
    const percentComplete = (totalBytesDownloaded / encryptedSize) * 100.0

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

    const metadataError = this.validateEncryptedChunkSizes()
    if (metadataError) {
      return metadataError
    }

    const state: DownloadRunState = {
      aborted: false,
      abortDeferred: Deferred<AbortSignal | ClientDisplayableError>(),
      chunksDownloaded: 0,
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

      const expectedChunkSize = this.file.encryptedChunkSizes[state.chunksDownloaded]
      if (expectedChunkSize === undefined) {
        this.abortRun(state, new ClientDisplayableError('File download returned data beyond its encrypted metadata.'))
        return
      }
      if (bytes.byteLength !== expectedChunkSize) {
        this.abortRun(
          state,
          new ClientDisplayableError(
            `File download chunk ${state.chunksDownloaded} had ${bytes.byteLength} bytes; expected ${expectedChunkSize}.`,
          ),
        )
        return
      }

      state.chunksDownloaded += 1
      state.totalBytesDownloaded += bytes.byteLength

      await onEncryptedBytes(bytes, this.getProgress(state.totalBytesDownloaded), (error) =>
        this.abortRun(state, error),
      )
    }

    const downloadPromise = this.api.downloadFile({
      file: this.file,
      chunkIndex,
      valetToken: this.valetToken,
      contentRangeStart: startRange,
      onBytesReceived: onRemoteBytesReceived,
      ownershipType: this.file.shared_vault_uuid ? 'shared-vault' : 'user',
      shouldAbort: () => state.aborted,
    })

    const result = await Promise.race([state.abortDeferred.promise, downloadPromise])

    if (state.terminalResult) {
      return state.terminalResult
    }
    if (result !== undefined) {
      return result
    }

    const expectedTotal = this.file.encryptedChunkSizes.reduce((total, size) => total + size, 0)
    if (
      state.chunksDownloaded !== this.file.encryptedChunkSizes.length ||
      state.totalBytesDownloaded !== expectedTotal
    ) {
      return new ClientDisplayableError(
        `File download ended after ${state.chunksDownloaded} of ${this.file.encryptedChunkSizes.length} encrypted chunks.`,
      )
    }

    return undefined
  }

  public abort(): void {
    if (this.activeRun !== undefined) {
      this.abortRun(this.activeRun)
    }
  }

  private abortRun(state: DownloadRunState, error?: ClientDisplayableError): void {
    if (state.aborted) {
      return
    }
    state.aborted = true
    state.terminalResult = error ?? 'aborted'
    state.abortDeferred.resolve(state.terminalResult)
  }

  private validateEncryptedChunkSizes(): ClientDisplayableError | undefined {
    if (this.file.encryptedChunkSizes.length === 0) {
      return new ClientDisplayableError('File download metadata does not contain an authenticated encrypted chunk.')
    }

    let total = 0
    for (const size of this.file.encryptedChunkSizes) {
      if (!Number.isSafeInteger(size) || size <= 0) {
        return new ClientDisplayableError('File download metadata contains an invalid encrypted chunk size.')
      }
      total += size
      if (!Number.isSafeInteger(total)) {
        return new ClientDisplayableError('File download metadata exceeds the supported encrypted size.')
      }
    }

    return undefined
  }
}
