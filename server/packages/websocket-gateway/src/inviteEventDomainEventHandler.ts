import { InviteEventOutboxDispatcher, InviteEventOutboxRecord, isInviteEventOutboxRecord } from './inviteEventOutbox.js'

export type InviteRealtimeDomainEventEnvelope = {
  eventId?: unknown
  type?: unknown
  payload?: unknown
}

/**
 * Transport-neutral composition seam for SNS/SQS or direct-call delivery.
 * The producer envelope is discarded after its strict metadata payload is
 * validated; only the canonical record reaches Redis fanout.
 */
export class InviteRealtimeDomainEventHandler {
  constructor(private readonly dispatcher: Pick<InviteEventOutboxDispatcher, 'dispatch'>) {}

  async handle(envelope: InviteRealtimeDomainEventEnvelope): Promise<void> {
    if (envelope.type !== 'INVITE_REALTIME_INVALIDATION_REQUESTED' || !isInviteEventOutboxRecord(envelope.payload)) {
      throw new Error('Invite realtime domain event is malformed.')
    }
    if (envelope.eventId !== envelope.payload.recordId) {
      throw new Error('Invite realtime domain event identity does not match its payload.')
    }
    await this.dispatcher.dispatch(cloneRecord(envelope.payload))
  }
}

function cloneRecord(record: InviteEventOutboxRecord): InviteEventOutboxRecord {
  return {
    version: record.version,
    recordId: record.recordId,
    affectedUserUuids: [...record.affectedUserUuids],
    event: { ...record.event },
  }
}
