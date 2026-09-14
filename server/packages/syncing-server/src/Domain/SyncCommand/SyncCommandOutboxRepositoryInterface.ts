import { DomainEventInterface } from '@standardnotes/domain-events'

export type ClaimedSyncCommandOutboxEvent = {
  uuid: string
  event: DomainEventInterface
  lockToken: string
  /** Delivery attempts including the claim that produced this record (1 on the first claim). */
  attempts: number
}

export interface SyncCommandOutboxRepositoryInterface {
  enqueue(event: DomainEventInterface): Promise<void>
  claimNext(
    nowTimestamp: number,
    staleBeforeTimestamp: number,
    lockToken: string,
  ): Promise<ClaimedSyncCommandOutboxEvent | null>
  markPublished(uuid: string, lockToken: string, publishedAtTimestamp: number): Promise<void>
  releaseForRetry(uuid: string, lockToken: string, availableAtTimestamp: number): Promise<void>
  /**
   * Give up on an event that failed to publish too many times. A dead row is
   * never claimed again; it stays visible for operators until retention
   * cleanup removes it.
   */
  markDead(uuid: string, lockToken: string, deadAtTimestamp: number): Promise<void>
  /** Retention cleanup: removes published rows (by publish time) and dead rows (by their last update) older than `timestamp`. */
  deletePublishedBefore(timestamp: number): Promise<number>
}
