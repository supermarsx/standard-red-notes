import { InviteRealtimeBatch } from './InviteRealtimeEvent'
import {
  getInviteRealtimeRecoveryAction,
  InviteRealtimeConsumeResult,
  InviteRealtimeEventConsumer,
  InviteRealtimeHandlerContext,
  InviteRealtimeResourceRevision,
} from './InviteRealtimeEventConsumer'

export type InviteRealtimeServerReconcileReason = 'BOOTSTRAP_REQUIRED' | 'CURSOR_EXPIRED' | 'CURSOR_INVALID'
export type InviteRealtimeSnapshotReason =
  InviteRealtimeServerReconcileReason | Extract<InviteRealtimeConsumeResult, { status: 'reconcile' }>['reason']

export type InviteRealtimeSubscriptionOptions = {
  cursor?: string
  limit?: number
  applyBatch(batch: InviteRealtimeBatch): Promise<string>
  reconcile(input: { reason: InviteRealtimeServerReconcileReason; cursor: string }): Promise<void>
  onReady?: (cursor: string) => void
  onError?: (error: unknown) => void
}

/** Structural port implemented by the web socket transport without coupling this domain service to the web package. */
export interface InviteRealtimeSubscriptionPort {
  subscribeInviteEvents(options: InviteRealtimeSubscriptionOptions): Promise<() => void>
}

export type InviteRealtimeSnapshotResult = {
  resourceRevisions?: readonly InviteRealtimeResourceRevision[]
}

export interface InviteRealtimeRetryScheduler {
  schedule(callback: () => void, delayMilliseconds: number): unknown
  cancel(handle: unknown): void
}

export type InviteRealtimeSubscriptionCoordinatorOptions = {
  batchLimit?: number
  retryBaseDelayMilliseconds?: number
  retryMaximumDelayMilliseconds?: number
  scheduler?: InviteRealtimeRetryScheduler
  reconcileSnapshot(input: {
    sessionScope: string
    reason: InviteRealtimeSnapshotReason
    cursor: string
    signal: AbortSignal
    context: InviteRealtimeHandlerContext
  }): Promise<InviteRealtimeSnapshotResult | void>
  onReady?: (cursor: string) => void
  onError?: (error: unknown) => void
}

type ActiveInviteRealtimeSession = {
  readonly sessionScope: string
  readonly generation: number
  readonly abortController: AbortController
  connection?: symbol
  disposeSubscription?: () => void
  retryHandle?: unknown
  retryAttempt: number
  applyFailure?: {
    connection: symbol
    reason: Extract<InviteRealtimeConsumeResult, { status: 'reconcile' }>['reason']
  }
}

const DEFAULT_BATCH_LIMIT = 100
const DEFAULT_RETRY_BASE_DELAY_MS = 250
const DEFAULT_RETRY_MAXIMUM_DELAY_MS = 30_000

/**
 * Owns the durable invite stream for exactly one authenticated session epoch.
 * Healthy delivery is entirely push-driven: the scheduler is used only after
 * an explicit transport/apply failure, never as a polling loop.
 */
export class InviteRealtimeSubscriptionCoordinator {
  private readonly batchLimit: number
  private readonly retryBaseDelayMilliseconds: number
  private readonly retryMaximumDelayMilliseconds: number
  private readonly scheduler: InviteRealtimeRetryScheduler
  private active?: ActiveInviteRealtimeSession
  private generation = 0

