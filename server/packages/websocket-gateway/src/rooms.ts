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
//   { t: 'room-reserve', room, cap, requestId, role: 'editor', protocolVersion: 2 }
//   { t: 'room-join', room, cap, requestId, role, protocolVersion: 2 }
//   { t: 'room-leave', room, requestId }
//   { t: 'yjs', room, payload, transferId?, stateRequestId? } // base64 encrypted update
//   { t: 'yjs-chunk',  room, ... }       // bounded chunk of a large encrypted update
//   { t: 'yjs-retry', room, requestId, requesterClientId } // correlated full-state retry
//   { t: 'yjs-response-claim', room, stateRequestId, leaseRequestId }
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
      t: 'room-reserve'
      room: string
      cap?: string
      requestId: string
      role: 'editor'
      protocolVersion: 2
    }
  | {
      t: 'room-join'
      room: string
      cap?: string
      requestId?: string
      role?: RoomLeaseRole
      protocolVersion?: number
    }
  | { t: 'room-leave'; room: string; requestId?: string }
  | { t: 'yjs'; room: string; payload: string; transferId?: string; stateRequestId?: string }
  | {
      t: 'yjs-chunk'
      room: string
      transferId: string
      index: number
      count: number
      totalBytes: number
      payload: string
      stateRequestId?: string
    }
  | { t: 'yjs-retry'; room: string; requestId: string; requesterClientId: number }
  | { t: 'yjs-response-claim'; room: string; stateRequestId: string; leaseRequestId: string }
  | { t: 'awareness'; room: string; payload: string }
  | { t: 'comment'; room: string; payload: string }

const RELAY_TYPES = new Set([
  'room-reserve',
  'room-join',
  'room-leave',
  'yjs',
  'yjs-chunk',
  'yjs-retry',
  'yjs-response-claim',
  'awareness',
  'comment',
])
export const COLLABORATION_PROTOCOL_VERSION = 2
const MAX_ROOM_ID = 200
const MAX_PAYLOAD = 512 * 1024 // 512 KiB per frame; a yjs update is normally tiny.
export const YJS_CHUNK_PLAINTEXT_BYTES = 128 * 1024
export const MAX_YJS_TRANSFER_BYTES = 4 * 1024 * 1024
export const MAX_YJS_TRANSFER_CHUNKS = MAX_YJS_TRANSFER_BYTES / YJS_CHUNK_PLAINTEXT_BYTES
// A signed JWT capability is small; cap the field so a junk frame can't blow up
// memory and so verification stays cheap.
const MAX_CAP = 4096
const MAX_REQUEST_ID = 128
export const MAX_YJS_CLIENT_ID = 0xffff_ffff
export type RoomLeaseRole = 'editor' | 'comment'
export type YjsResponseFrameDisposition = 'uncorrelated' | 'partial' | 'complete' | 'denied'

// Reservations exist before normal room membership, so the membership cap below
// cannot bound them. Keep this ledger deliberately smaller than the normal room
// cap: an editor reservation should be activated almost immediately.
export const MAX_PENDING_EDITOR_RESERVATIONS_PER_CONNECTION = 8
export const MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM = 32
export const PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS = 15_000
export const MAX_REQUEST_LEASES_PER_CONNECTION = 128
export const MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM = 8
export const MAX_REQUEST_LEASES_PER_ROOM = 256
export const MAX_CONNECTIONS_PER_ROOM = 128

// Control frames are far more expensive than opaque updates: reserve invokes
// capability verification and distributed lease coordination, while retry asks
// every peer to regenerate a full Yjs state. Unique request ids must not bypass
// these fixed-window budgets.
export const CONTROL_FRAME_WINDOW_MS = 10_000
export const MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION = 12
export const MAX_ROOM_RESERVE_FRAMES_PER_ROOM = 48
export const MAX_ROOM_JOIN_FRAMES_PER_CONNECTION = 16
export const MAX_ROOM_JOIN_FRAMES_PER_ROOM = 64
export const MAX_YJS_RETRY_FRAMES_PER_CONNECTION = 3
export const MAX_YJS_RETRY_FRAMES_PER_ROOM = 12
export const MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_CONNECTION = 8
export const MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_ROOM = 128
export const MAX_ACTIVE_YJS_RESPONSE_GRANTS_PER_CONNECTION = 16
export const MAX_ACTIVE_YJS_RESPONSE_GRANTS_PER_ROOM = 128
const MAX_TRACKED_CONTROL_ROOMS = 2_048

