import { createHash } from 'node:crypto'

import {
  MultiContainerSyncFilesAdapter,
  type MultiContainerFileAuthorization,
  type MultiContainerFileRangeResult,
  type MultiContainerFileResourceAuthorizer,
  type MultiContainerFileStoragePort,
  type MultiContainerFileStorageTarget,
} from './MultiContainerSyncFilesAdapter'

type Identity = {
  userUuid: string
  sessionUuid: string
  deviceId: string
  authorization?: string
}

type FileResource = {
  ownershipType: 'user' | 'shared-vault'
  remoteIdentifier: string
  fileUuid?: string
  sharedVaultUuid?: string
  sharedVaultOwnerUuid?: string
}

type AuthorizeInput = Parameters<MultiContainerFileResourceAuthorizer['authorize']>[0]

type StorageCall =
  | { kind: 'probeSize'; target: MultiContainerFileStorageTarget }
  | { kind: 'createUploadSession'; target: MultiContainerFileStorageTarget }
  | { kind: 'uploadPart'; target: MultiContainerFileStorageTarget; partNumber: number; bytes: Buffer }
  | { kind: 'closeUploadSession'; target: MultiContainerFileStorageTarget }
  | { kind: 'readRange'; target: MultiContainerFileStorageTarget; offset: number; length: number }

const MAX_CHUNK_BYTES = 256 * 1024
const PART_BYTES = 5 * 1024 * 1024

const IDENTITY: Identity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer session-credential',
}

const PERSONAL: FileResource = { ownershipType: 'user', remoteIdentifier: 'resource-1' }

const SHARED: FileResource = {
  ownershipType: 'shared-vault',
  remoteIdentifier: 'resource-2',
  fileUuid: 'file-2',
  sharedVaultUuid: 'vault-1',
  sharedVaultOwnerUuid: 'owner-1',
}

class FakeStorage implements MultiContainerFileStoragePort {
  calls: StorageCall[] = []
  isReady = true
  /** key => encrypted size of an already published resource. */
  existing = new Map<string, number>()
  /** key => bytes a download reads back. */
  contents = new Map<string, Buffer>()
  reportedTotalSize?: number
  shortRead = false
  failOn?: { kind: StorageCall['kind']; error: Error }

  ready(): boolean {
    return this.isReady
  }

  async probeSize(target: MultiContainerFileStorageTarget): Promise<number | undefined> {
    this.record({ kind: 'probeSize', target })
    const content = this.contents.get(key(target))
    if (content) {
      return content.byteLength
    }
    return this.existing.get(key(target))
  }

  async createUploadSession(target: MultiContainerFileStorageTarget): Promise<void> {
    this.record({ kind: 'createUploadSession', target })
  }

  async uploadPart(input: {
    target: MultiContainerFileStorageTarget
    partNumber: number
    bytes: Uint8Array
  }): Promise<void> {
    this.record({
      kind: 'uploadPart',
      target: input.target,
      partNumber: input.partNumber,
      bytes: Buffer.from(input.bytes),
    })
  }

  async closeUploadSession(target: MultiContainerFileStorageTarget): Promise<void> {
    this.record({ kind: 'closeUploadSession', target })
  }

  async readRange(input: {
    target: MultiContainerFileStorageTarget
    offset: number
    length: number
  }): Promise<MultiContainerFileRangeResult> {
    this.record({ kind: 'readRange', target: input.target, offset: input.offset, length: input.length })
    const content = this.contents.get(key(input.target))
    if (!content) {
      throw new Error('missing content')
    }
    const end = input.offset + (this.shortRead ? input.length - 1 : input.length)
    return {
      bytes: new Uint8Array(content.subarray(input.offset, end)),
      totalSize: this.reportedTotalSize ?? content.byteLength,
    }
  }

  callsOfKind(kind: StorageCall['kind']): StorageCall[] {
    return this.calls.filter((call) => call.kind === kind)
  }

  uploadedBytes(): Buffer {
    return Buffer.concat(
      this.calls
        .filter((call): call is Extract<StorageCall, { kind: 'uploadPart' }> => call.kind === 'uploadPart')
        .map((call) => call.bytes),
    )
  }

  private record(call: StorageCall): void {
    this.calls.push(call)
    if (this.failOn?.kind === call.kind) {
      throw this.failOn.error
    }
  }
}

class FakeAuthorizer implements MultiContainerFileResourceAuthorizer {
  calls: AuthorizeInput[] = []
  mintedTokens: string[] = []
  private counter = 0
  /** Overrides the default allow-everything decision. */
  decide?: (input: AuthorizeInput, defaultToken: string) => MultiContainerFileAuthorization | undefined
  /** When set, every mint returns this exact token (models a replayed credential). */
  fixedToken?: string

  async authorize(input: AuthorizeInput): Promise<MultiContainerFileAuthorization | undefined> {
    this.calls.push(input)
    this.counter += 1
    const token = this.fixedToken ?? `valet.token.${this.counter}`
    if (this.decide) {
      const decision = this.decide(input, token)
      if (decision) {
        this.mintedTokens.push(decision.valetToken)
      }
      return decision
    }
    const resource = input.resource as FileResource
    const storageOwnerUuid =
      resource.ownershipType === 'user' ? input.identity.userUuid : (resource.sharedVaultUuid as string)
    this.mintedTokens.push(token)
    return { storageOwnerUuid, valetToken: token }
  }
}