  constructor(
    private readonly port: InviteRealtimeSubscriptionPort,
    private readonly consumer: InviteRealtimeEventConsumer,
    private readonly options: InviteRealtimeSubscriptionCoordinatorOptions,
  ) {
    this.batchLimit = positiveInteger(options.batchLimit ?? DEFAULT_BATCH_LIMIT, 'Invite realtime batch limit')
    if (this.batchLimit > 100) {
      throw new Error('Invite realtime batch limit cannot exceed 100.')
    }
    this.retryBaseDelayMilliseconds = positiveInteger(
      options.retryBaseDelayMilliseconds ?? DEFAULT_RETRY_BASE_DELAY_MS,
      'Invite realtime retry base delay',
    )
    this.retryMaximumDelayMilliseconds = positiveInteger(
      options.retryMaximumDelayMilliseconds ?? DEFAULT_RETRY_MAXIMUM_DELAY_MS,
      'Invite realtime retry maximum delay',
    )
    if (this.retryMaximumDelayMilliseconds < this.retryBaseDelayMilliseconds) {
      throw new Error('Invite realtime retry maximum delay cannot be smaller than the base delay.')
    }
    this.scheduler = options.scheduler ?? defaultRetryScheduler
  }

  async startSession(sessionScope: string): Promise<void> {
    this.stopSession()
    const session: ActiveInviteRealtimeSession = {
      sessionScope,
      generation: ++this.generation,
      abortController: new AbortController(),
      retryAttempt: 0,
    }
    this.active = session

    const checkpoint = await this.consumer.beginSession(sessionScope)
    if (!this.isCurrent(session)) {
      return
    }
    await this.openSubscription(session, checkpoint?.cursor)
  }

  stopSession(): void {
    const session = this.active
    this.active = undefined
    this.generation += 1
    if (session) {
      session.abortController.abort()
      this.cancelRetry(session)
      this.disposeSubscription(session)
    }
    this.consumer.endSession()
  }

  private async openSubscription(session: ActiveInviteRealtimeSession, cursor?: string): Promise<void> {
    if (!this.isCurrent(session)) {
      return
    }
    this.disposeSubscription(session)
    const connection = Symbol('invite-realtime-connection')
    session.connection = connection
    session.applyFailure = undefined

    try {
      const dispose = await this.port.subscribeInviteEvents({
        ...(cursor === undefined ? {} : { cursor }),
        limit: this.batchLimit,
        applyBatch: (batch) => this.applyBatch(session, connection, batch),
        reconcile: ({ reason, cursor: reconcileCursor }) =>
          this.reconcile(session, connection, reason, reconcileCursor),
        onReady: (readyCursor) => {
          if (!this.isConnectionCurrent(session, connection)) {
            return
          }
          session.retryAttempt = 0
          this.options.onReady?.(readyCursor)
        },
        onError: (error) => this.handleTransportError(session, connection, error),
      })
      if (!this.isConnectionCurrent(session, connection)) {
        safeDispose(dispose)
        return
      }
      session.disposeSubscription = dispose
    } catch (error) {
      if (!this.isConnectionCurrent(session, connection)) {
        return
      }
      this.handleTransportError(session, connection, error)
    }
  }

  private async applyBatch(
    session: ActiveInviteRealtimeSession,
    connection: symbol,
    batch: InviteRealtimeBatch,
  ): Promise<string> {
    if (!this.isConnectionCurrent(session, connection)) {
      throw new InviteRealtimeSubscriptionCoordinatorError('session-changed')
    }
    const result = await this.consumer.consume(session.sessionScope, batch)
    if (result.status === 'applied') {
      session.applyFailure = undefined
      return result.ackCursor
    }

    const recovery = getInviteRealtimeRecoveryAction(result)
    if (recovery === 'snapshot') {
      await this.reconcileFromSnapshot(session, connection, result.reason, batch.nextCursor)
      return batch.nextCursor
    }
    session.applyFailure = { connection, reason: result.reason }
    throw new InviteRealtimeSubscriptionCoordinatorError(result.reason)
  }

  private async reconcile(
    session: ActiveInviteRealtimeSession,
    connection: symbol,
    reason: InviteRealtimeServerReconcileReason,
    cursor: string,
  ): Promise<void> {
    await this.reconcileFromSnapshot(session, connection, reason, cursor)
  }

