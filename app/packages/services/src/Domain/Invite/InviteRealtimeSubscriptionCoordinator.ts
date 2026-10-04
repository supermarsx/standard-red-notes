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

/**
 * The transport could not open the lane because an external condition holds that
 * will clear by itself — another tab of this account owning the socket is the only
 * one today. NOT a failure: the transport keeps the subscription registered and
 * resumes it when the condition clears, so the coordinator must park rather than
 * reconnect (an unbounded loop against a condition no reconnect can resolve) or
 * stand down (which would never recover when the other tab closes).
 *
 * `resumeAfterMilliseconds` is how long the condition can outlive the thing holding
 * it, for a consumer that wants to report an expectation. The coordinator does not
 * schedule anything from it: resumption is the transport's, not a timer's.
 */
export type InviteRealtimeDeferral = {
  readonly reason: string
  readonly resumeAfterMilliseconds: number
}

export type InviteRealtimeSubscriptionOptions = {
  cursor?: string
  limit?: number
  applyBatch(batch: InviteRealtimeBatch): Promise<string>
  reconcile(input: { reason: InviteRealtimeServerReconcileReason; cursor: string }): Promise<void>
  onReady?: (cursor: string) => void
  onError?: (error: unknown) => void
  onDeferred?: (deferral: InviteRealtimeDeferral) => void
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
  /** Observability only. Must not be used to report a fault: a deferral is not one. */
  onDeferred?: (deferral: InviteRealtimeDeferral) => void
}

type ActiveInviteRealtimeSession = {
  readonly sessionScope: string
  readonly generation: number
  readonly abortController: AbortController
  /** Set once the session's first subscription attempt has begun. */
  opened: boolean
  connection?: symbol
  disposeSubscription?: () => void
  retryHandle?: unknown
  retryAttempt: number
  /** Set while the transport reported a `deferred` condition on `connection`. */
  deferral?: { connection: symbol; reason: string }
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
      opened: false,
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

  /** True while the active session holds a subscription that is open or being opened. */
  hasLiveSubscription(): boolean {
    const session = this.active
    return session !== undefined && this.isCurrent(session) && session.connection !== undefined
  }

  /**
   * Re-open a stood-down or backing-off session from its durable cursor.
   * Wired to environment wake signals (connectivity restored, tab visible) so a
   * transient control-plane failure the transport reported as permanent no
   * longer silences invites and membership changes for the life of the tab.
   * No-op while a subscription is live or opening, before the session's first
   * open has begun, and after `stopSession()`. Returns whether it re-opened.
   */
  reconnectIfStopped(): boolean {
    const session = this.active
    if (!session || !this.isCurrent(session) || !session.opened || session.connection !== undefined) {
      return false
    }
    this.cancelRetry(session)
    session.retryAttempt = 0
    void this.openSubscription(session, this.consumer.getCursor(session.sessionScope))
    return true
  }

  private async openSubscription(session: ActiveInviteRealtimeSession, cursor?: string): Promise<void> {
    if (!this.isCurrent(session)) {
      return
    }
    session.opened = true
    this.disposeSubscription(session)
    const connection = Symbol('invite-realtime-connection')
    session.connection = connection
    session.applyFailure = undefined
    session.deferral = undefined

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
          session.deferral = undefined
          this.options.onReady?.(readyCursor)
        },
        onError: (error) => this.handleTransportError(session, connection, error),
        onDeferred: (deferral) => this.handleDeferral(session, connection, deferral),
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

  /**
   * Park the stream on a condition that will clear by itself.
   *
   * The subscription is deliberately left registered and `connection` left current:
   * the transport re-sends it the moment the condition clears, and its first frame
   * must land on this same connection or the resumed stream would be dropped as
   * stale. Nothing is scheduled and nothing is disposed, which is the whole point —
   * classified as a retryable error this condition drove one dispose, one re-dial and
   * one logged failure per backoff tick for as long as the tab stayed open.
   */
  private handleDeferral(
    session: ActiveInviteRealtimeSession,
    connection: symbol,
    deferral: InviteRealtimeDeferral,
  ): void {
    if (!this.isConnectionCurrent(session, connection)) {
      return
    }
    this.cancelRetry(session)
    session.deferral = { connection, reason: deferral.reason }
    try {
      this.options.onDeferred?.(deferral)
    } catch {
      // Diagnostic observers cannot change the parked state.
    }
  }

  /** True while the active session is parked waiting for an external condition to clear. */
  isDeferred(): boolean {
    const session = this.active
    return (
      session !== undefined &&
      this.isCurrent(session) &&
      session.deferral !== undefined &&
      session.deferral.connection === session.connection
    )
  }

  private handleTransportError(session: ActiveInviteRealtimeSession, connection: symbol, error: unknown): void {
    if (!this.isConnectionCurrent(session, connection)) {
      return
    }
    const applyFailure = session.applyFailure?.connection === connection ? session.applyFailure.reason : undefined
    session.connection = undefined
    session.applyFailure = undefined
    // A genuine failure ends the park: the condition is no longer the thing holding
    // the lane, and the ordinary retry/stand-down rules decide what happens next.
    session.deferral = undefined
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
