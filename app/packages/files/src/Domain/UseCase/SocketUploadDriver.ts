import { ClientDisplayableError, isClientDisplayableError } from '@standardnotes/responses'
import { FileContent, VaultListingInterface } from '@standardnotes/models'
import { HexString } from '@standardnotes/sncrypto-common'

import {
  SocketFileUploadFailure,
  SocketFileUploadPosition,
  SocketFileUploadSession,
} from '../Api/FileSocketTransportInterface'
import { decryptedChunkLengthAt, UploadSizePlan } from '../Chunker/UploadSizePlan'
import { EncryptAndUploadFileOperation } from '../Operations/EncryptAndUpload'
import { FileUploadProgress } from '../Types/FileUploadProgress'
import { FileUploadResult } from '../Types/FileUploadResult'
import { SocketUploadDigestHandle, SocketUploadTransfer } from './SocketUploadTransfer'

/** The one thing this driver needs from a `FileEncryptor`, so a spec can stand one in. */
export type SocketUploadEncryptor = {
  pushBytes(decryptedBytes: Uint8Array, isFinalChunk: boolean): Uint8Array
}

/** The running SHA-256 of the encrypted stream, plus the ability to add to it. */
export type SocketUploadStreamDigest = SocketUploadDigestHandle & {
  update(bytes: Uint8Array): void
}

export type SocketUploadPushOutcome =
  /** The bytes were taken; more are expected. */
  | { outcome: 'accepted' }
  /** The server published the file and agreed on its digest. */
  | { outcome: 'completed'; sha256: HexString }
  /** The upload is over and could not be rescued on either transport. */
  | { outcome: 'failed'; code: string; safeToFallback: boolean }

export type SocketUploadDriverOptions = {
  plan: UploadSizePlan
  file: {
    key: FileContent['key']
    remoteIdentifier: FileContent['remoteIdentifier']
  }
  /** Already minted by the caller's encryptor; it travels in file metadata, not in the stream. */
  encryptionHeader: string
  encryptor: SocketUploadEncryptor
  digest: SocketUploadStreamDigest
  session: SocketFileUploadSession
  position: SocketFileUploadPosition
  vault?: VaultListingInterface
  /**
   * Mints the WRITE valet token and opens the HTTP upload session — all the work
   * the socket path exists to avoid. Called at most once, and only while
   * restarting over HTTP is still provably safe.
   */
  beginHttpFallback: () => Promise<EncryptAndUploadFileOperation | ClientDisplayableError>
}

/**
 * Streams one file's encrypted bytes up the negotiated FILES_V1 lane, and falls
 * back to HTTP for as long as falling back is still honest.
 *
 * This is the object `beginNewFileUpload` hands back when the socket accepted an
 * open, so it stands in for {@link EncryptAndUploadFileOperation} and exposes the
 * same `getProgress` / `getResult` / `encryptedChunkSizes` surface. Once it has
 * fallen back, every one of those reads straight through to the HTTP operation,
 * so nothing downstream can tell which transport carried the bytes.
 *
 * ## The chunk schedule is the plan's, never the caller's
 *
 * `FILES_UPLOAD_OPEN` fixes `declaredSize` — the ENCRYPTED total — before a byte
 * moves, and the gateway re-asserts it in every binary frame header and again at
 * FINISH. That total is knowable in advance only if the encryptor is pushed
 * exactly `plan.chunkCount` times with exactly `plan.decryptedChunkSize` plaintext
 * bytes each (a possibly shorter last one), because each push adds exactly
 * `EncryptedChunkOverheadBytes` and nothing else.
 *
 * So the caller's chunking is deliberately ignored. Readers do not produce the
 * plan's sizes: `ByteChunker` pops `Math.max(minimumChunkSize, bytes.length)` —
 * everything buffered — so with 2 MB reads against a 5 MB floor the real chunks
 * are 6 MB and a `chunkSize + 1` file becomes ONE chunk where the plan says two;
 * `StreamingReader` is worse still, since its read sizes come from the browser
 * and its chunk count is therefore not a function of the file at all. Either
 * mismatch is 17 bytes of drift per chunk, invisible until FINISH answers
 * `FILE_INCOMPLETE` after the whole file has crossed the wire. This class
 * therefore buffers whatever it is handed and cuts it back to the plan.
 *
 * Separately, the 256 KiB frame limit is NOT the chunk size. One 5 MB encryption
 * chunk spans twenty binary frames; `position.maxFrameBytes` is the transport's
 * own figure, so this layer cannot drift from the gateway's.
 *
 * ## Resume is deliberately not implemented
 *
 * The server's upload state is in memory only, so a restart or a different
 * replica answers `FILE_RESUME_INVALID`; and this client could not honour a
 * rewind anyway, because `xchacha20StreamInitEncryptor` mints its own random
 * header and the plaintext is streamed rather than retained. A transfer that
 * asks to be re-opened is therefore refused (`FILE_RESUME_UNSUPPORTED`) rather
 * than re-sent: a resume that silently corrupts is far worse than no resume.
 *
 * ## What "safe to fall back" means here
 *
 * Two conditions, and both must hold. {@link SocketUploadTransfer} owns the
 * server-side half: nothing is published before FINISH, so a restart is safe
 * until FINISH has been attempted even once. This class owns the client-side
 * half: a restart needs a FRESH encryptor — a new stream header — fed the whole
 * file from byte zero, so it is possible only while every plaintext byte handed
 * over so far is still retained. That retention ends at the first acknowledged
 * chunk, which bounds it at roughly one planned chunk plus one caller chunk.
 */
