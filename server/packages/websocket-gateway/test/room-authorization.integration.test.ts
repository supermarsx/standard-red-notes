import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { defaultRoomJoinAuthorizer } from '../src/gateway.js'
import { COLLABORATION_PROTOCOL_VERSION, handleRelayFrame, MAX_YJS_TRANSFER_BYTES, RoomRegistry } from '../src/rooms.js'
import type { Conn } from '../src/registry.js'

// Proves the PRODUCTION wiring is fail-closed: the authorizer attachWebSocketGateway
// installs when NO custom authorizer is supplied is the capability-verifying default
// (NOT allow-all), and that handleRelayFrame enforces it on room-join.

const SECRET = 'integration-connection-secret'

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

function capabilityFor(userUuid: string, room: string, opts: { secret?: string } = {}): string {
  return jwt.sign(
    {
      purpose: 'collab-room',
      userUuid,
      room,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      serverUpdatedAtTimestamp: 1,
    },
    opts.secret ?? SECRET,
    {
      algorithm: 'HS256',
      expiresIn: 300,
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
        cap: capabilityFor('user-a', 'note-1'),
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      },
      authorize,
    )
    const reached = await handleRelayFrame(
      rooms,
      b,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capabilityFor('user-b', 'note-1'),
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      },
      authorize,
    )

    // Protocol v2 uses the joiner's explicit correlated retry, so activation
    // does not also trigger a redundant room-wide full-state fanout.
    expect(reached).toBe(0)
    expect(rooms.members('note-1')).toHaveLength(2)
    expect(b.sent).toContain(
      JSON.stringify({
        t: 'room-joined',
        room: 'note-1',
        bootstrap: false,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      }),
    )
    expect(a.sent).not.toContain(JSON.stringify({ t: 'room-sync', room: 'note-1' }))
  })

  it('evicts a joined member when its production JWT capability expires', async () => {
    let now = Date.now()
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('user-a')
    const capability = capabilityFor('user-a', 'note-1')
    const decoded = jwt.decode(capability) as { exp: number }

    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'note-1',
        cap: capability,
        requestId: 'join-request',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
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
})
