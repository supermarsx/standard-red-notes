import {
  canonicalSyncJson,
  digestSyncBody,
  isPermanentSyncFallbackReason,
  normalizeSyncRequestForWire,
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
