export const INVITE_REALTIME_EVENT_VERSION = 1 as const

export type InviteRealtimeEventKind =
  'shared-vault-invite' | 'subscription-invite' | 'shared-vault-membership' | 'application-state'

export type InviteRealtimeInviteAction = 'created' | 'updated' | 'accepted' | 'declined' | 'canceled' | 'deleted'
export type SharedVaultMembershipRealtimeAction =
  'invited' | 'accepted' | 'joined' | 'left' | 'revoked' | 'role-changed'
export type ApplicationStateRealtimeAction = 'updated' | 'invalidated'
export type InviteRealtimeEventAction =
  InviteRealtimeInviteAction | SharedVaultMembershipRealtimeAction | ApplicationStateRealtimeAction
export type SharedVaultMembershipRole = 'read' | 'write' | 'admin'
export type ApplicationStateResource =
  'items' | 'shared-vaults' | 'shared-vault-members' | 'files-metadata' | 'preferences' | 'account' | 'subscriptions'

type InviteRealtimeBaseEvent = {
  version: typeof INVITE_REALTIME_EVENT_VERSION
  eventId: string
  streamPosition: string
  occurredAt: number
}

/**
 * A deliberately data-minimal invitation invalidation. The authenticated
 * transport binds the event to an account; no account identifiers, email
 * addresses, encrypted invitation bodies, or keys cross this contract.
 */
export type SharedVaultInviteRealtimeEvent = InviteRealtimeBaseEvent & {
  kind: 'shared-vault-invite'
  action: InviteRealtimeInviteAction
  inviteUuid: string
  sharedVaultUuid: string
}

export type SubscriptionInviteRealtimeEvent = InviteRealtimeBaseEvent & {
  kind: 'subscription-invite'
  action: InviteRealtimeInviteAction
  inviteUuid: string
}

/**
 * Metadata-only membership delta. Producers append the same committed change
 * to every affected account stream. Keys, emails, encrypted payloads, file
 * bodies, and application assets are intentionally excluded.
 */
export type SharedVaultMembershipRealtimeEvent = InviteRealtimeBaseEvent & {
  kind: 'shared-vault-membership'
  action: SharedVaultMembershipRealtimeAction
  sharedVaultUuid: string
  memberUserUuid: string
  membershipUuid?: string
  inviteUuid?: string
  role?: SharedVaultMembershipRole
  revision: string
}

/** A small signal to apply an existing incremental application-state path. */
export type ApplicationStateRealtimeEvent = InviteRealtimeBaseEvent & {
  kind: 'application-state'
  action: ApplicationStateRealtimeAction
  resource: ApplicationStateResource
  resourceUuid?: string
  revision: string
}

export type InviteRealtimeEvent =
  | SharedVaultInviteRealtimeEvent
  | SubscriptionInviteRealtimeEvent
  | SharedVaultMembershipRealtimeEvent
  | ApplicationStateRealtimeEvent

export type InviteRealtimeBatch = {
  previousCursor: string
  events: InviteRealtimeEvent[]
  nextCursor: string
  hasMore: boolean
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EVENT_KINDS = new Set<InviteRealtimeEventKind>([
  'shared-vault-invite',
  'subscription-invite',
  'shared-vault-membership',
  'application-state',
])
const INVITE_ACTIONS = new Set<InviteRealtimeInviteAction>([
  'created',
  'updated',
  'accepted',
  'declined',
  'canceled',
  'deleted',
])
const MEMBERSHIP_ACTIONS = new Set<SharedVaultMembershipRealtimeAction>([
  'invited',
  'accepted',
  'joined',
  'left',
  'revoked',
  'role-changed',
])
const APPLICATION_ACTIONS = new Set<ApplicationStateRealtimeAction>(['updated', 'invalidated'])
const MEMBERSHIP_ROLES = new Set<SharedVaultMembershipRole>(['read', 'write', 'admin'])
const APPLICATION_RESOURCES = new Set<ApplicationStateResource>([
  'items',
  'shared-vaults',
  'shared-vault-members',
  'files-metadata',
  'preferences',
  'account',
  'subscriptions',
])
const BASE_EVENT_FIELDS = ['version', 'eventId', 'streamPosition', 'kind', 'action', 'occurredAt'] as const
const INVITE_EVENT_FIELDS = new Set([...BASE_EVENT_FIELDS, 'inviteUuid', 'sharedVaultUuid'])
const SUBSCRIPTION_EVENT_FIELDS = new Set([...BASE_EVENT_FIELDS, 'inviteUuid'])
const MEMBERSHIP_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  'sharedVaultUuid',
  'memberUserUuid',
  'membershipUuid',
  'inviteUuid',
  'role',
  'revision',
])
const APPLICATION_EVENT_FIELDS = new Set([...BASE_EVENT_FIELDS, 'resource', 'resourceUuid', 'revision'])

