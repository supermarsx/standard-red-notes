import { createHash } from 'crypto'
import { PureCryptoInterface, StreamingHash } from '@standardnotes/sncrypto-common'

import { EncryptedStreamDigest, EncryptedStreamDigestError } from './EncryptedStreamDigest'

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
