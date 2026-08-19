import { createHash, randomBytes, randomUUID, timingSafeEqual, type Hash } from 'node:crypto'

import type { SyncFilesAdapter, SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

type MetadataInput = Parameters<SyncFilesAdapter['metadata']>[0]
type FileResourceReference = MetadataInput['resources'][number]
type UploadDescriptor = Parameters<SyncFilesAdapter['openUpload']>[0]['descriptor']
type FileBinaryHeader = Parameters<SyncFilesAdapter['uploadChunk']>[0]['header']

export type MultiContainerFileOperation = 'metadata' | 'upload' | 'download'

/**
 * The outcome of a single authorization decision.
 *
 * Unlike the home server — which only needs to learn the canonical storage
 * namespace and can then touch its own disk — the distributed deployment has no
 * trust path to the files service other than the valet credential itself. So an
 * authorization here is BOTH a decision and the bearer credential that carries
 * that decision to storage. A `valetToken` is minted per operation, presented
 * once, and never reused.
 */
export type MultiContainerFileAuthorization = {
  /**
   * Canonical storage namespace. For personal files this is the authenticated
   * user UUID; for shared-vault files it is the authorized shared-vault UUID.
   */
  storageOwnerUuid: string
  /** Freshly minted, single-use valet credential for exactly this operation. */
  valetToken: string
}

export interface MultiContainerFileResourceAuthorizer {
  /**
   * Must perform a current canonical ownership/membership check and mint a
   * FRESH valet credential scoped to this resource and operation. For `upload`
   * it must also enforce the account/vault quota against `decryptedSize`.
   * Returning undefined is an explicit denial; uncertainty must deny.
   */
  authorize(
    input: {
      identity: SyncTicketIdentity
      resource: FileResourceReference
      operation: MultiContainerFileOperation
      decryptedSize?: number
    },
    signal: AbortSignal,
  ): Promise<MultiContainerFileAuthorization | undefined>
}

/**
 * Everything the storage boundary needs. The owner UUID is carried for local
 * state binding only — the files service derives the effective namespace from
 * the signed valet token, never from anything this process asserts.
 */
export type MultiContainerFileStorageTarget = {
  ownershipType: FileResourceReference['ownershipType']
  storageOwnerUuid: string
  remoteIdentifier: string
  valetToken: string
}

export type MultiContainerFileRangeResult = {
  bytes: Uint8Array
  totalSize: number
}

/**
 * The distributed storage boundary. Every method requires a valet credential;
 * there is deliberately no method that can be reached without one.
 */
export interface MultiContainerFileStoragePort {
  ready(): boolean
  /** Resolves to undefined when the resource does not exist. */
  probeSize(target: MultiContainerFileStorageTarget, signal: AbortSignal): Promise<number | undefined>
  createUploadSession(target: MultiContainerFileStorageTarget, signal: AbortSignal): Promise<void>
  uploadPart(
    input: { target: MultiContainerFileStorageTarget; partNumber: number; bytes: Uint8Array },
    signal: AbortSignal,
  ): Promise<void>
  closeUploadSession(target: MultiContainerFileStorageTarget, signal: AbortSignal): Promise<void>
  readRange(
    input: { target: MultiContainerFileStorageTarget; offset: number; length: number },
    signal: AbortSignal,
  ): Promise<MultiContainerFileRangeResult>
}

export type MultiContainerSyncFilesAdapterOptions = {
  authorizer: MultiContainerFileResourceAuthorizer
  storage: MultiContainerFileStoragePort
  maxActiveTransfers?: number
  maxActiveUploads?: number
  storagePartBytes?: number
  transferTtlMs?: number
  duplicateHistoryChunks?: number
  presentedTokenHistory?: number
  now?: () => number
  createTransferId?: () => string
  createResumeId?: () => string
}

type ChunkLedgerEntry = {
  offset: number
  byteLength: number
  sha256: string
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
  /** Next wire chunk index expected from the client. */
  nextIndex: number
  /** Bytes accepted from the client (buffered or flushed). */
  nextOffset: number
  /** Wire index at the last storage part boundary. */
  flushedIndex: number
  /** Bytes durably handed to the files service. */
  flushedOffset: number
  /** 1-based storage part number; the files service rejects a zero chunk id. */
  nextPartNumber: number
  pending: Buffer[]
  pendingBytes: number
  digest: Hash
  flushedDigest: Hash
  chunkLedger: Map<number, ChunkLedgerEntry>
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

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_CHUNK_BYTES = 256 * 1024
const MAX_TRANSFER_BYTES = 5 * 1024 * 1024 * 1024
const MAX_METADATA_ENTRIES = 100
const MAX_MIME_TYPE_BYTES = 255
const MAX_VALET_TOKEN_LENGTH = 8 * 1024
/** S3 rejects a non-final multipart part below 5 MiB, so parts are never smaller. */
const MIN_STORAGE_PART_BYTES = 5 * 1024 * 1024
const MAX_STORAGE_PART_BYTES = 64 * 1024 * 1024
const DEFAULT_STORAGE_PART_BYTES = MIN_STORAGE_PART_BYTES
const DEFAULT_MAX_ACTIVE_TRANSFERS = 64
const DEFAULT_MAX_ACTIVE_UPLOADS = 16
const DEFAULT_TRANSFER_TTL_MS = 15 * 60 * 1_000
const DEFAULT_DUPLICATE_HISTORY_CHUNKS = 512
const DEFAULT_PRESENTED_TOKEN_HISTORY = 4_096

/**
 * Bounded FILES_V1 adapter for the MULTI-CONTAINER deployment.
 *
 * The home server owns the canonical bytes on a local filesystem and can trust
 * in-process state; this deployment owns neither. The files service holds the
 * bytes (S3 or its own volume) and will only act on a signed valet credential,
 * and Auth/Syncing — the only components that can mint one — are reached over
 * the network. So this adapter differs from the home-server adapter in exactly
 * three places, and is otherwise semantically identical:
 *
 *  1. Authority is a per-operation valet credential rather than a directory
 *     path. Nothing is inferred from the socket: every operation re-authorizes,
 *     mints a fresh token, and a token is never presented to storage twice.
 *  2. Wire chunks (<=256 KiB) are coalesced into >=5 MiB storage parts, because
 *     distributed multipart storage rejects smaller non-final parts. The
 *     coalescing buffer is the only byte state this process keeps, and it is
 *     bounded by `maxActiveUploads * (storagePartBytes + MAX_CHUNK_BYTES)`.
 *  3. Resumable state is in-memory only. There is no local disk to persist a
 *     manifest to, so a resume rewinds to the last storage part boundary and a
 *     process restart invalidates outstanding resume ids (FILE_RESUME_INVALID).
 */
export class MultiContainerSyncFilesAdapter implements SyncFilesAdapter {
  private readonly transfers = new Map<string, TransferState>()
  private readonly resumeIndex = new Map<string, string>()
  private readonly completedUploads = new Map<string, CompletedUploadState>()
  private readonly transferLocks = new Map<string, Promise<void>>()
  private readonly presentedTokens = new Set<string>()
  private readonly expiredResumeIds = new Set<string>()
  private allocationQueue: Promise<void> = Promise.resolve()
  private readonly maxActiveTransfers: number
  private readonly maxActiveUploads: number
  private readonly storagePartBytes: number
  private readonly transferTtlMs: number
  private readonly duplicateHistoryChunks: number
  private readonly presentedTokenHistory: number
  private readonly now: () => number
  private readonly createTransferId: () => string
  private readonly createResumeId: () => string

  constructor(private readonly options: MultiContainerSyncFilesAdapterOptions) {
    this.maxActiveTransfers = options.maxActiveTransfers ?? DEFAULT_MAX_ACTIVE_TRANSFERS
    this.maxActiveUploads = options.maxActiveUploads ?? DEFAULT_MAX_ACTIVE_UPLOADS
    this.storagePartBytes = options.storagePartBytes ?? DEFAULT_STORAGE_PART_BYTES
    this.transferTtlMs = options.transferTtlMs ?? DEFAULT_TRANSFER_TTL_MS
    this.duplicateHistoryChunks = options.duplicateHistoryChunks ?? DEFAULT_DUPLICATE_HISTORY_CHUNKS
    this.presentedTokenHistory = options.presentedTokenHistory ?? DEFAULT_PRESENTED_TOKEN_HISTORY
    this.now = options.now ?? Date.now
    this.createTransferId = options.createTransferId ?? randomUUID
    // Hex, not base64url: the canonical identifier shape excludes '_', which
    // base64url emits, so a base64url resume id is rejected ~40% of the time.
    this.createResumeId = options.createResumeId ?? (() => randomBytes(24).toString('hex'))
    if (!Number.isSafeInteger(this.maxActiveTransfers) || this.maxActiveTransfers < 1) {
      throw new Error('maxActiveTransfers must be a positive safe integer.')
    }
    if (
      !Number.isSafeInteger(this.maxActiveUploads) ||
      this.maxActiveUploads < 1 ||
      this.maxActiveUploads > this.maxActiveTransfers
    ) {
      throw new Error('maxActiveUploads must be a positive safe integer no greater than maxActiveTransfers.')
    }
    if (
      !Number.isSafeInteger(this.storagePartBytes) ||
      this.storagePartBytes < MIN_STORAGE_PART_BYTES ||
      this.storagePartBytes > MAX_STORAGE_PART_BYTES
    ) {
      throw new Error('storagePartBytes must be between the 5MiB distributed-storage minimum and 64MiB.')
    }
    if (!Number.isSafeInteger(this.transferTtlMs) || this.transferTtlMs < 1_000) {
      throw new Error('transferTtlMs must be at least 1000ms.')
    }
    if (!Number.isSafeInteger(this.duplicateHistoryChunks) || this.duplicateHistoryChunks < 1) {
      throw new Error('duplicateHistoryChunks must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(this.presentedTokenHistory) || this.presentedTokenHistory < 1) {
      throw new Error('presentedTokenHistory must be a positive safe integer.')
    }
  }

  ready(): boolean {
    return this.options.storage.ready()
  }

  async metadata(input: MetadataInput, signal: AbortSignal) {
    this.assertReady()
    await this.pruneExpiredTransfers()
    if (input.resources.length < 1 || input.resources.length > MAX_METADATA_ENTRIES) {
      throw new MultiContainerSyncFilesAdapterError('FILE_RESOURCE_INVALID')
    }
    const results = []
    for (const resource of input.resources) {
      signal.throwIfAborted()
      this.assertResource(resource)
      const authorized = await this.authorize(input.identity, resource, 'metadata', signal)
      const size = await this.options.storage.probeSize(this.storageTarget(resource, authorized), signal)
      if (size === undefined) {
        results.push({ resource, exists: false })
        continue
      }
      this.assertStorageSize(size)
      results.push({ resource, exists: true, encryptedSize: size })
    }
    return results
  }

  async openUpload(input: { identity: SyncTicketIdentity; descriptor: UploadDescriptor }, signal: AbortSignal) {
    this.assertReady()
    await this.pruneExpiredTransfers()
    signal.throwIfAborted()
    this.assertDescriptor(input.descriptor)

    if (input.descriptor.resumeId) {
      const resumeId = input.descriptor.resumeId
      if (!IDENTIFIER_PATTERN.test(resumeId)) {
        throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
      }
      return this.withTransferLock(resumeId, async () => {
        signal.throwIfAborted()
        const authorized = await this.authorize(
          input.identity,
          input.descriptor,
          'upload',
          signal,
          input.descriptor.decryptedSize,
        )
        const resumed = this.loadUploadByResumeId(resumeId)
        this.assertUploadResumeMatches(resumed, input.identity, input.descriptor, authorized.storageOwnerUuid)
        // There is no durable partial to truncate: rewind to the last part the
        // files service actually accepted and discard everything buffered after
        // it, so the client re-sends exactly the bytes that were never stored.
        this.discardPending(resumed)
        resumed.generation += 1
        resumed.nextIndex = resumed.flushedIndex
        resumed.nextOffset = resumed.flushedOffset
        resumed.digest = resumed.flushedDigest.copy()
        resumed.chunkLedger.clear()
        resumed.updatedAt = this.now()
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
      this.assertUploadCapacity()
      const transferId = this.validGeneratedIdentifier(this.createTransferId(), 'transfer')
      const resumeId = this.validGeneratedIdentifier(this.createResumeId(), 'resume')
      const resource = this.copyResource(input.descriptor)
      await this.options.storage.createUploadSession(this.storageTarget(resource, authorized), signal)
      signal.throwIfAborted()

      const digest = createHash('sha256')
      const state: UploadState = {
        kind: 'upload',
        identity: this.transferIdentity(input.identity),
        resource,
        descriptor: { ...input.descriptor, resumeId },
        storageOwnerUuid: authorized.storageOwnerUuid,
        transferId,
        resumeId,
        generation: 1,
        nextIndex: 0,
        nextOffset: 0,
        flushedIndex: 0,
        flushedOffset: 0,
        nextPartNumber: 1,
        pending: [],
        pendingBytes: 0,
        digest,
        flushedDigest: digest.copy(),
        chunkLedger: new Map(),
        updatedAt: this.now(),
      }
      this.remember(state)
      return this.uploadOpenResult(state)
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
      const authorized = await this.authorize(
        input.identity,
        state.resource,
        'upload',
        signal,
        state.descriptor.decryptedSize,
      )
      this.assertStableStorageOwner(state, authorized)
      this.assertUploadHeader(state, input.header, input.bytes)

      if (input.header.index < state.nextIndex) {
        this.verifyDuplicateChunk(state, input.header)
        state.updatedAt = this.now()
        return {
          duplicate: true,
          nextIndex: state.nextIndex,
          nextOffset: state.nextOffset,
          resumeId: state.resumeId,
        }
      }
      if (input.header.index !== state.nextIndex || input.header.offset !== state.nextOffset) {
        throw new MultiContainerSyncFilesAdapterError('FILE_CHUNK_OUT_OF_ORDER')
      }

      // The session zeroes the decoded frame once this resolves, so the bytes
      // must be copied out before they can be coalesced into a storage part.
      state.pending.push(Buffer.from(input.bytes))
      state.pendingBytes += input.bytes.byteLength
      state.digest.update(input.bytes)
      this.rememberChunkDigest(state, input.header)
      state.nextIndex += 1
      state.nextOffset += input.bytes.byteLength

      const complete = state.nextOffset === state.descriptor.declaredSize
      if (state.pendingBytes >= this.storagePartBytes || complete) {
        await this.flushPending(state, authorized, signal)
      }
      state.updatedAt = this.now()
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
      const authorized = await this.authorize(
        input.identity,
        state.resource,
        'upload',
        signal,
        state.descriptor.decryptedSize,
      )
      this.assertStableStorageOwner(state, authorized)
      if (state.completedSha256) {
        if (state.completedSha256 !== input.sha256 || input.declaredSize !== state.descriptor.declaredSize) {
          throw new MultiContainerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
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
        throw new MultiContainerSyncFilesAdapterError('FILE_INCOMPLETE')
      }
      if (state.pendingBytes > 0) {
        await this.flushPending(state, authorized, signal)
      }

      // The object cannot be read back before it is published, so integrity is
      // proven from the running digest over the in-order accepted bytes rather
      // than by re-hashing a staged file.
      const actualSha256 = state.digest.copy().digest('hex')
      if (!constantTimeHexMatches(actualSha256, input.sha256)) {
        throw new MultiContainerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
      }
      signal.throwIfAborted()
      await this.assertDestinationIsReplaceable(state, input.identity, signal)
      // `authorized` may already have been spent on the trailing part flush; a
      // credential is presented to storage at most once, so publication mints
      // and re-checks its own.
      const publishing = await this.authorize(
        input.identity,
        state.resource,
        'upload',
        signal,
        state.descriptor.decryptedSize,
      )
      this.assertStableStorageOwner(state, publishing)
      await this.options.storage.closeUploadSession(this.storageTarget(state.resource, publishing), signal)
      state.completedSha256 = actualSha256
      state.updatedAt = this.now()
      this.discardPending(state)
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
      const size = await this.options.storage.probeSize(this.storageTarget(input.resource, authorized), signal)
      if (size === undefined) {
        throw new MultiContainerSyncFilesAdapterError('FILE_NOT_FOUND')
      }
      this.assertStorageSize(size)
      if (input.offset < 0 || input.offset >= size) {
        throw new MultiContainerSyncFilesAdapterError('FILE_RANGE_INVALID')
      }

      let state: DownloadState
      if (input.resumeId) {
        const transferId = this.resumeIndex.get(input.resumeId)
        const existing = transferId ? this.transfers.get(transferId) : undefined
        if (!existing || existing.kind !== 'download') {
          throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
        }
        this.assertIdentity(existing.identity, input.identity)
        if (
          !this.resourcesEqual(existing.resource, input.resource) ||
          existing.storageOwnerUuid !== authorized.storageOwnerUuid ||
          existing.declaredSize !== size
        ) {
          throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
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
            declaredSize: size,
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
        declaredSize: size,
        nextIndex: state.nextIndex,
        nextOffset: state.nextOffset,
      }
    }
    if (input.resumeId) {
      if (!IDENTIFIER_PATTERN.test(input.resumeId)) {
        throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
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
      const authorized = await this.authorize(input.identity, state.resource, 'download', signal)
      this.assertStableStorageOwner(state, authorized)
      if (
        input.index !== state.nextIndex ||
        input.offset !== state.nextOffset ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > MAX_CHUNK_BYTES
      ) {
        throw new MultiContainerSyncFilesAdapterError('FILE_CHUNK_OUT_OF_ORDER')
      }
      const length = Math.min(input.maxBytes, state.declaredSize - state.nextOffset)
      if (length < 1) {
        throw new MultiContainerSyncFilesAdapterError('FILE_RANGE_INVALID')
      }
      const range = await this.options.storage.readRange(
        { target: this.storageTarget(state.resource, authorized), offset: state.nextOffset, length },
        signal,
      )
      signal.throwIfAborted()
      if (range.totalSize !== state.declaredSize) {
        range.bytes.fill(0)
        throw new MultiContainerSyncFilesAdapterError('FILE_TRUNCATED')
      }
      if (range.bytes.byteLength !== length) {
        range.bytes.fill(0)
        throw new MultiContainerSyncFilesAdapterError('FILE_TRUNCATED')
      }
      const result = {
        index: state.nextIndex,
        offset: state.nextOffset,
        declaredSize: state.declaredSize,
        bytes: range.bytes,
        final: state.nextOffset + range.bytes.byteLength === state.declaredSize,
      }
      state.nextIndex += 1
      state.nextOffset += range.bytes.byteLength
      state.updatedAt = this.now()
      if (result.final) {
        this.removeState(state)
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
        throw new MultiContainerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
      }
      this.assertIdentity(state.identity, input.identity)
      if (state.generation !== input.generation) {
        throw new MultiContainerSyncFilesAdapterError('FILE_STALE_GENERATION')
      }
      // An abandoned distributed multipart upload is never published (only
      // close-session publishes it) and is reclaimed by the files service's own
      // lifecycle policy; there is no authenticated abort endpoint to call.
      this.removeState(state)
    })
  }

  private async authorize(
    identity: SyncTicketIdentity,
    resource: FileResourceReference,
    operation: MultiContainerFileOperation,
    signal: AbortSignal,
    decryptedSize?: number,
  ): Promise<MultiContainerFileAuthorization> {
    signal.throwIfAborted()
    const authorization = await this.options.authorizer.authorize(
      { identity, resource, operation, ...(decryptedSize === undefined ? {} : { decryptedSize }) },
      signal,
    )
    signal.throwIfAborted()
    if (
      !authorization ||
      !IDENTIFIER_PATTERN.test(authorization.storageOwnerUuid) ||
      !isValetTokenShaped(authorization.valetToken)
    ) {
      throw new MultiContainerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    if (resource.ownershipType === 'user' && authorization.storageOwnerUuid !== identity.userUuid) {
      throw new MultiContainerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    if (resource.ownershipType === 'shared-vault' && authorization.storageOwnerUuid !== resource.sharedVaultUuid) {
      throw new MultiContainerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    // A valet credential authorizes exactly one operation. Re-presenting one is
    // either a replay or an authorizer that failed to mint; both fail closed
    // BEFORE the storage boundary is touched.
    this.consumeValetToken(authorization.valetToken)
    return authorization
  }

  private consumeValetToken(valetToken: string): void {
    const fingerprint = createHash('sha256').update(valetToken, 'utf8').digest('base64')
    if (this.presentedTokens.has(fingerprint)) {
      throw new MultiContainerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    this.presentedTokens.add(fingerprint)
    while (this.presentedTokens.size > this.presentedTokenHistory) {
      const oldest = this.presentedTokens.values().next().value as string | undefined
      if (oldest === undefined) {
        break
      }
      this.presentedTokens.delete(oldest)
    }
  }

  private storageTarget(
    resource: FileResourceReference,
    authorization: MultiContainerFileAuthorization,
  ): MultiContainerFileStorageTarget {
    if (!IDENTIFIER_PATTERN.test(resource.remoteIdentifier)) {
      throw new MultiContainerSyncFilesAdapterError('FILE_PATH_INVALID')
    }
    return {
      ownershipType: resource.ownershipType,
      storageOwnerUuid: authorization.storageOwnerUuid,
      remoteIdentifier: resource.remoteIdentifier,
      valetToken: authorization.valetToken,
    }
  }

  /**
   * A membership or ownership change mid-transfer must never redirect bytes to
   * a different namespace than the one the transfer was opened against.
   *
   * Defence in depth, and currently unreachable by construction: `authorize`
   * already pins the namespace to the authenticated user or to the resource's
   * own vault, and both the identity and the resource are frozen on the state.
   * It is kept so that a future change to that binding fails closed here rather
   * than silently writing a transfer into someone else's namespace.
   */
  private assertStableStorageOwner(state: TransferState, authorization: MultiContainerFileAuthorization): void {
    if (state.storageOwnerUuid !== authorization.storageOwnerUuid) {
      throw new MultiContainerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
  }

  private async flushPending(
    state: UploadState,
    authorization: MultiContainerFileAuthorization,
    signal: AbortSignal,
  ): Promise<void> {
    if (state.pendingBytes < 1) {
      return
    }
    const payload = Buffer.concat(state.pending, state.pendingBytes)
    try {
      await this.options.storage.uploadPart(
        { target: this.storageTarget(state.resource, authorization), partNumber: state.nextPartNumber, bytes: payload },
        signal,
      )
    } finally {
      payload.fill(0)
    }
    this.discardPending(state)
    state.nextPartNumber += 1
    state.flushedIndex = state.nextIndex
    state.flushedOffset = state.nextOffset
    state.flushedDigest = state.digest.copy()
  }

  private discardPending(state: UploadState): void {
    for (const buffered of state.pending) {
      buffered.fill(0)
    }
    state.pending = []
    state.pendingBytes = 0
  }

  /**
   * Publication must not silently replace different encrypted data. The object
   * cannot be re-hashed remotely, so the pre-publication check is on the stored
   * encrypted size — a size-preserving replacement of an identically named
   * resource is the one case this deployment cannot distinguish.
   */
  private async assertDestinationIsReplaceable(
    state: UploadState,
    identity: SyncTicketIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const authorized = await this.authorize(identity, state.resource, 'metadata', signal)
    this.assertStableStorageOwner(state, authorized)
    const existing = await this.options.storage.probeSize(this.storageTarget(state.resource, authorized), signal)
    if (existing !== undefined && existing !== state.descriptor.declaredSize) {
      throw new MultiContainerSyncFilesAdapterError('FILE_DESTINATION_CONFLICT')
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
      throw new MultiContainerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
    }
  }

  private rememberChunkDigest(state: UploadState, header: FileBinaryHeader): void {
    state.chunkLedger.set(header.index, {
      offset: header.offset,
      byteLength: header.byteLength,
      sha256: header.sha256,
    })
    while (state.chunkLedger.size > this.duplicateHistoryChunks) {
      const oldest = state.chunkLedger.keys().next().value as number | undefined
      if (oldest === undefined) {
        break
      }
      state.chunkLedger.delete(oldest)
    }
  }

  /**
   * Accepted bytes are already on their way to storage and cannot be read back,
   * so a re-sent chunk is checked against the digest ledger. A chunk older than
   * the retained window is unverifiable and is therefore REJECTED rather than
   * blindly acknowledged; the client's recovery path for that is a resume.
   */
  private verifyDuplicateChunk(state: UploadState, header: FileBinaryHeader): void {
    if (header.offset + header.byteLength > state.nextOffset) {
      throw new MultiContainerSyncFilesAdapterError('FILE_CHUNK_OUT_OF_ORDER')
    }
    const recorded = state.chunkLedger.get(header.index)
    if (!recorded) {
      throw new MultiContainerSyncFilesAdapterError('FILE_CHUNK_OUT_OF_ORDER')
    }
    if (
      recorded.offset !== header.offset ||
      recorded.byteLength !== header.byteLength ||
      !constantTimeHexMatches(recorded.sha256, header.sha256)
    ) {
      throw new MultiContainerSyncFilesAdapterError('FILE_INTEGRITY_MISMATCH')
    }
  }

  private loadUploadByResumeId(resumeId: string): UploadState {
    const transferId = this.resumeIndex.get(resumeId)
    const remembered = transferId ? this.transfers.get(transferId) : undefined
    if (remembered?.kind !== 'upload') {
      if (this.expiredResumeIds.has(resumeId)) {
        throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_EXPIRED')
      }
      throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
    if (remembered.updatedAt + this.transferTtlMs <= this.now()) {
      this.forgetExpired(remembered)
      throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_EXPIRED')
    }
    return remembered
  }

  /**
   * TTL eviction is remembered briefly so a client that resumes a moment too
   * late is told the transfer EXPIRED rather than that its resume id was never
   * real — the home server gets that distinction from its on-disk manifest.
   */
  private forgetExpired(state: TransferState): void {
    this.removeState(state)
    this.expiredResumeIds.add(state.resumeId)
    while (this.expiredResumeIds.size > this.maxActiveTransfers * 4) {
      const oldest = this.expiredResumeIds.values().next().value as string | undefined
      if (oldest === undefined) {
        break
      }
      this.expiredResumeIds.delete(oldest)
    }
  }

  private async pruneExpiredTransfers(): Promise<void> {
    const cutoff = this.now() - this.transferTtlMs
    for (const state of [...this.transfers.values()]) {
      if (state.updatedAt <= cutoff) {
        await this.withTransferLock(state.resumeId, async () => {
          const current = this.transfers.get(state.transferId)
          if (current === state && current.updatedAt <= cutoff) {
            this.forgetExpired(current)
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
      throw new MultiContainerSyncFilesAdapterError('FILE_TRANSFER_CAPACITY')
    }
  }

  /**
   * Uploads are capped separately from downloads because each one owns a
   * coalescing buffer; this bound is what keeps this process's file memory
   * predictable in a deployment that cannot stage bytes on disk.
   */
  private assertUploadCapacity(): void {
    let uploads = 0
    for (const state of this.transfers.values()) {
      if (state.kind === 'upload') {
        uploads += 1
      }
    }
    if (uploads >= this.maxActiveUploads) {
      throw new MultiContainerSyncFilesAdapterError('FILE_TRANSFER_CAPACITY')
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
      throw new MultiContainerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
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

  private removeState(state: TransferState): void {
    this.transfers.delete(state.transferId)
    this.resumeIndex.delete(state.resumeId)
    this.completedUploads.delete(state.transferId)
    if (state.kind === 'upload') {
      this.discardPending(state)
      state.chunkLedger.clear()
    }
  }

  private currentUpload(identity: SyncTicketIdentity, transferId: string, generation: number): UploadState {
    const state = this.transfers.get(transferId)
    if (!state || state.kind !== 'upload') {
      throw new MultiContainerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
    }
    this.assertIdentity(state.identity, identity)
    if (state.generation !== generation) {
      throw new MultiContainerSyncFilesAdapterError('FILE_STALE_GENERATION')
    }
    return state
  }

  private currentUploadForFinish(identity: SyncTicketIdentity, transferId: string, generation: number): UploadState {
    const state = this.transfers.get(transferId) ?? this.completedUploads.get(transferId)
    if (!state || state.kind !== 'upload') {
      throw new MultiContainerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
    }
    this.assertIdentity(state.identity, identity)
    if (state.generation !== generation) {
      throw new MultiContainerSyncFilesAdapterError('FILE_STALE_GENERATION')
    }
    return state
  }

  private currentDownload(identity: SyncTicketIdentity, transferId: string, generation: number): DownloadState {
    const state = this.transfers.get(transferId)
    if (!state || state.kind !== 'download') {
      throw new MultiContainerSyncFilesAdapterError('FILE_TRANSFER_NOT_FOUND')
    }
    this.assertIdentity(state.identity, identity)
    if (state.generation !== generation) {
      throw new MultiContainerSyncFilesAdapterError('FILE_STALE_GENERATION')
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
      throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
    if (
      state.descriptor.decryptedSize !== descriptor.decryptedSize ||
      state.descriptor.declaredSize !== descriptor.declaredSize ||
      state.descriptor.mimeType !== descriptor.mimeType
    ) {
      throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
    if (state.completedSha256) {
      throw new MultiContainerSyncFilesAdapterError('FILE_RESUME_INVALID')
    }
  }

  private assertIdentity(expected: SyncTicketIdentity, actual: SyncTicketIdentity): void {
    if (
      expected.userUuid !== actual.userUuid ||
      expected.sessionUuid !== actual.sessionUuid ||
      expected.deviceId !== actual.deviceId
    ) {
      throw new MultiContainerSyncFilesAdapterError('FILE_ACCESS_DENIED')
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
      throw new MultiContainerSyncFilesAdapterError('FILE_RESOURCE_INVALID')
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
      throw new MultiContainerSyncFilesAdapterError('FILE_RESOURCE_INVALID')
    }
  }

  private assertStorageSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_TRANSFER_BYTES) {
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
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

  private assertReady(): void {
    if (!this.ready()) {
      throw new MultiContainerSyncFilesAdapterError('OPERATION_UNAVAILABLE')
    }
  }
}

/**
 * `SyncFilesSession.normalizeFilesError` recognises a coded adapter failure by
 * this exact `name`; anything else collapses to a retryable FILE_BACKEND_ERROR
 * and the client would lose the real reason (notably FILE_ACCESS_DENIED). The
 * tag is the session's contract for "adapter error carrying a code", not a
 * claim about which deployment raised it.
 */
const SYNC_FILES_ADAPTER_ERROR_NAME = 'HomeServerSyncFilesAdapterError'

export class MultiContainerSyncFilesAdapterError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = SYNC_FILES_ADAPTER_ERROR_NAME
  }
}

function isValetTokenShaped(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_VALET_TOKEN_LENGTH &&
    !/[\s\u0000-\u001f\u007f]/u.test(value)
  )
}

function constantTimeHexMatches(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
