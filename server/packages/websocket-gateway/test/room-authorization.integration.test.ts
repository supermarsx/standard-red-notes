import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { defaultRoomJoinAuthorizer } from '../src/gateway.js'
import { COLLABORATION_PROTOCOL_VERSION, handleRelayFrame, MAX_YJS_TRANSFER_BYTES, RoomRegistry } from '../src/rooms.js'
import { CollaborationRedisBridge } from '../src/collaborationRedisBridge.js'
import { RecordingCollaborationRedis } from './fixtures/recordingCollaborationRedis.js'
import type { Conn, SendableSocket } from '../src/registry.js'

// Proves the PRODUCTION wiring is fail-closed: the authorizer attachWebSocketGateway
// installs when NO custom authorizer is supplied is the capability-verifying default
// (NOT allow-all), and that handleRelayFrame enforces it on room-join.

const SECRET = 'integration-connection-secret'
const ROOM_EPOCH = 'room_epoch_0000000000000001'
const SECURITY_EPOCH = 'security_epoch_0000000000000001'

function fakeConn(userUuid: string): Conn & { sent: string[] } {
  const sent: string[] = []
  return {
    socket: { send: (m: string) => sent.push(m) },
    userUuid,
    sessionUuid: `s-${userUuid}`,
    connectionId: `c-${userUuid}`,
    sent,
  }
}

function capabilityFor(
  userUuid: string,
  room: string,
  opts: {
    secret?: string
    leaseRequestId?: string
    roomEpoch?: string
    securityEpoch?: string
    bootstrapChallenge?: string
    expiresIn?: number
  } = {},
): string {
  return jwt.sign(
    {
      purpose: 'collab-room',
      userUuid,
      room,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      collaborationAuthorizationIssuedAt: 1,
      serverUpdatedAtTimestamp: 1,
      roomEpoch: opts.roomEpoch ?? ROOM_EPOCH,
      collaborationSecurityEpoch: opts.securityEpoch ?? SECURITY_EPOCH,
      ...(opts.leaseRequestId ? { leaseRequestId: opts.leaseRequestId } : {}),
      ...(opts.bootstrapChallenge ? { bootstrapChallenge: opts.bootstrapChallenge } : {}),
    },
    opts.secret ?? SECRET,
    {
      algorithm: 'HS256',
      expiresIn: opts.expiresIn ?? 300,
    },
  )
}

