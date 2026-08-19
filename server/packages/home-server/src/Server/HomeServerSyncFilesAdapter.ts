import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, fsync, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { SyncFilesAdapter, SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

type MetadataInput = Parameters<SyncFilesAdapter['metadata']>[0]
type FileResourceReference = MetadataInput['resources'][number]
type UploadDescriptor = Parameters<SyncFilesAdapter['openUpload']>[0]['descriptor']
type FileBinaryHeader = Parameters<SyncFilesAdapter['uploadChunk']>[0]['header']

export type HomeServerFileOperation = 'metadata' | 'upload' | 'download'

export type HomeServerFileAuthorization = {
  /**
   * Canonical storage namespace. For personal files this is the authenticated
   * user UUID; for shared-vault files it is the authorized shared-vault UUID.
   */
  storageOwnerUuid: string
}

export interface HomeServerFileResourceAuthorizer {
  /**
   * Must perform a current canonical ownership/membership check. For `upload`,
   * it must also enforce the account/vault quota against `decryptedSize`.
   * Returning undefined is an explicit denial; uncertainty must deny.
   */
  authorize(
    input: {
      identity: SyncTicketIdentity
      resource: FileResourceReference
      operation: HomeServerFileOperation
      decryptedSize?: number
    },
    signal: AbortSignal,
  ): Promise<HomeServerFileAuthorization | undefined>
}

export type HomeServerSyncFilesAdapterOptions = {
  storageRoot: string
  authorizer: HomeServerFileResourceAuthorizer
  storageReady?: () => boolean
  maxActiveTransfers?: number
  transferTtlMs?: number
  now?: () => number
  createTransferId?: () => string
  createResumeId?: () => string
}

type UploadState = {
  kind: 'upload'
  identity: SyncTicketIdentity
  resource: FileResourceReference
  descriptor: UploadDescriptor
  storageOwnerUuid: string
  transferId: string
  resumeId: string
  generation: number
  nextIndex: number
  nextOffset: number
  partialPath: string
  manifestPath: string
  updatedAt: number
  completedSha256?: string
}

type DownloadState = {
  kind: 'download'
  identity: SyncTicketIdentity
  resource: FileResourceReference
  storageOwnerUuid: string
  transferId: string
  resumeId: string
  generation: number
  declaredSize: number
  nextIndex: number
  nextOffset: number
  updatedAt: number
}

type TransferState = UploadState | DownloadState
type CompletedUploadState = UploadState & { completedSha256: string }

type PersistedUploadManifest = {
  version: 1
  identity: SyncTicketIdentity
  resource: FileResourceReference
  descriptor: UploadDescriptor
  storageOwnerUuid: string
  transferId: string
  resumeId: string
  generation: number
  nextIndex: number
  nextOffset: number
  updatedAt: number
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_CHUNK_BYTES = 256 * 1024
const MAX_TRANSFER_BYTES = 5 * 1024 * 1024 * 1024
const MAX_METADATA_ENTRIES = 100
const MAX_MIME_TYPE_BYTES = 255
const MAX_PERSISTED_MANIFEST_BYTES = 64 * 1024
const DEFAULT_MAX_ACTIVE_TRANSFERS = 128
const DEFAULT_TRANSFER_TTL_MS = 15 * 60 * 1_000
const STAGING_DIRECTORY = '.sync-files-v1'

/**
 * Direct, bounded FILES_V1 adapter for the bundled Home Server.
 *
 * The files-server's HTTP use cases depend on valet-token response locals and
 * its FS multipart uploader retains every chunk in RAM. Neither contract is a
 * safe fit for a long-lived binary WebSocket. This adapter instead uses the
 * same canonical owner/resource filesystem layout directly. Upload chunks are
 * durably appended to private partial files, resumable state is persisted in a
 * small manifest, and publication is an atomic hard link that never replaces
 * existing encrypted data.
 */
export class HomeServerSyncFilesAdapter implements SyncFilesAdapter {
  private readonly transfers = new Map<string, TransferState>()
  private readonly resumeIndex = new Map<string, string>()
  private readonly completedUploads = new Map<string, CompletedUploadState>()
  private readonly transferLocks = new Map<string, Promise<void>>()
  private allocationQueue: Promise<void> = Promise.resolve()
  private readonly maxActiveTransfers: number
  private readonly transferTtlMs: number
  private readonly now: () => number
  private readonly createTransferId: () => string
  private readonly createResumeId: () => string
  private initialized = false
  private storageRoot = ''
  private stagingRoot = ''

  constructor(private readonly options: HomeServerSyncFilesAdapterOptions) {
    if (!options.storageRoot || !isAbsolute(options.storageRoot)) {
      throw new Error('A canonical file storage root is required.')
    }
    this.maxActiveTransfers = options.maxActiveTransfers ?? DEFAULT_MAX_ACTIVE_TRANSFERS
    this.transferTtlMs = options.transferTtlMs ?? DEFAULT_TRANSFER_TTL_MS
    this.now = options.now ?? Date.now
    this.createTransferId = options.createTransferId ?? randomUUID
    this.createResumeId = options.createResumeId ?? (() => randomBytes(24).toString('base64url'))
    if (!Number.isSafeInteger(this.maxActiveTransfers) || this.maxActiveTransfers < 1) {
      throw new Error('maxActiveTransfers must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.transferTtlMs) || this.transferTtlMs < 1_000) {
      throw new Error('transferTtlMs must be at least 1000ms.')
    }
  }

  async initialize(): Promise<void> {
    const requestedRoot = resolve(this.options.storageRoot)
    await fs.mkdir(requestedRoot, { recursive: true, mode: 0o700 })
    this.storageRoot = await fs.realpath(requestedRoot)
    this.stagingRoot = join(this.storageRoot, STAGING_DIRECTORY)
    await fs.mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
    await this.assertNotSymbolicLink(this.stagingRoot)
    await this.prunePersistedUploads()
    this.initialized = true
  }

  ready(): boolean {
    return this.initialized && (this.options.storageReady?.() ?? true)
  }

  async metadata(input: MetadataInput, signal: AbortSignal) {
    this.assertReady()
    await this.pruneExpiredTransfers()
    if (input.resources.length < 1 || input.resources.length > MAX_METADATA_ENTRIES) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESOURCE_INVALID')
    }
    const results = []
    for (const resource of input.resources) {
      signal.throwIfAborted()
      try {
        const authorized = await this.authorize(input.identity, resource, 'metadata', signal)
        const path = await this.resolveResourcePath(authorized.storageOwnerUuid, resource.remoteIdentifier, false)
        const stat = await fs.stat(path)
        if (!stat.isFile()) {
          throw new HomeServerSyncFilesAdapterError('FILE_NOT_FOUND')
        }
        results.push({ resource, exists: true, encryptedSize: stat.size })
      } catch (error) {
        if (isNotFound(error)) {
          results.push({ resource, exists: false })
          continue
        }
        throw error
      }
    }
    return results
  }

  async openUpload(input: { identity: SyncTicketIdentity; descriptor: UploadDescriptor }, signal: AbortSignal) {
    this.assertReady()
    await this.pruneExpiredTransfers()
    signal.throwIfAborted()
    this.assertDescriptor(input.descriptor)

    if (input.descriptor.resumeId) {
      return this.withTransferLock(input.descriptor.resumeId, async () => {
        signal.throwIfAborted()
        const authorized = await this.authorize(
          input.identity,
          input.descriptor,
          'upload',
          signal,
          input.descriptor.decryptedSize,
        )
        const resumed = await this.loadUploadByResumeId(input.descriptor.resumeId as string, signal)
        this.assertUploadResumeMatches(resumed, input.identity, input.descriptor, authorized.storageOwnerUuid)
        resumed.generation += 1
        resumed.updatedAt = this.now()
        await fs.truncate(resumed.partialPath, resumed.nextOffset)
        signal.throwIfAborted()
        await this.persistUploadManifest(resumed)
        this.remember(resumed)
        return this.uploadOpenResult(resumed)
      })
    }

    const authorized = await this.authorize(
      input.identity,
      input.descriptor,
      'upload',
      signal,
      input.descriptor.decryptedSize,
    )
    return this.withAllocationLock(async () => {
      signal.throwIfAborted()
      this.assertCapacity()
      const transferId = this.validGeneratedIdentifier(this.createTransferId(), 'transfer')
      const resumeId = this.validGeneratedIdentifier(this.createResumeId(), 'resume')
      const partialPath = join(this.stagingRoot, `${resumeId}.partial`)
      const manifestPath = join(this.stagingRoot, `${resumeId}.json`)
      const handle = await fs.open(partialPath, 'wx', 0o600)
      await handle.close()

      const state: UploadState = {
        kind: 'upload',
        identity: this.transferIdentity(input.identity),
        resource: this.copyResource(input.descriptor),
        descriptor: { ...input.descriptor, resumeId },
        storageOwnerUuid: authorized.storageOwnerUuid,
        transferId,
        resumeId,
        generation: 1,
        nextIndex: 0,
        nextOffset: 0,
        partialPath,
        manifestPath,
        updatedAt: this.now(),
      }
      try {
        signal.throwIfAborted()
        await this.persistUploadManifest(state)
        signal.throwIfAborted()
        this.remember(state)
        return this.uploadOpenResult(state)
      } catch (error) {
        await fs.rm(partialPath, { force: true }).catch(() => undefined)
        await fs.rm(manifestPath, { force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  async uploadChunk(
    input: { identity: SyncTicketIdentity; header: FileBinaryHeader; bytes: Uint8Array },
    signal: AbortSignal,
  ) {
    this.assertReady()
    signal.throwIfAborted()
    const lockKey = this.lockKeyForTransfer(input.header.transferId, 'upload')
    return this.withTransferLock(lockKey, async () => {
      signal.throwIfAborted()
      const state = this.currentUpload(input.identity, input.header.transferId, input.header.generation)
      await this.authorize(input.identity, state.resource, 'upload', signal, state.descriptor.decryptedSize)
      this.assertUploadHeader(state, input.header, input.bytes)

      if (input.header.index < state.nextIndex) {
        await this.verifyDuplicateChunk(state, input.header, input.bytes, signal)
        state.updatedAt = this.now()
        return {
          duplicate: true,
          nextIndex: state.nextIndex,
          nextOffset: state.nextOffset,
          resumeId: state.resumeId,
        }
      }
      if (input.header.index !== state.nextIndex || input.header.offset !== state.nextOffset) {
        throw new HomeServerSyncFilesAdapterError('FILE_CHUNK_OUT_OF_ORDER')
      }

      const handle = await fs.open(state.partialPath, 'r+')
      try {
        await this.writeAll(handle, input.bytes, input.header.offset, signal)
        await this.syncHandle(handle)
      } finally {
        await handle.close()
      }
      signal.throwIfAborted()
      state.nextIndex += 1
      state.nextOffset += input.bytes.byteLength
      state.updatedAt = this.now()
      await this.persistUploadManifest(state)
      return {
        duplicate: false,
        nextIndex: state.nextIndex,
        nextOffset: state.nextOffset,
        resumeId: state.resumeId,
      }
    })
  }

  async finishUpload(
    input: {
      identity: SyncTicketIdentity
      transferId: string
      generation: number
      declaredSize: number
      sha256: string
    },
    signal: AbortSignal,
  ) {
    this.assertReady()
    signal.throwIfAborted()
    const lockKey = this.lockKeyForTransfer(input.transferId, 'upload', true)
    return this.withTransferLock(lockKey, async () => {
      signal.throwIfAborted()
      const state = this.currentUploadForFinish(input.identity, input.transferId, input.generation)
      await this.authorize(input.identity, state.resource, 'upload', signal, state.descriptor.decryptedSize)
      if (state.completedSha256) {
        if (state.completedSha256 !== input.sha256 || input.declaredSize !== state.descriptor.declaredSize) {
          throw new HomeServerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
        }
        state.updatedAt = this.now()
        this.rememberCompletedUpload(state as CompletedUploadState)
        return { sha256: state.completedSha256 }
      }
      if (
        input.declaredSize !== state.descriptor.declaredSize ||
        state.nextOffset !== state.descriptor.declaredSize ||
        !SHA256_PATTERN.test(input.sha256)
      ) {
        throw new HomeServerSyncFilesAdapterError('FILE_INCOMPLETE')
      }

      const actualSha256 = await this.hashFile(state.partialPath, signal)
      if (actualSha256 !== input.sha256) {
        throw new HomeServerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
      }
      const destination = await this.resolveResourcePath(state.storageOwnerUuid, state.resource.remoteIdentifier, true)
      signal.throwIfAborted()
      try {
        await fs.link(state.partialPath, destination)
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error
        }
        const existingSha256 = await this.hashFile(destination, signal)
        const existingStat = await fs.stat(destination)
        if (existingSha256 !== actualSha256 || existingStat.size !== state.descriptor.declaredSize) {
          throw new HomeServerSyncFilesAdapterError('FILE_DESTINATION_CONFLICT')
        }
      }
      await this.syncDirectory(resolve(destination, '..'))
      state.completedSha256 = actualSha256
      state.updatedAt = this.now()
      await fs.rm(state.partialPath, { force: true })
      await fs.rm(state.manifestPath, { force: true })
      this.rememberCompletedUpload(state as CompletedUploadState)
      return { sha256: actualSha256 }
    })
  }

  async openDownload(
    input: {
      identity: SyncTicketIdentity
      resource: FileResourceReference
      offset: number
      resumeId?: string
    },
    signal: AbortSignal,
  ) {
    this.assertReady()
    await this.pruneExpiredTransfers()
    signal.throwIfAborted()
    this.assertResource(input.resource)
    const open = async () => {
      signal.throwIfAborted()
      const authorized = await this.authorize(input.identity, input.resource, 'download', signal)
      let stat
      try {
        const path = await this.resolveResourcePath(authorized.storageOwnerUuid, input.resource.remoteIdentifier, false)
        stat = await fs.stat(path)
      } catch (error) {
        if (isNotFound(error)) {
          throw new HomeServerSyncFilesAdapterError('FILE_NOT_FOUND')
        }
        throw error
      }
      if (!stat.isFile() || input.offset < 0 || input.offset >= stat.size) {
        throw new HomeServerSyncFilesAdapterError('FILE_RANGE_INVALID')
      }

      let state: DownloadState
      if (input.resumeId) {
        const transferId = this.resumeIndex.get(input.resumeId)
        const existing = transferId ? this.transfers.get(transferId) : undefined
        if (!existing || existing.kind !== 'download') {
          throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
        }
        this.assertIdentity(existing.identity, input.identity)
        if (
          !this.resourcesEqual(existing.resource, input.resource) ||
          existing.storageOwnerUuid !== authorized.storageOwnerUuid ||
          existing.declaredSize !== stat.size
        ) {
          throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
        }
        existing.generation += 1
        existing.nextIndex = 0
        existing.nextOffset = input.offset
        existing.updatedAt = this.now()
        state = existing
      } else {
        state = await this.withAllocationLock(async () => {
          signal.throwIfAborted()
          this.assertCapacity()
          const allocated: DownloadState = {
            kind: 'download',
            identity: this.transferIdentity(input.identity),
            resource: this.copyResource(input.resource),
            storageOwnerUuid: authorized.storageOwnerUuid,
            transferId: this.validGeneratedIdentifier(this.createTransferId(), 'transfer'),
            resumeId: this.validGeneratedIdentifier(this.createResumeId(), 'resume'),
            generation: 1,
            declaredSize: stat.size,
            nextIndex: 0,
            nextOffset: input.offset,
            updatedAt: this.now(),
          }
          this.remember(allocated)
          return allocated
        })
      }
      return {
        transferId: state.transferId,
        generation: state.generation,
        resumeId: state.resumeId,
        declaredSize: stat.size,
        nextIndex: state.nextIndex,
        nextOffset: state.nextOffset,
      }
    }
    if (input.resumeId) {
      if (!IDENTIFIER_PATTERN.test(input.resumeId)) {
        throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
      }
      return this.withTransferLock(input.resumeId, open)
    }
    return open()
  }

  async readDownloadChunk(
    input: {
      identity: SyncTicketIdentity
      transferId: string
      generation: number
      index: number
      offset: number
      maxBytes: number
    },
    signal: AbortSignal,
  ) {
    this.assertReady()
    signal.throwIfAborted()
    const lockKey = this.lockKeyForTransfer(input.transferId, 'download')
    return this.withTransferLock(lockKey, async () => {
      signal.throwIfAborted()
      const state = this.currentDownload(input.identity, input.transferId, input.generation)
      await this.authorize(input.identity, state.resource, 'download', signal)
      if (
        input.index !== state.nextIndex ||
        input.offset !== state.nextOffset ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > MAX_CHUNK_BYTES
      ) {
        throw new HomeServerSyncFilesAdapterError('FILE_CHUNK_OUT_OF_ORDER')
      }
      const length = Math.min(input.maxBytes, state.declaredSize - state.nextOffset)
      if (length < 1) {
        throw new HomeServerSyncFilesAdapterError('FILE_RANGE_INVALID')
      }
      const path = await this.resolveResourcePath(state.storageOwnerUuid, state.resource.remoteIdentifier, false)
      const handle = await fs.open(path, 'r')
      const bytes = new Uint8Array(length)
      let bytesRead = 0
      try {
        while (bytesRead < length) {
          signal.throwIfAborted()
          const result = await handle.read(bytes, bytesRead, length - bytesRead, state.nextOffset + bytesRead)
          if (result.bytesRead === 0) {
            throw new HomeServerSyncFilesAdapterError('FILE_TRUNCATED')
          }
          bytesRead += result.bytesRead
        }
      } finally {
        await handle.close()
      }
      signal.throwIfAborted()
      const result = {
        index: state.nextIndex,
        offset: state.nextOffset,
        declaredSize: state.declaredSize,
        bytes,
        final: state.nextOffset + bytes.byteLength === state.declaredSize,
      }
      state.nextIndex += 1
      state.nextOffset += bytes.byteLength
      state.updatedAt = this.now()
      if (result.final) {
        await this.removeState(state)
      }
      return result
    })
  }

  async cancel(input: {
    identity: SyncTicketIdentity
    transferId: string
    generation: number
    reason: string
  }): Promise<void> {
    this.assertReady()
    const lockKey = this.lockKeyForTransfer(input.transferId, undefined, true)
    await this.withTransferLock(lockKey, async () => {
      const state = this.transfers.get(input.transferId) ?? this.completedUploads.get(input.transferId)
      if (!state) {
        throw new HomeServerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
      }
      this.assertIdentity(state.identity, input.identity)
      if (state.generation !== input.generation) {
        throw new HomeServerSyncFilesAdapterError('FILE_STALE_GENERATION')
      }
      await this.removeState(state)
    })
  }

  private async authorize(
    identity: SyncTicketIdentity,
    resource: FileResourceReference,
    operation: HomeServerFileOperation,
    signal: AbortSignal,
    decryptedSize?: number,
  ): Promise<HomeServerFileAuthorization> {
    signal.throwIfAborted()
    const authorization = await this.options.authorizer.authorize(
      { identity, resource, operation, ...(decryptedSize === undefined ? {} : { decryptedSize }) },
      signal,
    )
    signal.throwIfAborted()
    if (!authorization || !IDENTIFIER_PATTERN.test(authorization.storageOwnerUuid)) {
      throw new HomeServerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    if (resource.ownershipType === 'user' && authorization.storageOwnerUuid !== identity.userUuid) {
      throw new HomeServerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    if (resource.ownershipType === 'shared-vault' && authorization.storageOwnerUuid !== resource.sharedVaultUuid) {
      throw new HomeServerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    return authorization
  }

  private async resolveResourcePath(ownerUuid: string, remoteIdentifier: string, createOwner: boolean) {
    if (!IDENTIFIER_PATTERN.test(ownerUuid) || !IDENTIFIER_PATTERN.test(remoteIdentifier)) {
      throw new HomeServerSyncFilesAdapterError('FILE_PATH_INVALID')
    }
    const ownerPath = this.pathInsideRoot(ownerUuid)
    if (createOwner) {
      await fs.mkdir(ownerPath, { recursive: true, mode: 0o700 })
    }
    await this.assertNotSymbolicLink(ownerPath)
    const resourcePath = this.pathInsideRoot(ownerUuid, remoteIdentifier)
    try {
      await this.assertNotSymbolicLink(resourcePath)
    } catch (error) {
      if (!isNotFound(error)) {
        throw error
      }
    }
    return resourcePath
  }

  private pathInsideRoot(...segments: string[]): string {
    const candidate = resolve(this.storageRoot, ...segments)
    const relativePath = relative(this.storageRoot, candidate)
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new HomeServerSyncFilesAdapterError('FILE_PATH_INVALID')
    }
    return candidate
  }

  private async assertNotSymbolicLink(path: string): Promise<void> {
    const stat = await fs.lstat(path)
    if (stat.isSymbolicLink()) {
      throw new HomeServerSyncFilesAdapterError('FILE_PATH_INVALID')
    }
  }

  private assertUploadHeader(state: UploadState, header: FileBinaryHeader, bytes: Uint8Array): void {
    if (
      header.kind !== 'UPLOAD_CHUNK' ||
      header.declaredSize !== state.descriptor.declaredSize ||
      header.byteLength !== bytes.byteLength ||
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_CHUNK_BYTES ||
      header.offset + bytes.byteLength > state.descriptor.declaredSize ||
      !SHA256_PATTERN.test(header.sha256) ||
      createHash('sha256').update(bytes).digest('hex') !== header.sha256 ||
      header.final !== (header.offset + bytes.byteLength === state.descriptor.declaredSize)
    ) {
      throw new HomeServerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
    }
  }

  private async verifyDuplicateChunk(
    state: UploadState,
    header: FileBinaryHeader,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    if (header.offset + bytes.byteLength > state.nextOffset) {
      throw new HomeServerSyncFilesAdapterError('FILE_CHUNK_OUT_OF_ORDER')
    }
    const handle = await fs.open(state.partialPath, 'r')
    const existing = new Uint8Array(bytes.byteLength)
    try {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(existing, 0, existing.byteLength, header.offset)
      if (bytesRead !== existing.byteLength || createHash('sha256').update(existing).digest('hex') !== header.sha256) {
        throw new HomeServerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
      }
    } finally {
      existing.fill(0)
      await handle.close()
    }
  }

  private async writeAll(handle: FileHandle, bytes: Uint8Array, offset: number, signal: AbortSignal) {
    let written = 0
    while (written < bytes.byteLength) {
      signal.throwIfAborted()
      const result = await handle.write(bytes, written, bytes.byteLength - written, offset + written)
      if (result.bytesWritten < 1) {
        throw new HomeServerSyncFilesAdapterError('FILE_BACKEND_ERROR')
      }
      written += result.bytesWritten
    }
  }

  private async hashFile(path: string, signal: AbortSignal): Promise<string> {
    const handle = await fs.open(path, 'r')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(MAX_CHUNK_BYTES)
    let position = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
        if (bytesRead === 0) {
          break
        }
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
      return hash.digest('hex')
    } finally {
      buffer.fill(0)
      await handle.close()
    }
  }

  private async persistUploadManifest(state: UploadState): Promise<void> {
    const manifest: PersistedUploadManifest = {
      version: 1,
      identity: state.identity,
      resource: state.resource,
      descriptor: state.descriptor,
      storageOwnerUuid: state.storageOwnerUuid,
      transferId: state.transferId,
      resumeId: state.resumeId,
      generation: state.generation,
      nextIndex: state.nextIndex,
      nextOffset: state.nextOffset,
      updatedAt: state.updatedAt,
    }
    const temporaryPath = `${state.manifestPath}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await fs.open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(manifest), 'utf8')
      await this.syncHandle(handle)
    } finally {
      await handle.close()
    }
    try {
      await fs.rename(temporaryPath, state.manifestPath)
      await this.syncDirectory(this.stagingRoot)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async loadUploadByResumeId(resumeId: string, signal: AbortSignal): Promise<UploadState> {
    if (!IDENTIFIER_PATTERN.test(resumeId)) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
    const rememberedId = this.resumeIndex.get(resumeId)
    const remembered = rememberedId ? this.transfers.get(rememberedId) : undefined
    if (remembered?.kind === 'upload') {
      return remembered
    }
    return this.withAllocationLock(async () => {
      signal.throwIfAborted()
      const concurrentlyRememberedId = this.resumeIndex.get(resumeId)
      const concurrentlyRemembered = concurrentlyRememberedId ? this.transfers.get(concurrentlyRememberedId) : undefined
      if (concurrentlyRemembered?.kind === 'upload') {
        return concurrentlyRemembered
      }
      this.assertCapacity()
      const manifestPath = join(this.stagingRoot, `${resumeId}.json`)
      const partialPath = join(this.stagingRoot, `${resumeId}.partial`)
      const manifest = await this.readPersistedUploadManifest(manifestPath, resumeId)
      if (manifest.updatedAt + this.transferTtlMs <= this.now()) {
        await fs.rm(manifestPath, { force: true })
        await fs.rm(partialPath, { force: true })
        throw new HomeServerSyncFilesAdapterError('FILE_RESUME_EXPIRED')
      }
      await this.assertNotSymbolicLink(partialPath)
      const stat = await fs.stat(partialPath)
      if (!stat.isFile() || stat.size < manifest.nextOffset) {
        throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
      }
      const state: UploadState = {
        kind: 'upload',
        ...manifest,
        partialPath,
        manifestPath,
      }
      signal.throwIfAborted()
      this.remember(state)
      return state
    })
  }

  private parseManifest(value: unknown, expectedResumeId: string): PersistedUploadManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
    const manifest = value as Partial<PersistedUploadManifest>
    if (
      manifest.version !== 1 ||
      !manifest.identity ||
      typeof manifest.identity.userUuid !== 'string' ||
      typeof manifest.identity.sessionUuid !== 'string' ||
      typeof manifest.identity.deviceId !== 'string' ||
      manifest.identity.authorization !== undefined ||
      !manifest.resource ||
      !manifest.descriptor ||
      !IDENTIFIER_PATTERN.test(manifest.storageOwnerUuid ?? '') ||
      !IDENTIFIER_PATTERN.test(manifest.transferId ?? '') ||
      manifest.resumeId !== expectedResumeId ||
      !Number.isSafeInteger(manifest.generation) ||
      Number(manifest.generation) < 1 ||
      !Number.isSafeInteger(manifest.nextIndex) ||
      Number(manifest.nextIndex) < 0 ||
      !Number.isSafeInteger(manifest.nextOffset) ||
      Number(manifest.nextOffset) < 0 ||
      Number(manifest.nextOffset) > Number(manifest.descriptor.declaredSize) ||
      !Number.isSafeInteger(manifest.updatedAt) ||
      Number(manifest.updatedAt) < 0
    ) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
    this.assertResource(manifest.resource)
    this.assertDescriptor(manifest.descriptor)
    return manifest as PersistedUploadManifest
  }

  private async prunePersistedUploads(): Promise<void> {
    const names = await fs.readdir(this.stagingRoot)
    const candidates: Array<{
      resumeId: string
      manifestPath: string
      partialPath: string
      updatedAt: number
    }> = []
    const manifests = names.filter((name) => name.endsWith('.json'))
    for (const name of manifests) {
      const resumeId = name.slice(0, -'.json'.length)
      const manifestPath = join(this.stagingRoot, name)
      const partialPath = join(this.stagingRoot, `${resumeId}.partial`)
      try {
        const parsed = await this.readPersistedUploadManifest(manifestPath, resumeId)
        if (parsed.updatedAt + this.transferTtlMs <= this.now()) {
          throw new HomeServerSyncFilesAdapterError('FILE_RESUME_EXPIRED')
        }
        await this.assertNotSymbolicLink(partialPath)
        const partial = await fs.stat(partialPath)
        if (!partial.isFile() || partial.size < parsed.nextOffset) {
          throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
        }
        candidates.push({ resumeId, manifestPath, partialPath, updatedAt: parsed.updatedAt })
      } catch {
        await fs.rm(manifestPath, { force: true })
        await fs.rm(partialPath, { force: true })
      }
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.resumeId.localeCompare(right.resumeId))
    const retainedResumeIds = new Set<string>()
    for (const [index, candidate] of candidates.entries()) {
      if (index >= this.maxActiveTransfers) {
        await fs.rm(candidate.manifestPath, { force: true })
        await fs.rm(candidate.partialPath, { force: true })
      } else {
        retainedResumeIds.add(candidate.resumeId)
      }
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await fs.rm(join(this.stagingRoot, name), { force: true })
      } else if (name.endsWith('.partial') && !retainedResumeIds.has(name.slice(0, -'.partial'.length))) {
        await fs.rm(join(this.stagingRoot, name), { force: true })
      }
    }
  }

  private async readPersistedUploadManifest(manifestPath: string, resumeId: string): Promise<PersistedUploadManifest> {
    try {
      await this.assertNotSymbolicLink(manifestPath)
      const handle = await fs.open(manifestPath, constants.O_RDONLY)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size < 2 || stat.size > MAX_PERSISTED_MANIFEST_BYTES) {
          throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
        }
        return this.parseManifest(JSON.parse(await handle.readFile('utf8')), resumeId)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof HomeServerSyncFilesAdapterError) {
        throw error
      }
      throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
  }

  private async pruneExpiredTransfers(): Promise<void> {
    const cutoff = this.now() - this.transferTtlMs
    for (const state of [...this.transfers.values()]) {
      if (state.updatedAt <= cutoff) {
        await this.withTransferLock(state.resumeId, async () => {
          const current = this.transfers.get(state.transferId)
          if (current === state && current.updatedAt <= cutoff) {
            await this.removeState(current)
          }
        })
      }
    }
    for (const state of [...this.completedUploads.values()]) {
      if (state.updatedAt <= cutoff) {
        await this.withTransferLock(state.resumeId, async () => {
          const current = this.completedUploads.get(state.transferId)
          if (current === state && current.updatedAt <= cutoff) {
            this.completedUploads.delete(current.transferId)
          }
        })
      }
    }
  }

  private assertCapacity(): void {
    if (this.transfers.size >= this.maxActiveTransfers) {
      throw new HomeServerSyncFilesAdapterError('FILE_TRANSFER_CAPACITY')
    }
  }

  private async withAllocationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.allocationQueue
    let release = (): void => undefined
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock
    })
    this.allocationQueue = previous.catch(() => undefined).then(() => current)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private remember(state: TransferState): void {
    this.transfers.set(state.transferId, state)
    this.resumeIndex.set(state.resumeId, state.transferId)
  }

  private rememberCompletedUpload(state: CompletedUploadState): void {
    this.transfers.delete(state.transferId)
    this.resumeIndex.delete(state.resumeId)
    this.completedUploads.delete(state.transferId)
    this.completedUploads.set(state.transferId, state)
    while (this.completedUploads.size > this.maxActiveTransfers) {
      const oldestTransferId = this.completedUploads.keys().next().value as string | undefined
      if (!oldestTransferId) {
        break
      }
      this.completedUploads.delete(oldestTransferId)
    }
  }

  private lockKeyForTransfer(transferId: string, kind?: TransferState['kind'], includeCompleted = false): string {
    const state =
      this.transfers.get(transferId) ?? (includeCompleted ? this.completedUploads.get(transferId) : undefined)
    if (!state || (kind !== undefined && state.kind !== kind)) {
      throw new HomeServerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
    }
    return state.resumeId
  }

  private async withTransferLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.transferLocks.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.transferLocks.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.transferLocks.get(key) === tail) {
        this.transferLocks.delete(key)
      }
    }
  }

  private async removeState(state: TransferState): Promise<void> {
    this.transfers.delete(state.transferId)
    this.resumeIndex.delete(state.resumeId)
    this.completedUploads.delete(state.transferId)
    if (state.kind === 'upload' && !state.completedSha256) {
      await fs.rm(state.partialPath, { force: true })
      await fs.rm(state.manifestPath, { force: true })
    }
  }

  private currentUpload(identity: SyncTicketIdentity, transferId: string, generation: number): UploadState {
    const state = this.transfers.get(transferId)
    if (!state || state.kind !== 'upload') {
      throw new HomeServerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
    }
    this.assertIdentity(state.identity, identity)
    if (state.generation !== generation) {
      throw new HomeServerSyncFilesAdapterError('FILE_STALE_GENERATION')
    }
    return state
  }

  private currentUploadForFinish(identity: SyncTicketIdentity, transferId: string, generation: number): UploadState {
    const state = this.transfers.get(transferId) ?? this.completedUploads.get(transferId)
    if (!state || state.kind !== 'upload') {
      throw new HomeServerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
    }
    this.assertIdentity(state.identity, identity)
    if (state.generation !== generation) {
      throw new HomeServerSyncFilesAdapterError('FILE_STALE_GENERATION')
    }
    return state
  }

  private currentDownload(identity: SyncTicketIdentity, transferId: string, generation: number): DownloadState {
    const state = this.transfers.get(transferId)
    if (!state || state.kind !== 'download') {
      throw new HomeServerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
    }
    this.assertIdentity(state.identity, identity)
    if (state.generation !== generation) {
      throw new HomeServerSyncFilesAdapterError('FILE_STALE_GENERATION')
    }
    return state
  }

  private assertUploadResumeMatches(
    state: UploadState,
    identity: SyncTicketIdentity,
    descriptor: UploadDescriptor,
    storageOwnerUuid: string,
  ): void {
    this.assertIdentity(state.identity, identity)
    const expected = { ...descriptor, resumeId: state.resumeId }
    if (!this.resourcesEqual(state.descriptor, expected) || state.storageOwnerUuid !== storageOwnerUuid) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
    if (
      state.descriptor.decryptedSize !== descriptor.decryptedSize ||
      state.descriptor.declaredSize !== descriptor.declaredSize ||
      state.descriptor.mimeType !== descriptor.mimeType
    ) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
  }

  private assertIdentity(expected: SyncTicketIdentity, actual: SyncTicketIdentity): void {
    if (
      expected.userUuid !== actual.userUuid ||
      expected.sessionUuid !== actual.sessionUuid ||
      expected.deviceId !== actual.deviceId
    ) {
      throw new HomeServerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
  }

  private transferIdentity(identity: SyncTicketIdentity): SyncTicketIdentity {
    return {
      userUuid: identity.userUuid,
      sessionUuid: identity.sessionUuid,
      deviceId: identity.deviceId,
    }
  }

  private assertResource(resource: FileResourceReference): void {
    if (
      (resource.ownershipType !== 'user' && resource.ownershipType !== 'shared-vault') ||
      !IDENTIFIER_PATTERN.test(resource.remoteIdentifier) ||
      (resource.fileUuid !== undefined && !IDENTIFIER_PATTERN.test(resource.fileUuid)) ||
      (resource.ownershipType === 'user' &&
        (resource.sharedVaultUuid !== undefined || resource.sharedVaultOwnerUuid !== undefined)) ||
      (resource.ownershipType === 'shared-vault' &&
        (!resource.sharedVaultUuid ||
          !IDENTIFIER_PATTERN.test(resource.sharedVaultUuid) ||
          !resource.sharedVaultOwnerUuid ||
          !IDENTIFIER_PATTERN.test(resource.sharedVaultOwnerUuid)))
    ) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESOURCE_INVALID')
    }
  }

  private assertDescriptor(descriptor: UploadDescriptor): void {
    this.assertResource(descriptor)
    if (
      !Number.isSafeInteger(descriptor.decryptedSize) ||
      descriptor.decryptedSize < 1 ||
      descriptor.decryptedSize > MAX_TRANSFER_BYTES ||
      !Number.isSafeInteger(descriptor.declaredSize) ||
      descriptor.declaredSize < 1 ||
      descriptor.declaredSize > MAX_TRANSFER_BYTES ||
      typeof descriptor.mimeType !== 'string' ||
      descriptor.mimeType.length < 1 ||
      Buffer.byteLength(descriptor.mimeType, 'utf8') > MAX_MIME_TYPE_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(descriptor.mimeType) ||
      (descriptor.resumeId !== undefined && !IDENTIFIER_PATTERN.test(descriptor.resumeId))
    ) {
      throw new HomeServerSyncFilesAdapterError('FILE_RESOURCE_INVALID')
    }
  }

  private resourcesEqual(left: FileResourceReference, right: FileResourceReference): boolean {
    return (
      left.ownershipType === right.ownershipType &&
      left.remoteIdentifier === right.remoteIdentifier &&
      left.fileUuid === right.fileUuid &&
      left.sharedVaultUuid === right.sharedVaultUuid &&
      left.sharedVaultOwnerUuid === right.sharedVaultOwnerUuid
    )
  }

  private copyResource(resource: FileResourceReference): FileResourceReference {
    return {
      ownershipType: resource.ownershipType,
      remoteIdentifier: resource.remoteIdentifier,
      ...(resource.fileUuid ? { fileUuid: resource.fileUuid } : {}),
      ...(resource.sharedVaultUuid ? { sharedVaultUuid: resource.sharedVaultUuid } : {}),
      ...(resource.sharedVaultOwnerUuid ? { sharedVaultOwnerUuid: resource.sharedVaultOwnerUuid } : {}),
    }
  }

  private uploadOpenResult(state: UploadState) {
    return {
      transferId: state.transferId,
      generation: state.generation,
      resumeId: state.resumeId,
      nextIndex: state.nextIndex,
      nextOffset: state.nextOffset,
      declaredSize: state.descriptor.declaredSize,
    }
  }

  private validGeneratedIdentifier(value: string, label: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new Error(`Generated ${label} identifier is invalid.`)
    }
    return value
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await fs.open(path, constants.O_RDONLY)
    try {
      try {
        await this.syncHandle(handle)
      } catch (error) {
        // Windows does not support fsync on directory handles. File contents
        // and manifests are still fsynced before publication.
        if (!isUnsupportedDirectorySync(error)) {
          throw error
        }
      }
    } finally {
      await handle.close()
    }
  }

  private syncHandle(handle: FileHandle): Promise<void> {
    return new Promise((resolveSync, reject) => {
      fsync(handle.fd, (error) => (error ? reject(error) : resolveSync()))
    })
  }

  private assertReady(): void {
    if (!this.ready()) {
      throw new HomeServerSyncFilesAdapterError('OPERATION_UNAVAILABLE')
    }
  }
}

export class HomeServerSyncFilesAdapterError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'HomeServerSyncFilesAdapterError'
  }
}

function isNotFound(error: unknown): boolean {
  return (
    (error instanceof HomeServerSyncFilesAdapterError && error.code === 'FILE_NOT_FOUND') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT')
  )
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== 'win32' || typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP'
}
