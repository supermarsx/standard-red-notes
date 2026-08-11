import { createHash, randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'

import type { Conn, SendableSocket } from './registry.js'
import {
  parseRelayFrame,
  PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
  type RelayFrame,
  type RoomRegistry,
  type RoomRelayLifecycle,
} from './rooms.js'
import type { Logger } from './redisBridge.js'
import { safeErrorLogMetadata } from './safeLog.js'

export const COLLABORATION_RELAY_CHANNEL = 'srn-collaboration-relay-v1'
const LEASE_TTL_MS = 75_000
const REDIS_OPERATION_TIMEOUT_MS = 1_500
const MAX_RELAY_ENVELOPE_BYTES = 700 * 1024
const LEASE_CLEANUP_RETRY_BASE_MS = 100
const LEASE_CLEANUP_RETRY_MAX_MS = 5_000
export const MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM = 64
// Longer than the client's full-state response/acceptance window. A retry uses
// a new stateRequestId, so liveness does not require re-granting the same id
// while a 4 MiB winner may still be encrypting and chunking its response.
export const YJS_RESPONSE_CLAIM_TTL_MS = 15_000
const INCOMPATIBLE_PROTOCOL_ERROR = 'Incompatible collaboration protocol is active in this room'
const ROOM_LEASE_LIMIT_ERROR = 'Collaboration room editor lease limit exceeded'
const LEASE_OWNERSHIP_LOST_ERROR = 'Collaboration lease ownership was lost'

function isLeasePolicyError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === INCOMPATIBLE_PROTOCOL_ERROR ||
      error.message === ROOM_LEASE_LIMIT_ERROR ||
      error.message === LEASE_OWNERSHIP_LOST_ERROR)
  )
}

type RelayPayloadFrame =
  | Extract<RelayFrame, { t: 'yjs' | 'yjs-chunk' | 'yjs-retry' | 'awareness' | 'comment' }>
  | {
      t: 'room-sync'
      room: string
    }

interface RedisCommandClient {
  readonly status: string
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
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
  leaseKey: string
  redisValue: string
  expiresAt: number
  shouldBootstrap: boolean
  bootstrapChallenge?: string
  protocolVersion: 2
  reservedRevision: number
  activated: boolean
}

const RESERVE_LEASE_SCRIPT = `
-- SRN_RESERVE_LEASE_V1
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
if active >= tonumber(ARGV[4]) and not alreadyReserved then return -2 end
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[1])
redis.call('SADD', KEYS[1], KEYS[2])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if active == 0 then return 1 else return 0 end
`

const RELEASE_LEASE_SCRIPT = `
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[1], KEYS[2])
if redis.call('SCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return 1
`

