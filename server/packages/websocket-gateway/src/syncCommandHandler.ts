import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SyncAuthTicketStore, SyncTicketIdentity } from './auth.js'
import type { SyncCommandLeaseRegistry, SyncSocketBudget } from './registry.js'
import { MAX_FILE_BINARY_FRAME_BYTES } from './filesProtocol.js'
import { SyncFilesSession, type SyncFilesAdapter } from './filesSession.js'
import {
  MAX_SYNC_BUFFERED_BYTES,
  MAX_SYNC_FRAME_BYTES,
  MAX_SYNC_QUEUED_BYTES,
  MAX_SYNC_QUEUED_FRAMES,
  MAX_SYNC_SEQUENCE,
  MAX_RPC_CREDIT_BYTES,
  SYNC_AUTH_DEADLINE_MS,
  SYNC_BACKEND_TIMEOUT_MS,
  SyncProtocolError,
  createSyncServerFrame,
  parseSyncClientFrame,
  type JsonObject,
  type SyncCollaborationAuthorizationFrame,
  type SyncCollaborationAuthorizationPayload,
  type SyncCommandFrame,
  type SyncNegotiatedOperation,
  type SyncRpcCancelFrame,
  type SyncRpcCreditFrame,
  type SyncRpcMethod,
  type SyncRpcRequestFrame,
  type SyncServerFrameType,
  type SyncStatusRequestFrame,
  type SyncFilesCancelFrame,
  type SyncFilesCreditFrame,
  type SyncFilesDownloadOpenFrame,
  type SyncFilesMetadataFrame,
  type SyncFilesUploadFinishFrame,
  type SyncFilesUploadOpenFrame,
  type SyncInviteAckFrame,
  type SyncInviteSubscribeFrame,
} from './syncProtocol.js'

