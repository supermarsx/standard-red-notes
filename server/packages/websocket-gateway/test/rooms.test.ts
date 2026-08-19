import { describe, it, expect, vi } from 'vitest'
import {
  CONTROL_FRAME_WINDOW_MS,
  RoomRegistry,
  parseRelayFrame,
  handleRelayFrame,
  MAX_CONNECTIONS_PER_ROOM,
  MAX_COLLABORATION_SOCKET_BUFFERED_BYTES,
  MAX_ACTIVE_YJS_RESPONSE_GRANTS_PER_CONNECTION,
  MAX_PENDING_EDITOR_RESERVATIONS_PER_CONNECTION,
  MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM,
  MAX_REQUEST_LEASES_PER_CONNECTION,
  MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM,
  MAX_REQUEST_LEASES_PER_ROOM,
  MAX_ROOM_JOIN_FRAMES_PER_CONNECTION,
  MAX_ROOM_JOIN_FRAMES_PER_ROOM,
  MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION,
  MAX_ROOM_RESERVE_FRAMES_PER_ROOM,
  MAX_YJS_CLIENT_ID,
  MAX_YJS_TRANSFER_BYTES,
  MAX_YJS_RETRY_FRAMES_PER_CONNECTION,
  MAX_YJS_RETRY_FRAMES_PER_ROOM,
  MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_CONNECTION,
  MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_ROOM,
  PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
  YJS_CHUNK_PLAINTEXT_BYTES,
  COLLABORATION_PROTOCOL_VERSION as COLLABORATION_PROTOCOL_VERSION_SOURCE,
  type RoomJoinAuthorization,
  type RoomRelayLifecycle,
} from '../src/rooms.js'
import type { Conn } from '../src/registry.js'

// `export const COLLABORATION_PROTOCOL_VERSION = 3` carries a *widening* literal
// type, so `{ protocolVersion: COLLABORATION_PROTOCOL_VERSION }` in a fixture
// infers `number` and no longer matches RelayFrame / RoomJoinAuthorizer, whose
// protocol fields are the literal 3. Re-binding it under an explicit annotation
// makes the reference non-widening so every fixture below narrows on its own.
// Value-identical to the source constant, and still tracks a version bump.
const COLLABORATION_PROTOCOL_VERSION: typeof COLLABORATION_PROTOCOL_VERSION_SOURCE =
  COLLABORATION_PROTOCOL_VERSION_SOURCE

const TEST_ROOM_EPOCH = 'room_epoch_0000000000000001'
const TEST_SECURITY_EPOCH = 'security_epoch_0000000000000001'

function fakeConn(id: string): Conn & { sent: string[] } {
  const sent: string[] = []
  return { socket: { send: (m: string) => sent.push(m) }, userUuid: id, sessionUuid: id, connectionId: id, sent }
}

