import type { Conn, SendableSocket } from './registry.js'

// ---------------------------------------------------------------------------
// Collaborative-editing relay (Tier 3 / CRDT transport)
//
// The gateway relays opaque, END-TO-END-ENCRYPTED yjs sync + awareness frames
// between clients editing the same note ("room"). The gateway never sees
// plaintext: the Lexical/yjs layer encrypts every update with a key only the
// note's collaborators hold, so relaying ciphertext to whoever is in the room
// is safe — non-collaborators cannot decrypt it. A room id is a note uuid.
//
// Protocol is JSON text frames (so it coexists with the existing `ping`/`pong`
// and push messages on the same socket) with a base64 binary payload:
//   { t: 'room-join',  room }
//   { t: 'room-leave', room }
//   { t: 'yjs',        room, payload }   // base64 yjs sync update
//   { t: 'awareness',  room, payload }   // base64 yjs awareness update
// `yjs`/`awareness` frames are re-broadcast verbatim to every OTHER member of
// the room. On join, the gateway tells existing members to re-announce state so
// the newcomer catches up (sync handshake is driven client-side by yjs).
// ---------------------------------------------------------------------------

export type RelayFrame =
  // `cap` is the short-lived signed capability the client obtained from the
  // api-gateway proving it may join this room. Optional at the parse layer (so a
  // malformed/legacy frame still parses), but the production authorizer REQUIRES
  // a valid one and denies otherwise.
  | {
      t: 'room-join'
      room: string
      cap?: string
      requestId?: string
      role?: RoomLeaseRole
    }
  | { t: 'room-leave'; room: string; requestId?: string }
  | { t: 'yjs'; room: string; payload: string }
  | { t: 'awareness'; room: string; payload: string }
  | { t: 'comment'; room: string; payload: string }

const RELAY_TYPES = new Set(['room-join', 'room-leave', 'yjs', 'awareness', 'comment'])
const MAX_ROOM_ID = 200
const MAX_PAYLOAD = 512 * 1024 // 512 KiB per frame; a yjs update is normally tiny.
// A signed JWT capability is small; cap the field so a junk frame can't blow up
// memory and so verification stays cheap.
const MAX_CAP = 4096
const MAX_REQUEST_ID = 128
export type RoomLeaseRole = 'editor' | 'comment'

/**
 * Parse a raw text frame into a RelayFrame, or return null if it is not a
 * well-formed relay frame (so the caller can fall through to other handlers).
 */
export function parseRelayFrame(raw: string): RelayFrame | null {
  if (raw.length === 0 || raw[0] !== '{') return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const t = obj.t
  if (typeof t !== 'string' || !RELAY_TYPES.has(t)) return null
  const room = obj.room
  if (typeof room !== 'string' || room.length === 0 || room.length > MAX_ROOM_ID) return null

  if (t === 'room-leave') {
    const requestId = obj.requestId
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID)
    ) {
      return null
    }
    return { t, room, ...(requestId ? { requestId } : {}) }
  }
  if (t === 'room-join') {
    const cap = obj.cap
    const requestId = obj.requestId
    const role = obj.role
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID)
    ) {
      return null
    }
    if (role !== undefined && role !== 'editor' && role !== 'comment') {
      return null
    }
    if (cap === undefined || cap === null) {
      return { t, room, ...(requestId ? { requestId } : {}), ...(role ? { role } : {}) }
    }
    if (typeof cap !== 'string' || cap.length === 0 || cap.length > MAX_CAP) {
      // A present-but-malformed capability is itself suspicious: drop the whole
      // frame so it can't be treated as a capability-less (and thus, under the
      // production authorizer, denied) join with side effects.
      return null
    }
    return { t, room, cap, ...(requestId ? { requestId } : {}), ...(role ? { role } : {}) }
  }
  const payload = obj.payload
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD) return null
  return { t: t as 'yjs' | 'awareness' | 'comment', room, payload }
}

/**
 * In-memory map of room id -> live connections currently editing that note.
 * A connection may be in several rooms (e.g. several open Super notes).
 */
// A single client should never need more open note-rooms than this; the cap
// stops a malicious/buggy client from inflating the registry with junk room ids.
const MAX_ROOMS_PER_CONNECTION = 100

type RoomLease = {
  role: RoomLeaseRole
  shouldBootstrap: boolean
  expiresAt: number
}

type RoomMembership = {
  requestIds: Map<string, RoomLease>
  /** Legacy clients have one unbound lease; preserve an explicit role when sent. */
  legacyLease?: RoomLease
}

