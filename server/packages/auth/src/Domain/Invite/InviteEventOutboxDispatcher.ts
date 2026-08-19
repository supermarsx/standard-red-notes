import { randomUUID } from 'node:crypto'

import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { safeErrorLogMetadata } from '../Logging/SafeLog'
import { InviteEventOutboxRepositoryInterface } from './InviteEventOutboxRepositoryInterface'

export type InviteEventOutboxDispatcherOptions = {
  maximumAttempts?: number
  leaseMilliseconds?: number
  retryBaseMilliseconds?: number
  retryMaximumMilliseconds?: number
  /** Ceiling for the backoff applied after consecutive repository failures. */
  pollBackoffMaximumMilliseconds?: number
  clock?: () => number
  logger?: Logger
}

export class InviteEventOutboxDispatcher {
  private readonly maximumAttempts: number
  private readonly leaseMilliseconds: number
  private readonly retryBaseMilliseconds: number
  private readonly retryMaximumMilliseconds: number
  private readonly pollBackoffMaximumMilliseconds: number
  private readonly clock: () => number
  private readonly logger: Logger | undefined
  private consecutiveFailures = 0
  private running = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<void> | undefined
  private maintenanceInterval = 1_000

  constructor(
    private readonly repository: InviteEventOutboxRepositoryInterface,
    private readonly publisher: DomainEventPublisherInterface,
    options: InviteEventOutboxDispatcherOptions = {},
  ) {
    this.maximumAttempts = options.maximumAttempts ?? 8
    this.leaseMilliseconds = options.leaseMilliseconds ?? 30_000
    this.retryBaseMilliseconds = options.retryBaseMilliseconds ?? 250
    this.retryMaximumMilliseconds = options.retryMaximumMilliseconds ?? 60_000
    this.pollBackoffMaximumMilliseconds = options.pollBackoffMaximumMilliseconds ?? 30_000
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
  }

  start(maintenanceInterval = 1_000): void {
    this.maintenanceInterval = maintenanceInterval
    this.stopped = false
    this.wake()
  }

  /**
   * Tears the poller down for good: no further maintenance passes are armed, the
   * pending timer is cleared, and any dispatch already in flight is awaited so the
   * caller can close the connection it is writing through. Resolving before that
   * drain settled would let `markPublished` land on a destroyed data source.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.inFlight) {
      await this.inFlight
    }
  }

  wake(): void {
    if (this.stopped || this.running || this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.dispatch()
    }, 0)
    this.timer.unref?.()
  }

  /**
   * Publishes claimable records until the outbox is empty or `maximumRecords` is
   * reached.
   *
   * Repository failures end the pass rather than escaping. The dispatcher is a
   * steady-state poller on a live server: an unhandled rejection here reaches the
   * process-level `unhandledRejection` handler in bin/server.ts and bin/worker.ts,
   * which exits the process. Re-armed every second, that turns any transient
   * database fault -- deadlock, lock timeout, replica failover, dropped connection
   * -- into a crash-looping auth outage. It also kills a worker that merely started
   * before the server had run migrations, since worker mode starts this poller but
   * never migrates.
   *
   * So the pass logs and gives up its turn, and `schedule()` retries with a backoff.
   * Nothing is swallowed silently; every failure is logged. Deliberately no
   * fail-fast branch: a missing table is exactly the un-migrated-worker case that
   * must back off rather than die, so it is not distinguishable here from a
   * transient fault in a way worth acting on.
   */
  async drain(maximumRecords = 100): Promise<{ published: number; failed: number; retried: number }> {
    if (this.running) {
      return { published: 0, failed: 0, retried: 0 }
    }
    this.running = true
    const totals = { published: 0, failed: 0, retried: 0 }
    let failed = false
    try {
      for (let index = 0; index < maximumRecords; index++) {
        try {
          const now = this.clock()
          const claimed = await this.repository.claimNext(
            now,
            now - this.leaseMilliseconds,
            randomUUID(),
            this.maximumAttempts,
          )
          if (!claimed) {
            break
          }
          try {
            await this.publisher.publish(claimed.event)
            await this.repository.markPublished(claimed.uuid, claimed.lockToken, this.clock())
            totals.published++
          } catch (error) {
            const attemptedAt = this.clock()
            const errorCode = redactedErrorCode(error)
            if (claimed.attempts >= this.maximumAttempts) {
              await this.repository.markFailed(claimed.uuid, claimed.lockToken, errorCode, attemptedAt)
              totals.failed++
            } else {
              await this.repository.releaseForRetry(
                claimed.uuid,
                claimed.lockToken,
                attemptedAt + this.retryDelay(claimed.attempts),
                errorCode,
                attemptedAt,
              )
              totals.retried++
            }
          }
        } catch (error) {
          // The record stays claimed; its lease expires and another pass reclaims it.
          failed = true
          this.consecutiveFailures++
          this.report('Invite event outbox dispatch pass failed; backing off and retrying.', error)
          break
        }
      }
      if (!failed) {
        this.consecutiveFailures = 0
      }
      return totals
    } finally {
      this.running = false
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryMaximumMilliseconds, this.retryBaseMilliseconds * 2 ** Math.max(0, attempt - 1))
  }

  private schedule(): void {
    if (this.stopped || this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.dispatch()
    }, this.nextPollDelay())
    this.timer.unref?.()
  }

  /**
   * Steady cadence while healthy; exponential backoff once passes start failing, so
   * a persistently broken or un-migrated schema is retried patiently instead of
   * being hammered — and logged once per backoff step rather than once a second.
   */
  private nextPollDelay(): number {
    if (this.consecutiveFailures === 0) {
      return this.maintenanceInterval
    }
    return Math.min(
      this.pollBackoffMaximumMilliseconds,
      this.maintenanceInterval * 2 ** Math.min(this.consecutiveFailures, 16),
    )
  }

  /**
   * Runs one drain and re-arms. `drain()` contains its own failures, so the catch
   * here only fires if the error handling itself threw — a logger that raises, say.
   * It still matters: nothing on this path may produce an unhandled rejection,
   * because bin/server.ts and bin/worker.ts turn one into `process.exit(1)`.
   *
   * `inFlight` is cleared inside the same continuation that resolves it, so once
   * `stop()`'s await returns there is nothing left in flight and no ordering race
   * between clearing the handle and observing it.
   */
  private dispatch(): void {
    this.inFlight = this.drain()
      .catch((error: unknown) => {
        this.consecutiveFailures++
        this.report('Invite event outbox dispatcher failed unexpectedly.', error)
      })
      .then(() => {
        this.inFlight = undefined
        this.schedule()
      })
  }

  /**
   * Logging is the last thing standing between a poller fault and a silent one, so
   * it must not become a fault itself: a logger whose transport is down would
   * otherwise throw straight out of the handler that exists to contain errors.
   */
  private report(message: string, error: unknown): void {
    try {
      this.logger?.error(message, safeErrorLogMetadata(error))
    } catch {
      /* a failed log must never escalate into a failed process */
    }
  }
}

function redactedErrorCode(error: unknown): string {
  if (error instanceof Error) {
    return (error.name || error.constructor.name || 'ERROR')
      .toUpperCase()
      .replace(/[^A-Z0-9_.-]/g, '_')
      .slice(0, 64)
  }
  return 'UNKNOWN_ERROR'
}
