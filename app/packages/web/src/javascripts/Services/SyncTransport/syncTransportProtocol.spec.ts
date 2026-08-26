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
  type SocketFileBinaryHeader,
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
