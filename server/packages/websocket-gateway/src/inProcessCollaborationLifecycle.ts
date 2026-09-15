import { randomUUID } from 'node:crypto'

import type { Conn, SendableSocket } from './registry.js'
import {
  CollaborationRoomEpochMismatchError,
  PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
  collaborationErrorCode,
  roomDeniedReasonFor,
  type CollaborationLifecycleErrorCode,
  type RelayFrame,
  type RoomDeniedReason,
  type RoomPresenceLeaveReason,
  type RoomRegistry,
  type RoomRelayLifecycle,
} from './rooms.js'
import {
  CollaborationLifecycleError,
  CollaborationRoomSecurityRevokedError,
  COLLABORATION_PRESENCE_TTL_MS,
  MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM,
  YJS_RESPONSE_CLAIM_TTL_MS,
} from './collaborationRedisBridge.js'
import type { Logger } from './redisBridge.js'

// ---------------------------------------------------------------------------
// Single-process collaboration plane.
//
// The Redis bridge exists so several gateway replicas agree on ONE Lexical
// bootstrapper per room, on the room's epoch, and on which replica answers a
// full-state retry. A deployment that runs exactly one gateway process -- the
// single container and the LXC image -- needs the same DECISIONS but not the
// network: every party to them is already in this process.
//
// Before this module such a deployment attached no gateway at all, so it
// shipped with no push, no live collaboration, no realtime invites and no
// push-MFA unless the operator stood up a Redis. This is the same state
// machine over Maps, and it is deliberately a mirror of the Lua in
// `collaborationRedisBridge.ts` rather than a simplification:
//
//   - a room's epoch rotates when its LAST editor lease is released, and the
//     rotated value is held as a tombstone for 24 h so a stale grant cannot
//     re-enter the room;
//   - a DENIED reserve returns without touching that tombstone's expiry (M1).
//     Re-arming it on every denial is what once kept a room unjoinable for a
//     rolling 24 h, so a note opened daily never recovered;
//   - `currentRoomEpoch` answers with the ROTATED epoch, because sync-lane
//     discovery substitutes it for the deterministic initial epoch (C4).
//
// What it is NOT: a fleet-shared store. `distribution` stays process-local
// everywhere it is reported, `health().pushBridge` is `'in-process'` rather
// than `'redis'`, and a second replica attached to the same database would get
// its own, disjoint copy of this state. Adding one is what Redis is for.
// ---------------------------------------------------------------------------

/**
 * Same 24 h tombstone the Lua arms (`ROOM_EPOCH_TOMBSTONE_TTL_MS`). It bounds
 * how long a released room refuses a grant minted against its old epoch.
 */
export const IN_PROCESS_ROOM_EPOCH_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1_000

/** Mirrors `isValidEpoch` in the Redis bridge: opaque, URL-safe, bounded. */
function isValidEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

function lifecycleError(
  code: CollaborationLifecycleErrorCode,
  message: string,
  policy = false,
): CollaborationLifecycleError {
  return new CollaborationLifecycleError(code, message, policy)
}

function relayUnhealthyError(): CollaborationLifecycleError {
  return lifecycleError('relay-unhealthy', 'In-process collaboration plane is stopped')
}

function incompatibleProtocolError(): CollaborationLifecycleError {
  return lifecycleError('incompatible-protocol', 'Incompatible collaboration protocol is active in this room', true)
}

function roomLeaseLimitError(): CollaborationLifecycleError {
  return lifecycleError('room-limit', 'Collaboration room editor lease limit exceeded', true)
}

function leaseOwnershipLostError(): CollaborationLifecycleError {
  return lifecycleError('reservation-expired', 'Collaboration lease ownership was lost', true)
}

function isLeasePolicyError(error: unknown): error is CollaborationLifecycleError {
  return error instanceof CollaborationLifecycleError && error.policy
}

type InProcessLease<S extends SendableSocket> = {
  conn: Conn<S>
  room: string
  requestId: string
  protocolVersion: 3
  roomEpoch: string
  collaborationSecurityEpoch: string
  collaborationAuthorizationIssuedAt: number
  /** The epoch this room takes once THIS lease releases it as the last one. */
  rotatedRoomEpoch: string
  reservedRevision: number
  expiresAt: number
  shouldBootstrap: boolean
  bootstrapChallenge?: string
  activated: boolean
}

