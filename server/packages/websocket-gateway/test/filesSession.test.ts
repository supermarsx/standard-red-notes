import { describe, expect, it, vi } from 'vitest'

import type { SyncTicketIdentity } from '../src/auth.js'
import {
  MAX_FILE_BINARY_FRAME_BYTES,
  decodeFileBinaryFrame,
  encodeFileBinaryFrame,
  sha256Hex,
  type FileBinaryHeader,
  type FileResourceReference,
} from '../src/filesProtocol.js'
import jwt from 'jsonwebtoken'

import {
  createSyncFilesTokenDecoder,
  SyncFilesError,
  SyncFilesSession,
  type SyncFileDownloadChunk,
  type SyncFilesAdapter,
  type SyncFilesSessionOptions,
} from '../src/filesSession.js'
import type {
  JsonObject,
  SyncFilesCancelFrame,
  SyncFilesCreditFrame,
  SyncFilesDownloadOpenFrame,
  SyncFilesMetadataFrame,
  SyncFilesUploadFinishFrame,
  SyncFilesUploadOpenFrame,
  SyncServerFrameType,
} from '../src/syncProtocol.js'

const identity: SyncTicketIdentity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer server-only-session-token',
}

const resource: FileResourceReference = {
  ownershipType: 'shared-vault',
  remoteIdentifier: 'remote-1',
  fileUuid: 'file-1',
  sharedVaultUuid: 'vault-1',
  sharedVaultOwnerUuid: 'owner-1',
}

type ControlEmission = {
  type: SyncServerFrameType
  requestId: string
  commandId: string
  payload: JsonObject
}

function adapter(overrides: Partial<SyncFilesAdapter> = {}): SyncFilesAdapter {
  return {
    ready: vi.fn(() => true),
    metadata: vi.fn(async () => []),
    openUpload: vi.fn(async () => ({
      transferId: 'upload-1',
      generation: 1,
      resumeId: 'upload-resume-1',
      nextIndex: 0,
      nextOffset: 0,
      declaredSize: 3,
    })),
    uploadChunk: vi.fn(async () => ({
      duplicate: false,
      nextIndex: 1,
      nextOffset: 3,
      resumeId: 'upload-resume-1',
    })),
    finishUpload: vi.fn(async ({ sha256 }) => ({ sha256 })),
    openDownload: vi.fn(async () => ({
      transferId: 'download-1',
      generation: 4,
      resumeId: 'download-resume-1',
      declaredSize: 6,
      nextIndex: 0,
      nextOffset: 0,
    })),
    readDownloadChunk: vi.fn(async () => ({
      index: 0,
      offset: 0,
      declaredSize: 6,
      bytes: new Uint8Array([1, 2, 3]),
      final: false,
    })),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  }
}

function harness(
  filesAdapter = adapter(),
  sendBinaryResult = true,
): {
  filesAdapter: SyncFilesAdapter
  session: SyncFilesSession
  controls: ControlEmission[]
  binaries: Uint8Array[]
  errors: Array<{ requestId: string; commandId: string; code: string }>
  metrics: Array<{ event: string; code?: string }>
} {
  const controls: ControlEmission[] = []
  const binaries: Uint8Array[] = []
  const errors: Array<{ requestId: string; commandId: string; code: string }> = []
  const metrics: Array<{ event: string; code?: string }> = []
  const options: SyncFilesSessionOptions = {
    adapter: filesAdapter,
    sendControl: (type, requestId, commandId, payload) => {
      controls.push({ type, requestId, commandId, payload })
      return true
    },
    sendBinary: (bytes) => {
      binaries.push(bytes)
      return sendBinaryResult
    },
    sendError: (requestId, commandId, code) => {
      errors.push({ requestId, commandId, code })
      return true
    },
    metrics: {
      increment: (event, code) => metrics.push({ event, ...(code ? { code } : {}) }),
    },
  }
  return { filesAdapter, session: new SyncFilesSession(options), controls, binaries, errors, metrics }
}

function envelope<TType extends string, TPayload extends JsonObject>(type: TType, payload: TPayload) {
  return {
    version: 1 as const,
    channel: 'sync' as const,
    type,
    requestId: `request-${type.toLowerCase()}`,
    commandId: `command-${type.toLowerCase()}`,
    sequence: 1,
    payloadLength: 0,
    payload,
  }
}

