import { randomUUID } from 'crypto'
import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { SyncCommandOutboxRepositoryInterface } from './SyncCommandOutboxRepositoryInterface'

export const SYNC_COMMAND_OUTBOX_MAX_ATTEMPTS_DEFAULT = 20

export class SyncCommandOutboxDispatcher {
  private activeDrain?: Promise<number>
  private interval?: NodeJS.Timeout

  constructor(
    private readonly repository: SyncCommandOutboxRepositoryInterface,
    private readonly publisher: DomainEventPublisherInterface,
    private readonly logger: Logger,
    private readonly retryDelayMilliseconds = 1_000,
    private readonly leaseMilliseconds = 30_000,
    // A poison event (e.g. one the broker rejects as too large) would otherwise
    // be retried on every sweep forever, with an error log each time. After
    // this many failed attempts the row is marked dead and left for retention
    // cleanup.
    private readonly maxAttempts = SYNC_COMMAND_OUTBOX_MAX_ATTEMPTS_DEFAULT,
  ) {}

  dispatchAvailable(limit = 100): Promise<number> {
    if (this.activeDrain) {
      return Promise.resolve(0)
    }

    const drain = this.performDispatch(limit)
    this.activeDrain = drain
    const clearActiveDrain = (): void => {
      if (this.activeDrain === drain) {
        this.activeDrain = undefined
      }
    }
    void drain.then(clearActiveDrain, clearActiveDrain)

    return drain
  }

  async waitForIdle(): Promise<void> {
    await this.activeDrain
  }

  private async performDispatch(limit: number): Promise<number> {
    let published = 0
    for (let index = 0; index < limit; index++) {
      const now = Date.now()
      const claimed = await this.repository.claimNext(now, now - this.leaseMilliseconds, randomUUID())
      if (!claimed) {
        break
      }

      try {
        await this.publisher.publish(claimed.event)
        await this.repository.markPublished(claimed.uuid, claimed.lockToken, Date.now())
        published++
      } catch (error) {
        if (claimed.attempts >= this.maxAttempts) {
          await this.repository.markDead(claimed.uuid, claimed.lockToken, Date.now())
          // Safe logging: only the error classification reaches the log (a raw
          // broker/provider message may carry endpoint or payload text). The
          // event type and the attempt count are the diagnostic value here.
          this.logger.error('Sync command outbox event exhausted its delivery attempts and was marked dead.', {
            ...safeErrorLogMetadata(error),
            codeTag: 'SyncCommandOutboxDispatcher',
            outboxEventId: claimed.uuid,
            eventType: claimed.event.type,
            attempts: claimed.attempts,
            maxAttempts: this.maxAttempts,
          })

          continue
        }

        await this.repository.releaseForRetry(claimed.uuid, claimed.lockToken, Date.now() + this.retryDelayMilliseconds)
        this.logger.error('Sync command outbox dispatch failed; event remains durable for retry.', {
          codeTag: 'SyncCommandOutboxDispatcher',
          outboxEventId: claimed.uuid,
          eventType: claimed.event.type,
          attempts: claimed.attempts,
          maxAttempts: this.maxAttempts,
        })
      }
    }

    return published
  }

  wake(): void {
    void this.dispatchAvailable().catch((error) => {
      this.logger.error('Sync command outbox background dispatch failed.', {
        ...safeErrorLogMetadata(error),
        codeTag: 'SyncCommandOutboxDispatcher',
      })
    })
  }

  start(intervalMilliseconds: number): void {
    if (this.interval) {
      return
    }
    this.interval = setInterval(() => this.wake(), intervalMilliseconds)
    this.interval.unref()
    this.wake()
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }
}
