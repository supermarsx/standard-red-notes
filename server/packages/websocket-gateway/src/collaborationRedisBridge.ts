import { createHash, randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'

import type { Conn, SendableSocket } from './registry.js'
import {
  CollaborationRoomEpochMismatchError,
  collaborationErrorCode,
  parseRelayFrame,
  PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
  roomDeniedReasonFor,
  type CollaborationLifecycleErrorCode,
  type RelayFrame,
  type RoomDeniedReason,
  type RoomRegistry,
  type RoomRelayLifecycle,
} from './rooms.js'
import type { Logger } from './redisBridge.js'
import { safeErrorLogMetadata } from './safeLog.js'

export const COLLABORATION_RELAY_CHANNEL = 'srn-collaboration-relay-v1'
const COLLABORATION_KEY_ROOT = 'srn:collaboration:'

/**
 * Per-deployment Redis namespace (C10): a non-empty namespace prefixes every
 * collaboration key and the relay channel as `<ns>:<original>`; empty keeps
 * today's byte-identical names so a rolling upgrade keeps replicas talking.
 */
export function collaborationKeyPrefix(namespace: string | undefined): string {
  const trimmed = (namespace ?? '').replace(/:+$/, '')
  return trimmed.length > 0 ? `${trimmed}:` : ''
}

export function collaborationRelayChannel(namespace: string | undefined): string {
  return `${collaborationKeyPrefix(namespace)}${COLLABORATION_RELAY_CHANNEL}`
}

const LEASE_TTL_MS = 75_000
const ROOM_EPOCH_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1_000
const REDIS_OPERATION_TIMEOUT_MS = 1_500
const MAX_RELAY_ENVELOPE_BYTES = 700 * 1024
const LEASE_CLEANUP_RETRY_BASE_MS = 100
const LEASE_CLEANUP_RETRY_MAX_MS = 5_000
export const MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM = 64
export const COLLABORATION_PRESENCE_TTL_MS = 45_000
// Longer than the client's full-state response/acceptance window. A retry uses
// a new stateRequestId, so liveness does not require re-granting the same id
// while a 4 MiB winner may still be encrypting and chunking its response.
export const YJS_RESPONSE_CLAIM_TTL_MS = 15_000
/**
 * Every failure the bridge raises carries a stable `code` (R45) so operators can
 * tell an epoch lockout from a Redis outage even after log redaction, and so the
 * gateway can name the denial to the client (C1). `policy` marks lease-policy
 * rejections that deny one room without declaring the whole relay unhealthy.
 */
export class CollaborationLifecycleError extends Error {
  constructor(
    readonly code: CollaborationLifecycleErrorCode,
    message: string,
    readonly policy = false,
  ) {
    super(message)
    this.name = 'CollaborationLifecycleError'
  }
}

function lifecycleError(code: CollaborationLifecycleErrorCode, message: string): CollaborationLifecycleError {
  return new CollaborationLifecycleError(code, message)
}

function leasePolicyError(code: CollaborationLifecycleErrorCode, message: string): CollaborationLifecycleError {
  return new CollaborationLifecycleError(code, message, true)
}

function incompatibleProtocolError(): CollaborationLifecycleError {
  return leasePolicyError('incompatible-protocol', 'Incompatible collaboration protocol is active in this room')
}

function roomLeaseLimitError(): CollaborationLifecycleError {
  return leasePolicyError('room-limit', 'Collaboration room editor lease limit exceeded')
}

function leaseOwnershipLostError(): CollaborationLifecycleError {
  return leasePolicyError('reservation-expired', 'Collaboration lease ownership was lost')
}

function relayUnhealthyError(): CollaborationLifecycleError {
  return lifecycleError('relay-unhealthy', 'Redis collaboration relay is not healthy')
}

function isLeasePolicyError(error: unknown): error is CollaborationLifecycleError {
  return error instanceof CollaborationLifecycleError && error.policy
}

/** Wrap a raw transport rejection so every thrown error carries a cause code. */
function asLifecycleError(error: unknown): Error {
  if (collaborationErrorCode(error) !== undefined) {
    return error as Error
  }
  const wrapped = lifecycleError('redis-unavailable', 'Redis collaboration operation failed')
  wrapped.cause = error
  return wrapped
}

type DenialOperation =
  | 'current-room-epoch'
  | 'responder-lookup'
  | 'lease-renewal'
  | 'lease-reservation'
  | 'lease-activation'
  | 'yjs-response-claim'
  | 'lease-refresh'
  | 'frame-publish'
  | 'lease-cleanup'

/**
 * The operator lines, as constants: the operation selects one, and the only
 * other value beside it is the closed-enum cause code (R45), repeated in the
 * metadata for hosts that keep structured fields. Nothing derived from the raw
 * error ever reaches the message position; `safeErrorLogMetadata` carries its
 * redacted classification.
 */
const WARN_LINES: Readonly<Record<DenialOperation, string>> = Object.freeze({
  'current-room-epoch': '[collab-redis] current room epoch unavailable',
  'responder-lookup': '[collab-redis] responder lookup unavailable',
  'lease-renewal': '[collab-redis] lease renewal unavailable; denying collaboration',
  'lease-reservation': '[collab-redis] lease reservation unavailable; denying collaboration',
  'lease-activation': '[collab-redis] lease activation unavailable; denying collaboration',
  'yjs-response-claim': '[collab-redis] Yjs response claim unavailable; denying collaboration',
  'lease-refresh': '[collab-redis] lease refresh failed',
  'frame-publish': '[collab-redis] encrypted frame publish failed',
  'lease-cleanup': '[collab-redis] lease cleanup failed',
})

function causeCodeOf(error: unknown): CollaborationLifecycleErrorCode {
  return collaborationErrorCode(error) ?? 'redis-unavailable'
}

type RelayPayloadFrame =
  | Extract<RelayFrame, { t: 'yjs' | 'yjs-chunk' | 'yjs-retry' | 'awareness' | 'comment' }>
  | RoomPresenceFrame
  | {
      t: 'room-sync'
      room: string
    }

type RoomPresenceFrame =
  | {
      t: 'room-presence'
      room: string
      roomEpoch: string
      protocolVersion: 3
      action: 'joined'
      presenceId: string
      userUuid: string
      clientId: number
      ttlMilliseconds: number
    }
  | {
      t: 'room-presence'
      room: string
      roomEpoch: string
      protocolVersion: 3
      action: 'left'
      presenceId: string
      userUuid: string
      clientId: number
      reason: 'clean-leave' | 'disconnect' | 'heartbeat-timeout' | 'revoked'
    }

type LocalPresence<S extends SendableSocket> = {
  lease: LocalLease<S>
  presenceId: string
  clientId: number
  expiresAt: number
}

interface RedisCommandClient {
  readonly status: string
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
  publish(channel: string, message: string): Promise<number>
  on(event: 'error', callback: (error: Error) => void): unknown
  on(event: 'ready', callback: () => void): unknown
  on(event: 'close' | 'end', callback: () => void): unknown
  on(event: 'reconnecting', callback: (delay: number) => void): unknown
  quit(): Promise<unknown>
  disconnect(): void
}

interface RedisSubscriberClient {
  readonly status: string
  subscribe(channel: string, callback: (error: Error | null | undefined, count?: unknown) => void): unknown
  on(event: 'message', callback: (channel: string, message: string) => void): unknown
  on(event: 'error', callback: (error: Error) => void): unknown
  on(event: 'ready', callback: () => void): unknown
  on(event: 'close' | 'end', callback: () => void): unknown
  on(event: 'reconnecting', callback: (delay: number) => void): unknown
  quit(): Promise<unknown>
  disconnect(): void
}

type LocalLease<S extends SendableSocket> = {
  conn: Conn<S>
  room: string
  requestId: string
  roomSetKey: string
  roomStateKey: string
  leaseKey: string
  redisValue: string
  roomStatePrefix: string
  rotatedRoomStateValue: string
  expiresAt: number
  shouldBootstrap: boolean
  bootstrapChallenge?: string
  protocolVersion: 3
  roomEpoch: string
  collaborationSecurityEpoch: string
  collaborationAuthorizationIssuedAt: number
  reservedRevision: number
  activated: boolean
}

// A denied reserve (epoch or security mismatch) returns WITHOUT touching the
// room-state TTL: only a successful reserve/refresh/release re-arms the 24 h
// tombstone. Otherwise every retry against a rotated room would push the
// lock-out out another day (t90 v2-M1), and a note in daily use never recovers.
const RESERVE_LEASE_SCRIPT = `
-- SRN_RESERVE_LEASE_V3
local members = redis.call('SMEMBERS', KEYS[1])
local active = 0
local alreadyReserved = false
for _, leaseKey in ipairs(members) do
  if redis.call('EXISTS', leaseKey) == 0 then
    redis.call('SREM', KEYS[1], leaseKey)
  else
    local value = redis.call('GET', leaseKey)
    if string.sub(value or '', 1, 3) ~= string.sub(ARGV[3], 1, 3) then return -1 end
    active = active + 1
    if leaseKey == KEYS[2] then alreadyReserved = true end
  end
end
local requestedState = ARGV[5] .. ':' .. ARGV[6] .. ':' .. ARGV[9]
local currentState = redis.call('GET', KEYS[3])
if not currentState then
  if active > 0 then
    for _, leaseKey in ipairs(members) do redis.call('DEL', leaseKey) end
    redis.call('DEL', KEYS[1])
    local rotatedState = ARGV[7] .. ':' .. ARGV[6] .. ':' .. ARGV[9]
    redis.call('SET', KEYS[3], rotatedState, 'PX', ARGV[8])
    return 'revoked:' .. ARGV[7]
  end
  redis.call('SET', KEYS[3], requestedState, 'PX', ARGV[8])
  currentState = requestedState
else
  local separator = string.find(currentState, ':', 1, true)
  local securitySeparator = separator and string.find(currentState, ':', separator + 1, true)
  local currentEpoch = separator and string.sub(currentState, 1, separator - 1) or ''
  local currentSecurityEpoch = securitySeparator and string.sub(currentState, separator + 1, securitySeparator - 1) or ''
  local currentIssuedAt = securitySeparator and tonumber(string.sub(currentState, securitySeparator + 1)) or 0
  local requestedIssuedAt = tonumber(ARGV[9]) or 0
  if currentSecurityEpoch ~= ARGV[6] then
    if requestedIssuedAt <= currentIssuedAt then
      return 'epoch:' .. currentEpoch
    end
    for _, leaseKey in ipairs(members) do redis.call('DEL', leaseKey) end
    redis.call('DEL', KEYS[1])
    local rotatedState = ARGV[7] .. ':' .. ARGV[6] .. ':' .. ARGV[9]
    redis.call('SET', KEYS[3], rotatedState, 'PX', ARGV[8])
    return 'revoked:' .. ARGV[7]
  end
  if currentEpoch ~= ARGV[5] then
    return 'epoch:' .. currentEpoch
  end
end
if active >= tonumber(ARGV[4]) and not alreadyReserved then return -2 end
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[1])
redis.call('SADD', KEYS[1], KEYS[2])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[8])
if active == 0 then return 1 else return 0 end
`

const RELEASE_LEASE_SCRIPT = `
-- SRN_RELEASE_LEASE_V3
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[1], KEYS[2])
if redis.call('SCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
  local currentState = redis.call('GET', KEYS[3])
  if currentState and string.sub(currentState, 1, string.len(ARGV[2])) == ARGV[2]
    and string.sub(currentState, string.len(ARGV[2]) + 1, string.len(ARGV[2]) + 1) == ':' then
    redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[3])
  end
end
return 1
`

// Activation and heartbeat refreshes are strict compare-and-refresh operations.
// They may extend only the exact lease value this process previously reserved;
// neither a missing lease nor a missing room-set membership is recreated. That
// is essential after expiry, eviction, or Redis restart: another replica may
// already have elected a new bootstrapper while this process retained stale
// local state.
const REFRESH_OWNED_LEASE_SCRIPT = `
-- SRN_REFRESH_OWNED_LEASE_V3
local current = redis.call('GET', KEYS[2])
if not current or current ~= ARGV[3] or redis.call('SISMEMBER', KEYS[1], KEYS[2]) == 0 then return -3 end
local currentState = redis.call('GET', KEYS[3])
if not currentState or string.sub(currentState, 1, string.len(ARGV[5])) ~= ARGV[5]
  or string.sub(currentState, string.len(ARGV[5]) + 1, string.len(ARGV[5]) + 1) ~= ':' then return -3 end
local members = redis.call('SMEMBERS', KEYS[1])
local active = 0
for _, leaseKey in ipairs(members) do
  if redis.call('EXISTS', leaseKey) == 0 then
    redis.call('SREM', KEYS[1], leaseKey)
  else
    local value = redis.call('GET', leaseKey)
    if string.sub(value or '', 1, 3) ~= string.sub(ARGV[3], 1, 3) then return -1 end
    active = active + 1
  end
end
if active > tonumber(ARGV[4]) then return -2 end
if redis.call('PEXPIRE', KEYS[2], ARGV[1]) ~= 1 then return -3 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[6])
return 1
`

// Counts room leases that are neither this process's own nor expired. Remote
// pending leases count as potential responders on purpose (they activate or
// expire within the 15 s reservation window), so the answer errs towards
// "someone may still answer" and the client keeps its bounded wait.
const COUNT_OTHER_LEASES_SCRIPT = `
-- SRN_COUNT_OTHER_LEASES_V1
local own = {}
for _, leaseKey in ipairs(ARGV) do own[leaseKey] = true end
local count = 0
for _, leaseKey in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  if not own[leaseKey] and redis.call('EXISTS', leaseKey) == 1 then count = count + 1 end
end
return count
`

const CLAIM_YJS_RESPONSE_SCRIPT = `
-- SRN_CLAIM_YJS_RESPONSE_V1
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] or redis.call('SISMEMBER', KEYS[2], KEYS[1]) == 0 then return -1 end
if redis.call('SET', KEYS[3], ARGV[2], 'NX', 'PX', ARGV[3]) then return 1 end
return 0
`

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isValidEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

export class CollaborationRoomSecurityRevokedError extends CollaborationRoomEpochMismatchError {
  override readonly code: CollaborationLifecycleErrorCode = 'security-revoked'
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(lifecycleError('redis-unavailable', 'Redis collaboration operation timed out')),
      REDIS_OPERATION_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) {clearTimeout(timer)}
  }
}

