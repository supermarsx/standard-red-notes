import { SodiumConstant } from '@standardnotes/sncrypto-common'

export class UploadSizePlanError extends Error {}

/**
 * Bytes xchacha20-poly1305 secretstream adds to **every** push: the Poly1305 tag
 * plus the one-byte tag field.
 *
 * Read from the constant table rather than written as `17` by hand —
 * `app/packages/sncrypto-common/src/Types/SodiumConstant.ts:3`. It is applied
 * once per `FileEncryptor.pushBytes`
 * (`app/packages/files/src/Domain/UseCase/FileEncryptor.ts:18-33`, which calls
 * `crypto.xchacha20StreamEncryptorPush` exactly once per chunk), so the total
 * overhead of a file is this times its chunk count and nothing else. The
 * 24-byte stream header
 * (`CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_HEADERBYTES`, same file line 4) is
 * deliberately NOT included: it travels in the file's `encryptionHeader`
 * metadata, not in the uploaded byte stream.
 */
export const EncryptedChunkOverheadBytes = SodiumConstant.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES

/** A decided chunk schedule, and the encrypted total that follows from it. */
export type UploadSizePlan = {
  /** Plaintext length of the file. */
  decryptedSize: number
  /** Plaintext bytes per chunk. Every chunk but the last is exactly this long. */
  decryptedChunkSize: number
  /** How many times the encryptor will be pushed. Always at least one. */
  chunkCount: number
  /** Plaintext length of the final chunk; equals `decryptedChunkSize` on an exact multiple. */
  finalChunkDecryptedSize: number
  /** `FILES_UPLOAD_OPEN`'s `declaredSize`: the total ENCRYPTED byte count. */
  encryptedSize: number
}

const assertPlannable = (decryptedSize: number, decryptedChunkSize: number): void => {
  if (!Number.isSafeInteger(decryptedSize) || decryptedSize < 0) {
    throw new UploadSizePlanError('An upload size plan needs a non-negative whole decrypted size.')
  }
  if (!Number.isSafeInteger(decryptedChunkSize) || decryptedChunkSize < 1) {
    throw new UploadSizePlanError('An upload size plan needs a positive whole chunk size.')
  }
}

/**
 * How many times the encryptor will be pushed for a file of this size, on a plan
 * of fixed `decryptedChunkSize` chunks.
 *
 * A zero-byte file still costs one chunk. The secretstream has to be pushed at
 * least once to emit its FINAL tag, and both readers already do exactly that:
 * `app/packages/filepicker/src/Classic/ClassicReader.ts:71-73` feeds one empty
 * buffer, and `app/packages/filepicker/src/Streaming/StreamingReader.ts:54`
 * flushes `previousChunk ?? new Uint8Array()` when the stream ends. That is also
 * what keeps `declaredSize` legal — see {@link plannedEncryptedSize}.
 */
export function plannedChunkCount(decryptedSize: number, decryptedChunkSize: number): number {
  assertPlannable(decryptedSize, decryptedChunkSize)

  return Math.max(1, Math.ceil(decryptedSize / decryptedChunkSize))
}