function fakeLifecycle(): RoomRelayLifecycle {
  return {
    reserveEditorLease: vi.fn().mockResolvedValue({ shouldBootstrap: false }),
    activateEditorLease: vi.fn().mockResolvedValue({ shouldBootstrap: false }),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    claimYjsResponse: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  }
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

  it('preserves request, protocol, transfer, and state-correlation bindings', () => {
    expect(parseRelayFrame(JSON.stringify({ t: 'room-leave', room: 'n1', requestId: 'lease-1' }))).toEqual({
      t: 'room-leave',
      room: 'n1',
      requestId: 'lease-1',
    })
    expect(
      parseRelayFrame(
        JSON.stringify({
          t: 'room-reserve',
          room: 'n1',
          cap: 'cap-1',
          requestId: 'lease-1',
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: TEST_ROOM_EPOCH,
        }),
      ),
    ).toEqual({
      t: 'room-reserve',
      room: 'n1',
      cap: 'cap-1',
      requestId: 'lease-1',
      role: 'editor',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: TEST_ROOM_EPOCH,
    })
    expect(
      parseRelayFrame(
        JSON.stringify({
          t: 'yjs',
          room: 'n1',
          payload: 'ciphertext',
          transferId: 'transfer-1',
          stateRequestId: 'state-1',
        }),
      ),
    ).toEqual({
      t: 'yjs',
      room: 'n1',
      payload: 'ciphertext',
      transferId: 'transfer-1',
      stateRequestId: 'state-1',
    })

    const chunk = {
      t: 'yjs-chunk',
      room: 'n1',
      transferId: 'transfer-1',
      index: 0,
      count: 2,
      totalBytes: YJS_CHUNK_PLAINTEXT_BYTES + 1,
      payload: 'ciphertext',
      stateRequestId: 'state-1',
    }
    expect(parseRelayFrame(JSON.stringify(chunk))).toEqual(chunk)
    expect(
      parseRelayFrame(
        JSON.stringify({
          t: 'yjs-response-claim',
          room: 'n1',
          stateRequestId: 'state-1',
          leaseRequestId: 'lease-1',
        }),
      ),
    ).toEqual({
      t: 'yjs-response-claim',
      room: 'n1',
      stateRequestId: 'state-1',
      leaseRequestId: 'lease-1',
    })
  })

  it.each([
    ['room-leave request', { t: 'room-leave', room: 'n1', requestId: '' }],
    ['retry request', { t: 'yjs-retry', room: 'n1', requestId: 1, requesterClientId: 1 }],
    ['missing retry client', { t: 'yjs-retry', room: 'n1', requestId: 'retry-1' }],
    ['negative retry client', { t: 'yjs-retry', room: 'n1', requestId: 'retry-1', requesterClientId: -1 }],
    ['fractional retry client', { t: 'yjs-retry', room: 'n1', requestId: 'retry-1', requesterClientId: 1.5 }],
    [
      'oversized retry client',
      { t: 'yjs-retry', room: 'n1', requestId: 'retry-1', requesterClientId: MAX_YJS_CLIENT_ID + 1 },
    ],
    ['join request', { t: 'room-join', room: 'n1', requestId: 'x'.repeat(129) }],
    ['join role', { t: 'room-join', room: 'n1', role: 'viewer' }],
    ['reserve protocol', { t: 'room-reserve', room: 'n1', requestId: 'lease-1', role: 'editor', protocolVersion: 1 }],
    ['state correlation', { t: 'yjs', room: 'n1', payload: 'ciphertext', stateRequestId: '' }],
    ['transfer correlation', { t: 'yjs', room: 'n1', payload: 'ciphertext', transferId: 1 }],
    ['missing response state request', { t: 'yjs-response-claim', room: 'n1', leaseRequestId: 'lease-1' }],
    [
      'oversized response state request',
      {
        t: 'yjs-response-claim',
        room: 'n1',
        stateRequestId: 'x'.repeat(129),
        leaseRequestId: 'lease-1',
      },
    ],
    ['missing response lease request', { t: 'yjs-response-claim', room: 'n1', stateRequestId: 'state-1' }],
    [
      'oversized response lease request',
      {
        t: 'yjs-response-claim',
        room: 'n1',
        stateRequestId: 'state-1',
        leaseRequestId: 'x'.repeat(129),
      },
    ],
  ])('rejects malformed optional binding: %s', (_description, frame) => {
    expect(parseRelayFrame(JSON.stringify(frame))).toBeNull()
  })

  it('accepts bounded chunk/retry frames and rejects inconsistent transfer metadata', () => {
    const frame = {
      t: 'yjs-chunk',
      room: 'n1',
      transferId: 'transfer-1',
      index: 1,
      count: 2,
      totalBytes: YJS_CHUNK_PLAINTEXT_BYTES + 1,
      payload: 'opaque-ciphertext',
    }
    expect(parseRelayFrame(JSON.stringify(frame))).toEqual(frame)
    expect(
      parseRelayFrame(
        JSON.stringify({
          t: 'yjs-retry',
          room: 'n1',
          requestId: 'retry-1',
          requesterClientId: MAX_YJS_CLIENT_ID,
        }),
      ),
    ).toEqual({
      t: 'yjs-retry',
      room: 'n1',
      requestId: 'retry-1',
      requesterClientId: MAX_YJS_CLIENT_ID,
    })
    expect(parseRelayFrame(JSON.stringify({ ...frame, index: 2 }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ ...frame, count: 3 }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ ...frame, totalBytes: MAX_YJS_TRANSFER_BYTES + 1 }))).toBeNull()
    expect(parseRelayFrame(JSON.stringify({ ...frame, transferId: 'x'.repeat(129) }))).toBeNull()
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
  it('skips slow consumers for local and cross-replica broadcasts without blocking healthy peers', () => {
    const rooms = new RoomRegistry()
    const sender = fakeConn('sender')
    const healthy = fakeConn('healthy')
    const slow = fakeConn('slow')
    ;(slow.socket as typeof slow.socket & { bufferedAmount: number }).bufferedAmount =
      MAX_COLLABORATION_SOCKET_BUFFERED_BYTES + 1
    rooms.join('n1', sender)
    rooms.join('n1', healthy)
    rooms.join('n1', slow)

    expect(rooms.broadcast('n1', 'local-frame', sender)).toBe(1)
    expect(rooms.broadcastAll('n1', 'remote-frame')).toBe(2)
    expect(healthy.sent).toEqual(['local-frame', 'remote-frame'])
    expect(sender.sent).toEqual(['remote-frame'])
    expect(slow.sent).toEqual([])
  })

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

  it('relays only authorized opaque chunk and retry frames', async () => {
    const rooms = new RoomRegistry()
    const member = fakeConn('member')
    const peer = fakeConn('peer')
    const outsider = fakeConn('outsider')
    await handleRelayFrame(rooms, member, { t: 'room-join', room: 'n1' })
    await handleRelayFrame(rooms, peer, { t: 'room-join', room: 'n1' })
    const chunk = {
      t: 'yjs-chunk' as const,
      room: 'n1',
      transferId: 'transfer-1',
      index: 0,
      count: 2,
      totalBytes: YJS_CHUNK_PLAINTEXT_BYTES + 1,
      payload: 'opaque-ciphertext',
    }
    expect(await handleRelayFrame(rooms, outsider, chunk)).toBe(0)
    expect(await handleRelayFrame(rooms, member, chunk)).toBe(1)
    expect(peer.sent).toContain(JSON.stringify(chunk))

    const retry = { t: 'yjs-retry' as const, room: 'n1', requestId: 'retry-1', requesterClientId: 42 }
    expect(await handleRelayFrame(rooms, member, retry)).toBe(1)
    expect(peer.sent).toContain(JSON.stringify(retry))
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

  it('limits a comment-only lease to comments and restores editor traffic only with a live editor lease', async () => {
    const rooms = new RoomRegistry()
    const mixed = fakeConn('mixed')
    const peer = fakeConn('peer')
    await handleRelayFrame(rooms, mixed, {
      t: 'room-join',
      room: 'n1',
      requestId: 'comment-lease',
      role: 'comment',
    })
    await handleRelayFrame(rooms, peer, { t: 'room-join', room: 'n1' })
    peer.sent.length = 0

    const editorFrames = [
      { t: 'yjs' as const, room: 'n1', payload: 'edit' },
      {
        t: 'yjs-chunk' as const,
        room: 'n1',
        transferId: 'transfer-1',
        index: 0,
        count: 2,
        totalBytes: YJS_CHUNK_PLAINTEXT_BYTES + 1,
        payload: 'chunk',
      },
      { t: 'yjs-retry' as const, room: 'n1', requestId: 'retry-1', requesterClientId: 42 },
      { t: 'awareness' as const, room: 'n1', payload: 'presence' },
    ]
    for (const frame of editorFrames) {
      expect(await handleRelayFrame(rooms, mixed, frame)).toBe(0)
      expect(peer.sent).not.toContain(JSON.stringify(frame))
    }
    const comment = { t: 'comment' as const, room: 'n1', payload: 'comment' }
    expect(await handleRelayFrame(rooms, mixed, comment)).toBe(1)
    expect(peer.sent).toContain(JSON.stringify(comment))

    await handleRelayFrame(rooms, mixed, {
      t: 'room-join',
      room: 'n1',
      requestId: 'editor-lease',
      role: 'editor',
    })
    expect(rooms.hasRole('n1', mixed, 'comment')).toBe(true)
    expect(rooms.hasRole('n1', mixed, 'editor')).toBe(true)
    const edit = { t: 'yjs' as const, room: 'n1', payload: 'authorized-edit' }
    expect(await handleRelayFrame(rooms, mixed, edit)).toBe(1)
    expect(peer.sent).toContain(JSON.stringify(edit))

    await handleRelayFrame(rooms, mixed, { t: 'room-leave', room: 'n1', requestId: 'editor-lease' })
    expect(rooms.hasRole('n1', mixed, 'editor')).toBe(false)
    expect(rooms.hasRole('n1', mixed, 'comment')).toBe(true)
    expect(await handleRelayFrame(rooms, mixed, { ...edit, payload: 'revoked-edit' })).toBe(0)
    expect(await handleRelayFrame(rooms, mixed, { ...comment, payload: 'still-authorized-comment' })).toBe(1)
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
      role: 'editor',
    })
    await handleRelayFrame(rooms, sharedSocket, {
      t: 'room-join',
      room: 'n1',
      requestId: 'comment-lease',
      role: 'comment',
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

  it('ignores a conflicting role replay without revoking the existing logical lease', async () => {
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

    expect(conn.sent).not.toContain(JSON.stringify({ t: 'room-denied', room: 'n1', requestId: 'stable-lease' }))
    expect(rooms.hasRole('n1', conn, 'comment')).toBe(true)
    expect(rooms.hasRole('n1', conn, 'editor')).toBe(false)
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

describe('reservation and expensive control-frame limits', () => {
  it('hard-caps reserve-only leases per connection and per room, then recovers on release, expiry, and close', () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const oneConnection = fakeConn('one-connection')

    for (let index = 0; index < MAX_PENDING_EDITOR_RESERVATIONS_PER_CONNECTION; index += 1) {
      expect(rooms.reservePendingEditorSlot(`connection-room-${index}`, oneConnection, `request-${index}`)).toEqual({
        accepted: true,
        created: true,
      })
    }
    expect(rooms.reservePendingEditorSlot('connection-overflow', oneConnection, 'overflow')).toEqual({
      accepted: false,
      created: false,
    })
    expect(rooms.pendingReservationCountForConn(oneConnection)).toBe(MAX_PENDING_EDITOR_RESERVATIONS_PER_CONNECTION)

    rooms.releasePendingEditorReservation('connection-room-0', oneConnection, 'request-0')
    expect(rooms.reservePendingEditorSlot('connection-recovered', oneConnection, 'recovered')).toEqual({
      accepted: true,
      created: true,
    })
    rooms.leaveAll(oneConnection)
    expect(rooms.pendingReservationCountForConn(oneConnection)).toBe(0)

    const room = 'target-room'
    const roomConnections = Array.from({ length: MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM + 1 }, (_, index) =>
      fakeConn(`room-connection-${index}`),
    )
    for (let index = 0; index < MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM; index += 1) {
      expect(rooms.reservePendingEditorSlot(room, roomConnections[index], `room-request-${index}`).accepted).toBe(true)
      expect(rooms.confirmPendingEditorReservation(room, roomConnections[index], `room-request-${index}`, 2_000)).toBe(
        2_000,
      )
    }
    expect(
      rooms.reservePendingEditorSlot(room, roomConnections[MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM], 'room-overflow')
        .accepted,
    ).toBe(false)
    expect(rooms.pendingReservationCountForRoom(room)).toBe(MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM)

    now = 2_001
    const expired = rooms.evictExpired()
    expect(expired).toHaveLength(MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM)
    expect(expired.every((reservation) => reservation.room === room)).toBe(true)
    expect(rooms.pendingReservationCountForRoom(room)).toBe(0)
    expect(
      rooms.reservePendingEditorSlot(room, roomConnections[MAX_PENDING_EDITOR_RESERVATIONS_PER_ROOM], 'room-recovered')
        .accepted,
    ).toBe(true)
  })

  it('keeps reservation replay idempotent and cleans exact logical leases without disturbing siblings', () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('idempotent')
    const peer = fakeConn('idempotent-peer')

    expect(rooms.reservePendingEditorSlot('shared-room', conn, 'request-a')).toEqual({
      accepted: true,
      created: true,
    })
    expect(rooms.confirmPendingEditorReservation('shared-room', conn, 'request-a', 60_000)).toBe(
      now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
    )
    const originalActivationDeadline = now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS
    now = 5_000
    expect(rooms.reservePendingEditorSlot('shared-room', conn, 'request-a')).toEqual({
      accepted: true,
      created: false,
    })
    expect(rooms.confirmPendingEditorReservation('shared-room', conn, 'request-a', 60_000)).toBe(
      originalActivationDeadline,
    )
    expect(rooms.reservePendingEditorSlot('shared-room', conn, 'request-b').accepted).toBe(true)
    expect(rooms.reservePendingEditorSlot('shared-room', peer, 'peer-request').accepted).toBe(true)
    expect(rooms.takeExpiredPendingEditorReservationsForRoom('shared-room')).toEqual([])
    expect(rooms.takeExpiredPendingEditorReservationsForConn(conn)).toEqual([])

    rooms.releasePendingEditorReservation('shared-room', conn, 'request-a')
    expect(rooms.hasPendingEditorReservation('shared-room', conn, 'request-b')).toBe(true)
    expect(rooms.pendingReservationCountForRoom('shared-room')).toBe(2)

    expect(rooms.confirmPendingEditorReservation('missing-room', conn, 'missing-request', 60_000)).toBeUndefined()
    expect(rooms.reservePendingEditorSlot('invalid-expiry', conn, 'invalid-expiry').accepted).toBe(true)
    expect(
      rooms.confirmPendingEditorReservation('invalid-expiry', conn, 'invalid-expiry', Number.POSITIVE_INFINITY),
    ).toBeUndefined()
  })

  it('bounds request leases per connection and per connection-room while preserving editor/comment overlap', () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('bounded-request-leases')

    for (let index = 0; index < MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM; index += 1) {
      expect(
        rooms.join('mixed-room', conn, Number.POSITIVE_INFINITY, `mixed-${index}`, index === 0 ? 'editor' : 'comment')
          .joined,
      ).toBe(true)
    }
    expect(rooms.join('mixed-room', conn, Number.POSITIVE_INFINITY, 'mixed-0', 'editor').joined).toBe(true)
    expect(rooms.join('mixed-room', conn, Number.POSITIVE_INFINITY, 'mixed-0', 'comment').joined).toBe(false)
    expect(rooms.join('mixed-room', conn, Number.POSITIVE_INFINITY, 'mixed-overflow', 'comment').joined).toBe(false)
    expect(rooms.hasRole('mixed-room', conn, 'editor')).toBe(true)
    expect(rooms.hasRole('mixed-room', conn, 'comment')).toBe(true)

    rooms.leave('mixed-room', conn, `mixed-${MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM - 1}`)
    expect(rooms.join('mixed-room', conn, Number.POSITIVE_INFINITY, 'mixed-recovered', 'comment').joined).toBe(true)

    const totalRooms = new RoomRegistry()
    const totalConn = fakeConn('total-request-leases')
    const roomCount = MAX_REQUEST_LEASES_PER_CONNECTION / MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM
    for (let roomIndex = 0; roomIndex < roomCount; roomIndex += 1) {
      for (let leaseIndex = 0; leaseIndex < MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM; leaseIndex += 1) {
        expect(
          totalRooms.join(
            `total-room-${roomIndex}`,
            totalConn,
            Number.POSITIVE_INFINITY,
            `total-${roomIndex}-${leaseIndex}`,
            'comment',
          ).joined,
        ).toBe(true)
      }
    }
    expect(totalRooms.join('total-overflow', totalConn, Number.POSITIVE_INFINITY, 'overflow', 'comment').joined).toBe(
      false,
    )
    totalRooms.leave('total-room-0', totalConn, 'total-0-0')
    expect(totalRooms.join('total-recovered', totalConn, Number.POSITIVE_INFINITY, 'recovered', 'comment').joined).toBe(
      true,
    )
  })

  it('bounds aggregate request leases and room fanout while allowing existing members to add a sibling lease', () => {
    const requestRooms = new RoomRegistry()
    const requestConnections = Array.from(
      { length: MAX_REQUEST_LEASES_PER_ROOM / MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM + 1 },
      (_, index) => fakeConn(`aggregate-request-${index}`),
    )
    for (let connectionIndex = 0; connectionIndex < requestConnections.length - 1; connectionIndex += 1) {
      for (let leaseIndex = 0; leaseIndex < MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM; leaseIndex += 1) {
        expect(
          requestRooms.join(
            'aggregate-request-room',
            requestConnections[connectionIndex],
            Number.POSITIVE_INFINITY,
            `request-${connectionIndex}-${leaseIndex}`,
            'comment',
          ).joined,
        ).toBe(true)
      }
    }
    const requestOverflow = requestConnections[requestConnections.length - 1]
    expect(
      requestRooms.join(
        'aggregate-request-room',
        requestOverflow,
        Number.POSITIVE_INFINITY,
        'request-overflow',
        'comment',
      ).joined,
    ).toBe(false)
    requestRooms.leave('aggregate-request-room', requestConnections[0], 'request-0-0')
    expect(
      requestRooms.join(
        'aggregate-request-room',
        requestOverflow,
        Number.POSITIVE_INFINITY,
        'request-recovered',
        'comment',
      ).joined,
    ).toBe(true)

    const fanoutRooms = new RoomRegistry()
    const members = Array.from({ length: MAX_CONNECTIONS_PER_ROOM + 1 }, (_, index) => fakeConn(`fanout-${index}`))
    for (let index = 0; index < MAX_CONNECTIONS_PER_ROOM; index += 1) {
      expect(
        fanoutRooms.join('fanout-room', members[index], Number.POSITIVE_INFINITY, `fanout-${index}`, 'comment').joined,
      ).toBe(true)
    }
    expect(
      fanoutRooms.join(
        'fanout-room',
        members[MAX_CONNECTIONS_PER_ROOM],
        Number.POSITIVE_INFINITY,
        'fanout-overflow',
        'comment',
      ).joined,
    ).toBe(false)
    expect(
      fanoutRooms.join('fanout-room', members[0], Number.POSITIVE_INFINITY, 'fanout-sibling', 'editor').joined,
    ).toBe(true)
  })

  it('throttles unique joins before authorization but lets exact replays through without global churn', async () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('join-flooder')
    const authorize = vi.fn((_userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    }))
    const joinComment = (room: string, requestId: string) =>
      handleRelayFrame(
        rooms,
        conn,
        {
          t: 'room-join',
          room,
          cap: requestId,
          requestId,
          role: 'comment',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: TEST_ROOM_EPOCH,
        },
        authorize,
      )

    for (let index = 0; index < MAX_ROOM_JOIN_FRAMES_PER_CONNECTION; index += 1) {
      await joinComment(`join-room-${index}`, `join-request-${index}`)
    }
    await joinComment('join-overflow', 'join-overflow')
    expect(authorize).toHaveBeenCalledTimes(MAX_ROOM_JOIN_FRAMES_PER_CONNECTION)
    expect(rooms.isMember('join-overflow', conn)).toBe(false)

    conn.sent.length = 0
    await joinComment('join-room-0', 'join-request-0')
    expect(authorize).toHaveBeenCalledTimes(MAX_ROOM_JOIN_FRAMES_PER_CONNECTION)
    expect(conn.sent).toContain(
      JSON.stringify({
        t: 'room-joined',
        room: 'join-room-0',
        requestId: 'join-request-0',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
        roomEpoch: TEST_ROOM_EPOCH,
      }),
    )

    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'join-room-0',
        requestId: 'join-request-0',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )
    expect(rooms.hasRole('join-room-0', conn, 'comment')).toBe(true)
    expect(rooms.hasRole('join-room-0', conn, 'editor')).toBe(false)

    now += CONTROL_FRAME_WINDOW_MS
    await joinComment('join-recovered', 'join-recovered')
    expect(authorize).toHaveBeenCalledTimes(MAX_ROOM_JOIN_FRAMES_PER_CONNECTION + 1)

    const aggregateRooms = new RoomRegistry(() => 1_000)
    const aggregateAuthorize = vi.fn((_userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    }))
    const aggregateConnections = Array.from({ length: MAX_ROOM_JOIN_FRAMES_PER_ROOM + 1 }, (_, index) =>
      fakeConn(`aggregate-join-${index}`),
    )
    for (let index = 0; index < aggregateConnections.length; index += 1) {
      await handleRelayFrame(
        aggregateRooms,
        aggregateConnections[index],
        {
          t: 'room-join',
          room: 'aggregate-join-room',
          cap: `aggregate-join-${index}`,
          requestId: `aggregate-join-${index}`,
          role: 'comment',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: TEST_ROOM_EPOCH,
        },
        aggregateAuthorize,
      )
    }
    expect(aggregateAuthorize).toHaveBeenCalledTimes(MAX_ROOM_JOIN_FRAMES_PER_ROOM)
    expect(aggregateRooms.members('aggregate-join-room')).toHaveLength(MAX_ROOM_JOIN_FRAMES_PER_ROOM)

    aggregateConnections[0].sent.length = 0
    await handleRelayFrame(
      aggregateRooms,
      aggregateConnections[0],
      {
        t: 'room-join',
        room: 'aggregate-join-room',
        cap: 'aggregate-join-0',
        requestId: 'aggregate-join-0',
        role: 'comment',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      aggregateAuthorize,
    )
    expect(aggregateAuthorize).toHaveBeenCalledTimes(MAX_ROOM_JOIN_FRAMES_PER_ROOM)
    expect(aggregateConnections[0].sent.some((message) => message.includes('"t":"room-joined"'))).toBe(true)
  })

  it('cleans only a denied editor attempt while preserving an existing valid lease', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const conn = fakeConn('editor-cap-denial')
    expect(rooms.join('editor-cap-room', conn, 60_000, 'valid-editor', 'editor').joined).toBe(true)
    for (let index = 1; index < MAX_REQUEST_LEASES_PER_CONNECTION_PER_ROOM; index += 1) {
      expect(rooms.join('editor-cap-room', conn, 60_000, `comment-${index}`, 'comment').joined).toBe(true)
    }
    expect(rooms.reservePendingEditorSlot('editor-cap-room', conn, 'overflow-editor').accepted).toBe(true)
    const lifecycle = fakeLifecycle()
    const authorize = vi.fn()

    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'editor-cap-room',
        requestId: 'overflow-editor',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      },
      authorize,
      undefined,
      lifecycle,
    )

    expect(authorize).not.toHaveBeenCalled()
    expect(lifecycle.activateEditorLease).not.toHaveBeenCalled()
    expect(lifecycle.releaseLease).toHaveBeenCalledWith(conn, 'editor-cap-room', 'overflow-editor')
    expect(rooms.hasPendingEditorReservation('editor-cap-room', conn, 'overflow-editor')).toBe(false)
    expect(rooms.requestLease('editor-cap-room', conn, 'valid-editor')).toMatchObject({ role: 'editor' })
    expect(rooms.hasRole('editor-cap-room', conn, 'editor')).toBe(true)
  })

  it('acknowledges an exact active editor replay without reauthorization, reactivation, or sync fanout', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const conn = fakeConn('strict-mode-editor')
    expect(rooms.join('strict-mode-room', conn, 60_000, 'stable-editor', 'editor', true).joined).toBe(true)
    expect(rooms.reservePendingEditorSlot('strict-mode-room', conn, 'stable-editor').accepted).toBe(true)
    const lifecycle = fakeLifecycle()
    const authorize = vi.fn()

    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'strict-mode-room',
        requestId: 'stable-editor',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      },
      authorize,
      undefined,
      lifecycle,
    )

    expect(authorize).not.toHaveBeenCalled()
    expect(lifecycle.activateEditorLease).not.toHaveBeenCalled()
    expect(lifecycle.releaseLease).not.toHaveBeenCalled()
    expect(lifecycle.publish).not.toHaveBeenCalled()
    expect(rooms.hasPendingEditorReservation('strict-mode-room', conn, 'stable-editor')).toBe(false)
    expect(rooms.requestLease('strict-mode-room', conn, 'stable-editor')).toMatchObject({
      role: 'editor',
      shouldBootstrap: true,
    })
    expect(conn.sent).toContain(
      JSON.stringify({
        t: 'room-joined',
        room: 'strict-mode-room',
        requestId: 'stable-editor',
        bootstrap: true,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      }),
    )

    conn.sent.length = 0
    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'strict-mode-room',
        requestId: 'stable-editor',
        role: 'editor',
      },
      authorize,
      undefined,
      lifecycle,
    )
    expect(conn.sent).toEqual([])
    expect(lifecycle.releaseLease).not.toHaveBeenCalled()
    expect(rooms.hasRole('strict-mode-room', conn, 'editor')).toBe(true)
  })

  it('denies unsupported and unauthorized reservations without retaining pending capacity', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const conn = fakeConn('denied-reservation')
    const frame = {
      t: 'room-reserve' as const,
      room: 'denied-room',
      cap: 'denied-request',
      requestId: 'denied-request',
      role: 'editor' as const,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: TEST_ROOM_EPOCH,
    }

    await handleRelayFrame(rooms, conn, frame)
    expect(rooms.pendingReservationCountForConn(conn)).toBe(0)

    const lifecycle = fakeLifecycle()
    const authorize = vi.fn().mockResolvedValue({ authorized: false as const })
    await handleRelayFrame(rooms, conn, frame, authorize, undefined, lifecycle)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(lifecycle.reserveEditorLease).not.toHaveBeenCalled()
    expect(rooms.pendingReservationCountForConn(conn)).toBe(0)
  })

  it('rejects a pending-cap flood before capability authorization or distributed reservation', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const conn = fakeConn('pending-flooder')
    for (let index = 0; index < MAX_PENDING_EDITOR_RESERVATIONS_PER_CONNECTION; index += 1) {
      rooms.reservePendingEditorSlot(`held-${index}`, conn, `held-${index}`)
      rooms.confirmPendingEditorReservation(`held-${index}`, conn, `held-${index}`, 60_000)
    }
    const authorize = vi.fn()
    const lifecycle = fakeLifecycle()

    await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-reserve',
        room: 'overflow-room',
        cap: 'overflow-request',
        requestId: 'overflow-request',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
      undefined,
      lifecycle,
    )

    expect(authorize).not.toHaveBeenCalled()
    expect(lifecycle.reserveEditorLease).not.toHaveBeenCalled()
    expect(conn.sent).toContain(
      JSON.stringify({ t: 'room-denied', room: 'overflow-room', requestId: 'overflow-request' }),
    )
  })

  it('releases expired distributed reservations before admitting replacement work', async () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('expiry-recovery')
    const lifecycle = fakeLifecycle()
    const authorize = vi.fn((_userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: capability === 'old-request' ? 2_000 : 20_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    }))
    const reserve = (room: string, requestId: string) =>
      handleRelayFrame(
        rooms,
        conn,
        {
          t: 'room-reserve',
          room,
          cap: requestId,
          requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: TEST_ROOM_EPOCH,
        },
        authorize,
        undefined,
        lifecycle,
      )

    await reserve('old-room', 'old-request')
    now = 2_001
    await reserve('new-room', 'new-request')

    expect(lifecycle.releaseLease).toHaveBeenCalledWith(conn, 'old-room', 'old-request')
    expect(lifecycle.reserveEditorLease).toHaveBeenCalledTimes(2)
    expect(vi.mocked(lifecycle.reserveEditorLease).mock.calls[1][3]).toBe(
      now + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
    )
    expect(rooms.pendingReservationCountForConn(conn)).toBe(1)
    expect(rooms.hasPendingEditorReservation('new-room', conn, 'new-request')).toBe(true)
  })

  it('throttles unique room-reserve ids per connection before repeated authorization and recovers next window', async () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('reserve-flooder')
    const lifecycle = fakeLifecycle()
    const authorize = vi.fn((_userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    }))
    const reserveAndRelease = async (index: number): Promise<void> => {
      const room = `reserve-room-${index}`
      const requestId = `reserve-request-${index}`
      await handleRelayFrame(
        rooms,
        conn,
        {
          t: 'room-reserve',
          room,
          cap: requestId,
          requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: TEST_ROOM_EPOCH,
        },
        authorize,
        undefined,
        lifecycle,
      )
      await handleRelayFrame(rooms, conn, { t: 'room-leave', room, requestId }, authorize, undefined, lifecycle)
    }

    for (let index = 0; index < MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION; index += 1) {
      await reserveAndRelease(index)
    }
    await reserveAndRelease(MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION)
    expect(authorize).toHaveBeenCalledTimes(MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION)
    expect(lifecycle.reserveEditorLease).toHaveBeenCalledTimes(MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION)

    now += CONTROL_FRAME_WINDOW_MS
    await reserveAndRelease(MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION + 1)
    expect(authorize).toHaveBeenCalledTimes(MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION + 1)
    expect(lifecycle.reserveEditorLease).toHaveBeenCalledTimes(MAX_ROOM_RESERVE_FRAMES_PER_CONNECTION + 1)
  })

  it('throttles aggregate room-reserve floods across connections', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const lifecycle = fakeLifecycle()
    const authorize = vi.fn((_userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    }))

    for (let index = 0; index <= MAX_ROOM_RESERVE_FRAMES_PER_ROOM; index += 1) {
      const conn = fakeConn(`aggregate-reserve-${index}`)
      const requestId = `aggregate-request-${index}`
      await handleRelayFrame(
        rooms,
        conn,
        {
          t: 'room-reserve',
          room: 'aggregate-room',
          cap: requestId,
          requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: TEST_ROOM_EPOCH,
        },
        authorize,
        undefined,
        lifecycle,
      )
      await handleRelayFrame(
        rooms,
        conn,
        { t: 'room-leave', room: 'aggregate-room', requestId },
        authorize,
        undefined,
        lifecycle,
      )
    }

    expect(authorize).toHaveBeenCalledTimes(MAX_ROOM_RESERVE_FRAMES_PER_ROOM)
    expect(lifecycle.reserveEditorLease).toHaveBeenCalledTimes(MAX_ROOM_RESERVE_FRAMES_PER_ROOM)
  })

  it('bounds unique yjs-retry amplification per connection and aggregate room', async () => {
    let now = 1_000
    const connectionRooms = new RoomRegistry(() => now)
    const sender = fakeConn('retry-sender')
    const peer = fakeConn('retry-peer')
    await handleRelayFrame(connectionRooms, sender, { t: 'room-join', room: 'retry-room' })
    await handleRelayFrame(connectionRooms, peer, { t: 'room-join', room: 'retry-room' })
    peer.sent.length = 0

    for (let index = 0; index < MAX_YJS_RETRY_FRAMES_PER_CONNECTION; index += 1) {
      expect(
        await handleRelayFrame(connectionRooms, sender, {
          t: 'yjs-retry',
          room: 'retry-room',
          requestId: `retry-${index}`,
          requesterClientId: 42,
        }),
      ).toBe(1)
    }
    expect(
      await handleRelayFrame(connectionRooms, sender, {
        t: 'yjs-retry',
        room: 'retry-room',
        requestId: 'retry-overflow',
        requesterClientId: 42,
      }),
    ).toBe(0)
    expect(peer.sent.filter((message) => message.includes('"t":"yjs-retry"'))).toHaveLength(
      MAX_YJS_RETRY_FRAMES_PER_CONNECTION,
    )

    now += CONTROL_FRAME_WINDOW_MS
    expect(
      await handleRelayFrame(connectionRooms, sender, {
        t: 'yjs-retry',
        room: 'retry-room',
        requestId: 'retry-recovered',
        requesterClientId: 42,
      }),
    ).toBe(1)

    const aggregateRooms = new RoomRegistry(() => 1_000)
    const aggregateSenders = Array.from({ length: MAX_YJS_RETRY_FRAMES_PER_ROOM + 1 }, (_, index) =>
      fakeConn(`aggregate-retry-${index}`),
    )
    for (const aggregateSender of aggregateSenders) {
      await handleRelayFrame(aggregateRooms, aggregateSender, { t: 'room-join', room: 'aggregate-retry-room' })
    }
    let accepted = 0
    for (let index = 0; index < aggregateSenders.length; index += 1) {
      const reached = await handleRelayFrame(aggregateRooms, aggregateSenders[index], {
        t: 'yjs-retry',
        room: 'aggregate-retry-room',
        requestId: `aggregate-retry-${index}`,
        requesterClientId: index,
      })
      if (reached > 0) {
        accepted += 1
      }
    }
    expect(accepted).toBe(MAX_YJS_RETRY_FRAMES_PER_ROOM)
  })
})