export interface SyncSocket {
  readonly bufferedAmount: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export type SyncAuthorizationCode =
  'SESSION_REVOKED' | 'READ_ONLY' | 'CONTENT_LIMIT' | 'SHARED_VAULT_FORBIDDEN' | 'SHADOW_BANNED' | 'NOT_AUTHORIZED'

export interface SyncAuthorizationInput {
  identity: SyncTicketIdentity
  operation: 'COMMAND' | 'STATUS'
  commandId: string
  digest: string
  payloadLength: number
  payload?: JsonObject
}

export type SyncAuthorizationDecision = { authorized: true } | { authorized: false; code: SyncAuthorizationCode }

/** Called for every command/status request; no authorization claim is cached from the ticket. */
export interface SyncLiveAuthorizationAdapter {
  ready(): boolean
  /**
   * Narrower readiness covering ONLY session revalidation, for adapters that
   * also implement `SyncCommandBackendAdapter` and would otherwise report the
   * durable backend's health as the session plane's health. When supplied this
   * is what gates the socket; `ready()` remains the fallback, so an adapter
   * that does not distinguish the two behaves exactly as it did before.
   */
  sessionAuthorizationReady?(): boolean
  authorize(input: SyncAuthorizationInput, signal: AbortSignal): Promise<SyncAuthorizationDecision>
}

/**
 * Session-plane readiness for an authorization adapter: its own narrower answer
 * when it has one, otherwise its single `ready()`.
 */
export function sessionAuthorizationReady(adapter: SyncLiveAuthorizationAdapter): boolean {
  return adapter.sessionAuthorizationReady ? adapter.sessionAuthorizationReady() : adapter.ready()
}

export interface SyncBackendCommandInput {
  identity: SyncTicketIdentity
  commandId: string
  digest: string
  payload: JsonObject
}

export interface SyncBackendCommit {
  digest: string
  payload?: JsonObject
}

export type SyncBackendStatus =
  | { status: 'UNKNOWN'; digest?: string }
  | { status: 'ACCEPTED'; digest: string; payload?: JsonObject }
  | { status: 'COMMITTED'; digest: string; payload?: JsonObject }
  | { status: 'ERROR'; digest: string; code: string }

/**
 * Independent of Lane 1 protobuf/generated types. The eventual syncing-server
 * adapter owns durable same-commandId/digest idempotency across replicas.
 */
export interface SyncCommandBackendAdapter {
  ready(): boolean
  execute(input: SyncBackendCommandInput, signal: AbortSignal): Promise<SyncBackendCommit>
  status(input: Omit<SyncBackendCommandInput, 'payload'>, signal: AbortSignal): Promise<SyncBackendStatus>
}

export type SyncCollaborationAuthorizationResult =
  | { authorized: false }
  | {
      authorized: true
      epochDiscovery: true
      room: string
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
      roomEpoch: string
      collaborationSecurityEpoch: string
    }
  | {
      authorized: true
      epochDiscovery?: false
      capability: string
      room: string
      expiresIn: number
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
      roomEpoch: string
      collaborationSecurityEpoch: string
      leaseRequestId?: string
      bootstrapChallenge?: string
    }

export interface SyncCollaborationAuthorizationAdapter {
  collaborationAuthorizationReady(): boolean
  authorizeCollaboration(
    input: { identity: SyncTicketIdentity; request: SyncCollaborationAuthorizationPayload },
    signal: AbortSignal,
  ): Promise<SyncCollaborationAuthorizationResult>
}

export type SyncApiRpcRequest = {
  identity: SyncTicketIdentity
  method: SyncRpcMethod
  path: string
  headers: Record<string, string>
  body?: unknown
  idempotencyKey?: string
  stream: boolean
}

export type SyncApiRpcResponse = {
  status: number
  headers?: Record<string, string>
  body?: unknown
  stream?: AsyncIterable<Uint8Array>
}

/**
 * Injected by the owning API process. Implementations must dispatch only to the
 * canonical authenticated handler stack; the gateway never accepts a target
 * host or forwards browser credentials from a frame.
 */
export interface SyncApiRpcAdapter {
  /**
   * Non-GET attempt keys must be reserved in fleet-shared durable storage
   * before the canonical handler can perform a side effect. A socket-local map
   * is only an optimization and never satisfies this contract.
   */
  readonly idempotencyScope: 'shared-durable'
  ready(): boolean
  operations(): readonly Extract<SyncNegotiatedOperation, 'API_RPC' | 'STREAM_ASSISTANT'>[]
  execute(input: SyncApiRpcRequest, signal: AbortSignal): Promise<SyncApiRpcResponse>
}

export type SyncInviteEventReplay = {
  previousCursor: string
  events: JsonObject[]
  nextCursor: string
  hasMore: boolean
}

/**
 * Fleet-shared durable invite invalidations. Producers must append the domain
 * mutation and its idempotent outbox record atomically; this read-side adapter
 * may publish availability only after that outbox record has been persisted.
 */
export interface SyncInviteEventsAdapter {
  readonly distribution: 'process' | 'shared'
  ready(): boolean
  tail(userUuid: string, signal: AbortSignal): Promise<string>
  readAfter(userUuid: string, cursor: string, limit: number, signal: AbortSignal): Promise<SyncInviteEventReplay>
  /** Must fan out across replicas. The callback is only a wake-up; the durable stream remains authoritative. */
  subscribeAvailability(userUuid: string, onAvailable: () => void): () => void
}

export interface SyncCommandMetrics {
  increment(event: string, code?: string): void
}

export interface SyncCommandHandlerOptions {
  socket: SyncSocket
  ownerId: string
  tickets: SyncAuthTicketStore
  leases: SyncCommandLeaseRegistry
  socketBudget: SyncSocketBudget
  authorization: SyncLiveAuthorizationAdapter
  backend: SyncCommandBackendAdapter
  collaborationAuthorization?: SyncCollaborationAuthorizationAdapter
  apiRpc?: SyncApiRpcAdapter
  inviteEvents?: SyncInviteEventsAdapter
  /** Production gateways require the invite stream and its wake-up bus to be fleet-shared. */
  requireSharedState?: boolean
  /** Optional canonical in-process file transport; never an HTTP proxy. */
  files?: SyncFilesAdapter
  isEnabled: () => boolean
  metrics?: SyncCommandMetrics
  authDeadlineMs?: number
  backendTimeoutMs?: number
  maxQueuedFrames?: number
  maxQueuedBytes?: number
  maxBufferedBytes?: number
  leaseRenewIntervalMs?: number
  socketBudgetRenewIntervalMs?: number
}

type ActiveLease = {
  userUuid: string
  deviceId: string
  commandId: string
  digest: string
  ownerId: string
}

type ActiveSocketBudget = {
  userUuid: string
  ownerId: string
}

type ActiveRpc = {
  requestId: string
  commandId: string
  controller: AbortController
  creditBytes: number
  waiters: Set<() => void>
  deadlineTimer?: NodeJS.Timeout
  abortCode?: string
}

type ActiveInviteSubscription = {
  requestId: string
  commandId: string
  cursor: string
  limit: number
  controller: AbortController
  unsubscribe?: () => void
  awaitingAck?: string
  pending: boolean
  pumping: boolean
  readySent: boolean
}

type CollaborationEpochDiscovery = {
  challengeDigest: Buffer
  requestId: string
  userUuid: string
  sessionUuid: string
  noteUuid: string
  roomEpoch: string
  collaborationSecurityEpoch: string
  expiresAt: number
}

const MAX_ACTIVE_RPC_REQUESTS = 8
const COLLABORATION_EPOCH_DISCOVERY_TTL_MS = 10_000
const MAX_RPC_CHUNK_BYTES = 64 * 1024
const MAX_RPC_IDEMPOTENCY_ENTRIES = 256

function constantTimeTextMatches(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest()
  const rightDigest = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function publicAuthorizationCode(code: SyncAuthorizationCode): string {
  // Never reveal shadow-ban state or detailed authorization topology on the wire.
  return code === 'CONTENT_LIMIT' ? 'CONTENT_LIMIT' : code === 'READ_ONLY' ? 'READ_ONLY' : 'NOT_AUTHORIZED'
}

class SyncLeaseLostError extends Error {
  constructor() {
    super('Distributed sync command lease was lost.')
    this.name = 'SyncLeaseLostError'
  }
}

export class SyncCommandHandler {
  private identity?: SyncTicketIdentity
  private expectedClientSequence = 0
  private serverSequence = 0
  private closed = false
  private queuedFrames = 0
  private queuedBytes = 0
  private queue: Promise<void> = Promise.resolve()
  private activeAbort?: AbortController
  private readonly activeRpcs = new Map<string, ActiveRpc>()
  private activeInviteSubscription?: ActiveInviteSubscription
  private collaborationEpochDiscovery?: CollaborationEpochDiscovery
  private readonly filesSession?: SyncFilesSession
  private readonly rpcIdempotency = new Map<string, string>()
  private activeLease?: ActiveLease
  private activeSocketBudget?: ActiveSocketBudget
  private socketBudgetRenewTimer?: NodeJS.Timeout
  private readonly lifecycleAbort = new AbortController()
  private readonly cleanupTasks = new Set<Promise<unknown>>()
  private readonly authTimer: NodeJS.Timeout
  private readonly authDeadlineMs: number
  private readonly backendTimeoutMs: number
  private readonly maxQueuedFrames: number
  private readonly maxQueuedBytes: number
  private readonly maxBufferedBytes: number
  private readonly leaseRenewIntervalMs: number
  private readonly socketBudgetRenewIntervalMs: number

  constructor(private readonly options: SyncCommandHandlerOptions) {
    this.authDeadlineMs = options.authDeadlineMs ?? SYNC_AUTH_DEADLINE_MS
    this.backendTimeoutMs = options.backendTimeoutMs ?? SYNC_BACKEND_TIMEOUT_MS
    this.maxQueuedFrames = options.maxQueuedFrames ?? MAX_SYNC_QUEUED_FRAMES
    this.maxQueuedBytes = options.maxQueuedBytes ?? MAX_SYNC_QUEUED_BYTES
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_SYNC_BUFFERED_BYTES
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 10_000
    this.socketBudgetRenewIntervalMs = options.socketBudgetRenewIntervalMs ?? 20_000
    if (options.files) {
      this.filesSession = new SyncFilesSession({
        adapter: options.files,
        sendControl: (type, requestId, commandId, payload) => this.send(type, requestId, commandId, payload),
        sendBinary: (bytes) => this.sendBinary(bytes),
        sendError: (requestId, commandId, code) => this.sendError(requestId, commandId, code),
        metrics: options.metrics,
      })
    }
    if (
      !Number.isSafeInteger(this.leaseRenewIntervalMs) ||
      this.leaseRenewIntervalMs < 1 ||
      !Number.isSafeInteger(this.socketBudgetRenewIntervalMs) ||
      this.socketBudgetRenewIntervalMs < 1
    ) {
      throw new Error('Invalid sync lease renewal interval.')
    }
    this.authTimer = setTimeout(() => {
      if (!this.identity && !this.closed) {
        this.options.metrics?.increment('auth', 'timeout')
        this.failAndClose('AUTH_TIMEOUT', 'Authentication deadline exceeded.')
      }
    }, this.authDeadlineMs)
    this.authTimer.unref()
  }

  enqueue(raw: string, rawBytes: number): void {
    if (this.closed) {
      return
    }
    if (
      !Number.isSafeInteger(rawBytes) ||
      rawBytes < 0 ||
      this.queuedFrames >= this.maxQueuedFrames ||
      this.queuedBytes + rawBytes > this.maxQueuedBytes
    ) {
      this.options.metrics?.increment('backpressure', 'ingress')
      this.failAndClose('BACKPRESSURE', 'Sync command queue is full.', 1013)
      return
    }
    this.queuedFrames += 1
    this.queuedBytes += rawBytes
    this.queue = this.queue
      .then(() => this.process(raw, rawBytes))
      .catch(() => {
        if (!this.closed) {
          this.options.metrics?.increment('backend', 'transport_unavailable')
          this.failAndClose('SYNC_DISABLED', 'WebSocket sync became unavailable.', 1013)
        }
      })
      .finally(() => {
        this.queuedFrames = Math.max(0, this.queuedFrames - 1)
        this.queuedBytes = Math.max(0, this.queuedBytes - rawBytes)
      })
  }

  enqueueBinary(raw: Uint8Array, rawBytes: number): void {
    if (this.closed) {
      return
    }
    if (
      !Number.isSafeInteger(rawBytes) ||
      rawBytes < 0 ||
      rawBytes !== raw.byteLength ||
      rawBytes > MAX_FILE_BINARY_FRAME_BYTES ||
      this.queuedFrames >= this.maxQueuedFrames ||
      this.queuedBytes + rawBytes > Math.max(this.maxQueuedBytes, MAX_FILE_BINARY_FRAME_BYTES)
    ) {
      raw.fill(0)
      this.options.metrics?.increment('backpressure', 'files_ingress')
      this.failAndClose('BACKPRESSURE', 'File transfer queue is full.', 1013)
      return
    }
    this.queuedFrames += 1
    this.queuedBytes += rawBytes
    this.queue = this.queue
      .then(() => this.processBinary(raw))
      .catch(() => {
        if (!this.closed) {
          this.options.metrics?.increment('files', 'transport_unavailable')
          this.failAndClose('SYNC_DISABLED', 'WebSocket files became unavailable.', 1013)
        }
      })
      .finally(() => {
        raw.fill(0)
        this.queuedFrames = Math.max(0, this.queuedFrames - 1)
        this.queuedBytes = Math.max(0, this.queuedBytes - rawBytes)
      })
  }

  disconnect(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    clearTimeout(this.authTimer)
    if (this.socketBudgetRenewTimer) {
      clearTimeout(this.socketBudgetRenewTimer)
    }
    this.lifecycleAbort.abort()
    this.activeAbort?.abort()
    this.abortActiveRpcs('SOCKET_CLOSED')
    this.stopInviteSubscription()
    this.collaborationEpochDiscovery = undefined
    this.filesSession?.disconnect()
    this.trackCleanup(this.releaseActiveLease())
    this.trackCleanup(this.releaseSocketBudget())
    this.options.metrics?.increment('disconnect')
  }

  /** Await queued work and distributed cleanup; the gateway bounds this during shutdown. */
  async stop(): Promise<void> {
    this.disconnect()
    await this.queue.catch(() => undefined)
    await Promise.allSettled([...this.cleanupTasks])
    await Promise.allSettled([this.releaseActiveLease(), this.releaseSocketBudget()])
  }

  private async process(raw: string, rawBytes: number): Promise<void> {
    if (this.closed) {
      return
    }
    if (
      !this.options.isEnabled() ||
      !this.options.tickets.ready() ||
      !this.options.leases.ready() ||
      !this.options.socketBudget.ready() ||
      !sessionAuthorizationReady(this.options.authorization)
    ) {
      this.failAndClose('SYNC_DISABLED', 'WebSocket sync is unavailable.', 1012)
      return
    }
    // The durable backend is deliberately NOT part of this blanket check. It is
    // a per-operation dependency of SYNC_ITEMS alone; closing the socket for it
    // also destroys the invite, collaboration, RPC and files lanes, none of
    // which touch it. COMMAND/STATUS are refused individually below instead.

    let frame
    try {
      frame = parseSyncClientFrame(raw, rawBytes)
    } catch (error) {
      const code = error instanceof SyncProtocolError ? error.code : 'INVALID_ENVELOPE'
      this.options.metrics?.increment('protocol', code)
      this.failAndClose(code, 'Invalid sync protocol frame.')
      return
    }

    if (!this.identity) {
      if (frame.type !== 'AUTH') {
        this.failAndClose('AUTH_REQUIRED', 'The first sync frame must authenticate.')
        return
      }
      const consumed = await this.options.tickets.consume(frame.payload.ticket, this.lifecycleAbort.signal)
      if (!consumed || !constantTimeTextMatches(consumed.deviceId, frame.payload.deviceId)) {
        this.options.metrics?.increment('auth', 'rejected')
        this.failAndClose('AUTH_REJECTED', 'Authentication failed.')
        return
      }
      if (this.closed) {
        return
      }
      const budget = { userUuid: consumed.userUuid, ownerId: this.options.ownerId }
      const budgetAcquired = await this.options.socketBudget.acquire(budget, this.lifecycleAbort.signal)
      if (!budgetAcquired) {
        this.options.metrics?.increment('socket_budget', 'limit')
        this.failAndClose('SOCKET_LIMIT', 'Per-user sync socket limit exceeded.', 1013)
        return
      }
      if (this.closed) {
        this.trackCleanup(this.options.socketBudget.release(budget))
        return
      }
      this.activeSocketBudget = budget
      this.scheduleSocketBudgetRenewal()
      this.identity = consumed
      this.expectedClientSequence = 1
      this.serverSequence = frame.payload.resumeSequence ?? 0
      clearTimeout(this.authTimer)
      const authenticated = this.send('AUTHENTICATED', frame.requestId, frame.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        nextClientSequence: this.expectedClientSequence,
        operations: [
          // SYNC_ITEMS is the ONE capability that needs the durable command
          // port. It stays first in the list so a deployment that has the port
          // advertises byte-identically to before this became conditional.
          ...(this.options.backend.ready() ? ['SYNC_ITEMS'] : []),
          ...(this.options.collaborationAuthorization?.collaborationAuthorizationReady()
            ? ['AUTHORIZE_COLLABORATION']
            : []),
          ...(this.options.apiRpc?.ready() ? this.options.apiRpc.operations() : []),
          ...(this.inviteEventsReady() ? ['INVITE_EVENTS'] : []),
          ...(this.options.files?.ready() ? ['FILES_V1'] : []),
        ],
      })
      if (!authenticated) {
        return
      }
      this.options.metrics?.increment('auth', 'accepted')
      return
    }

    if (frame.type === 'AUTH') {
      this.failAndClose('ALREADY_AUTHENTICATED', 'Authentication cannot be repeated.')
      return
    }
    if (frame.sequence !== this.expectedClientSequence) {
      this.failAndClose('OUT_OF_ORDER', 'Sync frame sequence is out of order.')
      return
    }
    this.expectedClientSequence += 1

    if (frame.type === 'PING') {
      this.send('PONG', frame.requestId, frame.commandId, {})
      return
    }
    if (frame.type === 'STATUS') {
      await this.handleStatus(frame)
      return
    }
    if (frame.type === 'COLLABORATION_AUTHORIZE') {
      await this.handleCollaborationAuthorization(frame)
      return
    }
    if (frame.type === 'RPC_CANCEL') {
      this.handleRpcCancel(frame)
      return
    }
    if (frame.type === 'RPC_CREDIT') {
      this.handleRpcCredit(frame)
      return
    }
    if (frame.type === 'RPC_REQUEST') {
      this.startRpc(frame)
      return
    }
    if (frame.type === 'INVITE_SUBSCRIBE') {
      await this.handleInviteSubscribe(frame)
      return
    }
    if (frame.type === 'INVITE_ACK') {
      this.handleInviteAck(frame)
      return
    }
    if (
      frame.type === 'FILES_METADATA' ||
      frame.type === 'FILES_UPLOAD_OPEN' ||
      frame.type === 'FILES_UPLOAD_FINISH' ||
      frame.type === 'FILES_DOWNLOAD_OPEN' ||
      frame.type === 'FILES_CREDIT' ||
      frame.type === 'FILES_CANCEL'
    ) {
      await this.filesSession?.handleControl(
        frame as
          | SyncFilesMetadataFrame
          | SyncFilesUploadOpenFrame
          | SyncFilesUploadFinishFrame
          | SyncFilesDownloadOpenFrame
          | SyncFilesCreditFrame
          | SyncFilesCancelFrame,
        this.identity,
      )
      if (!this.filesSession) {
        this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      }
      return
    }
    await this.handleCommand(frame)
  }

  private async processBinary(raw: Uint8Array): Promise<void> {
    if (this.closed) {
      return
    }
    if (!this.identity) {
      this.failAndClose('AUTH_REQUIRED', 'File binary frames require authentication.')
      return
    }
    if (!this.options.isEnabled() || !this.filesSession || !this.options.files?.ready()) {
      this.sendError('files-binary', 'files-binary', 'OPERATION_UNAVAILABLE')
      return
    }
    await this.filesSession.handleBinary(raw, this.identity)
  }

  private async handleCollaborationAuthorization(frame: SyncCollaborationAuthorizationFrame): Promise<void> {
    const adapter = this.options.collaborationAuthorization
    if (!adapter?.collaborationAuthorizationReady()) {
      this.options.metrics?.increment('collaboration_authorization', 'unavailable')
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }

    const identity = this.identity as SyncTicketIdentity
    const discoveryRequest = isCollaborationEpochDiscoveryRequest(frame.payload) ? frame.payload : undefined
    const grantRequest = discoveryRequest
      ? undefined
      : (frame.payload as Extract<SyncCollaborationAuthorizationPayload, { expectedRoomEpoch: string }>)
    const consumedDiscovery = grantRequest ? this.consumeCollaborationEpochDiscovery(grantRequest, identity) : undefined
    if (grantRequest && !consumedDiscovery) {
      this.options.metrics?.increment('collaboration_authorization', 'epoch_challenge_invalid')
      this.sendError(frame.requestId, frame.commandId, 'NOT_AUTHORIZED')
      return
    }

    const controller = new AbortController()
    this.activeAbort = controller
    try {
      const result = await this.withTimeout(
        (signal) => adapter.authorizeCollaboration({ identity, request: frame.payload }, signal),
        controller,
      )
      if (!result.authorized) {
        this.options.metrics?.increment('collaboration_authorization', 'denied')
        this.sendError(frame.requestId, frame.commandId, 'NOT_AUTHORIZED')
        return
      }
      if (discoveryRequest) {
        if (!isValidCollaborationEpochDiscoveryResult(result, discoveryRequest)) {
          this.options.metrics?.increment('collaboration_authorization', 'invalid_discovery_result')
          this.sendError(frame.requestId, frame.commandId, 'BACKEND_ERROR')
          return
        }
        // Hex, not base64url: the client must echo this challenge back inside a
        // sync envelope, where every identifier has to satisfy IDENTIFIER_PATTERN
        // (first character alphanumeric). base64url leads with `-` or `_` 2/64 of
        // the time, so 3.125% of handshakes minted a challenge the client could
        // never present — the echo failed envelope validation and failAndClose()
        // tore down the whole sync socket. Hex keeps all 256 bits and always
        // leads with [0-9a-f]. Only the SHA-256 digest of this value is stored,
        // and the comparison is timingSafeEqual, so the encoding is otherwise
        // immaterial.
        const challenge = randomBytes(32).toString('hex')
        const expiresAt = Date.now() + COLLABORATION_EPOCH_DISCOVERY_TTL_MS
        this.collaborationEpochDiscovery = {
          challengeDigest: createHash('sha256').update(challenge, 'utf8').digest(),
          requestId: frame.requestId,
          userUuid: identity.userUuid,
          sessionUuid: identity.sessionUuid,
          noteUuid: frame.payload.noteUuid,
          roomEpoch: result.roomEpoch,
          collaborationSecurityEpoch: result.collaborationSecurityEpoch,
          expiresAt,
        }
        this.send('COLLABORATION_AUTHORIZED', frame.requestId, frame.commandId, {
          epochDiscovery: true,
          room: result.room,
          serverUpdatedAtTimestamp: result.serverUpdatedAtTimestamp,
          collaborationProtocolVersion: 3,
          roomEpoch: result.roomEpoch,
          collaborationSecurityEpoch: result.collaborationSecurityEpoch,
          epochDiscoveryChallenge: challenge,
          epochDiscoveryRequestId: frame.requestId,
          challengeExpiresAt: expiresAt,
        })
        this.options.metrics?.increment('collaboration_authorization', 'epoch_discovered')
        return
      }
      if (
        !grantRequest ||
        !consumedDiscovery ||
        !isValidCollaborationAuthorizationResult(result, grantRequest, consumedDiscovery)
      ) {
        this.options.metrics?.increment('collaboration_authorization', 'invalid_result')
        this.sendError(frame.requestId, frame.commandId, 'BACKEND_ERROR')
        return
      }
      this.send('COLLABORATION_AUTHORIZED', frame.requestId, frame.commandId, {
        capability: result.capability,
        room: result.room,
        expiresIn: result.expiresIn,
        serverUpdatedAtTimestamp: result.serverUpdatedAtTimestamp,
        collaborationProtocolVersion: result.collaborationProtocolVersion,
        roomEpoch: result.roomEpoch,
        collaborationSecurityEpoch: result.collaborationSecurityEpoch,
        ...(result.leaseRequestId ? { leaseRequestId: result.leaseRequestId } : {}),
        ...(result.bootstrapChallenge ? { bootstrapChallenge: result.bootstrapChallenge } : {}),
      })
      this.options.metrics?.increment('collaboration_authorization', 'authorized')
    } catch {
      this.options.metrics?.increment('collaboration_authorization', controller.signal.aborted ? 'timeout' : 'error')
      this.sendError(frame.requestId, frame.commandId, controller.signal.aborted ? 'BACKEND_TIMEOUT' : 'BACKEND_ERROR')
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = undefined
      }
    }
  }

