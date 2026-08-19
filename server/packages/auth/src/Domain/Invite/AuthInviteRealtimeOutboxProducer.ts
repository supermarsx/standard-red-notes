import { randomUUID } from 'node:crypto'

import {
  DomainEventService,
  InviteRealtimeEventAction,
  InviteRealtimeInvalidationRequestedEvent,
} from '@standardnotes/domain-events'

import { InviteEventOutboxRepositoryInterface } from './InviteEventOutboxRepositoryInterface'
import { AuthInviteEventTransactionContext } from '../../Infra/TypeORM/AuthInviteEventTransactionContext'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class AuthInviteRealtimeOutboxProducer {
  constructor(
    private readonly repository: InviteEventOutboxRepositoryInterface,
    private readonly transactionContext: AuthInviteEventTransactionContext,
    private readonly clock: () => number = Date.now,
    private readonly eventIdFactory: () => string = randomUUID,
  ) {}

  async recordSubscriptionInvite(input: {
    action: InviteRealtimeEventAction
    inviteUuid: string
    affectedUserUuids: readonly string[]
    eventId?: string
    occurredAt?: number
  }): Promise<'inserted' | 'duplicate'> {
    if (!this.transactionContext.manager) {
      throw new Error('Auth invite realtime events must be enqueued inside the mutation transaction.')
    }
    const eventId = validateUuid(input.eventId ?? this.eventIdFactory(), 'event')
    const affectedUserUuids = normalizeAffectedUsers(input.affectedUserUuids)
    const occurredAt = input.occurredAt ?? this.clock()
    if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) {
      throw new Error('Auth invite realtime occurrence time is invalid.')
    }
    const event: InviteRealtimeInvalidationRequestedEvent = {
      eventId,
      type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
      createdAt: new Date(occurredAt),
      meta: {
        correlation: {
          userIdentifier: affectedUserUuids[0],
          userIdentifierType: 'uuid',
        },
        origin: DomainEventService.Auth,
      },
      payload: {
        version: 1,
        recordId: eventId,
        affectedUserUuids,
        event: {
          version: 1,
          eventId,
          kind: 'subscription-invite',
          action: input.action,
          inviteUuid: validateUuid(input.inviteUuid, 'invitation'),
          occurredAt,
        },
      },
    }
    return this.repository.enqueue(event)
  }
}

function normalizeAffectedUsers(values: readonly string[]): string[] {
  const valuesNormalized = [...new Set(values.map((value) => validateUuid(value, 'affected user')))]
  if (valuesNormalized.length === 0 || valuesNormalized.length > 1_000) {
    throw new Error('Auth invite realtime affected users are invalid.')
  }
  return valuesNormalized
}

function validateUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Auth invite realtime ${label} uuid is invalid.`)
  }
  return value.toLowerCase()
}