export class SocketUploadDriver {
  private readonly transfer: SocketUploadTransfer
  private readonly socketEncryptedChunkSizes: number[] = []
  /** Encrypted stream offset one past each planned chunk, and that chunk's plaintext length. */
  private readonly chunkBoundaries: Array<{ encryptedEnd: number; decryptedLength: number }> = []
  /** Plaintext kept verbatim, in the caller's own chunking, for an HTTP restart. */
  private retained: Array<{ bytes: Uint8Array; chunkId: number; isFinalChunk: boolean }> = []
  private retains = true
  /** Encrypted bytes produced but not yet acknowledged, plus the stream offset of their first byte. */
  private pendingEncrypted: Uint8Array = new Uint8Array(0)
  private pendingEncryptedBase: number
  private pendingDecrypted: Uint8Array[] = []
  private pendingDecryptedLength = 0
  private encryptedProduced: number
  private decryptedAccepted = 0
  private decryptedAcknowledged = 0
  private nextPlanChunk = 0
  /** Set by an explicit cancellation, which must never be rescued onto HTTP. */
  private cancelled = false
  private terminal?: SocketUploadPushOutcome
  private failureCode?: string
  private http?: EncryptAndUploadFileOperation

  constructor(private readonly options: SocketUploadDriverOptions) {
    this.transfer = new SocketUploadTransfer(options.plan.encryptedSize, options.digest)
    this.transfer.accepted({
      transferId: options.position.transferId,
      generation: options.position.generation,
      resumeId: options.position.resumeId,
      nextIndex: options.position.nextIndex,
      nextOffset: options.position.nextOffset,
      declaredSize: options.position.declaredSize,
    })
    this.pendingEncryptedBase = options.position.nextOffset
    this.encryptedProduced = options.position.nextOffset
    if (options.position.nextOffset !== 0 || options.position.maxFrameBytes < 1 || options.plan.decryptedSize < 1) {
      // A server that opens anywhere but byte zero is asking for a resume; a
      // transport that cannot carry one byte per frame cannot carry a file; and
      // an empty file has no socket lane at all, because the gateway's own size
      // check refuses a zero `decryptedSize`.
      this.remember('FILE_RESUME_UNSUPPORTED')
      this.transfer.serverError('FILE_RESUME_UNSUPPORTED')
    }
  }

  /** Which transport is actually carrying this upload. */
  get transport(): 'socket' | 'http' {
    return this.http ? 'http' : 'socket'
  }

  get encryptedChunkSizes(): number[] {
    return this.http ? this.http.encryptedChunkSizes : this.socketEncryptedChunkSizes
  }

