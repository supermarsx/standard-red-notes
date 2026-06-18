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
  | { t: 'room-join'; room: string }
  | { t: 'room-leave'; room: string }
  | { t: 'yjs'; room: string; payload: string }
  | { t: 'awareness'; room: string; payload: string }

const RELAY_TYPES = new Set(['room-join', 'room-leave', 'yjs', 'awareness'])
const MAX_ROOM_ID = 200
const MAX_PAYLOAD = 512 * 1024 // 512 KiB per frame; a yjs update is normally tiny.

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

  if (t === 'room-join' || t === 'room-leave') {
    return { t, room }
  }
  const payload = obj.payload
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD) return null
  return { t: t as 'yjs' | 'awareness', room, payload }
}

/**
 * In-memory map of room id -> live connections currently editing that note.
 * A connection may be in several rooms (e.g. several open Super notes).
 */
// A single client should never need more open note-rooms than this; the cap
// stops a malicious/buggy client from inflating the registry with junk room ids.
const MAX_ROOMS_PER_CONNECTION = 100

export class RoomRegistry<S extends SendableSocket = SendableSocket> {
  private readonly byRoom = new Map<string, Set<Conn<S>>>()
  private readonly byConn = new WeakMap<Conn<S>, Set<string>>()

  /** Returns false if the connection has hit its room cap (join rejected). */
  join(room: string, conn: Conn<S>): boolean {
    let rooms = this.byConn.get(conn)
    if (!rooms) {
      rooms = new Set<string>()
      this.byConn.set(conn, rooms)
    }
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS_PER_CONNECTION) {
      return false
    }
    let members = this.byRoom.get(room)
    if (!members) {
      members = new Set<Conn<S>>()
      this.byRoom.set(room, members)
    }
    members.add(conn)
    rooms.add(room)
    return true
  }

  leave(room: string, conn: Conn<S>): void {
    const members = this.byRoom.get(room)
    if (members) {
      members.delete(conn)
      if (members.size === 0) this.byRoom.delete(room)
    }
    this.byConn.get(conn)?.delete(room)
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
    const set = this.byRoom.get(room)
    return set ? [...set] : []
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
 * Handle one parsed relay frame against the room registry on behalf of `conn`.
 * Pure w.r.t. I/O except for `socket.send` via the registry, so it is unit
 * testable with fake sockets. Returns the number of peers the frame reached
 * (0 for join/leave control frames).
 */
export function handleRelayFrame<S extends SendableSocket>(
  rooms: RoomRegistry<S>,
  conn: Conn<S>,
  frame: RelayFrame,
): number {
  switch (frame.t) {
    case 'room-join':
      if (!rooms.join(frame.room, conn)) {
        return 0 // room cap reached for this connection; ignore the join
      }
      // Ask existing members to re-broadcast their state so the newcomer syncs.
      return rooms.broadcast(frame.room, JSON.stringify({ t: 'room-sync', room: frame.room }), conn)
    case 'room-leave':
      rooms.leave(frame.room, conn)
      return 0
    case 'yjs':
    case 'awareness':
      return rooms.broadcast(frame.room, JSON.stringify(frame), conn)
  }
}
