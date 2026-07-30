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

  it('parses opaque encrypted comment payloads and request-bound joins', () => {
    expect(
      parseRelayFrame(
        JSON.stringify({
          t: 'room-join',
          room: 'n1',
          cap: 'cap',
          requestId: 'request-1',
          role: 'editor',
        }),
      ),
    ).toEqual({ t: 'room-join', room: 'n1', cap: 'cap', requestId: 'request-1', role: 'editor' })
    expect(parseRelayFrame(JSON.stringify({ t: 'comment', room: 'n1', payload: 'ciphertext' }))).toEqual({
      t: 'comment',
      room: 'n1',
      payload: 'ciphertext',
    })
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

  it('relays encrypted comments only between current room members', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const b = fakeConn('b')
    const outsider = fakeConn('outsider')
    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' })

    const outsiderReach = await handleRelayFrame(rooms, outsider, {
      t: 'comment',
      room: 'n1',
      payload: 'forged',
    })
    expect(outsiderReach).toBe(0)

    const reached = await handleRelayFrame(rooms, a, { t: 'comment', room: 'n1', payload: 'ciphertext' })
    expect(reached).toBe(1)
    expect(b.sent).toContain(JSON.stringify({ t: 'comment', room: 'n1', payload: 'ciphertext' }))
    expect(b.sent).not.toContain(JSON.stringify({ t: 'comment', room: 'n1', payload: 'forged' }))
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

  it('keeps a shared socket in the room until every request-bound logical lease leaves', async () => {
    const rooms = new RoomRegistry()
    const sharedSocket = fakeConn('shared-socket')
    const peer = fakeConn('peer')
    await handleRelayFrame(rooms, sharedSocket, {
      t: 'room-join',
      room: 'n1',
      requestId: 'editor-lease',
    })
    await handleRelayFrame(rooms, sharedSocket, {
      t: 'room-join',
      room: 'n1',
      requestId: 'comment-lease',
    })
    await handleRelayFrame(rooms, peer, { t: 'room-join', room: 'n1' })

    await handleRelayFrame(rooms, sharedSocket, {
      t: 'room-leave',
      room: 'n1',
      requestId: 'comment-lease',
    })
    expect(rooms.isMember('n1', sharedSocket)).toBe(true)
    expect(
      await handleRelayFrame(rooms, sharedSocket, {
        t: 'comment',
        room: 'n1',
        payload: 'still-authorized',
      }),
    ).toBe(1)

    await handleRelayFrame(rooms, sharedSocket, {
      t: 'room-leave',
      room: 'n1',
      requestId: 'editor-lease',
    })
    expect(rooms.isMember('n1', sharedSocket)).toBe(false)
  })

  it('elects the first editor lease even when a comment lease joined the room first', async () => {
    const rooms = new RoomRegistry()
    const commentSocket = fakeConn('comment-socket')
    const firstEditor = fakeConn('first-editor')
    const secondEditor = fakeConn('second-editor')

    await handleRelayFrame(rooms, commentSocket, {
      t: 'room-join',
      room: 'n1',
      requestId: 'comment-lease',
      role: 'comment',
    })
    await handleRelayFrame(rooms, firstEditor, {
      t: 'room-join',
      room: 'n1',
      requestId: 'editor-a',
      role: 'editor',
    })
    await handleRelayFrame(rooms, secondEditor, {
      t: 'room-join',
      room: 'n1',
      requestId: 'editor-b',
      role: 'editor',
    })

    expect(commentSocket.sent).toContain(JSON.stringify({ t: 'room-joined', room: 'n1', requestId: 'comment-lease' }))
    expect(firstEditor.sent).toContain(
      JSON.stringify({ t: 'room-joined', room: 'n1', requestId: 'editor-a', bootstrap: true }),
    )
    expect(secondEditor.sent).toContain(
      JSON.stringify({ t: 'room-joined', room: 'n1', requestId: 'editor-b', bootstrap: false }),
    )
  })

  it('does not count an unbound explicit comment lease as an editor bootstrapper', async () => {
    const rooms = new RoomRegistry()
    const legacyCommentSocket = fakeConn('legacy-comment')
    const firstEditor = fakeConn('first-editor')

    await handleRelayFrame(rooms, legacyCommentSocket, {
      t: 'room-join',
      room: 'n1',
      role: 'comment',
    })
    await handleRelayFrame(rooms, firstEditor, {
      t: 'room-join',
      room: 'n1',
      requestId: 'editor-a',
      role: 'editor',
    })

    expect(legacyCommentSocket.sent).toContain(JSON.stringify({ t: 'room-joined', room: 'n1' }))
    expect(firstEditor.sent).toContain(
      JSON.stringify({ t: 'room-joined', room: 'n1', requestId: 'editor-a', bootstrap: true }),
    )
  })

  it('rejects changing an existing logical lease from comment to editor', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('same-socket')
    await handleRelayFrame(rooms, conn, {
      t: 'room-join',
      room: 'n1',
      requestId: 'stable-lease',
      role: 'comment',
    })
    conn.sent.length = 0

    await handleRelayFrame(rooms, conn, {
      t: 'room-join',
      room: 'n1',
      requestId: 'stable-lease',
      role: 'editor',
    })

    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'n1', requestId: 'stable-lease' }))
  })

  it('expires and denies a legacy unbound lease', () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('legacy')
    expect(rooms.join('n1', conn, 2_000).joined).toBe(true)

    now = 2_001
    rooms.evictExpired()

    expect(rooms.isMember('n1', conn)).toBe(false)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'n1' }))
  })

  it.each([
    ['long then short', ['long', 'short']],
    ['short then long', ['short', 'long']],
  ] as const)('recomputes membership expiry from the remaining lease when joined %s', (_label, joinOrder) => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('shared-socket')
    const expiry = { short: 2_000, long: 5_000 } as const

    for (const lease of joinOrder) {
      expect(
        rooms.join('n1', conn, expiry[lease], `${lease}-lease`, lease === 'long' ? 'comment' : 'editor').joined,
      ).toBe(true)
    }
    rooms.leave('n1', conn, 'long-lease')

    now = 1_999
    expect(rooms.isMember('n1', conn)).toBe(true)
    now = 2_001
    expect(rooms.isMember('n1', conn)).toBe(false)
    expect(conn.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'n1', requestId: 'short-lease' }))
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
    const authorize = (userUuid: string, room: string) =>
      userUuid === 'a' && room === 'n1'
        ? { authorized: true as const, expiresAt: Date.now() + 60_000 }
        : { authorized: false as const }

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
    const authorize = () => ({ authorized: true as const, expiresAt: Date.now() + 60_000 })

    await handleRelayFrame(rooms, a, { t: 'room-join', room: 'n1' }, authorize)
    await handleRelayFrame(rooms, b, { t: 'room-join', room: 'n1' }, authorize)
    const reached = await handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' }, authorize)

    expect(reached).toBe(1)
    expect(a.sent).toContain(JSON.stringify({ t: 'room-joined', room: 'n1' }))
    expect(b.sent).toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
  })

  it('does not join or acknowledge when the connection closes during delayed authorization', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('closing')
    let active = true
    let resolveAuthorization!: (value: { authorized: true; expiresAt: number }) => void
    const authorize = () =>
      new Promise<{ authorized: true; expiresAt: number }>((resolve) => {
        resolveAuthorization = resolve
      })

    const handling = handleRelayFrame(
      rooms,
      conn,
      { t: 'room-join', room: 'n1', requestId: 'delayed', role: 'editor' },
      authorize,
      () => active,
    )
    active = false
    resolveAuthorization({ authorized: true, expiresAt: Date.now() + 60_000 })
    await handling

    expect(rooms.roomCount()).toBe(0)
    expect(conn.sent).toEqual([])
  })
})

