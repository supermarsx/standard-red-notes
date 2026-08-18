import type {
  AccountSyncCommandMetadata,
  AccountSyncHttpFallback,
  AccountSyncTransportContext,
  AccountSyncTransportInterface,
  AccountSyncTransportRecoveryResult,
  AccountSyncTransportRequest,
  AccountSyncTransportResult,
} from '@standardnotes/services'
import type { HttpResponse, RawSyncResponse } from '@standardnotes/snjs'
import * as SyncTransportWorkerModule from './syncTransport.worker'
import {
  CollaborationAuthorizationTransportRequest,
  CollaborationAuthorizationTransportResult,
  AuthenticatedRpcRequest as AuthenticatedRpcRequestInput,
  DEFAULT_RPC_CREDIT_BYTES,
  DEFAULT_RPC_DEADLINE_MS,
  MainToSyncWorkerMessage,
  MAX_RPC_CREDIT_BYTES,
  MAX_RPC_DEADLINE_MS,
  MIN_RPC_DEADLINE_MS,
  normalizeSyncRequestForWire,
  SyncFallbackReason,
  SyncTransportState,
  SyncNegotiatedOperation,
  SyncWorkerToMainMessage,
  utf8Bytes,
  WorkerAuthenticatedRpcRequest,
} from './syncTransportProtocol'

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
  endpoint: string
  capability: 'ws-sync'
  version: 1
}

export interface SyncTransportControlPlane {
  /** Compatibility probe used only after ticket issuance says the operation is unavailable. */
  getCapabilities?(): Promise<{ capabilities: SyncCapability[] } | undefined>
  createTicket(deviceId: string): Promise<SyncTicketResponse | undefined>
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
  }
}

type TransportResponse = HttpResponse<RawSyncResponse>
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

