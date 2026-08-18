import { DomainEventInterface } from '@standardnotes/domain-events'

export type ClaimedSyncCommandOutboxEvent = {
  uuid: string
  event: DomainEventInterface
  lockToken: string
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
  deletePublishedBefore(timestamp: number): Promise<number>
}
