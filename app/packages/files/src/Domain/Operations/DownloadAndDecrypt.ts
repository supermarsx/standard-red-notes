import { ClientDisplayableError } from '@standardnotes/responses'
import { AbortFunction, FileDownloader, FileDownloaderResult } from '../UseCase/FileDownloader'
import { FileDecryptor } from '../UseCase/FileDecryptor'
import { FileDownloadProgress } from '../Types/FileDownloadProgress'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { FileContent } from '@standardnotes/models'
import { FilesApiInterface } from '../Api/FilesApiInterface'
import { DecryptedBytes } from '../Types/DecryptedBytes'
import { EncryptedBytes } from '../Types/EncryptedBytes'

export type DownloadAndDecryptResult = { success: boolean; error?: ClientDisplayableError; aborted?: boolean }

type OnBytesCallback = (results: {
  decrypted: DecryptedBytes
  encrypted: EncryptedBytes
  progress: FileDownloadProgress
}) => Promise<void>

export class DownloadAndDecryptFileOperation {
  private downloader: FileDownloader

  constructor(
    private readonly file: {
      uuid: string
      shared_vault_uuid: string | undefined
      encryptedChunkSizes: FileContent['encryptedChunkSizes']
      encryptionHeader: FileContent['encryptionHeader']
      remoteIdentifier: FileContent['remoteIdentifier']
      key: FileContent['key']
    },
    private readonly crypto: PureCryptoInterface,
    private readonly api: FilesApiInterface,
    valetToken: string,
  ) {
    this.downloader = new FileDownloader(this.file, this.api, valetToken)
  }

  private createDecryptor(): FileDecryptor {
    return new FileDecryptor(this.file, this.crypto)
  }

  public async run(onBytes: OnBytesCallback): Promise<DownloadAndDecryptResult> {
    let decryptor: FileDecryptor
    try {
      decryptor = this.createDecryptor()
    } catch {
      return {
        success: false,
        error: new ClientDisplayableError('File download could not initialize its authenticated decryptor.'),
        aborted: false,
      }
    }

    let authenticatedChunks = 0
    let finalSeen = false

    const onDownloadBytes = async (
      encryptedBytes: Uint8Array,
      progress: FileDownloadProgress,
      abortDownload: AbortFunction,
    ) => {
      const result = decryptor.decryptBytes(encryptedBytes)
      if (!result) {
        abortDownload(new ClientDisplayableError('Failed to authenticate and decrypt file chunk.'))
        return
      }

      const isLastDeclaredChunk = authenticatedChunks === this.file.encryptedChunkSizes.length - 1
      if (result.isFinalChunk && !isLastDeclaredChunk) {
        abortDownload(
          new ClientDisplayableError('File download authenticated its final chunk before the declared end.'),
        )
        return
      }
      if (!result.isFinalChunk && isLastDeclaredChunk) {
        abortDownload(new ClientDisplayableError('File download ended without an authenticated final chunk.'))
        return
      }

      authenticatedChunks += 1
      finalSeen = result.isFinalChunk

      await onBytes({ decrypted: { decryptedBytes: result.decryptedBytes }, encrypted: { encryptedBytes }, progress })
    }

    let downloadResult: FileDownloaderResult
    try {
      downloadResult = await this.downloader.run(onDownloadBytes)
    } catch {
      return {
        success: false,
        error: new ClientDisplayableError('File download failed before its encrypted stream could be authenticated.'),
        aborted: false,
      }
    }

    if (downloadResult === 'aborted') {
      return {
        success: false,
        error: undefined,
        aborted: true,
      }
    }

    if (downloadResult instanceof ClientDisplayableError) {
      return {
        success: false,
        error: downloadResult,
        aborted: false,
      }
    }

    if (!finalSeen || authenticatedChunks !== this.file.encryptedChunkSizes.length) {
      return {
        success: false,
        error: new ClientDisplayableError('File download did not contain exactly one authenticated final chunk.'),
        aborted: false,
      }
    }

    return {
      success: true,
      error: undefined,
      aborted: false,
    }
  }

  abort(): void {
    this.downloader.abort()
  }
}