function uploadFrame(bytes: Uint8Array, overrides: Partial<FileBinaryHeader> = {}): Uint8Array {
  return encodeFileBinaryFrame(
    {
      kind: 'UPLOAD_CHUNK',
      requestId: 'request-upload-chunk',
      transferId: 'upload-1',
      generation: 1,
      index: 0,
      offset: 0,
      declaredSize: bytes.byteLength,
      byteLength: bytes.byteLength,
      sha256: sha256Hex(bytes),
      final: true,
      ...overrides,
    },
    bytes,
  )
}

describe('SyncFilesSession', () => {
  it('forwards the authenticated identity for metadata and upload open/resume', async () => {
    const filesAdapter = adapter()
    const { session, controls } = harness(filesAdapter)
    const metadata = envelope('FILES_METADATA', {
      resources: [resource],
      deadlineMs: 1_000,
    }) satisfies SyncFilesMetadataFrame
    const open = envelope('FILES_UPLOAD_OPEN', {
      resource,
      decryptedSize: 2,
      declaredSize: 3,
      mimeType: 'application/octet-stream',
      deadlineMs: 1_000,
      resumeId: 'client-resume-1',
    }) satisfies SyncFilesUploadOpenFrame

    await session.handleControl(metadata, identity)
    await session.handleControl(open, identity)

    expect(filesAdapter.metadata).toHaveBeenCalledWith({ identity, resources: [resource] }, expect.any(AbortSignal))
    expect(filesAdapter.openUpload).toHaveBeenCalledWith(
      {
        identity,
        descriptor: {
          ...resource,
          decryptedSize: 2,
          declaredSize: 3,
          mimeType: 'application/octet-stream',
          resumeId: 'client-resume-1',
        },
      },
      expect.any(AbortSignal),
    )
    expect(controls.at(-1)).toMatchObject({
      type: 'FILES_ACCEPTED',
      payload: {
        mode: 'upload',
        transferId: 'upload-1',
        generation: 1,
        resumeId: 'upload-resume-1',
        nextIndex: 0,
        nextOffset: 0,
      },
    })
  })

  it('validates upload chunk integrity and ACKs duplicate chunks without losing identity', async () => {
    const filesAdapter = adapter({
      uploadChunk: vi.fn(async () => ({
        duplicate: true,
        nextIndex: 1,
        nextOffset: 3,
        resumeId: 'upload-resume-1',
      })),
    })
    const { session, controls, errors } = harness(filesAdapter)
    const raw = uploadFrame(new Uint8Array([7, 8, 9]))

    await session.handleBinary(raw, identity)

    expect(filesAdapter.uploadChunk).toHaveBeenCalledWith(
      {
        identity,
        header: expect.objectContaining({ transferId: 'upload-1', generation: 1, index: 0 }),
        bytes: expect.any(Uint8Array),
      },
      expect.any(AbortSignal),
    )
    expect(controls).toContainEqual({
      type: 'FILES_CHUNK_ACK',
      requestId: 'request-upload-chunk',
      commandId: 'upload-1',
      payload: {
        transferId: 'upload-1',
        generation: 1,
        index: 0,
        duplicate: true,
        nextIndex: 1,
        nextOffset: 3,
        resumeId: 'upload-resume-1',
      },
    })

    const corrupted = uploadFrame(new Uint8Array([7, 8, 9]))
    corrupted[corrupted.byteLength - 1] ^= 0xff
    await session.handleBinary(corrupted, identity)
    expect(errors.at(-1)?.code).toBe('FILE_FRAME_INTEGRITY')
    expect(filesAdapter.uploadChunk).toHaveBeenCalledTimes(1)
  })

  it('forwards and echoes the verified finish digest', async () => {
    const verifiedDigest = 'b'.repeat(64)
    const filesAdapter = adapter({ finishUpload: vi.fn(async () => ({ sha256: verifiedDigest })) })
    const { session, controls } = harness(filesAdapter)
    const frame = envelope('FILES_UPLOAD_FINISH', {
      transferId: 'upload-1',
      generation: 2,
      declaredSize: 99,
      sha256: 'a'.repeat(64),
      deadlineMs: 1_000,
    }) satisfies SyncFilesUploadFinishFrame

    await session.handleControl(frame, identity)

    expect(filesAdapter.finishUpload).toHaveBeenCalledWith(
      {
        identity,
        transferId: 'upload-1',
        generation: 2,
        declaredSize: 99,
        sha256: 'a'.repeat(64),
      },
      expect.any(AbortSignal),
    )
    expect(controls.at(-1)).toMatchObject({
      type: 'FILES_COMPLETE',
      payload: { mode: 'upload', transferId: 'upload-1', generation: 2, sha256: verifiedDigest },
    })
  })

  it('does not read beyond download credit and resumes pumping when more credit arrives', async () => {
    const chunks = [
      { index: 0, offset: 0, declaredSize: 6, bytes: new Uint8Array([1, 2, 3]), final: false },
      { index: 1, offset: 3, declaredSize: 6, bytes: new Uint8Array([4, 5, 6]), final: true },
    ]
    const filesAdapter = adapter({ readDownloadChunk: vi.fn(async () => chunks.shift()!) })
    const { session, controls, binaries } = harness(filesAdapter)
    const open = envelope('FILES_DOWNLOAD_OPEN', {
      resource,
      offset: 0,
      initialCreditBytes: 3,
      deadlineMs: 1_000,
    }) satisfies SyncFilesDownloadOpenFrame

    await session.handleControl(open, identity)
    await vi.waitFor(() => expect(binaries).toHaveLength(1))
    expect(filesAdapter.readDownloadChunk).toHaveBeenCalledTimes(1)
    expect(decodeFileBinaryFrame(binaries[0]!).bytes).toEqual(new Uint8Array([1, 2, 3]))

    const credit = envelope('FILES_CREDIT', {
      transferId: 'download-1',
      generation: 4,
      creditBytes: 3,
    }) satisfies SyncFilesCreditFrame
    await session.handleControl(credit, identity)

    await vi.waitFor(() => expect(binaries).toHaveLength(2))
    expect(filesAdapter.readDownloadChunk).toHaveBeenCalledTimes(2)
    expect(controls.at(-1)).toMatchObject({
      type: 'FILES_COMPLETE',
      payload: {
        mode: 'download',
        transferId: 'download-1',
        generation: 4,
        sha256: sha256Hex(new Uint8Array([1, 2, 3, 4, 5, 6])),
      },
    })
  })

  it('aborts a replaced download pump and fences stale emissions and map deletion by generation', async () => {
    type DownloadChunk = Awaited<ReturnType<SyncFilesAdapter['readDownloadChunk']>>
    let firstReadSignal: AbortSignal | undefined
    let markFirstReadStarted = (): void => undefined
    let resolveFirstRead = (_chunk: DownloadChunk): void => undefined
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve
    })
    const firstRead = new Promise<DownloadChunk>((resolve) => {
      resolveFirstRead = resolve
    })
    const filesAdapter = adapter({
      openDownload: vi
        .fn()
        .mockResolvedValueOnce({
          transferId: 'download-1',
          generation: 4,
          resumeId: 'download-resume-1',
          declaredSize: 3,
          nextIndex: 0,
          nextOffset: 0,
        })
        .mockResolvedValueOnce({
          transferId: 'download-1',
          generation: 5,
          resumeId: 'download-resume-1',
          declaredSize: 3,
          nextIndex: 0,
          nextOffset: 0,
        }),
      readDownloadChunk: vi
        .fn()
        .mockImplementationOnce((_input, signal) => {
          firstReadSignal = signal
          markFirstReadStarted()
          return firstRead
        })
        .mockResolvedValueOnce({
          index: 0,
          offset: 0,
          declaredSize: 3,
          bytes: new Uint8Array([4, 5, 6]),
          final: true,
        }),
    })
    const { session, controls, binaries, errors } = harness(filesAdapter)
    await session.handleControl(
      envelope('FILES_DOWNLOAD_OPEN', {
        resource,
        offset: 0,
        initialCreditBytes: 3,
        deadlineMs: 1_000,
      }) satisfies SyncFilesDownloadOpenFrame,
      identity,
    )
    await firstReadStarted

    await session.handleControl(
      envelope('FILES_DOWNLOAD_OPEN', {
        resource,
        offset: 0,
        initialCreditBytes: 0,
        deadlineMs: 1_000,
        resumeId: 'download-resume-1',
      }) satisfies SyncFilesDownloadOpenFrame,
      identity,
    )
    expect(firstReadSignal?.aborted).toBe(true)

    resolveFirstRead({
      index: 0,
      offset: 0,
      declaredSize: 3,
      bytes: new Uint8Array([1, 2, 3]),
      final: true,
    })
    await Promise.resolve()
    expect(binaries).toHaveLength(0)
    expect(errors).toHaveLength(0)

    await session.handleControl(
      envelope('FILES_CREDIT', {
        transferId: 'download-1',
        generation: 5,
        creditBytes: 3,
      }) satisfies SyncFilesCreditFrame,
      identity,
    )
    await vi.waitFor(() => expect(binaries).toHaveLength(1))
    expect(decodeFileBinaryFrame(binaries[0]!).header.generation).toBe(5)
    expect(controls.at(-1)).toMatchObject({
      type: 'FILES_COMPLETE',
      payload: { transferId: 'download-1', generation: 5 },
    })
    expect(errors).toHaveLength(0)
  })

  it('aborts and contains a backend read that exceeds its per-read deadline', async () => {
    vi.useFakeTimers()
    try {
      let readSignal: AbortSignal | undefined
      let markReadStarted = (): void => undefined
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve
      })
      const filesAdapter = adapter({
        readDownloadChunk: vi.fn((_input, signal) => {
          readSignal = signal
          markReadStarted()
          return new Promise<SyncFileDownloadChunk>(() => undefined)
        }),
      })
      const { session, errors } = harness(filesAdapter)
      await session.handleControl(
        envelope('FILES_DOWNLOAD_OPEN', {
          resource,
          offset: 0,
          initialCreditBytes: 3,
          deadlineMs: 1_000,
        }) satisfies SyncFilesDownloadOpenFrame,
        identity,
      )
      await readStarted

      await vi.advanceTimersByTimeAsync(1_000)

      expect(readSignal?.aborted).toBe(true)
      expect(errors.at(-1)?.code).toBe('FILE_DEADLINE_EXCEEDED')
      expect(filesAdapter.cancel).toHaveBeenCalledWith({
        identity,
        transferId: 'download-1',
        generation: 4,
        reason: 'download-failed',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels active transfers and fences stale generations', async () => {
    const filesAdapter = adapter()
    const { session, controls, errors } = harness(filesAdapter)
    await session.handleControl(
      envelope('FILES_DOWNLOAD_OPEN', {
        resource,
        offset: 0,
        initialCreditBytes: 0,
        deadlineMs: 1_000,
      }) satisfies SyncFilesDownloadOpenFrame,
      identity,
    )

    await session.handleControl(
      envelope('FILES_CREDIT', {
        transferId: 'download-1',
        generation: 3,
        creditBytes: 1,
      }) satisfies SyncFilesCreditFrame,
      identity,
    )
    expect(errors.at(-1)?.code).toBe('FILE_STALE_GENERATION')

    const cancel = envelope('FILES_CANCEL', { transferId: 'download-1', generation: 4 }) satisfies SyncFilesCancelFrame
    await session.handleControl(cancel, identity)

    expect(filesAdapter.cancel).toHaveBeenCalledWith({
      identity,
      transferId: 'download-1',
      generation: 4,
      reason: 'client-cancelled',
    })
    expect(controls.at(-1)).toMatchObject({ type: 'FILES_COMPLETE', payload: { mode: 'cancelled' } })
  })

  it('aborts in-flight download reads on disconnect and rejects later work', async () => {
    let readSignal: AbortSignal | undefined
    const filesAdapter = adapter({
      readDownloadChunk: vi.fn((_input, signal) => {
        readSignal = signal
        return new Promise<SyncFileDownloadChunk>(() => undefined)
      }),
    })
    const { session, errors } = harness(filesAdapter)
    await session.handleControl(
      envelope('FILES_DOWNLOAD_OPEN', {
        resource,
        offset: 0,
        initialCreditBytes: 3,
        deadlineMs: 1_000,
      }) satisfies SyncFilesDownloadOpenFrame,
      identity,
    )
    await vi.waitFor(() => expect(readSignal).toBeDefined())

    session.disconnect()

    expect(readSignal?.aborted).toBe(true)
    await session.handleControl(
      envelope('FILES_METADATA', { resources: [resource], deadlineMs: 1_000 }) satisfies SyncFilesMetadataFrame,
      identity,
    )
    expect(errors.at(-1)?.code).toBe('OPERATION_UNAVAILABLE')
  })

  it('contains backpressure, malformed binary, oversized binary, and backend failures', async () => {
    const filesAdapter = adapter({
      metadata: vi.fn(async () => {
        throw new SyncFilesError('FILE_ACCESS_DENIED', false)
      }),
    })
    const { session, errors } = harness(filesAdapter, false)
    await session.handleControl(
      envelope('FILES_METADATA', { resources: [resource], deadlineMs: 1_000 }) satisfies SyncFilesMetadataFrame,
      identity,
    )
    expect(errors.at(-1)?.code).toBe('FILE_ACCESS_DENIED')

    await session.handleBinary(new Uint8Array([1, 2, 3]), identity)
    expect(errors.at(-1)).toEqual({
      requestId: 'files-binary',
      commandId: 'files-binary',
      code: 'FILE_FRAME_MALFORMED',
    })
    await session.handleBinary(new Uint8Array(MAX_FILE_BINARY_FRAME_BYTES + 1), identity)
    expect(errors.at(-1)?.code).toBe('FILE_FRAME_TOO_LARGE')

    await session.handleControl(
      envelope('FILES_DOWNLOAD_OPEN', {
        resource,
        offset: 0,
        initialCreditBytes: 3,
        deadlineMs: 1_000,
      }) satisfies SyncFilesDownloadOpenFrame,
      identity,
    )
    await vi.waitFor(() => expect(errors.at(-1)?.code).toBe('FILE_BACKPRESSURE'))
    expect(filesAdapter.cancel).toHaveBeenCalledWith({
      identity,
      transferId: 'download-1',
      generation: 4,
      reason: 'download-failed',
    })
  })

  it('preserves only the bounded public error contract from the Home Server adapter', async () => {
    class HomeServerAdapterError extends Error {
      readonly name = 'HomeServerSyncFilesAdapterError'

      constructor(readonly code: string) {
        super(code)
      }
    }

    const filesAdapter = adapter({
      metadata: vi
        .fn()
        .mockRejectedValueOnce(new HomeServerAdapterError('FILE_ACCESS_DENIED'))
        // Standard Red Notes: "the session credential this socket presented can
        // no longer authenticate", distinct from FILE_ACCESS_DENIED, which stays
        // the answer to every policy denial AND to a revoked session.
        .mockRejectedValueOnce(new HomeServerAdapterError('SESSION_STALE'))
        .mockRejectedValueOnce(new HomeServerAdapterError('PRIVATE_STORAGE_PATH_LEAK')),
    })
    const { session, errors } = harness(filesAdapter)
    const metadata = envelope('FILES_METADATA', {
      resources: [resource],
      deadlineMs: 1_000,
    }) satisfies SyncFilesMetadataFrame

    await session.handleControl(metadata, identity)
    await session.handleControl(metadata, identity)
    await session.handleControl(metadata, identity)

    expect(errors.map(({ code }) => code)).toEqual(['FILE_ACCESS_DENIED', 'SESSION_STALE', 'FILE_BACKEND_ERROR'])
  })
})