describe('distributed Yjs response claims', () => {
  it('grants only an exact live editor lease and never grants comments, wrong ids, or lifecycle failure', async () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const editor = fakeConn('claim-editor')
    const commenter = fakeConn('claim-commenter')
    const expiresAt = now + 1_000
    rooms.join('claim-room', editor, expiresAt, 'editor-lease', 'editor')
    rooms.join('claim-room', commenter, expiresAt, 'comment-lease', 'comment')
    const lifecycle = fakeLifecycle()
    vi.mocked(lifecycle.claimYjsResponse).mockResolvedValue(expiresAt)

    await handleRelayFrame(
      rooms,
      editor,
      {
        t: 'yjs-response-claim',
        room: 'claim-room',
        stateRequestId: 'state-one',
        leaseRequestId: 'editor-lease',
      },
      undefined,
      undefined,
      lifecycle,
    )
    expect(lifecycle.claimYjsResponse).toHaveBeenCalledWith(editor, 'claim-room', 'state-one', 'editor-lease')
    expect(editor.sent).toContain(
      JSON.stringify({
        t: 'yjs-response-granted',
        room: 'claim-room',
        stateRequestId: 'state-one',
        leaseRequestId: 'editor-lease',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      }),
    )

    vi.mocked(lifecycle.claimYjsResponse).mockClear()
    await handleRelayFrame(
      rooms,
      commenter,
      {
        t: 'yjs-response-claim',
        room: 'claim-room',
        stateRequestId: 'state-comment',
        leaseRequestId: 'comment-lease',
      },
      undefined,
      undefined,
      lifecycle,
    )
    await handleRelayFrame(
      rooms,
      editor,
      {
        t: 'yjs-response-claim',
        room: 'claim-room',
        stateRequestId: 'state-wrong',
        leaseRequestId: 'wrong-lease',
      },
      undefined,
      undefined,
      lifecycle,
    )
    expect(lifecycle.claimYjsResponse).not.toHaveBeenCalled()
    expect(commenter.sent.some((message) => message.includes('yjs-response-granted'))).toBe(false)

    vi.mocked(lifecycle.claimYjsResponse).mockRejectedValue(new Error('redis unavailable'))
    await handleRelayFrame(
      rooms,
      editor,
      {
        t: 'yjs-response-claim',
        room: 'claim-room',
        stateRequestId: 'state-failed',
        leaseRequestId: 'editor-lease',
      },
      undefined,
      undefined,
      lifecycle,
    )
    expect(editor.sent.some((message) => message.includes('state-failed'))).toBe(false)

    now = expiresAt
    vi.mocked(lifecycle.claimYjsResponse).mockClear()
    await handleRelayFrame(
      rooms,
      editor,
      {
        t: 'yjs-response-claim',
        room: 'claim-room',
        stateRequestId: 'state-expired',
        leaseRequestId: 'editor-lease',
      },
      undefined,
      undefined,
      lifecycle,
    )
    expect(lifecycle.claimYjsResponse).not.toHaveBeenCalled()
    expect(editor.sent.some((message) => message.includes('state-expired'))).toBe(false)
  })

  it('requires a distributed lifecycle and bounds claim work per connection and room window', async () => {
    const noLifecycleRooms = new RoomRegistry()
    const noLifecycle = fakeConn('claim-no-lifecycle')
    noLifecycleRooms.join('claim-no-lifecycle-room', noLifecycle, Infinity, 'lease', 'editor')
    await handleRelayFrame(noLifecycleRooms, noLifecycle, {
      t: 'yjs-response-claim',
      room: 'claim-no-lifecycle-room',
      stateRequestId: 'state',
      leaseRequestId: 'lease',
    })
    expect(noLifecycle.sent.some((message) => message.includes('yjs-response-granted'))).toBe(false)

    const perConnectionRooms = new RoomRegistry(() => 1_000)
    const one = fakeConn('claim-bounded-one')
    perConnectionRooms.join('claim-bounded-room', one, Infinity, 'lease', 'editor')
    const perConnectionLifecycle = fakeLifecycle()
    for (let index = 0; index <= MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_CONNECTION; index += 1) {
      await handleRelayFrame(
        perConnectionRooms,
        one,
        {
          t: 'yjs-response-claim',
          room: 'claim-bounded-room',
          stateRequestId: `state-${index}`,
          leaseRequestId: 'lease',
        },
        undefined,
        undefined,
        perConnectionLifecycle,
      )
    }
    expect(perConnectionLifecycle.claimYjsResponse).toHaveBeenCalledTimes(MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_CONNECTION)

    const aggregateRooms = new RoomRegistry(() => 1_000)
    const aggregateLifecycle = fakeLifecycle()
    const claimants = Array.from({ length: MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_ROOM }, (_, index) => {
      const conn = fakeConn(`aggregate-claim-${index}`)
      aggregateRooms.join('aggregate-claim-room', conn, Infinity, `lease-${index}`, 'editor')
      return conn
    })
    for (let index = 0; index < claimants.length; index += 1) {
      await handleRelayFrame(
        aggregateRooms,
        claimants[index],
        {
          t: 'yjs-response-claim',
          room: 'aggregate-claim-room',
          stateRequestId: 'shared-state',
          leaseRequestId: `lease-${index}`,
        },
        undefined,
        undefined,
        aggregateLifecycle,
      )
    }
    await handleRelayFrame(
      aggregateRooms,
      claimants[0],
      {
        t: 'yjs-response-claim',
        room: 'aggregate-claim-room',
        stateRequestId: 'room-overflow',
        leaseRequestId: 'lease-0',
      },
      undefined,
      undefined,
      aggregateLifecycle,
    )
    expect(aggregateLifecycle.claimYjsResponse).toHaveBeenCalledTimes(MAX_YJS_RESPONSE_CLAIM_FRAMES_PER_ROOM)
  })

  it('drops rolling old-client correlated responses without a grant while preserving uncorrelated Yjs', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const oldClient = fakeConn('old-client')
    const peer = fakeConn('old-client-peer')
    rooms.join('old-client-room', oldClient, 2_000, 'old-client-lease', 'editor')
    rooms.join('old-client-room', peer, 2_000, 'peer-lease', 'editor')
    const lifecycle = fakeLifecycle()
    const correlated = {
      t: 'yjs' as const,
      room: 'old-client-room',
      payload: 'cached-full-state',
      stateRequestId: 'unclaimed-state',
    }

    await expect(handleRelayFrame(rooms, oldClient, correlated, undefined, undefined, lifecycle)).resolves.toBe(0)
    expect(lifecycle.publish).not.toHaveBeenCalled()
    expect(peer.sent).not.toContain(JSON.stringify(correlated))

    const incremental = { t: 'yjs' as const, room: 'old-client-room', payload: 'incremental-update' }
    await expect(handleRelayFrame(rooms, oldClient, incremental, undefined, undefined, lifecycle)).resolves.toBe(1)
    expect(lifecycle.publish).toHaveBeenCalledWith(incremental)
    expect(peer.sent).toContain(JSON.stringify(incremental))
  })

  it('binds a grant to one connection and consumes it on the first exact single-frame response', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const winner = fakeConn('grant-winner')
    const other = fakeConn('grant-other')
    const peer = fakeConn('grant-peer')
    for (const [conn, leaseRequestId] of [
      [winner, 'winner-lease'],
      [other, 'other-lease'],
      [peer, 'peer-lease'],
    ] as const) {
      rooms.join('grant-room', conn, 2_000, leaseRequestId, 'editor')
    }
    expect(rooms.recordYjsResponseGrant('grant-room', winner, 'state-one', 'winner-lease', 1_500)).toBe(true)
    const lifecycle = fakeLifecycle()
    const response = { t: 'yjs' as const, room: 'grant-room', payload: 'full-state', stateRequestId: 'state-one' }

    await handleRelayFrame(rooms, other, response, undefined, undefined, lifecycle)
    expect(lifecycle.publish).not.toHaveBeenCalled()
    await expect(handleRelayFrame(rooms, winner, response, undefined, undefined, lifecycle)).resolves.toBe(2)
    expect(lifecycle.publish).toHaveBeenCalledTimes(1)
    await handleRelayFrame(rooms, winner, response, undefined, undefined, lifecycle)
    expect(lifecycle.publish).toHaveBeenCalledTimes(1)
    expect(peer.sent.filter((message) => message === JSON.stringify(response))).toHaveLength(1)
  })

  it('binds chunked responses to one transfer shape, rejects duplicates/mismatches, and consumes on completion', async () => {
    const rooms = new RoomRegistry(() => 1_000)
    const winner = fakeConn('chunk-grant-winner')
    const other = fakeConn('chunk-grant-other')
    const peer = fakeConn('chunk-grant-peer')
    rooms.join('chunk-grant-room', winner, 2_000, 'winner-lease', 'editor')
    rooms.join('chunk-grant-room', other, 2_000, 'other-lease', 'editor')
    rooms.join('chunk-grant-room', peer, 2_000, 'peer-lease', 'editor')
    expect(rooms.recordYjsResponseGrant('chunk-grant-room', winner, 'chunk-state', 'winner-lease', 1_500)).toBe(true)
    const lifecycle = fakeLifecycle()
    const first = {
      t: 'yjs-chunk' as const,
      room: 'chunk-grant-room',
      transferId: 'transfer-one',
      index: 0,
      count: 2,
      totalBytes: YJS_CHUNK_PLAINTEXT_BYTES + 1,
      payload: 'chunk-zero',
      stateRequestId: 'chunk-state',
    }
    const second = { ...first, index: 1, payload: 'chunk-one' }

    await handleRelayFrame(rooms, other, first, undefined, undefined, lifecycle)
    // Out-of-order index=count-1 is a valid unique chunk, but it must not
    // acknowledge/consume the transfer before every index has arrived.
    await expect(handleRelayFrame(rooms, winner, second, undefined, undefined, lifecycle)).resolves.toBe(2)
    expect(winner.sent.some((message) => message.includes('"t":"yjs-accepted"'))).toBe(false)
    await handleRelayFrame(rooms, winner, second, undefined, undefined, lifecycle)
    await handleRelayFrame(
      rooms,
      winner,
      { ...first, transferId: 'mismatched-transfer' },
      undefined,
      undefined,
      lifecycle,
    )
    await expect(handleRelayFrame(rooms, winner, first, undefined, undefined, lifecycle)).resolves.toBe(2)
    expect(winner.sent).toContain(
      JSON.stringify({
        t: 'yjs-accepted',
        room: 'chunk-grant-room',
        transferId: 'transfer-one',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      }),
    )
    await handleRelayFrame(rooms, winner, first, undefined, undefined, lifecycle)

    expect(lifecycle.publish).toHaveBeenCalledTimes(2)
    expect(lifecycle.publish).toHaveBeenNthCalledWith(1, second)
    expect(lifecycle.publish).toHaveBeenNthCalledWith(2, first)
    expect(peer.sent.filter((message) => message.includes('"stateRequestId":"chunk-state"'))).toHaveLength(2)
  })

  it.each(['single-frame', 'final-chunk'] as const)(
    'consumes a %s grant before uncertain publish failure and denies the room instead of permitting replay',
    async (kind) => {
      const rooms = new RoomRegistry(() => 1_000)
      const winner = fakeConn(`publish-failure-${kind}`)
      rooms.join('publish-failure-room', winner, 2_000, 'winner-lease', 'editor')
      expect(rooms.recordYjsResponseGrant('publish-failure-room', winner, 'failure-state', 'winner-lease', 1_500)).toBe(
        true,
      )
      const lifecycle = fakeLifecycle()
      const single = {
        t: 'yjs' as const,
        room: 'publish-failure-room',
        payload: 'single-state',
        stateRequestId: 'failure-state',
      }
      const firstChunk = {
        t: 'yjs-chunk' as const,
        room: 'publish-failure-room',
        transferId: 'failure-transfer',
        index: 0,
        count: 2,
        totalBytes: YJS_CHUNK_PLAINTEXT_BYTES + 1,
        payload: 'first-chunk',
        stateRequestId: 'failure-state',
      }
      const finalChunk = { ...firstChunk, index: 1, payload: 'final-chunk' }
      if (kind === 'final-chunk') {
        vi.mocked(lifecycle.publish)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('uncertain publish'))
        await handleRelayFrame(rooms, winner, firstChunk, undefined, undefined, lifecycle)
      } else {
        vi.mocked(lifecycle.publish).mockRejectedValueOnce(new Error('uncertain publish'))
      }
      const failingFrame = kind === 'final-chunk' ? finalChunk : single

      await handleRelayFrame(rooms, winner, failingFrame, undefined, undefined, lifecycle)

      expect(rooms.isMember('publish-failure-room', winner)).toBe(false)
      expect(winner.sent).toContain(
        JSON.stringify({ t: 'room-denied', room: 'publish-failure-room', requestId: 'winner-lease' }),
      )
      rooms.join('publish-failure-room', winner, 2_000, 'winner-lease', 'editor')
      vi.mocked(lifecycle.publish).mockClear()
      vi.mocked(lifecycle.publish).mockResolvedValue(undefined)
      await handleRelayFrame(rooms, winner, failingFrame, undefined, undefined, lifecycle)
      expect(lifecycle.publish).not.toHaveBeenCalled()
    },
  )

  it('expires grants and cleans them on exact leave, lease expiry, connection close, and room denial', () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('grant-cleanup')
    const frame = (stateRequestId: string) => ({
      t: 'yjs' as const,
      room: 'cleanup-room',
      payload: 'full-state',
      stateRequestId,
    })
    const join = (expiresAt = now + 1_000) => rooms.join('cleanup-room', conn, expiresAt, 'cleanup-lease', 'editor')

    join()
    expect(rooms.recordYjsResponseGrant('cleanup-room', conn, 'leave-state', 'cleanup-lease', now + 500)).toBe(true)
    rooms.leave('cleanup-room', conn, 'cleanup-lease')
    join()
    expect(rooms.authorizeYjsResponseFrame('cleanup-room', conn, frame('leave-state'))).toBe('denied')

    expect(rooms.recordYjsResponseGrant('cleanup-room', conn, 'close-state', 'cleanup-lease', now + 500)).toBe(true)
    rooms.leaveAll(conn)
    join()
    expect(rooms.authorizeYjsResponseFrame('cleanup-room', conn, frame('close-state'))).toBe('denied')

    expect(rooms.recordYjsResponseGrant('cleanup-room', conn, 'denied-state', 'cleanup-lease', now + 500)).toBe(true)
    rooms.denyRoom('cleanup-room')
    join()
    expect(rooms.authorizeYjsResponseFrame('cleanup-room', conn, frame('denied-state'))).toBe('denied')

    expect(rooms.recordYjsResponseGrant('cleanup-room', conn, 'grant-expired', 'cleanup-lease', now + 5)).toBe(true)
    now += 5
    rooms.evictExpired()
    expect(rooms.authorizeYjsResponseFrame('cleanup-room', conn, frame('grant-expired'))).toBe('denied')

    expect(rooms.recordYjsResponseGrant('cleanup-room', conn, 'lease-expired', 'cleanup-lease', now + 500)).toBe(true)
    now += 996
    rooms.members('cleanup-room')
    join()
    expect(rooms.authorizeYjsResponseFrame('cleanup-room', conn, frame('lease-expired'))).toBe('denied')
  })

  it('never enumerates unrelated global grant rooms while recording or disconnecting one connection', () => {
    const rooms = new RoomRegistry(() => 1_000)
    const unrelated: Array<{ conn: ReturnType<typeof fakeConn>; room: string }> = []
    for (let index = 0; index < 2_000; index += 1) {
      const conn = fakeConn(`unrelated-grant-${index}`)
      const room = `unrelated-grant-room-${index}`
      rooms.join(room, conn, 10_000, 'lease', 'editor')
      expect(rooms.recordYjsResponseGrant(room, conn, 'state', 'lease', 5_000)).toBe(true)
      if (index === 0) {
        unrelated.push({ conn, room })
      }
    }
    const target = fakeConn('reverse-index-target')
    rooms.join('reverse-index-target-room', target, 10_000, 'lease', 'editor')
    expect(rooms.recordYjsResponseGrant('reverse-index-target-room', target, 'first', 'lease', 5_000)).toBe(true)

    type GlobalGrantMap = Map<string, Map<Conn, Map<string, unknown>>>
    const internals = rooms as unknown as { yjsResponseGrantsByRoom: GlobalGrantMap }
    const originalGlobalMap = internals.yjsResponseGrantsByRoom
    internals.yjsResponseGrantsByRoom = new Proxy(originalGlobalMap, {
      get(targetMap, property) {
        if (property === Symbol.iterator || property === 'entries' || property === 'keys' || property === 'values') {
          return () => {
            throw new Error('global grant map iteration is forbidden on a per-connection path')
          }
        }
        const value = Reflect.get(targetMap, property, targetMap) as unknown
        return typeof value === 'function' ? value.bind(targetMap) : value
      },
    })

    expect(rooms.recordYjsResponseGrant('reverse-index-target-room', target, 'second', 'lease', 5_000)).toBe(true)
    expect(() => rooms.leaveAll(target)).not.toThrow()
    const firstUnrelated = unrelated[0]
    expect(
      rooms.authorizeYjsResponseFrame(firstUnrelated.room, firstUnrelated.conn, {
        t: 'yjs',
        room: firstUnrelated.room,
        payload: 'unrelated-state',
        stateRequestId: 'state',
      }),
    ).toBe('complete')
  })

  it('retains the reverse entry until the last grant and removes only grants bound to an exact leaving lease', () => {
    const rooms = new RoomRegistry(() => 1_000)
    const conn = fakeConn('reverse-index-leases')
    const reverseIndex = (rooms as unknown as { yjsResponseGrantRoomsByConn: WeakMap<Conn, Set<string>> })
      .yjsResponseGrantRoomsByConn
    rooms.join('reverse-index-room', conn, 5_000, 'lease-a', 'editor')
    rooms.join('reverse-index-room', conn, 5_000, 'lease-b', 'editor')
    expect(rooms.recordYjsResponseGrant('reverse-index-room', conn, 'state-a', 'lease-a', 4_000)).toBe(true)
    expect(rooms.recordYjsResponseGrant('reverse-index-room', conn, 'state-b', 'lease-b', 4_000)).toBe(true)
    expect(reverseIndex.get(conn)).toEqual(new Set(['reverse-index-room']))

    rooms.leave('reverse-index-room', conn, 'lease-a')
    expect(reverseIndex.get(conn)).toEqual(new Set(['reverse-index-room']))
    expect(
      rooms.authorizeYjsResponseFrame('reverse-index-room', conn, {
        t: 'yjs',
        room: 'reverse-index-room',
        payload: 'removed-a',
        stateRequestId: 'state-a',
      }),
    ).toBe('denied')
    expect(
      rooms.authorizeYjsResponseFrame('reverse-index-room', conn, {
        t: 'yjs',
        room: 'reverse-index-room',
        payload: 'preserved-b',
        stateRequestId: 'state-b',
      }),
    ).toBe('complete')
    expect(reverseIndex.get(conn)).toBeUndefined()

    expect(rooms.recordYjsResponseGrant('reverse-index-room', conn, 'state-c', 'lease-b', 4_000)).toBe(true)
    expect(rooms.recordYjsResponseGrant('reverse-index-room', conn, 'state-d', 'lease-b', 4_000)).toBe(true)
    expect(
      rooms.authorizeYjsResponseFrame('reverse-index-room', conn, {
        t: 'yjs',
        room: 'reverse-index-room',
        payload: 'consume-c',
        stateRequestId: 'state-c',
      }),
    ).toBe('complete')
    expect(reverseIndex.get(conn)).toEqual(new Set(['reverse-index-room']))
    rooms.leaveAll(conn)
    expect(reverseIndex.get(conn)).toBeUndefined()
    rooms.join('reverse-index-room', conn, 5_000, 'lease-b', 'editor')
    expect(
      rooms.authorizeYjsResponseFrame('reverse-index-room', conn, {
        t: 'yjs',
        room: 'reverse-index-room',
        payload: 'must-be-cleaned-d',
        stateRequestId: 'state-d',
      }),
    ).toBe('denied')
  })

  it('reclaims the per-connection grant ceiling after completion, expiry, room denial, and close', () => {
    let now = 1_000
    const rooms = new RoomRegistry(() => now)
    const conn = fakeConn('grant-capacity-reclamation')
    const room = 'grant-capacity-room'
    const lease = 'capacity-lease'
    const reverseIndex = (rooms as unknown as { yjsResponseGrantRoomsByConn: WeakMap<Conn, Set<string>> })
      .yjsResponseGrantRoomsByConn
    const join = () => rooms.join(room, conn, now + 10_000, lease, 'editor')
    const fill = (prefix: string): void => {
      for (let index = 0; index < MAX_ACTIVE_YJS_RESPONSE_GRANTS_PER_CONNECTION; index += 1) {
        expect(
          rooms.recordYjsResponseGrant(room, conn, `${prefix}-${index}`, lease, index === 1 ? now + 5 : now + 5_000),
        ).toBe(true)
      }
    }

    join()
    fill('initial')
    expect(rooms.recordYjsResponseGrant(room, conn, 'initial-overflow', lease, now + 5_000)).toBe(false)
    expect(
      rooms.authorizeYjsResponseFrame(room, conn, {
        t: 'yjs',
        room,
        payload: 'completed',
        stateRequestId: 'initial-0',
      }),
    ).toBe('complete')
    expect(rooms.recordYjsResponseGrant(room, conn, 'after-completion', lease, now + 5_000)).toBe(true)

    now += 5
    expect(rooms.recordYjsResponseGrant(room, conn, 'after-expiry', lease, now + 5_000)).toBe(true)
    rooms.denyRoom(room)
    expect(reverseIndex.get(conn)).toBeUndefined()
    join()
    fill('after-deny')

    rooms.leaveAll(conn)
    expect(reverseIndex.get(conn)).toBeUndefined()
    join()
    fill('after-close')
  })
})

