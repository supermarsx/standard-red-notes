import { constantTimeDigestMatches } from './syncProtocol.js'

/**
 * Minimal contract a live socket must satisfy so the registry stays
 * testable without a real `ws` WebSocket. The real `ws.WebSocket` is
 * structurally compatible (it has `.send`).
 */
export interface SendableSocket {
  send(data: string): void
}

/**
 * A single live connection for a user.
 */
export interface Conn<S extends SendableSocket = SendableSocket> {
  socket: S
  /** Owner of this connection; the room-join authorizer checks membership for it. */
  userUuid: string
  sessionUuid: string
  connectionId: string
}

/**
 * A parsed message off the Redis `websocket-messages` channel.
 */
export interface DispatchMessage {
  userUuid: string
  /** Raw payload string to forward verbatim to client sockets. */
  message: string
  /** If set, sockets on this session are skipped (echo suppression). */
  originatingSessionUuid?: string
}

/**
 * In-memory registry of live connections, keyed by userUuid.
 *
 * A user may have many simultaneous sockets (multiple tabs / devices /
 * sessions), so each userUuid maps to a Set<Conn>.
 */
export class ConnectionRegistry<S extends SendableSocket = SendableSocket> {
  private readonly byUser = new Map<string, Set<Conn<S>>>()

  /** Register a live connection for a user. */
  add(userUuid: string, conn: Conn<S>): void {
    let set = this.byUser.get(userUuid)
    if (!set) {
      set = new Set<Conn<S>>()
      this.byUser.set(userUuid, set)
    }
    set.add(conn)
  }

  /** Remove a connection (on close/error). Cleans up empty user buckets. */
  remove(userUuid: string, conn: Conn<S>): void {
    const set = this.byUser.get(userUuid)
    if (!set) {
      return
    }
    set.delete(conn)
    if (set.size === 0) {
      this.byUser.delete(userUuid)
    }
  }

  /** All live connections for a user (empty array if none). */
  get(userUuid: string): Conn<S>[] {
    const set = this.byUser.get(userUuid)
    return set ? [...set] : []
  }

  /** Total live socket count across all users (for logging/metrics). */
  size(): number {
    let total = 0
    for (const set of this.byUser.values()) {
      total += set.size
    }
    return total
  }

  /**
   * Number of distinct user buckets currently held. Should return to 0 once all
   * connections close — a lingering empty bucket would be a memory leak.
   */
  userCount(): number {
    return this.byUser.size
  }

  /**
   * Push a raw message string to every live socket for `userUuid`, EXCEPT
   * sockets whose sessionUuid equals `excludeSessionUuid`.
   *
   * Returns the number of sockets the message was sent to.
   */
  pushToUser(userUuid: string, message: string, excludeSessionUuid?: string): number {
    let sent = 0
    for (const conn of this.get(userUuid)) {
      if (excludeSessionUuid !== undefined && conn.sessionUuid === excludeSessionUuid) {
        continue
      }
      // A dead/closing socket's send() can throw; never let one bad socket abort
      // the dispatch or bubble up and crash the gateway.
      try {
        conn.socket.send(message)
        sent += 1
      } catch {
        /* socket unwritable; skip it */
      }
    }
    return sent
  }
}

/**
 * Pure dispatch function: given a registry and a parsed dispatch message,
 * fan the raw `message` out to the matching user's sockets, excluding the
 * originating session. Kept separate from Redis/socket plumbing so it can be
 * unit-tested in isolation.
 *
 * Returns the number of sockets that received the message.
 */
export function dispatch<S extends SendableSocket>(registry: ConnectionRegistry<S>, parsed: DispatchMessage): number {
  return registry.pushToUser(parsed.userUuid, parsed.message, parsed.originatingSessionUuid)
}

/**
 * Parse a raw Redis channel payload into a DispatchMessage. Throws on
 * malformed JSON or a missing/invalid `userUuid`/`message`.
 */
export function parseDispatchMessage(raw: string): DispatchMessage {
  const obj = JSON.parse(raw) as Record<string, unknown>

  if (typeof obj.userUuid !== 'string' || obj.userUuid.length === 0) {
    throw new Error('dispatch message missing userUuid')
  }
  if (typeof obj.message !== 'string') {
    throw new Error('dispatch message missing message')
  }

  return {
    userUuid: obj.userUuid,
    message: obj.message,
    originatingSessionUuid: typeof obj.originatingSessionUuid === 'string' ? obj.originatingSessionUuid : undefined,
  }
}

export type SyncCommandLeaseResult = { acquired: true } | { acquired: false; reason: 'BUSY' | 'COMMAND_ID_CONFLICT' }

export interface SyncCommandLeaseRegistry {
  readonly distribution: 'process' | 'shared'
  ready(): boolean
  acquire(
    input: {
      userUuid: string
      deviceId: string
      commandId: string
      digest: string
      ownerId: string
    },
    signal?: AbortSignal,
  ): Promise<SyncCommandLeaseResult>
  renew(
    input: {
      userUuid: string
      deviceId: string
      commandId: string
      digest: string
      ownerId: string
    },
    signal?: AbortSignal,
  ): Promise<boolean>
  release(
    input: {
      userUuid: string
      deviceId: string
      commandId: string
      digest: string
      ownerId: string
    },
    signal?: AbortSignal,
  ): Promise<void>
}

