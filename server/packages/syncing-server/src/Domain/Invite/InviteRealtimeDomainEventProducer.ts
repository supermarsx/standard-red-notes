import { randomUUID } from 'node:crypto'

import { Uuid } from '@standardnotes/domain-core'
import {
  DomainEventService,
  InviteRealtimeEventAction,
  InviteRealtimeInvalidation,
  InviteRealtimeInvalidationRequestedEvent,
  InviteRealtimeMembershipAction,
  InviteRealtimeMembershipRole,
} from '@standardnotes/domain-events'
import { SyncCommandOutboxRepositoryInterface } from '../SyncCommand/SyncCommandOutboxRepositoryInterface'

const MAX_AFFECTED_USERS = 1_000

/**
 * Membership revision contract (t92 C12): a positive decimal integer without
 * leading zeros, at most 32 digits — the microsecond timestamp of the
 * mutation. Same pattern as the domain-events validator and the gateway; it
 * is checked here too because the syncing-server outbox enqueues the event
 * directly and never runs that validator.
 */
export const CANONICAL_REVISION_PATTERN = /^[1-9]\d{0,31}$/u

type SharedVaultInviteInput = {
  action: InviteRealtimeEventAction
  inviteUuid: string
  sharedVaultUuid: string
  affectedUserUuids: readonly string[]
  eventId?: string
  occurredAt?: number
}

type SharedVaultMembershipInput = {
  action: InviteRealtimeMembershipAction
  sharedVaultUuid: string
  memberUserUuid: string
  membershipUuid?: string
  inviteUuid?: string
  role?: InviteRealtimeMembershipRole
  revision: string
  affectedUserUuids: readonly string[]
  eventId?: string
  occurredAt?: number
}

/** Publishes strict metadata-only invalidations into the active DB outbox. */
export class InviteRealtimeDomainEventProducer {
  constructor(
    private readonly outboxRepository: SyncCommandOutboxRepositoryInterface,
    private readonly clock: () => number = Date.now,
    private readonly eventIdFactory: () => string = randomUUID,
  ) {}

  recordSharedVaultInvite(input: SharedVaultInviteInput): Promise<void> {
    return this.publish(input.affectedUserUuids, {
      version: 1,
      eventId: this.eventId(input.eventId),
      kind: 'shared-vault-invite',
      action: input.action,
      inviteUuid: this.uuid(input.inviteUuid, 'invite'),
      sharedVaultUuid: this.uuid(input.sharedVaultUuid, 'shared vault'),
      occurredAt: this.occurredAt(input.occurredAt),
    })
  }

  recordSharedVaultMembership(input: SharedVaultMembershipInput): Promise<void> {
    if (typeof input.revision !== 'string' || !CANONICAL_REVISION_PATTERN.test(input.revision)) {
      throw new Error('Invite realtime membership revision is invalid.')
    }
    return this.publish(input.affectedUserUuids, {
      version: 1,
      eventId: this.eventId(input.eventId),
      kind: 'shared-vault-membership',
      action: input.action,
      sharedVaultUuid: this.uuid(input.sharedVaultUuid, 'shared vault'),
      memberUserUuid: this.uuid(input.memberUserUuid, 'member'),
      ...(input.membershipUuid === undefined ? {} : { membershipUuid: this.uuid(input.membershipUuid, 'membership') }),
      ...(input.inviteUuid === undefined ? {} : { inviteUuid: this.uuid(input.inviteUuid, 'invite') }),
      ...(input.role === undefined ? {} : { role: input.role }),
      revision: input.revision,
      occurredAt: this.occurredAt(input.occurredAt),
    })
  }

  private async publish(affectedUserUuids: readonly string[], invalidation: InviteRealtimeInvalidation): Promise<void> {
    const affectedUsers = [...new Set(affectedUserUuids)].map((uuid) => this.uuid(uuid, 'affected user'))
    if (affectedUsers.length === 0 || affectedUsers.length > MAX_AFFECTED_USERS) {
      throw new Error('Invite realtime affected users are invalid.')
    }

    const event: InviteRealtimeInvalidationRequestedEvent = {
      eventId: invalidation.eventId,
      type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
      createdAt: new Date(invalidation.occurredAt),
      meta: {
        correlation: {
          userIdentifier: affectedUsers[0],
          userIdentifierType: 'uuid',
        },
        origin: DomainEventService.SyncingServer,
      },
      payload: {
        version: 1,
        recordId: invalidation.eventId,
        affectedUserUuids: affectedUsers,
        event: invalidation,
      },
    }

    await this.outboxRepository.enqueue(event)
  }

  private eventId(value: string | undefined): string {
    return this.uuid(value ?? this.eventIdFactory(), 'event')
  }

  private uuid(value: string, label: string): string {
    const result = Uuid.create(value)
    if (result.isFailed()) {
      throw new Error(`Invite realtime ${label} uuid is invalid.`)
    }
    return result.getValue().value
  }

  private occurredAt(value: number | undefined): number {
    const occurredAt = value ?? this.clock()
    if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) {
      throw new Error('Invite realtime occurrence time is invalid.')
    }
    return occurredAt
  }
}
