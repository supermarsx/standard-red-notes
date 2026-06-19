import { describe, it, expect } from 'vitest'
import { RoomRegistry, handleRelayFrame } from '../src/rooms.js'
import { ConnectionRegistry, type Conn } from '../src/registry.js'

// Leak guards for the gateway's long-lived in-memory structures. The gateway is a
// single process up for weeks; any registry that retains rooms/connections (or
// empty buckets) after everyone disconnects grows unbounded. These tests churn
// the full lifecycle and assert the structures return to EMPTY.

function fakeConn(id: string): Conn {
  return { socket: { send: () => {} }, sessionUuid: id, connectionId: id }
}

describe('ConnectionRegistry — no leak', () => {
  it('returns to zero connections AND zero user buckets after everyone disconnects', () => {
    const reg = new ConnectionRegistry()
    const conns: Conn[] = []
    for (let u = 0; u < 200; u++) {
      // a few sessions per user
      for (let s = 0; s < 3; s++) {
        const c = fakeConn(`u${u}-s${s}`)
        reg.add(`user-${u}`, c)
        conns.push(c)
      }
    }
    expect(reg.size()).toBe(600)
    expect(reg.userCount()).toBe(200)

    for (let i = 0; i < conns.length; i++) {
      reg.remove(`user-${Math.floor(i / 3)}`, conns[i])
    }
    // No lingering empty Set buckets — both must be exactly 0.
    expect(reg.size()).toBe(0)
    expect(reg.userCount()).toBe(0)
  })

  it('stays bounded across many connect/disconnect cycles', () => {
    const reg = new ConnectionRegistry()
    for (let cycle = 0; cycle < 5000; cycle++) {
      const c = fakeConn(`c${cycle}`)
      reg.add('same-user', c)
      reg.remove('same-user', c)
    }
    expect(reg.size()).toBe(0)
    expect(reg.userCount()).toBe(0)
  })

  it('removing a non-existent / already-removed conn does not leak a bucket', () => {
    const reg = new ConnectionRegistry()
    const c = fakeConn('x')
    reg.add('u', c)
    reg.remove('u', c)
    reg.remove('u', c) // double remove
    reg.remove('missing-user', fakeConn('y'))
    expect(reg.userCount()).toBe(0)
  })
})

describe('RoomRegistry — no leak', () => {
  it('returns to zero rooms after all members leave', () => {
    const rooms = new RoomRegistry()
    const conns = Array.from({ length: 50 }, (_, i) => fakeConn(`c${i}`))
    // every conn joins 10 shared rooms
    for (const c of conns) {
      for (let r = 0; r < 10; r++) rooms.join(`room-${r}`, c)
    }
    expect(rooms.roomCount()).toBe(10)

    // leave one room at a time
    for (const c of conns) {
      for (let r = 0; r < 10; r++) rooms.leave(`room-${r}`, c)
    }
    expect(rooms.roomCount()).toBe(0)
  })

  it('leaveAll fully removes a connection from every room (no orphan rooms)', () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    for (let r = 0; r < 100; r++) {
      rooms.join(`room-${r}`, a)
      rooms.join(`room-${r}`, b)
    }
    rooms.leaveAll(a)
    expect(rooms.roomCountForConn(a)).toBe(0)
    // b still present, so rooms remain; once b leaves too, rooms must hit 0.
    rooms.leaveAll(b)
    expect(rooms.roomCount()).toBe(0)
    expect(rooms.roomCountForConn(b)).toBe(0)
  })

  it('stays bounded across many join/leaveAll cycles (simulated reconnect churn)', () => {
    const rooms = new RoomRegistry()
    for (let cycle = 0; cycle < 5000; cycle++) {
      const c = fakeConn(`c${cycle}`)
      handleRelayFrame(rooms, c, { t: 'room-join', room: `note-${cycle % 20}` })
      rooms.leaveAll(c) // socket closed
    }
    expect(rooms.roomCount()).toBe(0)
  })

  it('the per-connection room cap prevents unbounded room growth from one client', () => {
    const rooms = new RoomRegistry()
    const c = fakeConn('flooder')
    let accepted = 0
    for (let r = 0; r < 10_000; r++) {
      if (rooms.join(`junk-${r}`, c)) accepted++
    }
    expect(accepted).toBe(100) // MAX_ROOMS_PER_CONNECTION
    expect(rooms.roomCountForConn(c)).toBe(100)
    expect(rooms.roomCount()).toBe(100)
    rooms.leaveAll(c)
    expect(rooms.roomCount()).toBe(0)
  })
})
