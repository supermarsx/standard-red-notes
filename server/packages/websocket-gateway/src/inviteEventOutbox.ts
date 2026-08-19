import {
  appendInviteEventForAffectedUsers,
  ApplicationStateResource,
  InviteEventAction,
  InviteEventInvalidation,
  InviteEventStore,
  isInviteEventInvalidation,
  isInviteEventUserUuid,
  SharedVaultMembershipEventAction,
  SharedVaultMembershipRole,
} from './inviteEventStore.js'
import { InviteEventAvailabilityBus } from './inviteEventAvailability.js'

export const INVITE_EVENT_OUTBOX_RECORD_VERSION = 1 as const
const MAX_AFFECTED_USERS = 1_000
const OUTBOX_FIELDS = new Set(['version', 'recordId', 'affectedUserUuids', 'event'])

export type InviteEventOutboxRecord = {
  version: typeof INVITE_EVENT_OUTBOX_RECORD_VERSION
  /** Equal to event.eventId and protected by a unique constraint in the mutation database. */
  recordId: string
  affectedUserUuids: string[]
  event: InviteEventInvalidation
}

/**
 * Must be implemented by the same active database transaction that persists
 * the invite/subscription/membership mutation. `recordId` is a unique key;
 * same-payload retries return duplicate and conflicting payloads must reject.
 */
export interface InviteEventOutboxTransaction {
  insertInviteEventOutboxRecord(record: InviteEventOutboxRecord): Promise<'inserted' | 'duplicate'>
}

type ProducerBaseInput = {
  affectedUserUuids: readonly string[]
  occurredAt?: number
}

export type SharedVaultInviteOutboxInput = ProducerBaseInput & {
  eventId: string
  action: InviteEventAction
  inviteUuid: string
  sharedVaultUuid: string
}

export type SubscriptionInviteOutboxInput = ProducerBaseInput & {
  eventId: string
  action: InviteEventAction
  inviteUuid: string
}

export type SharedVaultMembershipOutboxInput = ProducerBaseInput & {
  eventId: string
  action: SharedVaultMembershipEventAction
  sharedVaultUuid: string
  memberUserUuid: string
  membershipUuid?: string
  inviteUuid?: string
  role?: SharedVaultMembershipRole
  revision: string
}

export type ApplicationStateOutboxInput = ProducerBaseInput & {
  eventId: string
  action: 'updated' | 'invalidated'
  resource: ApplicationStateResource
  resourceUuid?: string
  revision: string
}

export type InviteEventProduceResult = {
  status: 'inserted' | 'duplicate'
  record: InviteEventOutboxRecord
}

/** Creates strict, data-minimal outbox records; it never writes the event stream directly. */
export class InviteLifecycleEventProducer {
  constructor(private readonly clock: () => number = Date.now) {}

  recordSharedVaultInvite(
    transaction: InviteEventOutboxTransaction,
    input: SharedVaultInviteOutboxInput,
  ): Promise<InviteEventProduceResult> {
    return this.record(transaction, input.affectedUserUuids, {
      version: 1,
      eventId: input.eventId,
      kind: 'shared-vault-invite',
      action: input.action,
      inviteUuid: input.inviteUuid,
      sharedVaultUuid: input.sharedVaultUuid,
      occurredAt: this.occurredAt(input.occurredAt),
    })
  }

  recordSubscriptionInvite(
    transaction: InviteEventOutboxTransaction,
    input: SubscriptionInviteOutboxInput,
  ): Promise<InviteEventProduceResult> {
    return this.record(transaction, input.affectedUserUuids, {
      version: 1,
      eventId: input.eventId,
      kind: 'subscription-invite',
      action: input.action,
      inviteUuid: input.inviteUuid,
      occurredAt: this.occurredAt(input.occurredAt),
    })
  }

  recordSharedVaultMembership(
    transaction: InviteEventOutboxTransaction,
    input: SharedVaultMembershipOutboxInput,
  ): Promise<InviteEventProduceResult> {
    return this.record(transaction, input.affectedUserUuids, {
      version: 1,
      eventId: input.eventId,
      kind: 'shared-vault-membership',
      action: input.action,
      sharedVaultUuid: input.sharedVaultUuid,
      memberUserUuid: input.memberUserUuid,
      ...(input.membershipUuid === undefined ? {} : { membershipUuid: input.membershipUuid }),
      ...(input.inviteUuid === undefined ? {} : { inviteUuid: input.inviteUuid }),
      ...(input.role === undefined ? {} : { role: input.role }),
      revision: input.revision,
      occurredAt: this.occurredAt(input.occurredAt),
    })
  }

