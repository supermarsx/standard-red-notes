import { createHash, webcrypto } from 'crypto'
import { PureCryptoInterface, StreamingHash } from '@standardnotes/sncrypto-common'

import { EncryptedStreamDigest, EncryptedStreamDigestError } from './EncryptedStreamDigest'

/**
 * `crypto.subtle` is absent in jsdom, and a `hasSubtle ? describe : describe.skip`
 * guard would make the equivalence suite below pass by never running. So install
 * Node's WebCrypto onto the global rather than skip: the comparison either runs
 * or the suite fails outright.
 */
const globalWithCrypto = globalThis as { crypto?: { subtle?: SubtleCrypto } }
if (typeof globalWithCrypto.crypto?.subtle?.digest !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
}
const subtle = (globalThis as unknown as { crypto: { subtle: SubtleCrypto } }).crypto.subtle

/** The exact one-shot call the browser would make over a whole in-memory stream. */
const oneShotSubtleDigest = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(await subtle.digest('SHA-256', new Uint8Array(bytes))).toString('hex')

/**
 * Node's own SHA-256 stands in for libsodium here, which is the point: the risk
 * this file covers is THIS code mis-driving a streaming hash — feeding chunks out
 * of order, dropping one, or finalizing twice — not whether libsodium computes
 * SHA-256 correctly. Using an independent implementation as the oracle means a
 * mistake in the feeding logic cannot be masked by making the same mistake twice.
 */
const nodeStreamingCrypto = (): PureCryptoInterface => {
  const states = new Map<number, ReturnType<typeof createHash>>()
  let nextState = 1
  return {
    sha256StreamInit: (): StreamingHash => {
      const state = nextState++
      states.set(state, createHash('sha256'))
      return { state: state as unknown as StreamingHash['state'] }
    },
    sha256StreamUpdate: (hash: StreamingHash, bytes: Uint8Array): void => {
      const digest = states.get(hash.state as unknown as number)
      if (!digest) {
        throw new Error('digest state was released')
      }
      digest.update(Buffer.from(bytes))
    },
    sha256StreamFinal: (hash: StreamingHash): string => {
      const key = hash.state as unknown as number
      const digest = states.get(key)
      if (!digest) {
        throw new Error('digest state was released')
      }
      // Mirrors libsodium: finalizing consumes the state.
      states.delete(key)
      return digest.digest('hex')
    },
  } as unknown as PureCryptoInterface
}

const oneShot = (chunks: Uint8Array[]): string => {
  const digest = createHash('sha256')
  for (const chunk of chunks) {
    digest.update(Buffer.from(chunk))
  }
  return digest.digest('hex')
}

