import { DomainEventService } from './DomainEventService'

export interface DomainEventInterface {
  /** Stable delivery identity. Publishers may omit it; durable transports assign one before enqueueing. */
  eventId?: string
  type: string
  createdAt: Date
  payload: unknown
  meta: {
    correlation: {
      userIdentifier: string
      userIdentifierType: 'uuid' | 'email' | 'shared-vault-uuid'
    }
    origin: DomainEventService
    target?: DomainEventService
  }
}
