import { describe, expect, it } from 'vitest'

import {
  MAX_INVITE_CURSOR_BYTES,
  MAX_RPC_CREDIT_BYTES,
  MAX_RPC_DEADLINE_MS,
  MAX_SYNC_FRAME_BYTES,
  MAX_SYNC_RESUME_SEQUENCE,
  MAX_SYNC_SEQUENCE,
  MIN_RPC_DEADLINE_MS,
  CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR,
  FILES_CONTROL_DEFAULTS,
  SYNC_COMMAND_DIGEST_TEST_VECTOR,
  SyncProtocolError,
  canonicalSyncJson,
  constantTimeDigestMatches,
  createSyncServerFrame,
  digestSyncCommandBody,
  parseSyncClientFrame,
  syncPayloadLength,
  type JsonObject,
} from '../src/syncProtocol.js'
import {
  MAX_FILE_METADATA_ENTRIES,
  MAX_FILE_TRANSFER_BYTES,
  MAX_FILE_TRANSFER_CREDIT_BYTES,
  MAX_FILE_TRANSFER_DEADLINE_MS,
  MIN_FILE_TRANSFER_DEADLINE_MS,
} from '../src/filesProtocol.js'

function commandFrame(body: JsonObject, digest = digestSyncCommandBody(body)): JsonObject {
  const payload = { command: 'SYNC_ITEMS', body }
  return {
    version: 1,
    channel: 'sync',
    type: 'COMMAND',
    requestId: 'request-1',
    commandId: 'command-1',
    sequence: 1,
    payloadLength: syncPayloadLength(payload),
    payload,
    digest,
  }
}

function pingFrame(overrides: JsonObject = {}): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type: 'PING',
    requestId: 'request-1',
    commandId: 'command-1',
    sequence: 1,
    payloadLength: 2,
    payload: {},
    ...overrides,
  }
}

function inviteFrame(
  type: 'INVITE_SUBSCRIBE' | 'INVITE_ACK',
  payload: JsonObject,
  overrides: JsonObject = {},
): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type,
    requestId: 'invite-request',
    commandId: 'invite-command',
    sequence: 1,
    payloadLength: syncPayloadLength(payload),
    payload,
    ...overrides,
  }
}

function clientFrame(type: string, payload: JsonObject, overrides: JsonObject = {}): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type,
    requestId: `${type.toLowerCase()}-request`,
    commandId: `${type.toLowerCase()}-command`,
    sequence: type === 'AUTH' ? 0 : 1,
    payloadLength: syncPayloadLength(payload),
    payload,
    ...overrides,
  }
}

function expectInvalidFrame(frame: JsonObject, code = 'INVALID_ENVELOPE'): void {
  expect(() => parseSyncClientFrame(JSON.stringify(frame))).toThrowError(expect.objectContaining({ code }))
}

