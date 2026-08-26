import { HexString, PureCryptoInterface, StreamingHash } from '@standardnotes/sncrypto-common'

export class EncryptedStreamDigestError extends Error {}

/**
 * The SHA-256 of a file's whole encrypted byte stream, accumulated as those
 * bytes are produced.
 *
 * `FILES_UPLOAD_FINISH` requires this digest, and the encrypted stream is never
 * resident in memory — the upload path is chunked precisely so a multi-gigabyte
 * file need not be. WebCrypto's `subtle.digest` is one-shot with no incremental
 * form, so this drives the streaming hash on {@link PureCryptoInterface}.
 *
 * Deliberately a property of the FILE, not of a transfer attempt. A resumed
 * upload rewinds to the last offset the server actually stored and re-sends from
 * there, but the digest still covers the same complete file, so it is computed
 * once and survives any number of resume cycles unchanged. Tying it to an
 * attempt would mean recomputing it from bytes the client may no longer hold.
 */
export class EncryptedStreamDigest {
  private hash: StreamingHash
  private finalized = false
  private byteLength = 0

  constructor(private readonly crypto: PureCryptoInterface) {
    this.hash = this.crypto.sha256StreamInit()
  }

  /** Total bytes hashed so far; must equal the transfer's declared size at the end. */
  get bytesHashed(): number {
    return this.byteLength
  }

  /** Adds the next encrypted chunk. Order is significant — this is a stream, not a set. */
  update(bytes: Uint8Array): void {
    if (this.finalized) {
      throw new EncryptedStreamDigestError('Encrypted stream digest received data after it was finalized.')
    }
    if (bytes.byteLength === 0) {
      return
    }
    this.crypto.sha256StreamUpdate(this.hash, bytes)
    this.byteLength += bytes.byteLength
  }

  /**
   * Finalizes and returns the hex digest.
   *
   * Single-use: the underlying hash state is released, so a second call would
   * read freed state rather than return the same answer. Callers that need the
   * value more than once must retain it.
   */
  final(): HexString {
    if (this.finalized) {
      throw new EncryptedStreamDigestError('Encrypted stream digest was finalized more than once.')
    }
    this.finalized = true
    return this.crypto.sha256StreamFinal(this.hash)
  }
}