export class RoomRegistry<S extends SendableSocket = SendableSocket> {
  private readonly byRoom = new Map<string, Map<Conn<S>, RoomMembership>>()
  private readonly byConn = new WeakMap<Conn<S>, Set<string>>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Joins one logical lease and elects exactly one editor bootstrapper. */
  join(
    room: string,
    conn: Conn<S>,
    expiresAt = Number.POSITIVE_INFINITY,
    requestId?: string,
    role: RoomLeaseRole = 'editor',
  ): { joined: boolean; shouldBootstrap: boolean } {
    if (expiresAt <= this.now() || (expiresAt !== Number.POSITIVE_INFINITY && !Number.isFinite(expiresAt))) {
      return { joined: false, shouldBootstrap: false }
    }
    this.members(room) // prune expired leases before bootstrap election
    let rooms = this.byConn.get(conn)
    if (!rooms) {
      rooms = new Set<string>()
      this.byConn.set(conn, rooms)
    }
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS_PER_CONNECTION) {
      return { joined: false, shouldBootstrap: false }
    }
    let members = this.byRoom.get(room)
    if (!members) {
      members = new Map()
      this.byRoom.set(room, members)
    }
    const membership = members.get(conn)
    const existingLease = requestId ? membership?.requestIds.get(requestId) : membership?.legacyLease
    if (existingLease && existingLease.role !== role) {
      return { joined: false, shouldBootstrap: false }
    }
    const shouldBootstrap = existingLease?.shouldBootstrap ?? (role === 'editor' && !this.hasEditorLease(room))
    if (membership) {
      if (requestId) {
        membership.requestIds.set(requestId, { role, shouldBootstrap, expiresAt })
      } else {
        membership.legacyLease = { role, shouldBootstrap, expiresAt }
      }
    } else {
      members.set(conn, {
        requestIds: new Map(requestId ? [[requestId, { role, shouldBootstrap, expiresAt }]] : []),
        ...(!requestId ? { legacyLease: { role, shouldBootstrap, expiresAt } } : {}),
      })
    }
    rooms.add(room)
    return { joined: true, shouldBootstrap }
  }

  leave(room: string, conn: Conn<S>, requestId?: string): void {
    const members = this.byRoom.get(room)
    const membership = members?.get(conn)
    if (!members || !membership) {
      return
    }
    if (requestId) {
      membership.requestIds.delete(requestId)
      if (membership.requestIds.size > 0 || membership.legacyLease !== undefined) {
        return
      }
    }
    members.delete(conn)
    if (members.size === 0) this.byRoom.delete(room)
    this.byConn.get(conn)?.delete(room)
  }

  private hasEditorLease(room: string): boolean {
    const members = this.byRoom.get(room)
    if (!members) {
      return false
    }
    for (const membership of members.values()) {
      if (membership.legacyLease?.role === 'editor') {
        return true
      }
      for (const lease of membership.requestIds.values()) {
        if (lease.role === 'editor') {
          return true
        }
      }
    }
    return false
  }

  /** Remove a connection from every room it joined (on socket close). */
  leaveAll(conn: Conn<S>): void {
    const rooms = this.byConn.get(conn)
    if (!rooms) return
    for (const room of rooms) {
      const members = this.byRoom.get(room)
      if (members) {
        members.delete(conn)
        if (members.size === 0) this.byRoom.delete(room)
      }
    }
    this.byConn.delete(conn)
  }

  members(room: string): Conn<S>[] {
    const members = this.byRoom.get(room)
    if (!members) {
      return []
    }
    const active: Conn<S>[] = []
    for (const [conn, membership] of members) {
      if (this.pruneExpiredLeases(room, conn, membership)) {
        active.push(conn)
      }
    }
    return active
  }

  /**
   * True iff `conn` is currently a member of `room`. O(1); used to gate the
   * yjs/awareness SEND path so a connection can only inject frames into a room
   * it actually joined (and was therefore authorized into).
   */
  isMember(room: string, conn: Conn<S>): boolean {
    const membership = this.byRoom.get(room)?.get(conn)
    if (!membership) {
      return false
    }
    return this.pruneExpiredLeases(room, conn, membership)
  }

  /** Proactively evict expired memberships even while a room is idle. */
  evictExpired(): void {
    for (const room of [...this.byRoom.keys()]) {
      this.members(room)
    }
  }

  private pruneExpiredLeases(room: string, conn: Conn<S>, membership: RoomMembership): boolean {
    const now = this.now()
    for (const [requestId, lease] of [...membership.requestIds]) {
      if (lease.expiresAt <= now) {
        membership.requestIds.delete(requestId)
        this.sendDenied(conn, room, requestId)
      }
    }
    if (membership.legacyLease !== undefined && membership.legacyLease.expiresAt <= now) {
      membership.legacyLease = undefined
      this.sendDenied(conn, room)
    }
    if (membership.requestIds.size > 0 || membership.legacyLease !== undefined) {
      return true
    }
    this.leave(room, conn)
    return false
  }

  private sendDenied(conn: Conn<S>, room: string, requestId?: string): void {
    try {
      conn.socket.send(
        JSON.stringify({
          t: 'room-denied',
          room,
          ...(requestId ? { requestId } : {}),
        }),
      )
    } catch {
      /* socket unwritable; membership is still evicted */
    }
  }

  /**
   * Number of rooms currently held. Should return to 0 once every member has
   * left — a lingering empty room would be a memory leak.
   */
  roomCount(): number {
    return this.byRoom.size
  }

  /** Number of rooms a connection is currently in (0 if none/unknown). */
  roomCountForConn(conn: Conn<S>): number {
    return this.byConn.get(conn)?.size ?? 0
  }

  /**
   * Send `message` to every member of `room` except `from`. Returns the number
   * of sockets that received it.
   */
  broadcast(room: string, message: string, from: Conn<S>): number {
    let sent = 0
    for (const member of this.members(room)) {
      if (member === from) continue
      // A dead/closing socket's send() can throw synchronously; never let one
      // bad peer abort the broadcast or bubble out of the message handler (which
      // would crash the whole gateway for everyone).
      try {
        member.socket.send(message)
        sent += 1
      } catch {
        /* peer socket unwritable; skip it */
      }
    }
    return sent
  }
}