  private consumeCollaborationEpochDiscovery(
    request: Extract<SyncCollaborationAuthorizationPayload, { expectedRoomEpoch: string }>,
    identity: SyncTicketIdentity,
  ): CollaborationEpochDiscovery | undefined {
    const discovery = this.collaborationEpochDiscovery
    this.collaborationEpochDiscovery = undefined
    if (
      !discovery ||
      discovery.expiresAt <= Date.now() ||
      discovery.requestId !== request.epochDiscoveryRequestId ||
      discovery.userUuid !== identity.userUuid ||
      discovery.sessionUuid !== identity.sessionUuid ||
      discovery.noteUuid !== request.noteUuid ||
      discovery.roomEpoch !== request.expectedRoomEpoch
    ) {
      return undefined
    }
    const supplied = createHash('sha256').update(request.epochDiscoveryChallenge, 'utf8').digest()
    return timingSafeEqual(discovery.challengeDigest, supplied) ? discovery : undefined
  }

  private async handleInviteSubscribe(frame: SyncInviteSubscribeFrame): Promise<void> {
    const adapter = this.options.inviteEvents
    if (!adapter || !this.inviteEventsReady()) {
      this.options.metrics?.increment('invite_events', 'unavailable')
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }

    this.stopInviteSubscription()
    const identity = this.identity as SyncTicketIdentity
    if (frame.payload.cursor === undefined) {
      const controller = new AbortController()
      try {
        const cursor = await this.withTimeout((signal) => adapter.tail(identity.userUuid, signal), controller)
        if (!isOpaqueInviteCursor(cursor)) {
          throw new Error('Invite stream returned an invalid tail cursor.')
        }
        this.send('INVITE_RECONCILE', frame.requestId, frame.commandId, {
          reason: 'BOOTSTRAP_REQUIRED',
          cursor,
        })
      } catch {
        this.options.metrics?.increment('invite_events', controller.signal.aborted ? 'timeout' : 'error')
        this.sendError(
          frame.requestId,
          frame.commandId,
          controller.signal.aborted ? 'BACKEND_TIMEOUT' : 'INVITE_STORE_UNAVAILABLE',
        )
      } finally {
        controller.abort()
      }
      return
    }

    const subscription: ActiveInviteSubscription = {
      requestId: frame.requestId,
      commandId: frame.commandId,
      cursor: frame.payload.cursor,
      limit: frame.payload.limit,
      controller: new AbortController(),
      pending: true,
      pumping: false,
      readySent: false,
    }
    this.activeInviteSubscription = subscription
    try {
      // Register before the first read so an append racing with replay cannot be lost.
      subscription.unsubscribe = adapter.subscribeAvailability(identity.userUuid, () => {
        this.requestInvitePump(subscription)
      })
    } catch {
      this.options.metrics?.increment('invite_events', 'subscription_error')
      this.stopInviteSubscription(subscription)
      this.sendError(frame.requestId, frame.commandId, 'INVITE_STORE_UNAVAILABLE')
      return
    }
    await this.pumpInviteEvents(subscription)
  }