function parseRemoteFrame(raw: string, localInstanceId: string): RelayPayloadFrame | undefined {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RELAY_ENVELOPE_BYTES) {
    return undefined
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!envelope || typeof envelope !== 'object') {
    return undefined
  }
  const value = envelope as { v?: unknown; origin?: unknown; frame?: unknown }
  if (value.v !== 1 || typeof value.origin !== 'string' || value.origin === localInstanceId) {
    return undefined
  }
  if (!value.frame || typeof value.frame !== 'object') {
    return undefined
  }
  const candidate = value.frame as { t?: unknown; room?: unknown }
  if (candidate.t === 'room-presence') {
    const presence = value.frame as Partial<RoomPresenceFrame>
    if (
      typeof presence.room !== 'string' ||
      presence.room.length === 0 ||
      presence.room.length > 200 ||
      !isValidEpoch(presence.roomEpoch) ||
      presence.protocolVersion !== 3 ||
      typeof presence.presenceId !== 'string' ||
      presence.presenceId.length === 0 ||
      presence.presenceId.length > 128 ||
      typeof presence.userUuid !== 'string' ||
      presence.userUuid.length === 0 ||
      presence.userUuid.length > 128 ||
      !Number.isSafeInteger(presence.clientId) ||
      Number(presence.clientId) < 0 ||
      Number(presence.clientId) > 0xffff_ffff
    ) {
      return undefined
    }
    if (
      presence.action === 'joined' &&
      Number.isSafeInteger(presence.ttlMilliseconds) &&
      Number(presence.ttlMilliseconds) >= 30_000 &&
      Number(presence.ttlMilliseconds) <= 120_000
    ) {
      return presence as RoomPresenceFrame
    }
    if (
      presence.action === 'left' &&
      (presence.reason === 'clean-leave' ||
        presence.reason === 'disconnect' ||
        presence.reason === 'heartbeat-timeout' ||
        presence.reason === 'revoked')
    ) {
      return presence as RoomPresenceFrame
    }
    return undefined
  }
  if (candidate.t === 'room-sync') {
    return typeof candidate.room === 'string' && candidate.room.length > 0 && candidate.room.length <= 200
      ? { t: 'room-sync', room: candidate.room }
      : undefined
  }
  const parsed = parseRelayFrame(JSON.stringify(value.frame))
  return parsed &&
    (parsed.t === 'yjs' ||
      parsed.t === 'yjs-chunk' ||
      parsed.t === 'yjs-retry' ||
      parsed.t === 'awareness' ||
      parsed.t === 'comment')
    ? parsed
    : undefined
}