const CAPABILITY_REPROBE_MS = 60_000

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
  private readonly pendingRpcs = new Map<string, PendingRpc>()
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
  private capabilityProbe?: Promise<boolean>
  private capabilityUnavailableUntil = 0
  private fallbackReason?: SyncFallbackReason

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

  authorizeCollaborationRoom(
    noteUuid: string,
    leaseRequestId?: string,
    bootstrapChallenge?: string,
  ): Promise<CollaborationAuthorizationTransportResult | null | undefined> {
    return this.enqueue(() =>
      this.authorizeCollaborationRoomOrdered({
        noteUuid,
        collaborationProtocolVersion: 2,
        ...(leaseRequestId ? { leaseRequestId } : {}),
        ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
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
    this.worker?.postMessage({ type: 'SHUTDOWN' })
    this.terminateWorker()
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
    const clientRequestId = this.nextRequestId('recover')
    return new Promise<AccountSyncTransportRecoveryResult<TransportResponse> | undefined>((resolve, reject) => {
      this.pending.set(clientRequestId, {
        mode: 'recover',
        sessionScope,
        httpFallback,
        resolve: resolve as (result: PendingResult) => void,
        reject,
      })
      worker.postMessage({ type: 'RECOVER', clientRequestId, sessionScope })
    })
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
    if (this.options.isHttpOnly?.() === true || (!this.options.isHttpOnly && defaultHttpOnly())) {
      this.state = 'HTTP_ONLY'
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

  private async onWorkerMessage(message: SyncWorkerToMainMessage): Promise<void> {
    if (message.type === 'STATE') {
      this.state = message.state
      this.fallbackReason = message.reason
      if (message.state === 'DEGRADED' || message.state === 'HTTP_ONLY') {
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
      this.capabilityUnavailableUntil = 0
      this.fallbackReason = undefined
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

    if (message.type === 'NEED_TICKET') {
      const sessionScope = pending?.sessionScope ?? collaborationPending?.sessionScope ?? rpcPending?.sessionScope
      if (sessionScope) {
        await this.supplyTicket(message.clientRequestId, sessionScope)
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
          const persisted = pending.persisted
          if (persisted) {
            await this.resolveHttpFallback(message.clientRequestId, pending, persisted.body, persisted.command)
          } else {
            pending.reject(new Error('Committed websocket sync response was malformed.'))
            this.pending.delete(message.clientRequestId)
          }
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
        !this.pendingRpcs.has(clientRequestId)) ||
      this.workerSessionScope !== sessionScope
    ) {
      return
    }
    const unavailable = (reason: SyncFallbackReason) => {
      worker.postMessage({ type: 'TICKET_UNAVAILABLE', clientRequestId, reason })
    }
    if (this.options.isHttpOnly?.() === true || (!this.options.isHttpOnly && defaultHttpOnly())) {
      unavailable('http-only')
      return
    }
    const configuredUrl = this.options.getConfiguredWebSocketUrl()
    if (!configuredUrl) {
      unavailable('capability-unavailable')
      return
    }
    let configuredEndpoint: URL
    try {
      configuredEndpoint = new URL(configuredUrl)
    } catch {
      unavailable('capability-unavailable')
      return
    }
    if (configuredEndpoint.protocol !== 'wss:' && configuredEndpoint.protocol !== 'ws:') {
      unavailable('capability-unavailable')
      return
    }

    if (!this.negotiated && Date.now() < this.capabilityUnavailableUntil) {
      unavailable('capability-unavailable')
      return
    }

    try {
      const ticket = await this.options.controlPlane.createTicket(this.options.deviceId)
      const currentScope = await this.currentSessionScope()
      if (currentScope !== sessionScope || this.revokedSessionScopes.has(sessionScope)) {
        const pending = this.pending.get(clientRequestId)
        const collaborationPending = this.pendingCollaboration.get(clientRequestId)
        const rpcPending = this.pendingRpcs.get(clientRequestId)
        this.pending.delete(clientRequestId)
        this.pendingCollaboration.delete(clientRequestId)
        pending?.reject(new Error('Authenticated session changed while acquiring a sync ticket.'))
        collaborationPending?.reject(new Error('Authenticated session changed while authorizing collaboration.'))
        if (rpcPending) {
          this.rejectRpc(clientRequestId, rpcPending, new AuthenticatedRpcError('SESSION_CHANGED', false, true))
        }
        await this.quarantineWorkerScope(sessionScope)
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
        const capabilityAvailable = await this.probeCapabilityOnce()
        // A positive capability response does not make a failing ticket issuer
        // healthy. Cache both negative capabilities and ticket-plane failures so
        // each background sync does not repeat ticket + capability requests.
        this.capabilityUnavailableUntil = Date.now() + CAPABILITY_REPROBE_MS
        unavailable(capabilityAvailable ? 'ticket-unavailable' : 'capability-unavailable')
        return
      }
      this.capabilityUnavailableUntil = 0
      const relativeEndpoint = ticket.endpoint
      const endpoint = new URL(relativeEndpoint, configuredEndpoint).toString()
      worker.postMessage({
        type: 'CONNECT',
        clientRequestId,
        sessionScope,
        authorization: {
          endpoint,
          ticket: ticket.ticket,
          expiresAt: ticket.expiresAt,
          deviceId: this.options.deviceId,
        },
      })
    } catch {
      const capabilityAvailable = await this.probeCapabilityOnce()
      this.capabilityUnavailableUntil = Date.now() + CAPABILITY_REPROBE_MS
      unavailable(capabilityAvailable ? 'ticket-unavailable' : 'capability-unavailable')
    }
  }

  private probeCapabilityOnce(): Promise<boolean> {
    if (!this.options.controlPlane.getCapabilities) {
      return Promise.resolve(false)
    }
    if (this.capabilityProbe) {
      return this.capabilityProbe
    }
    const probe = this.options.controlPlane
      .getCapabilities()
      .then(
        (response) =>
          response?.capabilities.some((candidate) => candidate.id === 'ws-sync' && candidate.version === 1) === true,
      )
      .catch(() => false)
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
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [, pending] of entries) {
      const persisted = pending.persisted
      if (!persisted) {
        pending.reject(new Error('Sync worker failed before durable command identity was confirmed.'))
        continue
      }
      try {
        const response = await pending.httpFallback(persisted.body, persisted.command)
        const result: AccountSyncTransportResult<TransportResponse> = {
          response,
          markCheckpointDurable: this.createDurableCheckpoint(pending.sessionScope, persisted.command.id),
        }
        pending.resolve(pending.mode === 'recover' ? { ...result, request: persisted.body } : result)
      } catch (error) {
        pending.reject(error)
      }
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
