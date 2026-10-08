import {
  canonicalSyncJson,
  decodeFileBinaryFrame,
  digestSyncBody,
  encodeFileBinaryFrame,
  fileBinaryPayloadDigest,
  fileBinaryPayloadMatchesDigest,
  isPermanentSyncFallbackReason,
  MAX_FILE_CHUNK_BYTES,
  normalizeSyncRequestForWire,
  SYNC_FALLBACK_REASON_EXPLANATIONS,
  syncCloseFallbackReason,
  syncFallbackDisposition,
  type SocketFileBinaryHeader,
  type SyncFallbackReason,
} from './syncTransportProtocol'
import { webcrypto } from 'crypto'

describe('permanent sync fallback reasons', () => {
  it('classifies a structurally absent transport as permanent', () => {
    expect(isPermanentSyncFallbackReason('capability-unavailable')).toBe(true)
    expect(isPermanentSyncFallbackReason('http-only')).toBe(true)
    expect(isPermanentSyncFallbackReason('unsupported-browser')).toBe(true)
  })

  it('leaves transient faults retryable so durable consumers still recover', () => {
    expect(isPermanentSyncFallbackReason('ticket-unavailable')).toBe(false)
    expect(isPermanentSyncFallbackReason('ticket-expired')).toBe(false)
    expect(isPermanentSyncFallbackReason('reconnect-gap')).toBe(false)
    expect(isPermanentSyncFallbackReason('server-kill')).toBe(false)
    expect(isPermanentSyncFallbackReason('worker-error')).toBe(false)
  })
})

/**
 * Standard Red Notes (t103): the boolean taxonomy had exactly two answers, and every
 * consumer derived "should I retry?" as the negation of "is it permanent?". That gave
 * `multi-tab-not-owner` the answer "retry now", which no retry can satisfy while
 * another tab holds the lane — and the durable invite stream retried on it forever.
 */
describe('sync fallback disposition', () => {
  it('answers deferred — not retryable — for a condition another tab holds', () => {
    expect(syncFallbackDisposition('multi-tab-not-owner')).toBe('deferred')
    // The negation of "permanent" is the answer that caused the loop, so it must
    // still be false here: the whole point is that the two are no longer the same
    // question.
    expect(isPermanentSyncFallbackReason('multi-tab-not-owner')).toBe(false)
  })

  it('keeps structural absence permanent and ordinary faults retryable', () => {
    expect(syncFallbackDisposition('capability-unavailable')).toBe('permanent')
    expect(syncFallbackDisposition('http-only')).toBe('permanent')
    expect(syncFallbackDisposition('unsupported-browser')).toBe('permanent')
    expect(syncFallbackDisposition('ticket-unavailable')).toBe('retryable')
    expect(syncFallbackDisposition('ticket-expired')).toBe('retryable')
    expect(syncFallbackDisposition('reconnect-gap')).toBe('retryable')
    expect(syncFallbackDisposition('server-kill')).toBe('retryable')
    expect(syncFallbackDisposition('worker-error')).toBe('retryable')
    expect(syncFallbackDisposition('outbox-unavailable')).toBe('retryable')
    expect(syncFallbackDisposition('live-sync-disabled')).toBe('retryable')
  })

  it('answers every reason in the union, and agrees with isPermanentSyncFallbackReason', () => {
    const reasons = Object.keys(SYNC_FALLBACK_REASON_EXPLANATIONS) as SyncFallbackReason[]
    // Precondition: the explanation map is keyed by the full union (it is a
    // `Record<SyncFallbackReason, string>`), so this really is an exhaustive sweep
    // rather than a sweep of nothing.
    expect(reasons).toContain('multi-tab-not-owner')
    expect(reasons.length).toBeGreaterThan(10)

    for (const reason of reasons) {
      const disposition = syncFallbackDisposition(reason)
      expect(['retryable', 'deferred', 'permanent']).toContain(disposition)
      expect(disposition === 'permanent').toBe(isPermanentSyncFallbackReason(reason))
    }

    // Exactly one reason is deferred today. Stated so that adding another forces a
    // deliberate look at every consumer of the taxonomy rather than a silent widening.
    expect(reasons.filter((reason) => syncFallbackDisposition(reason) === 'deferred')).toEqual(['multi-tab-not-owner'])
  })

  it('reads the deferred reason as expected rather than as a fault', () => {
    // The copy and the classification have to agree: a reason whose own explanation
    // says it is not a fault must not be handed to consumers as one.
    expect(SYNC_FALLBACK_REASON_EXPLANATIONS['multi-tab-not-owner']).toContain('not a fault')
  })
})