  private handleInviteAck(frame: SyncInviteAckFrame): void {
    const subscription = this.activeInviteSubscription
    if (!subscription?.awaitingAck || !constantTimeTextMatches(subscription.awaitingAck, frame.payload.cursor)) {
      this.options.metrics?.increment('invite_events', 'invalid_ack')
      this.failAndClose('INVITE_ACK_INVALID', 'Invite acknowledgement did not match the outstanding batch.')
      return
    }
    subscription.cursor = frame.payload.cursor
    subscription.awaitingAck = undefined
    subscription.pending = true
    this.requestInvitePump(subscription)
  }

  private requestInvitePump(subscription: ActiveInviteSubscription): void {
    if (this.closed || this.activeInviteSubscription !== subscription) {
      return
    }
    subscription.pending = true
    if (subscription.pumping || subscription.awaitingAck) {
      return
    }
    void this.pumpInviteEvents(subscription)
  }

  private async pumpInviteEvents(subscription: ActiveInviteSubscription): Promise<void> {
    const adapter = this.options.inviteEvents
    const identity = this.identity
    if (
      !adapter ||
      !identity ||
      this.closed ||
      this.activeInviteSubscription !== subscription ||
      subscription.pumping ||
      subscription.awaitingAck
    ) {
      return
    }

    subscription.pumping = true
    subscription.pending = false
    try {
      const replay = await this.withTimeout(
        (signal) => adapter.readAfter(identity.userUuid, subscription.cursor, subscription.limit, signal),
        subscription.controller,
      )
      if (this.closed || this.activeInviteSubscription !== subscription) {
        return
      }
      if (!isValidInviteReplay(replay, subscription.cursor, subscription.limit)) {
        this.options.metrics?.increment('invite_events', 'invalid_replay')
        this.stopInviteSubscription(subscription)
        this.sendError(subscription.requestId, subscription.commandId, 'INVITE_STORE_UNAVAILABLE')
        return
      }
      if (replay.events.length === 0) {
        // If an availability notification raced with the read, replay again
        // before declaring the cursor caught up.
        if (!subscription.pending && !subscription.readySent) {
          subscription.readySent = this.send('INVITE_READY', subscription.requestId, subscription.commandId, {
            cursor: subscription.cursor,
          })
        }
        return
      }
      const sent = this.send('INVITE_BATCH', subscription.requestId, subscription.commandId, replay)
      if (sent) {
        subscription.readySent = true
        subscription.awaitingAck = replay.nextCursor
        this.options.metrics?.increment('invite_events', 'batch')
      }
    } catch (error) {
      if (this.closed || this.activeInviteSubscription !== subscription) {
        return
      }
      const code = inviteStreamErrorCode(error)
      if (code === 'INVITE_CURSOR_EXPIRED' || code === 'INVITE_CURSOR_INVALID') {
        await this.reconcileInviteSubscription(
          subscription,
          code === 'INVITE_CURSOR_EXPIRED' ? 'CURSOR_EXPIRED' : 'CURSOR_INVALID',
        )
      } else {
        this.options.metrics?.increment('invite_events', subscription.controller.signal.aborted ? 'timeout' : 'error')
        this.stopInviteSubscription(subscription)
        this.sendError(
          subscription.requestId,
          subscription.commandId,
          subscription.controller.signal.aborted ? 'BACKEND_TIMEOUT' : 'INVITE_STORE_UNAVAILABLE',
        )
      }
    } finally {
      subscription.pumping = false
      if (
        !this.closed &&
        this.activeInviteSubscription === subscription &&
        subscription.pending &&
        !subscription.awaitingAck
      ) {
        queueMicrotask(() => this.requestInvitePump(subscription))
      }
    }
  }