function key(target: MultiContainerFileStorageTarget): string {
  return `${target.storageOwnerUuid}/${target.remoteIdentifier}`
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function uploadHeader(input: {
  transferId: string
  generation: number
  index: number
  offset: number
  declaredSize: number
  bytes: Uint8Array
}) {
  return {
    kind: 'UPLOAD_CHUNK' as const,
    requestId: 'request-1',
    transferId: input.transferId,
    generation: input.generation,
    index: input.index,
    offset: input.offset,
    declaredSize: input.declaredSize,
    byteLength: input.bytes.byteLength,
    sha256: sha256(input.bytes),
    final: input.offset + input.bytes.byteLength === input.declaredSize,
  }
}

function build(overrides: Record<string, unknown> = {}) {
  const storage = new FakeStorage()
  const authorizer = new FakeAuthorizer()
  let transferSequence = 0
  let resumeSequence = 0
  const adapter = new MultiContainerSyncFilesAdapter({
    authorizer,
    storage,
    createTransferId: () => `transfer-${(transferSequence += 1)}`,
    createResumeId: () => `resume-${(resumeSequence += 1)}`,
    ...overrides,
  })
  return { adapter, storage, authorizer }
}

const signal = (): AbortSignal => new AbortController().signal

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController()
  controller.abort(new Error('aborted'))
  return controller.signal
}

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name
  }
  throw new Error('Expected the operation to reject.')
}

async function openUpload(
  adapter: MultiContainerSyncFilesAdapter,
  declaredSize: number,
  resource: FileResource = PERSONAL,
  resumeId?: string,
) {
  return adapter.openUpload(
    {
      identity: IDENTITY,
      descriptor: {
        ...resource,
        decryptedSize: declaredSize,
        declaredSize,
        mimeType: 'application/octet-stream',
        ...(resumeId ? { resumeId } : {}),
      },
    },
    signal(),
  )
}

async function sendChunk(
  adapter: MultiContainerSyncFilesAdapter,
  opened: { transferId: string; generation: number },
  input: { index: number; offset: number; declaredSize: number; bytes: Uint8Array },
) {
  return adapter.uploadChunk(
    {
      identity: IDENTITY,
      header: uploadHeader({ ...input, transferId: opened.transferId, generation: opened.generation }),
      bytes: input.bytes,
    },
    signal(),
  )
}

