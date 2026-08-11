import { createHash, randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'

import type { Conn, SendableSocket } from './registry.js'
import { parseRelayFrame, type RelayFrame, type RoomRegistry, type RoomRelayLifecycle } from './rooms.js'
import type { Logger } from './redisBridge.js'
import { safeErrorLogMetadata } from './safeLog.js'

export const COLLABORATION_RELAY_CHANNEL = 'srn-collaboration-relay-v1'
const LEASE_TTL_MS = 75_000
const REDIS_OPERATION_TIMEOUT_MS = 1_500
const MAX_RELAY_ENVELOPE_BYTES = 700 * 1024

type RelayPayloadFrame =
  | Extract<RelayFrame, { t: 'yjs' | 'awareness' | 'comment' }>
  | {
      t: 'room-sync'
      room: string
    }

interface RedisCommandClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
  publish(channel: string, message: string): Promise<number>
  quit(): Promise<unknown>
  disconnect(): void
}

interface RedisSubscriberClient {
  subscribe(channel: string, callback: (error: Error | null | undefined, count?: unknown) => void): unknown
  on(event: 'message', callback: (channel: string, message: string) => void): unknown
  on(event: 'error', callback: (error: Error) => void): unknown
  on(event: 'ready', callback: () => void): unknown
  quit(): Promise<unknown>
  disconnect(): void
}

type LocalLease<S extends SendableSocket> = {
  conn: Conn<S>
  room: string
  requestId: string | undefined
  roomSetKey: string
  leaseKey: string
  expiresAt: number
  shouldBootstrap: boolean
}