describe('websocket sync protocol digest', () => {
  it('matches the frozen websocket and HTTP replay fixture', async () => {
    const body = {
      api: '20200115',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
        },
      ],
      sync_token: 'token',
      limit: 150,
    }
    const semanticBody = { ...body }
    delete (semanticBody as Partial<typeof body>).limit

    expect(canonicalSyncJson(semanticBody)).toBe(
      '{"api":"20200115","items":[{"content":"ciphertext","content_type":"Note","deleted":false,"uuid":"note-1"}],"sync_token":"token"}',
    )
    await expect(digestSyncBody(semanticBody as never, webcrypto.subtle as unknown as SubtleCrypto)).resolves.toBe(
      'e4c8512aab76dd9aca235be947afc7829b5ea652db89f93f672f69648a5e885e',
    )
  })

  it('sorts nested objects, omits undefined object fields, and preserves undefined array slots as null', () => {
    expect(canonicalSyncJson({ z: undefined, b: [{ y: 2, x: 1 }, undefined], a: true })).toBe(
      '{"a":true,"b":[{"x":1,"y":2},null]}',
    )
  })

  it('normalizes the current HTTP wire shape before hashing realistic item values', async () => {
    const wireBody = normalizeSyncRequestForWire({
      api: '20240226',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
          created_at: new Date('2026-08-18T12:34:56.789Z'),
          updated_at_timestamp: 1_787_056_496_789,
          auth_hash: undefined,
        },
      ],
      sync_token: 'token',
      cursor_token: undefined,
      limit: 150,
      shared_vault_uuids: ['vault-1'],
    })

    expect(wireBody).toEqual({
      api: '20240226',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
          created_at: '2026-08-18T12:34:56.789Z',
          updated_at_timestamp: 1_787_056_496_789,
        },
      ],
      sync_token: 'token',
      limit: 150,
      shared_vault_uuids: ['vault-1'],
    })
    expect(canonicalSyncJson(wireBody)).toBe(
      '{"api":"20240226","items":[{"content":"ciphertext","content_type":"Note","created_at":"2026-08-18T12:34:56.789Z","deleted":false,"updated_at_timestamp":1787056496789,"uuid":"note-1"}],"limit":150,"shared_vault_uuids":["vault-1"],"sync_token":"token"}',
    )
    await expect(digestSyncBody(wireBody, webcrypto.subtle as unknown as SubtleCrypto)).resolves.toBe(
      'ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61',
    )
  })

  it('rejects cyclic and invalid top-level values before transport', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => normalizeSyncRequestForWire(cyclic as never)).toThrow('not JSON serializable')
    expect(() => normalizeSyncRequestForWire(null as never)).toThrow('JSON object')
  })
})