/**
 * The total ENCRYPTED size of a file uploaded as fixed `decryptedChunkSize`
 * chunks — the `declaredSize` that `FILES_UPLOAD_OPEN` demands before a single
 * byte is sent, and that every binary chunk header re-asserts
 * (`server/packages/websocket-gateway/src/filesProtocol.ts:204-212`).
 *
 * ## Contract the caller must honour
 *
 * This number is a **prediction, made true by construction** — and only if the
 * caller actually drives the encryptor on this schedule: exactly
 * {@link plannedChunkCount} pushes, each of exactly `decryptedChunkSize`
 * plaintext bytes except a possibly shorter last one. Feed the encryptor on any
 * other schedule and the prediction is wrong, silently, until FINISH.
 *
 * **`ByteChunker` does not realize this plan and must not be used to.** Despite
 * the name, `minimumChunkSize` is a floor, not a size:
 * `Chunker/ByteChunker.ts:33` pops `Math.max(this.minimumChunkSize,
 * this.bytes.length)`, i.e. everything buffered, so a chunk is as large as
 * whatever the reader happened to deliver. With `ClassicReader`'s 2 MB reads
 * (`app/packages/filepicker/src/Classic/ClassicReader.ts:69`) against the 5 MB
 * floor (`FileService.minimumChunkSize()`,
 * `app/packages/services/src/Domain/Files/FileService.ts:150-152`, reached
 * through `Service/FilesClientInterface.ts:14`) the real chunks are 6 MB, and a
 * file of `chunkSize + 1` bytes becomes **one** chunk where this function
 * predicts two. `StreamingReader` is worse: its read sizes come from the
 * browser, so its chunk count is not a function of the file at all. The spec
 * pins both mismatches so this comment cannot quietly become false.
 *
 * ## Why being wrong is expensive
 *
 * The gateway checks `declaredSize` at open, on every chunk header, and again at
 * FINISH (`state.nextOffset !== state.descriptor.declaredSize` →
 * `FILE_INCOMPLETE`). An error of one chunk — 17 bytes — therefore surfaces only
 * **after the whole file has crossed the wire**, with a message that names
 * neither chunking nor size.
 *
 * ## Bounds the caller still owns
 *
 * The result is always `>= EncryptedChunkOverheadBytes`, so it satisfies the
 * `declaredSize >= 1` rule (`filesProtocol.ts:166-168`, `allowZero` false) even
 * for an empty file. The upper bound is **not** checked here, because its
 * constant belongs to the transport rather than to this package: compare the
 * result against `MAX_FILE_TRANSFER_BYTES` (`filesProtocol.ts:8`, mirrored for
 * the client in
 * `app/packages/web/src/javascripts/Services/SyncTransport/syncTransportProtocol.ts:29`)
 * before opening — and against **this** result, not against the decrypted size.
 * The cap bounds the encrypted total, so the overhead eats into it: at a 5 MB
 * chunk size the largest decrypted file that still fits under 5 GiB is
 * 5,368,690,862 bytes, and the ~18 KB band above that would pass a
 * decrypted-size check and then fail the open.
 *
 * Unrelated to all of the above: the 256 KiB `MAX_FILE_CHUNK_BYTES`
 * (`filesProtocol.ts:5`) is a *frame* limit. The transport re-slices the
 * encrypted stream into frames of its own; that slicing changes neither the
 * chunk count nor this total.
 */
export function plannedEncryptedSize(decryptedSize: number, decryptedChunkSize: number): number {
  const chunkCount = plannedChunkCount(decryptedSize, decryptedChunkSize)
  const encryptedSize = decryptedSize + EncryptedChunkOverheadBytes * chunkCount

  if (!Number.isSafeInteger(encryptedSize)) {
    throw new UploadSizePlanError('An upload size plan exceeds the largest exactly representable size.')
  }

  return encryptedSize
}

/**
 * The whole schedule in one value, so the uploader and the `FILES_UPLOAD_OPEN`
 * frame cannot disagree about which plan they are on.
 */
export function planUploadSize(decryptedSize: number, decryptedChunkSize: number): UploadSizePlan {
  const encryptedSize = plannedEncryptedSize(decryptedSize, decryptedChunkSize)
  const chunkCount = plannedChunkCount(decryptedSize, decryptedChunkSize)
  const remainder = decryptedSize % decryptedChunkSize

  return {
    decryptedSize,
    decryptedChunkSize,
    chunkCount,
    // An exact multiple ends on a full chunk; an empty file's only chunk is empty.
    finalChunkDecryptedSize: decryptedSize === 0 ? 0 : remainder === 0 ? decryptedChunkSize : remainder,
    encryptedSize,
  }
}

/**
 * Plaintext length of chunk `index` (0-based) under `plan`. The uploader slices
 * on these lengths; doing anything else invalidates `plan.encryptedSize`.
 */
export function decryptedChunkLengthAt(plan: UploadSizePlan, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= plan.chunkCount) {
    throw new UploadSizePlanError(`Chunk ${index} is outside a plan of ${plan.chunkCount} chunks.`)
  }

  return index === plan.chunkCount - 1 ? plan.finalChunkDecryptedSize : plan.decryptedChunkSize
}