// Activation and heartbeat refreshes are strict compare-and-refresh operations.
// They may extend only the exact lease value this process previously reserved;
// neither a missing lease nor a missing room-set membership is recreated. That
// is essential after expiry, eviction, or Redis restart: another replica may
// already have elected a new bootstrapper while this process retained stale
// local state.
const REFRESH_OWNED_LEASE_SCRIPT = `
-- SRN_REFRESH_OWNED_LEASE_V1
local current = redis.call('GET', KEYS[2])
if not current or current ~= ARGV[3] or redis.call('SISMEMBER', KEYS[1], KEYS[2]) == 0 then return -3 end
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
return 1
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

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis collaboration operation timed out')), REDIS_OPERATION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
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

  constructor(
    private readonly rooms: RoomRegistry<S>,
    private readonly commands: RedisCommandClient,
    private readonly subscriber: RedisSubscriberClient,
    private readonly logger: Logger,
    private readonly instanceId = randomUUID(),
  ) {
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
      if (!this.relayHealthy || channel !== COLLABORATION_RELAY_CHANNEL) {
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

  async reserveEditorLease(
    conn: Conn<S>,
    room: string,
    requestId: string,
    expiresAt: number,
    protocolVersion: 2,
    serverUpdatedAtTimestamp: number,
  ): Promise<{ shouldBootstrap: boolean; bootstrapChallenge?: string }> {
    if (!this.relayHealthy) {
      throw new Error('Redis collaboration relay is not healthy')
    }
    const now = Date.now()
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      !Number.isSafeInteger(serverUpdatedAtTimestamp) ||
      serverUpdatedAtTimestamp < 0
    ) {
      throw new Error('Collaboration reservation inputs are invalid or expired')
    }
    if ([...this.pendingLeaseReleases.values()].some((lease) => lease.room === room)) {
      throw new Error('Redis collaboration lease cleanup is pending for this room')
    }
    const localId = this.localLeaseId(conn, room, requestId)
    const existing = this.leases.get(localId)
    if (existing) {
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
      } catch (error) {
        this.logger.warn('[collab-redis] lease renewal unavailable; denying collaboration', safeErrorLogMetadata(error))
        if (isLeasePolicyError(error)) {
          await this.denyAndReleaseRoom(room)
        } else {
          this.handleCommandUnavailable()
        }
        throw error
      }
    }

    const roomSetKey = `srn:collaboration:room:${digest(room)}`
    const leaseKey = `srn:collaboration:lease:${digest(`${this.instanceId}\u0000${localId}`)}`
    const redisValue = `v${protocolVersion}:${digest(conn.userUuid)}:${randomUUID()}`
    const reservationExpiresAt = Math.min(expiresAt, now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS)
    // Defend the bridge contract independently of its caller: a timed-out Redis
    // EVAL can complete after bounded() rejects, so an untracked reservation
    // must never survive for the normal active-lease TTL.
    const ttl = this.leaseTtl(reservationExpiresAt)
    try {
      const elected = await bounded(
        this.commands.eval(
          RESERVE_LEASE_SCRIPT,
          2,
          roomSetKey,
          leaseKey,
          ttl,
          Math.max(LEASE_TTL_MS * 4, ttl * 2),
          redisValue,
          MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM,
        ),
      )
      const electionResult = Number(elected)
      if (electionResult === -1) {
        throw new Error(INCOMPATIBLE_PROTOCOL_ERROR)
      }
      if (electionResult === -2) {
        throw new Error(ROOM_LEASE_LIMIT_ERROR)
      }
      if (electionResult !== 0 && electionResult !== 1) {
        throw new Error('Redis returned an invalid collaboration lease result')
      }
      const shouldBootstrap = electionResult === 1
      const bootstrapChallenge = shouldBootstrap ? randomUUID() : undefined
      this.leases.set(localId, {
        conn,
        room,
        requestId,
        roomSetKey,
        leaseKey,
        redisValue,
        expiresAt: reservationExpiresAt,
        shouldBootstrap,
        ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
        protocolVersion,
        reservedRevision: serverUpdatedAtTimestamp,
        activated: false,
      })
      return { shouldBootstrap, ...(bootstrapChallenge ? { bootstrapChallenge } : {}) }
    } catch (error) {
      this.logger.warn(
        '[collab-redis] lease reservation unavailable; denying collaboration',
        safeErrorLogMetadata(error),
      )
      if (!isLeasePolicyError(error)) {
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
    protocolVersion: 2,
    serverUpdatedAtTimestamp: number,
    bootstrapChallenge?: string,
  ): Promise<{ shouldBootstrap: boolean }> {
    if (!this.relayHealthy) {
      throw new Error('Redis collaboration relay is not healthy')
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
      !Number.isSafeInteger(serverUpdatedAtTimestamp) ||
      serverUpdatedAtTimestamp < lease.reservedRevision
    ) {
      throw new Error('Collaboration reservation is missing or expired')
    }
    if (bootstrapChallenge !== lease.bootstrapChallenge) {
      throw new Error('Collaboration bootstrap challenge mismatch')
    }
    lease.expiresAt = expiresAt
    lease.reservedRevision = serverUpdatedAtTimestamp
    try {
      await this.refresh(lease, this.leaseTtl(expiresAt))
    } catch (error) {
      if (isLeasePolicyError(error)) {
        await this.denyAndReleaseRoom(room)
      } else {
        this.handleCommandUnavailable()
      }
      throw error
    }
    lease.activated = true
    return { shouldBootstrap: lease.shouldBootstrap }
  }

  async releaseLease(conn: Conn<S>, room: string, requestId: string | undefined): Promise<void> {
    const localId = this.localLeaseId(conn, room, requestId)
    const lease = this.leases.get(localId)
    if (!lease) {
      return
    }
    this.leases.delete(localId)
    await this.releaseOrQueue(lease)
  }

  async claimYjsResponse(
    conn: Conn<S>,
    room: string,
    stateRequestId: string,
    leaseRequestId: string,
  ): Promise<number | undefined> {
    if (!this.relayHealthy) {
      throw new Error('Redis collaboration relay is not healthy')
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
    const claimKey = `srn:collaboration:yjs-response-claim:${digest(room)}:${digest(stateRequestId)}`
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
        await this.denyAndReleaseRoom(room)
        return undefined
      }
      if (result !== 0 && result !== 1) {
        throw new Error('Redis returned an invalid Yjs response claim result')
      }
      return result === 1 ? claimExpiresAt : undefined
    } catch (error) {
      this.logger.warn(
        '[collab-redis] Yjs response claim unavailable; denying collaboration',
        safeErrorLogMetadata(error),
      )
      this.handleCommandUnavailable()
      throw error
    }
  }

  async releaseAll(conn: Conn<S>): Promise<void> {
    const owned = [...this.leases.entries()].filter(([, lease]) => lease.conn === conn)
    for (const [localId, lease] of owned) {
      this.leases.delete(localId)
      await this.releaseOrQueue(lease)
    }
  }

  async refreshLeases(): Promise<void> {
    const now = Date.now()
    let refreshFailed = false
    const policyFailureRooms = new Set<string>()
    await Promise.all(
      [...this.leases.entries()].map(async ([localId, lease]) => {
        if (Number.isFinite(lease.expiresAt) && lease.expiresAt <= now) {
          this.leases.delete(localId)
          await this.releaseOrQueue(lease)
          return
        }
        try {
          await this.refresh(lease, this.leaseTtl(lease.expiresAt))
        } catch (error) {
          if (isLeasePolicyError(error)) {
            policyFailureRooms.add(lease.room)
          } else {
            refreshFailed = true
          }
          this.logger.warn('[collab-redis] lease refresh failed', safeErrorLogMetadata(error))
        }
      }),
    )
    await Promise.all([...policyFailureRooms].map((room) => this.denyAndReleaseRoom(room)))
    if (refreshFailed) {
      this.handleCommandUnavailable()
    }
  }

  async publish(frame: RelayPayloadFrame): Promise<void> {
    if (!this.relayHealthy) {
      throw new Error('Redis collaboration relay is not healthy')
    }
    const message = JSON.stringify({ v: 1, origin: this.instanceId, frame })
    let missingSubscribers = false
    try {
      const subscriberCount = await bounded(this.commands.publish(COLLABORATION_RELAY_CHANNEL, message))
      if (!Number.isFinite(subscriberCount) || subscriberCount < 1) {
        missingSubscribers = true
        throw new Error('Redis collaboration relay has no subscribers')
      }
    } catch (error) {
      this.logger.warn('[collab-redis] encrypted frame publish failed', safeErrorLogMetadata(error))
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
    this.subscriberGeneration += 1
    this.subscriptionPending = false
    this.subscriptionEstablished = false
    this.commandReady = false
    this.relayHealthy = false
    this.rooms.denyAllRooms()
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

  private localLeaseId(conn: Conn<S>, room: string, requestId: string | undefined): string {
    return `${conn.userUuid}\u0000${conn.connectionId}\u0000${room}\u0000${requestId ?? 'legacy'}`
  }

  private markRelayUnhealthy(): void {
    this.relayHealthy = false
    this.rooms.denyAllRooms()
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
      const result = this.subscriber.subscribe(COLLABORATION_RELAY_CHANNEL, finish)
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
    let cleanup: Promise<void>
    cleanup = Promise.all(
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
      await bounded(this.commands.eval(RELEASE_LEASE_SCRIPT, 2, lease.roomSetKey, lease.leaseKey))
      return true
    } catch (error) {
      // The lease key has a short TTL, so a failed cleanup cannot strand a room.
      this.logger.warn('[collab-redis] lease cleanup failed', safeErrorLogMetadata(error))
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

  private async denyAndReleaseRoom(room: string): Promise<void> {
    this.rooms.denyRoom(room)
    const owned = [...this.leases.entries()].filter(([, lease]) => lease.room === room)
    await Promise.all(
      owned.map(async ([localId, lease]) => {
        this.leases.delete(localId)
        await this.releaseOrQueue(lease)
      }),
    )
  }

  private async refresh(lease: LocalLease<S>, ttl: number): Promise<void> {
    // Never recreate a missing key/set entry here. A Redis restart or eviction
    // loses the distributed election state, so preserving a stale local
    // shouldBootstrap decision would permit multiple bootstrappers.
    const result = Number(
      await bounded(
        this.commands.eval(
          REFRESH_OWNED_LEASE_SCRIPT,
          2,
          lease.roomSetKey,
          lease.leaseKey,
          ttl,
          LEASE_TTL_MS * 4,
          lease.redisValue,
          MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM,
        ),
      ),
    )
    if (result === -1) {
      throw new Error(INCOMPATIBLE_PROTOCOL_ERROR)
    }
    if (result === -2) {
      throw new Error(ROOM_LEASE_LIMIT_ERROR)
    }
    if (result === -3) {
      throw new Error(LEASE_OWNERSHIP_LOST_ERROR)
    }
    if (result !== 1) {
      throw new Error('Redis returned an invalid collaboration lease refresh result')
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
  opts: { host: string; port: number; logger: Logger },
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
  return new CollaborationRedisBridge(rooms, commands, subscriber, opts.logger)
}