const CONTROL_FRAME_LIMITS = Object.freeze({
  'room-reserve': {
    connection: MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION,
    room: MAX_ROOM_RESERVE_FRAMES_PER_ROOM,
  },
  'room-join': {
    connection: MAX_ROOM_JOIN_FRAMES_PER_CONNECTION,
    room: MAX_ROOM_JOIN_FRAMES_PER_ROOM,
  },
  'yjs-retry': {
    connection: MAX_YJS_RETRY_FRAMES_PER_CONNECTION,
    room: MAX_YJS_RETRY_FRAMES_PER_ROOM,
  },
  'yjs-response-claim': {
    connection: MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_CONNECTION,
    room: MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_ROOM,
  },
})

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
  if (t === 'yjs-retry') {
    const requestId = obj.requestId
    const requesterClientId = obj.requesterClientId
    if (
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      requestId.length > MAX_REQUEST_ID ||
      typeof requesterClientId !== 'number' ||
      !Number.isSafeInteger(requesterClientId) ||
      requesterClientId < 0 ||
      requesterClientId > MAX_YJS_CLIENT_ID
    ) {
      return null
    }
    return { t, room, requestId, requesterClientId }
  }
  if (t === 'yjs-response-claim') {
    const stateRequestId = obj.stateRequestId
    const leaseRequestId = obj.leaseRequestId
    if (
      typeof stateRequestId !== 'string' ||
      stateRequestId.length === 0 ||
      stateRequestId.length > MAX_REQUEST_ID ||
      typeof leaseRequestId !== 'string' ||
      leaseRequestId.length === 0 ||
      leaseRequestId.length > MAX_REQUEST_ID
    ) {
      return null
    }
    return { t, room, stateRequestId, leaseRequestId }
  }
  if (t === 'room-reserve' || t === 'room-join') {
    const cap = obj.cap
    const requestId = obj.requestId
    const role = obj.role
    const protocolVersion = obj.protocolVersion
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID)
    ) {
      return null
    }
    if (role !== undefined && role !== 'editor' && role !== 'comment') {
      return null
    }
    if (t === 'room-reserve') {
      if (
        typeof requestId !== 'string' ||
        requestId.length === 0 ||
        requestId.length > MAX_REQUEST_ID ||
        role !== 'editor' ||
        protocolVersion !== COLLABORATION_PROTOCOL_VERSION
      ) {
        return null
      }
    } else if (
      protocolVersion !== undefined &&
      (!Number.isSafeInteger(protocolVersion) || protocolVersion !== COLLABORATION_PROTOCOL_VERSION)
    ) {
      return null
    }
    if (cap === undefined || cap === null) {
      return {
        t,
        room,
        ...(requestId ? { requestId } : {}),
        ...(role ? { role } : {}),
        ...(protocolVersion === COLLABORATION_PROTOCOL_VERSION
          ? { protocolVersion: COLLABORATION_PROTOCOL_VERSION }
          : {}),
      } as RelayFrame
    }
    if (typeof cap !== 'string' || cap.length === 0 || cap.length > MAX_CAP) {
      // A present-but-malformed capability is itself suspicious: drop the whole
      // frame so it can't be treated as a capability-less (and thus, under the
      // production authorizer, denied) join with side effects.
      return null
    }
    return {
      t,
      room,
      cap,
      ...(requestId ? { requestId } : {}),
      ...(role ? { role } : {}),
      ...(protocolVersion === COLLABORATION_PROTOCOL_VERSION
        ? { protocolVersion: COLLABORATION_PROTOCOL_VERSION }
        : {}),
    } as RelayFrame
  }
  const payload = obj.payload
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD) return null
  const stateRequestId = obj.stateRequestId
  if (
    stateRequestId !== undefined &&
    (typeof stateRequestId !== 'string' || stateRequestId.length === 0 || stateRequestId.length > MAX_REQUEST_ID)
  ) {
    return null
  }
  if (t === 'yjs') {
    const transferId = obj.transferId
    if (
      transferId !== undefined &&
      (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > MAX_REQUEST_ID)
    ) {
      return null
    }
    return {
      t,
      room,
      payload,
      ...(transferId ? { transferId } : {}),
      ...(stateRequestId ? { stateRequestId } : {}),
    }
  }
  if (t === 'yjs-chunk') {
    const transferId = obj.transferId
    const index = obj.index
    const count = obj.count
    const totalBytes = obj.totalBytes
    if (
      typeof transferId !== 'string' ||
      transferId.length === 0 ||
      transferId.length > MAX_REQUEST_ID ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(totalBytes) ||
      (count as number) < 2 ||
      (count as number) > MAX_YJS_TRANSFER_CHUNKS ||
      (index as number) < 0 ||
      (index as number) >= (count as number) ||
      (totalBytes as number) <= YJS_CHUNK_PLAINTEXT_BYTES ||
      (totalBytes as number) > MAX_YJS_TRANSFER_BYTES ||
      Math.ceil((totalBytes as number) / YJS_CHUNK_PLAINTEXT_BYTES) !== count
    ) {
      return null
    }
    return {
      t,
      room,
      transferId,
      index: index as number,
      count: count as number,
      totalBytes: totalBytes as number,
      payload,
      ...(stateRequestId ? { stateRequestId } : {}),
    }
  }
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

type PendingEditorReservation = {
  expiresAt: number
}

type YjsResponseGrant = {
  leaseRequestId: string
  expiresAt: number
  transfer?: {
    transferId: string
    count: number
    totalBytes: number
    receivedIndexes: Set<number>
  }
}

export type ExpiredPendingEditorReservation<S extends SendableSocket = SendableSocket> = {
  conn: Conn<S>
  room: string
  requestId: string
}

type ControlFrameKind = 'room-reserve' | 'room-join' | 'yjs-retry' | 'yjs-response-claim'

type ControlWindow = {
  startedAt: number
  count: number
}

type ControlWindows = Record<ControlFrameKind, ControlWindow>

