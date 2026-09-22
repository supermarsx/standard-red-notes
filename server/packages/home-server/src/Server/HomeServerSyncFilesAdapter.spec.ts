import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A swap-in-and-out `randomBytes` override, used by exactly one test below to
// deterministically force the base64url leading-character edge case. Every
// other caller (createHash above, randomUUID transfer ids, randomBytes(8)
// manifest temp-file suffixes) must keep hitting the REAL implementation, so
// the mock factory defaults `mockRandomBytesOverride` to undefined and falls
// through to the actual module in that case.
let mockRandomBytesOverride: ((size: number) => Buffer | undefined) | undefined
jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto') as typeof import('node:crypto')
  return {
    ...actual,
    randomBytes: (...args: Parameters<typeof actual.randomBytes>) => {
      const size = args[0] as number
      if (mockRandomBytesOverride) {
        const overridden = mockRandomBytesOverride(size)
        if (overridden !== undefined) {
          return overridden
        }
      }
      return (actual.randomBytes as (...a: typeof args) => Buffer)(...args)
    },
  }
})

import {
  encodeFileBinaryFrame,
  decodeFileBinaryFrame,
  SyncFilesSession,
  type SyncFilesControlFrame,
  type SyncTicketIdentity,
} from '@standard-red-notes/websocket-gateway'

import {
  HomeServerSyncFilesAdapter,
  HomeServerSyncFilesAdapterError,
  type HomeServerFileResourceAuthorizer,
} from './HomeServerSyncFilesAdapter'