describe('handleRelayFrame yjs/awareness send-path membership gate', () => {
  it("drops a non-member connection's yjs frame (no broadcast), but delivers a member's", async () => {
    const rooms = new RoomRegistry()
    const member = fakeConn('member')
    const outsider = fakeConn('outsider')

    // `member` joins the room; `outsider` never joins (or was removed).
    await handleRelayFrame(rooms, member, { t: 'room-join', room: 'n1' })

    // The outsider knows the note uuid + room key and tries to inject an edit
    // WITHOUT being a member. It must be dropped and never reach the member.
    const outsiderReach = await handleRelayFrame(rooms, outsider, { t: 'yjs', room: 'n1', payload: 'AQID' })
    expect(outsiderReach).toBe(0)
    expect(member.sent.some((m) => m.includes('AQID'))).toBe(false)

    // A genuine member's frame IS broadcast to the other member.
    const other = fakeConn('other')
    await handleRelayFrame(rooms, other, { t: 'room-join', room: 'n1' })
    const memberReach = await handleRelayFrame(rooms, member, { t: 'yjs', room: 'n1', payload: 'BQYH' })
    expect(memberReach).toBe(1)
    expect(other.sent).toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'BQYH' }))
  })

  it('evicts an active member at capability expiry and blocks both receive and send until reauthorization', async () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const expiring = fakeConn('expiring')
    const current = fakeConn('current')
    const authorize = (userUuid: string) => ({
      authorized: true as const,
      expiresAt: userUuid === 'expiring' ? 2_000 : 5_000,
    })

    await handleRelayFrame(rooms, expiring, { t: 'room-join', room: 'n1', requestId: 'expiring-request' }, authorize)
    await handleRelayFrame(rooms, current, { t: 'room-join', room: 'n1', requestId: 'current-request' }, authorize)
    expiring.sent.length = 0
    current.sent.length = 0

    now = 2_001
    const receiveReach = await handleRelayFrame(rooms, current, {
      t: 'yjs',
      room: 'n1',
      payload: 'after-expiry',
    })
    expect(receiveReach).toBe(0)
    expect(expiring.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'n1', requestId: 'expiring-request' }))
    expect(rooms.isMember('n1', expiring)).toBe(false)

    const sendReach = await handleRelayFrame(rooms, expiring, {
      t: 'yjs',
      room: 'n1',
      payload: 'expired-injection',
    })
    expect(sendReach).toBe(0)
    expect(current.sent).not.toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'expired-injection' }))
  })

  it("drops a non-member connection's awareness frame (fake presence)", async () => {
    const rooms = new RoomRegistry()
    const member = fakeConn('member')
    const removed = fakeConn('removed')

    await handleRelayFrame(rooms, member, { t: 'room-join', room: 'n1' })

    // `removed` was in the room but left (membership revoked); its subsequent
    // awareness frame must not be relayed as presence.
    await handleRelayFrame(rooms, removed, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, removed, { t: 'room-leave', room: 'n1' })

    const reach = await handleRelayFrame(rooms, removed, { t: 'awareness', room: 'n1', payload: 'QQ' })
    expect(reach).toBe(0)
    expect(member.sent).not.toContain(JSON.stringify({ t: 'awareness', room: 'n1', payload: 'QQ' }))
  })
})
