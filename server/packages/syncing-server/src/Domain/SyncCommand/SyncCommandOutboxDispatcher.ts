import { randomUUID } from 'crypto'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { SyncCommandOutboxRepositoryInterface } from './SyncCommandOutboxRepositoryInterface'

export class SyncCommandOutboxDispatcher {
  private activeDrain?: Promise<number>
  private interval?: NodeJS.Timeout

  constructor(
    private readonly repository: SyncCommandOutboxRepositoryInterface,
    private readonly publisher: DomainEventPublisherInterface,
    private readonly logger: Logger,
    private readonly retryDelayMilliseconds = 1_000,
    private readonly leaseMilliseconds = 30_000,
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
      } catch (_error) {
        await this.repository.releaseForRetry(claimed.uuid, claimed.lockToken, Date.now() + this.retryDelayMilliseconds)
        this.logger.error('Sync command outbox dispatch failed; event remains durable for retry.', {
          codeTag: 'SyncCommandOutboxDispatcher',
          outboxEventId: claimed.uuid,
        })
      }
    }

    return published
  }

  wake(): void {
    void this.dispatchAvailable().catch((error) => {
      this.logger.error('Sync command outbox background dispatch failed.', {
        codeTag: 'SyncCommandOutboxDispatcher',
        error: error instanceof Error ? error.message : String(error),
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
