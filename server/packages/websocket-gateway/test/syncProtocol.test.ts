import { describe, expect, it } from 'vitest'

import {
  MAX_SYNC_FRAME_BYTES,
  MAX_SYNC_RESUME_SEQUENCE,
  MAX_SYNC_SEQUENCE,
  CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR,
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
})
