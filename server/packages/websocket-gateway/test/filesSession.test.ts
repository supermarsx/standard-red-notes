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
        .mockRejectedValueOnce(new HomeServerAdapterError('PRIVATE_STORAGE_PATH_LEAK')),
    })
    const { session, errors } = harness(filesAdapter)
    const metadata = envelope('FILES_METADATA', {
      resources: [resource],
      deadlineMs: 1_000,
    }) satisfies SyncFilesMetadataFrame

    await session.handleControl(metadata, identity)
    await session.handleControl(metadata, identity)

    expect(errors.map(({ code }) => code)).toEqual(['FILE_ACCESS_DENIED', 'FILE_BACKEND_ERROR'])
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
