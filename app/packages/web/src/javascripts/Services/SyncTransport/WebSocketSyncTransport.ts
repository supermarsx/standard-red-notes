import type {
  AccountSyncCommandMetadata,
  AccountSyncHttpFallback,
  AccountSyncTransportContext,
  AccountSyncTransportInterface,
  AccountSyncTransportRecoveryResult,
  AccountSyncTransportRequest,
  AccountSyncTransportResult,
  InviteRealtimeBatch,
} from '@standardnotes/services'
import type { HttpResponse, RawSyncResponse } from '@standardnotes/snjs'
import * as SyncTransportWorkerModule from './syncTransport.worker'
import {
  CollaborationAuthorizationTransportRequest,
  CollaborationAuthorizationTransportResult,
  AuthenticatedRpcRequest as AuthenticatedRpcRequestInput,
  DEFAULT_FILE_TRANSFER_CREDIT_BYTES,
  DEFAULT_FILE_TRANSFER_DEADLINE_MS,
  DEFAULT_RPC_CREDIT_BYTES,
  DEFAULT_RPC_DEADLINE_MS,
  isSocketFileResourceReference,
  MainToSyncWorkerMessage,
  MAX_RPC_CREDIT_BYTES,
  SocketFileResourceReference,
  MAX_RPC_DEADLINE_MS,
  MIN_RPC_DEADLINE_MS,
  normalizeSyncRequestForWire,
  SYNC_FALLBACK_REASON_EXPLANATIONS,
  SyncFallbackReason,
  SyncTransportState,
  SyncNegotiatedOperation,
  SyncWorkerToMainMessage,
  utf8Bytes,
  WorkerAuthenticatedRpcRequest,
} from './syncTransportProtocol'
import { OWNER_LEASE_TTL_MS } from './SyncTransportOutbox'

type SyncWorkerLike = {
  onmessage: ((event: MessageEvent<SyncWorkerToMainMessage>) => void) | null
  onerror: (() => void) | null
  postMessage(message: MainToSyncWorkerMessage): void
  terminate(): void
}

const SyncTransportWorker = ((SyncTransportWorkerModule as { default?: { new (): Worker } }).default ??
  (SyncTransportWorkerModule as unknown as { new (): Worker })) as { new (): Worker }

const BARRIER_TIMEOUT_MS = 5_000

export type AuthenticatedSyncScopeInput = {
  applicationIdentifier: string
  host: string
  userUuid: string
  accessToken: string
}

