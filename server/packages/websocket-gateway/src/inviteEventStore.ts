import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const INVITE_REALTIME_EVENT_VERSION = 1 as const
export const MAX_INVITE_EVENT_BYTES = 2 * 1024
export const MAX_INVITE_REPLAY_BATCH = 100

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_EVENTS_PER_USER = 10_000
const APPEND_SCRIPT = `
-- SRN_INVITE_EVENT_APPEND_V1
local cutoff = tonumber(ARGV[4]) - tonumber(ARGV[2])
local expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', cutoff)
for _, expiredPosition in ipairs(expired) do
  redis.call('ZREMRANGEBYSCORE', KEYS[2], expiredPosition, expiredPosition)
  redis.call('ZREM', KEYS[4], expiredPosition)
end
local existing = redis.call('GET', KEYS[3])
if existing then return {existing, 0} end
local position = redis.call('INCR', KEYS[1])
redis.call('ZADD', KEYS[2], position, ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[4], tostring(position))
redis.call('SET', KEYS[3], tostring(position), 'PX', ARGV[2])
local count = redis.call('ZCARD', KEYS[2])
local maximum = tonumber(ARGV[3])
if count > maximum then
  local trimmed = redis.call('ZRANGE', KEYS[2], 0, count - maximum - 1, 'WITHSCORES')
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, count - maximum - 1)
  for index = 2, #trimmed, 2 do redis.call('ZREM', KEYS[4], trimmed[index]) end
end
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[4], ARGV[2])
return {tostring(position), 1}
`
const PRUNE_SCRIPT = `
-- SRN_INVITE_EVENT_PRUNE_V1
local cutoff = tonumber(ARGV[2]) - tonumber(ARGV[1])
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', cutoff)
for _, expiredPosition in ipairs(expired) do
  redis.call('ZREMRANGEBYSCORE', KEYS[1], expiredPosition, expiredPosition)
  redis.call('ZREM', KEYS[2], expiredPosition)
end
return #expired
`

export type InviteEventKind =
  'shared-vault-invite' | 'subscription-invite' | 'shared-vault-membership' | 'application-state'
export type InviteEventAction = 'created' | 'updated' | 'accepted' | 'declined' | 'canceled' | 'deleted'
export type SharedVaultMembershipEventAction = 'invited' | 'accepted' | 'joined' | 'left' | 'revoked' | 'role-changed'
export type ApplicationStateEventAction = 'updated' | 'invalidated'
export type SharedVaultMembershipRole = 'read' | 'write' | 'admin'
export type ApplicationStateResource =
  'items' | 'shared-vaults' | 'shared-vault-members' | 'files-metadata' | 'preferences' | 'account' | 'subscriptions'

type InviteEventBase = {
  version: typeof INVITE_REALTIME_EVENT_VERSION
  eventId: string
  occurredAt: number
}

/** Payload accepted from an invite-domain producer before stream placement. */
export type InviteEventInvalidation =
  | (InviteEventBase & {
      kind: 'shared-vault-invite'
      action: InviteEventAction
      inviteUuid: string
      sharedVaultUuid: string
    })
  | (InviteEventBase & {
      kind: 'subscription-invite'
      action: InviteEventAction
      inviteUuid: string
    })
  | (InviteEventBase & {
      kind: 'shared-vault-membership'
      action: SharedVaultMembershipEventAction
      sharedVaultUuid: string
      memberUserUuid: string
      membershipUuid?: string
      inviteUuid?: string
      role?: SharedVaultMembershipRole
      revision: string
    })
  | (InviteEventBase & {
      kind: 'application-state'
      action: ApplicationStateEventAction
      resource: ApplicationStateResource
      resourceUuid?: string
      revision: string
    })

export type StoredInviteEvent = InviteEventInvalidation & { streamPosition: string }

export type InviteEventReplay = {
  previousCursor: string
  events: StoredInviteEvent[]
  nextCursor: string
  hasMore: boolean
}

export class InviteEventStoreError extends Error {
  constructor(
    readonly code: 'INVITE_CURSOR_INVALID' | 'INVITE_CURSOR_EXPIRED' | 'INVITE_STORE_UNAVAILABLE',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'InviteEventStoreError'
  }
}