export function isInviteRealtimeEvent(value: unknown): value is InviteRealtimeEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const event = value as Record<string, unknown>
  if (
    event.version !== INVITE_REALTIME_EVENT_VERSION ||
    typeof event.eventId !== 'string' ||
    !UUID_PATTERN.test(event.eventId) ||
    !isOpaqueCursor(event.streamPosition) ||
    typeof event.kind !== 'string' ||
    !EVENT_KINDS.has(event.kind as InviteRealtimeEventKind) ||
    !Number.isSafeInteger(event.occurredAt) ||
    Number(event.occurredAt) <= 0
  ) {
    return false
  }

  switch (event.kind) {
    case 'shared-vault-invite':
      return (
        hasOnlyFields(event, INVITE_EVENT_FIELDS) &&
        typeof event.action === 'string' &&
        INVITE_ACTIONS.has(event.action as InviteRealtimeInviteAction) &&
        isUuid(event.inviteUuid) &&
        isUuid(event.sharedVaultUuid)
      )
    case 'subscription-invite':
      return (
        hasOnlyFields(event, SUBSCRIPTION_EVENT_FIELDS) &&
        typeof event.action === 'string' &&
        INVITE_ACTIONS.has(event.action as InviteRealtimeInviteAction) &&
        isUuid(event.inviteUuid)
      )
    case 'shared-vault-membership': {
      if (
        !hasOnlyFields(event, MEMBERSHIP_EVENT_FIELDS) ||
        typeof event.action !== 'string' ||
        !MEMBERSHIP_ACTIONS.has(event.action as SharedVaultMembershipRealtimeAction) ||
        !isUuid(event.sharedVaultUuid) ||
        !isUuid(event.memberUserUuid) ||
        !isCanonicalRevision(event.revision)
      ) {
        return false
      }
      const needsMembership = event.action !== 'invited'
      const needsInvite = event.action === 'invited' || event.action === 'accepted'
      const needsRole = ['invited', 'accepted', 'joined', 'role-changed'].includes(event.action)
      return (
        (needsMembership ? isUuid(event.membershipUuid) : event.membershipUuid === undefined) &&
        (needsInvite ? isUuid(event.inviteUuid) : event.inviteUuid === undefined) &&
        (needsRole
          ? typeof event.role === 'string' && MEMBERSHIP_ROLES.has(event.role as SharedVaultMembershipRole)
          : event.role === undefined)
      )
    }
    case 'application-state':
      return (
        hasOnlyFields(event, APPLICATION_EVENT_FIELDS) &&
        typeof event.action === 'string' &&
        APPLICATION_ACTIONS.has(event.action as ApplicationStateRealtimeAction) &&
        typeof event.resource === 'string' &&
        APPLICATION_RESOURCES.has(event.resource as ApplicationStateResource) &&
        (event.resourceUuid === undefined || isUuid(event.resourceUuid)) &&
        isCanonicalRevision(event.revision)
      )
    default:
      return false
  }
}

export function isInviteRealtimeBatch(value: unknown): value is InviteRealtimeBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const batch = value as Partial<InviteRealtimeBatch>
  if (
    !isOpaqueCursor(batch.previousCursor) ||
    !isOpaqueCursor(batch.nextCursor) ||
    !Array.isArray(batch.events) ||
    batch.events.length > 100 ||
    typeof batch.hasMore !== 'boolean' ||
    !batch.events.every(isInviteRealtimeEvent)
  ) {
    return false
  }

  if (batch.events.length === 0) {
    return batch.hasMore === false && batch.previousCursor === batch.nextCursor
  }

  const positions = new Set(batch.events.map((event) => event.streamPosition))
  return (
    positions.size === batch.events.length && batch.events[batch.events.length - 1]?.streamPosition === batch.nextCursor
  )
}

export function isOpaqueCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048
}

export function isCanonicalRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,31}$/u.test(value)
}

export function getInviteRealtimeRevisionIdentity(
  event: InviteRealtimeEvent,
): { key: string; revision: string } | undefined {
  switch (event.kind) {
    case 'shared-vault-membership':
      return {
        key: `membership:${event.sharedVaultUuid}`,
        revision: event.revision,
      }
    case 'application-state':
      return {
        key: `application:${event.resource}`,
        revision: event.revision,
      }
    default:
      return undefined
  }
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => fields.has(field))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
