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
    if (!set) return
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
    for (const set of this.byUser.values()) total += set.size
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
export function dispatch<S extends SendableSocket>(
  registry: ConnectionRegistry<S>,
  parsed: DispatchMessage,
): number {
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
    originatingSessionUuid:
      typeof obj.originatingSessionUuid === 'string' ? obj.originatingSessionUuid : undefined,
  }
}