export interface InviteEventStore {
  readonly distribution: 'process' | 'shared'
  ready(): boolean
  append(userUuid: string, event: InviteEventInvalidation): Promise<{ cursor: string; duplicate: boolean }>
  tail(userUuid: string): Promise<string>
  readAfter(userUuid: string, cursor: string, limit?: number): Promise<InviteEventReplay>
}

export type AffectedUserAppendResult = {
  userUuid: string
  cursor: string
  duplicate: boolean
}

/**
 * Fan out one committed metadata change to every affected account stream.
 * Retrying after a partial backend failure is safe because eventId is deduped
 * independently in each account stream.
 */
export async function appendInviteEventForAffectedUsers(
  store: InviteEventStore,
  userUuids: readonly string[],
  event: InviteEventInvalidation,
): Promise<AffectedUserAppendResult[]> {
  assertInviteEvent(event)
  const uniqueUserUuids = [...new Set(userUuids)]
  if (uniqueUserUuids.length === 0 || uniqueUserUuids.length > 1_000) {
    throw new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', 'Affected account fanout is empty or too large.')
  }
  uniqueUserUuids.forEach(assertUserUuid)

  return Promise.all(
    uniqueUserUuids.map(async (userUuid) => {
      const result = await store.append(userUuid, event)
      return { userUuid, ...result }
    }),
  )
}

export interface RedisInviteEventClient {
  readonly status: string
  get(key: string): Promise<string | null>
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>
  zrangebyscore(
    key: string,
    minimum: string,
    maximum: '+inf',
    withScores: 'WITHSCORES',
    limit: 'LIMIT',
    offset: number,
    count: number,
  ): Promise<string[]>
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export type RedisInviteEventStoreOptions = {
  cursorSecret: string | Uint8Array
  keyPrefix?: string
  retentionMilliseconds?: number
  maxEventsPerUser?: number
  clock?: () => number
}

export class RedisInviteEventStore implements InviteEventStore {
  readonly distribution = 'shared' as const
  private readonly cursorCodec: InviteCursorCodec
  private readonly keyPrefix: string
  private readonly retentionMilliseconds: number
  private readonly maxEventsPerUser: number
  private readonly clock: () => number

  constructor(
    private readonly redis: RedisInviteEventClient,
    options: RedisInviteEventStoreOptions,
  ) {
    this.cursorCodec = new InviteCursorCodec(options.cursorSecret)
    this.keyPrefix = options.keyPrefix ?? 'ws:invite-events:v1:'
    this.retentionMilliseconds = positiveInteger(
      options.retentionMilliseconds ?? DEFAULT_RETENTION_MS,
      'retentionMilliseconds',
    )
    this.maxEventsPerUser = positiveInteger(options.maxEventsPerUser ?? DEFAULT_MAX_EVENTS_PER_USER, 'maxEventsPerUser')
    this.clock = options.clock ?? Date.now
  }

  ready(): boolean {
    return this.redis.status === 'ready'
  }

  async append(userUuid: string, event: InviteEventInvalidation): Promise<{ cursor: string; duplicate: boolean }> {
    this.assertReady()
    assertUserUuid(userUuid)
    assertInviteEvent(event)
    const serialized = JSON.stringify(event)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INVITE_EVENT_BYTES) {
      throw new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', 'Invite invalidation exceeds the durable limit.')
    }

    const keys = this.keys(userUuid)
    const eventIdentity = createHash('sha256').update(event.eventId, 'utf8').digest('hex')
    let result: unknown
    try {
      result = await this.redis.eval(
        APPEND_SCRIPT,
        4,
        keys.counter,
        keys.events,
        `${keys.dedup}${eventIdentity}`,
        keys.ages,
        serialized,
        this.retentionMilliseconds,
        this.maxEventsPerUser,
        this.clock(),
      )
    } catch (error) {
      throw unavailable('Could not append invite invalidation.', error)
    }
    if (!Array.isArray(result) || result.length !== 2) {
      throw unavailable('Invite invalidation append result is malformed.')
    }
    const position = parsePosition(result[0])
    const appended = Number(result[1])
    if (position === undefined || (appended !== 0 && appended !== 1)) {
      throw unavailable('Invite invalidation append result is malformed.')
    }
    return { cursor: this.cursorCodec.encode(userUuid, position), duplicate: appended === 0 }
  }

