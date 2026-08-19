import { InviteRealtimeInvalidationRequestedEvent } from '@standardnotes/domain-events'

export type ClaimedInviteEventOutboxRecord = {
  uuid: string
  event: InviteRealtimeInvalidationRequestedEvent
  lockToken: string
  attempts: number
}

export interface InviteEventOutboxRepositoryInterface {
  enqueue(event: InviteRealtimeInvalidationRequestedEvent): Promise<'inserted' | 'duplicate'>
  claimNext(
    nowTimestamp: number,
    staleBeforeTimestamp: number,
    lockToken: string,
    maximumAttempts: number,
  ): Promise<ClaimedInviteEventOutboxRecord | null>
  markPublished(uuid: string, lockToken: string, publishedAtTimestamp: number): Promise<void>
  releaseForRetry(
    uuid: string,
    lockToken: string,
    availableAtTimestamp: number,
    errorCode: string,
    attemptedAtTimestamp: number,
  ): Promise<void>
  markFailed(uuid: string, lockToken: string, errorCode: string, attemptedAtTimestamp: number): Promise<void>
  requeueFailed(uuid: string, availableAtTimestamp: number): Promise<boolean>
  deletePublishedBefore(timestamp: number): Promise<number>
}