/**
 * Redis-backed collaboration plane for horizontally scaled gateways.
 *
 * Redis sees only room identifiers and the already E2E-encrypted relay frames.
 * A short-lived distributed editor lease elects exactly one Lexical bootstrapper
 * across replicas; local leases are refreshed by the gateway heartbeat and stale
 * process entries disappear automatically after LEASE_TTL_MS.
 */
export class CollaborationRedisBridge<S extends SendableSocket> implements RoomRelayLifecycle<S> {
  private readonly leases = new Map<string, LocalLease<S>>()
  private readonly presences = new Map<string, LocalPresence<S>>()
  private presenceExpiryTimer: ReturnType<typeof setTimeout> | undefined
  private relayHealthy = false
  private commandReady = false
  private subscriptionEstablished = false
  private subscriptionPending = false
  private subscriberGeneration = 0
  private readonly pendingLeaseReleases = new Map<string, LocalLease<S>>()
  private leaseCleanupInFlight: Promise<void> | undefined
  private leaseCleanupRetryTimer: ReturnType<typeof setTimeout> | undefined
  private leaseCleanupFailureCount = 0
  private stopping = false
  private readonly keyPrefix: string
  private readonly relayChannel: string

  constructor(
    private readonly rooms: RoomRegistry<S>,
    private readonly commands: RedisCommandClient,
    private readonly subscriber: RedisSubscriberClient,
    private readonly logger: Logger,
    private readonly instanceId = randomUUID(),
    options: { keyPrefix?: string } = {},
  ) {
    this.keyPrefix = collaborationKeyPrefix(options.keyPrefix)
    this.relayChannel = collaborationRelayChannel(options.keyPrefix)
    commands.on('error', (error) => {
      logger.error('[collab-redis] command connection error', safeErrorLogMetadata(error))
      this.handleCommandUnavailable()
    })
    commands.on('close', () => {
      logger.warn('[collab-redis] command connection closed; denying collaboration')
      this.handleCommandUnavailable()
    })
    commands.on('reconnecting', (delay) => {
      logger.warn(`[collab-redis] command connection reconnecting in ${delay}ms; denying collaboration`)
      this.handleCommandUnavailable()
    })
    commands.on('end', () => {
      logger.error('[collab-redis] command connection ended; denying collaboration')
      this.handleCommandUnavailable()
    })
    commands.on('ready', () => {
      if (this.stopping) {
        return
      }
      this.commandReady = true
      logger.info('[collab-redis] command connection ready')
      this.cancelLeaseCleanupRetry()
      this.startPendingLeaseCleanup()
      this.maybeEnableRelay()
    })
    // ioredis always exposes status. The undefined fallback preserves
    // compatibility with minimal injected clients that are already usable.
    this.commandReady = commands.status === 'ready' || commands.status === undefined

    subscriber.on('error', (error) => {
      logger.error('[collab-redis] connection error', safeErrorLogMetadata(error))
      this.handleSubscriberUnavailable()
    })
    subscriber.on('close', () => {
      logger.warn('[collab-redis] subscriber connection closed; denying collaboration')
      this.handleSubscriberUnavailable()
    })
    subscriber.on('reconnecting', (delay) => {
      logger.warn(`[collab-redis] subscriber reconnecting in ${delay}ms; denying collaboration`)
      this.handleSubscriberUnavailable()
    })
    subscriber.on('end', () => {
      logger.error('[collab-redis] subscriber connection ended; denying collaboration')
      this.handleSubscriberUnavailable()
    })
    subscriber.on('ready', () => {
      if (this.stopping) {
        return
      }
      logger.info('[collab-redis] subscriber connected; establishing relay subscription')
      this.subscribeForCurrentConnection()
    })
    subscriber.on('message', (channel, raw) => {
      if (!this.relayHealthy || channel !== this.relayChannel) {
        return
      }
      const frame = parseRemoteFrame(raw, this.instanceId)
      if (!frame) {
        return
      }
      this.rooms.broadcastAll(frame.room, JSON.stringify(frame))
    })
    // A production ioredis client is normally still connecting here and will
    // enter through the ready handler. Supporting an already-ready injected
    // client avoids waiting for an event that has already happened.
    if (subscriber.status === 'ready' || subscriber.status === undefined) {
      this.subscribeForCurrentConnection()
    }
  }

