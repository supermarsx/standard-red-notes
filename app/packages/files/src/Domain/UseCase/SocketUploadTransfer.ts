import { HexString } from '@standardnotes/sncrypto-common'

/** Where the server says it actually is, plus the handles needed to get back to it. */
export type SocketUploadPosition = {
  transferId: string
  generation: number
  resumeId: string
  nextIndex: number
  nextOffset: number
}

export type SocketUploadAction =
  /** Open a transfer. `resumeId` present means resume an existing one, never restart it. */
  | { type: 'open'; resumeId?: string }
  | { type: 'send-chunk'; index: number; offset: number; transferId: string; generation: number }
  /**
   * Send `FILES_UPLOAD_FINISH`. Re-issued unchanged after an interrupted attempt:
   * safe only because the server's `finishUpload` is idempotent for a matching
   * digest, so this re-reads a decision rather than retrying an unknown write.
   */
  | { type: 'finish'; transferId: string; generation: number; sha256: HexString }
  | { type: 'done'; sha256: HexString }
  | { type: 'abandon'; code: string; safeToFallback: boolean }

type Phase =
  | { name: 'unopened' }
  | { name: 'sending'; position: SocketUploadPosition }
  | { name: 'finishing'; position: SocketUploadPosition }
  /** Socket lost mid-transfer; the server holds the truth and must be re-asked. */
  | { name: 'resumable'; position: SocketUploadPosition }
  | { name: 'completed'; sha256: HexString }
  | { name: 'abandoned'; code: string; safeToFallback: boolean }

export class SocketUploadTransferError extends Error {}

/**
 * Decides what an in-flight FILES_V1 upload should do next, especially after
 * something goes wrong. Deliberately pure — no socket, no timers, no I/O — because
 * these rules are the part that has to be right, and they should be provable
 * without a transport to stand them up.
 *
 * Two rules drive everything, and both come from the server's actual contract
 * rather than from assumption:
 *
 * 1. **Resume, never re-upload from zero.** `openUpload` with a `resumeId`
 *    re-authorizes, discards whatever the files service had buffered but not
 *    stored, rewinds to the last offset it *actually accepted*, and bumps
 *    `generation`. So after a socket loss the client asks the server where it is
 *    and adopts that answer. It never assumes its own last-sent position was
 *    stored, and the generation bump makes any late frame from the previous
 *    attempt inert.
 *
 * 2. **An interrupted FINISH is resolved, not retried.** `finishUpload` is
 *    idempotent: once `completedSha256` is set it returns the same result for an
 *    identical digest and throws `FILE_INTEGRITY_MISMATCH` for a different one.
 *    So when the socket dies between FINISH and COMPLETE, re-sending the identical
 *    FINISH reads the decision the server already made. Re-uploading instead could
 *    publish the same file twice, which is corruption rather than a failed request.
 *
 * The digest is a property of the FILE, not of a transfer attempt — it covers the
 * same bytes however many resume cycles occur, so it is computed once and passed
 * in here unchanged. Recomputing it per attempt would require bytes the client may
 * no longer hold once the server has rewound it.
 */
export class SocketUploadTransfer {
  private phase: Phase = { name: 'unopened' }
  /**
   * True once FINISH has been written even once. This is the fallback gate:
   * before FINISH nothing is published — the server publishes only at
   * `closeUploadSession` — so restarting over HTTP writes into an unpublished
   * session and is safe. After FINISH the object may already exist, so an HTTP
   * restart risks applying the same upload a second time.
   */
  private finishAttempted = false

