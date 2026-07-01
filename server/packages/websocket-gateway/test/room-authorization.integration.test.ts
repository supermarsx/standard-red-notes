import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { defaultRoomJoinAuthorizer } from '../src/gateway.js'
import { handleRelayFrame, RoomRegistry } from '../src/rooms.js'
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
  return jwt.sign({ purpose: 'collab-room', userUuid, room }, opts.secret ?? SECRET, {
    algorithm: 'HS256',
    expiresIn: 300,
  })
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

    await handleRelayFrame(rooms, conn, { t: 'room-join', room: 'note-1', cap: capabilityFor('user-a', 'note-OTHER') }, authorize)
    expect(rooms.members('note-1')).toHaveLength(0)

    await handleRelayFrame(rooms, conn, { t: 'room-join', room: 'note-1', cap: capabilityFor('attacker', 'note-1') }, authorize)
    expect(rooms.members('note-1')).toHaveLength(0)
  })

  it('ALLOWS a join with a valid capability and relays to that member', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('user-a')
    const b = fakeConn('user-b')

    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'note-1', cap: capabilityFor('user-a', 'note-1') }, authorize)
    const reached = await handleRelayFrame(
      rooms,
      b,
      { t: 'room-join', room: 'note-1', cap: capabilityFor('user-b', 'note-1') },
      authorize,
    )

    // B's join asks the existing member (A) to re-sync.
    expect(reached).toBe(1)
    expect(rooms.members('note-1')).toHaveLength(2)
    expect(a.sent).toContain(JSON.stringify({ t: 'room-sync', room: 'note-1' }))
  })
})