describe('sync protocol v1', () => {
  it('publishes and enforces the shared body-only canonical digest vector', () => {
    expect(canonicalSyncJson(SYNC_COMMAND_DIGEST_TEST_VECTOR.body)).toBe(SYNC_COMMAND_DIGEST_TEST_VECTOR.canonical)
    expect(digestSyncCommandBody(SYNC_COMMAND_DIGEST_TEST_VECTOR.body)).toBe(SYNC_COMMAND_DIGEST_TEST_VECTOR.digest)
    expect(parseSyncClientFrame(JSON.stringify(commandFrame(SYNC_COMMAND_DIGEST_TEST_VECTOR.body)))).toMatchObject({
      type: 'COMMAND',
      digest: SYNC_COMMAND_DIGEST_TEST_VECTOR.digest,
    })
  })

  it('pins both the legacy and current ad3833 cross-transport digest fixtures', () => {
    expect(SYNC_COMMAND_DIGEST_TEST_VECTOR.digest).toBe(
      'e4c8512aab76dd9aca235be947afc7829b5ea652db89f93f672f69648a5e885e',
    )
    expect(canonicalSyncJson(CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR.body)).toBe(
      CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR.canonical,
    )
    expect(digestSyncCommandBody(CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR.body)).toBe(
      'ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61',
    )
  })

  it('sorts object keys recursively, omits undefined properties, and preserves array order', () => {
    expect(canonicalSyncJson({ z: undefined, b: [{ y: 2, x: 1 }, undefined], a: true })).toBe(
      '{"a":true,"b":[{"x":1,"y":2},null]}',
    )
  })

  it('rejects a digest over the WS wrapper rather than the logical body', () => {
    const body = { api: '20200115', items: [] }
    const wrappedDigest = digestSyncCommandBody({ command: 'SYNC_ITEMS', body })
    expect(() => parseSyncClientFrame(JSON.stringify(commandFrame(body, wrappedDigest)))).toThrowError(
      expect.objectContaining<Partial<SyncProtocolError>>({ code: 'INVALID_DIGEST' }),
    )
  })

  it.each([
    ['malformed JSON', '{', 'MALFORMED_JSON'],
    ['non-object JSON', '[]', 'INVALID_ENVELOPE'],
  ])('rejects %s', (_label, raw, code) => {
    expect(() => parseSyncClientFrame(raw)).toThrowError(expect.objectContaining({ code }))
  })

  it('rejects extra fields and payload length mismatches', () => {
    const extra = { ...commandFrame({ items: [] }), surprise: true }
    expect(() => parseSyncClientFrame(JSON.stringify(extra))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    )

    const wrongLength = { ...commandFrame({ items: [] }), payloadLength: 1 }
    expect(() => parseSyncClientFrame(JSON.stringify(wrongLength))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD_LENGTH' }),
    )
  })

  it('rejects non-object command bodies before digest validation', () => {
    const payload = { command: 'SYNC_ITEMS', body: [] }
    const frame = {
      ...commandFrame({}),
      payload,
      payloadLength: syncPayloadLength(payload),
    }
    expect(() => parseSyncClientFrame(JSON.stringify(frame))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    )
  })

  it('rejects a frame before parsing when transport bytes exceed the lower sync cap', () => {
    expect(() => parseSyncClientFrame('{}', MAX_SYNC_FRAME_BYTES + 1)).toThrowError(
      expect.objectContaining({ code: 'FRAME_TOO_LARGE' }),
    )
  })

  it.each([
    [{ version: 2 }, 'UNSUPPORTED_VERSION'],
    [{ channel: 'other' }, 'INVALID_ENVELOPE'],
    [{ requestId: '../bad' }, 'INVALID_ENVELOPE'],
    [{ sequence: -1 }, 'INVALID_SEQUENCE'],
    [{ payloadLength: -1 }, 'INVALID_PAYLOAD_LENGTH'],
    [{ payload: [], payloadLength: 2 }, 'INVALID_ENVELOPE'],
  ])('rejects invalid base envelope fields %#', (override, code) => {
    expect(() => parseSyncClientFrame(JSON.stringify(pingFrame(override)))).toThrowError(
      expect.objectContaining({ code }),
    )
  })

  it('validates strict AUTH, STATUS and PING variants', () => {
    const invalidAuthFields = pingFrame({
      type: 'AUTH',
      payload: { ticket: 'x'.repeat(32), deviceId: 'device-1' },
      payloadLength: syncPayloadLength({ ticket: 'x'.repeat(32), deviceId: 'device-1' }),
      extra: true,
    })
    expect(() => parseSyncClientFrame(JSON.stringify(invalidAuthFields))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    )

    const invalidAuthPayload = pingFrame({
      type: 'AUTH',
      sequence: 0,
      payload: { ticket: 'short', deviceId: 'device-1' },
      payloadLength: syncPayloadLength({ ticket: 'short', deviceId: 'device-1' }),
    })
    expect(() => parseSyncClientFrame(JSON.stringify(invalidAuthPayload))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    )

    expect(() =>
      parseSyncClientFrame(JSON.stringify(pingFrame({ payload: { extra: true }, payloadLength: 14 }))),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ENVELOPE' }))
    expect(() => parseSyncClientFrame(JSON.stringify(pingFrame({ type: 'STATUS', digest: 'bad' })))).toThrowError(
      expect.objectContaining({ code: 'INVALID_DIGEST' }),
    )
    expect(() => parseSyncClientFrame(JSON.stringify(pingFrame({ type: 'UNKNOWN' })))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    )
  })

  it('accepts bounded invite subscriptions and exact acknowledgements', () => {
    expect(parseSyncClientFrame(JSON.stringify(inviteFrame('INVITE_SUBSCRIBE', { limit: 100 })))).toMatchObject({
      type: 'INVITE_SUBSCRIBE',
      payload: { limit: 100 },
    })
    expect(
      parseSyncClientFrame(
        JSON.stringify(inviteFrame('INVITE_SUBSCRIBE', { cursor: 'v1.0.opaque-signature', limit: 25 })),
      ),
    ).toMatchObject({ type: 'INVITE_SUBSCRIBE', payload: { cursor: 'v1.0.opaque-signature', limit: 25 } })
    expect(
      parseSyncClientFrame(JSON.stringify(inviteFrame('INVITE_ACK', { cursor: 'v1.1.opaque-signature' }))),
    ).toMatchObject({ type: 'INVITE_ACK', payload: { cursor: 'v1.1.opaque-signature' } })
  })

  it.each([
    ['zero replay limit', inviteFrame('INVITE_SUBSCRIBE', { limit: 0 })],
    ['oversized replay limit', inviteFrame('INVITE_SUBSCRIBE', { limit: 101 })],
    ['empty cursor', inviteFrame('INVITE_SUBSCRIBE', { cursor: '', limit: 25 })],
    ['oversized cursor', inviteFrame('INVITE_SUBSCRIBE', { cursor: 'x'.repeat(2_049), limit: 25 })],
    ['extra subscription field', inviteFrame('INVITE_SUBSCRIBE', { limit: 25, poll: true })],
    ['missing acknowledgement cursor', inviteFrame('INVITE_ACK', {})],
    ['extra acknowledgement field', inviteFrame('INVITE_ACK', { cursor: 'cursor', applied: true })],
  ])('rejects invalid invite frame: %s', (_label, frame) => {
    expect(() => parseSyncClientFrame(JSON.stringify(frame))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    )
  })

  it('compares only valid lowercase SHA-256 digests and builds default server payloads', () => {
    const digest = 'a'.repeat(64)
    expect(constantTimeDigestMatches(digest, digest)).toBe(true)
    expect(constantTimeDigestMatches(undefined, digest)).toBe(false)
    expect(constantTimeDigestMatches(digest, 'invalid')).toBe(false)
    expect(createSyncServerFrame({ type: 'PONG', requestId: 'r', commandId: 'c', sequence: 1 })).toMatchObject({
      payload: {},
      payloadLength: 2,
    })
  })

  it('bounds client, resume, and server sequences before unsafe increments', () => {
    expect(() => parseSyncClientFrame(JSON.stringify(pingFrame({ sequence: MAX_SYNC_SEQUENCE + 1 })))).toThrowError(
      expect.objectContaining({ code: 'INVALID_SEQUENCE' }),
    )
    const authPayload = { ticket: 'x'.repeat(43), deviceId: 'device-1', resumeSequence: MAX_SYNC_RESUME_SEQUENCE + 1 }
    expect(() =>
      parseSyncClientFrame(
        JSON.stringify({
          ...pingFrame(),
          type: 'AUTH',
          sequence: 0,
          payload: authPayload,
          payloadLength: syncPayloadLength(authPayload),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ENVELOPE' }))
    expect(() =>
      createSyncServerFrame({ type: 'PONG', requestId: 'r', commandId: 'c', sequence: MAX_SYNC_SEQUENCE + 1 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SEQUENCE' }))
  })

  it('accepts strict AUTH, STATUS, PING, and digest-bearing server frames at their boundaries', () => {
    const authPayload = { ticket: 'x'.repeat(32), deviceId: 'device-1', resumeSequence: MAX_SYNC_RESUME_SEQUENCE }
    expect(parseSyncClientFrame(JSON.stringify(clientFrame('AUTH', authPayload)))).toMatchObject({
      type: 'AUTH',
      payload: authPayload,
    })
    const statusPayload = {}
    expect(
      parseSyncClientFrame(JSON.stringify(clientFrame('STATUS', statusPayload, { digest: 'a'.repeat(64) }))),
    ).toMatchObject({ type: 'STATUS', digest: 'a'.repeat(64) })
    expect(parseSyncClientFrame(JSON.stringify(clientFrame('PING', {})))).toMatchObject({ type: 'PING' })
    expect(
      createSyncServerFrame({
        type: 'COMMITTED',
        requestId: 'request-1',
        commandId: 'command-1',
        sequence: MAX_SYNC_SEQUENCE,
        payload: { ok: true },
        digest: 'b'.repeat(64),
      }),
    ).toMatchObject({ digest: 'b'.repeat(64), payload: { ok: true } })
    expect(FILES_CONTROL_DEFAULTS).toEqual({ deadlineMs: 30_000, initialCreditBytes: 512 * 1024 })
  })

  it('accepts discovery and challenged collaboration grants with exact optional fields', () => {
    const discovery = {
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      epochDiscovery: true,
    }
    expect(parseSyncClientFrame(JSON.stringify(clientFrame('COLLABORATION_AUTHORIZE', discovery)))).toMatchObject({
      payload: discovery,
    })

    const grant = {
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      expectedRoomEpoch: 'room_epoch_000001',
      epochDiscoveryChallenge: 'challenge-1',
      epochDiscoveryRequestId: 'discovery-request-1',
      leaseRequestId: 'lease-request-1',
      bootstrapChallenge: 'bootstrap-1',
    }
    expect(parseSyncClientFrame(JSON.stringify(clientFrame('COLLABORATION_AUTHORIZE', grant)))).toMatchObject({
      payload: grant,
    })
  })

  // Rows carry an optional third element (envelope overrides), so the tuple has to
  // be spelled out: inference over mixed-arity rows makes the third element required.
  it.each<[string, JsonObject, JsonObject?]>([
    [
      'extra envelope field',
      { noteUuid: 'note-1', collaborationProtocolVersion: 3, epochDiscovery: true },
      { extra: true },
    ],
    [
      'extra discovery field',
      { noteUuid: 'note-1', collaborationProtocolVersion: 3, epochDiscovery: true, leaseRequestId: 'lease-1' },
    ],
    ['missing note', { collaborationProtocolVersion: 3, epochDiscovery: true }],
    ['empty note', { noteUuid: '', collaborationProtocolVersion: 3, epochDiscovery: true }],
    ['oversized note', { noteUuid: 'n'.repeat(201), collaborationProtocolVersion: 3, epochDiscovery: true }],
    ['wrong protocol version', { noteUuid: 'note-1', collaborationProtocolVersion: 2, epochDiscovery: true }],
    [
      'missing epoch',
      {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        epochDiscoveryChallenge: 'challenge-1',
        epochDiscoveryRequestId: 'discovery-1',
      },
    ],
    [
      'short epoch',
      {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: 'short',
        epochDiscoveryChallenge: 'challenge-1',
        epochDiscoveryRequestId: 'discovery-1',
      },
    ],
    [
      'invalid challenge',
      {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: 'room_epoch_000001',
        epochDiscoveryChallenge: '../bad',
        epochDiscoveryRequestId: 'discovery-1',
      },
    ],
    [
      'invalid discovery request',
      {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: 'room_epoch_000001',
        epochDiscoveryChallenge: 'challenge-1',
        epochDiscoveryRequestId: '',
      },
    ],
    [
      'invalid lease request',
      {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: 'room_epoch_000001',
        epochDiscoveryChallenge: 'challenge-1',
        epochDiscoveryRequestId: 'discovery-1',
        leaseRequestId: '../bad',
      },
    ],
    [
      'invalid bootstrap challenge',
      {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: 'room_epoch_000001',
        epochDiscoveryChallenge: 'challenge-1',
        epochDiscoveryRequestId: 'discovery-1',
        bootstrapChallenge: '../bad',
      },
    ],
    [
      'bootstrap without lease',
      {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: 'room_epoch_000001',
        epochDiscoveryChallenge: 'challenge-1',
        epochDiscoveryRequestId: 'discovery-1',
        bootstrapChallenge: 'bootstrap-1',
      },
    ],
  ])('rejects malformed collaboration authorization: %s', (_label, payload, overrides = {}) => {
    expectInvalidFrame(clientFrame('COLLABORATION_AUTHORIZE', payload, overrides))
  })

  it('accepts bounded same-origin RPC requests and exact cancel/credit controls', () => {
    const post = {
      method: 'POST',
      path: '/v1/items?limit=1',
      body: { items: [] },
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      deadlineMs: MIN_RPC_DEADLINE_MS,
      initialCreditBytes: MAX_RPC_CREDIT_BYTES,
      stream: true,
      idempotencyKey: 'rpc-key-1',
    }
    expect(parseSyncClientFrame(JSON.stringify(clientFrame('RPC_REQUEST', post)))).toMatchObject({ payload: post })
    expect(
      parseSyncClientFrame(
        JSON.stringify(
          clientFrame('RPC_REQUEST', {
            method: 'GET',
            path: '/v1/items',
            deadlineMs: MAX_RPC_DEADLINE_MS,
            initialCreditBytes: 1,
            stream: false,
          }),
        ),
      ),
    ).toMatchObject({ type: 'RPC_REQUEST' })
    expect(
      parseSyncClientFrame(JSON.stringify(clientFrame('RPC_CANCEL', { targetRequestId: 'rpc-request-1' }))),
    ).toMatchObject({ type: 'RPC_CANCEL' })
    expect(
      parseSyncClientFrame(
        JSON.stringify(clientFrame('RPC_CREDIT', { targetRequestId: 'rpc-request-1', creditBytes: 1 })),
      ),
    ).toMatchObject({ type: 'RPC_CREDIT' })
  })

  it.each([
    ['unsupported method', { method: 'HEAD' }],
    ['non-string path', { path: 1 }],
    ['non-v1 path', { path: '/healthcheck' }],
    ['protocol-relative path', { path: '//evil.example/v1/items' }],
    ['backslash path', { path: '/v1/unsafe\\path' }],
    ['fragment path', { path: '/v1/items#secret' }],
    ['oversized path', { path: `/v1/${'x'.repeat(2_049)}` }],
    ['non-integer deadline', { deadlineMs: 1.5 }],
    ['short deadline', { deadlineMs: MIN_RPC_DEADLINE_MS - 1 }],
    ['long deadline', { deadlineMs: MAX_RPC_DEADLINE_MS + 1 }],
    ['non-integer credit', { initialCreditBytes: 1.5 }],
    ['zero credit', { initialCreditBytes: 0 }],
    ['oversized credit', { initialCreditBytes: MAX_RPC_CREDIT_BYTES + 1 }],
    ['non-boolean stream', { stream: 'yes' }],
    ['non-object headers', { headers: [] }],
    [
      'too many headers',
      {
        headers: {
          accept: 'a',
          'content-type': 'b',
          'if-match': 'c',
          'if-none-match': 'd',
          'x-shared-vault-owner-context': 'e',
          extra: 'f',
        },
      },
    ],
    ['uppercase header', { headers: { Accept: 'application/json' } }],
    ['unapproved header', { headers: { authorization: 'secret' } }],
    ['non-string header', { headers: { accept: 1 } }],
    ['oversized header', { headers: { accept: 'x'.repeat(1_025) } }],
    ['newline header', { headers: { accept: 'text/plain\r\nunsafe' } }],
    ['invalid idempotency key', { idempotencyKey: '../bad' }],
    ['GET request body', { method: 'GET', body: {} }],
    ['unexpected field', { unexpected: true }],
  ])('rejects an unsafe RPC request with %s', (_label, change) => {
    const payload = {
      method: 'POST',
      path: '/v1/items',
      deadlineMs: 30_000,
      initialCreditBytes: 1_024,
      stream: false,
      ...change,
    }
    expectInvalidFrame(clientFrame('RPC_REQUEST', payload as JsonObject))
  })

  it.each([
    ['cancel extra field', 'RPC_CANCEL', { targetRequestId: 'rpc-1', extra: true }],
    ['invalid cancel target', 'RPC_CANCEL', { targetRequestId: '../bad' }],
    ['credit missing amount', 'RPC_CREDIT', { targetRequestId: 'rpc-1' }],
    ['credit invalid target', 'RPC_CREDIT', { targetRequestId: '', creditBytes: 1 }],
    ['credit non-integer', 'RPC_CREDIT', { targetRequestId: 'rpc-1', creditBytes: 1.5 }],
    ['credit zero', 'RPC_CREDIT', { targetRequestId: 'rpc-1', creditBytes: 0 }],
    ['credit oversized', 'RPC_CREDIT', { targetRequestId: 'rpc-1', creditBytes: MAX_RPC_CREDIT_BYTES + 1 }],
  ])('rejects malformed RPC control: %s', (_label, type, payload) => {
    expectInvalidFrame(clientFrame(type as string, payload as JsonObject))
  })

  it('accepts every bounded FILES_V1 control shape, including resumable transfers', () => {
    const personal = { ownershipType: 'user', remoteIdentifier: 'file-1', fileUuid: 'file-1' }
    const shared = {
      ownershipType: 'shared-vault',
      remoteIdentifier: 'file-2',
      fileUuid: 'file-2',
      sharedVaultUuid: 'vault-1',
      sharedVaultOwnerUuid: 'owner-1',
    }
    const frames = [
      clientFrame('FILES_METADATA', { resources: [personal, shared], deadlineMs: MIN_FILE_TRANSFER_DEADLINE_MS }),
      clientFrame('FILES_UPLOAD_OPEN', {
        resource: personal,
        decryptedSize: 1,
        declaredSize: MAX_FILE_TRANSFER_BYTES,
        mimeType: 'application/octet-stream',
        deadlineMs: MAX_FILE_TRANSFER_DEADLINE_MS,
        resumeId: 'resume-1',
      }),
      clientFrame('FILES_UPLOAD_FINISH', {
        transferId: 'transfer-1',
        generation: 1,
        declaredSize: 1,
        sha256: 'a'.repeat(64),
        deadlineMs: 30_000,
      }),
      clientFrame('FILES_DOWNLOAD_OPEN', {
        resource: shared,
        offset: 0,
        initialCreditBytes: MAX_FILE_TRANSFER_CREDIT_BYTES,
        deadlineMs: 30_000,
        resumeId: 'resume-2',
      }),
      clientFrame('FILES_CREDIT', { transferId: 'transfer-1', generation: 1, creditBytes: 1 }),
      clientFrame('FILES_CANCEL', { transferId: 'transfer-1', generation: 1 }),
    ]
    expect(frames.map((frame) => parseSyncClientFrame(JSON.stringify(frame)).type)).toEqual([
      'FILES_METADATA',
      'FILES_UPLOAD_OPEN',
      'FILES_UPLOAD_FINISH',
      'FILES_DOWNLOAD_OPEN',
      'FILES_CREDIT',
      'FILES_CANCEL',
    ])
  })

  it.each([
    [
      'metadata extra field',
      'FILES_METADATA',
      { resources: [{ ownershipType: 'user', remoteIdentifier: 'file-1' }], deadlineMs: 30_000, extra: true },
    ],
    ['metadata non-array', 'FILES_METADATA', { resources: {}, deadlineMs: 30_000 }],
    ['metadata empty', 'FILES_METADATA', { resources: [], deadlineMs: 30_000 }],
    [
      'metadata too many',
      'FILES_METADATA',
      {
        resources: Array.from({ length: MAX_FILE_METADATA_ENTRIES + 1 }, () => ({
          ownershipType: 'user',
          remoteIdentifier: 'file-1',
        })),
        deadlineMs: 30_000,
      },
    ],
    [
      'metadata invalid resource',
      'FILES_METADATA',
      { resources: [{ ownershipType: 'user', remoteIdentifier: '' }], deadlineMs: 30_000 },
    ],
    [
      'metadata short deadline',
      'FILES_METADATA',
      {
        resources: [{ ownershipType: 'user', remoteIdentifier: 'file-1' }],
        deadlineMs: MIN_FILE_TRANSFER_DEADLINE_MS - 1,
      },
    ],
    [
      'upload invalid resource',
      'FILES_UPLOAD_OPEN',
      { resource: null, decryptedSize: 1, declaredSize: 1, mimeType: 'text/plain', deadlineMs: 30_000 },
    ],
    [
      'upload zero decrypted size',
      'FILES_UPLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        decryptedSize: 0,
        declaredSize: 1,
        mimeType: 'text/plain',
        deadlineMs: 30_000,
      },
    ],
    [
      'upload oversized declared size',
      'FILES_UPLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        decryptedSize: 1,
        declaredSize: MAX_FILE_TRANSFER_BYTES + 1,
        mimeType: 'text/plain',
        deadlineMs: 30_000,
      },
    ],
    [
      'upload invalid MIME',
      'FILES_UPLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        decryptedSize: 1,
        declaredSize: 1,
        mimeType: '',
        deadlineMs: 30_000,
      },
    ],
    [
      'upload long deadline',
      'FILES_UPLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        decryptedSize: 1,
        declaredSize: 1,
        mimeType: 'text/plain',
        deadlineMs: MAX_FILE_TRANSFER_DEADLINE_MS + 1,
      },
    ],
    [
      'upload invalid resume',
      'FILES_UPLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        decryptedSize: 1,
        declaredSize: 1,
        mimeType: 'text/plain',
        deadlineMs: 30_000,
        resumeId: '../bad',
      },
    ],
    [
      'finish invalid transfer',
      'FILES_UPLOAD_FINISH',
      { transferId: '', generation: 1, declaredSize: 1, sha256: 'a'.repeat(64), deadlineMs: 30_000 },
    ],
    [
      'finish invalid generation',
      'FILES_UPLOAD_FINISH',
      { transferId: 'transfer-1', generation: 0, declaredSize: 1, sha256: 'a'.repeat(64), deadlineMs: 30_000 },
    ],
    [
      'finish zero size',
      'FILES_UPLOAD_FINISH',
      { transferId: 'transfer-1', generation: 1, declaredSize: 0, sha256: 'a'.repeat(64), deadlineMs: 30_000 },
    ],
    [
      'finish invalid digest',
      'FILES_UPLOAD_FINISH',
      { transferId: 'transfer-1', generation: 1, declaredSize: 1, sha256: 'bad', deadlineMs: 30_000 },
    ],
    [
      'finish invalid deadline',
      'FILES_UPLOAD_FINISH',
      { transferId: 'transfer-1', generation: 1, declaredSize: 1, sha256: 'a'.repeat(64), deadlineMs: 1 },
    ],
    [
      'download invalid resource',
      'FILES_DOWNLOAD_OPEN',
      { resource: {}, offset: 0, initialCreditBytes: 1, deadlineMs: 30_000 },
    ],
    [
      'download non-integer offset',
      'FILES_DOWNLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        offset: 0.5,
        initialCreditBytes: 1,
        deadlineMs: 30_000,
      },
    ],
    [
      'download negative offset',
      'FILES_DOWNLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        offset: -1,
        initialCreditBytes: 1,
        deadlineMs: 30_000,
      },
    ],
    [
      'download oversized offset',
      'FILES_DOWNLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        offset: MAX_FILE_TRANSFER_BYTES + 1,
        initialCreditBytes: 1,
        deadlineMs: 30_000,
      },
    ],
    [
      'download zero credit',
      'FILES_DOWNLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        offset: 0,
        initialCreditBytes: 0,
        deadlineMs: 30_000,
      },
    ],
    [
      'download invalid deadline',
      'FILES_DOWNLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        offset: 0,
        initialCreditBytes: 1,
        deadlineMs: 1,
      },
    ],
    [
      'download invalid resume',
      'FILES_DOWNLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier: 'file-1' },
        offset: 0,
        initialCreditBytes: 1,
        deadlineMs: 30_000,
        resumeId: '../bad',
      },
    ],
    ['credit missing amount', 'FILES_CREDIT', { transferId: 'transfer-1', generation: 1 }],
    [
      'credit invalid amount',
      'FILES_CREDIT',
      { transferId: 'transfer-1', generation: 1, creditBytes: MAX_FILE_TRANSFER_CREDIT_BYTES + 1 },
    ],
    ['cancel extra field', 'FILES_CANCEL', { transferId: 'transfer-1', generation: 1, extra: true }],
    ['cancel invalid transfer', 'FILES_CANCEL', { transferId: '../bad', generation: 1 }],
  ])('rejects malformed FILES_V1 control: %s', (_label, type, payload) => {
    expectInvalidFrame(clientFrame(type as string, payload as JsonObject))
  })

  it('rejects non-integer byte counts and an oversized invite cursor before JSON work', () => {
    expect(() => parseSyncClientFrame('{}', -1)).toThrowError(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }))
    expect(() => parseSyncClientFrame('{}', 1.5)).toThrowError(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }))
    expectInvalidFrame(inviteFrame('INVITE_ACK', { cursor: 'x'.repeat(MAX_INVITE_CURSOR_BYTES + 1) }))
  })
})