const identity: SyncTicketIdentity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'must-not-be-persisted',
}
const resource = { ownershipType: 'user' as const, remoteIdentifier: 'remote-1', fileUuid: 'file-1' }
const descriptor = {
  ...resource,
  decryptedSize: 5,
  declaredSize: 5,
  mimeType: 'application/octet-stream',
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function authorizer(allow = true): HomeServerFileResourceAuthorizer {
  return {
    authorize: jest.fn(async ({ identity: requestIdentity, resource: requestedResource }) => {
      if (!allow) {
        return undefined
      }
      return {
        storageOwnerUuid:
          requestedResource.ownershipType === 'user'
            ? requestIdentity.userUuid
            : (requestedResource.sharedVaultUuid as string),
      }
    }),
  }
}

describe('HomeServerSyncFilesAdapter', () => {
  const roots: string[] = []

  async function createAdapter(
    options: {
      root?: string
      authorize?: HomeServerFileResourceAuthorizer
      maxActiveTransfers?: number
      now?: () => number
    } = {},
  ) {
    const root = options.root ?? (await fs.mkdtemp(join(tmpdir(), 'srn-files-v1-')))
    if (!options.root) {
      roots.push(root)
    }
    let counter = 0
    const adapter = new HomeServerSyncFilesAdapter({
      storageRoot: root,
      authorizer: options.authorize ?? authorizer(),
      maxActiveTransfers: options.maxActiveTransfers,
      now: options.now,
      createTransferId: () => `transfer-${++counter}`,
      createResumeId: () => `resume-${counter}`,
    })
    await adapter.initialize()
    return { adapter, root }
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  /**
   * The default `createResumeId` (no injected override -- every other test in
   * this file injects one, see `createAdapter` above) encodes
   * `randomBytes(24)` as base64url. That alphabet has 64 symbols including
   * `-` and `_`, so the first character lands on one of those two roughly
   * 2/64 = 3.1% of the time. `validGeneratedIdentifier` requires an
   * alphanumeric first character (mirroring `IDENTIFIER_PATTERN`), so an
   * unguarded generator throws on about 1 upload-open in 32.
   *
   * This does NOT run the generator many times and hope randomness cooperates
   * -- that would only fail ~99.97% of the time on the bug, not
   * deterministically, and the team explicitly rejected a flaky test here.
   * Instead it forges the exact byte pattern whose base64url encoding starts
   * with `-`, and controls `randomBytes` to hand that out first: the buggy
   * generator returns/throws on that draw every single run; the fixed
   * generator must discard it and try again.
   */
  describe('default createResumeId (base64url leading-character bug)', () => {
    it('discards a base64url draw that starts with "-" or "_" instead of returning it', async () => {
      // Byte 0 = 0xf8 = 0b11111000: base64 packs the first output character
      // from the top 6 bits of byte 0, i.e. 111110 = 62 = '-' in the base64url
      // alphabet, regardless of the remaining bytes. This is deterministic,
      // not a random sample that happens to collide.
      const forgedLeadingHyphen = Buffer.alloc(24, 0)
      forgedLeadingHyphen[0] = 0xf8
      expect(forgedLeadingHyphen.toString('base64url')[0]).toBe('-')

      // A second, ordinary draw so the retry has something valid to land on.
      const ordinaryDraw = Buffer.alloc(24, 0)
      expect(ordinaryDraw.toString('base64url')[0]).toBe('A')

      let resumeIdDraws = 0
      mockRandomBytesOverride = (size) => {
        // Every OTHER randomBytes caller in the adapter (manifest temp-file
        // suffixes are randomBytes(8)) must keep behaving normally -- only
        // the 24-byte resume-id draw is forged. Returning undefined falls
        // through to the real implementation (see the jest.mock factory).
        if (size !== 24) {
          return undefined
        }
        resumeIdDraws += 1
        return resumeIdDraws === 1 ? forgedLeadingHyphen : ordinaryDraw
      }

      try {
        const root = await fs.mkdtemp(join(tmpdir(), 'srn-files-v1-'))
        roots.push(root)
        // createResumeId intentionally NOT overridden: this exercises the
        // real production default, not a test double.
        const adapter = new HomeServerSyncFilesAdapter({ storageRoot: root, authorizer: authorizer() })
        await adapter.initialize()

        const opened = await adapter.openUpload({ identity, descriptor }, new AbortController().signal)

        // Proves the rejected '-…' draw was discarded, not thrown or returned:
        // the accepted id is the SECOND draw's encoding.
        expect(resumeIdDraws).toBe(2)
        expect(opened.resumeId[0]).not.toBe('-')
        expect(opened.resumeId[0]).not.toBe('_')
        expect(opened.resumeId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
      } finally {
        mockRandomBytesOverride = undefined
      }
    })

    it('the id-validity rule itself rejects a leading "-" or "_" (why the undiscarded draw used to throw)', () => {
      const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
      expect(identifierPattern.test('-abc123def456')).toBe(false)
      expect(identifierPattern.test('_abc123def456')).toBe(false)
      // Non-leading '-'/'_' are fine; only the first character is constrained.
      expect(identifierPattern.test('a-bc123def456')).toBe(true)
    })
  })

  it('streams an upload to private staging, deduplicates retries, publishes atomically, and downloads it', async () => {
    const { adapter } = await createAdapter()
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    const opened = await adapter.openUpload({ identity, descriptor }, new AbortController().signal)
    const header = {
      kind: 'UPLOAD_CHUNK' as const,
      requestId: 'request-1',
      transferId: opened.transferId,
      generation: opened.generation,
      index: 0,
      offset: 0,
      declaredSize: bytes.byteLength,
      byteLength: bytes.byteLength,
      sha256: digest(bytes),
      final: true,
    }

    await expect(adapter.uploadChunk({ identity, header, bytes }, new AbortController().signal)).resolves.toMatchObject(
      {
        duplicate: false,
        nextIndex: 1,
        nextOffset: 5,
      },
    )
    await expect(adapter.uploadChunk({ identity, header, bytes }, new AbortController().signal)).resolves.toMatchObject(
      {
        duplicate: true,
        nextIndex: 1,
        nextOffset: 5,
      },
    )
    await expect(
      adapter.finishUpload(
        {
          identity,
          transferId: opened.transferId,
          generation: opened.generation,
          declaredSize: 5,
          sha256: digest(bytes),
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ sha256: digest(bytes) })

    await expect(adapter.metadata({ identity, resources: [resource] }, new AbortController().signal)).resolves.toEqual([
      { resource, exists: true, encryptedSize: 5 },
    ])
    const download = await adapter.openDownload({ identity, resource, offset: 0 }, new AbortController().signal)
    await expect(
      adapter.readDownloadChunk(
        {
          identity,
          transferId: download.transferId,
          generation: download.generation,
          index: 0,
          offset: 0,
          maxBytes: 3,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ bytes: Uint8Array.from([1, 2, 3]), final: false })
    await expect(
      adapter.readDownloadChunk(
        {
          identity,
          transferId: download.transferId,
          generation: download.generation,
          index: 1,
          offset: 3,
          maxBytes: 3,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ bytes: Uint8Array.from([4, 5]), final: true })
  })

  it('persists resumable upload state without persisting the bearer credential and fences stale generations', async () => {
    const first = await createAdapter()
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    const opened = await first.adapter.openUpload({ identity, descriptor }, new AbortController().signal)
    const firstChunk = bytes.subarray(0, 2)
    await first.adapter.uploadChunk(
      {
        identity,
        header: {
          kind: 'UPLOAD_CHUNK',
          requestId: 'request-1',
          transferId: opened.transferId,
          generation: opened.generation,
          index: 0,
          offset: 0,
          declaredSize: 5,
          byteLength: 2,
          sha256: digest(firstChunk),
          final: false,
        },
        bytes: firstChunk,
      },
      new AbortController().signal,
    )
    const manifest = await fs.readFile(join(first.root, '.sync-files-v1', `${opened.resumeId}.json`), 'utf8')
    expect(manifest).not.toContain(identity.authorization)

    const second = await createAdapter({ root: first.root })
    const resumed = await second.adapter.openUpload(
      { identity, descriptor: { ...descriptor, resumeId: opened.resumeId } },
      new AbortController().signal,
    )
    expect(resumed).toMatchObject({
      transferId: opened.transferId,
      generation: 2,
      nextIndex: 1,
      nextOffset: 2,
    })
    await expect(
      second.adapter.uploadChunk(
        {
          identity,
          header: {
            kind: 'UPLOAD_CHUNK',
            requestId: 'request-stale',
            transferId: opened.transferId,
            generation: 1,
            index: 1,
            offset: 2,
            declaredSize: 5,
            byteLength: 3,
            sha256: digest(bytes.subarray(2)),
            final: true,
          },
          bytes: bytes.subarray(2),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_STALE_GENERATION' })
  })

  it('serializes an active chunk with a concurrent resume before advancing the generation', async () => {
    let authorizationCalls = 0
    let releaseChunkAuthorization = (): void => undefined
    let markChunkAuthorizationStarted = (): void => undefined
    const chunkAuthorizationGate = new Promise<void>((resolve) => {
      releaseChunkAuthorization = resolve
    })
    const chunkAuthorizationStarted = new Promise<void>((resolve) => {
      markChunkAuthorizationStarted = resolve
    })
    const concurrentAuthorizer: HomeServerFileResourceAuthorizer = {
      authorize: jest.fn(async ({ identity: requestIdentity }) => {
        authorizationCalls += 1
        if (authorizationCalls === 2) {
          markChunkAuthorizationStarted()
          await chunkAuthorizationGate
        }
        return { storageOwnerUuid: requestIdentity.userUuid }
      }),
    }
    const { adapter } = await createAdapter({ authorize: concurrentAuthorizer })
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    const opened = await adapter.openUpload({ identity, descriptor }, new AbortController().signal)
    const chunk = adapter.uploadChunk(
      {
        identity,
        header: {
          kind: 'UPLOAD_CHUNK',
          requestId: 'request-concurrent',
          transferId: opened.transferId,
          generation: opened.generation,
          index: 0,
          offset: 0,
          declaredSize: bytes.byteLength,
          byteLength: bytes.byteLength,
          sha256: digest(bytes),
          final: true,
        },
        bytes,
      },
      new AbortController().signal,
    )
    await chunkAuthorizationStarted

    const resume = adapter.openUpload(
      { identity, descriptor: { ...descriptor, resumeId: opened.resumeId } },
      new AbortController().signal,
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(concurrentAuthorizer.authorize).toHaveBeenCalledTimes(2)

    releaseChunkAuthorization()
    await expect(chunk).resolves.toMatchObject({ duplicate: false, nextIndex: 1, nextOffset: 5 })
    await expect(resume).resolves.toMatchObject({ generation: 2, nextIndex: 1, nextOffset: 5 })
    expect(concurrentAuthorizer.authorize).toHaveBeenCalledTimes(3)

    await expect(
      adapter.uploadChunk(
        {
          identity,
          header: {
            kind: 'UPLOAD_CHUNK',
            requestId: 'request-stale-after-resume',
            transferId: opened.transferId,
            generation: opened.generation,
            index: 0,
            offset: 0,
            declaredSize: bytes.byteLength,
            byteLength: bytes.byteLength,
            sha256: digest(bytes),
            final: true,
          },
          bytes,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_STALE_GENERATION' })
  })

  it('retains bounded upload completion replay without consuming active transfer capacity', async () => {
    const { adapter } = await createAdapter({ maxActiveTransfers: 1 })
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    const opened = await adapter.openUpload({ identity, descriptor }, new AbortController().signal)
    await adapter.uploadChunk(
      {
        identity,
        header: {
          kind: 'UPLOAD_CHUNK',
          requestId: 'request-complete',
          transferId: opened.transferId,
          generation: opened.generation,
          index: 0,
          offset: 0,
          declaredSize: bytes.byteLength,
          byteLength: bytes.byteLength,
          sha256: digest(bytes),
          final: true,
        },
        bytes,
      },
      new AbortController().signal,
    )
    const finish = {
      identity,
      transferId: opened.transferId,
      generation: opened.generation,
      declaredSize: bytes.byteLength,
      sha256: digest(bytes),
    }
    await expect(adapter.finishUpload(finish, new AbortController().signal)).resolves.toEqual({
      sha256: digest(bytes),
    })
    await expect(adapter.finishUpload(finish, new AbortController().signal)).resolves.toEqual({
      sha256: digest(bytes),
    })

    const next = await adapter.openUpload(
      {
        identity,
        descriptor: { ...descriptor, remoteIdentifier: 'remote-2', fileUuid: 'file-2' },
      },
      new AbortController().signal,
    )
    await adapter.cancel({ identity, transferId: next.transferId, generation: next.generation, reason: 'test' })
  })

  it('releases successful final downloads from active transfer capacity', async () => {
    const { adapter, root } = await createAdapter({ maxActiveTransfers: 1 })
    await fs.mkdir(join(root, identity.userUuid), { recursive: true })
    await fs.writeFile(join(root, identity.userUuid, resource.remoteIdentifier), Uint8Array.from([1, 2, 3]))
    const download = await adapter.openDownload({ identity, resource, offset: 0 }, new AbortController().signal)
    await expect(
      adapter.readDownloadChunk(
        {
          identity,
          transferId: download.transferId,
          generation: download.generation,
          index: 0,
          offset: 0,
          maxBytes: 3,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ final: true, bytes: Uint8Array.from([1, 2, 3]) })

    const opened = await adapter.openUpload(
      {
        identity,
        descriptor: { ...descriptor, remoteIdentifier: 'remote-after-download', fileUuid: 'file-after-download' },
      },
      new AbortController().signal,
    )
    await adapter.cancel({ identity, transferId: opened.transferId, generation: opened.generation, reason: 'test' })
  })

  it('allocates concurrent upload and download opens against one atomic global capacity slot', async () => {
    let authorizationCalls = 0
    let releaseAuthorizations = (): void => undefined
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorizations = resolve
    })
    const concurrentAuthorizer: HomeServerFileResourceAuthorizer = {
      authorize: jest.fn(async ({ identity: requestIdentity }) => {
        authorizationCalls += 1
        if (authorizationCalls === 2) {
          releaseAuthorizations()
        }
        await authorizationGate
        return { storageOwnerUuid: requestIdentity.userUuid }
      }),
    }
    const { adapter, root } = await createAdapter({
      authorize: concurrentAuthorizer,
      maxActiveTransfers: 1,
    })
    await fs.mkdir(join(root, identity.userUuid), { recursive: true })
    await fs.writeFile(join(root, identity.userUuid, resource.remoteIdentifier), Uint8Array.from([1, 2, 3]))

    const results = await Promise.allSettled([
      adapter.openUpload(
        {
          identity,
          descriptor: { ...descriptor, remoteIdentifier: 'atomic-upload', fileUuid: 'atomic-upload-file' },
        },
        new AbortController().signal,
      ),
      adapter.openDownload({ identity, resource, offset: 0 }, new AbortController().signal),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined
    expect(rejected?.reason).toMatchObject({ code: 'FILE_TRANSFER_CAPACITY' })
    const fulfilled = results.find((result) => result.status === 'fulfilled') as
      PromiseFulfilledResult<{ transferId: string; generation: number }> | undefined
    expect(fulfilled).toBeDefined()
    if (fulfilled) {
      await adapter.cancel({
        identity,
        transferId: fulfilled.value.transferId,
        generation: fulfilled.value.generation,
        reason: 'test',
      })
    }
  })

  it('removes orphan partial uploads during restart pruning', async () => {
    const first = await createAdapter()
    const orphanPath = join(first.root, '.sync-files-v1', 'orphan.partial')
    await fs.writeFile(orphanPath, Uint8Array.from([1, 2, 3]))

    await createAdapter({ root: first.root })

    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains the newest persisted uploads by updatedAt rather than resume filename order', async () => {
    let timestamp = 200
    const first = await createAdapter({ maxActiveTransfers: 2, now: () => timestamp })
    const newest = await first.adapter.openUpload(
      { identity, descriptor: { ...descriptor, remoteIdentifier: 'newest-file', fileUuid: 'newest-file' } },
      new AbortController().signal,
    )
    timestamp = 100
    const older = await first.adapter.openUpload(
      { identity, descriptor: { ...descriptor, remoteIdentifier: 'older-file', fileUuid: 'older-file' } },
      new AbortController().signal,
    )

    timestamp = 201
    await createAdapter({ root: first.root, maxActiveTransfers: 1, now: () => timestamp })

    const staging = join(first.root, '.sync-files-v1')
    await expect(fs.stat(join(staging, `${newest.resumeId}.json`))).resolves.toMatchObject({})
    await expect(fs.stat(join(staging, `${newest.resumeId}.partial`))).resolves.toMatchObject({})
    await expect(fs.stat(join(staging, `${older.resumeId}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(join(staging, `${older.resumeId}.partial`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on authorization, ownership mismatch, tampering, cancellation, and transfer exhaustion', async () => {
    const denied = await createAdapter({ authorize: authorizer(false) })
    await expect(
      denied.adapter.metadata({ identity, resources: [resource] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' })

    const missing = await createAdapter()
    await expect(
      missing.adapter.openDownload({ identity, resource, offset: 0 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })

    const wrongOwner = authorizer()
    wrongOwner.authorize = jest.fn(async () => ({ storageOwnerUuid: 'someone-else' }))
    const mismatched = await createAdapter({ authorize: wrongOwner })
    await expect(
      mismatched.adapter.openUpload({ identity, descriptor }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' })

    const { adapter } = await createAdapter({ maxActiveTransfers: 1 })
    const opened = await adapter.openUpload({ identity, descriptor }, new AbortController().signal)
    await expect(adapter.openUpload({ identity, descriptor }, new AbortController().signal)).rejects.toMatchObject({
      code: 'FILE_TRANSFER_CAPACITY',
    })
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    await expect(
      adapter.uploadChunk(
        {
          identity,
          header: {
            kind: 'UPLOAD_CHUNK',
            requestId: 'request-1',
            transferId: opened.transferId,
            generation: opened.generation,
            index: 0,
            offset: 0,
            declaredSize: 5,
            byteLength: 5,
            sha256: '0'.repeat(64),
            final: true,
          },
          bytes,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_INTEGRITY_MISMATCH' })
    await adapter.cancel({ identity, transferId: opened.transferId, generation: opened.generation, reason: 'test' })
    await expect(
      adapter.uploadChunk(
        {
          identity,
          header: {
            kind: 'UPLOAD_CHUNK',
            requestId: 'request-2',
            transferId: opened.transferId,
            generation: opened.generation,
            index: 0,
            offset: 0,
            declaredSize: 5,
            byteLength: 5,
            sha256: digest(bytes),
            final: true,
          },
          bytes,
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HomeServerSyncFilesAdapterError)
  })

  it('keeps shared-vault storage in the exact authorized vault namespace and rejects symlink traversal', async () => {
    const { adapter, root } = await createAdapter()
    const sharedResource = {
      ownershipType: 'shared-vault' as const,
      remoteIdentifier: 'shared-file',
      fileUuid: 'file-2',
      sharedVaultUuid: 'vault-1',
      sharedVaultOwnerUuid: 'owner-1',
    }
    await fs.mkdir(join(root, 'vault-1'), { recursive: true })
    await fs.writeFile(join(root, 'vault-1', 'shared-file'), Uint8Array.from([7]))
    await expect(
      adapter.metadata({ identity, resources: [sharedResource] }, new AbortController().signal),
    ).resolves.toEqual([{ resource: sharedResource, exists: true, encryptedSize: 1 }])

    const external = await fs.mkdtemp(join(tmpdir(), 'srn-files-outside-'))
    roots.push(external)
    await fs.symlink(external, join(root, identity.userUuid), 'junction')
    const malicious = await createAdapter({ root })
    await expect(
      malicious.adapter.metadata({ identity, resources: [resource] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'FILE_PATH_INVALID' })
  })

  // The gateway drives this adapter through SyncFilesSession, never directly.
  // Testing the adapter interface alone leaves that seam unproven -- which is
  // how the whole FILES_V1 lane stayed dead while looking wired. Here the real
  // session class consumes real wire frames and the bytes land on real disk.
  it('moves a file end to end through the real gateway file session', async () => {
    const { adapter, root } = await createAdapter()
    const payload = Uint8Array.from({ length: 600 }, (_value, index) => (index * 11) % 251)
    const sha256 = digest(payload)

    const controls: Array<{ type: string; payload: Record<string, unknown> }> = []
    const binaries: Uint8Array[] = []
    const errors: string[] = []
    const session = new SyncFilesSession({
      adapter,
      sendControl: (type, _requestId, _commandId, framePayload) => {
        controls.push({ type, payload: framePayload as Record<string, unknown> })
        return true
      },
      sendBinary: (bytes) => {
        binaries.push(Uint8Array.from(bytes))
        return true
      },
      sendError: (_requestId, _commandId, code) => {
        errors.push(code)
        return true
      },
    })
    const control = (type: string, framePayload: Record<string, unknown>): SyncFilesControlFrame =>
      ({
        version: 1,
        channel: 'sync',
        type,
        requestId: `request-${type}`,
        commandId: `command-${type}`,
        sequence: 1,
        payloadLength: 0,
        payload: framePayload,
      }) as unknown as SyncFilesControlFrame
    const lastControl = (type: string) => controls.filter((frame) => frame.type === type).at(-1)

    await session.handleControl(
      control('FILES_UPLOAD_OPEN', {
        resource,
        decryptedSize: payload.byteLength,
        declaredSize: payload.byteLength,
        mimeType: 'application/octet-stream',
        deadlineMs: 5_000,
      }),
      identity,
    )
    const opened = lastControl('FILES_ACCEPTED')
    expect(opened).toMatchObject({ payload: { mode: 'upload', declaredSize: payload.byteLength } })
    const transferId = opened?.payload.transferId as string
    const generation = opened?.payload.generation as number

    const half = 300
    for (const [index, slice] of [payload.slice(0, half), payload.slice(half)].entries()) {
      await session.handleBinary(
        encodeFileBinaryFrame(
          {
            kind: 'UPLOAD_CHUNK',
            requestId: 'request-upload-chunk',
            transferId,
            generation,
            index,
            offset: index * half,
            declaredSize: payload.byteLength,
            byteLength: slice.byteLength,
            sha256: digest(slice),
            final: index === 1,
          },
          slice,
        ),
        identity,
      )
      expect(lastControl('FILES_CHUNK_ACK')).toMatchObject({ payload: { index, duplicate: false } })
    }

    await session.handleControl(
      control('FILES_UPLOAD_FINISH', {
        transferId,
        generation,
        declaredSize: payload.byteLength,
        sha256,
        deadlineMs: 5_000,
      }),
      identity,
    )
    expect(lastControl('FILES_COMPLETE')).toMatchObject({ payload: { mode: 'upload', sha256 } })
    // Published to the canonical <root>/<ownerUuid>/<remoteIdentifier> path the
    // files service serves from, not left in private transfer staging.
    await expect(fs.readFile(join(root, identity.userUuid, resource.remoteIdentifier))).resolves.toEqual(
      Buffer.from(payload),
    )

    await session.handleControl(
      control('FILES_DOWNLOAD_OPEN', {
        resource,
        offset: 0,
        initialCreditBytes: payload.byteLength,
        deadlineMs: 5_000,
      }),
      identity,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lastControl('FILES_COMPLETE')).toMatchObject({ payload: { mode: 'download', sha256 } })
    expect(errors).toEqual([])
    const received = Buffer.concat(binaries.map((frame) => Buffer.from(decodeFileBinaryFrame(frame).bytes)))
    expect(new Uint8Array(received)).toEqual(payload)
  })
})
