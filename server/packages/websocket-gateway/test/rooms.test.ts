import { describe, it, expect } from 'vitest'
import { RoomRegistry, parseRelayFrame, handleRelayFrame } from '../src/rooms.js'
import type { Conn } from '../src/registry.js'

function fakeConn(id: string): Conn & { sent: string[] } {
  const sent: string[] = []
  return { socket: { send: (m: string) => sent.push(m) }, userUuid: id, sessionUuid: id, connectionId: id, sent }
}

describe('parseRelayFrame', () => {
  it('parses join/leave control frames', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'n1' }))).toEqual({ t: 'room-join', room: 'n1' })
    expect(parseRelayFrame(JSON.stringify({ t: 'room-leave', room: 'n1' }))).toEqual({ t: 'room-leave', room: 'n1' })
  })

  it('parses yjs/awareness payload frames', () => {
    const f = parseRelayFrame(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
    expect(f).toEqual({ t: 'yjs', room: 'n1', payload: 'AQID' })
  })

  it('rejects non-relay frames and garbage', () => {
    expect(parseRelayFrame('ping')).toBeNull()
    expect(parseRelayFrame('not json')).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'unknown', room: 'n1' }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'yjs', room: 'n1' }))).toBeNull() // missing payload
    expect(parseRelayFrame(JSON.stringify({ t: 'yjs', room: '', payload: 'x' }))).toBeNull()
  })

  it('rejects oversized room ids and payloads', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'x'.repeat(201) }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'x'.repeat(512 * 1024 + 1) }))).toBeNull()
  })
})

describe('RoomRegistry + handleRelayFrame', () => {
  it('relays a yjs frame to other room members but not the sender', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    const c = fakeConn('c')
    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, c, { t: 'room-join', room: 'other' })

    const reached = await handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' })
    expect(reached).toBe(1)
    expect(b.sent).toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
    expect(a.sent).not.toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
    expect(c.sent.some((m) => m.includes('AQID'))).toBe(false) // isolated room
  })

  it('on join, asks existing members to re-sync', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    const reached = await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    expect(reached).toBe(1)
    expect(a.sent).toContain(JSON.stringify({ t: 'room-sync', room: 'n1' }))
  })

  it('relays awareness frames', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, a, { t: 'awareness', room: 'n1', payload: 'QQ' })
    expect(b.sent).toContain(JSON.stringify({ t: 'awareness', room: 'n1', payload: 'QQ' }))
  })

  it('leave stops delivery', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, b, { t: 'room-leave', room: 'n1' })
    const reached = await handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' })
    expect(reached).toBe(0)
  })

  it('leaveAll removes a connection from every room', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n2' })
    await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    rooms.leaveAll(a)
    expect(rooms.members('n1')).toHaveLength(1)
    expect(rooms.members('n2')).toHaveLength(0)
  })
})

describe('handleRelayFrame room-join authorization', () => {
  it('rejects an unauthorized join: the socket never enters the room and gets room-denied', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const intruder = fakeConn('intruder')

    // Only user "a" is a member of note "n1".
    const authorize = (userUuid: string, room: string) => userUuid === 'a' && room === 'n1'

    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' }, authorize)
    const reached = await handleRelayFrame(rooms, intruder, { t: 'room-join', room: 'n1' }, authorize)

    expect(reached).toBe(0)
    expect(rooms.members('n1')).toHaveLength(1) // intruder NOT added
    expect(intruder.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'n1' }))

    // The intruder cannot inject frames into a room it never joined, and a's
    // frame is not delivered to the intruder.
    const out = await handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' }, authorize)
    expect(out).toBe(0)
    expect(intruder.sent.some((m) => m.includes('AQID'))).toBe(false)
  })

  it('fails CLOSED when the authorizer throws', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const authorize = () => {
      throw new Error('membership service unavailable')
    }

    const reached = await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' }, authorize)
    expect(reached).toBe(0)
    expect(rooms.members('n1')).toHaveLength(0)
    expect(a.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'n1' }))
  })

  it('allows an authorized member to join and collaborate', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    const authorize = () => true // both are members of the shared-vault note

    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' }, authorize)
    await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' }, authorize)
    const reached = await handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' }, authorize)

    expect(reached).toBe(1)
    expect(b.sent).toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
  })
})
