import { describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { decodeCrossServiceToken, verifyConnectionToken, verifyRoomCapability } from '../src/auth.js'
import { ConnectionRegistry, parseDispatchMessage, type Conn, type SendableSocket } from '../src/registry.js'
import { RoomRegistry, handleRelayFrame, parseRelayFrame } from '../src/rooms.js'

const SECRET = 'edge-case-secret'

/** A token whose payload is a bare string rather than a JSON object. */
function nonObjectPayloadToken(): string {
  return jwt.sign('a-plain-string-payload', SECRET, { algorithm: 'HS256' })
}

describe('auth: non-object token payloads', () => {
  it('rejects a connection token whose payload is not an object', () => {
    expect(() => verifyConnectionToken(nonObjectPayloadToken(), SECRET)).toThrow(
      /connection token payload is not an object/,
    )
  })

  it('rejects a connection token carrying a userUuid but no sessionUuid', () => {
    const token = jwt.sign({ userUuid: 'user-1' }, SECRET, { algorithm: 'HS256' })
    expect(() => verifyConnectionToken(token, SECRET)).toThrow(/connection token missing sessionUuid/)
  })

  it('rejects a connection token with an empty sessionUuid', () => {
    const token = jwt.sign({ userUuid: 'user-1', sessionUuid: '' }, SECRET, { algorithm: 'HS256' })
    expect(() => verifyConnectionToken(token, SECRET)).toThrow(/connection token missing sessionUuid/)
  })

  it('returns undefined for a cross-service token whose payload is not an object', () => {
    expect(decodeCrossServiceToken(nonObjectPayloadToken(), SECRET)).toBeUndefined()
  })

  it('denies a room capability whose payload is not an object', () => {
    expect(verifyRoomCapability(nonObjectPayloadToken(), SECRET, 'user-1', 'note-1')).toBe(false)
  })

  it('denies a room capability when the secret is empty', () => {
    const cap = jwt.sign({ purpose: 'collab-room', userUuid: 'user-1', room: 'note-1' }, SECRET, {
      algorithm: 'HS256',
    })
    expect(verifyRoomCapability(cap, '', 'user-1', 'note-1')).toBe(false)
  })

  it('denies a room capability for an empty user or room', () => {
    const cap = jwt.sign({ purpose: 'collab-room', userUuid: 'user-1', room: 'note-1' }, SECRET, {
      algorithm: 'HS256',
    })
    expect(verifyRoomCapability(cap, SECRET, '', 'note-1')).toBe(false)
    expect(verifyRoomCapability(cap, SECRET, 'user-1', '')).toBe(false)
  })

  it('denies a capability minted for a different purpose', () => {
    const cap = jwt.sign({ purpose: 'password-reset', userUuid: 'user-1', room: 'note-1' }, SECRET, {
      algorithm: 'HS256',
    })
    expect(verifyRoomCapability(cap, SECRET, 'user-1', 'note-1')).toBe(false)
  })
})

describe('parseDispatchMessage rejections', () => {
  it('rejects a payload with a non-string or empty userUuid', () => {
    expect(() => parseDispatchMessage(JSON.stringify({ userUuid: 42, message: 'm' }))).toThrow(/missing userUuid/)
    expect(() => parseDispatchMessage(JSON.stringify({ userUuid: '', message: 'm' }))).toThrow(/missing userUuid/)
  })

  it('rejects a payload with a non-string message', () => {
    expect(() => parseDispatchMessage(JSON.stringify({ userUuid: 'user-1', message: { a: 1 } }))).toThrow(
      /missing message/,
    )
  })

  it('drops a non-string originatingSessionUuid rather than propagating it', () => {
    const parsed = parseDispatchMessage(JSON.stringify({ userUuid: 'user-1', message: 'm', originatingSessionUuid: 7 }))
    expect(parsed.originatingSessionUuid).toBeUndefined()
  })
})

describe('parseRelayFrame rejections', () => {
  it('rejects an empty string and anything that does not start with an object brace', () => {
    expect(parseRelayFrame('')).toBeNull()
    expect(parseRelayFrame('ping')).toBeNull()
    expect(parseRelayFrame('[1,2,3]')).toBeNull()
  })

  it('rejects a body that starts like an object but is not valid json', () => {
    expect(parseRelayFrame('{ not json')).toBeNull()
  })

  it('rejects an unknown or non-string frame type', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'evict', room: 'note-1' }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 7, room: 'note-1' }))).toBeNull()
  })

  it('rejects a missing, empty or oversized room id', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join' }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: '' }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'x'.repeat(5_000) }))).toBeNull()
  })

  it('accepts a room-join with an absent or null capability', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'note-1' }))).toEqual({
      t: 'room-join',
      room: 'note-1',
    })
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'note-1', cap: null }))).toEqual({
      t: 'room-join',
      room: 'note-1',
    })
  })

  it('drops the whole frame when a present capability is malformed', () => {
    // A present-but-malformed capability must not degrade into a capability-less join.
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'note-1', cap: '' }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'note-1', cap: 12 }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'room-join', room: 'note-1', cap: 'x'.repeat(20_000) }))).toBeNull()
  })

  it('parses a room-leave frame', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'room-leave', room: 'note-1' }))).toEqual({
      t: 'room-leave',
      room: 'note-1',
    })
  })

  it('rejects a yjs or awareness frame with a missing, empty or oversized payload', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'yjs', room: 'note-1' }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'yjs', room: 'note-1', payload: '' }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ t: 'awareness', room: 'note-1', payload: 5 }))).toBeNull()
    expect(
      parseRelayFrame(JSON.stringify({ t: 'awareness', room: 'note-1', payload: 'x'.repeat(2_000_000) })),
    ).toBeNull()
  })
})