/** Derive a non-secret epoch that stays stable when only token secret material rotates. */
export async function deriveOpaqueSyncSessionScope(
  input: AuthenticatedSyncScopeInput,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const tokenParts = input.accessToken.split(':')
  const stableSessionIdentifier =
    tokenParts.length >= 3 && /^\d+$/u.test(tokenParts[0]) && tokenParts[1].length > 0
      ? `${tokenParts[0]}:${tokenParts[1]}`
      : input.accessToken
  const material = JSON.stringify({
    version: 1,
    applicationIdentifier: input.applicationIdentifier,
    host: input.host,
    userUuid: input.userUuid,
    sessionIdentifier: stableSessionIdentifier,
  })
  const digest = await subtle.digest('SHA-256', utf8Bytes(material) as unknown as BufferSource)
  const digestHex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sync-session-v1:${digestHex}`
}

export type SyncCapability = {
  id: 'ws-sync'
  version: 1
  endpoint: string
}

export type SyncTicketResponse = {
  ticket: string
  expiresAt: number
  /**
   * Server clock at issue time, when the server reports it. Together with
   * `expiresAt` it gives the ticket's lifetime without trusting either clock to
   * agree with the other; without it the client performs no local expiry check.
   */
  issuedAt?: number
  endpoint: string
  capability: 'ws-sync'
  version: 1
}

/**
 * A control-plane request the server ANSWERED with a non-success status. Only an
 * answer can prove the capability absent; a thrown request (network error,
 * timeout) or a bare `undefined` proves nothing and must stay retryable. `code`
 * and `transient` come from the JSON error body when the server sent one
 * (`{ error: { code: 'SYNC_DISABLED', transient: true } }` during a store outage).
 */
export type SyncControlPlaneRefusal = {
  refused: true
  status: number
  code?: string
  transient?: boolean
}

export function isSyncControlPlaneRefusal(value: unknown): value is SyncControlPlaneRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { refused?: unknown }).refused === true &&
    Number.isSafeInteger((value as { status?: unknown }).status)
  )
}

export interface SyncTransportControlPlane {
  /**
   * Compatibility probe used only after ticket issuance says the operation is
   * unavailable. Return the list the server answered with, a refusal for a
   * non-success answer, `undefined` when the answer could not be read, and throw
   * on a network failure.
   */
  getCapabilities?(): Promise<{ capabilities: SyncCapability[] } | SyncControlPlaneRefusal | undefined>
  /** Same contract: refusal for a non-success answer, `undefined` for an unreadable one, throw on network failure. */
  createTicket(deviceId: string): Promise<SyncTicketResponse | SyncControlPlaneRefusal | undefined>
}

export type WebSocketSyncTransportOptions = {
  controlPlane: SyncTransportControlPlane
  getConfiguredWebSocketUrl: () => string | undefined
  /** Stable for access-token refresh, different for logout/new-login. */
  getAuthenticatedSessionScope: () => Promise<string | undefined>
  deviceId: string
  isHttpOnly?: () => boolean
  workerFactory?: () => SyncWorkerLike
  environment?: {
    hasWorker: boolean
    hasWebSocket: boolean
    hasIndexedDb: boolean
    /** Defaults to `location.protocol`; only http(s) pages have an origin the sync lane can use. */
    pageProtocol?: string
  }
}

type TransportResponse = HttpResponse<RawSyncResponse>
type CapabilityProbeVerdict = 'present' | 'absent' | 'unknown'
type PendingResult =
  AccountSyncTransportResult<TransportResponse> | AccountSyncTransportRecoveryResult<TransportResponse> | undefined

type PendingExecution = {
  mode: 'execute' | 'recover'
  sessionScope: string
  body?: AccountSyncTransportRequest
  httpFallback: AccountSyncHttpFallback<TransportResponse>
  resolve: (result: PendingResult) => void
  reject: (error: unknown) => void
  persisted?: { body: AccountSyncTransportRequest; command: AccountSyncCommandMetadata }
}

type Barrier = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type PendingCollaborationAuthorization = {
  sessionScope: string
  resolve: (result: CollaborationAuthorizationTransportResult | null | undefined) => void
  reject: (error: unknown) => void
}

export type InviteRealtimeSubscriptionOptions = {
  cursor?: string
  limit?: number
  /** Must resolve to the exact batch cursor only after authoritative state and its checkpoint are durable. */
  applyBatch(batch: InviteRealtimeBatch): Promise<string>
  /** Must complete the authoritative HTTP snapshot and reset its checkpoint before resolving. */
  reconcile(input: {
    reason: 'BOOTSTRAP_REQUIRED' | 'CURSOR_EXPIRED' | 'CURSOR_INVALID'
    cursor: string
  }): Promise<void>
  onReady?: (cursor: string) => void
  onError?: (error: AuthenticatedRpcError) => void
}

type PendingInviteSubscription = {
  sessionScope: string
  options: InviteRealtimeSubscriptionOptions
  tail: Promise<void>
}

export type AuthenticatedRpcResponse = {
  status: number
  headers: Record<string, string>
  body?: unknown
  stream?: ReadableStream<Uint8Array>
  transport: 'websocket'
}

export type AuthenticatedRpcStreamRequest = AuthenticatedRpcRequestInput & {
  signal?: AbortSignal
}

export class AuthenticatedRpcError extends Error {
  override readonly name = 'AuthenticatedRpcError'

  constructor(
    readonly code: string,
    readonly retryable: boolean,
    /** True only when no RPC request bytes crossed the authenticated socket. */
    readonly safeToFallback: boolean,
  ) {
    super(`Authenticated websocket RPC failed: ${code}`)
  }
}

type PendingRpc = {
  sessionScope: string
  accepted: boolean
  responseResolved: boolean
  resolve: (response: AuthenticatedRpcResponse) => void
  reject: (error: unknown) => void
  response?: AuthenticatedRpcResponse
  streamController?: ReadableStreamDefaultController<Uint8Array>
  creditToReturn: number
  abortCleanup?: () => void
}

type RpcWorkerMessage = Extract<
  SyncWorkerToMainMessage,
  { type: 'RPC_ACCEPTED' | 'RPC_RESPONSE' | 'RPC_CHUNK' | 'RPC_END' | 'RPC_ERROR' }
>

type FileDownloadWorkerMessage = Extract<
  SyncWorkerToMainMessage,
  { type: 'FILE_DOWNLOAD_ACCEPTED' | 'FILE_DOWNLOAD_CHUNK' | 'FILE_DOWNLOAD_COMPLETE' | 'FILE_DOWNLOAD_ERROR' }
>

export type SocketFileDownloadRequest = {
  /**
   * Passed through to the gateway byte-identical. This is the same string the
   * file's encryptor and decryptor use as the xchacha20 AAD, so it is never
   * derived, normalized or regenerated on this path.
   */
  remoteIdentifier: string
  fileUuid: string
  /**
   * Present only for a file that lives in a shared vault, and only when both
   * values come from the vault listing that genuinely records them. Omitted, the
   * transfer is opened as a personal resource.
   */
  sharedVault?: { sharedVaultUuid: string; sharedVaultOwnerUuid: string }
  /** The client's own authenticated total, i.e. the sum of `encryptedChunkSizes`. */
  declaredSize: number
  /** Receives the encrypted stream in order. Backpressure: credit is returned only once this resolves. */
  onBytes: (bytes: Uint8Array) => Promise<void>
  signal?: AbortSignal
}

export type SocketFileDownloadOutcome =
  | { outcome: 'completed'; sha256: string }
  /** No socket, or the gateway does not advertise FILES_V1. Nothing was attempted. */
  | { outcome: 'unavailable' }
  | { outcome: 'aborted' }
  | {
      outcome: 'failed'
      code: string
      retryable: boolean
      /** True only if no byte reached `onBytes`, so an HTTP retry cannot double-feed the decryptor. */
      safeToFallback: boolean
    }

type PendingFileDownload = {
  sessionScope: string
  request: SocketFileDownloadRequest
  settle: (outcome: SocketFileDownloadOutcome) => void
  settled: boolean
  bytesDelivered: number
  tail: Promise<void>
  abortCleanup?: () => void
}

const CAPABILITY_REPROBE_MS = 60_000

/**
 * How long the worker is given to hand its multi-tab owner lease back before the
 * page terminates it. Short enough to be invisible on a tab close, long enough
 * for one IndexedDB write.
 */
const WORKER_SHUTDOWN_GRACE_MS = 500

/**
 * The worker lane rides a same-origin websocket, so it only makes sense from a
 * page served over http(s). Electron `file:`, a React Native webview or an
 * extension popup have no such origin and run the legacy socket lane only.
 */
function pageOriginSupportsSyncLane(pageProtocol: string | undefined): boolean {
  const protocol = pageProtocol ?? (globalThis as { location?: { protocol?: unknown } }).location?.protocol
  return protocol === undefined || protocol === 'http:' || protocol === 'https:'
}

/**
 * Statuses with which a server states that this endpoint does not exist here.
 * Anything else — 5xx from a proxy mid-deploy, 429, 401 — says nothing about the
 * capability and must stay retryable.
 */
const CAPABILITY_ABSENT_STATUSES = new Set([404, 410, 501])

function refusalProvesCapabilityAbsent(refusal: SyncControlPlaneRefusal): boolean {
  if (CAPABILITY_ABSENT_STATUSES.has(refusal.status)) {
    return true
  }
  // 503 SYNC_DISABLED without `transient` is the gateway saying the lane is
  // switched off by configuration; with `transient: true` its stores are still
  // coming up and the very same request may succeed seconds later.
  return refusal.status === 503 && refusal.code === 'SYNC_DISABLED' && refusal.transient !== true
}

function defaultHttpOnly(): boolean {
  const injected = (globalThis as { _sync_transport?: unknown })._sync_transport
  if (injected === 'http-only') {
    return true
  }
  try {
    return globalThis.localStorage?.getItem('standardnotes.sync-transport') === 'http-only'
  } catch {
    return false
  }
}

function normalizeCommittedResult(result: unknown): TransportResponse | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined
  }
  const candidate = result as { status?: unknown; data?: unknown }
  if (typeof candidate.status === 'number' && candidate.data && typeof candidate.data === 'object') {
    return result as TransportResponse
  }
  return { status: 200, data: result as RawSyncResponse } as TransportResponse
}

/** Main-thread facade. The worker receives only short-lived tickets and opaque sync bodies. */
export class WebSocketSyncTransport implements AccountSyncTransportInterface<TransportResponse> {
  private worker?: SyncWorkerLike
  private workerSessionScope?: string
  private readonly pending = new Map<string, PendingExecution>()
  private readonly pendingCollaboration = new Map<string, PendingCollaborationAuthorization>()
  private readonly pendingInviteSubscriptions = new Map<string, PendingInviteSubscription>()
  private readonly pendingRpcs = new Map<string, PendingRpc>()
  private readonly pendingFileDownloads = new Map<string, PendingFileDownload>()
  private readonly checkpointBarriers = new Map<string, Barrier>()
  private readonly revocationBarriers = new Map<string, Barrier>()
  private readonly revokedSessionScopes = new Set<string>()
  private readonly acknowledgedRevokedSessionScopes = new Set<string>()
  private state: SyncTransportState = 'HTTP_ONLY'
  private requestCounter = 0
  private deinitialized = false
  private executionTail: Promise<void> = Promise.resolve()
  private negotiated?: {
    sessionScope: string
    protocolVersion: 1
    endpoint: string
    operations: ReadonlySet<SyncNegotiatedOperation>
  }
  private capabilityProbe?: Promise<CapabilityProbeVerdict>
  /**
   * Negative ticket cache. It stores the classified reason with its deadline and
   * replays that exact reason, so a transient `ticket-unavailable` never gets
   * rewritten into the permanent `capability-unavailable` for the next request.
   */
  private ticketFailureCache?: { reason: SyncFallbackReason; until: number }
  private fallbackReason?: SyncFallbackReason
  /**
   * Signature of the last transition this transport announced to the console, so
   * a state that is re-reported on every sync round (HTTP_FALLBACK with the same
   * reason is the normal case on a gateway that advertises no SYNC_ITEMS) is
   * logged once per genuine change rather than once per save.
   */
  private lastLoggedTransition?: string
  private pageHideListener?: () => void
  private shutdownBarrier?: () => void

  constructor(private readonly options: WebSocketSyncTransportOptions) {}

  get transportState(): SyncTransportState {
    return this.state
  }

  get transportStatus(): {
    state: SyncTransportState
    fallbackReason?: SyncFallbackReason
    operations: readonly SyncNegotiatedOperation[]
  } {
    return {
      state: this.state,
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
      operations: this.negotiated ? [...this.negotiated.operations] : [],
    }
  }

  recoverPending(
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
  ): Promise<AccountSyncTransportRecoveryResult<TransportResponse> | undefined> {
    return this.enqueue(() => this.recoverPendingOrdered(httpFallback))
  }

  execute(
    request: AccountSyncTransportRequest,
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
    context?: AccountSyncTransportContext,
  ): Promise<AccountSyncTransportResult<TransportResponse>> {
    return this.enqueue(() => this.executeOrdered(request, httpFallback, context))
  }

  /**
   * `expectedRoomEpoch` is optional by design rather than vestigial. Omitted, the
   * worker discovers the room epoch itself and grants against whatever it finds.
   * Supplied, it pins the request: `SyncTransportWorkerRuntime` compares it to the
   * discovered epoch and denies before the grant leg is ever sent, so a caller
   * holding state from a since-rotated room is cut off during discovery instead of
   * receiving a capability for the new epoch.
   */
  authorizeCollaborationRoom(
    noteUuid: string,
    leaseRequestId?: string,
    bootstrapChallenge?: string,
    expectedRoomEpoch?: string,
  ): Promise<CollaborationAuthorizationTransportResult | null | undefined> {
    return this.enqueue(() =>
      this.authorizeCollaborationRoomOrdered({
        noteUuid,
        collaborationProtocolVersion: 3,
        ...(leaseRequestId ? { leaseRequestId } : {}),
        ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
        ...(expectedRoomEpoch ? { expectedRoomEpoch } : {}),
      }),
    )
  }

  /**
   * Opens a multiplexed authenticated RPC on the worker-owned sync socket.
   * Callers may use HTTP only when a rejected AuthenticatedRpcError explicitly
   * has `safeToFallback === true`; requests are never replayed after being sent.
   */
  async openAuthenticatedRpcStream(request: AuthenticatedRpcStreamRequest): Promise<AuthenticatedRpcResponse> {
    const normalized = normalizeAuthenticatedRpcRequest(request)
    if (this.deinitialized || !this.environmentSupported()) {
      throw new AuthenticatedRpcError('SOCKET_UNAVAILABLE', true, true)
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      throw new AuthenticatedRpcError('SESSION_UNAVAILABLE', false, true)
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      throw new AuthenticatedRpcError('WORKER_UNAVAILABLE', true, true)
    }
    const clientRequestId = this.nextRequestId('rpc')
    return new Promise<AuthenticatedRpcResponse>((resolve, reject) => {
      const pending: PendingRpc = {
        sessionScope,
        accepted: false,
        responseResolved: false,
        resolve,
        reject,
        creditToReturn: 0,
      }
      if (request.signal?.aborted) {
        reject(new AuthenticatedRpcError('CANCELLED', false, true))
        return
      }
      if (request.signal) {
        const abort = () => worker.postMessage({ type: 'CANCEL_RPC', clientRequestId })
        request.signal.addEventListener('abort', abort, { once: true })
        pending.abortCleanup = () => request.signal?.removeEventListener('abort', abort)
      }
      this.pendingRpcs.set(clientRequestId, pending)
      worker.postMessage({ type: 'OPEN_RPC', clientRequestId, sessionScope, request: normalized })
    })
  }

  /**
   * True only when a live, authenticated socket has actually negotiated FILES_V1.
   *
   * Never optimistic and never a promise: this reads the operation list the
   * gateway sent in `AUTHENTICATED`, so it is false on every deployment that
   * does not serve the lane, false before the socket is up, and false again the
   * moment the socket degrades. Callers use it to decide whether to try the
   * socket at all, which is what keeps the HTTP path completely untouched where
   * the lane is absent.
   */
  isFileLaneAvailable(): boolean {
    return (
      !this.deinitialized &&
      this.state === 'READY' &&
      this.negotiated?.operations.has('FILES_V1') === true &&
      this.worker !== undefined
    )
  }

  /**
   * Streams one file's encrypted bytes over the negotiated socket.
   *
   * Opens nothing on its own: with no socket already up and advertising
   * FILES_V1 this returns `unavailable` without a ticket request or a connection
   * attempt, and the caller proceeds over HTTP exactly as before.
   *
   * Authorization is unchanged, not relaxed. The client sends only the resource
   * reference; the gateway mints its own single-use credential and re-validates
   * the session per operation, so this lane cannot move bytes that the HTTP path
   * would have refused.
   */
  async downloadFileOverSocket(request: SocketFileDownloadRequest): Promise<SocketFileDownloadOutcome> {
    if (!this.isFileLaneAvailable() || !this.environmentSupported()) {
      return { outcome: 'unavailable' }
    }
    const resource: SocketFileResourceReference = request.sharedVault
      ? {
          ownershipType: 'shared-vault',
          remoteIdentifier: request.remoteIdentifier,
          fileUuid: request.fileUuid,
          sharedVaultUuid: request.sharedVault.sharedVaultUuid,
          sharedVaultOwnerUuid: request.sharedVault.sharedVaultOwnerUuid,
        }
      : { ownershipType: 'user', remoteIdentifier: request.remoteIdentifier, fileUuid: request.fileUuid }
    if (
      !Number.isSafeInteger(request.declaredSize) ||
      request.declaredSize < 1 ||
      !isSocketFileResourceReference(resource)
    ) {
      return { outcome: 'unavailable' }
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope) || this.workerSessionScope !== sessionScope) {
      return { outcome: 'unavailable' }
    }
    const worker = this.worker
    if (!worker || !this.isFileLaneAvailable()) {
      return { outcome: 'unavailable' }
    }
    if (request.signal?.aborted) {
      return { outcome: 'aborted' }
    }

    const clientRequestId = this.nextRequestId('file-download')
    return new Promise<SocketFileDownloadOutcome>((resolve) => {
      const pending: PendingFileDownload = {
        sessionScope,
        request,
        settle: resolve,
        settled: false,
        bytesDelivered: 0,
        tail: Promise.resolve(),
      }
      if (request.signal) {
        const abort = () => {
          worker.postMessage({ type: 'CANCEL_FILE_DOWNLOAD', clientRequestId })
          this.settleFileDownload(clientRequestId, pending, { outcome: 'aborted' })
        }
        request.signal.addEventListener('abort', abort, { once: true })
        pending.abortCleanup = () => request.signal?.removeEventListener('abort', abort)
      }
      this.pendingFileDownloads.set(clientRequestId, pending)
      worker.postMessage({
        type: 'OPEN_FILE_DOWNLOAD',
        clientRequestId,
        sessionScope,
        request: {
          resource,
          declaredSize: request.declaredSize,
          initialCreditBytes: DEFAULT_FILE_TRANSFER_CREDIT_BYTES,
          deadlineMs: DEFAULT_FILE_TRANSFER_DEADLINE_MS,
        },
      })
    })
  }

  async subscribeInviteEvents(options: InviteRealtimeSubscriptionOptions): Promise<() => void> {
    if (this.deinitialized || !this.environmentSupported()) {
      throw new AuthenticatedRpcError('SOCKET_UNAVAILABLE', true, true)
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      throw new AuthenticatedRpcError('SESSION_UNAVAILABLE', false, true)
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      throw new AuthenticatedRpcError('WORKER_UNAVAILABLE', true, true)
    }
    const limit = options.limit ?? 100
    if (
      (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 2_048)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new AuthenticatedRpcError('INVALID_REQUEST', false, true)
    }
    for (const [requestId, pending] of this.pendingInviteSubscriptions) {
      this.pendingInviteSubscriptions.delete(requestId)
      this.worker?.postMessage({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId: requestId })
      pending.options.onError?.(new AuthenticatedRpcError('REPLACED', false, true))
    }
    const clientRequestId = this.nextRequestId('invite-events')
    const pending: PendingInviteSubscription = { sessionScope, options, tail: Promise.resolve() }
    this.pendingInviteSubscriptions.set(clientRequestId, pending)
    worker.postMessage({
      type: 'SUBSCRIBE_INVITE_EVENTS',
      clientRequestId,
      sessionScope,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit,
    })
    return () => {
      if (this.pendingInviteSubscriptions.get(clientRequestId) !== pending) {
        return
      }
      this.pendingInviteSubscriptions.delete(clientRequestId)
      this.worker?.postMessage({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId })
    }
  }

  async notifySessionRevoked(): Promise<void> {
    const sessionScope = (await this.currentSessionScope()) ?? this.workerSessionScope
    if (!sessionScope) {
      this.terminateWorker()
      this.state = 'HTTP_ONLY'
      return
    }
    if (this.acknowledgedRevokedSessionScopes.has(sessionScope)) {
      this.terminateWorker()
      this.state = 'HTTP_ONLY'
      return
    }
    this.revokedSessionScopes.add(sessionScope)
    const error = new Error('Websocket sync session was revoked.')
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionScope === sessionScope) {
        pending.reject(error)
        this.pending.delete(requestId)
      }
    }
    for (const [requestId, pending] of this.pendingCollaboration) {
      if (pending.sessionScope === sessionScope) {
        pending.reject(error)
        this.pendingCollaboration.delete(requestId)
      }
    }
    for (const [requestId, pending] of this.pendingRpcs) {
      if (pending.sessionScope === sessionScope) {
        this.rejectRpc(requestId, pending, new AuthenticatedRpcError('SESSION_REVOKED', false, false))
      }
    }
    for (const [requestId, pending] of this.pendingInviteSubscriptions) {
      if (pending.sessionScope === sessionScope) {
        pending.options.onError?.(new AuthenticatedRpcError('SESSION_REVOKED', false, false))
        this.pendingInviteSubscriptions.delete(requestId)
      }
    }
    this.failAllFileDownloads('SESSION_REVOKED', sessionScope)
    this.negotiated = undefined

    if (!this.environmentSupported()) {
      this.terminateWorker()
      this.state = 'HTTP_ONLY'
      return
    }

    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      this.state = 'HTTP_ONLY'
      return
    }
    const requestId = this.nextRequestId('revoke')
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.revocationBarriers.delete(requestId)
          reject(new Error('Timed out waiting for sync session quarantine.'))
        }, BARRIER_TIMEOUT_MS)
        this.revocationBarriers.set(requestId, { resolve, reject, timeout })
        worker.postMessage({ type: 'SESSION_REVOKED', requestId, sessionScope })
      })
      this.acknowledgedRevokedSessionScopes.add(sessionScope)
    } finally {
      this.terminateWorker()
      this.state = 'HTTP_ONLY'
    }
  }

  deinit(): void {
    if (this.deinitialized) {
      return
    }
    this.deinitialized = true
    this.unregisterPageHideRelease()
    const worker = this.worker
    this.worker = undefined
    this.workerSessionScope = undefined
    if (worker) {
      // `terminate()` used to run in the same tick as SHUTDOWN, so the worker
      // never reached the line that hands its owner lease back and the next tab
      // waited out the whole lease TTL before it could sync over the socket.
      worker.postMessage({ type: 'SHUTDOWN' })
      void this.terminateAfterShutdown(worker)
    }
    const error = new Error('Websocket sync transport was deinitialized.')
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    for (const pending of this.pendingCollaboration.values()) {
      pending.reject(error)
    }
    this.pendingCollaboration.clear()
    for (const [requestId, pending] of this.pendingRpcs) {
      this.rejectRpc(requestId, pending, new AuthenticatedRpcError('SHUTDOWN', false, false))
    }
    for (const pending of this.pendingInviteSubscriptions.values()) {
      pending.options.onError?.(new AuthenticatedRpcError('SHUTDOWN', false, false))
    }
    this.pendingInviteSubscriptions.clear()
    this.failAllFileDownloads('SHUTDOWN')
    this.negotiated = undefined
    this.rejectAllBarriers(error)
    this.state = 'HTTP_ONLY'
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionTail
    let release: () => void = () => undefined
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(async () => {
      try {
        return await operation()
      } finally {
        release()
      }
    })
  }

  private async recoverPendingOrdered(
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
  ): Promise<AccountSyncTransportRecoveryResult<TransportResponse> | undefined> {
    if (this.deinitialized || !this.environmentSupported()) {
      return undefined
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      return undefined
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      return undefined
    }
    // The kill switch (and a platform with no socket lane) must cover recovery
    // too: a record dispatched before the switch flipped can never be asked
    // STATUS again, so the worker replays it over HTTP with its identity.
    const replayOverHttp = this.sessionLaneUnavailableReason()
    const clientRequestId = this.nextRequestId('recover')
    return new Promise<AccountSyncTransportRecoveryResult<TransportResponse> | undefined>((resolve, reject) => {
      this.pending.set(clientRequestId, {
        mode: 'recover',
        sessionScope,
        httpFallback,
        resolve: resolve as (result: PendingResult) => void,
        reject,
      })
      worker.postMessage({
        type: 'RECOVER',
        clientRequestId,
        sessionScope,
        ...(replayOverHttp ? { replayOverHttp } : {}),
      })
    })
  }

  /**
   * Reasons that rule the worker lane out for the whole session before any
   * ticket is worth requesting: the operator/user http-only switch, no configured
   * websocket URL, a URL that is not ws(s), or a page origin that is not http(s).
   * `capability-unavailable` is right for the last three — they are structural,
   * and nothing a retry can change.
   */
  private sessionLaneUnavailableReason(): SyncFallbackReason | undefined {
    if (this.options.isHttpOnly?.() === true || (!this.options.isHttpOnly && defaultHttpOnly())) {
      return 'http-only'
    }
    const configuredUrl = this.options.getConfiguredWebSocketUrl()
    if (!configuredUrl) {
      return 'capability-unavailable'
    }
    let configuredEndpoint: URL
    try {
      configuredEndpoint = new URL(configuredUrl)
    } catch {
      return 'capability-unavailable'
    }
    if (configuredEndpoint.protocol !== 'wss:' && configuredEndpoint.protocol !== 'ws:') {
      return 'capability-unavailable'
    }
    if (!pageOriginSupportsSyncLane(this.options.environment?.pageProtocol)) {
      return 'capability-unavailable'
    }
    return undefined
  }

  private async executeOrdered(
    request: AccountSyncTransportRequest,
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
    context?: AccountSyncTransportContext,
  ): Promise<AccountSyncTransportResult<TransportResponse>> {
    const normalizedRequest = normalizeSyncRequestForWire(request)
    if (this.deinitialized) {
      this.state = 'HTTP_ONLY'
      return { response: await httpFallback(normalizedRequest) }
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope) {
      this.state = 'HTTP_ONLY'
      return { response: await httpFallback(normalizedRequest) }
    }
    if (this.revokedSessionScopes.has(sessionScope)) {
      throw new Error('Websocket sync session was revoked.')
    }
    // Decided here, not in the worker: a platform with no socket lane used to pay
    // a worker round trip plus an IndexedDB read on every sync only to be told so.
    const laneUnavailable = this.sessionLaneUnavailableReason()
    if (laneUnavailable) {
      this.state = 'HTTP_ONLY'
      this.fallbackReason = laneUnavailable
      return { response: await httpFallback(normalizedRequest) }
    }
    if (!this.environmentSupported()) {
      this.state = 'HTTP_ONLY'
      return { response: await httpFallback(normalizedRequest) }
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      return { response: await httpFallback(normalizedRequest) }
    }

    const clientRequestId = this.nextRequestId('sync')
    return new Promise<AccountSyncTransportResult<TransportResponse>>((resolve, reject) => {
      this.pending.set(clientRequestId, {
        mode: 'execute',
        sessionScope,
        body: normalizedRequest,
        httpFallback,
        resolve: resolve as (result: PendingResult) => void,
        reject,
      })
      worker.postMessage({ type: 'EXECUTE', clientRequestId, body: normalizedRequest, sessionScope, context })
    })
  }

  private async authorizeCollaborationRoomOrdered(
    request: CollaborationAuthorizationTransportRequest,
  ): Promise<CollaborationAuthorizationTransportResult | null | undefined> {
    if (this.deinitialized || !this.environmentSupported()) {
      return undefined
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      return undefined
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      return undefined
    }
    const clientRequestId = this.nextRequestId('collaboration')
    return new Promise<CollaborationAuthorizationTransportResult | null | undefined>((resolve, reject) => {
      this.pendingCollaboration.set(clientRequestId, { sessionScope, resolve, reject })
      worker.postMessage({ type: 'AUTHORIZE_COLLABORATION', clientRequestId, sessionScope, request })
    })
  }

  private environmentSupported(): boolean {
    const environment = this.options.environment ?? {
      hasWorker: typeof Worker !== 'undefined',
      hasWebSocket: typeof WebSocket !== 'undefined',
      hasIndexedDb: typeof indexedDB !== 'undefined',
    }
    return environment.hasWorker && environment.hasWebSocket && environment.hasIndexedDb
  }

  private async currentSessionScope(): Promise<string | undefined> {
    try {
      return await this.options.getAuthenticatedSessionScope()
    } catch {
      return undefined
    }
  }

  private async workerForSession(sessionScope: string): Promise<SyncWorkerLike | undefined> {
    if (this.worker && this.workerSessionScope !== sessionScope) {
      await this.quarantineWorkerScope(this.workerSessionScope)
    }
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.options.workerFactory?.() ?? (new SyncTransportWorker() as unknown as SyncWorkerLike)
      worker.onmessage = (event) => void this.onWorkerMessage(event.data)
      worker.onerror = () => void this.onWorkerError()
      this.worker = worker
      this.workerSessionScope = sessionScope
      this.registerPageHideRelease()
      return worker
    } catch {
      this.state = 'HTTP_ONLY'
      return undefined
    }
  }

  private async quarantineWorkerScope(sessionScope: string | undefined): Promise<void> {
    const worker = this.worker
    if (!worker || !sessionScope) {
      this.terminateWorker()
      return
    }
    this.revokedSessionScopes.add(sessionScope)
    const requestId = this.nextRequestId('rotate')
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.revocationBarriers.delete(requestId)
          reject(new Error('Timed out rotating the sync session worker.'))
        }, BARRIER_TIMEOUT_MS)
        this.revocationBarriers.set(requestId, { resolve, reject, timeout })
        worker.postMessage({ type: 'SESSION_REVOKED', requestId, sessionScope })
      })
      this.acknowledgedRevokedSessionScopes.add(sessionScope)
    } finally {
      this.terminateWorker()
    }
  }

  private terminateWorker(): void {
    const worker = this.worker
    this.worker = undefined
    this.workerSessionScope = undefined
    this.negotiated = undefined
    worker?.terminate()
  }

  /** Terminates on `SHUTDOWN_COMPLETE`, or when the grace window runs out. */
  private terminateAfterShutdown(worker: SyncWorkerLike): Promise<void> {
    this.negotiated = undefined
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (this.shutdownBarrier === finish) {
          this.shutdownBarrier = undefined
        }
        worker.terminate()
        resolve()
      }
      const timeout = setTimeout(finish, WORKER_SHUTDOWN_GRACE_MS)
      this.shutdownBarrier = finish
    })
  }

  /**
   * A tab being closed or navigated away from should hand the socket over at
   * once rather than leaving the next tab to wait out the lease. `pagehide`
   * fires for both, and for the back/forward cache, where the worker's own
   * in-flight check keeps the release from costing anything.
   */
  private registerPageHideRelease(): void {
    if (this.pageHideListener || typeof globalThis.addEventListener !== 'function') {
      return
    }
    const listener = () => {
      this.worker?.postMessage({ type: 'RELEASE_OWNER' })
    }
    this.pageHideListener = listener
    globalThis.addEventListener('pagehide', listener)
  }

  private unregisterPageHideRelease(): void {
    const listener = this.pageHideListener
    this.pageHideListener = undefined
    if (listener && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('pagehide', listener)
    }
  }

  /**
   * Standard Red Notes (t99): say out loud which transport carries saves.
   *
   * This lane degrades to HTTP silently and correctly — a gateway with no durable
   * command port withholds SYNC_ITEMS, every other capability negotiates, and the
   * socket stays open — so there was NO signal anywhere that saves had left the
   * socket. The only readout was `transportStatus`, rendered exclusively in the
   * admin-gated diagnostics pane, which the affected user usually cannot open. The
   * observable symptom was a burst of `POST /v1/items` and no way to explain it.
   *
   * One line per genuine transition, never per sync round: `announceTransition` is
   * reached on every STATE message and a fallback re-reports the same state and
   * reason for each save, so the signature is deduplicated.
   */
  private announceTransition(state: SyncTransportState, reason: SyncFallbackReason | undefined): void {
    const signature = `${state}:${reason ?? 'none'}`
    if (this.lastLoggedTransition === signature) {
      return
    }
    this.lastLoggedTransition = signature

    const usesHttp = state === 'HTTP_ONLY' || state === 'HTTP_FALLBACK' || state === 'DEGRADED'
    if (!usesHttp) {
      // CONNECTING/AUTHENTICATING/HALF_OPEN are steps on the way to READY, and
      // READY itself is announced by announceNegotiation with the operation list.
      return
    }

    const explanation = reason ? SYNC_FALLBACK_REASON_EXPLANATIONS[reason] : undefined
    console.warn(
      `[sync-transport] Account sync is using HTTP (state ${state}${reason ? `, reason ${reason}` : ''}).` +
        ` Every save is one POST /v1/items.${explanation ? ` ${explanation}` : ''}`,
    )
  }

  /** The counterpart: a successful negotiation, with what the socket actually carries. */
  private announceNegotiation(operations: readonly SyncNegotiatedOperation[]): void {
    const signature = `NEGOTIATED:${[...operations].join(',')}`
    if (this.lastLoggedTransition === signature) {
      return
    }
    this.lastLoggedTransition = signature

    const carriesSync = operations.includes('SYNC_ITEMS')
    const list = operations.join(', ') || 'nothing'
    // eslint-disable-next-line no-console
    console.info(
      carriesSync
        ? `[sync-transport] Account sync is on the websocket. Negotiated: ${list}.`
        : `[sync-transport] Websocket negotiated ${list}, but NOT SYNC_ITEMS — saves stay on HTTP.` +
            ' The server bound no durable sync command port (see SYNCING_SERVER_GRPC_UNBOUND).',
    )
  }

  private async onWorkerMessage(message: SyncWorkerToMainMessage): Promise<void> {
    if (message.type === 'SHUTDOWN_COMPLETE') {
      this.shutdownBarrier?.()
      return
    }
    if (message.type === 'STATE') {
      this.state = message.state
      this.fallbackReason = message.reason
      this.announceTransition(message.state, message.reason)
      if (message.reason === 'multi-tab-not-owner') {
        // Another tab owns the socket for this scope and its lease stands for a
        // known span. Asking again before then can only mint and spend another
        // one-use ticket to be told the same thing, once per sync per tab.
        this.ticketFailureCache = { reason: 'multi-tab-not-owner', until: Date.now() + OWNER_LEASE_TTL_MS }
      }
      // A worker-initiated close never posts DEGRADED (its own onClose is skipped),
      // so HTTP_FALLBACK must clear the negotiation too or the negative ticket
      // cache is bypassed on every sync and the reported operations go stale.
      if (message.state === 'DEGRADED' || message.state === 'HTTP_ONLY' || message.state === 'HTTP_FALLBACK') {
        this.negotiated = undefined
      }
      return
    }
    if (message.type === 'NEGOTIATED') {
      this.negotiated = {
        sessionScope: message.sessionScope,
        protocolVersion: message.protocolVersion,
        endpoint: message.endpoint,
        operations: new Set(message.operations),
      }
      this.ticketFailureCache = undefined
      this.fallbackReason = undefined
      this.announceNegotiation(message.operations)
      return
    }
    if (message.type === 'CHECKPOINT_CLEARED' || message.type === 'CHECKPOINT_FAILED') {
      const barrier = this.checkpointBarriers.get(message.requestId)
      if (barrier) {
        clearTimeout(barrier.timeout)
        this.checkpointBarriers.delete(message.requestId)
        if (message.type === 'CHECKPOINT_CLEARED') {
          barrier.resolve()
        } else {
          barrier.reject(new Error('Could not clear the durable sync command checkpoint.'))
        }
      }
      return
    }
    if (message.type === 'SESSION_REVOKED_ACK' || message.type === 'SESSION_REVOKED_FAILED') {
      const barrier = this.revocationBarriers.get(message.requestId)
      if (barrier) {
        clearTimeout(barrier.timeout)
        this.revocationBarriers.delete(message.requestId)
        if (message.type === 'SESSION_REVOKED_ACK') {
          barrier.resolve()
        } else {
          barrier.reject(new Error('Could not quarantine the revoked sync session.'))
        }
      }
      return
    }
    const pending = 'clientRequestId' in message ? this.pending.get(message.clientRequestId) : undefined
    const collaborationPending =
      'clientRequestId' in message ? this.pendingCollaboration.get(message.clientRequestId) : undefined
    const rpcPending = 'clientRequestId' in message ? this.pendingRpcs.get(message.clientRequestId) : undefined
    const invitePending =
      'clientRequestId' in message ? this.pendingInviteSubscriptions.get(message.clientRequestId) : undefined

    if (message.type === 'NEED_TICKET') {
      const sessionScope =
        pending?.sessionScope ??
        collaborationPending?.sessionScope ??
        rpcPending?.sessionScope ??
        invitePending?.sessionScope
      if (sessionScope) {
        await this.supplyTicket(message.clientRequestId, sessionScope)
      }
      return
    }
    if (
      message.type === 'INVITE_READY' ||
      message.type === 'INVITE_BATCH' ||
      message.type === 'INVITE_RECONCILE' ||
      message.type === 'INVITE_ERROR'
    ) {
      if (invitePending) {
        this.handleInviteWorkerMessage(message, invitePending)
      }
      return
    }
    if (
      message.type === 'RPC_ACCEPTED' ||
      message.type === 'RPC_RESPONSE' ||
      message.type === 'RPC_CHUNK' ||
      message.type === 'RPC_END' ||
      message.type === 'RPC_ERROR'
    ) {
      if (rpcPending) {
        this.handleRpcWorkerMessage(message, rpcPending)
      }
      return
    }
    if (
      message.type === 'FILE_DOWNLOAD_ACCEPTED' ||
      message.type === 'FILE_DOWNLOAD_CHUNK' ||
      message.type === 'FILE_DOWNLOAD_COMPLETE' ||
      message.type === 'FILE_DOWNLOAD_ERROR'
    ) {
      const fileDownloadPending = this.pendingFileDownloads.get(message.clientRequestId)
      if (fileDownloadPending) {
        this.handleFileDownloadWorkerMessage(message, fileDownloadPending)
      }
      return
    }
    if (
      message.type === 'COLLABORATION_RESULT' ||
      message.type === 'COLLABORATION_DENIED' ||
      message.type === 'COLLABORATION_FALLBACK'
    ) {
      if (!collaborationPending) {
        return
      }
      this.pendingCollaboration.delete(message.clientRequestId)
      if (message.type === 'COLLABORATION_FALLBACK') {
        this.fallbackReason = message.reason
        collaborationPending.resolve(undefined)
      } else if (message.type === 'COLLABORATION_DENIED') {
        collaborationPending.resolve(null)
      } else {
        collaborationPending.resolve(message.result)
      }
      return
    }
    if (!pending) {
      return
    }

    switch (message.type) {
      case 'COMMAND_PERSISTED':
        pending.persisted = { body: message.body, command: message.command }
        break
      case 'RECOVERY_EMPTY':
        this.pending.delete(message.clientRequestId)
        pending.resolve(undefined)
        break
      case 'RECOVERY_REQUIRED':
        this.pending.delete(message.clientRequestId)
        pending.reject(new Error('Durable sync recovery must complete before a new command can execute.'))
        break
      case 'HTTP_FALLBACK':
        await this.resolveHttpFallback(message.clientRequestId, pending, message.body, message.command)
        break
      case 'RESULT': {
        const response = normalizeCommittedResult(message.result)
        if (!response) {
          // COMMITTED proves the mutation may have taken effect. A malformed
          // response must retain the durable outbox for STATUS reconciliation;
          // replaying it over HTTP here would create a second transport owner.
          pending.reject(new Error('Committed websocket sync response was malformed; durable recovery is required.'))
          this.pending.delete(message.clientRequestId)
          return
        }
        const persisted = pending.persisted
        if (!persisted) {
          pending.reject(new Error('Committed websocket sync response has no durable command identity.'))
          this.pending.delete(message.clientRequestId)
          return
        }
        this.pending.delete(message.clientRequestId)
        const result: AccountSyncTransportResult<TransportResponse> = {
          response,
          markCheckpointDurable: this.createDurableCheckpoint(pending.sessionScope, message.commandId),
        }
        pending.resolve(pending.mode === 'recover' ? { ...result, request: persisted.body } : result)
        break
      }
      default:
        break
    }
  }

  private handleRpcWorkerMessage(message: RpcWorkerMessage, pending: PendingRpc): void {
    switch (message.type) {
      case 'RPC_ACCEPTED':
        pending.accepted = true
        return
      case 'RPC_RESPONSE': {
        const response: AuthenticatedRpcResponse = {
          status: message.status,
          headers: message.headers,
          transport: 'websocket',
          ...(!message.stream && Object.hasOwn(message, 'body') ? { body: message.body } : {}),
        }
        if (message.stream) {
          const clientRequestId = message.clientRequestId
          response.stream = new ReadableStream<Uint8Array>(
            {
              start: (controller) => {
                pending.streamController = controller
              },
              pull: () => {
                const creditBytes = pending.creditToReturn
                if (creditBytes > 0) {
                  pending.creditToReturn = 0
                  this.worker?.postMessage({ type: 'RPC_CREDIT', clientRequestId, creditBytes })
                }
              },
              cancel: () => {
                this.worker?.postMessage({ type: 'CANCEL_RPC', clientRequestId })
              },
            },
            { highWaterMark: 1, size: () => 1 },
          )
          pending.responseResolved = true
          pending.resolve(response)
        } else {
          pending.response = response
        }
        return
      }
      case 'RPC_CHUNK':
        if (!pending.streamController) {
          this.rejectRpc(message.clientRequestId, pending, new AuthenticatedRpcError('INVALID_RESPONSE', false, false))
          this.worker?.postMessage({ type: 'CANCEL_RPC', clientRequestId: message.clientRequestId })
          return
        }
        try {
          pending.streamController.enqueue(decodeRpcBase64(message.bytes, message.byteLength))
          pending.creditToReturn = Math.min(MAX_RPC_CREDIT_BYTES, pending.creditToReturn + message.byteLength)
        } catch {
          this.rejectRpc(message.clientRequestId, pending, new AuthenticatedRpcError('INVALID_RESPONSE', false, false))
          this.worker?.postMessage({ type: 'CANCEL_RPC', clientRequestId: message.clientRequestId })
        }
        return
      case 'RPC_END':
        if (pending.streamController) {
          pending.streamController.close()
        } else if (pending.response) {
          pending.responseResolved = true
          pending.resolve(pending.response)
        } else {
          this.rejectRpc(message.clientRequestId, pending, new AuthenticatedRpcError('INVALID_RESPONSE', false, false))
          return
        }
        this.cleanupRpc(message.clientRequestId, pending)
        return
      case 'RPC_ERROR': {
        const error = new AuthenticatedRpcError(message.code, message.retryable, message.safeToFallback)
        this.rejectRpc(message.clientRequestId, pending, error)
        return
      }
    }
  }

  private handleInviteWorkerMessage(
    message: Extract<
      SyncWorkerToMainMessage,
      { type: 'INVITE_READY' | 'INVITE_BATCH' | 'INVITE_RECONCILE' | 'INVITE_ERROR' }
    >,
    pending: PendingInviteSubscription,
  ): void {
    if (message.type === 'INVITE_READY') {
      pending.options.onReady?.(message.cursor)
      return
    }
    if (message.type === 'INVITE_ERROR') {
      pending.options.onError?.(new AuthenticatedRpcError(message.code, message.retryable, false))
      return
    }

    const clientRequestId = message.clientRequestId
    const operation = pending.tail.then(async () => {
      if (this.pendingInviteSubscriptions.get(clientRequestId) !== pending) {
        return
      }
      if (message.type === 'INVITE_BATCH') {
        const ackCursor = await pending.options.applyBatch(message.batch)
        if (ackCursor !== message.batch.nextCursor) {
          throw new AuthenticatedRpcError('INVITE_ACK_MISMATCH', false, false)
        }
        if (this.pendingInviteSubscriptions.get(clientRequestId) === pending) {
          this.worker?.postMessage({ type: 'ACK_INVITE_EVENTS', clientRequestId, cursor: ackCursor })
        }
        return
      }

      await pending.options.reconcile({ reason: message.reason, cursor: message.cursor })
      if (this.pendingInviteSubscriptions.get(clientRequestId) === pending) {
        this.worker?.postMessage({
          type: 'SUBSCRIBE_INVITE_EVENTS',
          clientRequestId,
          sessionScope: pending.sessionScope,
          cursor: message.cursor,
          limit: pending.options.limit ?? 100,
        })
      }
    })
    pending.tail = operation.catch((error) => {
      const failure =
        error instanceof AuthenticatedRpcError ? error : new AuthenticatedRpcError('INVITE_APPLY_FAILED', true, false)
      if (this.pendingInviteSubscriptions.get(clientRequestId) === pending) {
        // The worker/server are both intentionally holding the batch unacked.
        // End this subscription so the lifecycle owner can retry from its last
        // durable checkpoint; leaving it registered would deadlock forever.
        this.pendingInviteSubscriptions.delete(clientRequestId)
        this.worker?.postMessage({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId })
      }
      pending.options.onError?.(failure)
    })
  }

  /**
   * Applies download messages strictly in arrival order, and returns socket
   * credit only after `onBytes` has resolved. Chaining onto a per-download tail
   * is what makes the credit window mean "consumed" rather than "received" —
   * without it a slow consumer would keep granting credit and the encrypted
   * stream would pile up in memory ahead of the decryptor.
   */
  private handleFileDownloadWorkerMessage(message: FileDownloadWorkerMessage, pending: PendingFileDownload): void {
    if (message.type === 'FILE_DOWNLOAD_ACCEPTED') {
      return
    }
    if (message.type === 'FILE_DOWNLOAD_ERROR') {
      this.settleFileDownload(message.clientRequestId, pending, {
        outcome: 'failed',
        code: message.code,
        retryable: message.retryable,
        // The worker reports what crossed to this thread; this thread knows what
        // actually reached the decryptor, and that is the stricter of the two.
        safeToFallback: message.safeToFallback && pending.bytesDelivered === 0,
      })
      return
    }

    const clientRequestId = message.clientRequestId
    const operation = pending.tail.then(async () => {
      if (this.pendingFileDownloads.get(clientRequestId) !== pending || pending.settled) {
        return
      }
      if (message.type === 'FILE_DOWNLOAD_CHUNK') {
        await pending.request.onBytes(message.bytes)
        pending.bytesDelivered += message.bytes.byteLength
        if (this.pendingFileDownloads.get(clientRequestId) === pending && !pending.settled) {
          this.worker?.postMessage({
            type: 'FILE_DOWNLOAD_CREDIT',
            clientRequestId,
            creditBytes: message.bytes.byteLength,
          })
        }
        return
      }
      if (pending.bytesDelivered !== message.declaredSize) {
        this.settleFileDownload(clientRequestId, pending, {
          outcome: 'failed',
          code: 'FILE_TRUNCATED',
          retryable: false,
          safeToFallback: pending.bytesDelivered === 0,
        })
        return
      }
      this.settleFileDownload(clientRequestId, pending, { outcome: 'completed', sha256: message.sha256 })
    })
    pending.tail = operation.catch(() => {
      this.worker?.postMessage({ type: 'CANCEL_FILE_DOWNLOAD', clientRequestId })
      this.settleFileDownload(clientRequestId, pending, {
        outcome: 'failed',
        code: 'FILE_CONSUMER_FAILED',
        retryable: false,
        // The consumer already saw bytes, so it owns whatever partial state it
        // built. Restarting the same file over HTTP would feed them a second time.
        safeToFallback: false,
      })
    })
  }

  private settleFileDownload(
    clientRequestId: string,
    pending: PendingFileDownload,
    outcome: SocketFileDownloadOutcome,
  ): void {
    if (pending.settled) {
      return
    }
    pending.settled = true
    if (this.pendingFileDownloads.get(clientRequestId) === pending) {
      this.pendingFileDownloads.delete(clientRequestId)
    }
    pending.abortCleanup?.()
    pending.settle(outcome)
  }

  private failAllFileDownloads(code: string, sessionScope?: string): void {
    for (const [clientRequestId, pending] of [...this.pendingFileDownloads]) {
      if (sessionScope !== undefined && pending.sessionScope !== sessionScope) {
        continue
      }
      this.settleFileDownload(clientRequestId, pending, {
        outcome: 'failed',
        code,
        retryable: false,
        safeToFallback: pending.bytesDelivered === 0,
      })
    }
  }

  private rejectRpc(clientRequestId: string, pending: PendingRpc, error: AuthenticatedRpcError): void {
    if (pending.streamController) {
      try {
        pending.streamController.error(error)
      } catch {
        // The stream may already be cancelled or closed.
      }
    }
    if (!pending.responseResolved) {
      pending.reject(error)
    }
    this.cleanupRpc(clientRequestId, pending)
  }

  private cleanupRpc(clientRequestId: string, pending: PendingRpc): void {
    if (this.pendingRpcs.get(clientRequestId) === pending) {
      this.pendingRpcs.delete(clientRequestId)
    }
    pending.abortCleanup?.()
  }

  private async supplyTicket(clientRequestId: string, sessionScope: string): Promise<void> {
    const worker = this.worker
    if (
      !worker ||
      (!this.pending.has(clientRequestId) &&
        !this.pendingCollaboration.has(clientRequestId) &&
        !this.pendingRpcs.has(clientRequestId) &&
        !this.pendingInviteSubscriptions.has(clientRequestId)) ||
      this.workerSessionScope !== sessionScope
    ) {
      return
    }
    const unavailable = (reason: SyncFallbackReason) => {
      worker.postMessage({ type: 'TICKET_UNAVAILABLE', clientRequestId, reason })
    }
    const laneUnavailable = this.sessionLaneUnavailableReason()
    if (laneUnavailable) {
      unavailable(laneUnavailable)
      return
    }
    // sessionLaneUnavailableReason() just parsed this successfully.
    const configuredEndpoint = new URL(this.options.getConfiguredWebSocketUrl() as string)

    // The cache exists so background syncs do not repeat ticket + capability
    // requests every 30 s. The invite stream and RPC callers are not background
    // syncs: they arrive once per launch and a stale verdict stands them down
    // for the life of the tab, so they always get a fresh answer.
    const bootstrap = this.pendingInviteSubscriptions.has(clientRequestId) || this.pendingRpcs.has(clientRequestId)
    const cached = this.ticketFailureCache
    // `multi-tab-not-owner` is the exception: it is not a verdict about the
    // deployment but about this tab, it expires with the other tab's lease, and
    // a bootstrap that ignores it burns a ticket on every one of its retries.
    if (
      cached &&
      !this.negotiated &&
      Date.now() < cached.until &&
      (!bootstrap || cached.reason === 'multi-tab-not-owner')
    ) {
      unavailable(cached.reason)
      return
    }
    const cacheAndReport = (reason: SyncFallbackReason) => {
      this.ticketFailureCache = { reason, until: Date.now() + CAPABILITY_REPROBE_MS }
      unavailable(reason)
    }

    let ticket: SyncTicketResponse | SyncControlPlaneRefusal | undefined
    let receivedAt: number
    try {
      ticket = await this.options.controlPlane.createTicket(this.options.deviceId)
      receivedAt = Date.now()
    } catch {
      // No answer at all (network error, timeout, aborted fetch). The capability
      // may well exist; only a probe that the server answers can say otherwise.
      cacheAndReport((await this.probeCapabilityOnce()) === 'absent' ? 'capability-unavailable' : 'ticket-unavailable')
      return
    }
    try {
      const currentScope = await this.currentSessionScope()
      if (currentScope !== sessionScope || this.revokedSessionScopes.has(sessionScope)) {
        const pending = this.pending.get(clientRequestId)
        const collaborationPending = this.pendingCollaboration.get(clientRequestId)
        const rpcPending = this.pendingRpcs.get(clientRequestId)
        const invitePending = this.pendingInviteSubscriptions.get(clientRequestId)
        this.pending.delete(clientRequestId)
        this.pendingCollaboration.delete(clientRequestId)
        this.pendingInviteSubscriptions.delete(clientRequestId)
        pending?.reject(new Error('Authenticated session changed while acquiring a sync ticket.'))
        collaborationPending?.reject(new Error('Authenticated session changed while authorizing collaboration.'))
        if (rpcPending) {
          this.rejectRpc(clientRequestId, rpcPending, new AuthenticatedRpcError('SESSION_CHANGED', false, true))
        }
        invitePending?.options.onError?.(new AuthenticatedRpcError('SESSION_CHANGED', false, true))
        await this.quarantineWorkerScope(sessionScope)
        return
      }
      if (isSyncControlPlaneRefusal(ticket)) {
        // The server answered. Only an answer that says "not here" is permanent;
        // a 5xx, 429 or a transient SYNC_DISABLED is the same request succeeding
        // a little later.
        cacheAndReport(refusalProvesCapabilityAbsent(ticket) ? 'capability-unavailable' : 'ticket-unavailable')
        return
      }
      if (
        !ticket ||
        ticket.capability !== 'ws-sync' ||
        ticket.version !== 1 ||
        typeof ticket.ticket !== 'string' ||
        ticket.ticket.length < 32 ||
        !Number.isSafeInteger(ticket.expiresAt)
      ) {
        // Unreadable or malformed answer. A positive capability probe does not
        // make a failing ticket issuer healthy, so this is still cached — but
        // as the retryable reason unless the probe proves the capability absent.
        cacheAndReport(
          (await this.probeCapabilityOnce()) === 'absent' ? 'capability-unavailable' : 'ticket-unavailable',
        )
        return
      }
      this.ticketFailureCache = undefined
      const relativeEndpoint = ticket.endpoint
      const endpoint = new URL(relativeEndpoint, configuredEndpoint).toString()
      // Express expiry on the local clock from the server's own lifetime span.
      // Comparing the server's absolute `expiresAt` to Date.now() kept every
      // ticket out of the lane on a browser clock ≥ 29 s ahead of the server.
      const lifetimeMs = Number.isSafeInteger(ticket.issuedAt) ? ticket.expiresAt - Number(ticket.issuedAt) : undefined
      worker.postMessage({
        type: 'CONNECT',
        clientRequestId,
        sessionScope,
        authorization: {
          endpoint,
          ticket: ticket.ticket,
          expiresAt: ticket.expiresAt,
          deviceId: this.options.deviceId,
          ...(lifetimeMs !== undefined && lifetimeMs > 0 ? { localExpiresAt: receivedAt + lifetimeMs } : {}),
        },
      })
    } catch {
      cacheAndReport('ticket-unavailable')
    }
  }

  /**
   * `'absent'` only when the server answered that the capability is not offered:
   * a list without `ws-sync`, or a status that says the endpoint does not exist.
   * A thrown probe, an unreadable answer or any other refusal is `'unknown'`.
   */
  private probeCapabilityOnce(): Promise<CapabilityProbeVerdict> {
    if (!this.options.controlPlane.getCapabilities) {
      return Promise.resolve('unknown')
    }
    if (this.capabilityProbe) {
      return this.capabilityProbe
    }
    const probe = this.options.controlPlane
      .getCapabilities()
      .then((response): CapabilityProbeVerdict => {
        if (isSyncControlPlaneRefusal(response)) {
          return refusalProvesCapabilityAbsent(response) ? 'absent' : 'unknown'
        }
        if (!response || !Array.isArray(response.capabilities)) {
          return 'unknown'
        }
        return response.capabilities.some((candidate) => candidate.id === 'ws-sync' && candidate.version === 1)
          ? 'present'
          : 'absent'
      })
      .catch((): CapabilityProbeVerdict => 'unknown')
      .finally(() => {
        if (this.capabilityProbe === probe) {
          this.capabilityProbe = undefined
        }
      })
    this.capabilityProbe = probe
    return probe
  }

  private async resolveHttpFallback(
    clientRequestId: string,
    pending: PendingExecution,
    body: AccountSyncTransportRequest,
    command?: AccountSyncCommandMetadata,
  ): Promise<void> {
    /**
     * Claim the terminal transition before crossing the async HTTP boundary.
     * Worker close/error/timeout paths can converge on the same durable command;
     * without this compare-and-delete, two queued HTTP_FALLBACK messages (or a
     * worker error racing one) could issue the same POST concurrently. The server
     * command journal makes that mutation idempotent, but the client must still
     * guarantee one fallback request and one acknowledgement per execution.
     */
    if (this.pending.get(clientRequestId) !== pending) {
      return
    }
    this.pending.delete(clientRequestId)
    try {
      const response = await pending.httpFallback(body, command)
      const result: AccountSyncTransportResult<TransportResponse> = {
        response,
        ...(command
          ? {
              markCheckpointDurable: this.createDurableCheckpoint(pending.sessionScope, command.id),
            }
          : {}),
      }
      pending.resolve(pending.mode === 'recover' ? { ...result, request: body } : result)
    } catch (error) {
      pending.reject(error)
    }
  }

  private markCheckpointDurable(sessionScope: string, commandId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const requestId = this.nextRequestId('checkpoint')
      void this.workerForSession(sessionScope)
        .then((worker) => {
          if (!worker) {
            reject(new Error('Sync worker is unavailable for durable checkpoint acknowledgement.'))
            return
          }
          const timeout = setTimeout(() => {
            this.checkpointBarriers.delete(requestId)
            reject(new Error('Timed out clearing the durable sync command checkpoint.'))
          }, BARRIER_TIMEOUT_MS)
          this.checkpointBarriers.set(requestId, { resolve, reject, timeout })
          worker.postMessage({ type: 'CHECKPOINT_DURABLE', requestId, sessionScope, commandId })
        })
        .catch(reject)
    })
  }

  private createDurableCheckpoint(sessionScope: string, commandId: string): () => Promise<void> {
    let checkpoint: Promise<void> | undefined
    return () => {
      checkpoint ??= this.markCheckpointDurable(sessionScope, commandId)
      return checkpoint
    }
  }

  private async onWorkerError(): Promise<void> {
    this.terminateWorker()
    this.state = 'DEGRADED'
    this.fallbackReason = 'worker-error'
    this.negotiated = undefined
    for (const pending of this.pendingCollaboration.values()) {
      pending.resolve(undefined)
    }
    this.pendingCollaboration.clear()
    for (const [requestId, pending] of this.pendingRpcs) {
      this.rejectRpc(requestId, pending, new AuthenticatedRpcError('WORKER_ERROR', true, false))
    }
    for (const pending of this.pendingInviteSubscriptions.values()) {
      pending.options.onError?.(new AuthenticatedRpcError('WORKER_ERROR', true, false))
    }
    this.pendingInviteSubscriptions.clear()
    this.failAllFileDownloads('WORKER_ERROR')
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [, pending] of entries) {
      const persisted = pending.persisted
      if (!persisted) {
        pending.reject(new Error('Sync worker failed before durable command identity was confirmed.'))
        continue
      }
      // COMMAND_PERSISTED can race the worker's socket write. Once the worker
      // itself is gone the main thread cannot prove the command stayed local,
      // so retain IndexedDB state and require STATUS recovery instead of HTTP.
      pending.reject(new Error('Sync worker failed after command persistence; durable recovery is required.'))
    }
    this.rejectAllBarriers(new Error('Sync worker failed during an acknowledgement barrier.'))
  }

  private rejectAllBarriers(error: Error): void {
    for (const barriers of [this.checkpointBarriers, this.revocationBarriers]) {
      for (const barrier of barriers.values()) {
        clearTimeout(barrier.timeout)
        barrier.reject(error)
      }
      barriers.clear()
    }
  }

  private nextRequestId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.requestCounter}`
  }
}

