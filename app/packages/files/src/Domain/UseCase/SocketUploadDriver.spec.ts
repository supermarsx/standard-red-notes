import { createHash } from 'crypto'
import { ClientDisplayableError } from '@standardnotes/responses'
import { PureCryptoInterface, StreamEncryptor, StreamingHash } from '@standardnotes/sncrypto-common'
import { VaultListingInterface } from '@standardnotes/models'

import {
  SocketFileUploadChunkOutcome,
  SocketFileUploadFinishOutcome,
  SocketFileUploadPosition,
  SocketFileUploadSession,
} from '../Api/FileSocketTransportInterface'
import { FilesApiInterface } from '../Api/FilesApiInterface'
import { EncryptedChunkOverheadBytes, planUploadSize } from '../Chunker/UploadSizePlan'
import { EncryptAndUploadFileOperation } from '../Operations/EncryptAndUpload'
import { EncryptedStreamDigest } from './EncryptedStreamDigest'
import { SocketUploadDriver, SocketUploadEncryptor } from './SocketUploadDriver'

const CHUNK_SIZE = 100
const FRAME_SIZE = 40

/**
 * Node's own SHA-256 standing in for libsodium's streaming hash, exactly as
 * `EncryptedStreamDigest.spec` does: the risk under test is this driver feeding
 * the hash the wrong bytes, and an independent implementation means the same
 * mistake cannot be made twice and cancel out.
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
      states.get(hash.state as unknown as number)?.update(Buffer.from(bytes))
    },
    sha256StreamFinal: (hash: StreamingHash): string => {
      const key = hash.state as unknown as number
      const digest = states.get(key) as ReturnType<typeof createHash>
      states.delete(key)
      return digest.digest('hex')
    },
  } as unknown as PureCryptoInterface
}

/**
 * Adds exactly `EncryptedChunkOverheadBytes` per push, which is the entirety of
 * what xchacha20-poly1305 secretstream adds and therefore the entirety of what
 * `plannedEncryptedSize` predicts. The tag byte records whether the push was
 * final, so a spec can prove the FINAL tag landed on the last planned chunk
 * rather than wherever the caller happened to say "last".
 */
const countingEncryptor = (): SocketUploadEncryptor & { pushes: Array<{ length: number; isFinalChunk: boolean }> } => {
  const pushes: Array<{ length: number; isFinalChunk: boolean }> = []
  return {
    pushes,
    pushBytes(decryptedBytes: Uint8Array, isFinalChunk: boolean): Uint8Array {
      pushes.push({ length: decryptedBytes.byteLength, isFinalChunk })
      const encrypted = new Uint8Array(decryptedBytes.byteLength + EncryptedChunkOverheadBytes)
      encrypted.set(decryptedBytes, 0)
      encrypted.fill(isFinalChunk ? 0xff : 0xaa, decryptedBytes.byteLength)
      return encrypted
    },
  }
}

type RecordedFrame = { index: number; offset: number; bytes: Uint8Array }

/**
 * A byte-accurate stand-in for the gateway's own upload bookkeeping: it stores by
 * offset, rejects a gap or an overlap, and verifies the digest at FINISH over
 * exactly the bytes it received. A driver that mis-slices, double-sends or hashes
 * the wrong stream fails here rather than passing on a loose assertion.
 */