  async tail(userUuid: string): Promise<string> {
    this.assertReady()
    assertUserUuid(userUuid)
    let value: string | null
    try {
      value = await this.redis.get(this.keys(userUuid).counter)
    } catch (error) {
      throw unavailable('Could not read invite stream tail.', error)
    }
    const position = value === null ? 0 : parsePosition(value)
    if (position === undefined) {
      throw unavailable('Invite stream tail is malformed.')
    }
    return this.cursorCodec.encode(userUuid, position)
  }

  async readAfter(userUuid: string, cursor: string, limit = MAX_INVITE_REPLAY_BATCH): Promise<InviteEventReplay> {
    this.assertReady()
    assertUserUuid(userUuid)
    const boundedLimit = replayLimit(limit)
    const after = this.cursorCodec.decode(userUuid, cursor)
    const keys = this.keys(userUuid)

    let counterValue: string | null
    let earliestRow: string[]
    let rows: string[]
    try {
      await this.redis.eval(PRUNE_SCRIPT, 2, keys.events, keys.ages, this.retentionMilliseconds, this.clock())
      ;[counterValue, earliestRow, rows] = await Promise.all([
        this.redis.get(keys.counter),
        this.redis.zrange(keys.events, 0, 0, 'WITHSCORES'),
        this.redis.zrangebyscore(keys.events, `(${after}`, '+inf', 'WITHSCORES', 'LIMIT', 0, boundedLimit + 1),
      ])
    } catch (error) {
      throw unavailable('Could not replay invite invalidations.', error)
    }

    const tail = counterValue === null ? 0 : parsePosition(counterValue)
    const earliest = earliestRow.length === 0 ? undefined : parsePosition(earliestRow[1])
    if (tail === undefined || earliestRow.length % 2 !== 0 || (earliestRow.length > 0 && earliest === undefined)) {
      throw unavailable('Invite stream metadata is malformed.')
    }
    if (after > tail) {
      throw new InviteEventStoreError('INVITE_CURSOR_INVALID', 'Invite cursor is ahead of the authenticated stream.')
    }
    if (after < tail && (earliest === undefined || earliest > after + 1)) {
      throw new InviteEventStoreError('INVITE_CURSOR_EXPIRED', 'Invite cursor is outside replay retention.')
    }
    if (rows.length % 2 !== 0) {
      throw unavailable('Invite stream replay is malformed.')
    }

    const available = rows.length / 2
    const hasMore = available > boundedLimit
    const selected = hasMore ? rows.slice(0, boundedLimit * 2) : rows
    const events: StoredInviteEvent[] = []
    for (let index = 0; index < selected.length; index += 2) {
      const position = parsePosition(selected[index + 1])
      if (position === undefined) {
        throw unavailable('Invite stream position is malformed.')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(selected[index])
      } catch (error) {
        throw unavailable('Invite stream payload is malformed.', error)
      }
      assertInviteEventFromStore(parsed)
      events.push({ ...parsed, streamPosition: this.cursorCodec.encode(userUuid, position) })
    }

    return {
      previousCursor: cursor,
      events,
      nextCursor: events.at(-1)?.streamPosition ?? cursor,
      hasMore,
    }
  }

  private assertReady(): void {
    if (!this.ready()) {
      throw unavailable('Durable invite stream is not ready.')
    }
  }

  private keys(userUuid: string): { counter: string; events: string; dedup: string; ages: string } {
    const subject = createHash('sha256').update(userUuid, 'utf8').digest('hex')
    const base = `${this.keyPrefix}${subject}`
    return {
      counter: `${base}:counter`,
      events: `${base}:events`,
      dedup: `${base}:dedup:`,
      ages: `${base}:ages`,
    }
  }
}

export type InMemoryInviteEventStoreOptions = {
  cursorSecret: string | Uint8Array
  maxEventsPerUser?: number
}

/** Explicit test/development fallback; production negotiation requires shared distribution. */
export class InMemoryInviteEventStore implements InviteEventStore {
  readonly distribution = 'process' as const
  private readonly cursorCodec: InviteCursorCodec
  private readonly maximum: number
  private readonly streams = new Map<
    string,
    { tail: number; events: Array<{ position: number; event: InviteEventInvalidation }> }
  >()
  private readonly positionsByEvent = new Map<string, number>()

