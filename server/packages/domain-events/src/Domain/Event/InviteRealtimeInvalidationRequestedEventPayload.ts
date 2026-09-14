export const INVITE_REALTIME_INVALIDATION_VERSION = 1 as const

export type InviteRealtimeEventKind =
  | 'shared-vault-invite'
  | 'subscription-invite'
  | 'shared-vault-membership'
  | 'application-state'
export type InviteRealtimeEventAction = 'created' | 'updated' | 'accepted' | 'declined' | 'canceled' | 'deleted'
// `role-changed` was dropped together with the client contract (N16): no producer
// emits it and a client disconnects on an action it does not know.
export type InviteRealtimeMembershipAction = 'invited' | 'accepted' | 'joined' | 'left' | 'revoked'
export type InviteRealtimeMembershipRole = 'read' | 'write' | 'admin'
export type InviteRealtimeApplicationStateAction = 'updated' | 'invalidated'
export type InviteRealtimeApplicationStateResource =
  | 'items'
  | 'shared-vaults'
  | 'shared-vault-members'
  | 'files-metadata'
  | 'preferences'
  | 'account'
  | 'subscriptions'

type InviteRealtimeInvalidationBase = {
  version: typeof INVITE_REALTIME_INVALIDATION_VERSION
  eventId: string
  occurredAt: number
}

/**
 * Mirrors the websocket gateway's `InviteEventInvalidation` (its
 * `inviteEventStore.ts` is the canonical validator). The rules below must stay
 * identical: a payload the gateway rejects is never acknowledged on SQS and
 * would otherwise be redelivered forever, so producers fail fast here instead.
 */
export type InviteRealtimeInvalidation =
  | (InviteRealtimeInvalidationBase & {
      kind: 'shared-vault-invite'
      action: InviteRealtimeEventAction
      inviteUuid: string
      sharedVaultUuid: string
    })
  | (InviteRealtimeInvalidationBase & {
      kind: 'subscription-invite'
      action: InviteRealtimeEventAction
      inviteUuid: string
    })
  | (InviteRealtimeInvalidationBase & {
      kind: 'shared-vault-membership'
      action: InviteRealtimeMembershipAction
      sharedVaultUuid: string
      memberUserUuid: string
      membershipUuid?: string
      inviteUuid?: string
      role?: InviteRealtimeMembershipRole
      revision: string
    })
  | (InviteRealtimeInvalidationBase & {
      kind: 'application-state'
      action: InviteRealtimeApplicationStateAction
      resource: InviteRealtimeApplicationStateResource
      resourceUuid?: string
      revision: string
    })

/**
 * Durable, metadata-only bridge from a mutation database outbox to the invite
 * event stream. Identifiers and invalidation metadata are intentionally the
 * only accepted fields; encrypted invite bodies, emails and subscription
 * details never cross this boundary.
 */