  get vault(): VaultListingInterface | undefined {
    return this.http ? this.http.vault : this.options.vault
  }

  /** Set once the socket lane published the file; `undefined` while HTTP carries it. */
  get completedSha256(): HexString | undefined {
    return this.terminal?.outcome === 'completed' ? this.terminal.sha256 : undefined
  }

  /** Present only on the HTTP path, where `closeUploadSession` still needs it. */
  getValetToken(): string | undefined {
    return this.http?.getValetToken()
  }

  getProgress(): FileUploadProgress {
    if (this.http) {
      return this.http.getProgress()
    }
    const decryptedFileSize = this.options.plan.decryptedSize
    return {
      decryptedFileSize,
      decryptedBytesUploaded: this.decryptedAcknowledged,
      decryptedBytesRemaining: decryptedFileSize - this.decryptedAcknowledged,
      // Never a division by zero: the constructor refuses an empty file outright.
      percentComplete: (this.decryptedAcknowledged / decryptedFileSize) * 100.0,
    }
  }

  getResult(): FileUploadResult {
    if (this.http) {
      return this.http.getResult()
    }
    return {
      encryptionHeader: this.options.encryptionHeader,
      finalDecryptedSize: this.decryptedAccepted,
      key: this.options.file.key,
      remoteIdentifier: this.options.file.remoteIdentifier,
    }
  }

  /**
   * Takes the next run of plaintext. `chunkId` is the caller's own index and is
   * recorded in case of an HTTP restart, but it never decides what crosses the
   * wire — the plan does.
   */
  async pushBytes(
    decryptedBytes: Uint8Array,
    chunkId: number,
    isFinalChunk: boolean,
  ): Promise<SocketUploadPushOutcome> {
    if (this.http) {
      return this.pushOverHttp(this.http, decryptedBytes, chunkId, isFinalChunk)
    }
    if (this.terminal) {
      return this.terminal
    }
    if (this.decryptedAccepted + decryptedBytes.byteLength > this.options.plan.decryptedSize) {
      return this.abandon('FILE_PLAN_OVERRUN')
    }
    if (this.retains) {
      this.retained.push({ bytes: decryptedBytes, chunkId, isFinalChunk })
    }
    if (decryptedBytes.byteLength > 0) {
      this.pendingDecrypted.push(decryptedBytes)
      this.pendingDecryptedLength += decryptedBytes.byteLength
    }
    this.decryptedAccepted += decryptedBytes.byteLength
    if (isFinalChunk && this.decryptedAccepted !== this.options.plan.decryptedSize) {
      // The length the open promised the server is the one the file metadata will
      // claim too, so a stream that ends short is a corrupt upload, not a retry.
      return this.abandon('FILE_PLAN_UNDERRUN')
    }
    return this.drain()
  }

  /** Best-effort teardown of a transfer that will never finish. */
  cancel(): void {
    if (!this.http && this.terminal === undefined) {
      this.options.session.cancel()
    }
  }

