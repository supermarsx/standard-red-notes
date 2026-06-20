import { PureCryptoInterface, StreamEncryptor } from '@standardnotes/sncrypto-common'

import { ByteChunker } from '../Chunker/ByteChunker'
import { LocalOnlyFileUploadOperation } from './EncryptLocalOnly'

/**
 * Deterministic stability benchmark for "large local-only files" (100 / 250 / 500 MB).
 *
 * IMPORTANT: jsdom / a node test worker cannot safely allocate a real 500 MB buffer (and doing
 * so wouldn't represent a browser tab anyway). So we do NOT allocate the full file. Instead we:
 *   - stream the file to the chunker in fixed-size slices (a single reused buffer), exactly how
 *     the real reader feeds bytes, and count the chunks/byte-accounting,
 *   - measure the per-chunk cost of the encryption + accumulation step on ONE representative
 *     chunk and extrapolate linearly to the full size,
 *   - compute the local persistence sizing (encrypted overhead + chunk count).
 *
 * The numbers printed here are coarse and machine-dependent; they exist to characterise the
 * shape of the cost (linear in size, dominated by full-payload accumulation), not to assert a
 * wall-clock budget. The only hard assertions are correctness invariants (chunk math, byte
 * accounting) so the test is deterministic in CI.
 */

const MB = 1_000_000
const MINIMUM_CHUNK_SIZE = 5 * MB // FileService.minimumChunkSize()
const ENCRYPTION_OVERHEAD_PER_CHUNK = 17 // xchacha20poly1305 stream tag+mac per push (approx.)

const SIZES = [
  { label: '100 MB', bytes: 100 * MB },
  { label: '250 MB', bytes: 250 * MB },
  { label: '500 MB', bytes: 500 * MB },
]

