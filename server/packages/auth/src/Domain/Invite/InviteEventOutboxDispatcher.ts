import { randomUUID } from 'node:crypto'

import { DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { InviteEventOutboxRepositoryInterface } from './InviteEventOutboxRepositoryInterface'

export type InviteEventOutboxDispatcherOptions = {
  maximumAttempts?: number
  leaseMilliseconds?: number
  retryBaseMilliseconds?: number
  retryMaximumMilliseconds?: number
  clock?: () => number
}

export class InviteEventOutboxDispatcher {
  private readonly maximumAttempts: number
  private readonly leaseMilliseconds: number
  private readonly retryBaseMilliseconds: number
  private readonly retryMaximumMilliseconds: number
  private readonly clock: () => number
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
    this.clock = options.clock ?? Date.now
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
      const pending = this.inFlight
      await pending
      if (this.inFlight === pending) {
        this.inFlight = undefined
      }
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

  async drain(maximumRecords = 100): Promise<{ published: number; failed: number; retried: number }> {
    if (this.running) {
      return { published: 0, failed: 0, retried: 0 }
    }
    this.running = true
    const totals = { published: 0, failed: 0, retried: 0 }
    try {
      for (let index = 0; index < maximumRecords; index++) {
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
      }
      return totals
    } finally {
      this.running = false
    }
  }

  async deletePublishedBefore(timestamp: number): Promise<number> {
    return this.repository.deletePublishedBefore(timestamp)
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
    }, this.maintenanceInterval)
    this.timer.unref?.()
  }

  /**
   * Runs one drain and re-arms. `inFlight` is a settled-either-way mirror of the
   * drain so `stop()` can await it without inheriting a rejection; the original
   * promise keeps its unhandled-rejection behaviour so a broken repository still
   * trips the process-level fail-fast handlers rather than looping silently.
   */
  private dispatch(): void {
    const drained = this.drain()
    this.inFlight = drained.then(
      () => undefined,
      () => undefined,
    )
    void drained.finally(() => {
      this.inFlight = undefined
      this.schedule()
    })
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