  /** Both Redis paths (commands + relay subscription) are usable right now (C9). */
  isRelayHealthy(): boolean {
    return this.relayHealthy
  }

  /**
   * The room's CURRENT epoch for one security generation (C4). Discovery on the
   * sync lane substitutes it for the deterministic initial epoch, so a room that
   * rotated when its last editor left can be re-entered with the one-use
   * challenge binding intact. Undefined when the room carries no state, when
   * the state belongs to another security epoch, or when Redis cannot answer
   * (callers then keep the initial epoch).
   */
  async currentRoomEpoch(room: string, collaborationSecurityEpoch: string): Promise<string | undefined> {
    if (typeof room !== 'string' || room.length === 0 || !isValidEpoch(collaborationSecurityEpoch)) {
      return undefined
    }
    let state: string | null
    try {
      state = await bounded(this.commands.get(this.roomStateKey(room)))
    } catch (error) {
      this.warnDenial('current-room-epoch', error)
      return undefined
    }
    if (typeof state !== 'string') {
      return undefined
    }
    const [epoch, securityEpoch] = state.split(':')
    return isValidEpoch(epoch) && securityEpoch === collaborationSecurityEpoch ? epoch : undefined
  }

  async hasOtherActivatedEditorLease(conn: Conn<S>, room: string): Promise<boolean> {
    const ownLeaseKeys: string[] = []
    for (const lease of this.leases.values()) {
      if (lease.room !== room) {
        continue
      }
      if (lease.conn !== conn && lease.activated) {
        return true
      }
      ownLeaseKeys.push(lease.leaseKey)
    }
    if (!this.relayHealthy) {
      return true
    }
    try {
      const count = Number(
        await bounded(this.commands.eval(COUNT_OTHER_LEASES_SCRIPT, 1, this.roomSetKey(room), ...ownLeaseKeys)),
      )
      return !Number.isSafeInteger(count) || count > 0
    } catch (error) {
      this.warnDenial('responder-lookup', error)
      return true
    }
  }

  async reserveEditorLease(
    conn: Conn<S>,
    room: string,
    requestId: string,
    expiresAt: number,
    protocolVersion: 3,
    serverUpdatedAtTimestamp: number,
    roomEpoch: string,
    collaborationSecurityEpoch: string,
    collaborationAuthorizationIssuedAt = Date.now(),
  ): Promise<{ shouldBootstrap: boolean; bootstrapChallenge?: string }> {
    if (!this.relayHealthy) {
      throw relayUnhealthyError()
    }
    const now = Date.now()
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      !Number.isSafeInteger(serverUpdatedAtTimestamp) ||
      serverUpdatedAtTimestamp < 0 ||
      !Number.isSafeInteger(collaborationAuthorizationIssuedAt) ||
      collaborationAuthorizationIssuedAt <= 0 ||
      !isValidEpoch(roomEpoch) ||
      !isValidEpoch(collaborationSecurityEpoch)
    ) {
      throw lifecycleError('reservation-expired', 'Collaboration reservation inputs are invalid or expired')
    }
    if ([...this.pendingLeaseReleases.values()].some((lease) => lease.room === room)) {
      throw lifecycleError('relay-unhealthy', 'Redis collaboration lease cleanup is pending for this room')
    }
    const localId = this.localLeaseId(conn, room, requestId)
    const existing = this.leases.get(localId)
    if (existing) {
      if (
        existing.protocolVersion !== protocolVersion ||
        existing.roomEpoch !== roomEpoch ||
        existing.collaborationSecurityEpoch !== collaborationSecurityEpoch
      ) {
        throw new CollaborationRoomEpochMismatchError(existing.roomEpoch)
      }
      // An active logical lease may replay room-reserve during reconnect churn.
      // Treat that exact replay as read-only: a provisional 15s deadline must
      // never shorten or extend the already-authorized active lease.
      if (existing.activated) {
        return {
          shouldBootstrap: existing.shouldBootstrap,
          ...(existing.bootstrapChallenge ? { bootstrapChallenge: existing.bootstrapChallenge } : {}),
        }
      }
      existing.expiresAt = Math.min(
        existing.expiresAt,
        expiresAt,
        now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
      )
      const replayTtl = Math.min(this.leaseTtl(existing.expiresAt), PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS)
      try {
        await this.refresh(existing, replayTtl)
        return {
          shouldBootstrap: existing.shouldBootstrap,
          ...(existing.bootstrapChallenge ? { bootstrapChallenge: existing.bootstrapChallenge } : {}),
        }
      } catch (rawError) {
        const error = asLifecycleError(rawError)
        this.warnDenial('lease-renewal', error)
        if (isLeasePolicyError(error)) {
          await this.denyAndReleaseRoom(room, roomDeniedReasonFor(error))
        } else {
          this.handleCommandUnavailable()
        }
        throw error
      }
    }