describe('FILES_V1 binary frames', () => {
  const subtle = webcrypto.subtle as unknown as SubtleCrypto

  const header = async (
    bytes: Uint8Array,
    overrides: Partial<SocketFileBinaryHeader> = {},
  ): Promise<SocketFileBinaryHeader> => ({
    kind: 'UPLOAD_CHUNK',
    requestId: 'request-1',
    transferId: 'transfer-1',
    generation: 1,
    index: 0,
    offset: 0,
    declaredSize: bytes.byteLength,
    byteLength: bytes.byteLength,
    sha256: await fileBinaryPayloadDigest(bytes, subtle),
    final: true,
    ...overrides,
  })

  it('round-trips a chunk through the exact wire layout the gateway expects', async () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256)
    const encoded = encodeFileBinaryFrame(await header(bytes), bytes)

    // The prefix is the interop contract with `encodeFileBinaryFrame` on the
    // server: SRNF, version, kind, then a big-endian uint16 header length.
    expect([...encoded.subarray(0, 4)]).toEqual([0x53, 0x52, 0x4e, 0x46])
    expect(encoded[4]).toBe(1)
    expect(encoded[5]).toBe(1)
    const headerLength = (encoded[6] << 8) | encoded[7]
    expect(encoded.byteLength).toBe(8 + headerLength + bytes.byteLength)

    const decoded = decodeFileBinaryFrame(encoded)
    expect(decoded.header).toEqual(await header(bytes))
    expect([...decoded.bytes]).toEqual([...bytes])
    await expect(fileBinaryPayloadMatchesDigest(decoded, subtle)).resolves.toBe(true)
  })

  it('marks the kind byte so a download chunk cannot be read back as an upload', async () => {
    const bytes = Uint8Array.from([1, 2, 3])
    const encoded = encodeFileBinaryFrame(await header(bytes, { kind: 'DOWNLOAD_CHUNK' }), bytes)

    expect(encoded[5]).toBe(2)
    expect(decodeFileBinaryFrame(encoded).header.kind).toBe('DOWNLOAD_CHUNK')
  })

  it('detects a payload that does not match its declared digest', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const encoded = encodeFileBinaryFrame(await header(bytes), bytes)
    // Corrupt one payload byte, leaving the header untouched.
    encoded[encoded.byteLength - 1] ^= 0xff

    const decoded = decodeFileBinaryFrame(encoded)
    await expect(fileBinaryPayloadMatchesDigest(decoded, subtle)).resolves.toBe(false)
  })

  it('refuses to emit a frame whose header disagrees with its payload', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const claimed = await header(bytes, { byteLength: 3 })

    expect(() => encodeFileBinaryFrame(claimed, bytes)).toThrow('FILE_FRAME_MALFORMED')
  })

  it('refuses to emit a chunk above the protocol chunk ceiling', async () => {
    const bytes = new Uint8Array(MAX_FILE_CHUNK_BYTES + 1)
    // A ceiling to respect, not a budget to raise: the gateway enforces the same
    // number, so exceeding it locally can only waste a round trip.
    const claimed = await header(bytes)

    expect(() => encodeFileBinaryFrame(claimed, bytes)).toThrow('FILE_FRAME_MALFORMED')
  })

  it('refuses a final flag that disagrees with the declared size', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const claimed = await header(bytes, { declaredSize: 10, final: true })

    expect(() => encodeFileBinaryFrame(claimed, bytes)).toThrow('FILE_FRAME_MALFORMED')
  })
})

/**
 * *** THE OPERATOR'S COMPLAINT, AS A TABLE. ***
 *
 * A `1008 'sync rate limit exceeded'` used to reach the user as a bare
 * `SOCKET_CLOSED`, and so did about a dozen other distinct gateway decisions,
 * because the only thing the close site ever asked was `code >= 4000` — a test no
 * server close in this repo passes. Every case below is a close the gateway
 * actually performs, named with the code and the reason string it writes.
 */