type InProcessPresence<S extends SendableSocket> = {
  lease: InProcessLease<S>
  presenceId: string
  clientId: number
  expiresAt: number
}

type RoomState = {
  epoch: string
  securityEpoch: string
  issuedAt: number
  /** The tombstone deadline; only a SUCCESSFUL operation ever moves it (M1). */
  expiresAt: number
}

/**
 * The collaboration plane the gateway drives, whichever transport backs it.
 * `CollaborationRedisBridge` and `InProcessCollaborationLifecycle` both satisfy
 * it, so `attachWebSocketGateway` selects one and the rest of the file is
 * written against the decisions rather than against Redis.
 */
export interface CollaborationPlane<S extends SendableSocket = SendableSocket> extends RoomRelayLifecycle<S> {
  isRelayHealthy(): boolean
  currentRoomEpoch(room: string, collaborationSecurityEpoch: string): Promise<string | undefined>
  releaseAll(conn: Conn<S>): Promise<void>
  refreshLeases(): Promise<void>
  stop(): Promise<void>
}

export type InProcessCollaborationLifecycleOptions = {
  /** Injectable clock; the tombstone is 24 h, which no test can wait out. */
  now?: () => number
}

export class InProcessCollaborationLifecycle<S extends SendableSocket> implements CollaborationPlane<S> {
  private readonly leases = new Map<string, InProcessLease<S>>()
  private readonly presences = new Map<string, InProcessPresence<S>>()
  private readonly roomState = new Map<string, RoomState>()
  private readonly yjsResponseClaims = new Map<string, number>()
  private presenceExpiryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly now: () => number

