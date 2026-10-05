import { SodiumConstant } from '@standardnotes/sncrypto-common'

import { ByteChunker } from './ByteChunker'
import {
  decryptedChunkLengthAt,
  EncryptedChunkOverheadBytes,
  plannedChunkCount,
  plannedEncryptedSize,
  planUploadSize,
  UploadSizePlanError,
} from './UploadSizePlan'

/** `FileService.minimumChunkSize()` — services/src/Domain/Files/FileService.ts:150-152. */
const MinimumChunkSize = 5_000_000

describe('UploadSizePlan', () => {
  it('reads the per-chunk overhead from the sodium constant rather than restating it', () => {
    expect(EncryptedChunkOverheadBytes).toBe(SodiumConstant.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES)
    // Pinned so a constant table edit cannot silently change every declaredSize.
    expect(EncryptedChunkOverheadBytes).toBe(17)
  })

  describe('boundaries', () => {
    it('plans one chunk for a zero-byte file, so declaredSize stays legal', () => {
      expect(plannedChunkCount(0, MinimumChunkSize)).toBe(1)
      // The gateway rejects declaredSize < 1 (filesProtocol.ts:166-168), so a
      // zero-chunk plan for an empty file would make empty files unuploadable.
      expect(plannedEncryptedSize(0, MinimumChunkSize)).toBe(17)
      expect(plannedEncryptedSize(0, MinimumChunkSize)).toBeGreaterThanOrEqual(1)
    })

    it('plans one chunk for a file smaller than one chunk', () => {
      expect(plannedChunkCount(1, MinimumChunkSize)).toBe(1)
      expect(plannedEncryptedSize(1, MinimumChunkSize)).toBe(18)
      expect(plannedEncryptedSize(MinimumChunkSize - 1, MinimumChunkSize)).toBe(4_999_999 + 17)
    })

    it('plans exactly one chunk for a file of exactly one chunk', () => {
      expect(plannedChunkCount(MinimumChunkSize, MinimumChunkSize)).toBe(1)
      expect(plannedEncryptedSize(MinimumChunkSize, MinimumChunkSize)).toBe(5_000_017)
    })

    it('plans two chunks one byte over the boundary', () => {
      expect(plannedChunkCount(MinimumChunkSize + 1, MinimumChunkSize)).toBe(2)
      expect(plannedEncryptedSize(MinimumChunkSize + 1, MinimumChunkSize)).toBe(5_000_001 + 34)
    })

    it('plans a multi-chunk file with a short tail', () => {
      expect(plannedChunkCount(12_500_000, MinimumChunkSize)).toBe(3)
      expect(plannedEncryptedSize(12_500_000, MinimumChunkSize)).toBe(12_500_000 + 51)
    })

    it('plans a multi-chunk file that divides exactly', () => {
      expect(plannedChunkCount(15_000_000, MinimumChunkSize)).toBe(3)
      expect(plannedEncryptedSize(15_000_000, MinimumChunkSize)).toBe(15_000_000 + 51)
    })

    it('stays exact at the 5 GiB transfer ceiling', () => {
      const fiveGibibytes = 5 * 1024 * 1024 * 1024
      const encryptedSize = plannedEncryptedSize(fiveGibibytes, MinimumChunkSize)

      expect(plannedChunkCount(fiveGibibytes, MinimumChunkSize)).toBe(1074)
      expect(encryptedSize).toBe(fiveGibibytes + 17 * 1074)
      expect(Number.isSafeInteger(encryptedSize)).toBe(true)
    })

    it('shows the overhead eating into MAX_FILE_TRANSFER_BYTES, which bounds the ENCRYPTED total', () => {
      // MAX_FILE_TRANSFER_BYTES — websocket-gateway/src/filesProtocol.ts:8.
      const cap = 5 * 1024 * 1024 * 1024

      // A decrypted file of exactly the cap does not fit once encrypted, so a
      // caller that checks the decrypted size against the cap opens a transfer
      // the gateway will refuse.
      expect(plannedEncryptedSize(cap, MinimumChunkSize)).toBeGreaterThan(cap)

      const largestThatFits = 5_368_690_862
      expect(plannedEncryptedSize(largestThatFits, MinimumChunkSize)).toBe(cap)
      expect(plannedEncryptedSize(largestThatFits + 1, MinimumChunkSize)).toBeGreaterThan(cap)
    })

    it('refuses a size it could not represent exactly', () => {
      expect(() => plannedEncryptedSize(Number.MAX_SAFE_INTEGER, 1)).toThrow(UploadSizePlanError)
    })
  })

  describe('the arithmetic is the sum of the chunk plan, not a formula beside it', () => {
    it.each([0, 1, 999, MinimumChunkSize - 1, MinimumChunkSize, MinimumChunkSize + 1, 12_500_000, 15_000_000])(
      'agrees with chunk-by-chunk summation for %i bytes',
      (decryptedSize) => {
        const plan = planUploadSize(decryptedSize, MinimumChunkSize)

        let decryptedTotal = 0
        let encryptedTotal = 0
        for (let index = 0; index < plan.chunkCount; index++) {
          const length = decryptedChunkLengthAt(plan, index)
          decryptedTotal += length
          encryptedTotal += length + EncryptedChunkOverheadBytes
        }

        expect(decryptedTotal).toBe(decryptedSize)
        expect(encryptedTotal).toBe(plan.encryptedSize)
        expect(plan.encryptedSize).toBe(plannedEncryptedSize(decryptedSize, MinimumChunkSize))
      },
    )

    it('reports the final chunk length that the uploader must slice', () => {
      expect(planUploadSize(0, 100).finalChunkDecryptedSize).toBe(0)
      expect(planUploadSize(100, 100).finalChunkDecryptedSize).toBe(100)
      expect(planUploadSize(101, 100).finalChunkDecryptedSize).toBe(1)
      expect(planUploadSize(250, 100).finalChunkDecryptedSize).toBe(50)
    })

    it('refuses a chunk index outside the plan', () => {
      const plan = planUploadSize(250, 100)

      expect(() => decryptedChunkLengthAt(plan, -1)).toThrow(UploadSizePlanError)
      expect(() => decryptedChunkLengthAt(plan, 3)).toThrow(UploadSizePlanError)
      expect(() => decryptedChunkLengthAt(plan, 1.5)).toThrow(UploadSizePlanError)
      expect(decryptedChunkLengthAt(plan, 2)).toBe(50)
    })
  })

  describe('input validation', () => {
    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %p as a decrypted size', (decryptedSize) => {
      expect(() => plannedEncryptedSize(decryptedSize, MinimumChunkSize)).toThrow(UploadSizePlanError)
    })

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %p as a chunk size', (chunkSize) => {
      expect(() => plannedEncryptedSize(1000, chunkSize)).toThrow(UploadSizePlanError)
      expect(() => planUploadSize(1000, chunkSize)).toThrow(UploadSizePlanError)
    })
  })

  /**
   * The reason this module exists, kept executable.
   *
   * `plannedEncryptedSize` is only true if the caller drives the encryptor on
   * the plan. The existing HTTP path does not, and these tests pin the exact
   * disagreement so the docblock's warning cannot rot into a false claim.
   *
   * Scaled down by 1000 from the real numbers (5 MB floor, 2 MB reads) purely so
   * the test is fast: `ByteChunker.addBytes` rebuilds its buffer with an array
   * spread, which is quadratic. The ratios — and therefore the chunk counts —
   * are identical.
   */
  describe('why ByteChunker cannot realize the plan', () => {
    const Floor = 5_000
    const ReadSize = 2_000

    /** `ClassicReader.readFile` verbatim — filepicker/src/Classic/ClassicReader.ts:62-80. */
    const chunkLengthsFromClassicReader = async (totalBytes: number): Promise<number[]> => {
      const lengths: number[] = []
      const chunker = new ByteChunker(Floor, async ({ data }) => {
        lengths.push(data.length)
      })
      const buffer = new Uint8Array(totalBytes)

      if (buffer.length === 0) {
        await chunker.addBytes(new Uint8Array(), true)
      }
      for (let i = 0; i < buffer.length; i += ReadSize) {
        const chunkMax = i + ReadSize
        await chunker.addBytes(buffer.slice(i, chunkMax), chunkMax >= buffer.length)
      }

      return lengths
    }

    it('emits chunks larger than the floor, so one byte over a boundary is still one chunk', async () => {
      const lengths = await chunkLengthsFromClassicReader(Floor + 1)

      // The plan says two chunks; the real reader produces one, because
      // ByteChunker.ts:33 pops everything buffered rather than one floor's worth.
      expect(lengths).toEqual([Floor + 1])
      expect(plannedChunkCount(Floor + 1, Floor)).toBe(2)
      expect(plannedEncryptedSize(Floor + 1, Floor)).not.toBe(Floor + 1 + EncryptedChunkOverheadBytes * lengths.length)
    })

    it('drifts by a whole chunk over a larger file', async () => {
      const total = 50_000
      const lengths = await chunkLengthsFromClassicReader(total)

      // 2 KB reads accumulate to 6 KB before the 5 KB floor trips, so the real
      // chunks are 6 KB and there are nine of them, not ten.
      expect(lengths).toEqual([6_000, 6_000, 6_000, 6_000, 6_000, 6_000, 6_000, 6_000, 2_000])
      expect(plannedChunkCount(total, Floor)).toBe(10)

      const actualEncryptedSize = total + EncryptedChunkOverheadBytes * lengths.length
      expect(plannedEncryptedSize(total, Floor) - actualEncryptedSize).toBe(EncryptedChunkOverheadBytes)
    })

    it('does agree with the plan on an empty file, which is the one case it cannot differ on', async () => {
      const lengths = await chunkLengthsFromClassicReader(0)

      expect(lengths).toEqual([0])
      expect(plannedChunkCount(0, Floor)).toBe(1)
      expect(plannedEncryptedSize(0, Floor)).toBe(EncryptedChunkOverheadBytes * lengths.length)
    })
  })
})
