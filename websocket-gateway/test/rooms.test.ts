import { describe, it, expect } from 'vitest'
import { RoomRegistry, parseRelayFrame, handleRelayFrame } from '../src/rooms.js'
import type { Conn } from '../src/registry.js'

function fakeConn(id: string): Conn & { sent: string[] } {
  const sent: string[] = []
  return { socket: { send: (m: string) => sent.push(m) }, sessionUuid: id, connectionId: id, sent }
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
  it('relays a yjs frame to other room members but not the sender', () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    const c = fakeConn('c')
    handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    handleRelayFrame(rooms, c, { t: 'room-join', room: 'other' })

    const reached = handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' })
    expect(reached).toBe(1)
    expect(b.sent).toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
    expect(a.sent).not.toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
    expect(c.sent.some((m) => m.includes('AQID'))).toBe(false) // isolated room
  })

  it('on join, asks existing members to re-sync', () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    const reached = handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    expect(reached).toBe(1)
    expect(a.sent).toContain(JSON.stringify({ t: 'room-sync', room: 'n1' }))
  })

  it('relays awareness frames', () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    handleRelayFrame(rooms, a, { t: 'awareness', room: 'n1', payload: 'QQ' })
    expect(b.sent).toContain(JSON.stringify({ t: 'awareness', room: 'n1', payload: 'QQ' }))
  })

  it('leave stops delivery', () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    handleRelayFrame(rooms, b, { t: 'room-leave', room: 'n1' })
    const reached = handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' })
    expect(reached).toBe(0)
  })

  it('leaveAll removes a connection from every room', () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    handleRelayFrame(rooms, a, { t: 'room-join', room: 'n2' })
    handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })
    rooms.leaveAll(a)
    expect(rooms.members('n1')).toHaveLength(1)
    expect(rooms.members('n2')).toHaveLength(0)
  })
})