  private async drain(): Promise<SocketUploadPushOutcome> {
    for (;;) {
      const action = this.transfer.nextAction()

      if (action.type === 'done') {
        this.terminal = { outcome: 'completed', sha256: action.sha256 }
        return this.terminal
      }

      if (action.type === 'abandon') {
        return this.conclude(this.failureCode ?? action.code, action.safeToFallback)
      }

      if (action.type === 'open') {
        // Either a resume after a socket loss, or a server offset this client
        // never produced. Both would need bytes that are gone.
        this.remember('FILE_RESUME_UNSUPPORTED')
        this.transfer.serverError('FILE_RESUME_UNSUPPORTED')
        continue
      }

      if (action.type === 'finish') {
        // Marked before the write: this client cannot know whether bytes it wrote
        // arrived, so "FINISH was attempted" is the only transition that never
        // under-states the risk of the upload already having been applied.
        this.transfer.finishSent()
        const finished = await this.options.session.finish({
          transferId: action.transferId,
          generation: action.generation,
          declaredSize: this.options.plan.encryptedSize,
          sha256: action.sha256,
        })
        if (finished.outcome === 'completed') {
          this.transfer.completed(finished.sha256)
          continue
        }
        if (finished.outcome === 'aborted') {
          this.cancelled = true
          this.remember('FILE_CANCELLED')
          this.transfer.serverError('FILE_CANCELLED')
          continue
        }
        this.recordFailure(finished)
        continue
      }

      const frame = this.nextFrame()
      if (frame === undefined) {
        // Everything on hand has been sent and acknowledged; the caller owes more
        // plaintext before another frame exists.
        return { outcome: 'accepted' }
      }
      if (frame === 'unproducible') {
        this.remember('FILE_INVALID_STATE')
        this.transfer.serverError('FILE_INVALID_STATE')
        continue
      }

      const acknowledged = await this.options.session.sendChunk({
        index: action.index,
        offset: action.offset,
        bytes: frame,
      })
      if (acknowledged.outcome === 'acknowledged') {
        this.transfer.chunkAcknowledged(acknowledged)
        const position = this.transfer.position
        if (position === undefined) {
          // The transfer refused the ack outright; its verdict stands.
          continue
        }
        if (position.nextOffset < action.offset + frame.byteLength || position.nextOffset > this.encryptedProduced) {
          // An ack that does not clear the frame just sent would spin this loop
          // forever, and one that claims bytes this client never produced has
          // lost track of which transfer it is answering. Both are fatal here.
          this.remember('FILE_INVALID_STATE')
          this.transfer.serverError('FILE_INVALID_STATE')
          continue
        }
        this.release(position.nextOffset)
        continue
      }
      if (acknowledged.outcome === 'aborted') {
        this.cancelled = true
        this.remember('FILE_CANCELLED')
        this.transfer.serverError('FILE_CANCELLED')
        continue
      }
      this.recordFailure(acknowledged)
    }
  }

  /**
   * The next frame to write, `undefined` when more plaintext is needed first, and
   * `'unproducible'` when no frame can be produced at all.
   *
   * There is exactly one legal place to send from — `pendingEncryptedBase`, which
   * is where the server's last acknowledgement left the stream — so there is no
   * offset arithmetic here to get wrong. A frame never straddles a chunk
   * boundary either: the buffer holds at most one encrypted chunk at a time, so
   * the last frame of a chunk is simply short.
   */
  private nextFrame(): Uint8Array | undefined | 'unproducible' {
    if (this.pendingEncrypted.byteLength === 0) {
      const produced = this.produceEncryptedChunk()
      if (produced !== 'produced') {
        return produced === 'abandoned' ? 'unproducible' : undefined
      }
    }
    const length = Math.min(this.options.position.maxFrameBytes, this.pendingEncrypted.byteLength)
    return this.pendingEncrypted.subarray(0, length)
  }

  /**
   * Encrypts exactly one planned chunk, if enough plaintext is on hand.
   *
   * Only ever called with an empty buffer, and only while the transfer still
   * wants bytes — so the plan always has a chunk left to give.
   */
  private produceEncryptedChunk(): 'produced' | 'needs-more-plaintext' | 'abandoned' {
    const plan = this.options.plan
    const decryptedLength = decryptedChunkLengthAt(plan, this.nextPlanChunk)
    if (this.pendingDecryptedLength < decryptedLength) {
      return 'needs-more-plaintext'
    }
    const isFinalChunk = this.nextPlanChunk === plan.chunkCount - 1
    const encrypted = this.options.encryptor.pushBytes(this.takeDecrypted(decryptedLength), isFinalChunk)
    this.options.digest.update(encrypted)
    if (this.options.digest.bytesHashed > plan.encryptedSize) {
      // Caught on the chunk that overruns rather than at FINISH: the transfer's
      // own check is an end-of-stream equality, by which point the whole file has
      // already been encrypted and sent.
      this.remember('FILE_PLAN_OVERRUN')
      this.transfer.serverError('FILE_PLAN_OVERRUN')
      return 'abandoned'
    }
    this.socketEncryptedChunkSizes.push(encrypted.byteLength)
    this.encryptedProduced += encrypted.byteLength
    this.chunkBoundaries.push({ encryptedEnd: this.encryptedProduced, decryptedLength })
    this.nextPlanChunk += 1
    this.pendingEncrypted = encrypted
    return 'produced'
  }

