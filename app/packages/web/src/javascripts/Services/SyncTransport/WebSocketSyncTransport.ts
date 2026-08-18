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
  MainToSyncWorkerMessage,
  normalizeSyncRequestForWire,
  SyncFallbackReason,
  SyncTransportState,
  SyncWorkerToMainMessage,
  utf8Bytes,
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
  getCapabilities(): Promise<{ capabilities: SyncCapability[] } | undefined>
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
  private readonly checkpointBarriers = new Map<string, Barrier>()
  private readonly revocationBarriers = new Map<string, Barrier>()
  private readonly revokedSessionScopes = new Set<string>()
  private readonly acknowledgedRevokedSessionScopes = new Set<string>()
  private state: SyncTransportState = 'HTTP_ONLY'
  private requestCounter = 0
  private deinitialized = false
  private executionTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: WebSocketSyncTransportOptions) {}

  get transportState(): SyncTransportState {
    return this.state
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
    worker?.terminate()
  }

  private async onWorkerMessage(message: SyncWorkerToMainMessage): Promise<void> {
    if (message.type === 'STATE') {
      this.state = message.state
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
    if (!pending) {
      return
    }

    switch (message.type) {
      case 'NEED_TICKET':
        await this.supplyTicket(message.clientRequestId, pending.sessionScope)
        break
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
          markCheckpointDurable: () => this.markCheckpointDurable(pending.sessionScope, message.commandId),
        }
        pending.resolve(pending.mode === 'recover' ? { ...result, request: persisted.body } : result)
        break
      }
      default:
        break
    }
  }

  private async supplyTicket(clientRequestId: string, sessionScope: string): Promise<void> {
    const worker = this.worker
    if (!worker || !this.pending.has(clientRequestId) || this.workerSessionScope !== sessionScope) {
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

    try {
      const capabilityResponse = await this.options.controlPlane.getCapabilities()
      const capability = capabilityResponse?.capabilities.find(
        (candidate) => candidate.id === 'ws-sync' && candidate.version === 1,
      )
      if (!capability) {
        unavailable('capability-unavailable')
        return
      }
      const ticket = await this.options.controlPlane.createTicket(this.options.deviceId)
      const currentScope = await this.currentSessionScope()
      if (currentScope !== sessionScope || this.revokedSessionScopes.has(sessionScope)) {
        const pending = this.pending.get(clientRequestId)
        this.pending.delete(clientRequestId)
        pending?.reject(new Error('Authenticated session changed while acquiring a sync ticket.'))
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
        unavailable('ticket-unavailable')
        return
      }
      const relativeEndpoint = ticket.endpoint || capability.endpoint
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
      unavailable('ticket-unavailable')
    }
  }

  private async resolveHttpFallback(
    clientRequestId: string,
    pending: PendingExecution,
    body: AccountSyncTransportRequest,
    command?: AccountSyncCommandMetadata,
  ): Promise<void> {
    try {
      const response = await pending.httpFallback(body, command)
      this.pending.delete(clientRequestId)
      const result: AccountSyncTransportResult<TransportResponse> = {
        response,
        ...(command
          ? {
              markCheckpointDurable: () => this.markCheckpointDurable(pending.sessionScope, command.id),
            }
          : {}),
      }
      pending.resolve(pending.mode === 'recover' ? { ...result, request: body } : result)
    } catch (error) {
      this.pending.delete(clientRequestId)
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

  private async onWorkerError(): Promise<void> {
    this.terminateWorker()
    this.state = 'DEGRADED'
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
          markCheckpointDurable: () => this.markCheckpointDurable(pending.sessionScope, persisted.command.id),
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