describe('large local-only file stability benchmark', () => {
  /**
   * Feeds `totalBytes` to a ByteChunker in `sliceSize` slices using a single reused buffer, so we
   * never hold the whole file in memory. Returns the chunk count + total bytes the chunker saw.
   */
  async function streamThroughChunker(
    totalBytes: number,
    minimumChunkSize: number,
    sliceSize: number,
  ): Promise<{ chunkCount: number; bytesChunked: number; maxChunkSize: number }> {
    let chunkCount = 0
    let bytesChunked = 0
    let maxChunkSize = 0

    const chunker = new ByteChunker(minimumChunkSize, async ({ data }) => {
      chunkCount++
      bytesChunked += data.length
      maxChunkSize = Math.max(maxChunkSize, data.length)
    })

    const slice = new Uint8Array(sliceSize)
    let remaining = totalBytes
    while (remaining > 0) {
      const thisSlice = Math.min(sliceSize, remaining)
      remaining -= thisSlice
      await chunker.addBytes(thisSlice === sliceSize ? slice : slice.subarray(0, thisSlice), remaining === 0)
    }

    return { chunkCount, bytesChunked, maxChunkSize }
  }

  it('streams a representative size through the real chunker and extrapolates 100/250/500 MB', async () => {
    // We stream only a representative slice of the file through the REAL ByteChunker (proving
    // correctness + measuring the actual per-MB cost), then extrapolate chunk counts/time to the
    // full sizes. We deliberately do NOT stream the full 500 MB because ByteChunker concatenates
    // its internal buffer with `new Uint8Array([...this.bytes, ...bytes])`, which is O(n) per add
    // — streaming 500 MB through it is pathologically slow (a real-world finding in itself: the
    // chunker is not suited to very large inputs and dominates upload CPU on big files).
    const representativeBytes = 30 * MB
    const sliceSize = 1 * MB

    const start = Date.now()
    const { chunkCount, bytesChunked, maxChunkSize } = await streamThroughChunker(
      representativeBytes,
      MINIMUM_CHUNK_SIZE,
      sliceSize,
    )
    const elapsedMs = Date.now() - start
    const msPerMb = elapsedMs / (representativeBytes / MB)

    expect(bytesChunked).toBe(representativeBytes)
    expect(chunkCount).toBe(Math.ceil(representativeBytes / MINIMUM_CHUNK_SIZE))
    expect(maxChunkSize).toBeGreaterThanOrEqual(MINIMUM_CHUNK_SIZE)

    // eslint-disable-next-line no-console
    console.log(
      `[chunking] measured ${representativeBytes / MB}MB: ${chunkCount} chunks in ${elapsedMs}ms ` +
        `(~${msPerMb.toFixed(1)}ms/MB through the real ByteChunker)`,
    )

    for (const { label, bytes } of SIZES) {
      const chunks = Math.ceil(bytes / MINIMUM_CHUNK_SIZE)
      // eslint-disable-next-line no-console
      console.log(
        `[chunking] ${label}: ${chunks} chunks, extrapolated chunker CPU ~${(
          (msPerMb * bytes) / MB / 1000
        ).toFixed(1)}s (extrapolated; real cost is super-linear due to the chunker's array spread)`,
      )
    }
  })

  it('measures per-chunk encryption cost and extrapolates to full file (single-chunk measurement)', () => {
    // A crypto mock that does representative work per push: it allocates an output buffer the
    // size of the input + overhead and copies the bytes (mirrors the real memory behaviour of
    // producing a fresh encrypted Uint8Array per chunk, without the native xchacha cost).
    const crypto = {} as jest.Mocked<PureCryptoInterface>
    crypto.xchacha20StreamInitEncryptor = jest
      .fn()
      .mockReturnValue({ header: 'header', state: {} } as StreamEncryptor)
    crypto.xchacha20StreamEncryptorPush = jest.fn().mockImplementation((_stream, message: Uint8Array) => {
      const out = new Uint8Array(message.length + ENCRYPTION_OVERHEAD_PER_CHUNK)
      out.set(message)
      return out
    })

    const oneChunk = new Uint8Array(MINIMUM_CHUNK_SIZE)

    // Time a single representative chunk encryption.
    const op = new LocalOnlyFileUploadOperation({ key: 'k', remoteIdentifier: 'r', decryptedSize: MINIMUM_CHUNK_SIZE }, crypto)
    const startOne = Date.now()
    op.pushBytes(oneChunk, true)
    const perChunkMs = Date.now() - startOne

    for (const { label, bytes } of SIZES) {
      const chunks = Math.ceil(bytes / MINIMUM_CHUNK_SIZE)
      const extrapolatedEncryptMs = perChunkMs * chunks
      const encryptedSize = bytes + chunks * ENCRYPTION_OVERHEAD_PER_CHUNK

      // eslint-disable-next-line no-console
      console.log(
        `[encrypt] ${label}: ${chunks} chunks @ ~${perChunkMs}ms/chunk => ~${extrapolatedEncryptMs}ms encrypt; ` +
          `encrypted size ~${(encryptedSize / MB).toFixed(2)}MB`,
      )

      // Encrypted size is always >= decrypted size (overhead) and overhead is bounded.
      expect(encryptedSize).toBeGreaterThanOrEqual(bytes)
      expect(encryptedSize - bytes).toBe(chunks * ENCRYPTION_OVERHEAD_PER_CHUNK)
    }
  })

  it('accumulating the full encrypted payload concatenates correctly (small-size proof of correctness)', () => {
    // Prove getEncryptedBytes() concatenates all chunks in order, using a SMALL size so we can
    // actually allocate it. The real 500 MB path uses the identical code; this asserts the
    // accumulation logic that, at 500 MB, is the dominant transient memory cost (a second full
    // copy of the file's encrypted bytes in a single contiguous buffer).
    const crypto = {} as jest.Mocked<PureCryptoInterface>
    crypto.xchacha20StreamInitEncryptor = jest
      .fn()
      .mockReturnValue({ header: 'header', state: {} } as StreamEncryptor)
    let counter = 0
    crypto.xchacha20StreamEncryptorPush = jest.fn().mockImplementation((_stream, message: Uint8Array) => {
      // Tag each chunk's first byte so we can verify ordering.
      const out = new Uint8Array(message.length)
      out.fill(++counter)
      return out
    })

    const op = new LocalOnlyFileUploadOperation({ key: 'k', remoteIdentifier: 'r', decryptedSize: 30 }, crypto)
    op.pushBytes(new Uint8Array(10), false)
    op.pushBytes(new Uint8Array(10), false)
    op.pushBytes(new Uint8Array(10), true)

    const aggregate = op.getEncryptedBytes().encryptedBytes
    expect(aggregate.length).toBe(30)
    expect(op.encryptedChunkSizes).toEqual([10, 10, 10])
    expect(op.decryptedSize).toBe(30)
    // Ordering preserved: first 10 bytes from chunk 1, next from chunk 2, etc.
    expect(aggregate[0]).toBe(1)
    expect(aggregate[10]).toBe(2)
    expect(aggregate[20]).toBe(3)
  })

  it('reports the local persistence + memory profile for each size', () => {
    for (const { label, bytes } of SIZES) {
      const chunks = Math.ceil(bytes / MINIMUM_CHUNK_SIZE)
      const encryptedSize = bytes + chunks * ENCRYPTION_OVERHEAD_PER_CHUNK

      // Peak transient memory while finishing a local-only upload is roughly:
      //   plaintext file (held by the browser File/Blob, often disk-backed) +
      //   array of encrypted chunks (~encryptedSize) +
      //   single concatenated encrypted buffer (~encryptedSize) +
      //   the Blob written to IndexedDB (~encryptedSize, may be disk-backed)
      // i.e. ~2x-3x the file size live in JS heap at the moment of getEncryptedBytes().
      const approxPeakHeapMB = (encryptedSize * 2) / MB

      // eslint-disable-next-line no-console
      console.log(
        `[persist] ${label}: stored encrypted ~${(encryptedSize / MB).toFixed(2)}MB in IndexedDB across ` +
          `${chunks} chunks; approx transient JS heap at finish ~${approxPeakHeapMB.toFixed(0)}MB`,
      )

      expect(approxPeakHeapMB).toBeGreaterThan(0)
    }
  })
})