/**
 * Async predicate deciding whether `userUuid` may join the note-room `room`
 * (room id === note uuid), given the optional signed `capability` the client
 * presented on the join frame. An allow result must carry the capability's
 * absolute expiry; the registry enforces it for continued send and receive.
 * The gateway treats a thrown error / rejected promise as a DENY (fail closed).
 * Wired by the caller to a real capability check; when omitted, joins are allowed
 * (standalone / test default — see gateway.ts for the production authorizer).
 */
export type RoomJoinAuthorization =
  | { authorized: false }
  | {
      authorized: true
      /** Epoch milliseconds; continued send and receive access ends here. */
      expiresAt: number
    }

export type RoomJoinAuthorizer = (
  userUuid: string,
  room: string,
  capability?: string,
) => RoomJoinAuthorization | Promise<RoomJoinAuthorization>

/**
 * Handle one parsed relay frame against the room registry on behalf of `conn`.
 * Pure w.r.t. I/O except for `socket.send` via the registry, so it is unit
 * testable with fake sockets. Returns the number of peers the frame reached
 * (0 for join/leave control frames).
 *
 * AUTHORIZATION: `room-join` is gated on `authorize(userUuid, room)` so an
 * authenticated socket cannot join (and therefore cannot receive OR inject
 * yjs/awareness frames for) an arbitrary note it has no membership in. The
 * authorizer FAILS CLOSED: a thrown/rejected check rejects the join.
 *
 * Every send and receive path is independently gated on live, unexpired room
 * membership. Expired members are evicted and receive a request-bound denial;
 * they must obtain a fresh exact-note capability before collaboration resumes.
 */
export async function handleRelayFrame<S extends SendableSocket>(
  rooms: RoomRegistry<S>,
  conn: Conn<S>,
  frame: RelayFrame,
  authorize?: RoomJoinAuthorizer,
  isConnectionActive?: () => boolean,
): Promise<number> {
  if (isConnectionActive && !isConnectionActive()) {
    return 0
  }
  switch (frame.t) {
    case 'room-join': {
      let authorization: RoomJoinAuthorization = {
        authorized: true,
        expiresAt: Number.POSITIVE_INFINITY,
      }
      if (authorize !== undefined) {
        try {
          authorization = await authorize(conn.userUuid, frame.room, frame.cap)
        } catch {
          authorization = { authorized: false } // fail closed on authorizer error
        }
        if (!authorization.authorized) {
          // Tell the client its join was refused (so it can stop the provider)
          // and do NOT add it to the room.
          try {
            conn.socket.send(
              JSON.stringify({
                t: 'room-denied',
                room: frame.room,
                ...(frame.requestId ? { requestId: frame.requestId } : {}),
              }),
            )
          } catch {
            /* socket unwritable; nothing else to do */
          }
          return 0
        }
      }
      // Authorization can be asynchronous. A socket that closed while it was
      // in flight must never be resurrected into a room or receive an ack.
      if (isConnectionActive && !isConnectionActive()) {
        return 0
      }
      const joinResult = rooms.join(frame.room, conn, authorization.expiresAt, frame.requestId, frame.role ?? 'editor')
      if (!joinResult.joined) {
        try {
          conn.socket.send(
            JSON.stringify({
              t: 'room-denied',
              room: frame.room,
              ...(frame.requestId ? { requestId: frame.requestId } : {}),
            }),
          )
        } catch {
          /* socket unwritable; nothing else to do */
        }
        return 0
      }
      try {
        conn.socket.send(
          JSON.stringify({
            t: 'room-joined',
            room: frame.room,
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
            ...(frame.role === 'editor' ? { bootstrap: joinResult.shouldBootstrap } : {}),
          }),
        )
      } catch {
        rooms.leave(frame.room, conn, frame.requestId)
        return 0
      }
      // Ask existing members to re-broadcast their state so the newcomer syncs.
      return frame.role === 'comment'
        ? 0
        : rooms.broadcast(frame.room, JSON.stringify({ t: 'room-sync', room: frame.room }), conn)
    }
    case 'room-leave':
      rooms.leave(frame.room, conn, frame.requestId)
      return 0
    case 'yjs':
    case 'awareness':
    case 'comment':
      // Fail closed on the SEND path too: only a current, unexpired member may
      // inject edit/awareness/comment frames. The receive side is likewise
      // checked by RoomRegistry.broadcast before each delivery.
      if (!rooms.isMember(frame.room, conn)) {
        return 0
      }
      return rooms.broadcast(frame.room, JSON.stringify(frame), conn)
  }
}