describe('handleRelayFrame room-join authorization', () => {
  it('rejects an unauthorized join: the socket never enters the room and gets room-denied', async () => {
    const rooms = new RoomRegistry()
    const a = fakeConn('a')
    const intruder = fakeConn('intruder')

    // Only user "a" is a member of note "n1".
    const authorize = (userUuid: string, room: string, capability?: string) =>
      userUuid === 'a' && room === 'n1'
        ? {
            authorized: true as const,
            expiresAt: Date.now() + 60_000,
            serverUpdatedAtTimestamp: 1,
            collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
            roomEpoch: TEST_ROOM_EPOCH,
            collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
            leaseRequestId: capability,
          }
        : { authorized: false as const }

    await handleRelayFrame(
      rooms,
      a,
      {
        t: 'room-join',
        room: 'n1',
        cap: 'lease-a',
        requestId: 'lease-a',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )
    const reached = await handleRelayFrame(
      rooms,
      intruder,
      {
        t: 'room-join',
        room: 'n1',
        cap: 'lease-intruder',
        requestId: 'lease-intruder',
        role: 'comment',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )

    expect(reached).toBe(0)
    expect(rooms.members('n1')).toHaveLength(1) // intruder NOT added
    expect(intruder.sent).toContain(JSON.stringify({ t: 'room-denied', room: 'n1', requestId: 'lease-intruder' }))

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
    const authorize = (_userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: Date.now() + 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    })

    await handleRelayFrame(
      rooms,
      a,
      {
        t: 'room-join',
        room: 'n1',
        cap: 'lease-a',
        requestId: 'lease-a',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )
    await handleRelayFrame(
      rooms,
      b,
      {
        t: 'room-join',
        room: 'n1',
        cap: 'lease-b',
        requestId: 'lease-b',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )
    const reached = await handleRelayFrame(rooms, a, { t: 'yjs', room: 'n1', payload: 'AQID' }, authorize)

    expect(reached).toBe(1)
    expect(a.sent).toContain(
      JSON.stringify({
        t: 'room-joined',
        room: 'n1',
        requestId: 'lease-a',
        bootstrap: true,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
        roomEpoch: TEST_ROOM_EPOCH,
      }),
    )
    expect(b.sent).toContain(JSON.stringify({ t: 'yjs', room: 'n1', payload: 'AQID' }))
  })

  it('does not join or acknowledge when the connection closes during delayed authorization', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('closing')
    let active = true
    // These annotations were hand-rolled and pinned to `2`, which silently outlived
    // the v3 bump. Worse, the shape was missing roomEpoch/collaborationSecurityEpoch
    // entirely, so the join would have been refused by the epoch guard even if the
    // connection had stayed open -- the case could not fail for the reason it names.
    // Derive it from the real authorization type and grant a fully valid one, so the
    // only thing standing between this frame and a join is the closed-connection guard.
    type DelayedAuthorization = Extract<RoomJoinAuthorization, { authorized: true }>
    let resolveAuthorization!: (value: DelayedAuthorization) => void
    const authorize = () =>
      new Promise<DelayedAuthorization>((resolve) => {
        resolveAuthorization = resolve
      })

    const handling = handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'n1',
        cap: 'delayed',
        requestId: 'delayed',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
      () => active,
    )
    active = false
    resolveAuthorization({
      authorized: true,
      expiresAt: Date.now() + 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: 'delayed',
    })
    await handling

    expect(rooms.roomCount()).toBe(0)
    expect(conn.sent).toEqual([])
  })

  // The only place a v2 value still belongs: `handleRelayFrame` has no v2 code
  // path left (every branch compares strict-equal to COLLABORATION_PROTOCOL_VERSION),
  // so a v2 authorization is a downgrade to be refused, not a compatibility mode.
  // This is what the stale `collaborationProtocolVersion: 2` fixtures above only
  // appeared to cover — they were type annotations, never an exercised legacy path.
  it('denies a join whose authorization carries a stale pre-v3 collaboration protocol version', async () => {
    const rooms = new RoomRegistry()
    const conn = fakeConn('downgraded')

    const authorize = (_userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: Date.now() + 60_000,
      serverUpdatedAtTimestamp: 1,
      // A gateway still speaking the previous protocol revision.
      collaborationProtocolVersion: 2 as unknown as typeof COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    })

    const reached = await handleRelayFrame(
      rooms,
      conn,
      {
        t: 'room-join',
        room: 'n1',
        cap: 'lease-downgraded',
        requestId: 'lease-downgraded',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )

    expect(reached).toBe(0)
    expect(rooms.roomCount()).toBe(0)
    expect(conn.sent).toContain(
      JSON.stringify({ t: 'room-denied', room: 'n1', requestId: 'lease-downgraded' }),
    )
    expect(conn.sent.some((message) => message.includes('room-joined'))).toBe(false)
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
    const authorize = (userUuid: string, _room: string, capability?: string) => ({
      authorized: true as const,
      expiresAt: userUuid === 'expiring' ? 2_000 : 5_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: TEST_ROOM_EPOCH,
      collaborationSecurityEpoch: TEST_SECURITY_EPOCH,
      leaseRequestId: capability,
    })

    await handleRelayFrame(
      rooms,
      expiring,
      {
        t: 'room-join',
        room: 'n1',
        requestId: 'expiring-request',
        cap: 'expiring-request',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )
    await handleRelayFrame(
      rooms,
      current,
      {
        t: 'room-join',
        room: 'n1',
        requestId: 'current-request',
        cap: 'current-request',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: TEST_ROOM_EPOCH,
      },
      authorize,
    )
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
