import { EncryptAndUploadFileOperation } from '../Operations/EncryptAndUpload'
import { LocalOnlyFileUploadOperation } from '../Operations/EncryptLocalOnly'
import { FileItem, FileMetadata, VaultListingInterface, SharedVaultListingInterface } from '@standardnotes/models'
import { ClientDisplayableError } from '@standardnotes/responses'
import { FileDownloadProgress } from '../Types/FileDownloadProgress'
import { FileSystemApi } from '../Api/FileSystemApi'
import { FileHandleRead } from '../Api/FileHandleRead'
import { FileSystemNoSelection } from '../Api/FileSystemNoSelection'
import { FileBackupMetadataFile } from '../Device/FileBackupMetadataFile'
import { LocalFileBackendInterface } from './LocalFileBackendInterface'

export interface FilesClientInterface {
  minimumChunkSize(): number

  /**
   * Sets the platform-provided backend used to persist "large local-only files" (files kept
   * on this device only and excluded from sync). The web app supplies an IndexedDB-backed
   * implementation. When unset, local-only uploads are not available.
   */
  setLocalFileBackend(backend: LocalFileBackendInterface): void

  /**
   * Begins a "large local-only file" operation. The returned operation encrypts pushed chunks
   * and accumulates the encrypted bytes in memory; nothing is sent to the server. Mirrors the
   * server upload triad (begin / pushBytes / finish) so callers can reuse the same chunked
   * read loop.
   */
  beginNewLocalOnlyFileUpload(sizeInBytes: number): LocalOnlyFileUploadOperation

  pushBytesForLocalOnlyUpload(operation: LocalOnlyFileUploadOperation, bytes: Uint8Array, isFinalChunk: boolean): void

  /**
   * Persists the accumulated encrypted bytes via the local backend WITHOUT uploading to the
   * server, then creates a `localOnly`-flagged file item (excluded from sync). Used for large
   * files the user opted to keep on this device only.
   */
  finishLocalOnlyUpload(
    operation: LocalOnlyFileUploadOperation,
    fileMetadata: FileMetadata,
    uuid: string,
  ): Promise<FileItem | ClientDisplayableError>

  beginNewFileUpload(
    sizeInBytes: number,
    vault?: VaultListingInterface,
  ): Promise<EncryptAndUploadFileOperation | ClientDisplayableError>
  pushBytesForUpload(
    operation: EncryptAndUploadFileOperation,
    bytes: Uint8Array,
    chunkId: number,
    isFinalChunk: boolean,
  ): Promise<ClientDisplayableError | undefined>
  finishUpload(
    operation: EncryptAndUploadFileOperation,
    fileMetadata: FileMetadata,
    uuid: string,
  ): Promise<FileItem | ClientDisplayableError>

  /**
   * Downloads and decrypts a file, invoking `onDecryptedBytes` per chunk.
   *
   * `options.signal` lets a caller cancel an in-flight download: if it is already aborted the
   * call short-circuits before any work, and aborting it mid-flight tears down the underlying
   * download/decrypt operation so no further chunks are pumped. Optional and backward-compatible
   * — existing callers that omit it are unaffected.
   */
  downloadFile(
    file: FileItem,
    onDecryptedBytes: (bytes: Uint8Array, progress: FileDownloadProgress) => Promise<void>,
    options?: { signal?: AbortSignal },
  ): Promise<ClientDisplayableError | undefined>

  deleteFile(file: FileItem): Promise<ClientDisplayableError | undefined>

  moveFileToSharedVault(
    file: FileItem,
    sharedVault: SharedVaultListingInterface,
  ): Promise<void | ClientDisplayableError>
  moveFileOutOfSharedVault(file: FileItem): Promise<void | ClientDisplayableError>

  selectFile(fileSystem: FileSystemApi): Promise<FileHandleRead | FileSystemNoSelection>

  isFileNameFileBackupRelated(name: string): 'metadata' | 'binary' | false
  decryptBackupMetadataFile(metdataFile: FileBackupMetadataFile): Promise<FileItem | undefined>
  readBackupFileAndSaveDecrypted(
    fileHandle: FileHandleRead,
    file: FileItem,
    fileSystem: FileSystemApi,
  ): Promise<'success' | 'aborted' | 'failed'>
  readBackupFileBytesDecrypted(
    fileHandle: FileHandleRead,
    file: FileItem,
    fileSystem: FileSystemApi,
  ): Promise<Uint8Array>
}
