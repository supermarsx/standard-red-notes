import { FileContent } from '@standardnotes/models'
import { FileOwnershipType } from './FileOwnershipType'

export type DownloadFileParams = {
  file: { encryptedChunkSizes: FileContent['encryptedChunkSizes'] }
  chunkIndex: number
  valetToken: string
  ownershipType: FileOwnershipType
  contentRangeStart: number
  onBytesReceived: (bytes: Uint8Array) => Promise<void>
  /** Stops bounded follow-up range requests after the active request settles. */
  shouldAbort?: () => boolean
}