  constructor(options: InMemoryInviteEventStoreOptions) {
    this.cursorCodec = new InviteCursorCodec(options.cursorSecret)
    this.maximum = positiveInteger(options.maxEventsPerUser ?? DEFAULT_MAX_EVENTS_PER_USER, 'maxEventsPerUser')
  }

  ready(): boolean {
    return true
  }

  async append(userUuid: string, event: InviteEventInvalidation): Promise<{ cursor: string; duplicate: boolean }> {
    assertUserUuid(userUuid)
    assertInviteEvent(event)
    const identity = `${userUuid}\u0000${event.eventId}`
    const duplicatePosition = this.positionsByEvent.get(identity)
    if (duplicatePosition !== undefined) {
      return { cursor: this.cursorCodec.encode(userUuid, duplicatePosition), duplicate: true }
    }
    const stream = this.streams.get(userUuid) ?? { tail: 0, events: [] }
    stream.tail += 1
    stream.events.push({ position: stream.tail, event: { ...event } })
    while (stream.events.length > this.maximum) {
      const removed = stream.events.shift()
      if (removed) {
        this.positionsByEvent.delete(`${userUuid}\u0000${removed.event.eventId}`)
      }
    }
    this.streams.set(userUuid, stream)
    this.positionsByEvent.set(identity, stream.tail)
    return { cursor: this.cursorCodec.encode(userUuid, stream.tail), duplicate: false }
  }

  async tail(userUuid: string): Promise<string> {
    assertUserUuid(userUuid)
    return this.cursorCodec.encode(userUuid, this.streams.get(userUuid)?.tail ?? 0)
  }

  async readAfter(userUuid: string, cursor: string, limit = MAX_INVITE_REPLAY_BATCH): Promise<InviteEventReplay> {
    assertUserUuid(userUuid)
    const boundedLimit = replayLimit(limit)
    const after = this.cursorCodec.decode(userUuid, cursor)
    const stream = this.streams.get(userUuid) ?? { tail: 0, events: [] }
    if (after > stream.tail) {
      throw new InviteEventStoreError('INVITE_CURSOR_INVALID', 'Invite cursor is ahead of the authenticated stream.')
    }
    if (after < stream.tail && (stream.events[0] === undefined || stream.events[0].position > after + 1)) {
      throw new InviteEventStoreError('INVITE_CURSOR_EXPIRED', 'Invite cursor is outside replay retention.')
    }
    const available = stream.events.filter((entry) => entry.position > after)
    const selected = available.slice(0, boundedLimit)
    const events = selected.map(({ position, event }) => ({
      ...event,
      streamPosition: this.cursorCodec.encode(userUuid, position),
    }))
    return {
      previousCursor: cursor,
      events,
      nextCursor: events.at(-1)?.streamPosition ?? cursor,
      hasMore: available.length > selected.length,
    }
  }
}

class InviteCursorCodec {
  private readonly secret: Buffer

  constructor(secret: string | Uint8Array) {
    this.secret = Buffer.from(secret)
    if (this.secret.byteLength < 32) {
      throw new Error('Invite cursor secret must contain at least 32 bytes.')
    }
  }

  encode(userUuid: string, position: number): string {
    const encodedPosition = position.toString(36)
    const message = `v1\u0000${userUuid}\u0000${encodedPosition}`
    const signature = createHmac('sha256', this.secret).update(message, 'utf8').digest('base64url')
    return `v1.${encodedPosition}.${signature}`
  }