  recordApplicationState(
    transaction: InviteEventOutboxTransaction,
    input: ApplicationStateOutboxInput,
  ): Promise<InviteEventProduceResult> {
    return this.record(transaction, input.affectedUserUuids, {
      version: 1,
      eventId: input.eventId,
      kind: 'application-state',
      action: input.action,
      resource: input.resource,
      ...(input.resourceUuid === undefined ? {} : { resourceUuid: input.resourceUuid }),
      revision: input.revision,
      occurredAt: this.occurredAt(input.occurredAt),
    })
  }

  private async record(
    transaction: InviteEventOutboxTransaction,
    affectedUserUuids: readonly string[],
    event: InviteEventInvalidation,
  ): Promise<InviteEventProduceResult> {
    if (!isInviteEventInvalidation(event)) {
      throw new InviteEventOutboxError('Invite event producer input is invalid.')
    }
    const record: InviteEventOutboxRecord = {
      version: INVITE_EVENT_OUTBOX_RECORD_VERSION,
      recordId: event.eventId,
      affectedUserUuids: normalizeAffectedUsers(affectedUserUuids),
      event,
    }
    const status = await transaction.insertInviteEventOutboxRecord(cloneRecord(record))
    if (status !== 'inserted' && status !== 'duplicate') {
      throw new InviteEventOutboxError('Invite event outbox transaction returned an invalid status.')
    }
    return { status, record: cloneRecord(record) }
  }

  private occurredAt(value: number | undefined): number {
    const occurredAt = value ?? this.clock()
    if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) {
      throw new InviteEventOutboxError('Invite event occurrence time is invalid.')
    }
    return occurredAt
  }
}

export type InviteEventDispatchResult = {
  affectedUsers: number
  appended: number
  duplicates: number
}

/**
 * Dispatches one claimed record. The outbox worker may mark it delivered only
 * after this resolves. Any append/publish failure leaves the record pending;
 * retry is safe because every account stream deduplicates event.eventId.
 */
export class InviteEventOutboxDispatcher {
  constructor(
    private readonly store: InviteEventStore,
    private readonly availability: InviteEventAvailabilityBus,
  ) {}

  async dispatch(record: InviteEventOutboxRecord, signal?: AbortSignal): Promise<InviteEventDispatchResult> {
    if (!isInviteEventOutboxRecord(record)) {
      throw new InviteEventOutboxError('Invite event outbox record is malformed.')
    }
    throwIfAborted(signal)
    const results = await appendInviteEventForAffectedUsers(this.store, record.affectedUserUuids, record.event)
    throwIfAborted(signal)
    await Promise.all(results.map(({ userUuid }) => this.availability.publishAvailability(userUuid)))
    throwIfAborted(signal)
    const duplicates = results.filter((result) => result.duplicate).length
    return {
      affectedUsers: results.length,
      appended: results.length - duplicates,
      duplicates,
    }
  }
}

export function isInviteEventOutboxRecord(value: unknown): value is InviteEventOutboxRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).every((field) => OUTBOX_FIELDS.has(field)) &&
    record.version === INVITE_EVENT_OUTBOX_RECORD_VERSION &&
    typeof record.recordId === 'string' &&
    Array.isArray(record.affectedUserUuids) &&
    record.affectedUserUuids.length > 0 &&
    record.affectedUserUuids.length <= MAX_AFFECTED_USERS &&
    record.affectedUserUuids.every(isInviteEventUserUuid) &&
    new Set(record.affectedUserUuids).size === record.affectedUserUuids.length &&
    isInviteEventInvalidation(record.event) &&
    record.recordId === record.event.eventId
  )
}

export class InviteEventOutboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InviteEventOutboxError'
  }
}

function normalizeAffectedUsers(values: readonly string[]): string[] {
  const unique = [...new Set(values)]
  if (unique.length === 0 || unique.length > MAX_AFFECTED_USERS || !unique.every(isInviteEventUserUuid)) {
    throw new InviteEventOutboxError('Invite event affected accounts are invalid.')
  }
  return unique
}

function cloneRecord(record: InviteEventOutboxRecord): InviteEventOutboxRecord {
  return {
    version: record.version,
    recordId: record.recordId,
    affectedUserUuids: [...record.affectedUserUuids],
    event: { ...record.event },
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return
  }
  const error = new Error('Invite event outbox dispatch was aborted.')
  error.name = 'AbortError'
  throw error
}