  constructor(
    private readonly rooms: RoomRegistry<S>,
    private readonly logger: Logger,
    options: InProcessCollaborationLifecycleOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  /**
   * Always true while attached: the "relay" is a function call, so there is no
   * connection to lose. It goes false on `stop()` for the same reason the Redis
   * bridge's does -- a stopping gateway must deny rather than accept.
   */
  isRelayHealthy(): boolean {
    return !this.stopped
  }

  /**
   * C4. The room's CURRENT epoch for one security generation, so a room that
   * rotated when its last editor left is re-enterable with the one-use
   * challenge binding intact. Undefined when the room carries no live state or
   * the state belongs to another security generation.
   */
  async currentRoomEpoch(room: string, collaborationSecurityEpoch: string): Promise<string | undefined> {
    if (typeof room !== 'string' || room.length === 0 || !isValidEpoch(collaborationSecurityEpoch)) {
      return undefined
    }
    const state = this.stateOf(room)
    return state && state.securityEpoch === collaborationSecurityEpoch && isValidEpoch(state.epoch)
      ? state.epoch
      : undefined
  }

  /**
   * C2. True when any OTHER connection holds an activated editor lease for the
   * room. There are no remote leases to be unsure about here, so -- unlike the
   * Redis path, which errs towards "someone may still answer" -- a false is a
   * fact, and the client fails over immediately instead of waiting 80 s.
   */
  async hasOtherActivatedEditorLease(conn: Conn<S>, room: string): Promise<boolean> {
    const now = this.now()
    for (const lease of this.leases.values()) {
      if (lease.room === room && lease.conn !== conn && lease.activated && lease.expiresAt > now) {
        return true
      }
    }
    return false
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
    collaborationAuthorizationIssuedAt = this.now(),
  ): Promise<{ shouldBootstrap: boolean; bootstrapChallenge?: string }> {
    if (this.stopped) {
      throw relayUnhealthyError()
    }
    const now = this.now()
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

    const localId = this.localLeaseId(conn, room, requestId)
    const existing = this.leases.get(localId)
    if (existing) {
      return this.replayReservation(existing, protocolVersion, roomEpoch, collaborationSecurityEpoch, expiresAt, now)
    }

    try {
      return this.electLease(
        conn,
        localId,
        room,
        requestId,
        expiresAt,
        protocolVersion,
        serverUpdatedAtTimestamp,
        roomEpoch,
        collaborationSecurityEpoch,
        collaborationAuthorizationIssuedAt,
        now,
      )
    } catch (error) {
      this.warnDenial('lease-reservation', error)
      if (error instanceof CollaborationRoomSecurityRevokedError) {
        await this.discardRevokedRoom(room)
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
    collaborationAuthorizationIssuedAt = this.now(),
  ): Promise<{ shouldBootstrap: boolean }> {
    if (this.stopped) {
      throw relayUnhealthyError()
    }
    const now = this.now()
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
      this.refresh(lease, now)
    } catch (error) {
      this.warnDenial('lease-activation', error)
      if (isLeasePolicyError(error)) {
        await this.denyAndReleaseRoom(room, roomDeniedReasonFor(error))
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
    if (this.stopped) {
      throw relayUnhealthyError()
    }
    const localId = this.localLeaseId(conn, room, requestId)
    const lease = this.leases.get(localId)
    const now = this.now()
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
      // NOT a policy error, matching the Redis bridge exactly: a lease-policy
      // failure makes the caller deny and release the whole ROOM, and hitting
      // the presence cap must cost this heartbeat alone.
      throw lifecycleError('room-limit', 'Collaboration room presence limit exceeded')
    }

    const presence: InProcessPresence<S> = {
      lease,
      presenceId: randomUUID(),
      clientId,
      expiresAt: now + COLLABORATION_PRESENCE_TTL_MS,
    }
    this.presences.set(localId, presence)
    this.rooms.broadcastAll(
      room,
      JSON.stringify({
        t: 'room-presence',
        room,
        roomEpoch,
        protocolVersion: 3,
        action: 'joined',
        presenceId: presence.presenceId,
        userUuid: conn.userUuid,
        clientId,
        ttlMilliseconds: COLLABORATION_PRESENCE_TTL_MS,
      }),
    )
    this.schedulePresenceExpiry()
  }

  async releaseLease(
    conn: Conn<S>,
    room: string,
    requestId: string | undefined,
    reason: RoomPresenceLeaveReason = 'disconnect',
  ): Promise<void> {
    const localId = this.localLeaseId(conn, room, requestId)
    const lease = this.leases.get(localId)
    if (!lease) {
      return
    }
    this.leases.delete(localId)
    this.releasePresence(lease, reason)
    this.release(lease)
  }

  /**
   * One responder per outstanding full-state request, exactly as the NX claim
   * does across replicas. Undefined means another activated editor already
   * took this request id.
   */
  async claimYjsResponse(
    conn: Conn<S>,
    room: string,
    stateRequestId: string,
    leaseRequestId: string,
  ): Promise<number | undefined> {
    if (this.stopped) {
      throw relayUnhealthyError()
    }
    const localId = this.localLeaseId(conn, room, leaseRequestId)
    const lease = this.leases.get(localId)
    if (!lease || !lease.activated) {
      return undefined
    }
    const now = this.now()
    if (lease.expiresAt <= now) {
      this.leases.delete(localId)
      this.release(lease)
      return undefined
    }
    const claimKey = `${room}\u0000${stateRequestId}`
    const heldUntil = this.yjsResponseClaims.get(claimKey)
    if (heldUntil !== undefined && heldUntil > now) {
      return undefined
    }
    const claimExpiresAt = now + YJS_RESPONSE_CLAIM_TTL_MS
    this.yjsResponseClaims.set(claimKey, claimExpiresAt)
    this.pruneYjsResponseClaims(now)
    return claimExpiresAt
  }

  /**
   * Nothing to relay: every member of every room is served by this process, and
   * `handleRelayFrame` has already broadcast to them. Kept as a resolved
   * promise (never a rejection) so the caller's ordered relay chain behaves
   * identically to the Redis path's success case.
   */
  async publish(
    _frame:
      | Extract<RelayFrame, { t: 'yjs' | 'yjs-chunk' | 'yjs-retry' | 'awareness' | 'comment' }>
      | { t: 'room-sync'; room: string },
  ): Promise<void> {
    if (this.stopped) {
      throw relayUnhealthyError()
    }
  }

  async releaseAll(conn: Conn<S>): Promise<void> {
    for (const [localId, lease] of [...this.leases.entries()]) {
      if (lease.conn !== conn) {
        continue
      }
      this.leases.delete(localId)
      this.releasePresence(lease, 'disconnect')
      this.release(lease)
    }
  }

  /** Driven by the gateway heartbeat: evicts elapsed leases and sweeps state. */
  async refreshLeases(): Promise<void> {
    const now = this.now()
    const policyFailureRooms = new Map<string, RoomDeniedReason>()
    for (const [localId, lease] of [...this.leases.entries()]) {
      if (Number.isFinite(lease.expiresAt) && lease.expiresAt <= now) {
        this.leases.delete(localId)
        this.releasePresence(lease, 'revoked')
        this.release(lease)
        continue
      }
      try {
        this.refresh(lease, now)
      } catch (error) {
        if (isLeasePolicyError(error)) {
          policyFailureRooms.set(lease.room, roomDeniedReasonFor(error))
        }
        this.warnDenial('lease-refresh', error)
      }
    }
    for (const [room, reason] of policyFailureRooms) {
      await this.denyAndReleaseRoom(room, reason)
    }
    this.pruneYjsResponseClaims(now)
    this.pruneRoomState(now)
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopped = true
    if (this.presenceExpiryTimer) {
      clearTimeout(this.presenceExpiryTimer)
      this.presenceExpiryTimer = undefined
    }
    for (const presence of [...this.presences.values()]) {
      this.releasePresence(presence.lease, 'disconnect')
    }
    this.rooms.denyAllRooms('relay-unhealthy')
    // Release every remaining lease so a room's epoch rotates on shutdown
    // exactly as it would on a clean leave; the next boot starts from state
    // this process no longer holds, and a stale grant must still be refused.
    for (const [localId, lease] of [...this.leases.entries()]) {
      this.leases.delete(localId)
      this.release(lease)
    }
    this.yjsResponseClaims.clear()
  }

  /**
   * An active logical lease may replay `room-reserve` during reconnect churn.
   * Read-only for an already-activated lease: a provisional 15 s deadline must
   * never shorten or extend the authorized one.
   */
  private replayReservation(
    existing: InProcessLease<S>,
    protocolVersion: 3,
    roomEpoch: string,
    collaborationSecurityEpoch: string,
    expiresAt: number,
    now: number,
  ): { shouldBootstrap: boolean; bootstrapChallenge?: string } {
    if (
      existing.protocolVersion !== protocolVersion ||
      existing.roomEpoch !== roomEpoch ||
      existing.collaborationSecurityEpoch !== collaborationSecurityEpoch
    ) {
      throw new CollaborationRoomEpochMismatchError(existing.roomEpoch)
    }
    if (!existing.activated) {
      existing.expiresAt = Math.min(
        existing.expiresAt,
        expiresAt,
        now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
      )
      this.refresh(existing, now)
    }
    return {
      shouldBootstrap: existing.shouldBootstrap,
      ...(existing.bootstrapChallenge ? { bootstrapChallenge: existing.bootstrapChallenge } : {}),
    }
  }

  /**
   * The election, mirroring SRN_RESERVE_LEASE_V3 clause for clause.
   *
   * *** M1 ***: both denial returns leave the room state's expiry ALONE. Only
   * the success path at the end re-arms the tombstone. A room whose epoch has
   * rotated therefore becomes joinable again 24 h after the release, however
   * many stale grants are presented in the meantime.
   */
  private electLease(
    conn: Conn<S>,
    localId: string,
    room: string,
    requestId: string,
    expiresAt: number,
    protocolVersion: 3,
    serverUpdatedAtTimestamp: number,
    roomEpoch: string,
    collaborationSecurityEpoch: string,
    collaborationAuthorizationIssuedAt: number,
    now: number,
  ): { shouldBootstrap: boolean; bootstrapChallenge?: string } {
    const live = this.liveLeases(room, now)
    if (live.some((lease) => lease.protocolVersion !== protocolVersion)) {
      throw incompatibleProtocolError()
    }
    const rotatedRoomEpoch = randomUUID()
    const state = this.stateOf(room, now)
    if (!state) {
      if (live.length > 0) {
        // The state expired under live leases: the room's generation can no
        // longer be proven, so it is rotated and every holder is evicted.
        this.evictRoomLeases(room)
        this.setState(room, rotatedRoomEpoch, collaborationSecurityEpoch, collaborationAuthorizationIssuedAt, now)
        throw new CollaborationRoomSecurityRevokedError(rotatedRoomEpoch)
      }
      this.setState(room, roomEpoch, collaborationSecurityEpoch, collaborationAuthorizationIssuedAt, now)
    } else if (state.securityEpoch !== collaborationSecurityEpoch) {
      if (collaborationAuthorizationIssuedAt <= state.issuedAt) {
        throw new CollaborationRoomEpochMismatchError(state.epoch)
      }
      this.evictRoomLeases(room)
      this.setState(room, rotatedRoomEpoch, collaborationSecurityEpoch, collaborationAuthorizationIssuedAt, now)
      throw new CollaborationRoomSecurityRevokedError(rotatedRoomEpoch)
    } else if (state.epoch !== roomEpoch) {
      throw new CollaborationRoomEpochMismatchError(state.epoch)
    }

    if (live.length >= MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM) {
      throw roomLeaseLimitError()
    }

    const shouldBootstrap = live.length === 0
    const bootstrapChallenge = shouldBootstrap ? randomUUID() : undefined
    this.leases.set(localId, {
      conn,
      room,
      requestId,
      protocolVersion,
      roomEpoch,
      collaborationSecurityEpoch,
      collaborationAuthorizationIssuedAt,
      rotatedRoomEpoch,
      reservedRevision: serverUpdatedAtTimestamp,
      expiresAt: Math.min(expiresAt, now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS),
      shouldBootstrap,
      ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
      activated: false,
    })
    this.armTombstone(room, now)
    return { shouldBootstrap, ...(bootstrapChallenge ? { bootstrapChallenge } : {}) }
  }

  /**
   * SRN_REFRESH_OWNED_LEASE_V3: strict compare-and-refresh. A lease this
   * process no longer holds, or a room whose generation moved on, is never
   * recreated -- preserving a stale `shouldBootstrap` would permit a second
   * bootstrapper.
   */
  private refresh(lease: InProcessLease<S>, now: number): void {
    const localId = this.localLeaseId(lease.conn, lease.room, lease.requestId)
    const state = this.stateOf(lease.room, now)
    if (
      this.leases.get(localId) !== lease ||
      lease.expiresAt <= now ||
      !state ||
      state.epoch !== lease.roomEpoch ||
      state.securityEpoch !== lease.collaborationSecurityEpoch
    ) {
      throw leaseOwnershipLostError()
    }
    const live = this.liveLeases(lease.room, now)
    if (live.some((other) => other.protocolVersion !== lease.protocolVersion)) {
      throw incompatibleProtocolError()
    }
    if (live.length > MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM) {
      throw roomLeaseLimitError()
    }
    this.armTombstone(lease.room, now)
  }

  /**
   * SRN_RELEASE_LEASE_V3: the LAST lease out rotates the room's epoch to an
   * unguessable value and leaves it as a 24 h tombstone, so a grant minted
   * against the old epoch is refused for as long as one could plausibly be
   * replayed.
   */
  private release(lease: InProcessLease<S>): void {
    const now = this.now()
    if (this.liveLeases(lease.room, now).length > 0) {
      return
    }
    const state = this.stateOf(lease.room, now)
    if (!state || state.epoch !== lease.roomEpoch || state.securityEpoch !== lease.collaborationSecurityEpoch) {
      return
    }
    this.setState(
      lease.room,
      lease.rotatedRoomEpoch,
      lease.collaborationSecurityEpoch,
      lease.collaborationAuthorizationIssuedAt,
      now,
    )
  }

  private async denyAndReleaseRoom(room: string, reason: RoomDeniedReason = 'policy'): Promise<void> {
    this.rooms.denyRoom(room, reason)
    for (const [localId, lease] of [...this.leases.entries()]) {
      if (lease.room !== room) {
        continue
      }
      this.leases.delete(localId)
      this.releasePresence(lease, 'revoked')
      this.release(lease)
    }
  }

  private async discardRevokedRoom(room: string): Promise<void> {
    this.rooms.denyRoom(room, 'security-revoked')
    for (const [localId, lease] of [...this.leases.entries()]) {
      if (lease.room !== room) {
        continue
      }
      this.leases.delete(localId)
      this.releasePresence(lease, 'revoked')
    }
  }

  /** Drops every lease for a room WITHOUT rotating on each one (the caller rotates once). */
  private evictRoomLeases(room: string): void {
    for (const [localId, lease] of [...this.leases.entries()]) {
      if (lease.room === room) {
        this.leases.delete(localId)
        this.releasePresence(lease, 'revoked')
      }
    }
  }

  private releasePresence(lease: InProcessLease<S>, reason: RoomPresenceLeaveReason): void {
    const localId = this.localLeaseId(lease.conn, lease.room, lease.requestId)
    const presence = this.presences.get(localId)
    if (!presence) {
      return
    }
    // Delete before the broadcast so a clean leave, socket cleanup, revocation
    // and the TTL reaper can race without emitting two terminal events.
    this.presences.delete(localId)
    this.schedulePresenceExpiry()
    this.rooms.broadcastAll(
      lease.room,
      JSON.stringify({
        t: 'room-presence',
        room: lease.room,
        roomEpoch: lease.roomEpoch,
        protocolVersion: 3,
        action: 'left',
        presenceId: presence.presenceId,
        userUuid: lease.conn.userUuid,
        clientId: presence.clientId,
        reason,
      }),
    )
  }

  private schedulePresenceExpiry(): void {
    if (this.presenceExpiryTimer) {
      clearTimeout(this.presenceExpiryTimer)
      this.presenceExpiryTimer = undefined
    }
    if (this.stopped || this.presences.size === 0) {
      return
    }
    const nextExpiry = Math.min(...[...this.presences.values()].map((presence) => presence.expiresAt))
    const delay = Math.min(COLLABORATION_PRESENCE_TTL_MS, Math.max(0, nextExpiry - this.now()))
    this.presenceExpiryTimer = setTimeout(() => {
      this.presenceExpiryTimer = undefined
      this.expirePresence()
    }, delay)
    this.presenceExpiryTimer.unref?.()
  }

  private expirePresence(): void {
    const now = this.now()
    for (const presence of [...this.presences.values()]) {
      if (presence.expiresAt <= now) {
        this.releasePresence(presence.lease, 'heartbeat-timeout')
      }
    }
    this.schedulePresenceExpiry()
  }

  /** Live leases for a room, dropping elapsed ones WITHOUT rotating the epoch. */
  private liveLeases(room: string, now: number): InProcessLease<S>[] {
    const live: InProcessLease<S>[] = []
    for (const [localId, lease] of [...this.leases.entries()]) {
      if (lease.room !== room) {
        continue
      }
      if (lease.expiresAt <= now) {
        this.leases.delete(localId)
        continue
      }
      live.push(lease)
    }
    return live
  }

  private stateOf(room: string, now = this.now()): RoomState | undefined {
    const state = this.roomState.get(room)
    if (!state) {
      return undefined
    }
    if (state.expiresAt <= now) {
      this.roomState.delete(room)
      return undefined
    }
    return state
  }

  private setState(room: string, epoch: string, securityEpoch: string, issuedAt: number, now: number): void {
    this.roomState.set(room, {
      epoch,
      securityEpoch,
      issuedAt,
      expiresAt: now + IN_PROCESS_ROOM_EPOCH_TOMBSTONE_TTL_MS,
    })
  }

  /** The `PEXPIRE` at the end of a SUCCESSFUL reserve/refresh, and nowhere else. */
  private armTombstone(room: string, now: number): void {
    const state = this.roomState.get(room)
    if (state) {
      state.expiresAt = now + IN_PROCESS_ROOM_EPOCH_TOMBSTONE_TTL_MS
    }
  }

  private pruneRoomState(now: number): void {
    for (const [room, state] of [...this.roomState.entries()]) {
      if (state.expiresAt <= now) {
        this.roomState.delete(room)
      }
    }
  }

  private pruneYjsResponseClaims(now: number): void {
    for (const [key, expiresAt] of [...this.yjsResponseClaims.entries()]) {
      if (expiresAt <= now) {
        this.yjsResponseClaims.delete(key)
      }
    }
  }

  private localLeaseId(conn: Conn<S>, room: string, requestId: string | undefined): string {
    return `${conn.userUuid}\u0000${conn.connectionId}\u0000${room}\u0000${requestId ?? 'legacy'}`
  }

  /**
   * One constant line per operation plus the closed-enum cause code, like the
   * Redis bridge's. The error contributes only its classification -- never a
   * message, a room identifier or a user.
   */
  private warnDenial(operation: 'lease-reservation' | 'lease-activation' | 'lease-refresh', error: unknown): void {
    const cause = collaborationErrorCode(error) ?? 'redis-unavailable'
    this.logger.warn(`${WARN_LINES[operation]} ${JSON.stringify({ cause })}`, { cause })
  }
}

const WARN_LINES = Object.freeze({
  'lease-reservation': '[collab-local] lease reservation denied',
  'lease-activation': '[collab-local] lease activation denied',
  'lease-refresh': '[collab-local] lease refresh denied',
})