  decode(userUuid: string, cursor: string): number {
    const parts = cursor.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1' || !/^[0-9a-z]+$/u.test(parts[1])) {
      throw new InviteEventStoreError('INVITE_CURSOR_INVALID', 'Invite cursor is malformed.')
    }
    const position = Number.parseInt(parts[1], 36)
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new InviteEventStoreError('INVITE_CURSOR_INVALID', 'Invite cursor position is invalid.')
    }
    const expected = Buffer.from(
      createHmac('sha256', this.secret).update(`v1\u0000${userUuid}\u0000${parts[1]}`, 'utf8').digest('base64url'),
      'utf8',
    )
    const supplied = Buffer.from(parts[2], 'utf8')
    if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) {
      throw new InviteEventStoreError('INVITE_CURSOR_INVALID', 'Invite cursor does not belong to this account.')
    }
    return position
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const KINDS = new Set<InviteEventKind>([
  'shared-vault-invite',
  'subscription-invite',
  'shared-vault-membership',
  'application-state',
])
const ACTIONS = new Set<InviteEventAction>(['created', 'updated', 'accepted', 'declined', 'canceled', 'deleted'])
const MEMBERSHIP_ACTIONS = new Set<SharedVaultMembershipEventAction>([
  'invited',
  'accepted',
  'joined',
  'left',
  'revoked',
  'role-changed',
])
const APPLICATION_ACTIONS = new Set<ApplicationStateEventAction>(['updated', 'invalidated'])
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
const BASE_FIELDS = ['version', 'eventId', 'kind', 'action', 'occurredAt'] as const
const SHARED_INVITE_FIELDS = new Set([...BASE_FIELDS, 'inviteUuid', 'sharedVaultUuid'])
const SUBSCRIPTION_INVITE_FIELDS = new Set([...BASE_FIELDS, 'inviteUuid'])
const MEMBERSHIP_FIELDS = new Set([
  ...BASE_FIELDS,
  'sharedVaultUuid',
  'memberUserUuid',
  'membershipUuid',
  'inviteUuid',
  'role',
  'revision',
])
const APPLICATION_FIELDS = new Set([...BASE_FIELDS, 'resource', 'resourceUuid', 'revision'])

function assertUserUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', 'Authenticated invite subject is invalid.')
  }
}

function assertInviteEvent(value: unknown): asserts value is InviteEventInvalidation {
  if (!isInviteEventInvalidation(value)) {
    throw new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', 'Invite invalidation is malformed.')
  }
}

function assertInviteEventFromStore(value: unknown): asserts value is InviteEventInvalidation {
  if (!isInviteEventInvalidation(value)) {
    throw unavailable('Invite stream payload failed validation.')
  }
}

/** Canonical strict validator shared by producers, the durable store, and the wire adapter. */
export function isInviteEventInvalidation(value: unknown): value is InviteEventInvalidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const event = value as Record<string, unknown>
  if (
    event.version !== INVITE_REALTIME_EVENT_VERSION ||
    typeof event.eventId !== 'string' ||
    !UUID_PATTERN.test(event.eventId) ||
    typeof event.kind !== 'string' ||
    !KINDS.has(event.kind as InviteEventKind) ||
    !Number.isSafeInteger(event.occurredAt) ||
    Number(event.occurredAt) <= 0
  ) {
    return false
  }

  switch (event.kind) {
    case 'shared-vault-invite':
      return (
        hasOnlyFields(event, SHARED_INVITE_FIELDS) &&
        typeof event.action === 'string' &&
        ACTIONS.has(event.action as InviteEventAction) &&
        isUuid(event.inviteUuid) &&
        isUuid(event.sharedVaultUuid)
      )
    case 'subscription-invite':
      return (
        hasOnlyFields(event, SUBSCRIPTION_INVITE_FIELDS) &&
        typeof event.action === 'string' &&
        ACTIONS.has(event.action as InviteEventAction) &&
        isUuid(event.inviteUuid)
      )
    case 'shared-vault-membership': {
      if (
        !hasOnlyFields(event, MEMBERSHIP_FIELDS) ||
        typeof event.action !== 'string' ||
        !MEMBERSHIP_ACTIONS.has(event.action as SharedVaultMembershipEventAction) ||
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
        hasOnlyFields(event, APPLICATION_FIELDS) &&
        typeof event.action === 'string' &&
        APPLICATION_ACTIONS.has(event.action as ApplicationStateEventAction) &&
        typeof event.resource === 'string' &&
        APPLICATION_RESOURCES.has(event.resource as ApplicationStateResource) &&
        (event.resourceUuid === undefined || isUuid(event.resourceUuid)) &&
        isCanonicalRevision(event.revision)
      )
    default:
      return false
  }
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => fields.has(field))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isInviteEventUserUuid(value: unknown): value is string {
  return isUuid(value)
}

export function isOpaqueInviteEventCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 2_048
}

function isCanonicalRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,31}$/u.test(value)
}

function replayLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INVITE_REPLAY_BATCH) {
    throw new InviteEventStoreError('INVITE_CURSOR_INVALID', 'Invite replay limit is invalid.')
  }
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`)
  }
  return value
}

function parsePosition(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function unavailable(message: string, cause?: unknown): InviteEventStoreError {
  return new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', message, cause === undefined ? undefined : { cause })
}