  private async reconcileFromSnapshot(
    session: ActiveInviteRealtimeSession,
    connection: symbol,
    reason: InviteRealtimeSnapshotReason,
    cursor: string,
  ): Promise<void> {
    if (!this.isConnectionCurrent(session, connection)) {
      throw new InviteRealtimeSubscriptionCoordinatorError('session-changed')
    }
    const snapshot = await this.options.reconcileSnapshot({
      sessionScope: session.sessionScope,
      reason,
      cursor,
      signal: session.abortController.signal,
      context: this.snapshotContext(session, connection),
    })
    if (!this.isConnectionCurrent(session, connection)) {
      throw new InviteRealtimeSubscriptionCoordinatorError('session-changed')
    }
    await this.consumer.resetAfterReconciliation(
      session.sessionScope,
      cursor,
      snapshot?.resourceRevisions ? snapshot.resourceRevisions.map((entry) => ({ ...entry })) : [],
    )
  }

  private handleTransportError(session: ActiveInviteRealtimeSession, connection: symbol, error: unknown): void {
    if (!this.isConnectionCurrent(session, connection)) {
      return
    }
    const applyFailure = session.applyFailure?.connection === connection ? session.applyFailure.reason : undefined
    session.connection = undefined
    session.applyFailure = undefined
    this.disposeSubscription(session)
    try {
      this.options.onError?.(error)
    } catch {
      // Diagnostic observers cannot suppress durable recovery.
    }

    if (applyFailure === 'invalid-batch' || applyFailure === 'session-changed') {
      return
    }
    if (applyFailure === undefined && isExplicitlyNonRetryable(error)) {
      return
    }
    this.scheduleRetry(session)
  }

  private snapshotContext(session: ActiveInviteRealtimeSession, connection: symbol): InviteRealtimeHandlerContext {
    return {
      sessionScope: session.sessionScope,
      sessionEpoch: session.generation,
      signal: session.abortController.signal,
      isCurrent: () => this.isConnectionCurrent(session, connection),
      assertCurrent: () => {
        if (!this.isConnectionCurrent(session, connection)) {
          throw new InviteRealtimeSubscriptionCoordinatorError('session-changed')
        }
      },
    }
  }

  private scheduleRetry(session: ActiveInviteRealtimeSession): void {
    if (!this.isCurrent(session) || session.retryHandle !== undefined) {
      return
    }
    const exponent = Math.min(session.retryAttempt, 30)
    const delay = Math.min(this.retryBaseDelayMilliseconds * 2 ** exponent, this.retryMaximumDelayMilliseconds)
    session.retryAttempt += 1
    session.retryHandle = this.scheduler.schedule(() => {
      session.retryHandle = undefined
      if (!this.isCurrent(session)) {
        return
      }
      void this.openSubscription(session, this.consumer.getCursor(session.sessionScope))
    }, delay)
  }

  private cancelRetry(session: ActiveInviteRealtimeSession): void {
    if (session.retryHandle === undefined) {
      return
    }
    this.scheduler.cancel(session.retryHandle)
    session.retryHandle = undefined
  }

  private disposeSubscription(session: ActiveInviteRealtimeSession): void {
    const dispose = session.disposeSubscription
    session.disposeSubscription = undefined
    if (dispose) {
      safeDispose(dispose)
    }
  }

  private isCurrent(session: ActiveInviteRealtimeSession): boolean {
    return this.active === session && this.generation === session.generation && !session.abortController.signal.aborted
  }

  private isConnectionCurrent(session: ActiveInviteRealtimeSession, connection: symbol): boolean {
    return this.isCurrent(session) && session.connection === connection
  }
}

export class InviteRealtimeSubscriptionCoordinatorError extends Error {
  constructor(readonly reason: Extract<InviteRealtimeConsumeResult, { status: 'reconcile' }>['reason']) {
    super(`Invite realtime subscription requires recovery: ${reason}.`)
    this.name = 'InviteRealtimeSubscriptionCoordinatorError'
  }
}

const defaultRetryScheduler: InviteRealtimeRetryScheduler = {
  schedule: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`)
  }
  return value
}

function isExplicitlyNonRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable === false)
}

function safeDispose(dispose: () => void): void {
  try {
    dispose()
  } catch {
    // The durable cursor remains authoritative; disposal is best-effort.
  }
}