const RPC_REQUEST_HEADER_NAMES = new Set([
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
  'x-shared-vault-owner-context',
])

function normalizeAuthenticatedRpcRequest(request: AuthenticatedRpcStreamRequest): WorkerAuthenticatedRpcRequest {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    throw new AuthenticatedRpcError('INVALID_METHOD', false, true)
  }
  if (
    typeof request.path !== 'string' ||
    !request.path.startsWith('/v1/') ||
    request.path.startsWith('//') ||
    request.path.includes('\\') ||
    request.path.includes('#') ||
    utf8Bytes(request.path).byteLength > 2_048
  ) {
    throw new AuthenticatedRpcError('INVALID_PATH', false, true)
  }
  try {
    const parsed = new URL(request.path, 'http://rpc.invalid')
    if (parsed.origin !== 'http://rpc.invalid' || `${parsed.pathname}${parsed.search}` !== request.path) {
      throw new Error('non-canonical path')
    }
  } catch {
    throw new AuthenticatedRpcError('INVALID_PATH', false, true)
  }
  if (request.method === 'GET' && Object.hasOwn(request, 'body')) {
    throw new AuthenticatedRpcError('GET_BODY_FORBIDDEN', false, true)
  }
  if (
    request.method !== 'GET' &&
    (typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.idempotencyKey))
  ) {
    throw new AuthenticatedRpcError('IDEMPOTENCY_KEY_REQUIRED', false, true)
  }
  const deadlineMs = request.deadlineMs ?? DEFAULT_RPC_DEADLINE_MS
  const initialCreditBytes = request.initialCreditBytes ?? DEFAULT_RPC_CREDIT_BYTES
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < MIN_RPC_DEADLINE_MS ||
    deadlineMs > MAX_RPC_DEADLINE_MS ||
    !Number.isSafeInteger(initialCreditBytes) ||
    initialCreditBytes <= 0 ||
    initialCreditBytes > MAX_RPC_CREDIT_BYTES
  ) {
    throw new AuthenticatedRpcError('INVALID_LIMITS', false, true)
  }
  const headers: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(request.headers ?? {})) {
    const name = rawName.toLowerCase()
    if (
      rawName !== name ||
      !RPC_REQUEST_HEADER_NAMES.has(name) ||
      typeof value !== 'string' ||
      value.length > 1_024 ||
      /[\r\n]/u.test(value)
    ) {
      throw new AuthenticatedRpcError('INVALID_HEADERS', false, true)
    }
    headers[name] = value
  }

  let body: unknown
  if (Object.hasOwn(request, 'body') && request.body !== undefined) {
    try {
      body = JSON.parse(JSON.stringify(request.body))
    } catch {
      throw new AuthenticatedRpcError('INVALID_BODY', false, true)
    }
  }
  return {
    method: request.method,
    path: request.path,
    deadlineMs,
    initialCreditBytes,
    stream: request.stream ?? false,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
  }
}

function decodeRpcBase64(value: string, expectedLength: number): Uint8Array {
  if (value.length % 4 !== 0 || (value.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/u.test(value))) {
    throw new Error('Invalid RPC base64 chunk.')
  }
  const decoded = globalThis.atob(value)
  if (decoded.length !== expectedLength) {
    throw new Error('RPC chunk length mismatch.')
  }
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}