describe('default (production) room authorization is fail-closed', () => {
  const authorize = defaultRoomJoinAuthorizer(SECRET)

  it('DENIES a capability-less join (NOT allow-all) and never adds to the room', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('user-a')

    const reached = await handleRelayFrame(rooms, conn, { t: 'room-join', room: 'note-1' }, authorize)

    expect(reached).toBe(0)
    expect(rooms.members('note-1')).toHaveLength(0)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1' }))
  })

  it('DENIES a join whose capability was signed with the wrong secret', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('user-a')
    const cap = capabilityFor('user-a', 'note-1', { secret: 'evil' })

    await handleRelayFrame(rooms, conn, { t: 'room-join', room: 'note-1', cap }, authorize)

    expect(rooms.members('note-1')).toHaveLength(0)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1' }))
  })

  it('DENIES a join whose capability is for a different room/user', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('user-a')

    await handleRelayFrame(
      rooms,
      conn,
      { t: 'room-join', room: 'note-1', cap: capabilityFor('user-a', 'note-OTHER') },
      authorize,
    )
    expect(rooms.members('note-1')).toHaveLength(0)
    expect(conn.sent.filter((message) => message.includes('room-joined'))).toHaveLength(0)

    await handleRelayFrame(
      rooms,
      conn,
      { t: 'room-join', room: 'note-1', cap: capabilityFor('attacker', 'note-1') },
      authorize,
    )
    expect(rooms.members('note-1')).toHaveLength(0)
    expect(conn.sent.filter((message) => message.includes('room-joined'))).toHaveLength(0)
  })

  it('ALLOWS a join with a valid capability and relays to that member', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('user-a')
    const b = fakeConn('user-b')

    await handleRelayFrame(
      rooms,
      a,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: 'lease-a' }),
        requestId: 'lease-a',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
    )
    const reached = await handleRelayFrame(
      rooms,
      b,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capabilityFor('user-b', 'note-1', { leaseRequestId: 'lease-b' }),
        requestId: 'lease-b',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
    )

    // Protocol v3 uses the joiner's explicit correlated retry, so activation
    // does not also trigger a redundant room-wide full-state fanout.
    expect(reached).toBe(0)
    expect(rooms.members('note-1')).toHaveLength(2)
    expect(b.sent).toContain(
      JSON.stringify({
        t: 'room-joined',
        room: 'note-1',
        requestId: 'lease-b',
        bootstrap: false,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
        roomEpoch: ROOM_EPOCH,
      }),
    )
    expect(a.sent).not.toContain(JSON.stringify({ t: 'room-sync', room: 'note-1' }))
  })

  it('evicts a joined member when its production JWT capability expires', async () => {
    let now = Date.now()
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('user-a')
    const capability = capabilityFor('user-a', 'note-1', { leaseRequestId: 'join-request' })
    const decoded = jwt.decode(capability) as { exp: number }

    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capability,
        requestId: 'join-request',
        role: 'comment',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
    )
    expect(rooms.isMember('note-1', conn)).toBe(true)

    now = decoded.exp * 1_000 + 1
    const reached = await handleRelayFrame(rooms, conn, {
      t: 'comment',
      room: 'note-1',
      payload: 'expired-ciphertext',
    })

    expect(reached).toBe(0)
    expect(rooms.isMember('note-1', conn)).toBe(false)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId: 'join-request' }))
  })

  it('DENIES an otherwise-valid capability when the frame expects another room epoch', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('user-a')
    const requestId = 'epoch-bound-request'

    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: requestId }),
        requestId,
        role: 'comment',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: 'room_epoch_0000000000000002',
      },
      authorize,
    )

    expect(rooms.isMember('note-1', conn)).toBe(false)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
  })
})