interface SyncCommandLease {
  commandId: string
  digest: string
  ownerId: string
  expiresAt: number
}

/**
 * Enforces one active sync command for a user/device pair. A fleet may inject a
 * shared implementation; this in-memory registry is intentionally independent
 * from the future syncing-server/protobuf adapter.
 */
export class InMemorySyncCommandLeaseRegistry implements SyncCommandLeaseRegistry {
  readonly distribution = 'process' as const
  private readonly leases = new Map<string, SyncCommandLease>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  ready(): boolean {
    return true
  }

  async acquire(input: {
    userUuid: string
    deviceId: string
    commandId: string
    digest: string
    ownerId: string
  }): Promise<SyncCommandLeaseResult> {
    const key = `${input.userUuid}\u0000${input.deviceId}`
    let existing = this.leases.get(key)
    if (existing && existing.expiresAt <= this.now()) {
      this.leases.delete(key)
      existing = undefined
    }
    if (existing) {
      if (existing.commandId === input.commandId && !constantTimeDigestMatches(input.digest, existing.digest)) {
        return { acquired: false, reason: 'COMMAND_ID_CONFLICT' }
      }
      return { acquired: false, reason: 'BUSY' }
    }
    this.leases.set(key, {
      commandId: input.commandId,
      digest: input.digest,
      ownerId: input.ownerId,
      expiresAt: this.now() + this.ttlMs,
    })
    return { acquired: true }
  }

  async renew(input: {
    userUuid: string
    deviceId: string
    commandId: string
    digest: string
    ownerId: string
  }): Promise<boolean> {
    const key = `${input.userUuid}\u0000${input.deviceId}`
    const existing = this.leases.get(key)
    if (
      !existing ||
      existing.expiresAt <= this.now() ||
      existing.commandId !== input.commandId ||
      existing.ownerId !== input.ownerId ||
      !constantTimeDigestMatches(input.digest, existing.digest)
    ) {
      if (existing?.expiresAt !== undefined && existing.expiresAt <= this.now()) {
        this.leases.delete(key)
      }
      return false
    }
    existing.expiresAt = this.now() + this.ttlMs
    return true
  }

  async release(input: {
    userUuid: string
    deviceId: string
    commandId: string
    digest: string
    ownerId: string
  }): Promise<void> {
    const key = `${input.userUuid}\u0000${input.deviceId}`
    const existing = this.leases.get(key)
    if (
      existing?.commandId === input.commandId &&
      existing.ownerId === input.ownerId &&
      constantTimeDigestMatches(input.digest, existing.digest)
    ) {
      this.leases.delete(key)
    }
  }
}

export interface SyncSocketBudget {
  readonly distribution: 'process' | 'shared'
  ready(): boolean
  acquire(input: { userUuid: string; ownerId: string }, signal?: AbortSignal): Promise<boolean>
  renew(input: { userUuid: string; ownerId: string }, signal?: AbortSignal): Promise<boolean>
  release(input: { userUuid: string; ownerId: string }, signal?: AbortSignal): Promise<void>
}

/** Per-user authenticated sync-socket budget for deterministic tests and development. */
export class InMemorySyncSocketBudget implements SyncSocketBudget {
  readonly distribution = 'process' as const
  private readonly byUser = new Map<string, Map<string, number>>()

  constructor(
    private readonly maximumPerUser = 4,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 75_000,
  ) {
    if (!Number.isSafeInteger(maximumPerUser) || maximumPerUser < 1) {
      throw new Error('Invalid sync per-user socket limit.')
    }
  }

  ready(): boolean {
    return true
  }

  async acquire(input: { userUuid: string; ownerId: string }): Promise<boolean> {
    const owners = this.liveOwners(input.userUuid)
    if (!owners.has(input.ownerId) && owners.size >= this.maximumPerUser) {
      return false
    }
    owners.set(input.ownerId, this.now() + this.ttlMs)
    this.byUser.set(input.userUuid, owners)
    return true
  }

  async renew(input: { userUuid: string; ownerId: string }): Promise<boolean> {
    const owners = this.liveOwners(input.userUuid)
    if (!owners.has(input.ownerId)) {
      return false
    }
    owners.set(input.ownerId, this.now() + this.ttlMs)
    this.byUser.set(input.userUuid, owners)
    return true
  }

  async release(input: { userUuid: string; ownerId: string }): Promise<void> {
    const owners = this.byUser.get(input.userUuid)
    owners?.delete(input.ownerId)
    if (owners?.size === 0) {
      this.byUser.delete(input.userUuid)
    }
  }

  private liveOwners(userUuid: string): Map<string, number> {
    const owners = this.byUser.get(userUuid) ?? new Map<string, number>()
    const now = this.now()
    for (const [ownerId, expiresAt] of owners) {
      if (expiresAt <= now) {
        owners.delete(ownerId)
      }
    }
    if (owners.size === 0) {
      this.byUser.delete(userUuid)
    }
    return owners
  }
}