export class RoomRegistry<S extends SendableSocket = SendableSocket> {
  private readonly byRoom = new Map<string, Map<Conn<S>, RoomMembership>>()
  private readonly byConn = new WeakMap<Conn<S>, Set<string>>()
  private readonly pendingReservationsByRoom = new Map<string, Map<Conn<S>, Map<string, PendingEditorReservation>>>()
  private readonly pendingReservationsByConn = new WeakMap<Conn<S>, Map<string, Set<string>>>()
  private readonly controlWindowsByConn = new WeakMap<Conn<S>, ControlWindows>()
  private readonly controlWindowsByRoom = new Map<string, ControlWindows>()
  private readonly yjsResponseGrantsByRoom = new Map<string, Map<Conn<S>, Map<string, YjsResponseGrant>>>()
  private readonly yjsResponseGrantRoomsByConn = new WeakMap<Conn<S>, Set<string>>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Claim a bounded slot before awaiting capability authorization. The short
   * provisional expiry prevents a stalled authorizer from pinning capacity.
   * Replays of the same request are idempotent and do not consume another slot.
   */
  reservePendingEditorSlot(room: string, conn: Conn<S>, requestId: string): { accepted: boolean; created: boolean } {
    const existing = this.pendingReservationsByRoom.get(room)?.get(conn)?.get(requestId)
    if (existing) {
      return { accepted: true, created: false }
    }

    if (
      this.pendingReservationCountForConn(conn) >= MAX_PENDING_EDITOR_RESERVATIONS_PER_CONNECTION ||
      this.pendingReservationCountForRoom(room) >= MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM
    ) {
      return { accepted: false, created: false }
    }

    let roomReservations = this.pendingReservationsByRoom.get(room)
    if (!roomReservations) {
      roomReservations = new Map()
      this.pendingReservationsByRoom.set(room, roomReservations)
    }
    let connectionReservations = roomReservations.get(conn)
    if (!connectionReservations) {
      connectionReservations = new Map()
      roomReservations.set(conn, connectionReservations)
    }
    connectionReservations.set(requestId, {
      expiresAt: this.now() + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
    })

    let connectionRooms = this.pendingReservationsByConn.get(conn)
    if (!connectionRooms) {
      connectionRooms = new Map()
      this.pendingReservationsByConn.set(conn, connectionRooms)
    }
    let roomRequestIds = connectionRooms.get(room)
    if (!roomRequestIds) {
      roomRequestIds = new Set()
      connectionRooms.set(room, roomRequestIds)
    }
    roomRequestIds.add(requestId)
    return { accepted: true, created: true }
  }

  /** Bind the slot to the verified capability without extending its short activation deadline. */
  confirmPendingEditorReservation(
    room: string,
    conn: Conn<S>,
    requestId: string,
    expiresAt: number,
  ): number | undefined {
    const reservation = this.pendingReservationsByRoom.get(room)?.get(conn)?.get(requestId)
    const now = this.now()
    if (!reservation || reservation.expiresAt <= now || !Number.isFinite(expiresAt) || expiresAt <= now) {
      this.releasePendingEditorReservation(room, conn, requestId)
      return undefined
    }
    reservation.expiresAt = Math.min(
      reservation.expiresAt,
      expiresAt,
      now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
    )
    return reservation.expiresAt
  }

  hasPendingEditorReservation(room: string, conn: Conn<S>, requestId: string): boolean {
    const reservation = this.pendingReservationsByRoom.get(room)?.get(conn)?.get(requestId)
    return reservation !== undefined && reservation.expiresAt > this.now()
  }

  releasePendingEditorReservation(room: string, conn: Conn<S>, requestId?: string): void {
    const roomReservations = this.pendingReservationsByRoom.get(room)
    const connectionReservations = roomReservations?.get(conn)
    if (!roomReservations || !connectionReservations) {
      return
    }

    const connectionRooms = this.pendingReservationsByConn.get(conn)
    const roomRequestIds = connectionRooms?.get(room)
    if (requestId) {
      connectionReservations.delete(requestId)
      roomRequestIds?.delete(requestId)
    } else {
      connectionReservations.clear()
      roomRequestIds?.clear()
    }
    if (connectionReservations.size === 0) {
      roomReservations.delete(conn)
      connectionRooms?.delete(room)
    }
    if (roomReservations.size === 0) {
      this.pendingReservationsByRoom.delete(room)
    }
    if (connectionRooms?.size === 0) {
      this.pendingReservationsByConn.delete(conn)
    }
  }

  pendingReservationCountForConn(conn: Conn<S>): number {
    let count = 0
    for (const requestIds of this.pendingReservationsByConn.get(conn)?.values() ?? []) {
      count += requestIds.size
    }
    return count
  }

  pendingReservationCountForRoom(room: string): number {
    let count = 0
    for (const reservations of this.pendingReservationsByRoom.get(room)?.values() ?? []) {
      count += reservations.size
    }
    return count
  }

  takeExpiredPendingEditorReservationsForConn(conn: Conn<S>): ExpiredPendingEditorReservation<S>[] {
    const connectionRooms = this.pendingReservationsByConn.get(conn)
    if (!connectionRooms) {
      return []
    }
    return [...connectionRooms.keys()].flatMap((room) => this.takeExpiredPendingEditorReservationsInRoom(room, conn))
  }

  takeExpiredPendingEditorReservationsForRoom(room: string): ExpiredPendingEditorReservation<S>[] {
    if (!this.pendingReservationsByRoom.has(room)) {
      return []
    }
    return this.takeExpiredPendingEditorReservationsInRoom(room)
  }

  /** Atomically consume both the connection and aggregate room control budget. */
  allowControlFrame(kind: ControlFrameKind, room: string, conn: Conn<S>): boolean {
    const now = this.now()
    this.pruneControlRooms(now)
    const connectionWindows = this.controlWindowsByConn.get(conn) ?? this.newControlWindows(now)
    const connectionWindow = this.currentControlWindow(connectionWindows[kind], now)
    const limits = CONTROL_FRAME_LIMITS[kind]
    if (connectionWindow.count >= limits.connection) {
      return false
    }
    let roomWindows = this.controlWindowsByRoom.get(room)
    if (!roomWindows) {
      if (this.controlWindowsByRoom.size >= MAX_TRACKED_CONTROL_ROOMS) {
        return false
      }
      roomWindows = this.newControlWindows(now)
      this.controlWindowsByRoom.set(room, roomWindows)
    }

    const roomWindow = this.currentControlWindow(roomWindows[kind], now)
    if (roomWindow.count >= limits.room) {
      return false
    }
    connectionWindow.count += 1
    roomWindow.count += 1
    this.controlWindowsByConn.set(conn, connectionWindows)
    return true
  }

  requestLease(
    room: string,
    conn: Conn<S>,
    requestId: string,
  ): { role: RoomLeaseRole; shouldBootstrap: boolean } | undefined {
    const membership = this.byRoom.get(room)?.get(conn)
    if (!membership || !this.pruneExpiredLeases(room, conn, membership)) {
      return undefined
    }
    const lease = membership.requestIds.get(requestId)
    return lease ? { role: lease.role, shouldBootstrap: lease.shouldBootstrap } : undefined
  }