  private async reconcileInviteSubscription(
    subscription: ActiveInviteSubscription,
    reason: 'CURSOR_EXPIRED' | 'CURSOR_INVALID',
  ): Promise<void> {
    const adapter = this.options.inviteEvents
    const identity = this.identity
    if (!adapter || !identity || this.activeInviteSubscription !== subscription) {
      return
    }
    try {
      const cursor = await this.withTimeout(
        (signal) => adapter.tail(identity.userUuid, signal),
        subscription.controller,
      )
      if (!isOpaqueInviteCursor(cursor)) {
        throw new Error('Invite stream returned an invalid reconciliation cursor.')
      }
      this.stopInviteSubscription(subscription)
      this.send('INVITE_RECONCILE', subscription.requestId, subscription.commandId, { reason, cursor })
      this.options.metrics?.increment('invite_events', reason.toLowerCase())
    } catch {
      this.stopInviteSubscription(subscription)
      this.sendError(subscription.requestId, subscription.commandId, 'INVITE_STORE_UNAVAILABLE')
    }
  }

  private stopInviteSubscription(expected?: ActiveInviteSubscription): void {
    const subscription = this.activeInviteSubscription
    if (!subscription || (expected && expected !== subscription)) {
      return
    }
    this.activeInviteSubscription = undefined
    subscription.controller.abort()
    try {
      subscription.unsubscribe?.()
    } catch {
      // Subscription state is already detached; the durable cursor remains authoritative.
    }
  }

  private inviteEventsReady(): boolean {
    const adapter = this.options.inviteEvents
    return Boolean(adapter?.ready() && (!this.options.requireSharedState || adapter.distribution === 'shared'))
  }

  private startRpc(frame: SyncRpcRequestFrame): void {
    const adapter = this.options.apiRpc
    if (!adapter?.ready() || !adapter.operations().includes('API_RPC')) {
      this.options.metrics?.increment('rpc', 'unavailable')
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }
    const assistantStream = isAssistantStreamPath(frame.payload.path)
    if (assistantStream && !adapter.operations().includes('STREAM_ASSISTANT')) {
      this.options.metrics?.increment('rpc', 'assistant_stream_unavailable')
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }
    if (!isAllowedRpcRequest(frame, adapter.operations())) {
      // Only reads and two explicitly reviewed POST routes may cross the RPC
      // bridge. An idempotency key never turns an arbitrary mutation into an
      // allowed operation.
      this.options.metrics?.increment('rpc', 'mutating_route_unavailable')
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }
    if (isFilesRpcPath(frame.payload.path)) {
      this.options.metrics?.increment('rpc', 'files_unavailable')
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }
    if (this.activeRpcs.has(frame.requestId)) {
      this.options.metrics?.increment('rpc', 'duplicate_request_id')
      this.sendError(frame.requestId, frame.commandId, 'DUPLICATE_REQUEST')
      return
    }
    if (this.activeRpcs.size >= MAX_ACTIVE_RPC_REQUESTS) {
      this.options.metrics?.increment('rpc', 'concurrency_limit')
      this.sendError(frame.requestId, frame.commandId, 'BUSY')
      return
    }
    if (frame.payload.method !== 'GET' && !frame.payload.idempotencyKey) {
      this.options.metrics?.increment('rpc', 'idempotency_required')
      this.sendError(frame.requestId, frame.commandId, 'IDEMPOTENCY_KEY_REQUIRED')
      return
    }

    if (frame.payload.idempotencyKey) {
      const fingerprint = rpcFingerprint(frame)
      const previous = this.rpcIdempotency.get(frame.payload.idempotencyKey)
      if (previous !== undefined) {
        this.options.metrics?.increment('rpc', previous === fingerprint ? 'duplicate' : 'idempotency_conflict')
        this.sendError(
          frame.requestId,
          frame.commandId,
          previous === fingerprint ? 'DUPLICATE_REQUEST' : 'IDEMPOTENCY_KEY_CONFLICT',
        )
        return
      }
      this.rpcIdempotency.set(frame.payload.idempotencyKey, fingerprint)
      while (this.rpcIdempotency.size > MAX_RPC_IDEMPOTENCY_ENTRIES) {
        const oldest = this.rpcIdempotency.keys().next().value as string | undefined
        if (!oldest) {
          break
        }
        this.rpcIdempotency.delete(oldest)
      }
    }

    const controller = new AbortController()
    const active: ActiveRpc = {
      requestId: frame.requestId,
      commandId: frame.commandId,
      controller,
      creditBytes: Math.min(MAX_RPC_CREDIT_BYTES, frame.payload.initialCreditBytes),
      waiters: new Set(),
    }
    active.deadlineTimer = setTimeout(() => {
      active.abortCode = 'DEADLINE_EXCEEDED'
      controller.abort(new Error('RPC deadline exceeded.'))
      this.wakeRpc(active)
    }, frame.payload.deadlineMs)
    active.deadlineTimer.unref()
    this.activeRpcs.set(frame.requestId, active)
    if (!this.send('RPC_ACCEPTED', frame.requestId, frame.commandId, { accepted: true })) {
      this.finishRpc(active)
      return
    }
    this.options.metrics?.increment('rpc', 'accepted')
    this.trackCleanup(this.runRpc(frame, active))
  }

  private async runRpc(frame: SyncRpcRequestFrame, active: ActiveRpc): Promise<void> {
    try {
      const adapter = this.options.apiRpc as SyncApiRpcAdapter
      const response = await adapter.execute(
        {
          identity: this.identity as SyncTicketIdentity,
          method: frame.payload.method,
          path: frame.payload.path,
          headers: (frame.payload.headers ?? {}) as Record<string, string>,
          ...(Object.hasOwn(frame.payload, 'body') ? { body: frame.payload.body } : {}),
          ...(frame.payload.idempotencyKey ? { idempotencyKey: frame.payload.idempotencyKey } : {}),
          stream: frame.payload.stream,
        },
        active.controller.signal,
      )
      if (
        !Number.isSafeInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        (response.stream !== undefined && !isAsyncIterable(response.stream))
      ) {
        throw new Error('Invalid RPC adapter response.')
      }
      const headers = safeRpcResponseHeaders(response.headers)
      const shouldStream = response.stream !== undefined || frame.payload.stream
      if (
        !this.send('RPC_RESPONSE', frame.requestId, frame.commandId, {
          status: response.status,
          headers,
          stream: shouldStream,
          ...(!shouldStream && Object.hasOwn(response, 'body') ? { body: response.body } : {}),
        })
      ) {
        return
      }

      if (shouldStream) {
        const source = response.stream ?? singleRpcBody(response.body)
        let index = 0
        for await (const sourceChunk of source) {
          if (!(sourceChunk instanceof Uint8Array)) {
            throw new Error('Invalid RPC stream chunk.')
          }
          for (let offset = 0; offset < sourceChunk.byteLength; offset += MAX_RPC_CHUNK_BYTES) {
            const chunk = sourceChunk.subarray(offset, Math.min(sourceChunk.byteLength, offset + MAX_RPC_CHUNK_BYTES))
            await this.consumeRpcCredit(active, chunk.byteLength)
            if (active.controller.signal.aborted || this.closed) {
              throw active.controller.signal.reason ?? new Error('RPC aborted.')
            }
            if (
              !this.send('RPC_CHUNK', frame.requestId, frame.commandId, {
                index,
                bytes: Buffer.from(chunk).toString('base64'),
                byteLength: chunk.byteLength,
              })
            ) {
              return
            }
            index += 1
          }
        }
      }

      this.send('RPC_END', frame.requestId, frame.commandId, { status: 'COMPLETED' })
      this.options.metrics?.increment('rpc', 'completed')
    } catch {
      if (!this.closed) {
        const code = active.abortCode ?? (active.controller.signal.aborted ? 'CANCELLED' : 'BACKEND_ERROR')
        this.options.metrics?.increment('rpc', code.toLowerCase())
        this.sendError(frame.requestId, frame.commandId, code)
      }
    } finally {
      this.finishRpc(active)
    }
  }