describe('handleRelayFrame room cap', () => {
  function conn(id: string, send = vi.fn()): Conn<SendableSocket> {
    return { socket: { send }, userUuid: `user-${id}`, sessionUuid: `session-${id}`, connectionId: id }
  }

  it('ignores a join once the connection has hit its room cap', async () => {
    const rooms = new RoomRegistry<SendableSocket>()
    const connection = conn('c1')

    // Fill the connection up to whatever cap RoomRegistry.join enforces.
    let room = 0
    while (rooms.join(`room-${room}`, connection) && room < 1_000) {
      room += 1
    }
    const cappedRoom = `room-${room}`
    expect(rooms.roomCountForConn(connection)).toBeGreaterThan(0)

    const joined = await handleRelayFrame(rooms, connection, { t: 'room-join', room: cappedRoom })
    expect(joined).toBe(0)
    expect(rooms.isMember(cappedRoom, connection)).toBe(false)
  })

  it('still reports a denial when the denied socket cannot be written to', async () => {
    const rooms = new RoomRegistry<SendableSocket>()
    const connection = conn('c2', {
      send: () => {
        throw new Error('socket unwritable')
      },
    } as unknown as ReturnType<typeof vi.fn>)

    const joined = await handleRelayFrame(rooms, connection, { t: 'room-join', room: 'note-1' }, () => false)
    expect(joined).toBe(0)
    expect(rooms.isMember('note-1', connection)).toBe(false)
  })
})

describe('ConnectionRegistry bookkeeping', () => {
  it('removing an unknown connection is a no-op', () => {
    const registry = new ConnectionRegistry<SendableSocket>()
    const connection: Conn<SendableSocket> = {
      socket: { send: vi.fn() },
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      connectionId: 'c1',
    }

    registry.remove('user-1', connection)
    expect(registry.size()).toBe(0)

    registry.add('user-1', connection)
    registry.remove('user-2', connection)
    expect(registry.size()).toBe(1)

    registry.remove('user-1', connection)
    expect(registry.size()).toBe(0)
  })
})
