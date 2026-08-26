export type SocketFileDownloadOutcome =
  | { outcome: 'completed'; sha256: string }
  /** Nothing was attempted: no socket, or this deployment does not serve the lane. */
  | { outcome: 'unavailable' }
  | { outcome: 'aborted' }
  | {
      outcome: 'failed'
      code: string
      retryable: boolean
      /**
       * True only when no byte reached `onBytes`. The file decryptor is stateful
       * and chunk-ordered, so once it has been fed anything, restarting the same
       * file over HTTP from byte zero would feed it a second time.
       */
      safeToFallback: boolean
    }

export type SocketFileDownloadRequest = {
  /**
   * Forwarded to the server byte-identical. Also the xchacha20 AAD used by this
   * file's encryptor and decryptor, so it is never derived or regenerated here.
   */
  remoteIdentifier: string
  fileUuid: string
  /**
   * Present only for a file in a shared vault, and only when both values come
   * from the vault listing that genuinely records them — never inferred or
   * defaulted. Omitted, the transfer is opened as a personal resource.
   */
  sharedVault?: { sharedVaultUuid: string; sharedVaultOwnerUuid: string }
  /** The client's own authenticated total: the sum of `encryptedChunkSizes`. */
  declaredSize: number
  /** Receives the encrypted stream in order; credit is returned only once it resolves. */
  onBytes: (bytes: Uint8Array) => Promise<void>
  signal?: AbortSignal
}

/**
 * The seam through which the files layer may borrow an already-negotiated
 * realtime socket for a transfer.
 *
 * Deliberately tiny and pull-based. The files layer asks whether the lane is
 * live and, if so, streams over it; it never asks for a socket to be opened, so
 * a deployment that does not advertise the lane performs no extra work and takes
 * no new failure mode from this interface existing.
 */
export interface FileSocketTransportInterface {
  /**
   * True only when a live authenticated socket has actually negotiated the file
   * lane. Synchronous and never optimistic — a `false` here means the caller
   * proceeds over HTTP with no attempt made.
   */
  isFileLaneAvailable(): boolean

  downloadFileOverSocket(request: SocketFileDownloadRequest): Promise<SocketFileDownloadOutcome>
}