  private handleRpcCancel(frame: SyncRpcCancelFrame): void {
    const active = this.activeRpcs.get(frame.payload.targetRequestId)
    if (!active) {
      this.sendError(frame.requestId, frame.commandId, 'UNKNOWN_REQUEST')
      return
    }
    active.abortCode = 'CANCELLED'
    active.controller.abort(new Error('RPC cancelled by client.'))
    this.wakeRpc(active)
    this.options.metrics?.increment('rpc', 'cancelled')
  }

  private handleRpcCredit(frame: SyncRpcCreditFrame): void {
    const active = this.activeRpcs.get(frame.payload.targetRequestId)
    if (!active) {
      this.sendError(frame.requestId, frame.commandId, 'UNKNOWN_REQUEST')
      return
    }
    active.creditBytes = Math.min(MAX_RPC_CREDIT_BYTES, active.creditBytes + frame.payload.creditBytes)
    this.wakeRpc(active)
  }

  private async consumeRpcCredit(active: ActiveRpc, bytes: number): Promise<void> {
    while (active.creditBytes < bytes && !active.controller.signal.aborted && !this.closed) {
      this.options.metrics?.increment('rpc', 'backpressure_wait')
      await new Promise<void>((resolve) => active.waiters.add(resolve))
    }
    if (active.controller.signal.aborted || this.closed) {
      throw active.controller.signal.reason ?? new Error('RPC aborted.')
    }
    active.creditBytes -= bytes
  }

  private wakeRpc(active: ActiveRpc): void {
    for (const wake of active.waiters) {
      wake()
    }
    active.waiters.clear()
  }

  private finishRpc(active: ActiveRpc): void {
    if (this.activeRpcs.get(active.requestId) === active) {
      this.activeRpcs.delete(active.requestId)
    }
    if (active.deadlineTimer) {
      clearTimeout(active.deadlineTimer)
    }
    this.wakeRpc(active)
  }

  private abortActiveRpcs(code: string): void {
    for (const active of this.activeRpcs.values()) {
      active.abortCode = code
      active.controller.abort(new Error(code))
      this.wakeRpc(active)
      if (active.deadlineTimer) {
        clearTimeout(active.deadlineTimer)
      }
    }
    this.activeRpcs.clear()
  }