  constructor(
    private readonly declaredSize: number,
    private readonly sha256: HexString,
  ) {
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) {
      throw new SocketUploadTransferError('A socket upload needs a positive declared size.')
    }
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new SocketUploadTransferError('A socket upload needs the hex digest of its encrypted stream.')
    }
  }

  /**
   * HTTP is a compatibility path only while this client can prove the upload
   * cannot already have been applied. Ambiguity resolves to unsafe, never the
   * reverse.
   */
  get safeToFallback(): boolean {
    if (this.phase.name === 'abandoned') {
      return this.phase.safeToFallback
    }
    return !this.finishAttempted
  }

  get position(): SocketUploadPosition | undefined {
    return this.phase.name === 'completed' || this.phase.name === 'abandoned' || this.phase.name === 'unopened'
      ? undefined
      : this.phase.position
  }

  nextAction(): SocketUploadAction {
    switch (this.phase.name) {
      case 'unopened':
        return { type: 'open' }
      case 'resumable':
        // The whole point: come back to the same transfer and let the server say
        // where it is, rather than starting a second upload of the same file.
        return { type: 'open', resumeId: this.phase.position.resumeId }
      case 'sending': {
        const position = this.phase.position
        if (position.nextOffset === this.declaredSize) {
          return {
            type: 'finish',
            transferId: position.transferId,
            generation: position.generation,
            sha256: this.sha256,
          }
        }
        return {
          type: 'send-chunk',
          index: position.nextIndex,
          offset: position.nextOffset,
          transferId: position.transferId,
          generation: position.generation,
        }
      }
      case 'finishing':
        return {
          type: 'finish',
          transferId: this.phase.position.transferId,
          generation: this.phase.position.generation,
          sha256: this.sha256,
        }
      case 'completed':
        return { type: 'done', sha256: this.phase.sha256 }
      case 'abandoned':
        return { type: 'abandon', code: this.phase.code, safeToFallback: this.phase.safeToFallback }
    }
  }

  /** The server accepted an open — either the first one or a resume. */
  accepted(result: SocketUploadPosition & { declaredSize: number }): void {
    if (this.phase.name === 'completed' || this.phase.name === 'abandoned') {
      return
    }
    if (
      // The client's own encrypted stream decides how long this file is; a server
      // reporting otherwise is refused rather than followed.
      result.declaredSize !== this.declaredSize ||
      result.generation < 1 ||
      result.nextIndex < 0 ||
      result.nextOffset < 0 ||
      result.nextOffset > this.declaredSize
    ) {
      this.abandon('FILE_INVALID_STATE')
      return
    }
    const position: SocketUploadPosition = {
      transferId: result.transferId,
      generation: result.generation,
      resumeId: result.resumeId,
      nextIndex: result.nextIndex,
      nextOffset: result.nextOffset,
    }
    // A resume that lands on a fully-stored stream goes straight back to
    // finishing: every byte is already accepted, so the only outstanding
    // question is what FINISH decided.
    this.phase =
      this.finishAttempted && position.nextOffset === this.declaredSize
        ? { name: 'finishing', position }
        : { name: 'sending', position }
  }

  /** The server acknowledged a chunk and reported where it now is. */
  chunkAcknowledged(ack: {
    transferId: string
    generation: number
    nextIndex: number
    nextOffset: number
    resumeId: string
  }): void {
    if (this.phase.name !== 'sending') {
      return
    }
    const position = this.phase.position
    if (ack.transferId !== position.transferId || ack.generation !== position.generation) {
      // A late ack from a superseded generation says nothing about where this
      // attempt stands. Ignoring it is what makes the generation bump meaningful.
      return
    }
    if (
      ack.nextOffset < position.nextOffset ||
      ack.nextOffset > this.declaredSize ||
      ack.nextIndex < position.nextIndex
    ) {
      // The server cannot move backwards within one generation; if it appears to,
      // this client has lost track of which transfer it is talking about.
      this.abandon('FILE_INVALID_STATE')
      return
    }
    this.phase = {
      name: 'sending',
      position: { ...position, nextIndex: ack.nextIndex, nextOffset: ack.nextOffset, resumeId: ack.resumeId },
    }
  }

  /** FINISH has been written to the socket; its outcome is unknown until answered. */
  finishSent(): void {
    if (this.phase.name !== 'sending') {
      return
    }
    this.finishAttempted = true
    this.phase = { name: 'finishing', position: this.phase.position }
  }

  completed(sha256: HexString): void {
    if (this.phase.name === 'abandoned' || this.phase.name === 'completed') {
      return
    }
    if (sha256 !== this.sha256) {
      // The server published a different stream than the one this client hashed.
      this.abandon('FILE_INTEGRITY_MISMATCH')
      return
    }
    this.phase = { name: 'completed', sha256 }
  }

  /**
   * The socket went away. This is the case this class exists for: it is not a
   * failure but a loss of knowledge, and the cure is to re-ask the server rather
   * than to re-send the file.
   */
  socketLost(): void {
    switch (this.phase.name) {
      case 'completed':
      case 'abandoned':
      case 'resumable':
        return
      case 'unopened':
        // Nothing was ever sent, so nothing can have been applied.
        this.phase = { name: 'abandoned', code: 'SOCKET_CLOSED', safeToFallback: true }
        return
      case 'sending':
      case 'finishing':
        this.phase = { name: 'resumable', position: this.phase.position }
    }
  }

  serverError(code: string): void {
    if (this.phase.name === 'completed' || this.phase.name === 'abandoned') {
      return
    }
    this.abandon(code)
  }

  private abandon(code: string): void {
    this.phase = { name: 'abandoned', code, safeToFallback: !this.finishAttempted }
  }
}