  /**
   * Bind one distributed response-claim grant to the exact local socket and
   * editor lease that won it. The absolute expiry is supplied by the Redis
   * lifecycle so the local permission never outlives the global NX claim.
   */
  recordYjsResponseGrant(
    room: string,
    conn: Conn<S>,
    stateRequestId: string,
    leaseRequestId: string,
    expiresAt: number,
  ): boolean {
    const now = this.now()
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      this.requestLease(room, conn, leaseRequestId)?.role !== 'editor'
    ) {
      return false
    }
    this.pruneExpiredYjsResponseGrantsForRoom(room, now)
    this.pruneExpiredYjsResponseGrantsForConnection(conn, now)
    const existing = this.yjsResponseGrantsByRoom.get(room)?.get(conn)?.get(stateRequestId)
    if (existing) {
      return false
    }
    if (
      this.yjsResponseGrantCountForConnection(conn) >= MAX_ACTIVE_YJS_RESPONSE_GRANTS_PER_CONNECTION ||
      this.yjsResponseGrantCountForRoom(room) >= MAX_ACTIVE_YJS_RESPONSE_GRANTS_PER_ROOM
    ) {
      return false
    }
    let roomGrants = this.yjsResponseGrantsByRoom.get(room)
    if (!roomGrants) {
      roomGrants = new Map()
      this.yjsResponseGrantsByRoom.set(room, roomGrants)
    }
    let connectionGrants = roomGrants.get(conn)
    if (!connectionGrants) {
      connectionGrants = new Map()
      roomGrants.set(conn, connectionGrants)
    }
    connectionGrants.set(stateRequestId, { leaseRequestId, expiresAt })
    let connectionRooms = this.yjsResponseGrantRoomsByConn.get(conn)
    if (!connectionRooms) {
      connectionRooms = new Set()
      this.yjsResponseGrantRoomsByConn.set(conn, connectionRooms)
    }
    connectionRooms.add(room)
    return true
  }

  /**
   * Authorize one correlated full-state frame against its exact local grant.
   * Uncorrelated Yjs bootstrap/incremental traffic intentionally bypasses this
   * response-only gate. A single-frame response consumes immediately; chunks
   * bind one transfer shape and consume only after every unique index arrives.
   */
  authorizeYjsResponseFrame(
    room: string,
    conn: Conn<S>,
    frame: Extract<RelayFrame, { t: 'yjs' | 'yjs-chunk' }>,
  ): YjsResponseFrameDisposition {
    const stateRequestId = frame.stateRequestId
    if (!stateRequestId) {
      return 'uncorrelated'
    }
    const now = this.now()
    const grant = this.yjsResponseGrantsByRoom.get(room)?.get(conn)?.get(stateRequestId)
    if (!grant) {
      return 'denied'
    }
    if (grant.expiresAt <= now || this.requestLease(room, conn, grant.leaseRequestId)?.role !== 'editor') {
      this.deleteYjsResponseGrant(room, conn, stateRequestId)
      return 'denied'
    }
    if (frame.t === 'yjs') {
      if (grant.transfer) {
        return 'denied'
      }
      this.deleteYjsResponseGrant(room, conn, stateRequestId)
      return 'complete'
    }
    if (!grant.transfer) {
      grant.transfer = {
        transferId: frame.transferId,
        count: frame.count,
        totalBytes: frame.totalBytes,
        receivedIndexes: new Set<number>(),
      }
    } else if (
      grant.transfer.transferId !== frame.transferId ||
      grant.transfer.count !== frame.count ||
      grant.transfer.totalBytes !== frame.totalBytes
    ) {
      return 'denied'
    }
    if (grant.transfer.receivedIndexes.has(frame.index)) {
      return 'denied'
    }
    grant.transfer.receivedIndexes.add(frame.index)
    if (grant.transfer.receivedIndexes.size === grant.transfer.count) {
      this.deleteYjsResponseGrant(room, conn, stateRequestId)
      return 'complete'
    }
    return 'partial'
  }

  /** Read-only admission check used before expensive capability authorization. */
  canAcceptJoin(room: string, conn: Conn<S>, requestId?: string): boolean {
    this.members(room)
    const connectionRooms = this.byConn.get(conn)
    if (!connectionRooms?.has(room) && (connectionRooms?.size ?? 0) >= MAX_ROOMS_PER_CONNECTION) {
      return false
    }
    const members = this.byRoom.get(room)
    const membership = members?.get(conn)
    if (!membership && (members?.size ?? 0) >= MAX_CONNECTIONS_PER_ROOM) {
      return false
    }
    if (!requestId || membership?.requestIds.has(requestId)) {
      return true
    }
    if ((membership?.requestIds.size ?? 0) >= MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM) {
      return false
    }
    if (this.requestLeaseCountForConn(conn) >= MAX_REQUEST_LEASES_PER_CONNECTION) {
      return false
    }
    return this.requestLeaseCountForRoom(room) < MAX_REQUEST_LEASES_PER_ROOM
  }

  private requestLeaseCountForConn(conn: Conn<S>): number {
    const connectionRooms = this.byConn.get(conn)
    if (!connectionRooms) {
      return 0
    }
    let count = 0
    for (const room of [...connectionRooms]) {
      const membership = this.byRoom.get(room)?.get(conn)
      if (membership && this.pruneExpiredLeases(room, conn, membership)) {
        count += membership.requestIds.size
      }
    }
    return count
  }

  private requestLeaseCountForRoom(room: string): number {
    let count = 0
    for (const membership of this.byRoom.get(room)?.values() ?? []) {
      count += membership.requestIds.size
    }
    return count
  }

  /** Joins one logical lease and elects exactly one editor bootstrapper. */
  join(
    room: string,
    conn: Conn<S>,
    expiresAt = Number.POSITIVE_INFINITY,
    requestId?: string,
    role: RoomLeaseRole = 'editor',
    shouldBootstrapOverride?: boolean,
  ): { joined: boolean; shouldBootstrap: boolean } {
    if (expiresAt <= this.now() || (expiresAt !== Number.POSITIVE_INFINITY && !Number.isFinite(expiresAt))) {
      return { joined: false, shouldBootstrap: false }
    }
    this.members(room) // prune expired leases before bootstrap election
    const existingMembership = this.byRoom.get(room)?.get(conn)
    const existingLease = requestId ? existingMembership?.requestIds.get(requestId) : existingMembership?.legacyLease
    if (existingLease && existingLease.role !== role) {
      return { joined: false, shouldBootstrap: false }
    }
    if (!this.canAcceptJoin(room, conn, requestId)) {
      return { joined: false, shouldBootstrap: false }
    }
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
    const shouldBootstrap =
      existingLease?.shouldBootstrap ??
      (role === 'editor' ? (shouldBootstrapOverride ?? !this.hasEditorLease(room)) : false)
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
    this.removeYjsResponseGrants(room, conn, requestId)
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
    this.pruneExpiredYjsResponseGrantsForConnection(conn)
    for (const room of [...(this.yjsResponseGrantRoomsByConn.get(conn) ?? [])]) {
      this.removeYjsResponseGrants(room, conn)
    }
    for (const room of [...(this.pendingReservationsByConn.get(conn)?.keys() ?? [])]) {
      this.releasePendingEditorReservation(room, conn)
    }
    this.controlWindowsByConn.delete(conn)
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

  /** Fail closed when the distributed relay can no longer guarantee convergence. */
  denyRoom(room: string): void {
    this.removeAllYjsResponseGrantsForRoom(room)
    const members = this.byRoom.get(room)
    if (members) {
      for (const [conn, membership] of members) {
        for (const requestId of membership.requestIds.keys()) {
          this.sendDenied(conn, room, requestId)
        }
        if (membership.legacyLease) {
          this.sendDenied(conn, room)
        }
        this.byConn.get(conn)?.delete(room)
      }
      this.byRoom.delete(room)
    }
    const pending = this.pendingReservationsByRoom.get(room)
    if (pending) {
      for (const [conn, reservations] of [...pending]) {
        for (const requestId of reservations.keys()) {
          this.sendDenied(conn, room, requestId)
        }
        this.releasePendingEditorReservation(room, conn)
      }
    }
  }

  denyAllRooms(): void {
    const rooms = new Set([
      ...this.byRoom.keys(),
      ...this.pendingReservationsByRoom.keys(),
      ...this.yjsResponseGrantsByRoom.keys(),
    ])
    for (const room of rooms) {
      this.denyRoom(room)
    }
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

  /** True only while this connection owns at least one live lease for `role`. */
  hasRole(room: string, conn: Conn<S>, role: RoomLeaseRole): boolean {
    const membership = this.byRoom.get(room)?.get(conn)
    if (!membership || !this.pruneExpiredLeases(room, conn, membership)) {
      return false
    }
    if (membership.legacyLease?.role === role) {
      return true
    }
    for (const lease of membership.requestIds.values()) {
      if (lease.role === role) {
        return true
      }
    }
    return false
  }

  /** Proactively evict expired memberships and return reservations needing distributed release. */
  evictExpired(): ExpiredPendingEditorReservation<S>[] {
    for (const room of [...this.byRoom.keys()]) {
      this.members(room)
    }
    for (const room of [...this.yjsResponseGrantsByRoom.keys()]) {
      this.pruneExpiredYjsResponseGrantsForRoom(room)
    }
    return [...this.pendingReservationsByRoom.keys()].flatMap((room) =>
      this.takeExpiredPendingEditorReservationsInRoom(room),
    )
  }

  private pruneExpiredLeases(room: string, conn: Conn<S>, membership: RoomMembership): boolean {
    const now = this.now()
    for (const [requestId, lease] of [...membership.requestIds]) {
      if (lease.expiresAt <= now) {
        this.removeYjsResponseGrants(room, conn, requestId)
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

  private takeExpiredPendingEditorReservationsInRoom(
    room: string,
    onlyConnection?: Conn<S>,
  ): ExpiredPendingEditorReservation<S>[] {
    const now = this.now()
    const expired: ExpiredPendingEditorReservation<S>[] = []
    const roomReservations = this.pendingReservationsByRoom.get(room)
    if (!roomReservations) {
      return expired
    }
    for (const [conn, reservations] of [...roomReservations]) {
      if (onlyConnection && conn !== onlyConnection) {
        continue
      }
      for (const [requestId, reservation] of [...reservations]) {
        if (reservation.expiresAt <= now) {
          expired.push({ conn, room, requestId })
          this.releasePendingEditorReservation(room, conn, requestId)
        }
      }
    }
    return expired
  }

  private deleteYjsResponseGrant(room: string, conn: Conn<S>, stateRequestId: string): void {
    const roomGrants = this.yjsResponseGrantsByRoom.get(room)
    const connectionGrants = roomGrants?.get(conn)
    if (!roomGrants || !connectionGrants) {
      return
    }
    connectionGrants.delete(stateRequestId)
    if (connectionGrants.size === 0) {
      roomGrants.delete(conn)
      const connectionRooms = this.yjsResponseGrantRoomsByConn.get(conn)
      connectionRooms?.delete(room)
      if (connectionRooms?.size === 0) {
        this.yjsResponseGrantRoomsByConn.delete(conn)
      }
    }
    if (roomGrants.size === 0) {
      this.yjsResponseGrantsByRoom.delete(room)
    }
  }

  private removeAllYjsResponseGrantsForRoom(room: string): void {
    const roomGrants = this.yjsResponseGrantsByRoom.get(room)
    if (!roomGrants) {
      return
    }
    for (const [conn, connectionGrants] of [...roomGrants]) {
      for (const stateRequestId of [...connectionGrants.keys()]) {
        this.deleteYjsResponseGrant(room, conn, stateRequestId)
      }
    }
  }

  private removeYjsResponseGrants(room: string, conn: Conn<S>, leaseRequestId?: string): void {
    const connectionGrants = this.yjsResponseGrantsByRoom.get(room)?.get(conn)
    if (!connectionGrants) {
      return
    }
    for (const [stateRequestId, grant] of [...connectionGrants]) {
      if (leaseRequestId === undefined || grant.leaseRequestId === leaseRequestId) {
        this.deleteYjsResponseGrant(room, conn, stateRequestId)
      }
    }
  }

  private pruneExpiredYjsResponseGrantsForRoom(room: string, now = this.now()): void {
    const roomGrants = this.yjsResponseGrantsByRoom.get(room)
    if (!roomGrants) {
      return
    }
    for (const [conn, connectionGrants] of [...roomGrants]) {
      for (const [stateRequestId, grant] of [...connectionGrants]) {
        if (grant.expiresAt <= now) {
          this.deleteYjsResponseGrant(room, conn, stateRequestId)
        }
      }
    }
  }

  private pruneExpiredYjsResponseGrantsForConnection(conn: Conn<S>, now = this.now()): void {
    for (const room of [...(this.yjsResponseGrantRoomsByConn.get(conn) ?? [])]) {
      const connectionGrants = this.yjsResponseGrantsByRoom.get(room)?.get(conn)
      if (!connectionGrants) {
        continue
      }
      for (const [stateRequestId, grant] of [...connectionGrants]) {
        if (grant.expiresAt <= now) {
          this.deleteYjsResponseGrant(room, conn, stateRequestId)
        }
      }
    }
  }

  private yjsResponseGrantCountForConnection(conn: Conn<S>): number {
    let count = 0
    for (const room of this.yjsResponseGrantRoomsByConn.get(conn) ?? []) {
      count += this.yjsResponseGrantsByRoom.get(room)?.get(conn)?.size ?? 0
    }
    return count
  }

  private yjsResponseGrantCountForRoom(room: string): number {
    let count = 0
    for (const connectionGrants of this.yjsResponseGrantsByRoom.get(room)?.values() ?? []) {
      count += connectionGrants.size
    }
    return count
  }

  private newControlWindows(now: number): ControlWindows {
    return {
      'room-reserve': { startedAt: now, count: 0 },
      'room-join': { startedAt: now, count: 0 },
      'yjs-retry': { startedAt: now, count: 0 },
      'yjs-response-claim': { startedAt: now, count: 0 },
    }
  }

  private currentControlWindow(window: ControlWindow, now: number): ControlWindow {
    if (now - window.startedAt >= CONTROL_FRAME_WINDOW_MS) {
      window.startedAt = now
      window.count = 0
    }
    return window
  }

  private pruneControlRooms(now: number): void {
    for (const [room, windows] of this.controlWindowsByRoom) {
      if (
        now - windows['room-reserve'].startedAt >= CONTROL_FRAME_WINDOW_MS &&
        now - windows['room-join'].startedAt >= CONTROL_FRAME_WINDOW_MS &&
        now - windows['yjs-retry'].startedAt >= CONTROL_FRAME_WINDOW_MS &&
        now - windows['yjs-response-claim'].startedAt >= CONTROL_FRAME_WINDOW_MS
      ) {
        this.controlWindowsByRoom.delete(room)
      }
    }
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

  /** Broadcast a frame received from another gateway replica to all local members. */
  broadcastAll(room: string, message: string): number {
    let sent = 0
    for (const member of this.members(room)) {
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

export interface RoomRelayLifecycle<S extends SendableSocket = SendableSocket> {
  reserveEditorLease(
    conn: Conn<S>,
    room: string,
    requestId: string,
    expiresAt: number,
    protocolVersion: 2,
    serverUpdatedAtTimestamp: number,
  ): Promise<{ shouldBootstrap: boolean; bootstrapChallenge?: string }>
  activateEditorLease(
    conn: Conn<S>,
    room: string,
    requestId: string,
    expiresAt: number,
    protocolVersion: 2,
    serverUpdatedAtTimestamp: number,
    bootstrapChallenge?: string,
  ): Promise<{ shouldBootstrap: boolean }>
  releaseLease(conn: Conn<S>, room: string, requestId: string | undefined): Promise<void>
  /** Absolute local expiry when granted; undefined means this claimant lost. */
  claimYjsResponse(
    conn: Conn<S>,
    room: string,
    stateRequestId: string,
    leaseRequestId: string,
  ): Promise<number | undefined>
  publish(
    frame:
      | Extract<RelayFrame, { t: 'yjs' | 'yjs-chunk' | 'yjs-retry' | 'awareness' | 'comment' }>
      | { t: 'room-sync'; room: string },
  ): Promise<void>
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
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 2
      leaseRequestId?: string
      bootstrapChallenge?: string
    }

export type RoomJoinAuthorizer = (
  userUuid: string,
  room: string,
  capability?: string,
) => RoomJoinAuthorization | Promise<RoomJoinAuthorization>

function ignoreLifecycleReleaseFailure(): undefined {
  return undefined
}

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
  lifecycle?: RoomRelayLifecycle<S>,
): Promise<number> {
  if (isConnectionActive && !isConnectionActive()) {
    return 0
  }
  const deny = (room: string, requestId?: string): number => {
    try {
      conn.socket.send(JSON.stringify({ t: 'room-denied', room, ...(requestId ? { requestId } : {}) }))
    } catch {
      /* socket unwritable */
    }
    return 0
  }
  const authorizeCapability = async (room: string, capability?: string): Promise<RoomJoinAuthorization> => {
    if (!authorize) {
      return {
        authorized: true,
        expiresAt: Number.POSITIVE_INFINITY,
        serverUpdatedAtTimestamp: 1,
        collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      }
    }
    try {
      return await authorize(conn.userUuid, room, capability)
    } catch {
      return { authorized: false }
    }
  }
  switch (frame.t) {
    case 'room-reserve': {
      if (!lifecycle) {
        return deny(frame.room, frame.requestId)
      }
      if (!rooms.allowControlFrame('room-reserve', frame.room, conn)) {
        return deny(frame.room, frame.requestId)
      }
      const expiredReservations = [
        ...rooms.takeExpiredPendingEditorReservationsForConn(conn),
        ...rooms.takeExpiredPendingEditorReservationsForRoom(frame.room),
      ]
      await Promise.all(
        expiredReservations.map((expired) =>
          lifecycle.releaseLease(expired.conn, expired.room, expired.requestId).catch(ignoreLifecycleReleaseFailure),
        ),
      )
      const slot = rooms.reservePendingEditorSlot(frame.room, conn, frame.requestId)
      if (!slot.accepted) {
        return deny(frame.room, frame.requestId)
      }
      const authorization = await authorizeCapability(frame.room, frame.cap)
      if (
        !authorization.authorized ||
        authorization.collaborationProtocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
        authorization.leaseRequestId !== frame.requestId ||
        authorization.bootstrapChallenge !== undefined
      ) {
        if (slot.created) {
          rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
        }
        return deny(frame.room, frame.requestId)
      }
      if (isConnectionActive && !isConnectionActive()) {
        rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
        return 0
      }
      const activationDeadline = rooms.confirmPendingEditorReservation(
        frame.room,
        conn,
        frame.requestId,
        authorization.expiresAt,
      )
      if (activationDeadline === undefined) {
        return deny(frame.room, frame.requestId)
      }
      try {
        const reservation = await lifecycle.reserveEditorLease(
          conn,
          frame.room,
          frame.requestId,
          activationDeadline,
          COLLABORATION_PROTOCOL_VERSION,
          authorization.serverUpdatedAtTimestamp,
        )
        if (
          (isConnectionActive && !isConnectionActive()) ||
          !rooms.hasPendingEditorReservation(frame.room, conn, frame.requestId)
        ) {
          rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
          await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
          return 0
        }
        conn.socket.send(
          JSON.stringify({
            t: 'room-reserved',
            room: frame.room,
            requestId: frame.requestId,
            bootstrap: reservation.shouldBootstrap,
            ...(reservation.bootstrapChallenge ? { bootstrapChallenge: reservation.bootstrapChallenge } : {}),
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          }),
        )
      } catch {
        rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
        await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
        return deny(frame.room, frame.requestId)
      }
      return 0
    }
    case 'room-join': {
      const requestedRole = frame.role ?? 'editor'
      const productionProtocolRequired = authorize !== undefined || lifecycle !== undefined
      const existingRequestLease = frame.requestId ? rooms.requestLease(frame.room, conn, frame.requestId) : undefined

      // React StrictMode and reconnect churn may replay an already-active
      // logical join. Acknowledge that exact lease without re-authorizing,
      // refreshing its expiry, activating Redis again, or broadcasting another
      // room-wide sync request. Conflicting role reuse is ignored without
      // evicting the valid lease that already owns this request id.
      if (existingRequestLease) {
        if (existingRequestLease.role !== requestedRole) {
          if (existingRequestLease.role === 'comment' && requestedRole === 'editor' && frame.requestId) {
            rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
            if (lifecycle) {
              await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
            }
          }
          return 0
        }
        if (productionProtocolRequired && frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
          return 0
        }
        if (requestedRole === 'editor' && frame.requestId) {
          rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
        }
        if (isConnectionActive && !isConnectionActive()) {
          return 0
        }
        try {
          conn.socket.send(
            JSON.stringify({
              t: 'room-joined',
              room: frame.room,
              ...(frame.requestId ? { requestId: frame.requestId } : {}),
              ...(requestedRole === 'editor' ? { bootstrap: existingRequestLease.shouldBootstrap } : {}),
              ...(productionProtocolRequired
                ? {
                    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
                    maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
                  }
                : {}),
            }),
          )
        } catch {
          /* An unwritable replay does not revoke the still-valid logical lease. */
        }
        return 0
      }

      const releaseJoinAttempt = async (): Promise<void> => {
        if (requestedRole === 'editor' && frame.requestId) {
          rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
          if (lifecycle) {
            await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
          }
        }
      }
      const denyJoin = async (): Promise<number> => {
        await releaseJoinAttempt()
        return deny(frame.room, frame.requestId)
      }
      if (
        lifecycle &&
        requestedRole === 'editor' &&
        (!frame.requestId || !rooms.hasPendingEditorReservation(frame.room, conn, frame.requestId))
      ) {
        return denyJoin()
      }
      if (!rooms.canAcceptJoin(frame.room, conn, frame.requestId)) {
        return denyJoin()
      }
      if (!rooms.allowControlFrame('room-join', frame.room, conn)) {
        return denyJoin()
      }
      const authorization = await authorizeCapability(frame.room, frame.cap)
      if (!authorization.authorized) {
        return denyJoin()
      }
      // Authorization can be asynchronous. A socket that closed while it was
      // in flight must never be resurrected into a room or receive an ack.
      if (isConnectionActive && !isConnectionActive()) {
        await releaseJoinAttempt()
        return 0
      }
      let shouldBootstrapOverride: boolean | undefined
      let reservedEditorLease = false
      if (
        productionProtocolRequired &&
        (frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
          authorization.collaborationProtocolVersion !== COLLABORATION_PROTOCOL_VERSION)
      ) {
        return denyJoin()
      }
      if (requestedRole === 'editor' && lifecycle) {
        if (
          !frame.requestId ||
          authorization.leaseRequestId !== frame.requestId ||
          frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION
        ) {
          return denyJoin()
        }
        try {
          shouldBootstrapOverride = (
            await lifecycle.activateEditorLease(
              conn,
              frame.room,
              frame.requestId,
              authorization.expiresAt,
              COLLABORATION_PROTOCOL_VERSION,
              authorization.serverUpdatedAtTimestamp,
              authorization.bootstrapChallenge,
            )
          ).shouldBootstrap
          reservedEditorLease = true
          if (isConnectionActive && !isConnectionActive()) {
            rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
            await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
            return 0
          }
        } catch {
          return denyJoin()
        }
      }
      const joinResult = rooms.join(
        frame.room,
        conn,
        authorization.expiresAt,
        frame.requestId,
        requestedRole,
        shouldBootstrapOverride,
      )
      if (!joinResult.joined) {
        rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
        if (lifecycle && reservedEditorLease) {
          await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
        }
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
      if (reservedEditorLease && frame.requestId) {
        rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
      }
      try {
        conn.socket.send(
          JSON.stringify({
            t: 'room-joined',
            room: frame.room,
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
            ...(requestedRole === 'editor' ? { bootstrap: joinResult.shouldBootstrap } : {}),
            ...(productionProtocolRequired
              ? {
                  protocolVersion: COLLABORATION_PROTOCOL_VERSION,
                  maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
                }
              : {}),
          }),
        )
      } catch {
        rooms.leave(frame.room, conn, frame.requestId)
        if (lifecycle && reservedEditorLease) {
          await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
        }
        return 0
      }
      // Protocol-v2 editors explicitly request one correlated full-state retry
      // after activation. Do not also fan out the legacy room-sync request: it
      // creates redundant full-state responses and defeats responder election.
      if (requestedRole === 'comment' || frame.protocolVersion === COLLABORATION_PROTOCOL_VERSION) {
        return 0
      }
      const syncFrame = { t: 'room-sync' as const, room: frame.room }
      if (lifecycle) {
        try {
          await lifecycle.publish(syncFrame)
        } catch {
          rooms.denyRoom(frame.room)
          return 0
        }
      }
      return rooms.broadcast(frame.room, JSON.stringify(syncFrame), conn)
    }
    case 'room-leave':
      rooms.leave(frame.room, conn, frame.requestId)
      rooms.releasePendingEditorReservation(frame.room, conn, frame.requestId)
      if (lifecycle) {
        await lifecycle.releaseLease(conn, frame.room, frame.requestId).catch(ignoreLifecycleReleaseFailure)
      }
      return 0
    case 'yjs-response-claim': {
      const exactLease = rooms.requestLease(frame.room, conn, frame.leaseRequestId)
      if (
        exactLease?.role !== 'editor' ||
        !lifecycle ||
        !rooms.allowControlFrame('yjs-response-claim', frame.room, conn)
      ) {
        return 0
      }
      let grantExpiresAt: number | undefined
      try {
        grantExpiresAt = await lifecycle.claimYjsResponse(conn, frame.room, frame.stateRequestId, frame.leaseRequestId)
      } catch {
        return 0
      }
      if (
        grantExpiresAt === undefined ||
        (isConnectionActive && !isConnectionActive()) ||
        !rooms.recordYjsResponseGrant(frame.room, conn, frame.stateRequestId, frame.leaseRequestId, grantExpiresAt)
      ) {
        return 0
      }
      try {
        conn.socket.send(
          JSON.stringify({
            t: 'yjs-response-granted',
            room: frame.room,
            stateRequestId: frame.stateRequestId,
            leaseRequestId: frame.leaseRequestId,
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          }),
        )
      } catch {
        rooms.leave(frame.room, conn, frame.leaseRequestId)
        await lifecycle.releaseLease(conn, frame.room, frame.leaseRequestId).catch(ignoreLifecycleReleaseFailure)
      }
      return 0
    }
    case 'yjs':
    case 'yjs-chunk':
    case 'yjs-retry':
    case 'awareness':
    case 'comment':
      // Fail closed on the SEND path too: only a current, unexpired member may
      // inject content. Comment-only leases deliberately cannot inject editor
      // or presence traffic; an editor lease may also comment. A mixed socket
      // retains only the privileges of whichever leases remain unexpired.
      if (
        (frame.t === 'comment' && !rooms.isMember(frame.room, conn)) ||
        (frame.t !== 'comment' && !rooms.hasRole(frame.room, conn, 'editor'))
      ) {
        return 0
      }
      if (frame.t === 'yjs-retry' && !rooms.allowControlFrame('yjs-retry', frame.room, conn)) {
        return 0
      }
      const yjsResponseDisposition =
        frame.t === 'yjs' || frame.t === 'yjs-chunk'
          ? rooms.authorizeYjsResponseFrame(frame.room, conn, frame)
          : undefined
      if (yjsResponseDisposition === 'denied') {
        return 0
      }
      if (lifecycle) {
        try {
          await lifecycle.publish(frame)
        } catch {
          rooms.denyRoom(frame.room)
          return 0
        }
      }
      const reached = rooms.broadcast(frame.room, JSON.stringify(frame), conn)
      const acceptedTransferId =
        frame.t === 'yjs'
          ? frame.transferId
          : frame.t === 'yjs-chunk' &&
              (frame.stateRequestId ? yjsResponseDisposition === 'complete' : frame.index === frame.count - 1)
            ? frame.transferId
            : undefined
      if (acceptedTransferId) {
        try {
          conn.socket.send(
            JSON.stringify({
              t: 'yjs-accepted',
              room: frame.room,
              transferId: acceptedTransferId,
              protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            }),
          )
        } catch {
          rooms.leave(frame.room, conn)
        }
      }
      return reached
  }
}