  private async handleStatus(frame: SyncStatusRequestFrame): Promise<void> {
    if (!this.options.backend.ready()) {
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }
    const identity = this.identity as SyncTicketIdentity
    const controller = new AbortController()
    this.activeAbort = controller
    try {
      const authorization = await this.withTimeout(
        (signal) =>
          this.options.authorization.authorize(
            {
              identity,
              operation: 'STATUS',
              commandId: frame.commandId,
              digest: frame.digest,
              payloadLength: 0,
            },
            signal,
          ),
        controller,
      )
      if (!authorization.authorized) {
        this.options.metrics?.increment('authorization', authorization.code)
        this.sendError(frame.requestId, frame.commandId, publicAuthorizationCode(authorization.code))
        return
      }
      const status = await this.withTimeout(
        (signal) => this.options.backend.status({ identity, commandId: frame.commandId, digest: frame.digest }, signal),
        controller,
      )
      if (status.digest && !constantTimeTextMatches(status.digest, frame.digest)) {
        this.sendError(frame.requestId, frame.commandId, 'COMMAND_ID_CONFLICT')
        return
      }
      this.send(
        'STATUS',
        frame.requestId,
        frame.commandId,
        {
          status: status.status,
          ...('payload' in status && status.payload !== undefined ? { result: status.payload } : {}),
          ...('code' in status ? { code: status.code } : {}),
        },
        frame.digest,
      )
    } catch {
      this.options.metrics?.increment('backend', controller.signal.aborted ? 'timeout' : 'error')
      this.sendError(frame.requestId, frame.commandId, controller.signal.aborted ? 'BACKEND_TIMEOUT' : 'BACKEND_ERROR')
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = undefined
      }
    }
  }

  private async handleCommand(frame: SyncCommandFrame): Promise<void> {
    // Refused BEFORE a command lease is acquired: a socket that never
    // advertised SYNC_ITEMS must not be able to take durable-command leases.
    if (!this.options.backend.ready()) {
      this.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }
    const identity = this.identity as SyncTicketIdentity
    const leaseInput = {
      userUuid: identity.userUuid,
      deviceId: identity.deviceId,
      commandId: frame.commandId,
      digest: frame.digest,
      ownerId: this.options.ownerId,
    }
    const lease = await this.options.leases.acquire(leaseInput, this.lifecycleAbort.signal)
    if (!lease.acquired) {
      this.sendError(frame.requestId, frame.commandId, lease.reason)
      return
    }
    this.activeLease = leaseInput
    const controller = new AbortController()
    this.activeAbort = controller

    try {
      await this.withLeaseRenewal(controller, async () => {
        const firstAuthorization = await this.authorizeCommand(identity, frame, controller)
        if (!firstAuthorization.authorized) {
          this.options.metrics?.increment('authorization', firstAuthorization.code)
          this.sendError(frame.requestId, frame.commandId, publicAuthorizationCode(firstAuthorization.code))
          return
        }

        if (!this.send('ACCEPTED', frame.requestId, frame.commandId, { status: 'ACCEPTED' }, frame.digest)) {
          return
        }

        // Re-run the complete live policy after ACCEPTED and immediately before
        // the durable write. Session/vault/read-only state may change while a
        // command waits behind authorization or distributed coordination.
        const executeAuthorization = await this.authorizeCommand(identity, frame, controller)
        if (!executeAuthorization.authorized) {
          this.options.metrics?.increment('authorization', executeAuthorization.code)
          this.sendError(frame.requestId, frame.commandId, publicAuthorizationCode(executeAuthorization.code))
          return
        }

        const committed = await this.withTimeout(
          (signal) =>
            this.options.backend.execute(
              { identity, commandId: frame.commandId, digest: frame.digest, payload: frame.payload },
              signal,
            ),
          controller,
        )
        if (!constantTimeTextMatches(committed.digest, frame.digest)) {
          this.sendError(frame.requestId, frame.commandId, 'COMMAND_ID_CONFLICT')
          return
        }
        this.send(
          'COMMITTED',
          frame.requestId,
          frame.commandId,
          {
            status: 'COMMITTED',
            ...(committed.payload !== undefined ? { result: committed.payload } : {}),
          },
          frame.digest,
        )
        this.options.metrics?.increment('command', 'committed')
      })
    } catch (error) {
      const leaseLost = error instanceof SyncLeaseLostError || controller.signal.reason instanceof SyncLeaseLostError
      const timedOut = controller.signal.aborted && !leaseLost && !this.closed
      this.options.metrics?.increment(
        leaseLost ? 'lease' : 'backend',
        leaseLost ? 'lost' : timedOut ? 'timeout' : 'error',
      )
      this.sendError(
        frame.requestId,
        frame.commandId,
        leaseLost ? 'LEASE_LOST' : timedOut ? 'BACKEND_TIMEOUT' : 'BACKEND_ERROR',
      )
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = undefined
      }
      await this.releaseActiveLease()
    }
  }

  private authorizeCommand(
    identity: SyncTicketIdentity,
    frame: SyncCommandFrame,
    controller: AbortController,
  ): Promise<SyncAuthorizationDecision> {
    return this.withTimeout(
      (signal) =>
        this.options.authorization.authorize(
          {
            identity,
            operation: 'COMMAND',
            commandId: frame.commandId,
            digest: frame.digest,
            payloadLength: frame.payloadLength,
            payload: frame.payload,
          },
          signal,
        ),
      controller,
    )
  }

  private async withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    if (controller.signal.aborted) {
      throw new Error('Sync operation was aborted.')
    }
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error('sync backend timeout'))
          }, this.backendTimeoutMs)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  private async withLeaseRenewal<T>(controller: AbortController, operation: () => Promise<T>): Promise<T> {
    const lease = this.activeLease
    if (!lease) {
      throw new SyncLeaseLostError()
    }
    let timer: NodeJS.Timeout | undefined
    let stopped = false
    let rejectLost!: (error: Error) => void
    const lost = new Promise<never>((_resolve, reject) => {
      rejectLost = reject
    })
    const schedule = (): void => {
      timer = setTimeout(() => {
        void (async () => {
          try {
            const renewed = await this.options.leases.renew(lease, this.lifecycleAbort.signal)
            if (!renewed) {
              throw new SyncLeaseLostError()
            }
            if (!stopped && !this.closed) {
              schedule()
            }
          } catch {
            if (!stopped) {
              const lostError = new SyncLeaseLostError()
              controller.abort(lostError)
              rejectLost(lostError)
            }
          }
        })()
      }, this.leaseRenewIntervalMs)
      timer.unref()
    }
    schedule()
    try {
      return await Promise.race([operation(), lost])
    } finally {
      stopped = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private send(
    type: SyncServerFrameType,
    requestId: string,
    commandId: string,
    payload: JsonObject,
    digest?: string,
  ): boolean {
    if (this.closed) {
      return false
    }
    if (this.serverSequence >= MAX_SYNC_SEQUENCE) {
      this.failAndClose('SEQUENCE_EXHAUSTED', 'Sync response sequence was exhausted.')
      return false
    }
    const frame = createSyncServerFrame({
      type,
      requestId,
      commandId,
      sequence: this.serverSequence + 1,
      payload,
      digest,
    })
    const serialized = JSON.stringify(frame)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_SYNC_FRAME_BYTES) {
      this.options.metrics?.increment('egress', 'RESULT_TOO_LARGE')
      this.sendError(requestId, commandId, 'RESULT_TOO_LARGE')
      return false
    }
    if (this.options.socket.bufferedAmount + bytes > this.maxBufferedBytes) {
      this.options.metrics?.increment('backpressure', 'egress')
      this.failAndClose('BACKPRESSURE', 'Sync client is not consuming responses.', 1013)
      return false
    }
    try {
      this.options.socket.send(serialized)
      this.serverSequence = frame.sequence
      return true
    } catch {
      this.disconnect()
      return false
    }
  }

  private sendError(requestId: string, commandId: string, code: string): boolean {
    if (this.closed || this.serverSequence >= MAX_SYNC_SEQUENCE) {
      return false
    }
    const frame = createSyncServerFrame({
      type: 'ERROR',
      requestId,
      commandId,
      sequence: this.serverSequence + 1,
      payload: { code, retryable: isRetryableError(code) },
    })
    const serialized = JSON.stringify(frame)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_SYNC_FRAME_BYTES || this.options.socket.bufferedAmount + bytes > this.maxBufferedBytes) {
      return false
    }
    try {
      this.options.socket.send(serialized)
      this.serverSequence = frame.sequence
      return true
    } catch {
      this.disconnect()
      return false
    }
  }

  private sendBinary(bytes: Uint8Array): boolean {
    if (this.closed || bytes.byteLength > MAX_FILE_BINARY_FRAME_BYTES) {
      return false
    }
    if (this.options.socket.bufferedAmount + bytes.byteLength > this.maxBufferedBytes) {
      this.options.metrics?.increment('backpressure', 'files_egress')
      return false
    }
    try {
      this.options.socket.send(bytes)
      return true
    } catch {
      this.disconnect()
      return false
    }
  }

  private failAndClose(code: string, message: string, closeCode = 1008): void {
    if (this.closed) {
      return
    }
    this.sendError('protocol', 'protocol', code)
    this.closed = true
    clearTimeout(this.authTimer)
    if (this.socketBudgetRenewTimer) {
      clearTimeout(this.socketBudgetRenewTimer)
    }
    this.lifecycleAbort.abort()
    this.activeAbort?.abort()
    this.abortActiveRpcs(code)
    this.stopInviteSubscription()
    this.filesSession?.disconnect()
    this.trackCleanup(this.releaseActiveLease())
    this.trackCleanup(this.releaseSocketBudget())
    try {
      this.options.socket.close(closeCode, message.slice(0, 123))
    } catch {
      // State is already closed and all reservations are released.
    }
  }

  private scheduleSocketBudgetRenewal(): void {
    if (!this.activeSocketBudget || this.closed) {
      return
    }
    this.socketBudgetRenewTimer = setTimeout(() => {
      void (async () => {
        const reservation = this.activeSocketBudget
        if (!reservation || this.closed) {
          return
        }
        try {
          const renewed = await this.options.socketBudget.renew(reservation, this.lifecycleAbort.signal)
          if (!renewed) {
            this.options.metrics?.increment('socket_budget', 'lost')
            this.failAndClose('SOCKET_BUDGET_LOST', 'Sync socket reservation was lost.', 1013)
            return
          }
          this.scheduleSocketBudgetRenewal()
        } catch {
          if (!this.closed) {
            this.options.metrics?.increment('socket_budget', 'error')
            this.failAndClose('SOCKET_BUDGET_LOST', 'Sync socket reservation was lost.', 1013)
          }
        }
      })()
    }, this.socketBudgetRenewIntervalMs)
    this.socketBudgetRenewTimer.unref()
  }

  private async releaseActiveLease(): Promise<void> {
    const lease = this.activeLease
    if (!lease) {
      return
    }
    this.activeLease = undefined
    try {
      await this.options.leases.release(lease)
    } catch {
      this.options.metrics?.increment('lease', 'release_error')
      // The bounded TTL remains the final fail-safe after a Redis outage.
    }
  }

  private async releaseSocketBudget(): Promise<void> {
    const reservation = this.activeSocketBudget
    if (!reservation) {
      return
    }
    this.activeSocketBudget = undefined
    if (this.socketBudgetRenewTimer) {
      clearTimeout(this.socketBudgetRenewTimer)
    }
    try {
      await this.options.socketBudget.release(reservation)
    } catch {
      this.options.metrics?.increment('socket_budget', 'release_error')
      // The bounded TTL prevents a permanent per-user capacity leak.
    }
  }

  private trackCleanup(task: Promise<unknown>): void {
    const tracked = task.catch(() => undefined).finally(() => this.cleanupTasks.delete(tracked))
    this.cleanupTasks.add(tracked)
  }
}

function isValidCollaborationAuthorizationResult(
  result: SyncCollaborationAuthorizationResult,
  request: Extract<SyncCollaborationAuthorizationPayload, { expectedRoomEpoch: string }>,
  discovery: CollaborationEpochDiscovery,
): result is Extract<SyncCollaborationAuthorizationResult, { epochDiscovery?: false }> {
  return (
    result.authorized === true &&
    result.epochDiscovery !== true &&
    typeof result.capability === 'string' &&
    result.capability.length > 0 &&
    result.room === request.noteUuid &&
    Number.isSafeInteger(result.expiresIn) &&
    result.expiresIn > 0 &&
    Number.isSafeInteger(result.serverUpdatedAtTimestamp) &&
    result.serverUpdatedAtTimestamp > 0 &&
    result.collaborationProtocolVersion === 3 &&
    isValidCollaborationEpoch(result.roomEpoch) &&
    isValidCollaborationEpoch(result.collaborationSecurityEpoch) &&
    result.roomEpoch === request.expectedRoomEpoch &&
    result.roomEpoch === discovery.roomEpoch &&
    result.collaborationSecurityEpoch === discovery.collaborationSecurityEpoch &&
    result.leaseRequestId === request.leaseRequestId &&
    result.bootstrapChallenge === request.bootstrapChallenge
  )
}

function isCollaborationEpochDiscoveryRequest(
  request: SyncCollaborationAuthorizationPayload,
): request is Extract<SyncCollaborationAuthorizationPayload, { epochDiscovery: true }> {
  return request.epochDiscovery === true
}

function isValidCollaborationEpochDiscoveryResult(
  result: SyncCollaborationAuthorizationResult,
  request: Extract<SyncCollaborationAuthorizationPayload, { epochDiscovery: true }>,
): result is Extract<SyncCollaborationAuthorizationResult, { epochDiscovery: true }> {
  return (
    result.authorized === true &&
    result.epochDiscovery === true &&
    result.room === request.noteUuid &&
    Number.isSafeInteger(result.serverUpdatedAtTimestamp) &&
    result.serverUpdatedAtTimestamp > 0 &&
    result.collaborationProtocolVersion === 3 &&
    isValidCollaborationEpoch(result.roomEpoch) &&
    isValidCollaborationEpoch(result.collaborationSecurityEpoch) &&
    !('capability' in result) &&
    !('expiresIn' in result)
  )
}

function isValidCollaborationEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value)
}

const RPC_RESPONSE_HEADER_NAMES = new Set([
  'cache-control',
  'content-disposition',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'retry-after',
  'x-request-id',
])

function isAssistantStreamPath(path: string): boolean {
  return new URL(path, 'http://rpc.invalid').pathname === '/v1/assistant/stream'
}

function isAllowedRpcRequest(
  frame: SyncRpcRequestFrame,
  operations: readonly Extract<SyncNegotiatedOperation, 'API_RPC' | 'STREAM_ASSISTANT'>[],
): boolean {
  if (frame.payload.method === 'GET') {
    return true
  }
  if (frame.payload.method !== 'POST') {
    return false
  }
  const pathname = new URL(frame.payload.path, 'http://rpc.invalid').pathname
  return (
    (pathname === '/v1/assistant/stream' && operations.includes('STREAM_ASSISTANT')) ||
    pathname === '/v1/collaboration/authorize'
  )
}

function isFilesRpcPath(path: string): boolean {
  const pathname = new URL(path, 'http://rpc.invalid').pathname
  return pathname === '/v1/files' || pathname.startsWith('/v1/files/')
}

function rpcFingerprint(frame: SyncRpcRequestFrame): string {
  const headers = Object.fromEntries(
    Object.entries(frame.payload.headers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  )
  return createHash('sha256')
    .update(
      JSON.stringify({
        method: frame.payload.method,
        path: frame.payload.path,
        headers,
        body: frame.payload.body,
        stream: frame.payload.stream,
      }),
      'utf8',
    )
    .digest('hex')
}

function safeRpcResponseHeaders(headers: Record<string, string> | undefined): JsonObject {
  const safe: JsonObject = {}
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase()
    if (
      rawName === name &&
      RPC_RESPONSE_HEADER_NAMES.has(name) &&
      typeof value === 'string' &&
      value.length <= 1_024 &&
      !/[\r\n]/u.test(value)
    ) {
      safe[name] = value
    }
  }
  return safe
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  )
}

async function* singleRpcBody(body: unknown): AsyncGenerator<Uint8Array> {
  if (body === undefined) {
    return
  }
  if (body instanceof Uint8Array) {
    yield body
    return
  }
  yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
}

function isRetryableError(code: string): boolean {
  return (
    code === 'BUSY' ||
    code === 'BACKEND_TIMEOUT' ||
    code === 'BACKEND_ERROR' ||
    code === 'SYNC_DISABLED' ||
    code === 'RESULT_TOO_LARGE' ||
    code === 'LEASE_LOST' ||
    code === 'SOCKET_LIMIT' ||
    code === 'SOCKET_BUDGET_LOST' ||
    code === 'OPERATION_UNAVAILABLE' ||
    code === 'INVITE_STORE_UNAVAILABLE' ||
    code === 'DEADLINE_EXCEEDED'
  )
}

function isOpaqueInviteCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 2_048
}

function isValidInviteReplay(value: unknown, expectedCursor: string, limit: number): value is SyncInviteEventReplay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const replay = value as Partial<SyncInviteEventReplay>
  if (
    replay.previousCursor !== expectedCursor ||
    !isOpaqueInviteCursor(replay.nextCursor) ||
    !Array.isArray(replay.events) ||
    replay.events.length > limit ||
    typeof replay.hasMore !== 'boolean' ||
    !replay.events.every(isValidInviteEvent)
  ) {
    return false
  }
  if (replay.events.length === 0) {
    return replay.nextCursor === expectedCursor && replay.hasMore === false
  }
  const positions = replay.events.map((event) => event.streamPosition)
  return new Set(positions).size === positions.length && positions.at(-1) === replay.nextCursor
}

const INVITE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const INVITE_BASE_EVENT_FIELDS = ['version', 'eventId', 'streamPosition', 'kind', 'action', 'occurredAt'] as const
const SHARED_VAULT_INVITE_EVENT_FIELDS = new Set([...INVITE_BASE_EVENT_FIELDS, 'inviteUuid', 'sharedVaultUuid'])
const SUBSCRIPTION_INVITE_EVENT_FIELDS = new Set([...INVITE_BASE_EVENT_FIELDS, 'inviteUuid'])
const SHARED_VAULT_MEMBERSHIP_EVENT_FIELDS = new Set([
  ...INVITE_BASE_EVENT_FIELDS,
  'sharedVaultUuid',
  'memberUserUuid',
  'membershipUuid',
  'inviteUuid',
  'role',
  'revision',
])
const APPLICATION_STATE_EVENT_FIELDS = new Set([...INVITE_BASE_EVENT_FIELDS, 'resource', 'resourceUuid', 'revision'])
const INVITE_ACTIONS = new Set(['created', 'updated', 'accepted', 'declined', 'canceled', 'deleted'])
const MEMBERSHIP_ACTIONS = new Set(['invited', 'accepted', 'joined', 'left', 'revoked', 'role-changed'])
const MEMBERSHIP_ROLES = new Set(['read', 'write', 'admin'])
const APPLICATION_STATE_ACTIONS = new Set(['updated', 'invalidated'])
const APPLICATION_STATE_RESOURCES = new Set([
  'items',
  'shared-vaults',
  'shared-vault-members',
  'files-metadata',
  'preferences',
  'account',
  'subscriptions',
])

function isValidInviteEvent(value: unknown): value is JsonObject & { streamPosition: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const event = value as Record<string, unknown>
  if (
    event.version !== 1 ||
    !isInviteUuid(event.eventId) ||
    !isOpaqueInviteCursor(event.streamPosition) ||
    !Number.isSafeInteger(event.occurredAt) ||
    Number(event.occurredAt) <= 0
  ) {
    return false
  }

  switch (event.kind) {
    case 'shared-vault-invite':
      return (
        hasOnlyInviteEventFields(event, SHARED_VAULT_INVITE_EVENT_FIELDS) &&
        typeof event.action === 'string' &&
        INVITE_ACTIONS.has(event.action) &&
        isInviteUuid(event.inviteUuid) &&
        isInviteUuid(event.sharedVaultUuid)
      )
    case 'subscription-invite':
      return (
        hasOnlyInviteEventFields(event, SUBSCRIPTION_INVITE_EVENT_FIELDS) &&
        typeof event.action === 'string' &&
        INVITE_ACTIONS.has(event.action) &&
        isInviteUuid(event.inviteUuid)
      )
    case 'shared-vault-membership': {
      if (
        !hasOnlyInviteEventFields(event, SHARED_VAULT_MEMBERSHIP_EVENT_FIELDS) ||
        typeof event.action !== 'string' ||
        !MEMBERSHIP_ACTIONS.has(event.action) ||
        !isInviteUuid(event.sharedVaultUuid) ||
        !isInviteUuid(event.memberUserUuid) ||
        !isCanonicalInviteRevision(event.revision)
      ) {
        return false
      }
      const needsMembership = event.action !== 'invited'
      const needsInvite = event.action === 'invited' || event.action === 'accepted'
      const needsRole = ['invited', 'accepted', 'joined', 'role-changed'].includes(event.action)
      return (
        (needsMembership ? isInviteUuid(event.membershipUuid) : event.membershipUuid === undefined) &&
        (needsInvite ? isInviteUuid(event.inviteUuid) : event.inviteUuid === undefined) &&
        (needsRole ? typeof event.role === 'string' && MEMBERSHIP_ROLES.has(event.role) : event.role === undefined)
      )
    }
    case 'application-state':
      return (
        hasOnlyInviteEventFields(event, APPLICATION_STATE_EVENT_FIELDS) &&
        typeof event.action === 'string' &&
        APPLICATION_STATE_ACTIONS.has(event.action) &&
        typeof event.resource === 'string' &&
        APPLICATION_STATE_RESOURCES.has(event.resource) &&
        (event.resourceUuid === undefined || isInviteUuid(event.resourceUuid)) &&
        isCanonicalInviteRevision(event.revision)
      )
    default:
      return false
  }
}

function hasOnlyInviteEventFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => fields.has(field))
}

function isInviteUuid(value: unknown): value is string {
  return typeof value === 'string' && INVITE_UUID_PATTERN.test(value)
}

function isCanonicalInviteRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,31}$/u.test(value)
}

function inviteStreamErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }
  return typeof error.code === 'string' ? error.code : undefined
}