const recordingSession = (
  declaredSize: number,
): SocketFileUploadSession & {
  frames: RecordedFrame[]
  stored: Uint8Array
  storedLength: number
  finished: Array<{ sha256: string; declaredSize: number }>
  cancels: number
  failChunkAt?: (frame: RecordedFrame) => SocketFileUploadChunkOutcome | undefined
  failFinish?: () => SocketFileUploadFinishOutcome | undefined
} => {
  const session = {
    frames: [] as RecordedFrame[],
    stored: new Uint8Array(declaredSize),
    storedLength: 0,
    finished: [] as Array<{ sha256: string; declaredSize: number }>,
    cancels: 0,
    failChunkAt: undefined as ((frame: RecordedFrame) => SocketFileUploadChunkOutcome | undefined) | undefined,
    failFinish: undefined as (() => SocketFileUploadFinishOutcome | undefined) | undefined,

    async sendChunk(chunk: {
      index: number
      offset: number
      bytes: Uint8Array
    }): Promise<SocketFileUploadChunkOutcome> {
      const frame = { index: chunk.index, offset: chunk.offset, bytes: Uint8Array.from(chunk.bytes) }
      const refusal = session.failChunkAt?.(frame)
      if (refusal) {
        return refusal
      }
      if (chunk.offset !== session.storedLength) {
        throw new Error(`frame at ${chunk.offset} but the server is at ${session.storedLength}`)
      }
      if (chunk.bytes.byteLength < 1) {
        throw new Error('the gateway refuses an empty binary frame')
      }
      session.frames.push(frame)
      session.stored.set(frame.bytes, chunk.offset)
      session.storedLength += chunk.bytes.byteLength
      return {
        outcome: 'acknowledged',
        transferId: 'transfer-1',
        generation: 1,
        index: chunk.index,
        duplicate: false,
        nextIndex: chunk.index + 1,
        nextOffset: session.storedLength,
        resumeId: 'resume-1',
      }
    },

    async finish(input: { declaredSize: number; sha256: string }): Promise<SocketFileUploadFinishOutcome> {
      const refusal = session.failFinish?.()
      if (refusal) {
        return refusal
      }
      const actual = createHash('sha256')
        .update(Buffer.from(session.stored.subarray(0, session.storedLength)))
        .digest('hex')
      if (actual !== input.sha256) {
        return { outcome: 'failed', code: 'FILE_INTEGRITY_MISMATCH', retryable: false, safeToFallback: false }
      }
      if (session.storedLength !== input.declaredSize) {
        return { outcome: 'failed', code: 'FILE_INCOMPLETE', retryable: false, safeToFallback: false }
      }
      session.finished.push({ sha256: input.sha256, declaredSize: input.declaredSize })
      return { outcome: 'completed', sha256: input.sha256 }
    },

    cancel(): void {
      session.cancels += 1
    },
  }
  return session
}

const position = (
  declaredSize: number,
  overrides: Partial<SocketFileUploadPosition> = {},
): SocketFileUploadPosition => ({
  transferId: 'transfer-1',
  generation: 1,
  resumeId: 'resume-1',
  nextIndex: 0,
  nextOffset: 0,
  declaredSize,
  maxFrameBytes: FRAME_SIZE,
  ...overrides,
})

const plaintext = (length: number): Uint8Array => Uint8Array.from({ length }, (_value, index) => (index * 31) % 251)

