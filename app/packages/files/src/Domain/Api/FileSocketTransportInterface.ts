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

  /**
   * Opens one upload on the already-negotiated socket, or reports that HTTP must
   * carry it.
   *
   * Opens nothing on its own and never bootstraps a connection: with no live
   * socket advertising the lane this answers `unavailable` without a ticket
   * request, so the caller proceeds over HTTP with nothing attempted. The open is
   * a real round trip answered by the server, which is why the caller should
   * prefer it to `isFileLaneAvailable()` as the decision point — a liveness check
   * is a prediction, an accepted open is proof.
   */
  uploadFileOverSocket(request: SocketFileUploadRequest): Promise<SocketFileUploadOpenOutcome>
}

/** The handle to a shared vault, carried only when the vault listing genuinely records both halves. */
export type SocketFileSharedVaultReference = { sharedVaultUuid: string; sharedVaultOwnerUuid: string }

export type SocketFileUploadRequest = {
  /** Forwarded byte-identical, and the same string the file's encryptor uses as xchacha20 AAD. */
  remoteIdentifier: string
  fileUuid: string
  sharedVault?: SocketFileSharedVaultReference
  /**
   * Plaintext length of the file. Must be >= 1: both the gateway and the worker
   * validate it with `isFileTransferSize`, which refuses zero, so an empty file
   * has no socket lane and belongs on HTTP.
   */
  decryptedSize: number
  /**
   * The ENCRYPTED total — `plannedEncryptedSize`, never the decrypted size. The
   * gateway checks it at open, re-asserts it in every binary frame header, and
   * checks it again at FINISH, so a wrong value surfaces only after the whole
   * file has crossed the wire.
   */
  declaredSize: number
  mimeType: string
  signal?: AbortSignal
}

/** Where the server says the transfer is, in bytes of the ENCRYPTED stream. */
export type SocketFileUploadPosition = {
  transferId: string
  generation: number
  resumeId: string
  nextIndex: number
  nextOffset: number
  declaredSize: number
  /**
   * Largest payload one binary frame may carry. Reported by the transport rather
   * than redeclared here so the files layer cannot drift from the gateway's own
   * `MAX_FILE_CHUNK_BYTES`.
   */
  maxFrameBytes: number
}

export type SocketFileUploadFailure = {
  outcome: 'failed'
  code: string
  /** The socket may recover; it says nothing about whether a retry is SAFE. */
  retryable: boolean
  /**
   * True only while this client can prove the upload cannot already have been
   * applied server-side. Ambiguity resolves to false.
   */
  safeToFallback: boolean
}

export type SocketFileUploadOpenOutcome =
  | { outcome: 'opened'; position: SocketFileUploadPosition; session: SocketFileUploadSession }
  /** Nothing was attempted: no socket, or this deployment does not serve the lane. */
  | { outcome: 'unavailable' }
  | { outcome: 'aborted' }
  | SocketFileUploadFailure

export type SocketFileUploadAcknowledgement = {
  outcome: 'acknowledged'
  transferId: string
  generation: number
  index: number
  duplicate: boolean
  nextIndex: number
  nextOffset: number
  resumeId: string
}

export type SocketFileUploadChunkOutcome =
  SocketFileUploadAcknowledgement | { outcome: 'aborted' } | SocketFileUploadFailure

export type SocketFileUploadFinishOutcome =
  { outcome: 'completed'; sha256: string } | { outcome: 'aborted' } | SocketFileUploadFailure

/**
 * One opened FILES_V1 upload.
 *
 * Strictly sequential: exactly one {@link sendChunk} may be outstanding, because
 * the server answers chunks with acks that carry no client correlation id of
 * their own, and because the whole point of the ack is to learn where the server
 * actually is before deciding what to send next.
 */
export interface SocketFileUploadSession {
  sendChunk(chunk: { index: number; offset: number; bytes: Uint8Array }): Promise<SocketFileUploadChunkOutcome>
  finish(input: {
    transferId: string
    generation: number
    declaredSize: number
    sha256: string
  }): Promise<SocketFileUploadFinishOutcome>
  /** Best effort; the caller's own verdict is authoritative regardless. */
  cancel(): void
}