export type InviteRealtimeInvalidationRequestedEventPayload = {
  version: typeof INVITE_REALTIME_INVALIDATION_VERSION
  recordId: string
  affectedUserUuids: string[]
  event: InviteRealtimeInvalidation
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** Same shape the gateway enforces: a positive decimal integer without leading zeros, at most 32 digits. */
const CANONICAL_REVISION_PATTERN = /^[1-9]\d{0,31}$/u
const MAX_AFFECTED_USERS = 1_000

const INVITE_ACTIONS: ReadonlySet<string> = new Set<InviteRealtimeEventAction>([
  'created',
  'updated',
  'accepted',
  'declined',
  'canceled',
  'deleted',
])
const MEMBERSHIP_ACTIONS: ReadonlySet<string> = new Set<InviteRealtimeMembershipAction>([
  'invited',
  'accepted',
  'joined',
  'left',
  'revoked',
])
const MEMBERSHIP_ROLES: ReadonlySet<string> = new Set<InviteRealtimeMembershipRole>(['read', 'write', 'admin'])
const APPLICATION_ACTIONS: ReadonlySet<string> = new Set<InviteRealtimeApplicationStateAction>([
  'updated',
  'invalidated',
])
const APPLICATION_RESOURCES: ReadonlySet<string> = new Set<InviteRealtimeApplicationStateResource>([
  'items',
  'shared-vaults',
  'shared-vault-members',
  'files-metadata',
  'preferences',
  'account',
  'subscriptions',
])
const MEMBERSHIP_ACTIONS_WITH_ROLE: ReadonlySet<string> = new Set<InviteRealtimeMembershipAction>([
  'invited',
  'accepted',
  'joined',
])

const BASE_FIELDS = ['version', 'eventId', 'kind', 'action', 'occurredAt']
const SHARED_INVITE_FIELDS: ReadonlySet<string> = new Set([...BASE_FIELDS, 'inviteUuid', 'sharedVaultUuid'])
const SUBSCRIPTION_INVITE_FIELDS: ReadonlySet<string> = new Set([...BASE_FIELDS, 'inviteUuid'])
const MEMBERSHIP_FIELDS: ReadonlySet<string> = new Set([
  ...BASE_FIELDS,
  'sharedVaultUuid',
  'memberUserUuid',
  'membershipUuid',
  'inviteUuid',
  'role',
  'revision',
])
const APPLICATION_FIELDS: ReadonlySet<string> = new Set([...BASE_FIELDS, 'resource', 'resourceUuid', 'revision'])
const PAYLOAD_FIELDS: ReadonlySet<string> = new Set(['version', 'recordId', 'affectedUserUuids', 'event'])

export function isInviteRealtimeInvalidationRequestedEventPayload(
  value: unknown,
): value is InviteRealtimeInvalidationRequestedEventPayload {
  if (!isRecord(value) || !hasOnlyFields(value, PAYLOAD_FIELDS)) {
    return false
  }
  if (
    value.version !== INVITE_REALTIME_INVALIDATION_VERSION ||
    !isUuid(value.recordId) ||
    !Array.isArray(value.affectedUserUuids) ||
    value.affectedUserUuids.length === 0 ||
    value.affectedUserUuids.length > MAX_AFFECTED_USERS ||
    !value.affectedUserUuids.every(isUuid) ||
    new Set(value.affectedUserUuids).size !== value.affectedUserUuids.length ||
    !isInviteRealtimeInvalidation(value.event)
  ) {
    return false
  }
  return value.recordId === value.event.eventId
}

export function isInviteRealtimeInvalidation(value: unknown): value is InviteRealtimeInvalidation {
  if (!isRecord(value) || !isValidBase(value)) {
    return false
  }
  switch (value.kind) {
    case 'shared-vault-invite':
      return (
        hasOnlyFields(value, SHARED_INVITE_FIELDS) &&
        isMember(INVITE_ACTIONS, value.action) &&
        isUuid(value.inviteUuid) &&
        isUuid(value.sharedVaultUuid)
      )
    case 'subscription-invite':
      return (
        hasOnlyFields(value, SUBSCRIPTION_INVITE_FIELDS) &&
        isMember(INVITE_ACTIONS, value.action) &&
        isUuid(value.inviteUuid)
      )
    case 'shared-vault-membership':
      return isValidMembership(value)
    case 'application-state':
      return (
        hasOnlyFields(value, APPLICATION_FIELDS) &&
        isMember(APPLICATION_ACTIONS, value.action) &&
        isMember(APPLICATION_RESOURCES, value.resource) &&
        (value.resourceUuid === undefined || isUuid(value.resourceUuid)) &&
        isCanonicalRevision(value.revision)
      )
    default:
      return false
  }
}

function isValidMembership(value: Record<string, unknown>): boolean {
  if (
    !hasOnlyFields(value, MEMBERSHIP_FIELDS) ||
    !isMember(MEMBERSHIP_ACTIONS, value.action) ||
    !isUuid(value.sharedVaultUuid) ||
    !isUuid(value.memberUserUuid) ||
    !isCanonicalRevision(value.revision)
  ) {
    return false
  }
  // Per-action requirements are exact: an `invited` event has no membership row
  // yet, only `invited`/`accepted` carry the invite, and role-less actions must
  // not smuggle a role. Anything looser is rejected by the gateway.
  const needsMembership = value.action !== 'invited'
  const needsInvite = value.action === 'invited' || value.action === 'accepted'
  const needsRole = MEMBERSHIP_ACTIONS_WITH_ROLE.has(value.action)
  return (
    (needsMembership ? isUuid(value.membershipUuid) : value.membershipUuid === undefined) &&
    (needsInvite ? isUuid(value.inviteUuid) : value.inviteUuid === undefined) &&
    (needsRole ? isMember(MEMBERSHIP_ROLES, value.role) : value.role === undefined)
  )
}

function isValidBase(value: Record<string, unknown>): boolean {
  return (
    value.version === INVITE_REALTIME_INVALIDATION_VERSION &&
    isUuid(value.eventId) &&
    Number.isSafeInteger(value.occurredAt) &&
    (value.occurredAt as number) > 0
  )
}

function isMember(allowed: ReadonlySet<string>, value: unknown): value is string {
  return typeof value === 'string' && allowed.has(value)
}

function isCanonicalRevision(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_REVISION_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => allowed.has(field))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