  private takeDecrypted(length: number): Uint8Array {
    const taken = new Uint8Array(length)
    let written = 0
    while (written < length) {
      const head = this.pendingDecrypted[0]
      const usable = Math.min(head.byteLength, length - written)
      taken.set(head.subarray(0, usable), written)
      written += usable
      if (usable === head.byteLength) {
        this.pendingDecrypted.shift()
      } else {
        this.pendingDecrypted[0] = head.subarray(usable)
      }
    }
    this.pendingDecryptedLength -= length
    return taken
  }

  /** Drops what the server has stored, and closes the HTTP retention window. */
  private release(nextOffset: number): void {
    this.pendingEncrypted = this.pendingEncrypted.subarray(nextOffset - this.pendingEncryptedBase)
    this.pendingEncryptedBase = nextOffset
    this.retains = false
    this.retained = []
    this.decryptedAcknowledged = this.chunkBoundaries
      .filter((boundary) => boundary.encryptedEnd <= nextOffset)
      .reduce((total, boundary) => total + boundary.decryptedLength, 0)
  }

  /** First code wins: it names what actually went wrong, not what it cascaded into. */
  private remember(code: string): void {
    if (this.failureCode === undefined) {
      this.failureCode = code
    }
  }

  private recordFailure(failure: SocketFileUploadFailure): void {
    this.remember(failure.code)
    if (failure.retryable) {
      // The socket may come back, but this client cannot resume, so record the
      // position and let the refusal above turn it into a clean abandon.
      this.transfer.socketLost()
      return
    }
    this.transfer.serverError(failure.code)
  }

  /**
   * The CALLER broke the size contract it opened under. Deliberately fatal
   * rather than restartable: the bytes that violated the plan were refused, so an
   * HTTP replay of what is retained would publish a short file, and silently
   * re-routing would hide the caller's bug behind a slower upload.
   */
  private abandon(code: string): Promise<SocketUploadPushOutcome> {
    this.remember(code)
    this.transfer.serverError(code)
    return this.conclude(code, this.transfer.safeToFallback, false)
  }

  /**
   * The socket path is over. Restart over HTTP when that is still provably safe,
   * and otherwise report the failure rather than risk applying the upload twice.
   */
  private async conclude(code: string, safeToFallback: boolean, restartable = true): Promise<SocketUploadPushOutcome> {
    this.options.session.cancel()
    if (restartable && safeToFallback && this.retains && !this.cancelled) {
      const restarted = await this.restartOverHttp()
      if (restarted) {
        return restarted
      }
    }
    this.terminal = { outcome: 'failed', code, safeToFallback }
    return this.terminal
  }

  private async restartOverHttp(): Promise<SocketUploadPushOutcome | undefined> {
    const operation = await this.options.beginHttpFallback()
    if (isClientDisplayableError(operation)) {
      return undefined
    }
    const replay = this.retained
    this.http = operation
    this.retains = false
    this.retained = []
    this.pendingDecrypted = []
    this.pendingDecryptedLength = 0
    this.pendingEncrypted = new Uint8Array(0)
    this.socketEncryptedChunkSizes.length = 0
    for (const entry of replay) {
      const pushed = await this.pushOverHttp(operation, entry.bytes, entry.chunkId, entry.isFinalChunk)
      if (pushed.outcome !== 'accepted') {
        return pushed
      }
    }
    return { outcome: 'accepted' }
  }

  private async pushOverHttp(
    operation: EncryptAndUploadFileOperation,
    decryptedBytes: Uint8Array,
    chunkId: number,
    isFinalChunk: boolean,
  ): Promise<SocketUploadPushOutcome> {
    const uploaded = await operation.pushBytes(decryptedBytes, chunkId, isFinalChunk)
    if (uploaded) {
      return { outcome: 'accepted' }
    }
    this.terminal = { outcome: 'failed', code: 'FILE_HTTP_CHUNK_REJECTED', safeToFallback: false }
    return this.terminal
  }
}