/**
 * Finding 4: a download that ran out of credit went PERMANENTLY silent.
 *
 * Measured live before the fix, on both shipped topologies: a declared 5,000 ms
 * deadline watched for 40,000 ms produced no frames, no FILES_COMPLETE, no
 * ERROR and no close, having delivered 65,536 of 716,800 bytes, and the transfer
 * slot stayed held. After: the same probe is answered
 * `ERROR FILE_DEADLINE_EXCEEDED` at 5,081 ms (compose) and 5,029 ms (single
 * container).
 *
 * Driven here through the real timer wheel at a small deadline rather than a
 * socket harness, because this is a timing contract and the in-process socket
 * harness cannot hold the state a starved pump needs.
 */
describe('SyncFilesSession download deadline', () => {
  const declaredSize = 12
  const chunkBytes = 4

  /** Serves `chunkBytes` at a time out of a `declaredSize`-byte resource. */
  function creditedAdapter(overrides: Partial<SyncFilesAdapter> = {}): SyncFilesAdapter {
    return adapter({
      openDownload: vi.fn(async () => ({
        transferId: 'download-1',
        generation: 4,
        resumeId: 'download-resume-1',
        declaredSize,
        nextIndex: 0,
        nextOffset: 0,
      })),
      readDownloadChunk: vi.fn(async ({ index, offset, maxBytes }): Promise<SyncFileDownloadChunk> => {
        const byteLength = Math.min(maxBytes, declaredSize - offset)
        return {
          index,
          offset,
          declaredSize,
          bytes: new Uint8Array(byteLength).fill(index + 1),
          final: offset + byteLength === declaredSize,
        }
      }),
      ...overrides,
    })
  }

  const downloadFrame = (deadlineMs: number, initialCreditBytes: number) =>
    envelope('FILES_DOWNLOAD_OPEN', {
      resource,
      offset: 0,
      initialCreditBytes,
      deadlineMs,
    }) satisfies SyncFilesDownloadOpenFrame

  it('answers an under-credited download with FILE_DEADLINE_EXCEEDED instead of silence', async () => {
    const filesAdapter = creditedAdapter()
    const { session, errors, binaries } = harness(filesAdapter)

    await session.handleControl(downloadFrame(60, chunkBytes), identity)

    await vi.waitFor(() => expect(errors.at(-1)?.code).toBe('FILE_DEADLINE_EXCEEDED'), { timeout: 2_000 })
    // It delivered what it was credited for and then named its refusal, rather
    // than delivering that much and nothing else ever.
    expect(binaries).toHaveLength(1)
    expect(decodeFileBinaryFrame(binaries[0]!).bytes.byteLength).toBe(chunkBytes)
  })

  it('releases the transfer when the deadline fires, rather than holding the slot', async () => {
    const filesAdapter = creditedAdapter()
    const { session, errors } = harness(filesAdapter)

    await session.handleControl(downloadFrame(60, chunkBytes), identity)
    await vi.waitFor(() => expect(errors.at(-1)?.code).toBe('FILE_DEADLINE_EXCEEDED'), { timeout: 2_000 })

    expect(filesAdapter.cancel).toHaveBeenCalledWith({
      identity,
      transferId: 'download-1',
      generation: 4,
      reason: 'download-deadline-exceeded',
    })
    // The slot is gone, so late credit for it is a stale generation, not a resume
    // of a transfer the session still believes in.
    const credit = envelope('FILES_CREDIT', {
      transferId: 'download-1',
      generation: 4,
      creditBytes: chunkBytes,
    }) satisfies SyncFilesCreditFrame
    await session.handleControl(credit, identity)
    expect(errors.at(-1)?.code).toBe('FILE_STALE_GENERATION')
  })

  it('counts the refusal under its own code', async () => {
    const { session, errors, metrics } = harness(creditedAdapter())

    await session.handleControl(downloadFrame(60, chunkBytes), identity)
    await vi.waitFor(() => expect(errors.at(-1)?.code).toBe('FILE_DEADLINE_EXCEEDED'), { timeout: 2_000 })

    expect(metrics).toContainEqual({ event: 'files', code: 'file_deadline_exceeded' })
  })

  it('bounds SILENCE, not duration: credit that keeps arriving carries a transfer past its deadline', async () => {
    const filesAdapter = creditedAdapter()
    const { session, errors, controls, binaries } = harness(filesAdapter)
    const deadlineMs = 120

    await session.handleControl(downloadFrame(deadlineMs, chunkBytes), identity)

    // Grant the remaining headroom in two late instalments, each arriving after a
    // starvation gap. A whole-transfer deadline would have killed this; a
    // starvation deadline must not.
    for (let granted = 0; granted < 2; granted++) {
      await new Promise((resolve) => setTimeout(resolve, deadlineMs / 2))
      await session.handleControl(
        envelope('FILES_CREDIT', {
          transferId: 'download-1',
          generation: 4,
          creditBytes: chunkBytes,
        }) satisfies SyncFilesCreditFrame,
        identity,
      )
    }

    await vi.waitFor(() => expect(controls.some((control) => control.type === 'FILES_COMPLETE')).toBe(true), {
      timeout: 2_000,
    })
    expect(errors).toEqual([])
    expect(binaries).toHaveLength(declaredSize / chunkBytes)
    expect(Buffer.concat(binaries.map((frame) => Buffer.from(decodeFileBinaryFrame(frame).bytes))).byteLength).toBe(
      declaredSize,
    )
  })

  it('does not fire after the download has completed', async () => {
    const { session, errors, controls } = harness(creditedAdapter())

    await session.handleControl(downloadFrame(40, declaredSize), identity)

    await vi.waitFor(() => expect(controls.some((control) => control.type === 'FILES_COMPLETE')).toBe(true), {
      timeout: 2_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(errors).toEqual([])
  })

  it('does not fire after the socket has gone', async () => {
    const { session, errors } = harness(creditedAdapter())

    await session.handleControl(downloadFrame(40, chunkBytes), identity)
    session.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(errors).toEqual([])
  })
})

/**
 * Finding 1b: socket close released nothing adapter-side, so one account's
 * sixteen abandoned uploads answered FILE_TRANSFER_CAPACITY to every other
 * account for fifteen minutes. The session cannot release those itself -- it
 * tracks downloads only -- so it has to tell the adapter.
 */
describe('SyncFilesSession release on socket close', () => {
  it('tells the adapter which session is closing, even with no download open', async () => {
    const releaseSession = vi.fn(async () => undefined)
    const filesAdapter = adapter({ releaseSession })
    const { session } = harness(filesAdapter)

    await session.handleControl(
      envelope('FILES_UPLOAD_OPEN', {
        resource,
        decryptedSize: 2,
        declaredSize: 3,
        mimeType: 'application/octet-stream',
        deadlineMs: 1_000,
      }) satisfies SyncFilesUploadOpenFrame,
      identity,
    )
    session.disconnect()

    expect(releaseSession).toHaveBeenCalledTimes(1)
    expect(releaseSession).toHaveBeenCalledWith(identity)
  })

  it('releases for a socket that only ever sent an upload CHUNK', async () => {
    const releaseSession = vi.fn(async () => undefined)
    const { session } = harness(adapter({ releaseSession }))

    await session.handleBinary(uploadFrame(new Uint8Array([1, 2, 3])), identity)
    session.disconnect()

    expect(releaseSession).toHaveBeenCalledWith(identity)
  })

  it('releases exactly once, and never for a socket that never touched the lane', async () => {
    const releaseSession = vi.fn(async () => undefined)
    const { session } = harness(adapter({ releaseSession }))

    session.disconnect()
    session.disconnect()

    expect(releaseSession).not.toHaveBeenCalled()
  })

  it('survives an adapter whose release rejects', async () => {
    const releaseSession = vi.fn(async () => {
      throw new Error('release failed')
    })
    const { session } = harness(adapter({ releaseSession }))

    await session.handleBinary(uploadFrame(new Uint8Array([1, 2, 3])), identity)

    expect(() => session.disconnect()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})

describe('createSyncFilesTokenDecoder', () => {
  it('accepts an HS256 token signed with the same secret and rejects everything else', () => {
    const decoder = createSyncFilesTokenDecoder<{ userUuid: string }>('files-secret')
    const signed = jwt.sign({ userUuid: 'user-1' }, 'files-secret', { algorithm: 'HS256', expiresIn: '60s' })

    expect(decoder.decodeToken(signed)).toMatchObject({ userUuid: 'user-1' })
    expect(decoder.decodeToken(jwt.sign({ userUuid: 'user-1' }, 'other-secret'))).toBeUndefined()
    expect(decoder.decodeToken(jwt.sign({ userUuid: 'user-1' }, '', { algorithm: 'none' }))).toBeUndefined()
    expect(decoder.decodeToken(jwt.sign({ userUuid: 'user-1' }, 'files-secret', { expiresIn: -60 }))).toBeUndefined()
    expect(decoder.decodeToken('not-a-token')).toBeUndefined()
  })

  it('refuses to build a decoder without a signing secret', () => {
    expect(() => createSyncFilesTokenDecoder('')).toThrow(/signing secret/u)
  })
})
