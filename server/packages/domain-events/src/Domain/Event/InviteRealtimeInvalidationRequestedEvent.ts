import { DomainEventInterface } from './DomainEventInterface'
import { InviteRealtimeInvalidationRequestedEventPayload } from './InviteRealtimeInvalidationRequestedEventPayload'

export interface InviteRealtimeInvalidationRequestedEvent extends DomainEventInterface {
  eventId: string
  type: 'INVITE_REALTIME_INVALIDATION_REQUESTED'
  payload: InviteRealtimeInvalidationRequestedEventPayload
}