    const roomSetKey = this.roomSetKey(room)
    const roomStateKey = this.roomStateKey(room)
    const leaseKey = `${this.keyPrefix}${COLLABORATION_KEY_ROOT}lease:${digest(`${this.instanceId}\u0000${localId}`)}`
    const redisValue = `v${protocolVersion}:${digest(`${roomEpoch}\u0000${collaborationSecurityEpoch}`)}:${randomUUID()}`
    const roomStatePrefix = `${roomEpoch}:${collaborationSecurityEpoch}`
    const rotatedRoomStateValue = `${randomUUID()}:${collaborationSecurityEpoch}:${collaborationAuthorizationIssuedAt}`
    const reservationExpiresAt = Math.min(expiresAt, now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS)
    // Defend the bridge contract independently of its caller: a timed-out Redis
    // EVAL can complete after bounded() rejects, so an untracked reservation
    // must never survive for the normal active-lease TTL.
    const ttl = this.leaseTtl(reservationExpiresAt)
    try {
      const elected = await bounded(
        this.commands.eval(
          RESERVE_LEASE_SCRIPT,
          3,
          roomSetKey,
          leaseKey,
          roomStateKey,
          ttl,
          Math.max(LEASE_TTL_MS * 4, ttl * 2),
          redisValue,
          MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM,
          roomEpoch,
          collaborationSecurityEpoch,
          randomUUID(),
          ROOM_EPOCH_TOMBSTONE_TTL_MS,
          collaborationAuthorizationIssuedAt,
        ),
      )
      if (typeof elected === 'string' && elected.startsWith('epoch:')) {
        throw new CollaborationRoomEpochMismatchError(elected.slice('epoch:'.length))
      }
      if (typeof elected === 'string' && elected.startsWith('revoked:')) {
        throw new CollaborationRoomSecurityRevokedError(elected.slice('revoked:'.length))
      }
      const electionResult = Number(elected)
      if (electionResult === -1) {
        throw incompatibleProtocolError()
      }
      if (electionResult === -2) {
        throw roomLeaseLimitError()
      }
      if (electionResult !== 0 && electionResult !== 1) {
        throw lifecycleError('redis-unavailable', 'Redis returned an invalid collaboration lease result')
      }
      const shouldBootstrap = electionResult === 1
      const bootstrapChallenge = shouldBootstrap ? randomUUID() : undefined
      this.leases.set(localId, {
        conn,
        room,
        requestId,
        roomSetKey,
        roomStateKey,
        leaseKey,
        redisValue,
        roomStatePrefix,
        rotatedRoomStateValue,
        expiresAt: reservationExpiresAt,
        shouldBootstrap,
        ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
        protocolVersion,
        roomEpoch,
        collaborationSecurityEpoch,
        collaborationAuthorizationIssuedAt,
        reservedRevision: serverUpdatedAtTimestamp,
        activated: false,
      })
      return { shouldBootstrap, ...(bootstrapChallenge ? { bootstrapChallenge } : {}) }
    } catch (rawError) {
      const error = asLifecycleError(rawError)
      this.warnDenial('lease-reservation', error)
      if (error instanceof CollaborationRoomSecurityRevokedError) {
        await this.discardRevokedRoom(room)
      } else if (!isLeasePolicyError(error) && !(error instanceof CollaborationRoomEpochMismatchError)) {
        this.handleCommandUnavailable()
      }
      throw error
    }
  }

  async activateEditorLease(
    conn: Conn<S>,
    room: string,
    requestId: string,
    expiresAt: number,
    protocolVersion: 3,
    serverUpdatedAtTimestamp: number,
    bootstrapChallenge: string | undefined,
    roomEpoch: string,
    collaborationSecurityEpoch: string,
    collaborationAuthorizationIssuedAt = Date.now(),
  ): Promise<{ shouldBootstrap: boolean }> {
    if (!this.relayHealthy) {
      throw relayUnhealthyError()
    }
    const now = Date.now()
    const lease = this.leases.get(this.localLeaseId(conn, room, requestId))
    if (
      !lease ||
      lease.activated ||
      lease.expiresAt <= now ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      lease.protocolVersion !== protocolVersion ||
      lease.roomEpoch !== roomEpoch ||
      lease.collaborationSecurityEpoch !== collaborationSecurityEpoch ||
      !Number.isSafeInteger(serverUpdatedAtTimestamp) ||
      serverUpdatedAtTimestamp < lease.reservedRevision ||
      !Number.isSafeInteger(collaborationAuthorizationIssuedAt) ||
      collaborationAuthorizationIssuedAt < lease.collaborationAuthorizationIssuedAt
    ) {
      throw lifecycleError('reservation-expired', 'Collaboration reservation is missing or expired')
    }
    if (bootstrapChallenge !== lease.bootstrapChallenge) {
      throw lifecycleError('incompatible-protocol', 'Collaboration bootstrap challenge mismatch')
    }
    lease.expiresAt = expiresAt
    lease.collaborationAuthorizationIssuedAt = collaborationAuthorizationIssuedAt
    lease.reservedRevision = serverUpdatedAtTimestamp
    try {
      await this.refresh(lease, this.leaseTtl(expiresAt))
    } catch (rawError) {
      const error = asLifecycleError(rawError)
      this.warnDenial('lease-activation', error)
      if (isLeasePolicyError(error)) {
        await this.denyAndReleaseRoom(room, roomDeniedReasonFor(error))
      } else {
        this.handleCommandUnavailable()
      }
      throw error
    }
    lease.activated = true
    return { shouldBootstrap: lease.shouldBootstrap }
  }

  async heartbeatPresence(
    conn: Conn<S>,
    room: string,
    requestId: string,
    roomEpoch: string,
    clientId: number,
  ): Promise<void> {
    if (!this.relayHealthy) {
      throw relayUnhealthyError()
    }
    const localId = this.localLeaseId(conn, room, requestId)
    const lease = this.leases.get(localId)
    const now = Date.now()
    if (
      !lease?.activated ||
      lease.expiresAt <= now ||
      lease.roomEpoch !== roomEpoch ||
      !Number.isSafeInteger(clientId) ||
      clientId < 0 ||
      clientId > 0xffff_ffff
    ) {
      throw new CollaborationRoomEpochMismatchError(lease?.roomEpoch ?? roomEpoch)
    }

    const existing = this.presences.get(localId)
    if (existing) {
      if (existing.clientId !== clientId || existing.lease !== lease) {
        throw lifecycleError('incompatible-protocol', 'Collaboration presence identity changed during an active lease')
      }
      existing.expiresAt = now + COLLABORATION_PRESENCE_TTL_MS
      this.schedulePresenceExpiry()
      return
    }
    if (
      [...this.presences.values()].filter((presence) => presence.lease.room === room).length >=
      MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM
    ) {
      throw lifecycleError('room-limit', 'Collaboration room presence limit exceeded')
    }

    const presence: LocalPresence<S> = {
      lease,
      presenceId: randomUUID(),
      clientId,
      expiresAt: now + COLLABORATION_PRESENCE_TTL_MS,
    }
    this.presences.set(localId, presence)
    try {
      await this.emitPresence({
        t: 'room-presence',
        room,
        roomEpoch,
        protocolVersion: 3,
        action: 'joined',
        presenceId: presence.presenceId,
        userUuid: conn.userUuid,
        clientId,
        ttlMilliseconds: COLLABORATION_PRESENCE_TTL_MS,
      })
    } catch (error) {
      this.presences.delete(localId)
      throw error
    }
    this.schedulePresenceExpiry()
  }

  async releaseLease(
    conn: Conn<S>,
    room: string,
    requestId: string | undefined,
    reason: 'clean-leave' | 'disconnect' | 'heartbeat-timeout' | 'revoked' = 'disconnect',
  ): Promise<void> {
    const localId = this.localLeaseId(conn, room, requestId)
    const lease = this.leases.get(localId)
    if (!lease) {
      return
    }
    this.leases.delete(localId)
    await this.releasePresence(lease, reason)
    await this.releaseOrQueue(lease)
  }

  async claimYjsResponse(
    conn: Conn<S>,
    room: string,
    stateRequestId: string,
    leaseRequestId: string,
  ): Promise<number | undefined> {
    if (!this.relayHealthy) {
      throw relayUnhealthyError()
    }
    const localId = this.localLeaseId(conn, room, leaseRequestId)
    const lease = this.leases.get(localId)
    if (!lease || !lease.activated) {
      return undefined
    }
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(localId)
      await this.releaseOrQueue(lease)
      return undefined
    }
    const claimKey = `${this.keyPrefix}${COLLABORATION_KEY_ROOT}yjs-response-claim:${digest(room)}:${digest(stateRequestId)}`
    // Capture before Redis EVAL so the gateway-local permission is never valid
    // beyond the distributed NX claim created during that operation.
    const claimExpiresAt = Date.now() + YJS_RESPONSE_CLAIM_TTL_MS
    try {
      const result = Number(
        await bounded(
          this.commands.eval(
            CLAIM_YJS_RESPONSE_SCRIPT,
            3,
            lease.leaseKey,
            lease.roomSetKey,
            claimKey,
            lease.redisValue,
            digest(lease.leaseKey),
            YJS_RESPONSE_CLAIM_TTL_MS,
          ),
        ),
      )
      if (result === -1) {
        await this.denyAndReleaseRoom(room, 'reservation-expired')
        return undefined
      }
      if (result !== 0 && result !== 1) {
        throw lifecycleError('redis-unavailable', 'Redis returned an invalid Yjs response claim result')
      }
      return result === 1 ? claimExpiresAt : undefined
    } catch (rawError) {
      const error = asLifecycleError(rawError)
      this.warnDenial('yjs-response-claim', error)
      this.handleCommandUnavailable()
      throw error
    }
  }

  async releaseAll(conn: Conn<S>): Promise<void> {
    const owned = [...this.leases.entries()].filter(([, lease]) => lease.conn === conn)
    for (const [localId, lease] of owned) {
      this.leases.delete(localId)
      await this.releasePresence(lease, 'disconnect')
      await this.releaseOrQueue(lease)
    }
  }

  async refreshLeases(): Promise<void> {
    const now = Date.now()
    let refreshFailed = false
    const policyFailureRooms = new Map<string, RoomDeniedReason>()
    await Promise.all(
      [...this.leases.entries()].map(async ([localId, lease]) => {
        if (Number.isFinite(lease.expiresAt) && lease.expiresAt <= now) {
          this.leases.delete(localId)
          await this.releasePresence(lease, 'revoked')
          await this.releaseOrQueue(lease)
          return
        }
        try {
          await this.refresh(lease, this.leaseTtl(lease.expiresAt))
        } catch (rawError) {
          const error = asLifecycleError(rawError)
          if (isLeasePolicyError(error)) {
            policyFailureRooms.set(lease.room, roomDeniedReasonFor(error))
          } else {
            refreshFailed = true
          }
          this.warnDenial('lease-refresh', error)
        }
      }),
    )
    await Promise.all([...policyFailureRooms].map(([room, reason]) => this.denyAndReleaseRoom(room, reason)))
    if (refreshFailed) {
      this.handleCommandUnavailable()
    }
  }

  async publish(frame: RelayPayloadFrame): Promise<void> {
    if (!this.relayHealthy) {
      throw relayUnhealthyError()
    }
    const message = JSON.stringify({ v: 1, origin: this.instanceId, frame })
    let missingSubscribers = false
    try {
      const subscriberCount = await bounded(this.commands.publish(this.relayChannel, message))
      if (!Number.isFinite(subscriberCount) || subscriberCount < 1) {
        missingSubscribers = true
        throw lifecycleError('relay-unhealthy', 'Redis collaboration relay has no subscribers')
      }
    } catch (rawError) {
      const error = asLifecycleError(rawError)
      this.warnDenial('frame-publish', error)
      if (missingSubscribers) {
        this.handleSubscriberUnavailable()
        if (this.subscriber.status === 'ready') {
          this.subscribeForCurrentConnection()
        }
      } else {
        this.handleCommandUnavailable()
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.presenceExpiryTimer) {
      clearTimeout(this.presenceExpiryTimer)
      this.presenceExpiryTimer = undefined
    }
    await Promise.all(
      [...this.presences.values()].map((presence) => this.releasePresence(presence.lease, 'disconnect')),
    )
    this.subscriberGeneration += 1
    this.subscriptionPending = false
    this.subscriptionEstablished = false
    this.commandReady = false
    this.relayHealthy = false
    this.rooms.denyAllRooms('relay-unhealthy')
    this.cancelLeaseCleanupRetry()
    if (this.leaseCleanupInFlight) {
      await this.leaseCleanupInFlight
    }
    const pendingReleases = new Map(this.pendingLeaseReleases)
    for (const lease of this.leases.values()) {
      pendingReleases.set(lease.leaseKey, lease)
    }
    this.pendingLeaseReleases.clear()
    this.leases.clear()
    await Promise.allSettled([...pendingReleases.values()].map((lease) => this.release(lease)))
    await Promise.all([this.closeClient(this.commands), this.closeClient(this.subscriber)])
  }

  /**
   * One constant line per operation plus the closed-enum cause code, in the
   * message (for hosts that flatten metadata) and in the metadata (for hosts
   * that keep it); the error itself contributes only its redacted classification.
   */
  private warnDenial(operation: DenialOperation, error: unknown): void {
    const cause = causeCodeOf(error)
    this.logger.warn(`${WARN_LINES[operation]} ${JSON.stringify({ cause })}`, { ...safeErrorLogMetadata(error), cause })
  }

  private localLeaseId(conn: Conn<S>, room: string, requestId: string | undefined): string {
    return `${conn.userUuid}\u0000${conn.connectionId}\u0000${room}\u0000${requestId ?? 'legacy'}`
  }

  private roomSetKey(room: string): string {
    return `${this.keyPrefix}${COLLABORATION_KEY_ROOT}room:${digest(room)}`
  }

  private roomStateKey(room: string): string {
    return `${this.keyPrefix}${COLLABORATION_KEY_ROOT}room-state:${digest(room)}`
  }

  private markRelayUnhealthy(): void {
    this.relayHealthy = false
    this.rooms.denyAllRooms('relay-unhealthy')
    this.presences.clear()
    if (this.presenceExpiryTimer) {
      clearTimeout(this.presenceExpiryTimer)
      this.presenceExpiryTimer = undefined
    }
    const leases = [...this.leases.values()]
    this.leases.clear()
    for (const lease of leases) {
      this.pendingLeaseReleases.set(lease.leaseKey, lease)
    }
    this.startPendingLeaseCleanup()
  }

  private handleCommandUnavailable(): void {
    this.commandReady = false
    this.cancelLeaseCleanupRetry()
    this.markRelayUnhealthy()
  }

  private handleSubscriberUnavailable(): void {
    this.subscriberGeneration += 1
    this.subscriptionPending = false
    this.subscriptionEstablished = false
    this.markRelayUnhealthy()
  }

  private subscribeForCurrentConnection(): void {
    if (this.stopping || this.subscriptionPending || this.subscriptionEstablished) {
      return
    }

    const generation = this.subscriberGeneration
    this.subscriptionPending = true
    let settled = false
    const finish = (error: Error | null | undefined, count?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      if (this.stopping || generation !== this.subscriberGeneration) {
        return
      }
      this.subscriptionPending = false
      if (error || typeof count !== 'number' || !Number.isFinite(count) || count < 1) {
        this.subscriptionEstablished = false
        this.markRelayUnhealthy()
        this.logger.error(
          '[collab-redis] subscribe failed',
          safeErrorLogMetadata(error ?? new Error('Redis reported no active collaboration subscription')),
        )
        return
      }
      this.subscriptionEstablished = true
      this.logger.info(`[collab-redis] subscribed (${count} channels)`)
      this.maybeEnableRelay()
    }

    try {
      const result = this.subscriber.subscribe(this.relayChannel, finish)
      if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        void Promise.resolve(result).then(
          (count) => finish(undefined, count),
          (error: unknown) => finish(error instanceof Error ? error : new Error('Redis subscribe failed')),
        )
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Redis subscribe failed'))
    }
  }

  private maybeEnableRelay(): void {
    if (
      this.stopping ||
      this.relayHealthy ||
      !this.commandReady ||
      !this.subscriptionEstablished ||
      this.pendingLeaseReleases.size > 0 ||
      this.leaseCleanupInFlight
    ) {
      return
    }
    this.relayHealthy = true
    this.logger.info('[collab-redis] command and subscriber relay paths are healthy')
  }

  private startPendingLeaseCleanup(): void {
    if (!this.commandReady || this.leaseCleanupInFlight || this.pendingLeaseReleases.size === 0) {
      return
    }
    const batch = [...this.pendingLeaseReleases.entries()]
    const cleanup: Promise<void> = Promise.all(
      batch.map(async ([leaseKey, lease]) => {
        const released = await this.release(lease)
        if (released && this.pendingLeaseReleases.get(leaseKey) === lease) {
          this.pendingLeaseReleases.delete(leaseKey)
        }
        return released
      }),
    ).then((results) => {
      if (this.leaseCleanupInFlight === cleanup) {
        this.leaseCleanupInFlight = undefined
      }
      if (results.some((released) => !released)) {
        // Keep the relay closed and retry with capped backoff. Connection
        // lifecycle loss cancels this timer; the next ready event retries
        // immediately instead.
        this.schedulePendingLeaseCleanupRetry()
      } else if (this.pendingLeaseReleases.size > 0) {
        this.cancelLeaseCleanupRetry()
        this.leaseCleanupFailureCount = 0
        this.startPendingLeaseCleanup()
      } else {
        this.cancelLeaseCleanupRetry()
        this.leaseCleanupFailureCount = 0
      }
      this.maybeEnableRelay()
    })
    this.leaseCleanupInFlight = cleanup
  }

  private schedulePendingLeaseCleanupRetry(): void {
    if (this.stopping || !this.commandReady || this.leaseCleanupRetryTimer || this.pendingLeaseReleases.size === 0) {
      return
    }
    const delay = Math.min(
      LEASE_CLEANUP_RETRY_BASE_MS * 2 ** Math.min(this.leaseCleanupFailureCount, 6),
      LEASE_CLEANUP_RETRY_MAX_MS,
    )
    this.leaseCleanupFailureCount += 1
    this.leaseCleanupRetryTimer = setTimeout(() => {
      this.leaseCleanupRetryTimer = undefined
      this.startPendingLeaseCleanup()
    }, delay)
  }

  private cancelLeaseCleanupRetry(): void {
    if (this.leaseCleanupRetryTimer) {
      clearTimeout(this.leaseCleanupRetryTimer)
      this.leaseCleanupRetryTimer = undefined
    }
  }

  private leaseTtl(expiresAt: number): number {
    if (!Number.isFinite(expiresAt)) {
      return LEASE_TTL_MS
    }
    return Math.max(1, Math.min(LEASE_TTL_MS, expiresAt - Date.now()))
  }

  private async release(lease: LocalLease<S>): Promise<boolean> {
    try {
      await bounded(
        this.commands.eval(
          RELEASE_LEASE_SCRIPT,
          3,
          lease.roomSetKey,
          lease.leaseKey,
          lease.roomStateKey,
          lease.rotatedRoomStateValue,
          lease.roomStatePrefix,
          ROOM_EPOCH_TOMBSTONE_TTL_MS,
        ),
      )
      return true
    } catch (error) {
      // The lease key has a short TTL, so a failed cleanup cannot strand a room.
      this.warnDenial('lease-cleanup', error)
      return false
    }
  }

  private async releaseOrQueue(lease: LocalLease<S>): Promise<void> {
    if (await this.release(lease)) {
      return
    }
    this.pendingLeaseReleases.set(lease.leaseKey, lease)
    this.schedulePendingLeaseCleanupRetry()
  }

  private async denyAndReleaseRoom(room: string, reason: RoomDeniedReason = 'policy'): Promise<void> {
    this.rooms.denyRoom(room, reason)
    const owned = [...this.leases.entries()].filter(([, lease]) => lease.room === room)
    await Promise.all(
      owned.map(async ([localId, lease]) => {
        this.leases.delete(localId)
        await this.releasePresence(lease, 'revoked')
        await this.releaseOrQueue(lease)
      }),
    )
  }

  private async discardRevokedRoom(room: string): Promise<void> {
    this.rooms.denyRoom(room, 'security-revoked')
    const releases: Promise<void>[] = []
    for (const [localId, lease] of this.leases) {
      if (lease.room === room) {
        this.leases.delete(localId)
        releases.push(this.releasePresence(lease, 'revoked'))
      }
    }
    await Promise.all(releases)
  }

  private async releasePresence(
    lease: LocalLease<S>,
    reason: 'clean-leave' | 'disconnect' | 'heartbeat-timeout' | 'revoked',
  ): Promise<void> {
    const localId = this.localLeaseId(lease.conn, lease.room, lease.requestId)
    const presence = this.presences.get(localId)
    if (!presence) {
      return
    }
    // Delete before I/O so clean leave, socket cleanup, revocation and the TTL
    // reaper can race without ever emitting more than one terminal event.
    this.presences.delete(localId)
    this.schedulePresenceExpiry()
    const frame: RoomPresenceFrame = {
      t: 'room-presence',
      room: lease.room,
      roomEpoch: lease.roomEpoch,
      protocolVersion: 3,
      action: 'left',
      presenceId: presence.presenceId,
      userUuid: lease.conn.userUuid,
      clientId: presence.clientId,
      reason,
    }
    try {
      await this.emitPresence(frame)
    } catch {
      // Membership is already terminal locally. Relay failure independently
      // denies rooms and clients expire the prior joined event by its short TTL.
    }
  }

  private async emitPresence(frame: RoomPresenceFrame): Promise<void> {
    await this.publish(frame)
    this.rooms.broadcastAll(frame.room, JSON.stringify(frame))
  }

  private schedulePresenceExpiry(): void {
    if (this.presenceExpiryTimer) {
      clearTimeout(this.presenceExpiryTimer)
      this.presenceExpiryTimer = undefined
    }
    if (this.stopping || this.presences.size === 0) {
      return
    }
    const nextExpiry = Math.min(...[...this.presences.values()].map((presence) => presence.expiresAt))
    this.presenceExpiryTimer = setTimeout(
      () => {
        this.presenceExpiryTimer = undefined
        void this.expirePresence()
      },
      Math.max(0, nextExpiry - Date.now()),
    )
  }

  private async expirePresence(): Promise<void> {
    const now = Date.now()
    const expired = [...this.presences.values()].filter((presence) => presence.expiresAt <= now)
    await Promise.all(expired.map((presence) => this.releasePresence(presence.lease, 'heartbeat-timeout')))
    this.schedulePresenceExpiry()
  }

  private async refresh(lease: LocalLease<S>, ttl: number): Promise<void> {
    // Never recreate a missing key/set entry here. A Redis restart or eviction
    // loses the distributed election state, so preserving a stale local
    // shouldBootstrap decision would permit multiple bootstrappers.
    const result = Number(
      await bounded(
        this.commands.eval(
          REFRESH_OWNED_LEASE_SCRIPT,
          3,
          lease.roomSetKey,
          lease.leaseKey,
          lease.roomStateKey,
          ttl,
          LEASE_TTL_MS * 4,
          lease.redisValue,
          MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM,
          lease.roomStatePrefix,
          ROOM_EPOCH_TOMBSTONE_TTL_MS,
        ),
      ),
    )
    if (result === -1) {
      throw incompatibleProtocolError()
    }
    if (result === -2) {
      throw roomLeaseLimitError()
    }
    if (result === -3) {
      throw leaseOwnershipLostError()
    }
    if (result !== 1) {
      throw lifecycleError('redis-unavailable', 'Redis returned an invalid collaboration lease refresh result')
    }
  }

  private async closeClient(client: { quit(): Promise<unknown>; disconnect(): void }): Promise<void> {
    try {
      await bounded(client.quit())
    } catch {
      client.disconnect()
    }
  }
}

export function startCollaborationRedisBridge<S extends SendableSocket>(
  rooms: RoomRegistry<S>,
  opts: { host: string; port: number; logger: Logger; keyPrefix?: string },
): CollaborationRedisBridge<S> {
  const baseRedisOptions = {
    host: opts.host,
    port: opts.port,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  }
  // Never queue edit frames without bound while Redis is unavailable. Pub/sub
  // reconnects continuously, while command operations fail quickly and every
  // active collaboration room is denied until distributed relay health returns.
  const commands = new Redis({ ...baseRedisOptions, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  const subscriber = new Redis({
    ...baseRedisOptions,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    autoResubscribe: false,
  })
  return new CollaborationRedisBridge(rooms, commands, subscriber, opts.logger, randomUUID(), {
    ...(opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : {}),
  })
}