describe('SocketUploadDriver', () => {
  let encryptor: ReturnType<typeof countingEncryptor>
  let httpApi: jest.Mocked<FilesApiInterface>
  let httpCrypto: PureCryptoInterface
  let beginHttpFallback: jest.Mock

  const makeHttpOperation = () =>
    new EncryptAndUploadFileOperation(
      { key: 'secret', remoteIdentifier: 'remote-1', decryptedSize: 0 },
      'http-valet-token',
      httpCrypto,
      httpApi,
    )

  beforeEach(() => {
    encryptor = countingEncryptor()
    httpApi = { uploadFileBytes: jest.fn().mockResolvedValue(true) } as unknown as jest.Mocked<FilesApiInterface>
    httpCrypto = {
      xchacha20StreamInitEncryptor: jest.fn().mockReturnValue({ header: 'http-header', state: {} } as StreamEncryptor),
      xchacha20StreamEncryptorPush: jest.fn().mockReturnValue(new Uint8Array(1)),
    } as unknown as PureCryptoInterface
    beginHttpFallback = jest.fn(async () => makeHttpOperation())
  })

  const subject = (
    decryptedSize: number,
    session: SocketFileUploadSession,
    overrides: { position?: SocketFileUploadPosition } = {},
  ) => {
    const plan = planUploadSize(decryptedSize, CHUNK_SIZE)
    return new SocketUploadDriver({
      plan,
      file: { key: 'secret', remoteIdentifier: 'remote-1' },
      encryptionHeader: 'socket-header',
      encryptor,
      digest: new EncryptedStreamDigest(nodeStreamingCrypto()),
      session,
      position: overrides.position ?? position(plan.encryptedSize),
      beginHttpFallback,
    })
  }

  /** Feeds the whole file in `callerChunk`-sized pushes, the way a reader would. */
  const uploadWhole = async (driver: SocketUploadDriver, bytes: Uint8Array, callerChunk: number) => {
    const outcomes = []
    for (let offset = 0, index = 0; offset < Math.max(1, bytes.byteLength); offset += callerChunk, index += 1) {
      const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + callerChunk))
      outcomes.push(await driver.pushBytes(slice, index, offset + callerChunk >= bytes.byteLength))
    }
    return outcomes
  }

  describe('boundary sizes', () => {
    it.each([
      ['one byte', 1, 1],
      ['one byte under a chunk', CHUNK_SIZE - 1, 1],
      ['exactly one chunk', CHUNK_SIZE, 1],
      ['one byte over a chunk boundary', CHUNK_SIZE + 1, 2],
      ['an exact multiple of the chunk size', CHUNK_SIZE * 3, 3],
      ['several chunks and a remainder', CHUNK_SIZE * 2 + 7, 3],
    ])('uploads %s and the server verifies the digest', async (_label, size, expectedChunks) => {
      const bytes = plaintext(size)
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      const driver = subject(size, session)

      const outcomes = await uploadWhole(driver, bytes, 37)

      expect(outcomes[outcomes.length - 1]).toEqual({
        outcome: 'completed',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
      expect(plan.chunkCount).toBe(expectedChunks)
      expect(encryptor.pushes).toHaveLength(expectedChunks)
      expect(session.storedLength).toBe(plan.encryptedSize)
      expect(session.finished).toEqual([{ sha256: driver.completedSha256, declaredSize: plan.encryptedSize }])
      expect(driver.encryptedChunkSizes.reduce((total, each) => total + each, 0)).toBe(plan.encryptedSize)
      expect(driver.getResult()).toEqual({
        encryptionHeader: 'socket-header',
        finalDecryptedSize: size,
        key: 'secret',
        remoteIdentifier: 'remote-1',
      })
      expect(driver.getProgress().percentComplete).toBe(100)
    })
  })

  describe('the plan drives the encryptor, not the caller', () => {
    it.each([
      ['a reader that over-delivers, the way ByteChunker does', CHUNK_SIZE + 23],
      ['a reader whose sizes come from the browser', 7],
      ['a reader that hands over the whole file at once', CHUNK_SIZE * 10],
    ])('pushes exactly the planned chunk schedule despite %s', async (_label, callerChunk) => {
      const size = CHUNK_SIZE * 2 + 13
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      const driver = subject(size, session)

      await uploadWhole(driver, plaintext(size), callerChunk)

      expect(encryptor.pushes).toEqual([
        { length: CHUNK_SIZE, isFinalChunk: false },
        { length: CHUNK_SIZE, isFinalChunk: false },
        { length: 13, isFinalChunk: true },
      ])
      expect(session.storedLength).toBe(plan.encryptedSize)
    })

    it('never emits a frame larger than the transport allows, and spans one chunk over many frames', async () => {
      const size = CHUNK_SIZE * 2
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)

      await uploadWhole(subject(size, session), plaintext(size), size)

      expect(Math.max(...session.frames.map((frame) => frame.bytes.byteLength))).toBe(FRAME_SIZE)
      // Two 117-byte encrypted chunks, each cut into 40 + 40 + 37. A frame never
      // straddles a chunk boundary, so the short frame at 80 is expected.
      expect(session.frames).toHaveLength(6)
      expect(session.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3, 4, 5])
      expect(session.frames.map((frame) => frame.offset)).toEqual([0, 40, 80, 117, 157, 197])
      expect(session.frames.map((frame) => frame.bytes.byteLength)).toEqual([40, 40, 37, 40, 40, 37])
    })

    it('hands the server the exact encrypted bytes the digest covers', async () => {
      const size = CHUNK_SIZE + 5
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      const bytes = plaintext(size)

      const driver = subject(size, session)
      await uploadWhole(driver, bytes, 13)

      const assembled = Buffer.from(session.stored.subarray(0, session.storedLength))
      expect(createHash('sha256').update(assembled).digest('hex')).toBe(driver.completedSha256)
      // Chunk one is the plaintext head plus a non-final tag; chunk two the tail plus a FINAL tag.
      expect(assembled.subarray(0, CHUNK_SIZE)).toEqual(Buffer.from(bytes.subarray(0, CHUNK_SIZE)))
      expect(assembled[CHUNK_SIZE]).toBe(0xaa)
      expect(assembled[assembled.byteLength - 1]).toBe(0xff)
    })
  })

  describe('size plan disagreements', () => {
    it('refuses more plaintext than the open promised, before encrypting it', async () => {
      const session = recordingSession(planUploadSize(10, CHUNK_SIZE).encryptedSize)
      const driver = subject(10, session)

      await expect(driver.pushBytes(plaintext(11), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_PLAN_OVERRUN',
        safeToFallback: true,
      })
      expect(encryptor.pushes).toHaveLength(0)
      // A caller that broke its own size contract is not quietly re-routed.
      expect(beginHttpFallback).not.toHaveBeenCalled()
    })

    it('refuses a final chunk that leaves the declared size unmet', async () => {
      const session = recordingSession(planUploadSize(10, CHUNK_SIZE).encryptedSize)
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('no http either'))

      await expect(subject(10, session).pushBytes(plaintext(4), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_PLAN_UNDERRUN',
        safeToFallback: true,
      })
      expect(session.frames).toHaveLength(0)
    })

    it('surfaces a bad plan on the first chunk, before a single frame is sent', async () => {
      const size = CHUNK_SIZE * 3
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize + 8_192)
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('no http either'))
      // 400 encrypted bytes for the first of three 117-byte chunks. The transfer's
      // own check is an end-of-stream equality, so it would not notice until the
      // whole file had been encrypted and sent.
      encryptor.pushBytes = (decryptedBytes: Uint8Array) =>
        new Uint8Array(decryptedBytes.byteLength + EncryptedChunkOverheadBytes + 283)

      const outcome = await subject(size, session).pushBytes(plaintext(size), 0, true)

      expect(outcome).toEqual({ outcome: 'failed', code: 'FILE_PLAN_OVERRUN', safeToFallback: true })
      expect(session.frames).toHaveLength(0)
      expect(session.finished).toHaveLength(0)
    })

    it('stops a slow drift partway through rather than sending the whole file first', async () => {
      const size = CHUNK_SIZE * 3
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize + 8_192)
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('no http either'))
      encryptor.pushBytes = (decryptedBytes: Uint8Array) =>
        new Uint8Array(decryptedBytes.byteLength + EncryptedChunkOverheadBytes + 50)

      const outcome = await subject(size, session).pushBytes(plaintext(size), 0, true)

      expect(outcome).toEqual({ outcome: 'failed', code: 'FILE_PLAN_OVERRUN', safeToFallback: true })
      // Two 167-byte chunks were sent; the third took the running total past the
      // 351 bytes the server was promised, so it never left this process.
      expect(session.storedLength).toBe(334)
      expect(session.finished).toHaveLength(0)
    })
  })

  describe('falling back to HTTP', () => {
    it('restarts over HTTP, with a fresh encryptor, when the socket dies before the first ack', async () => {
      const size = CHUNK_SIZE + 5
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      session.failChunkAt = () => ({ outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true })
      const driver = subject(size, session)

      const first = await driver.pushBytes(plaintext(size), 0, true)

      expect(first).toEqual({ outcome: 'accepted' })
      expect(driver.transport).toBe('http')
      expect(beginHttpFallback).toHaveBeenCalledTimes(1)
      // Every byte handed over so far was replayed into the HTTP operation.
      expect(httpApi.uploadFileBytes).toHaveBeenCalledTimes(1)
      expect(driver.getResult().encryptionHeader).toBe('http-header')
      expect(driver.getValetToken()).toBe('http-valet-token')
      expect(session.cancels).toBeGreaterThan(0)
    })

    it('keeps delegating to HTTP for every later chunk once it has fallen back', async () => {
      const size = CHUNK_SIZE * 2
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failChunkAt = () => ({ outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true })
      const driver = subject(size, session)
      const bytes = plaintext(size)

      await driver.pushBytes(bytes.subarray(0, CHUNK_SIZE), 0, false)
      await driver.pushBytes(bytes.subarray(CHUNK_SIZE), 1, true)

      expect(driver.transport).toBe('http')
      expect(httpApi.uploadFileBytes).toHaveBeenCalledTimes(2)
      expect(driver.encryptedChunkSizes).toHaveLength(2)
      expect(session.frames).toHaveLength(0)
    })

    it('refuses to restart once the server has acknowledged a byte, because the plaintext is gone', async () => {
      const size = CHUNK_SIZE * 2
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failChunkAt = (frame) =>
        frame.offset === 0
          ? undefined
          : { outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true }
      const driver = subject(size, session)

      const outcome = await driver.pushBytes(plaintext(size), 0, true)

      expect(outcome).toEqual({ outcome: 'failed', code: 'SOCKET_CLOSED', safeToFallback: true })
      expect(driver.transport).toBe('socket')
      expect(beginHttpFallback).not.toHaveBeenCalled()
    })

    it('refuses to restart after FINISH was attempted, because the file may already be published', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failFinish = () => ({ outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true })
      const driver = subject(size, session)

      const outcome = await driver.pushBytes(plaintext(size), 0, true)

      expect(outcome).toEqual({ outcome: 'failed', code: 'SOCKET_CLOSED', safeToFallback: false })
      expect(beginHttpFallback).not.toHaveBeenCalled()
    })

    it('reports the failure when HTTP cannot be started either', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failChunkAt = () => ({
        outcome: 'failed',
        code: 'OPERATION_UNAVAILABLE',
        retryable: true,
        safeToFallback: true,
      })
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('valet token refused'))

      await expect(subject(size, session).pushBytes(plaintext(size), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'OPERATION_UNAVAILABLE',
        safeToFallback: true,
      })
    })

    it('reports a rejected HTTP chunk during the replay rather than claiming success', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failChunkAt = () => ({ outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true })
      httpApi.uploadFileBytes = jest.fn().mockResolvedValue(false)

      await expect(subject(size, session).pushBytes(plaintext(size), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_HTTP_CHUNK_REJECTED',
        safeToFallback: false,
      })
    })

    it('never rescues a cancellation onto HTTP', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failChunkAt = () => ({ outcome: 'aborted' })

      await expect(subject(size, session).pushBytes(plaintext(size), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_CANCELLED',
        safeToFallback: true,
      })
      expect(beginHttpFallback).not.toHaveBeenCalled()
    })

    it('never rescues a cancelled FINISH onto HTTP', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failFinish = () => ({ outcome: 'aborted' })

      await expect(subject(size, session).pushBytes(plaintext(size), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_CANCELLED',
        safeToFallback: false,
      })
      expect(beginHttpFallback).not.toHaveBeenCalled()
    })
  })

  describe('resume is refused rather than attempted', () => {
    it('leaves an open that lands anywhere but byte zero, since this client cannot re-encrypt', async () => {
      const size = 10
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)

      const driver = subject(size, session, {
        position: position(plan.encryptedSize, { nextOffset: 9, nextIndex: 1 }),
      })
      const outcome = await driver.pushBytes(plaintext(size), 0, true)

      expect(outcome).toEqual({ outcome: 'accepted' })
      expect(driver.transport).toBe('http')
      expect(session.frames).toHaveLength(0)
    })

    it('refuses to take an empty file onto the lane at all', async () => {
      const session = recordingSession(17)
      const driver = subject(0, session)

      await expect(driver.pushBytes(new Uint8Array(0), 0, true)).resolves.toEqual({ outcome: 'accepted' })

      expect(driver.transport).toBe('http')
      expect(session.frames).toHaveLength(0)
    })

    it('refuses an open whose transport cannot carry a single byte per frame', async () => {
      const size = 10
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('no http either'))

      const outcome = await subject(size, session, {
        position: position(plan.encryptedSize, { maxFrameBytes: 0 }),
      }).pushBytes(plaintext(size), 0, true)

      expect(outcome).toEqual({ outcome: 'failed', code: 'FILE_RESUME_UNSUPPORTED', safeToFallback: true })
    })

    it('abandons rather than re-opens when a retryable failure arrives after bytes were stored', async () => {
      const size = CHUNK_SIZE * 2
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failChunkAt = (frame) =>
        frame.offset < 80
          ? undefined
          : { outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true }

      const driver = subject(size, session)
      const outcome = await driver.pushBytes(plaintext(size), 0, true)

      expect(outcome).toEqual({ outcome: 'failed', code: 'SOCKET_CLOSED', safeToFallback: true })
      expect(session.finished).toHaveLength(0)
    })
  })

  describe('bookkeeping', () => {
    it('reports progress from what the server acknowledged, not from what was handed over', async () => {
      const size = CHUNK_SIZE * 2
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      const stopAfter = 3
      session.failChunkAt = () =>
        session.frames.length >= stopAfter
          ? { outcome: 'failed', code: 'HALT', retryable: false, safeToFallback: false }
          : undefined
      const driver = subject(size, session)

      await driver.pushBytes(plaintext(size), 0, true)

      // Three 40-byte frames acknowledged: 120 bytes, which is past the end of the
      // first 117-byte encrypted chunk, so exactly one chunk's plaintext is done.
      expect(driver.getProgress()).toEqual({
        decryptedFileSize: size,
        decryptedBytesUploaded: CHUNK_SIZE,
        decryptedBytesRemaining: CHUNK_SIZE,
        percentComplete: 50,
      })
    })

    it('takes an empty push in its stride, as a reader flushing nothing does', async () => {
      const size = CHUNK_SIZE + 5
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      const driver = subject(size, session)
      const bytes = plaintext(size)

      await driver.pushBytes(bytes.subarray(0, CHUNK_SIZE), 0, false)
      await driver.pushBytes(new Uint8Array(0), 1, false)
      const last = await driver.pushBytes(bytes.subarray(CHUNK_SIZE), 2, true)

      expect(last).toEqual({ outcome: 'completed', sha256: driver.completedSha256 })
      expect(encryptor.pushes).toHaveLength(2)
    })

    it('answers every later push with the verdict it already reached', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      const driver = subject(size, session)

      const completed = await driver.pushBytes(plaintext(size), 0, true)
      const again = await driver.pushBytes(plaintext(1), 1, true)

      expect(again).toBe(completed)
      expect(encryptor.pushes).toHaveLength(1)
    })

    it('cancels an unfinished transfer and leaves a finished one alone', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      const driver = subject(size, session)

      driver.cancel()
      expect(session.cancels).toBe(1)

      await driver.pushBytes(plaintext(size), 0, true)
      driver.cancel()
      expect(session.cancels).toBe(1)
    })

    it('reports HTTP progress, vault and result once it has fallen back', async () => {
      const size = 10
      const session = recordingSession(planUploadSize(size, CHUNK_SIZE).encryptedSize)
      session.failChunkAt = () => ({ outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true })
      const vault = { isSharedVaultListing: () => false } as unknown as VaultListingInterface
      beginHttpFallback.mockImplementation(
        async () =>
          new EncryptAndUploadFileOperation(
            { key: 'secret', remoteIdentifier: 'remote-1', decryptedSize: size },
            'http-valet-token',
            httpCrypto,
            httpApi,
            vault,
          ),
      )
      const driver = subject(size, session)

      await driver.pushBytes(plaintext(size), 0, true)

      expect(driver.transport).toBe('http')
      expect(driver.vault).toBe(vault)
      expect(driver.getProgress()).toEqual({
        decryptedFileSize: size,
        decryptedBytesUploaded: size,
        decryptedBytesRemaining: 0,
        percentComplete: 100,
      })
      expect(driver.getResult().encryptionHeader).toBe('http-header')
      expect(driver.completedSha256).toBeUndefined()
    })

    it('refuses an acknowledgement that does not clear the frame it just sent', async () => {
      const size = CHUNK_SIZE
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('no http either'))
      // Legal-looking and monotonic, but it leaves the stream exactly where it
      // was. Followed, this would re-send the same frame for ever.
      session.failChunkAt = (frame) =>
        frame.offset === 0
          ? {
              outcome: 'acknowledged',
              transferId: 'transfer-1',
              generation: 1,
              index: 0,
              duplicate: false,
              nextIndex: 1,
              nextOffset: 0,
              resumeId: 'resume-1',
            }
          : undefined

      await expect(subject(size, session).pushBytes(plaintext(size), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_INVALID_STATE',
        safeToFallback: true,
      })
    })

    it('refuses an acknowledgement claiming bytes this client never produced', async () => {
      const size = CHUNK_SIZE * 2
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('no http either'))
      // Only the first 117-byte chunk has been encrypted, so a server claiming
      // all 234 bytes has lost track of which transfer it is answering.
      session.failChunkAt = () => ({
        outcome: 'acknowledged',
        transferId: 'transfer-1',
        generation: 1,
        index: 0,
        duplicate: false,
        nextIndex: 1,
        nextOffset: plan.encryptedSize,
        resumeId: 'resume-1',
      })

      await expect(subject(size, session).pushBytes(plaintext(size), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_INVALID_STATE',
        safeToFallback: true,
      })
    })

    it('stands by the transfer when it refuses an acknowledgement outright', async () => {
      const size = CHUNK_SIZE * 2
      const plan = planUploadSize(size, CHUNK_SIZE)
      const session = recordingSession(plan.encryptedSize)
      beginHttpFallback.mockResolvedValue(new ClientDisplayableError('no http either'))
      // A second ack that rewinds inside one generation: SocketUploadTransfer
      // abandons on it, and this driver must adopt that verdict rather than
      // reading a position that no longer exists.
      session.failChunkAt = (frame) =>
        frame.offset === 40
          ? {
              outcome: 'acknowledged',
              transferId: 'transfer-1',
              generation: 1,
              index: 1,
              duplicate: false,
              nextIndex: 2,
              nextOffset: 10,
              resumeId: 'resume-1',
            }
          : undefined

      await expect(subject(size, session).pushBytes(plaintext(size), 0, true)).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_INVALID_STATE',
        safeToFallback: true,
      })
    })

    it('exposes no valet token while the socket carries the upload', () => {
      const driver = subject(10, recordingSession(planUploadSize(10, CHUNK_SIZE).encryptedSize))

      expect(driver.getValetToken()).toBeUndefined()
      expect(driver.vault).toBeUndefined()
      expect(driver.completedSha256).toBeUndefined()
    })
  })
})
