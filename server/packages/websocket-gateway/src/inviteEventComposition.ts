import { InviteEventAvailabilityBus, SharedInviteEventsAdapter } from './inviteEventAvailability.js'
import { InviteEventStore } from './inviteEventStore.js'
import { InviteEventOutboxDispatcher, InviteLifecycleEventProducer } from './inviteEventOutbox.js'

export type SharedInviteEventComposition = {
  /** Pass directly as the gateway command handler's `inviteEvents` adapter. */
  gatewayAdapter: SharedInviteEventsAdapter
  /** Use only with the mutation-scoped transactional outbox interface. */
  producer: InviteLifecycleEventProducer
  /** Invoke from the durable outbox worker before marking its record delivered. */
  dispatcher: InviteEventOutboxDispatcher
}

/** Exact production composition seam; rejects process-local persistence or wakeups. */
export function createSharedInviteEventComposition(input: {
  store: InviteEventStore
  availability: InviteEventAvailabilityBus
  clock?: () => number
}): SharedInviteEventComposition {
  return {
    gatewayAdapter: new SharedInviteEventsAdapter(input.store, input.availability),
    producer: new InviteLifecycleEventProducer(input.clock),
    dispatcher: new InviteEventOutboxDispatcher(input.store, input.availability),
  }
}