// ---------------------------------------------------------------------------
// v3 negative cases, asserted at the GRANT BACKEND boundary.
//
// Every test below drives the real `handleRelayFrame` with the real production
// authorizer AND the real CollaborationRedisBridge, whose EVALs are recorded by
// `RecordingCollaborationRedis`. A denial is only proven fail-closed when the
// grant backend was never invoked: an error response with `SRN_RESERVE_LEASE_V3`
// already executed would be a real vulnerability (a lease key and room-state
// key would exist in shared Redis, and a peer replica would see the room as
// occupied). Asserting only on `room-denied` would miss exactly that.
// ---------------------------------------------------------------------------
describe('v3 discovery and challenge misuse never reach the collaboration grant backend', () => {
  const authorize = defaultRoomJoinAuthorizer(SECRET)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  function harness() {
    const redis = new RecordingCollaborationRedis()
    const rooms = new RoomRegistry<SendableSocket>()
    const bridge = new CollaborationRedisBridge(
      rooms,
      redis.client() as never,
      redis.client() as never,
      logger,
      randomUUID(),
    )
    const reserveEditorLease = vi.spyOn(bridge, 'reserveEditorLease')
    const activateEditorLease = vi.spyOn(bridge, 'activateEditorLease')
    return { redis, rooms, bridge, reserveEditorLease, activateEditorLease }
  }

  /** No lease was minted, no room state exists, and nothing joined the room. */
  function expectGrantBackendUntouched(
    h: ReturnType<typeof harness>,
    room: string,
    conn: Conn<SendableSocket>,
    requestId?: string,
  ): void {
    expect(h.reserveEditorLease).not.toHaveBeenCalled()
    expect(h.activateEditorLease).not.toHaveBeenCalled()
    expect(h.redis.scriptCalls).toEqual([])
    expect(h.redis.reserveEvalCalls).toBe(0)
    expect(h.redis.isPristine).toBe(true)
    expect(h.redis.published).toEqual([])
    expect(h.rooms.members(room)).toHaveLength(0)
    expect(h.rooms.isMember(room, conn)).toBe(false)
    if (requestId) {
      expect(h.rooms.hasPendingEditorReservation(room, conn, requestId)).toBe(false)
      expect(h.rooms.requestLease(room, conn, requestId)).toBeUndefined()
    }
  }

  // --- POSITIVE CONTROL ----------------------------------------------------
  // Without this, every "backend not invoked" assertion below could pass
  // vacuously (e.g. if the recorder were mis-wired and saw nothing at all).
  it('CONTROL: the complete challenge-bound handshake DOES reach the grant backend', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'lease-control'

    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: requestId }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    const reserved = conn.sent.map((message) => JSON.parse(message) as Record<string, unknown>).at(-1)
    expect(reserved).toMatchObject({ t: 'room-reserved', room: 'note-1', requestId, bootstrap: true })
    const bootstrapChallenge = reserved?.bootstrapChallenge as string
    expect(bootstrapChallenge).toEqual(expect.any(String))
    expect(h.redis.reserveEvalCalls).toBe(1)

    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: requestId, bootstrapChallenge }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(h.activateEditorLease).toHaveBeenCalledTimes(1)
    expect(h.redis.refreshEvalCalls).toBe(1)
    expect(h.rooms.isMember('note-1', conn)).toBe(true)
    expect(conn.sent.at(-1)).toContain('room-joined')
  })

  // --- 1. DISCOVERY CANNOT RESERVE OR JOIN ---------------------------------
  // The discovery phase yields ONLY (roomEpoch, securityEpoch) and a one-use
  // challenge; it never yields a room capability. A client holding discovery
  // output alone must be unable to touch room state.
  it('a discovery-only client (no capability at all) cannot reserve a lease', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'discovery-reserve'

    const reached = await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(reached).toBe(0)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expectGrantBackendUntouched(h, 'note-1', conn, requestId)
  })

  it('a discovery-only client (no capability at all) cannot join a room', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'discovery-join'

    for (const role of ['editor', 'comment'] as const) {
      await handleRelayFrame(
        h.rooms,
        conn,
        {
          t: 'room-join',
          room: 'note-1',
          requestId,
          role,
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: ROOM_EPOCH,
        },
        authorize,
        undefined,
        h.bridge,
      )
    }

    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expect(conn.sent.filter((message) => message.includes('room-joined'))).toHaveLength(0)
    expectGrantBackendUntouched(h, 'note-1', conn, requestId)
  })

  it('a discovery-shaped capability (epochs but no lease binding) cannot reserve or join', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'unbound-lease'
    // Correct user, correct room, correct epochs, correct signature — the only
    // thing a discovery response cannot produce is the leaseRequestId binding.
    const cap = capabilityFor('user-a', 'note-1')

    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap,
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )
    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-join',
        room: 'note-1',
        cap,
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expectGrantBackendUntouched(h, 'note-1', conn, requestId)
  })

  it('an editor cannot join without the reservation the grant backend minted', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'skip-reserve'

    // A fully valid grant capability, but room-reserve was never performed, so
    // no pending reservation and no Redis lease exist to activate.
    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: requestId, bootstrapChallenge: 'forged-challenge' }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expectGrantBackendUntouched(h, 'note-1', conn, requestId)
  })

  // --- 2. MISSING CHALLENGE ------------------------------------------------
  it('MISSING challenge: a reserve capability with no bootstrap challenge cannot be replayed as a join', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'missing-challenge'
    const reserveCapability = capabilityFor('user-a', 'note-1', { leaseRequestId: requestId })

    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: reserveCapability,
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )
    expect(h.redis.reserveEvalCalls).toBe(1)
    const refreshesAfterReserve = h.redis.refreshEvalCalls

    // Re-present the SAME (challenge-less) capability on room-join. The bridge
    // minted a bootstrap challenge during reserve; a join that cannot echo it
    // must not be able to activate the lease.
    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-join',
        room: 'note-1',
        cap: reserveCapability,
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(conn.sent.filter((message) => message.includes('room-joined'))).toHaveLength(0)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expect(h.rooms.isMember('note-1', conn)).toBe(false)
    // The activation EVAL never ran, so the reservation was never promoted.
    expect(h.redis.refreshEvalCalls).toBe(refreshesAfterReserve)
    expect(h.redis.reserveEvalCalls).toBe(1)
  })

  // --- 3. STALE CHALLENGE --------------------------------------------------
  it('STALE challenge: an expired capability never reaches the grant backend', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'stale-capability'

    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: requestId, expiresIn: -60 }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expectGrantBackendUntouched(h, 'note-1', conn, requestId)
  })

  it('STALE challenge: a capability bound to a superseded room epoch never reaches the grant backend', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'superseded-epoch'

    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        // Capability minted for the previous (now rotated) room epoch.
        cap: capabilityFor('user-a', 'note-1', {
          leaseRequestId: requestId,
          roomEpoch: 'room_epoch_0000000000000000',
        }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expectGrantBackendUntouched(h, 'note-1', conn, requestId)
  })

  it('STALE challenge: a superseded SECURITY epoch is rejected by the atomic room-state gate', async () => {
    // The security epoch is never carried on the client frame, so `rooms.ts`
    // cannot compare it; the `SRN_RESERVE_LEASE_V3` room-state check is its only
    // enforcement point. The reserve EVAL therefore does run — what must not
    // happen is a lease being minted for the stale epoch.
    const h = harness()
    const current = fakeConn('user-a')
    const stale = fakeConn('user-b')

    await handleRelayFrame(
      h.rooms,
      current,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: 'current-lease' }),
        requestId: 'current-lease',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )
    expect(h.redis.leases.size).toBe(1)

    await handleRelayFrame(
      h.rooms,
      stale,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: capabilityFor('user-b', 'note-1', {
          leaseRequestId: 'stale-lease',
          securityEpoch: 'security_epoch_0000000000000000',
        }),
        requestId: 'stale-lease',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(stale.sent.filter((message) => message.includes('room-reserved'))).toHaveLength(0)
    expect(stale.sent.some((message) => message.includes('room-denied'))).toBe(true)
    expect(h.rooms.hasPendingEditorReservation('note-1', stale, 'stale-lease')).toBe(false)
    expect(h.rooms.isMember('note-1', stale)).toBe(false)
    // No lease was minted for the stale security epoch.
    expect(h.redis.leases.size).toBe(1)
  })

  // --- 4. MISMATCHED CHALLENGE ---------------------------------------------
  it.each([
    [
      'a different room',
      (requestId: string) => capabilityFor('user-a', 'note-OTHER', { leaseRequestId: requestId }),
      ROOM_EPOCH,
      undefined,
    ],
    [
      'a different user',
      (requestId: string) => capabilityFor('attacker', 'note-1', { leaseRequestId: requestId }),
      ROOM_EPOCH,
      undefined,
    ],
    [
      'a different lease request',
      () => capabilityFor('user-a', 'note-1', { leaseRequestId: 'someone-elses-lease' }),
      ROOM_EPOCH,
      undefined,
    ],
    [
      'a different room epoch',
      (requestId: string) =>
        capabilityFor('user-a', 'note-1', { leaseRequestId: requestId, roomEpoch: 'room_epoch_0000000000000009' }),
      ROOM_EPOCH,
      undefined,
    ],
    [
      'a foreign signing secret',
      (requestId: string) => capabilityFor('user-a', 'note-1', { leaseRequestId: requestId, secret: 'attacker' }),
      ROOM_EPOCH,
      undefined,
    ],
  ])(
    'MISMATCHED challenge bound to %s never reaches the grant backend',
    async (_description, mintCapability, expectedRoomEpoch) => {
      const h = harness()
      const conn = fakeConn('user-a')
      const requestId = 'mismatched-lease'

      await handleRelayFrame(
        h.rooms,
        conn,
        {
          t: 'room-reserve',
          room: 'note-1',
          cap: mintCapability(requestId),
          requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch,
        },
        authorize,
        undefined,
        h.bridge,
      )

      expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
      expectGrantBackendUntouched(h, 'note-1', conn, requestId)
    },
  )

  // --- 5. REPLAYED CHALLENGE -----------------------------------------------
  it('REPLAYED challenge: a grant-phase capability cannot be replayed as a reservation', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'replayed-into-reserve'

    // A capability that already carries a bootstrap challenge belongs to the
    // activation half of the handshake. Accepting it at reserve time would let
    // a captured grant mint a brand-new lease.
    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', {
          leaseRequestId: requestId,
          bootstrapChallenge: 'captured-challenge',
        }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expectGrantBackendUntouched(h, 'note-1', conn, requestId)
  })

  it('REPLAYED challenge: a captured bootstrap challenge cannot activate a foreign lease', async () => {
    const h = harness()
    const victim = fakeConn('user-a')
    const attacker = fakeConn('user-b')
    const requestId = 'victim-lease'

    await handleRelayFrame(
      h.rooms,
      victim,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: requestId }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )
    const reserved = JSON.parse(victim.sent.at(-1) as string) as { bootstrapChallenge: string }
    const refreshesAfterReserve = h.redis.refreshEvalCalls
    const reservesAfterReserve = h.redis.reserveEvalCalls

    // The attacker replays the victim's exact challenge and lease id on its own
    // connection, with a capability legitimately issued to ITSELF.
    await handleRelayFrame(
      h.rooms,
      attacker,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capabilityFor('user-b', 'note-1', {
          leaseRequestId: requestId,
          bootstrapChallenge: reserved.bootstrapChallenge,
        }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )

    expect(attacker.sent.filter((message) => message.includes('room-joined'))).toHaveLength(0)
    expect(attacker.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'note-1', requestId }))
    expect(h.rooms.isMember('note-1', attacker)).toBe(false)
    expect(h.redis.refreshEvalCalls).toBe(refreshesAfterReserve)
    expect(h.redis.reserveEvalCalls).toBe(reservesAfterReserve)
  })

  it('REPLAYED challenge: one bootstrap challenge activates exactly once', async () => {
    const h = harness()
    const conn = fakeConn('user-a')
    const requestId = 'one-use-challenge'

    await handleRelayFrame(
      h.rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'note-1',
        cap: capabilityFor('user-a', 'note-1', { leaseRequestId: requestId }),
        requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      },
      authorize,
      undefined,
      h.bridge,
    )
    const reserved = JSON.parse(conn.sent.at(-1) as string) as { bootstrapChallenge: string }
    const joinFrame = {
      t: 'room-join' as const,
      room: 'note-1',
      cap: capabilityFor('user-a', 'note-1', {
        leaseRequestId: requestId,
        bootstrapChallenge: reserved.bootstrapChallenge,
      }),
      requestId,
      role: 'editor' as const,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: ROOM_EPOCH,
    }

    await handleRelayFrame(h.rooms, conn, joinFrame, authorize, undefined, h.bridge)
    expect(h.activateEditorLease).toHaveBeenCalledTimes(1)
    const refreshesAfterActivation = h.redis.refreshEvalCalls

    // Replaying the identical activation must be an idempotent acknowledgement,
    // never a second trip through the grant backend.
    await handleRelayFrame(h.rooms, conn, joinFrame, authorize, undefined, h.bridge)
    await handleRelayFrame(h.rooms, conn, joinFrame, authorize, undefined, h.bridge)

    expect(h.activateEditorLease).toHaveBeenCalledTimes(1)
    expect(h.redis.refreshEvalCalls).toBe(refreshesAfterActivation)
    expect(h.rooms.members('note-1')).toHaveLength(1)
  })
})
