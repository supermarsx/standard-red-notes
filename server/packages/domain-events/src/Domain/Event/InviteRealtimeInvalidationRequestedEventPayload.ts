export const INVITE_REALTIME_INVALIDATION_VERSION = 1 as const

export type InviteRealtimeEventAction = 'created' | 'updated' | 'accepted' | 'declined' | 'canceled' | 'deleted'
export type InviteRealtimeMembershipAction = 'invited' | 'accepted' | 'joined' | 'left' | 'revoked' | 'role-changed'
export type InviteRealtimeMembershipRole = 'read' | 'write' | 'admin'

type InviteRealtimeInvalidationBase = {
  version: typeof INVITE_REALTIME_INVALIDATION_VERSION
  eventId: string
  occurredAt: number
}

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
const MAX_AFFECTED_USERS = 1_000
const BASE_FIELDS = new Set(['version', 'eventId', 'kind', 'action', 'occurredAt'])

export function isInviteRealtimeInvalidationRequestedEventPayload(
  value: unknown,
): value is InviteRealtimeInvalidationRequestedEventPayload {
  if (!isRecord(value) || !hasOnlyFields(value, ['version', 'recordId', 'affectedUserUuids', 'event'])) {
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
  if (value.kind === 'shared-vault-invite') {
    return (
      hasOnlyFields(value, [...BASE_FIELDS, 'inviteUuid', 'sharedVaultUuid']) &&
      isInviteAction(value.action) &&
      isUuid(value.inviteUuid) &&
      isUuid(value.sharedVaultUuid)
    )
  }
  if (value.kind === 'subscription-invite') {
    return (
      hasOnlyFields(value, [...BASE_FIELDS, 'inviteUuid']) && isInviteAction(value.action) && isUuid(value.inviteUuid)
    )
  }
  if (value.kind === 'shared-vault-membership') {
    return (
      hasOnlyFields(value, [
        ...BASE_FIELDS,
        'sharedVaultUuid',
        'memberUserUuid',
        'membershipUuid',
        'inviteUuid',
        'role',
        'revision',
      ]) &&
      isMembershipAction(value.action) &&
      isUuid(value.sharedVaultUuid) &&
      isUuid(value.memberUserUuid) &&
      (value.membershipUuid === undefined || isUuid(value.membershipUuid)) &&
      (value.inviteUuid === undefined || isUuid(value.inviteUuid)) &&
      (value.role === undefined || value.role === 'read' || value.role === 'write' || value.role === 'admin') &&
      typeof value.revision === 'string' &&
      value.revision.length > 0 &&
      value.revision.length <= 128
    )
  }
  return false
}

function isValidBase(value: Record<string, unknown>): boolean {
  return (
    value.version === INVITE_REALTIME_INVALIDATION_VERSION &&
    isUuid(value.eventId) &&
    Number.isSafeInteger(value.occurredAt) &&
    (value.occurredAt as number) > 0
  )
}

function isInviteAction(value: unknown): value is InviteRealtimeEventAction {
  return (
    value === 'created' ||
    value === 'updated' ||
    value === 'accepted' ||
    value === 'declined' ||
    value === 'canceled' ||
    value === 'deleted'
  )
}

function isMembershipAction(value: unknown): value is InviteRealtimeMembershipAction {
  return (
    value === 'invited' ||
    value === 'accepted' ||
    value === 'joined' ||
    value === 'left' ||
    value === 'revoked' ||
    value === 'role-changed'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyFields(value: Record<string, unknown>, allowed: Iterable<string>): boolean {
  const fields = new Set(allowed)
  return Object.keys(value).every((field) => fields.has(field))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