describe('MultiContainerSyncFilesAdapter', () => {
  describe('readiness', () => {
    it('reports the storage boundary readiness', () => {
      const { adapter, storage } = build()
      expect(adapter.ready()).toBe(true)
      storage.isReady = false
      expect(adapter.ready()).toBe(false)
    })

    it('refuses every operation while storage is unavailable', async () => {
      const { adapter, storage, authorizer } = build()
      storage.isReady = false
      expect(await codeOf(adapter.metadata({ identity: IDENTITY, resources: [PERSONAL] }, signal()))).toBe(
        'OPERATION_UNAVAILABLE',
      )
      expect(await codeOf(openUpload(adapter, 10))).toBe('OPERATION_UNAVAILABLE')
      expect(await codeOf(adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal()))).toBe(
        'OPERATION_UNAVAILABLE',
      )
      expect(storage.calls).toHaveLength(0)
      expect(authorizer.calls).toHaveLength(0)
    })
  })

  describe('construction bounds', () => {
    it.each([
      ['maxActiveTransfers', { maxActiveTransfers: 0 }],
      ['maxActiveUploads above maxActiveTransfers', { maxActiveTransfers: 2, maxActiveUploads: 3 }],
      ['storagePartBytes below the distributed minimum', { storagePartBytes: 1024 }],
      ['storagePartBytes above the cap', { storagePartBytes: 128 * 1024 * 1024 }],
      ['transferTtlMs below one second', { transferTtlMs: 10 }],
      ['duplicateHistoryChunks', { duplicateHistoryChunks: 0 }],
      ['presentedTokenHistory', { presentedTokenHistory: 0 }],
    ])('rejects an invalid %s', (_label, overrides) => {
      expect(() => build(overrides)).toThrow()
    })
  })

  describe('authorization', () => {
    it('denies and never reaches storage when the authorizer refuses', async () => {
      const { adapter, storage, authorizer } = build()
      authorizer.decide = () => undefined

      expect(await codeOf(adapter.metadata({ identity: IDENTITY, resources: [PERSONAL] }, signal()))).toBe(
        'FILE_ACCESS_DENIED',
      )
      expect(await codeOf(openUpload(adapter, 10))).toBe('FILE_ACCESS_DENIED')
      expect(await codeOf(adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal()))).toBe(
        'FILE_ACCESS_DENIED',
      )
      expect(storage.calls).toHaveLength(0)
    })

    it('denies a personal resource whose namespace is not the authenticated user', async () => {
      const { adapter, storage, authorizer } = build()
      authorizer.decide = (_input, token) => ({ storageOwnerUuid: 'someone-else', valetToken: token })

      expect(await codeOf(openUpload(adapter, 10))).toBe('FILE_ACCESS_DENIED')
      expect(storage.calls).toHaveLength(0)
    })

    it('denies a shared-vault resource whose namespace is not the requested vault', async () => {
      const { adapter, storage, authorizer } = build()
      authorizer.decide = (_input, token) => ({ storageOwnerUuid: 'other-vault', valetToken: token })

      expect(await codeOf(openUpload(adapter, 10, SHARED))).toBe('FILE_ACCESS_DENIED')
      expect(storage.calls).toHaveLength(0)
    })

    it.each([
      ['a missing credential', ''],
      ['a whitespace credential', 'valet token'],
      ['a control-character credential', `valet${String.fromCharCode(1)}token`],
      ['an oversized credential', 'v'.repeat(8 * 1024 + 1)],
    ])('denies %s without reaching storage', async (_label, valetToken) => {
      const { adapter, storage, authorizer } = build()
      authorizer.decide = () => ({ storageOwnerUuid: IDENTITY.userUuid, valetToken })

      expect(await codeOf(openUpload(adapter, 10))).toBe('FILE_ACCESS_DENIED')
      expect(storage.calls).toHaveLength(0)
    })

    it('denies a replayed valet credential and leaves storage untouched by the replay', async () => {
      const { adapter, storage, authorizer } = build()
      authorizer.fixedToken = 'valet.token.constant'

      await openUpload(adapter, 10)
      expect(storage.callsOfKind('createUploadSession')).toHaveLength(1)

      const callsAfterFirst = storage.calls.length
      expect(await codeOf(openUpload(adapter, 10))).toBe('FILE_ACCESS_DENIED')
      expect(storage.calls).toHaveLength(callsAfterFirst)
    })

    it('presents a distinct credential for every storage interaction', async () => {
      const { adapter, storage } = build()
      const declaredSize = 12
      const opened = await openUpload(adapter, declaredSize)
      await sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: Buffer.alloc(declaredSize, 7) })
      await adapter.finishUpload(
        {
          identity: IDENTITY,
          transferId: opened.transferId,
          generation: opened.generation,
          declaredSize,
          sha256: sha256(Buffer.alloc(declaredSize, 7)),
        },
        signal(),
      )

      const presented = storage.calls.map((call) => call.target.valetToken)
      expect(presented.length).toBeGreaterThan(1)
      expect(new Set(presented).size).toBe(presented.length)
    })

    it('re-authorizes every upload chunk and refuses one whose namespace is not the caller', async () => {
      const { adapter, storage, authorizer } = build()
      const declaredSize = 20
      const opened = await openUpload(adapter, declaredSize)
      const partsBefore = storage.callsOfKind('uploadPart').length

      authorizer.decide = (_input, token) => ({ storageOwnerUuid: 'relocated-vault', valetToken: token })
      const code = await codeOf(
        sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: Buffer.alloc(declaredSize, 1) }),
      )

      expect(code).toBe('FILE_ACCESS_DENIED')
      expect(storage.callsOfKind('uploadPart')).toHaveLength(partsBefore)
    })

    it('refuses a chunk from a different session before authorization is even attempted', async () => {
      const { adapter, storage, authorizer } = build()
      const declaredSize = 20
      const opened = await openUpload(adapter, declaredSize)
      const authorizeCalls = authorizer.calls.length

      const code = await codeOf(
        adapter.uploadChunk(
          {
            identity: { ...IDENTITY, sessionUuid: 'session-2' },
            header: uploadHeader({
              transferId: opened.transferId,
              generation: opened.generation,
              index: 0,
              offset: 0,
              declaredSize,
              bytes: Buffer.alloc(declaredSize, 1),
            }),
            bytes: Buffer.alloc(declaredSize, 1),
          },
          signal(),
        ),
      )

      expect(code).toBe('FILE_ACCESS_DENIED')
      expect(authorizer.calls).toHaveLength(authorizeCalls)
      expect(storage.callsOfKind('uploadPart')).toHaveLength(0)
    })

    it('carries the operation and declared decrypted size into the authorization decision', async () => {
      const { adapter, authorizer } = build()
      await openUpload(adapter, 42)
      const [first] = authorizer.calls
      expect(first.operation).toBe('upload')
      expect(first.decryptedSize).toBe(42)
      expect(first.identity.authorization).toBe('Bearer session-credential')
    })
  })

  describe('metadata', () => {
    it('reports existence and encrypted size', async () => {
      const { adapter, storage } = build()
      storage.existing.set(`${IDENTITY.userUuid}/resource-1`, 1234)

      const entries = await adapter.metadata(
        { identity: IDENTITY, resources: [PERSONAL, { ownershipType: 'user', remoteIdentifier: 'resource-9' }] },
        signal(),
      )

      expect(entries).toEqual([
        { resource: PERSONAL, exists: true, encryptedSize: 1234 },
        { resource: { ownershipType: 'user', remoteIdentifier: 'resource-9' }, exists: false },
      ])
    })

    it.each([
      ['an empty batch', [] as FileResource[]],
      [
        'an oversized batch',
        Array.from({ length: 101 }, (_v, i) => ({ ownershipType: 'user' as const, remoteIdentifier: `r-${i}` })),
      ],
    ])('rejects %s', async (_label, resources) => {
      const { adapter, storage } = build()
      expect(await codeOf(adapter.metadata({ identity: IDENTITY, resources }, signal()))).toBe('FILE_RESOURCE_INVALID')
      expect(storage.calls).toHaveLength(0)
    })

    it.each([
      ['a traversal identifier', { ownershipType: 'user' as const, remoteIdentifier: '../secret' }],
      ['a shared-vault reference without a vault', { ownershipType: 'shared-vault' as const, remoteIdentifier: 'r' }],
      [
        'a personal reference carrying vault fields',
        { ownershipType: 'user' as const, remoteIdentifier: 'r', sharedVaultUuid: 'v' },
      ],
    ])('rejects %s before authorization', async (_label, resource) => {
      const { adapter, storage, authorizer } = build()
      expect(await codeOf(adapter.metadata({ identity: IDENTITY, resources: [resource] }, signal()))).toBe(
        'FILE_RESOURCE_INVALID',
      )
      expect(authorizer.calls).toHaveLength(0)
      expect(storage.calls).toHaveLength(0)
    })

    it('rejects an implausible reported size', async () => {
      const { adapter, storage } = build()
      storage.existing.set(`${IDENTITY.userUuid}/resource-1`, 6 * 1024 * 1024 * 1024)
      expect(await codeOf(adapter.metadata({ identity: IDENTITY, resources: [PERSONAL] }, signal()))).toBe(
        'FILE_BACKEND_ERROR',
      )
    })

    it('does not reach storage once the signal is aborted', async () => {
      const { adapter, storage } = build()
      await expect(adapter.metadata({ identity: IDENTITY, resources: [PERSONAL] }, abortedSignal())).rejects.toThrow()
      expect(storage.calls).toHaveLength(0)
    })
  })

  describe('upload', () => {
    it('coalesces wire chunks into distributed-storage parts and publishes once', async () => {
      const { adapter, storage } = build()
      const chunk = Buffer.alloc(MAX_CHUNK_BYTES, 3)
      const chunkCount = 21
      const declaredSize = MAX_CHUNK_BYTES * chunkCount
      const opened = await openUpload(adapter, declaredSize)

      for (let index = 0; index < chunkCount; index += 1) {
        await sendChunk(adapter, opened, {
          index,
          offset: index * MAX_CHUNK_BYTES,
          declaredSize,
          bytes: chunk,
        })
      }

      const parts = storage.callsOfKind('uploadPart') as Extract<StorageCall, { kind: 'uploadPart' }>[]
      expect(parts).toHaveLength(2)
      expect(parts[0].bytes.byteLength).toBeGreaterThanOrEqual(PART_BYTES)
      expect(parts.map((part) => part.partNumber)).toEqual([1, 2])
      expect(storage.uploadedBytes().byteLength).toBe(declaredSize)

      const expected = sha256(Buffer.alloc(declaredSize, 3))
      const finished = await adapter.finishUpload(
        {
          identity: IDENTITY,
          transferId: opened.transferId,
          generation: opened.generation,
          declaredSize,
          sha256: expected,
        },
        signal(),
      )
      expect(finished).toEqual({ sha256: expected })
      expect(storage.callsOfKind('closeUploadSession')).toHaveLength(1)
    })

    it('opens with a resumable identity and a zeroed cursor', async () => {
      const { adapter, storage } = build()
      const opened = await openUpload(adapter, 99)
      expect(opened).toEqual({
        transferId: 'transfer-1',
        generation: 1,
        resumeId: 'resume-1',
        nextIndex: 0,
        nextOffset: 0,
        declaredSize: 99,
      })
      expect(storage.callsOfKind('createUploadSession')).toHaveLength(1)
    })

    it('never registers a transfer when the storage session cannot be created', async () => {
      const { adapter, storage } = build()
      storage.failOn = { kind: 'createUploadSession', error: new Error('offline') }
      await expect(openUpload(adapter, 10)).rejects.toThrow('offline')

      const code = await codeOf(
        adapter.uploadChunk(
          {
            identity: IDENTITY,
            header: uploadHeader({
              transferId: 'transfer-1',
              generation: 1,
              index: 0,
              offset: 0,
              declaredSize: 10,
              bytes: Buffer.alloc(10),
            }),
            bytes: Buffer.alloc(10),
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_TRANSFER_NOT_FOUND')
    })

    it.each([
      ['a zero declared size', { declaredSize: 0 }],
      ['a declared size beyond the transfer cap', { declaredSize: 5 * 1024 * 1024 * 1024 + 1 }],
      ['a decrypted size beyond the transfer cap', { decryptedSize: 5 * 1024 * 1024 * 1024 + 1 }],
      ['an empty mime type', { mimeType: '' }],
      ['a control-character mime type', { mimeType: `text/plain${String.fromCharCode(1)}` }],
      ['a malformed resume id', { resumeId: 'not a resume id' }],
    ])('rejects %s', async (_label, patch) => {
      const { adapter, storage, authorizer } = build()
      const code = await codeOf(
        adapter.openUpload(
          {
            identity: IDENTITY,
            descriptor: {
              ...PERSONAL,
              decryptedSize: 10,
              declaredSize: 10,
              mimeType: 'application/octet-stream',
              ...patch,
            } as never,
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_RESOURCE_INVALID')
      expect(authorizer.calls).toHaveLength(0)
      expect(storage.calls).toHaveLength(0)
    })

    it('rejects a chunk whose payload does not match its header digest', async () => {
      const { adapter, storage } = build()
      const declaredSize = 16
      const opened = await openUpload(adapter, declaredSize)
      const header = uploadHeader({
        transferId: opened.transferId,
        generation: opened.generation,
        index: 0,
        offset: 0,
        declaredSize,
        bytes: Buffer.alloc(declaredSize, 1),
      })

      const code = await codeOf(
        adapter.uploadChunk({ identity: IDENTITY, header, bytes: Buffer.alloc(declaredSize, 2) }, signal()),
      )
      expect(code).toBe('FILE_INTEGRITY_MISMATCH')
      expect(storage.callsOfKind('uploadPart')).toHaveLength(0)
    })

    it('rejects a chunk that would overrun the declared size', async () => {
      const { adapter } = build()
      const declaredSize = 16
      const opened = await openUpload(adapter, declaredSize)
      const bytes = Buffer.alloc(declaredSize + 8, 1)
      const code = await codeOf(
        adapter.uploadChunk(
          {
            identity: IDENTITY,
            header: {
              ...uploadHeader({
                transferId: opened.transferId,
                generation: opened.generation,
                index: 0,
                offset: 0,
                declaredSize,
                bytes,
              }),
              final: true,
            },
            bytes,
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_INTEGRITY_MISMATCH')
    })

    it('rejects an out-of-order chunk', async () => {
      const { adapter } = build()
      const declaredSize = 32
      const opened = await openUpload(adapter, declaredSize)
      const code = await codeOf(
        sendChunk(adapter, opened, { index: 1, offset: 16, declaredSize, bytes: Buffer.alloc(16, 1) }),
      )
      expect(code).toBe('FILE_CHUNK_OUT_OF_ORDER')
    })

    it('acknowledges a verified duplicate without storing it again', async () => {
      const { adapter, storage } = build()
      const declaredSize = 32
      const opened = await openUpload(adapter, declaredSize)
      const first = Buffer.alloc(16, 1)
      await sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: first })
      const partsBefore = storage.callsOfKind('uploadPart').length

      const replayed = await sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: first })
      expect(replayed).toEqual({ duplicate: true, nextIndex: 1, nextOffset: 16, resumeId: 'resume-1' })
      expect(storage.callsOfKind('uploadPart')).toHaveLength(partsBefore)
    })

    it('rejects a duplicate index carrying different bytes', async () => {
      const { adapter } = build()
      const declaredSize = 32
      const opened = await openUpload(adapter, declaredSize)
      await sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: Buffer.alloc(16, 1) })

      const code = await codeOf(
        sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: Buffer.alloc(16, 2) }),
      )
      expect(code).toBe('FILE_INTEGRITY_MISMATCH')
    })

    it('rejects a duplicate that has fallen outside the verifiable window', async () => {
      const { adapter } = build({ duplicateHistoryChunks: 1 })
      const declaredSize = 48
      const opened = await openUpload(adapter, declaredSize)
      const first = Buffer.alloc(16, 1)
      await sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: first })
      await sendChunk(adapter, opened, { index: 1, offset: 16, declaredSize, bytes: Buffer.alloc(16, 2) })

      const code = await codeOf(sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: first }))
      expect(code).toBe('FILE_CHUNK_OUT_OF_ORDER')
    })

    it('rejects a chunk on a stale generation', async () => {
      const { adapter } = build()
      const declaredSize = 16
      const opened = await openUpload(adapter, declaredSize)
      const code = await codeOf(
        sendChunk(
          adapter,
          { transferId: opened.transferId, generation: opened.generation + 1 },
          { index: 0, offset: 0, declaredSize, bytes: Buffer.alloc(declaredSize, 1) },
        ),
      )
      expect(code).toBe('FILE_STALE_GENERATION')
    })

    it('rejects an unknown transfer', async () => {
      const { adapter } = build()
      const code = await codeOf(
        adapter.uploadChunk(
          {
            identity: IDENTITY,
            header: uploadHeader({
              transferId: 'transfer-404',
              generation: 1,
              index: 0,
              offset: 0,
              declaredSize: 8,
              bytes: Buffer.alloc(8),
            }),
            bytes: Buffer.alloc(8),
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_TRANSFER_NOT_FOUND')
    })

    it('caps the number of concurrent uploads', async () => {
      const { adapter } = build({ maxActiveUploads: 1, maxActiveTransfers: 4 })
      await openUpload(adapter, 10)
      expect(await codeOf(openUpload(adapter, 10))).toBe('FILE_TRANSFER_CAPACITY')
    })

    it('caps the total number of concurrent transfers', async () => {
      const { adapter, storage } = build({ maxActiveUploads: 1, maxActiveTransfers: 1 })
      storage.contents.set(`${IDENTITY.userUuid}/resource-1`, Buffer.alloc(64, 1))
      await openUpload(adapter, 10)
      expect(await codeOf(adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal()))).toBe(
        'FILE_TRANSFER_CAPACITY',
      )
    })
  })

  describe('finish', () => {
    const declaredSize = 24
    const payload = Buffer.alloc(declaredSize, 5)

    async function completedUpload() {
      const context = build()
      const opened = await openUpload(context.adapter, declaredSize)
      await sendChunk(context.adapter, opened, { index: 0, offset: 0, declaredSize, bytes: payload })
      return { ...context, opened }
    }

    it('publishes and reports the digest of the accepted bytes', async () => {
      const { adapter, storage, opened } = await completedUpload()
      const result = await adapter.finishUpload(
        {
          identity: IDENTITY,
          transferId: opened.transferId,
          generation: opened.generation,
          declaredSize,
          sha256: sha256(payload),
        },
        signal(),
      )
      expect(result).toEqual({ sha256: sha256(payload) })
      expect(storage.callsOfKind('closeUploadSession')).toHaveLength(1)
    })

    it('is idempotent for a replayed finish', async () => {
      const { adapter, storage, opened } = await completedUpload()
      const request = {
        identity: IDENTITY,
        transferId: opened.transferId,
        generation: opened.generation,
        declaredSize,
        sha256: sha256(payload),
      }
      await adapter.finishUpload(request, signal())
      await adapter.finishUpload(request, signal())
      expect(storage.callsOfKind('closeUploadSession')).toHaveLength(1)
    })

    it('refuses to publish when the client digest disagrees', async () => {
      const { adapter, storage, opened } = await completedUpload()
      const code = await codeOf(
        adapter.finishUpload(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation,
            declaredSize,
            sha256: sha256(Buffer.alloc(declaredSize, 9)),
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_INTEGRITY_MISMATCH')
      expect(storage.callsOfKind('closeUploadSession')).toHaveLength(0)
    })

    it('refuses to publish an incomplete transfer', async () => {
      const { adapter, storage } = build()
      const opened = await openUpload(adapter, declaredSize)
      await sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: Buffer.alloc(8, 5) })

      const code = await codeOf(
        adapter.finishUpload(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation,
            declaredSize,
            sha256: sha256(payload),
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_INCOMPLETE')
      expect(storage.callsOfKind('closeUploadSession')).toHaveLength(0)
    })

    it('refuses to publish over a differently sized resource', async () => {
      const { adapter, storage, opened } = await completedUpload()
      storage.existing.set(`${IDENTITY.userUuid}/resource-1`, declaredSize + 10)

      const code = await codeOf(
        adapter.finishUpload(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation,
            declaredSize,
            sha256: sha256(payload),
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_DESTINATION_CONFLICT')
      expect(storage.callsOfKind('closeUploadSession')).toHaveLength(0)
    })

    it('rejects a finish for a stale generation', async () => {
      const { adapter, opened } = await completedUpload()
      const code = await codeOf(
        adapter.finishUpload(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation + 5,
            declaredSize,
            sha256: sha256(payload),
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_STALE_GENERATION')
    })
  })

  describe('resume', () => {
    const chunk = Buffer.alloc(MAX_CHUNK_BYTES, 4)
    const chunkCount = 24
    const declaredSize = MAX_CHUNK_BYTES * chunkCount

    async function partiallyUploaded(sent: number) {
      const context = build()
      const opened = await openUpload(context.adapter, declaredSize)
      for (let index = 0; index < sent; index += 1) {
        await sendChunk(context.adapter, opened, {
          index,
          offset: index * MAX_CHUNK_BYTES,
          declaredSize,
          bytes: chunk,
        })
      }
      return { ...context, opened }
    }

    it('rewinds to the last durable storage part boundary', async () => {
      const { adapter, storage } = await partiallyUploaded(22)
      const flushedBytes = storage.uploadedBytes().byteLength
      expect(flushedBytes).toBeGreaterThan(0)
      expect(flushedBytes).toBeLessThan(22 * MAX_CHUNK_BYTES)

      const resumed = await openUpload(adapter, declaredSize, PERSONAL, 'resume-1')

      expect(resumed.generation).toBe(2)
      expect(resumed.transferId).toBe('transfer-1')
      expect(resumed.nextOffset).toBe(flushedBytes)
      expect(resumed.nextIndex).toBe(flushedBytes / MAX_CHUNK_BYTES)
    })

    it('accepts the rewound bytes again and still publishes the true digest', async () => {
      const { adapter, storage } = await partiallyUploaded(22)
      const resumed = await openUpload(adapter, declaredSize, PERSONAL, 'resume-1')

      for (let index = resumed.nextIndex; index < chunkCount; index += 1) {
        await sendChunk(adapter, resumed, {
          index,
          offset: index * MAX_CHUNK_BYTES,
          declaredSize,
          bytes: chunk,
        })
      }

      const expected = sha256(Buffer.alloc(declaredSize, 4))
      const finished = await adapter.finishUpload(
        {
          identity: IDENTITY,
          transferId: resumed.transferId,
          generation: resumed.generation,
          declaredSize,
          sha256: expected,
        },
        signal(),
      )
      expect(finished).toEqual({ sha256: expected })
      expect(storage.uploadedBytes().byteLength).toBe(declaredSize)
    })

    it('retires the previous generation after a resume', async () => {
      const { adapter, opened } = await partiallyUploaded(2)
      await openUpload(adapter, declaredSize, PERSONAL, 'resume-1')
      const code = await codeOf(sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: chunk }))
      expect(code).toBe('FILE_STALE_GENERATION')
    })

    it.each([
      ['a different declared size', { declaredSize: MAX_CHUNK_BYTES }],
      ['a different mime type', { mimeType: 'image/png' }],
    ])('refuses a resume with %s', async (_label, patch) => {
      const { adapter } = await partiallyUploaded(2)
      const code = await codeOf(
        adapter.openUpload(
          {
            identity: IDENTITY,
            descriptor: {
              ...PERSONAL,
              decryptedSize: declaredSize,
              declaredSize,
              mimeType: 'application/octet-stream',
              resumeId: 'resume-1',
              ...patch,
            },
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_RESUME_INVALID')
    })

    it('refuses a resume from a different session', async () => {
      const { adapter } = await partiallyUploaded(2)
      const code = await codeOf(
        adapter.openUpload(
          {
            identity: { ...IDENTITY, deviceId: 'device-2' },
            descriptor: {
              ...PERSONAL,
              decryptedSize: declaredSize,
              declaredSize,
              mimeType: 'application/octet-stream',
              resumeId: 'resume-1',
            },
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_ACCESS_DENIED')
    })

    it('refuses an unknown resume id', async () => {
      const { adapter } = build()
      const code = await codeOf(openUpload(adapter, 100, PERSONAL, 'resume-unknown'))
      expect(code).toBe('FILE_RESUME_INVALID')
    })

    it('reports an expired resume distinctly from an unknown one', async () => {
      let clock = 1_000_000
      const { adapter } = build({ transferTtlMs: 60_000, now: () => clock })
      await openUpload(adapter, 100)
      clock += 120_000
      const code = await codeOf(openUpload(adapter, 100, PERSONAL, 'resume-1'))
      expect(code).toBe('FILE_RESUME_EXPIRED')
    })
  })

  describe('download', () => {
    const content = Buffer.alloc(1000, 8)

    function withContent(overrides: Record<string, unknown> = {}) {
      const context = build(overrides)
      context.storage.contents.set(`${IDENTITY.userUuid}/resource-1`, content)
      return context
    }

    it('opens at the requested offset and streams to completion', async () => {
      const { adapter, storage } = withContent()
      const opened = await adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal())
      expect(opened).toEqual({
        transferId: 'transfer-1',
        generation: 1,
        resumeId: 'resume-1',
        declaredSize: 1000,
        nextIndex: 0,
        nextOffset: 0,
      })

      const first = await adapter.readDownloadChunk(
        {
          identity: IDENTITY,
          transferId: opened.transferId,
          generation: opened.generation,
          index: 0,
          offset: 0,
          maxBytes: 600,
        },
        signal(),
      )
      expect(first.bytes.byteLength).toBe(600)
      expect(first.final).toBe(false)

      const second = await adapter.readDownloadChunk(
        {
          identity: IDENTITY,
          transferId: opened.transferId,
          generation: opened.generation,
          index: 1,
          offset: 600,
          maxBytes: 600,
        },
        signal(),
      )
      expect(second.bytes.byteLength).toBe(400)
      expect(second.final).toBe(true)
      expect(storage.callsOfKind('readRange')).toHaveLength(2)

      const afterCompletion = await codeOf(
        adapter.readDownloadChunk(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation,
            index: 2,
            offset: 1000,
            maxBytes: 10,
          },
          signal(),
        ),
      )
      expect(afterCompletion).toBe('FILE_TRANSFER_NOT_FOUND')
    })

    it('honours the credit-derived read size without exceeding the chunk cap', async () => {
      const { adapter, storage } = withContent()
      const opened = await adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal())
      await adapter.readDownloadChunk(
        {
          identity: IDENTITY,
          transferId: opened.transferId,
          generation: opened.generation,
          index: 0,
          offset: 0,
          maxBytes: 128,
        },
        signal(),
      )
      const [read] = storage.callsOfKind('readRange') as Extract<StorageCall, { kind: 'readRange' }>[]
      expect(read.length).toBe(128)

      const code = await codeOf(
        adapter.readDownloadChunk(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation,
            index: 1,
            offset: 128,
            maxBytes: MAX_CHUNK_BYTES + 1,
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_CHUNK_OUT_OF_ORDER')
    })

    it('reports a missing resource', async () => {
      const { adapter } = build()
      expect(await codeOf(adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal()))).toBe(
        'FILE_NOT_FOUND',
      )
    })

    it.each([
      ['a negative offset', -1],
      ['an offset at the end of the resource', 1000],
      ['an offset past the resource', 5000],
    ])('rejects %s', async (_label, offset) => {
      const { adapter } = withContent()
      expect(await codeOf(adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset }, signal()))).toBe(
        'FILE_RANGE_INVALID',
      )
    })

    it('detects a resource that changed size under an open transfer', async () => {
      const { adapter, storage } = withContent()
      const opened = await adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal())
      storage.reportedTotalSize = 900
      const code = await codeOf(
        adapter.readDownloadChunk(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation,
            index: 0,
            offset: 0,
            maxBytes: 100,
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_TRUNCATED')
    })

    it('detects a short read', async () => {
      const { adapter, storage } = withContent()
      const opened = await adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal())
      storage.shortRead = true
      const code = await codeOf(
        adapter.readDownloadChunk(
          {
            identity: IDENTITY,
            transferId: opened.transferId,
            generation: opened.generation,
            index: 0,
            offset: 0,
            maxBytes: 100,
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_TRUNCATED')
    })

    it('rewinds a resumed download to the requested offset on a new generation', async () => {
      const { adapter } = withContent()
      const opened = await adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal())
      await adapter.readDownloadChunk(
        {
          identity: IDENTITY,
          transferId: opened.transferId,
          generation: opened.generation,
          index: 0,
          offset: 0,
          maxBytes: 100,
        },
        signal(),
      )

      const resumed = await adapter.openDownload(
        { identity: IDENTITY, resource: PERSONAL, offset: 100, resumeId: opened.resumeId },
        signal(),
      )
      expect(resumed).toMatchObject({ transferId: 'transfer-1', generation: 2, nextIndex: 0, nextOffset: 100 })
    })

    it('refuses a download resume that points at a different resource', async () => {
      const { adapter, storage } = withContent()
      storage.contents.set(`${IDENTITY.userUuid}/resource-3`, content)
      const opened = await adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal())
      const code = await codeOf(
        adapter.openDownload(
          {
            identity: IDENTITY,
            resource: { ownershipType: 'user', remoteIdentifier: 'resource-3' },
            offset: 0,
            resumeId: opened.resumeId,
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_RESUME_INVALID')
    })

    it('refuses a malformed download resume id', async () => {
      const { adapter } = withContent()
      const code = await codeOf(
        adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0, resumeId: 'bad id' }, signal()),
      )
      expect(code).toBe('FILE_RESUME_INVALID')
    })

    it('refuses a read from a different session', async () => {
      const { adapter, storage } = withContent()
      const opened = await adapter.openDownload({ identity: IDENTITY, resource: PERSONAL, offset: 0 }, signal())
      const reads = storage.callsOfKind('readRange').length
      const code = await codeOf(
        adapter.readDownloadChunk(
          {
            identity: { ...IDENTITY, userUuid: 'user-2' },
            transferId: opened.transferId,
            generation: opened.generation,
            index: 0,
            offset: 0,
            maxBytes: 100,
          },
          signal(),
        ),
      )
      expect(code).toBe('FILE_ACCESS_DENIED')
      expect(storage.callsOfKind('readRange')).toHaveLength(reads)
    })
  })

  describe('cancel', () => {
    it('drops an in-flight upload', async () => {
      const { adapter } = build()
      const opened = await openUpload(adapter, 32)
      await adapter.cancel({
        identity: IDENTITY,
        transferId: opened.transferId,
        generation: opened.generation,
        reason: 'client-cancelled',
      })
      const code = await codeOf(
        sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize: 32, bytes: Buffer.alloc(32, 1) }),
      )
      expect(code).toBe('FILE_TRANSFER_NOT_FOUND')
    })

    it('rejects an unknown transfer', async () => {
      const { adapter } = build()
      const code = await codeOf(
        adapter.cancel({ identity: IDENTITY, transferId: 'transfer-404', generation: 1, reason: 'nope' }),
      )
      expect(code).toBe('FILE_TRANSFER_NOT_FOUND')
    })

    it('rejects a stale generation', async () => {
      const { adapter } = build()
      const opened = await openUpload(adapter, 32)
      const code = await codeOf(
        adapter.cancel({ identity: IDENTITY, transferId: opened.transferId, generation: 9, reason: 'nope' }),
      )
      expect(code).toBe('FILE_STALE_GENERATION')
    })

    it('rejects a cancel from a different session', async () => {
      const { adapter } = build()
      const opened = await openUpload(adapter, 32)
      const code = await codeOf(
        adapter.cancel({
          identity: { ...IDENTITY, sessionUuid: 'session-9' },
          transferId: opened.transferId,
          generation: opened.generation,
          reason: 'nope',
        }),
      )
      expect(code).toBe('FILE_ACCESS_DENIED')
    })
  })

  describe('shared vault resources', () => {
    it('stores under the authorized vault namespace, not the user', async () => {
      const { adapter, storage } = build()
      const declaredSize = 16
      const opened = await openUpload(adapter, declaredSize, SHARED)
      await sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize, bytes: Buffer.alloc(declaredSize, 6) })

      for (const call of storage.calls) {
        expect(call.target.storageOwnerUuid).toBe('vault-1')
        expect(call.target.ownershipType).toBe('shared-vault')
      }
    })
  })

  describe('expiry', () => {
    it('reclaims a transfer that has outlived its ttl', async () => {
      let clock = 5_000_000
      const { adapter } = build({ transferTtlMs: 60_000, now: () => clock })
      const opened = await openUpload(adapter, 32)
      clock += 120_000
      await adapter.metadata({ identity: IDENTITY, resources: [PERSONAL] }, signal())

      const code = await codeOf(
        sendChunk(adapter, opened, { index: 0, offset: 0, declaredSize: 32, bytes: Buffer.alloc(32, 1) }),
      )
      expect(code).toBe('FILE_TRANSFER_NOT_FOUND')
    })
  })
})