const RESERVE_LEASE_SCRIPT = `
local members = redis.call('SMEMBERS', KEYS[1])
local active = 0
for _, leaseKey in ipairs(members) do
  if redis.call('EXISTS', leaseKey) == 0 then
    redis.call('SREM', KEYS[1], leaseKey)
  else
    active = active + 1
  end
end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
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

const REFRESH_LEASE_SCRIPT = `
redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
redis.call('SADD', KEYS[1], KEYS[2])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
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
  return parsed && (parsed.t === 'yjs' || parsed.t === 'awareness' || parsed.t === 'comment') ? parsed : undefined
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

  constructor(
    private readonly rooms: RoomRegistry<S>,
    private readonly commands: RedisCommandClient,
    private readonly subscriber: RedisSubscriberClient,
    private readonly logger: Logger,
    private readonly instanceId = randomUUID(),
  ) {
    subscriber.on('error', (error) => {
      logger.error('[collab-redis] connection error', safeErrorLogMetadata(error))
    })
    subscriber.on('ready', () => {
      logger.info('[collab-redis] subscriber connected')
    })
    subscriber.subscribe(COLLABORATION_RELAY_CHANNEL, (error, count) => {
      if (error) {
        logger.error('[collab-redis] subscribe failed', safeErrorLogMetadata(error))
      } else {
        logger.info(`[collab-redis] subscribed (${typeof count === 'number' ? count : 0} channels)`)
      }
    })
    subscriber.on('message', (channel, raw) => {
      if (channel !== COLLABORATION_RELAY_CHANNEL) {
        return
      }
      const frame = parseRemoteFrame(raw, this.instanceId)
      if (!frame) {
        return
      }
      this.rooms.broadcastAll(frame.room, JSON.stringify(frame))
    })
  }

  async reserveEditorLease(
    conn: Conn<S>,
    room: string,
    requestId: string | undefined,
    expiresAt: number,
  ): Promise<{ shouldBootstrap?: boolean }> {
    const localId = this.localLeaseId(conn, room, requestId)
    const existing = this.leases.get(localId)
    const ttl = this.leaseTtl(expiresAt)
    if (existing) {
      existing.expiresAt = expiresAt
      try {
        await this.refresh(existing, ttl)
        return { shouldBootstrap: existing.shouldBootstrap }
      } catch (error) {
        this.logger.warn(
          '[collab-redis] lease renewal unavailable; preserving local election',
          safeErrorLogMetadata(error),
        )
        return { shouldBootstrap: undefined }
      }
    }

    const roomSetKey = `srn:collaboration:room:${digest(room)}`
    const leaseKey = `srn:collaboration:lease:${digest(`${this.instanceId}\u0000${localId}`)}`
    try {
      const elected = await bounded(
        this.commands.eval(RESERVE_LEASE_SCRIPT, 2, roomSetKey, leaseKey, ttl, Math.max(LEASE_TTL_MS * 4, ttl * 2)),
      )
      const shouldBootstrap = Number(elected) === 1
      this.leases.set(localId, {
        conn,
        room,
        requestId,
        roomSetKey,
        leaseKey,
        expiresAt,
        shouldBootstrap,
      })
      return { shouldBootstrap }
    } catch (error) {
      this.logger.warn(
        '[collab-redis] lease reservation unavailable; using local election',
        safeErrorLogMetadata(error),
      )
      return { shouldBootstrap: undefined }
    }
  }

  async releaseLease(conn: Conn<S>, room: string, requestId: string | undefined): Promise<void> {
    const localId = this.localLeaseId(conn, room, requestId)
    const lease = this.leases.get(localId)
    if (!lease) {
      return
    }
    this.leases.delete(localId)
    await this.release(lease)
  }

  async releaseAll(conn: Conn<S>): Promise<void> {
    const owned = [...this.leases.entries()].filter(([, lease]) => lease.conn === conn)
    for (const [localId, lease] of owned) {
      this.leases.delete(localId)
      await this.release(lease)
    }
  }

  async refreshLeases(): Promise<void> {
    const now = Date.now()
    await Promise.all(
      [...this.leases.entries()].map(async ([localId, lease]) => {
        if (Number.isFinite(lease.expiresAt) && lease.expiresAt <= now) {
          this.leases.delete(localId)
          await this.release(lease)
          return
        }
        try {
          await this.refresh(lease, this.leaseTtl(lease.expiresAt))
        } catch (error) {
          this.logger.warn('[collab-redis] lease refresh failed', safeErrorLogMetadata(error))
        }
      }),
    )
  }

  publish(frame: RelayPayloadFrame): void {
    const message = JSON.stringify({ v: 1, origin: this.instanceId, frame })
    let publication: Promise<number>
    try {
      publication = this.commands.publish(COLLABORATION_RELAY_CHANNEL, message)
    } catch (error) {
      this.logger.warn('[collab-redis] encrypted frame publish failed', safeErrorLogMetadata(error))
      return
    }
    void publication.catch((error) => {
      this.logger.warn('[collab-redis] encrypted frame publish failed', safeErrorLogMetadata(error))
    })
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.leases.values()].map((lease) => this.release(lease)))
    this.leases.clear()
    await Promise.all([this.closeClient(this.commands), this.closeClient(this.subscriber)])
  }

  private localLeaseId(conn: Conn<S>, room: string, requestId: string | undefined): string {
    return `${conn.connectionId}\u0000${room}\u0000${requestId ?? 'legacy'}`
  }

  private leaseTtl(expiresAt: number): number {
    if (!Number.isFinite(expiresAt)) {
      return LEASE_TTL_MS
    }
    return Math.max(1, Math.min(LEASE_TTL_MS, expiresAt - Date.now()))
  }

  private async release(lease: LocalLease<S>): Promise<void> {
    try {
      await bounded(this.commands.eval(RELEASE_LEASE_SCRIPT, 2, lease.roomSetKey, lease.leaseKey))
    } catch (error) {
      // The lease key has a short TTL, so a failed cleanup cannot strand a room.
      this.logger.warn('[collab-redis] lease cleanup failed', safeErrorLogMetadata(error))
    }
  }

  private async refresh(lease: LocalLease<S>, ttl: number): Promise<void> {
    // Re-add both keys atomically. Besides extending normal leases, this repairs
    // the global room set after a Redis restart/eviction while the socket and its
    // already-authorized local lease are still alive.
    await bounded(this.commands.eval(REFRESH_LEASE_SCRIPT, 2, lease.roomSetKey, lease.leaseKey, ttl, LEASE_TTL_MS * 4))
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
  // reconnects continuously, while command operations fail quickly and the
  // gateway falls back to its local room registry.
  const commands = new Redis({ ...baseRedisOptions, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  const subscriber = new Redis({ ...baseRedisOptions, maxRetriesPerRequest: null })
  return new CollaborationRedisBridge(rooms, commands, subscriber, opts.logger)
}