describe('EncryptedStreamDigest', () => {
  let crypto: PureCryptoInterface

  beforeEach(() => {
    crypto = nodeStreamingCrypto()
  })

  it('matches the NIST vector for "abc" fed as a single chunk', () => {
    const subject = new EncryptedStreamDigest(crypto)
    subject.update(Uint8Array.from([0x61, 0x62, 0x63]))

    expect(subject.final()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('matches the same NIST vector when the input is split across chunk boundaries', () => {
    const subject = new EncryptedStreamDigest(crypto)
    subject.update(Uint8Array.from([0x61]))
    subject.update(Uint8Array.from([0x62]))
    subject.update(Uint8Array.from([0x63]))

    expect(subject.final()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('is independent of how a stream is divided into chunks', () => {
    // The transport frames at 256 KiB and the encryptor emits its own sizes;
    // neither may influence the digest of the file.
    const source = Uint8Array.from({ length: 1000 }, (_, index) => (index * 7) % 256)
    const split = (size: number): Uint8Array[] => {
      const chunks: Uint8Array[] = []
      for (let offset = 0; offset < source.byteLength; offset += size) {
        chunks.push(source.subarray(offset, Math.min(offset + size, source.byteLength)))
      }
      return chunks
    }

    const digests = [1, 7, 64, 999, 1000].map((size) => {
      const subject = new EncryptedStreamDigest(crypto)
      for (const chunk of split(size)) {
        subject.update(chunk)
      }
      return subject.final()
    })

    expect(new Set(digests).size).toBe(1)
    expect(digests[0]).toBe(oneShot([source]))
  })

  it('digests the empty stream rather than refusing it', () => {
    const subject = new EncryptedStreamDigest(crypto)

    expect(subject.final()).toBe(oneShot([]))
    expect(subject.bytesHashed).toBe(0)
  })

  it('ignores an empty chunk without disturbing the digest or the byte count', () => {
    const subject = new EncryptedStreamDigest(crypto)
    subject.update(Uint8Array.from([1, 2, 3]))
    subject.update(new Uint8Array())
    subject.update(Uint8Array.from([4, 5]))

    expect(subject.final()).toBe(oneShot([Uint8Array.from([1, 2, 3, 4, 5])]))
    expect(subject.bytesHashed).toBe(5)
  })

  it('tracks the byte count so a transfer can prove it hashed exactly what it declared', () => {
    const subject = new EncryptedStreamDigest(crypto)
    subject.update(new Uint8Array(300))
    subject.update(new Uint8Array(212))

    expect(subject.bytesHashed).toBe(512)
  })

  it('is order-sensitive, so a chunk applied out of sequence cannot go unnoticed', () => {
    const inOrder = new EncryptedStreamDigest(crypto)
    inOrder.update(Uint8Array.from([1, 2]))
    inOrder.update(Uint8Array.from([3, 4]))

    const swapped = new EncryptedStreamDigest(crypto)
    swapped.update(Uint8Array.from([3, 4]))
    swapped.update(Uint8Array.from([1, 2]))

    expect(inOrder.final()).not.toBe(swapped.final())
  })

  it('refuses to accept data after finalizing', () => {
    const subject = new EncryptedStreamDigest(crypto)
    subject.update(Uint8Array.from([1]))
    subject.final()

    expect(() => subject.update(Uint8Array.from([2]))).toThrow(EncryptedStreamDigestError)
  })

  it('refuses to finalize twice rather than reading released state', () => {
    const subject = new EncryptedStreamDigest(crypto)
    subject.update(Uint8Array.from([1]))
    subject.final()

    // libsodium releases the state on final; a second call would read freed
    // memory, so this must fail here rather than return a plausible digest.
    expect(() => subject.final()).toThrow(EncryptedStreamDigestError)
  })
})

/**
 * The claim `FILES_UPLOAD_FINISH` rests on: an EncryptedStreamDigest fed chunk by
 * chunk produces the SAME 32 bytes as one-shot `crypto.subtle.digest('SHA-256', …)`
 * over the whole stream, for a stream far larger than any single chunk.
 *
 * Nothing here is skippable and nothing is shaped so that it could pass vacuously:
 * the oracle is proven to be a real SHA-256 before it is trusted, and every
 * comparison test declares its assertion count, so a comparison that silently did
 * not execute fails the test rather than reporting green.
 */
describe('EncryptedStreamDigest is byte-identical to one-shot WebCrypto', () => {
  /** 5,012,345 bytes: over five megabytes, and not a multiple of any chunk size used below. */
  const MultiMegabyteLength = 5_000_000 + 12_345

  const multiMegabyteStream = (): Uint8Array => {
    const bytes = new Uint8Array(MultiMegabyteLength)
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = (index * 31 + (index >>> 11)) & 0xff
    }
    return bytes
  }

  const feedInChunks = (source: Uint8Array, chunkSize: number): string => {
    const subject = new EncryptedStreamDigest(nodeStreamingCrypto())
    for (let offset = 0; offset < source.byteLength; offset += chunkSize) {
      subject.update(source.subarray(offset, Math.min(offset + chunkSize, source.byteLength)))
    }
    return subject.final()
  }

  it('uses an oracle that is genuinely SHA-256, so the comparisons below mean something', async () => {
    expect.assertions(3)

    expect(typeof subtle.digest).toBe('function')
    // NIST FIPS 180-4 vector for "abc". A stub oracle cannot produce this.
    expect(await oneShotSubtleDigest(Uint8Array.from([0x61, 0x62, 0x63]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await oneShotSubtleDigest(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches one-shot WebCrypto over a multi-megabyte stream fed as encryptor-sized chunks', async () => {
    expect.assertions(2)

    const source = multiMegabyteStream()
    const expected = await oneShotSubtleDigest(source)

    // FileService.minimumChunkSize() — services/src/Domain/Files/FileService.ts:150-152.
    expect(feedInChunks(source, 5_000_000)).toBe(expected)
    expect(source.byteLength).toBe(MultiMegabyteLength)
  })

  it('matches one-shot WebCrypto when the same stream is re-sliced into transport frames', async () => {
    expect.assertions(1)

    const source = multiMegabyteStream()

    // MAX_FILE_CHUNK_BYTES — websocket-gateway/src/filesProtocol.ts:5. The transport
    // re-slices the encrypted stream, and that must not move the digest.
    expect(feedInChunks(source, 256 * 1024)).toBe(await oneShotSubtleDigest(source))
  })

  it.each([1_048_576, 262_144, 65_537, 1_000, 7])(
    'matches one-shot WebCrypto over the multi-megabyte stream in %i-byte chunks',
    async (chunkSize) => {
      expect.assertions(1)

      const source = multiMegabyteStream()

      expect(feedInChunks(source, chunkSize)).toBe(await oneShotSubtleDigest(source))
    },
  )

  it('matches one-shot WebCrypto on a single chunk larger than any transport frame', async () => {
    expect.assertions(1)

    const source = multiMegabyteStream()

    expect(feedInChunks(source, MultiMegabyteLength)).toBe(await oneShotSubtleDigest(source))
  })

  it('matches one-shot WebCrypto on the empty stream', async () => {
    expect.assertions(1)

    const subject = new EncryptedStreamDigest(nodeStreamingCrypto())

    expect(subject.final()).toBe(await oneShotSubtleDigest(new Uint8Array()))
  })

  it('differs from one-shot WebCrypto when a single byte of the stream changes', async () => {
    expect.assertions(1)

    const source = multiMegabyteStream()
    const tampered = source.slice()
    tampered[MultiMegabyteLength - 1] ^= 0x01

    // Proves the comparison is sensitive to the content, not merely to the length.
    expect(feedInChunks(tampered, 65_537)).not.toBe(await oneShotSubtleDigest(source))
  })

  it('counts exactly the bytes it hashed, which is how the uploader checks declaredSize', () => {
    const subject = new EncryptedStreamDigest(nodeStreamingCrypto())
    const source = multiMegabyteStream()
    for (let offset = 0; offset < source.byteLength; offset += 262_144) {
      subject.update(source.subarray(offset, Math.min(offset + 262_144, source.byteLength)))
    }

    expect(subject.bytesHashed).toBe(MultiMegabyteLength)
  })
})
