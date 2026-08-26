import { FileContent } from '@standardnotes/models'
import { FileOwnershipType } from './FileOwnershipType'

export type DownloadFileParams = {
  /**
   * The HTTP path needs only `encryptedChunkSizes`, because the valet token
   * already names the object. A socket transport has no valet token to carry that
   * naming, so it must send the resource reference itself — hence `uuid` and
   * `remoteIdentifier` are part of the contract rather than incidental extras.
   *
   * `remoteIdentifier` must be forwarded byte-identical wherever it goes: it is
   * the xchacha20 AAD for this file in both the encryptor and the decryptor, so a
   * rewritten value fails authentication rather than merely missing the object.
   */
  file: {
    uuid: string
    remoteIdentifier: FileContent['remoteIdentifier']
    encryptedChunkSizes: FileContent['encryptedChunkSizes']
  }
  chunkIndex: number
  valetToken: string
  ownershipType: FileOwnershipType
  contentRangeStart: number
  onBytesReceived: (bytes: Uint8Array) => Promise<void>
  /** Stops bounded follow-up range requests after the active request settles. */
  shouldAbort?: () => boolean
  /** Cancels the active range request as soon as the caller aborts. */
  abortSignal?: AbortSignal
}
