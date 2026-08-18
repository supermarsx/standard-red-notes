import { createHash, timingSafeEqual } from 'node:crypto'
import type { SyncAuthTicketStore, SyncTicketIdentity } from './auth.js'
import type { SyncCommandLeaseRegistry, SyncSocketBudget } from './registry.js'
import {
  MAX_SYNC_BUFFERED_BYTES,
  MAX_SYNC_FRAME_BYTES,
  MAX_SYNC_QUEUED_BYTES,
  MAX_SYNC_QUEUED_FRAMES,
  MAX_SYNC_SEQUENCE,
  SYNC_AUTH_DEADLINE_MS,
  SYNC_BACKEND_TIMEOUT_MS,
  SyncProtocolError,
  createSyncServerFrame,
  parseSyncClientFrame,
  type JsonObject,
  type SyncCommandFrame,
  type SyncStatusRequestFrame,
} from './syncProtocol.js'

export interface SyncSocket {
  readonly bufferedAmount: number
  send(data: string): void
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
  authorize(input: SyncAuthorizationInput, signal: AbortSignal): Promise<SyncAuthorizationDecision>
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
      !this.options.authorization.ready() ||
      !this.options.backend.ready()
    ) {
      this.failAndClose('SYNC_DISABLED', 'WebSocket sync is unavailable.', 1012)
      return
    }

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
      this.send('AUTHENTICATED', frame.requestId, frame.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        nextClientSequence: this.expectedClientSequence,
      })
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
    await this.handleCommand(frame)
  }

  private async handleStatus(frame: SyncStatusRequestFrame): Promise<void> {
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
    type: 'AUTHENTICATED' | 'ACCEPTED' | 'COMMITTED' | 'STATUS' | 'PONG',
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

function isRetryableError(code: string): boolean {
  return (
    code === 'BUSY' ||
    code === 'BACKEND_TIMEOUT' ||
    code === 'BACKEND_ERROR' ||
    code === 'SYNC_DISABLED' ||
    code === 'RESULT_TOO_LARGE' ||
    code === 'LEASE_LOST' ||
    code === 'SOCKET_LIMIT' ||
    code === 'SOCKET_BUDGET_LOST'
  )
}