describe('syncCloseFallbackReason', () => {
  /** `gateway.attach.test.ts` asserts this exact pair on the wire. */
  it('names the rate limit the gateway states, instead of reporting nothing', () => {
    expect(syncCloseFallbackReason({ code: 1008, reason: 'sync rate limit exceeded', wasClean: true })).toBe(
      'rate-limited',
    )
    expect(syncCloseFallbackReason({ code: 1008, reason: 'file rate limit exceeded', wasClean: true })).toBe(
      'rate-limited',
    )
    expect(syncCloseFallbackReason({ code: 1008, reason: 'message rate limit exceeded', wasClean: true })).toBe(
      'rate-limited',
    )
  })

  it('separates the eleven causes the gateway sends as 1008', () => {
    expect(syncCloseFallbackReason({ code: 1008, reason: 'per-user connection limit exceeded', wasClean: true })).toBe(
      'socket-limit',
    )
    expect(syncCloseFallbackReason({ code: 1008, reason: 'missing authToken', wasClean: true })).toBe('auth-failed')
    expect(syncCloseFallbackReason({ code: 1008, reason: 'invalid authToken', wasClean: true })).toBe('auth-failed')
    expect(syncCloseFallbackReason({ code: 1008, reason: 'origin-not-allowed', wasClean: true })).toBe('server-policy')
    expect(syncCloseFallbackReason({ code: 1008, reason: 'query-string-not-permitted', wasClean: true })).toBe(
      'proxy-failed',
    )
    expect(syncCloseFallbackReason({ code: 1008, reason: 'unknown path', wasClean: true })).toBe('proxy-failed')
    // A 1008 whose reason this build does not recognise is still a policy refusal,
    // and must NOT collapse to "no cause reported".
    expect(syncCloseFallbackReason({ code: 1008, reason: 'something-added-next-release', wasClean: true })).toBe(
      'server-policy',
    )
    expect(syncCloseFallbackReason({ code: 1008, wasClean: true })).toBe('server-policy')
  })

  it('maps the other codes the gateway closes with', () => {
    expect(syncCloseFallbackReason({ code: 1009, reason: 'sync frame too large', wasClean: true })).toBe(
      'frame-too-large',
    )
    expect(syncCloseFallbackReason({ code: 1012, reason: 'WebSocket sync is unavailable.', wasClean: true })).toBe(
      'server-unavailable',
    )
    expect(syncCloseFallbackReason({ code: 1013, reason: 'sync-unavailable:redis', wasClean: true })).toBe(
      'server-unavailable',
    )
    expect(syncCloseFallbackReason({ code: 1013, reason: 'draining', wasClean: true })).toBe('server-unavailable')
    expect(syncCloseFallbackReason({ code: 1001, reason: 'server shutting down', wasClean: true })).toBe(
      'reconnect-gap',
    )
  })

  /**
   * *** THE INVERSION THIS REPLACES. *** `code >= 4000 ? 'server-kill' : undefined`
   * reported `server-kill` for the ONLY three closes the server does not perform —
   * this client's own ack timeout, pong timeout and failed invite acknowledgement.
   */
  it('reports the client-side timeout as its own cause, never as a server kill', () => {
    expect(syncCloseFallbackReason({ code: 4000, reason: 'ack-timeout', wasClean: true })).toBe('ack-timeout')
    expect(syncCloseFallbackReason({ code: 4000, reason: 'pong-timeout', wasClean: true })).toBe('ack-timeout')
    expect(syncCloseFallbackReason({ code: 4000, reason: 'invite acknowledgement failed', wasClean: true })).toBe(
      'ack-timeout',
    )
    expect(syncCloseFallbackReason({ code: 4000, reason: 'ack-timeout', wasClean: true })).not.toBe('server-kill')
  })

  it('treats a connection that died without a close frame as a gap, not a verdict', () => {
    expect(syncCloseFallbackReason({ code: 1006, reason: '', wasClean: false })).toBe('reconnect-gap')
    // A close frame never arrived, so there is no server statement to classify and
    // whatever text came with it is not the server's word.
    expect(syncCloseFallbackReason({ code: 1008, reason: 'sync rate limit exceeded', wasClean: false })).toBe(
      'reconnect-gap',
    )
  })

  it('reports nothing for an ordinary close, so a clean teardown is not a degradation', () => {
    expect(syncCloseFallbackReason({ code: 1000, reason: 'transport-fallback', wasClean: true })).toBeUndefined()
    expect(syncCloseFallbackReason({ code: 0 })).toBeUndefined()
  })

  /**
   * The specific half. `failAndClose` sends ONE ERROR frame addressed to
   * `'protocol'` and then closes, and the close code it picks collapses eleven
   * causes onto 1008 or 1013 — so the frame's own code is the better answer and
   * must win.
   */
  it('prefers the gateway protocol ERROR code over the close code', () => {
    expect(
      syncCloseFallbackReason({
        code: 1013,
        reason: 'Sync command queue is full.',
        wasClean: true,
        protocolErrorCode: 'BACKPRESSURE',
      }),
    ).toBe('backpressure')
    expect(syncCloseFallbackReason({ code: 1013, wasClean: true, protocolErrorCode: 'SOCKET_LIMIT' })).toBe(
      'socket-limit',
    )
    expect(syncCloseFallbackReason({ code: 1013, wasClean: true, protocolErrorCode: 'SOCKET_BUDGET_LOST' })).toBe(
      'socket-limit',
    )
    expect(syncCloseFallbackReason({ code: 1008, wasClean: true, protocolErrorCode: 'AUTH_TIMEOUT' })).toBe(
      'auth-failed',
    )
    expect(syncCloseFallbackReason({ code: 1008, wasClean: true, protocolErrorCode: 'OUT_OF_ORDER' })).toBe(
      'server-policy',
    )
    expect(syncCloseFallbackReason({ code: 1008, wasClean: true, protocolErrorCode: 'SEQUENCE_EXHAUSTED' })).toBe(
      'server-policy',
    )
    expect(syncCloseFallbackReason({ code: 1008, wasClean: true, protocolErrorCode: 'INVITE_ACK_INVALID' })).toBe(
      'server-policy',
    )
    expect(syncCloseFallbackReason({ code: 1012, wasClean: true, protocolErrorCode: 'SYNC_DISABLED' })).toBe(
      'server-unavailable',
    )
    // The gateway named a cause and then the connection died before its close
    // frame arrived. The cause it named is still the truth.
    expect(syncCloseFallbackReason({ code: 1006, wasClean: false, protocolErrorCode: 'BACKPRESSURE' })).toBe(
      'backpressure',
    )
  })

  it('falls through to the close code for a protocol code this build cannot name', () => {
    expect(
      syncCloseFallbackReason({
        code: 1008,
        reason: 'sync rate limit exceeded',
        wasClean: true,
        protocolErrorCode: 'A_CODE_FROM_A_NEWER_GATEWAY',
      }),
    ).toBe('rate-limited')
  })

  /**
   * Every answer is a member of the declared set — which is what lets the ledger
   * and the admin pane key counters on it. A reason string from the network must
   * never be able to leave this function.
   */
  it('only ever answers with a declared fallback reason', () => {
    const declared = new Set(Object.keys(SYNC_FALLBACK_REASON_EXPLANATIONS))
    const codes = [0, 1000, 1001, 1005, 1006, 1008, 1009, 1011, 1012, 1013, 3000, 4000, 4999]
    const reasons = ['', 'sync rate limit exceeded', 'origin-not-allowed', 'hunter2 https://sync.internal:8443']
    const protocolCodes = [
      undefined,
      'BACKPRESSURE',
      'SOCKET_LIMIT',
      'SYNC_DISABLED',
      'NOT_AUTHORIZED',
      'REAUTH_REJECTED',
      'ALREADY_AUTHENTICATED',
      'INVALID_ENVELOPE',
      'AUTH_REQUIRED',
      'AUTH_REJECTED',
      'SOCKET_BUDGET_LOST',
      'UNKNOWN_TO_THIS_BUILD',
    ]

    for (const code of codes) {
      for (const reason of reasons) {
        for (const wasClean of [true, false, undefined]) {
          for (const protocolErrorCode of protocolCodes) {
            const answer = syncCloseFallbackReason({
              code,
              reason,
              ...(wasClean === undefined ? {} : { wasClean }),
              ...(protocolErrorCode === undefined ? {} : { protocolErrorCode }),
            })
            expect(answer === undefined || declared.has(answer)).toBe(true)
          }
        }
      }
    }
  })

  it('leaves every new reason retryable, so no consumer stands down on a transient server close', () => {
    expect(syncFallbackDisposition('rate-limited')).toBe('retryable')
    expect(syncFallbackDisposition('server-policy')).toBe('retryable')
    expect(syncFallbackDisposition('server-unavailable')).toBe('retryable')
    expect(syncFallbackDisposition('socket-limit')).toBe('retryable')
    expect(isPermanentSyncFallbackReason('server-unavailable')).toBe(false)
  })
})
