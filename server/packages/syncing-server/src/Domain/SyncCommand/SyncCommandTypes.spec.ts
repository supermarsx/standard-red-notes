import { canonicalJson, computeSyncCommandDigest } from './SyncCommandTypes'

describe('sync command canonical digest contract', () => {
  it('matches the current HTTP/WebSocket wire-normalized fixture including api, Date conversion, and omission', () => {
    const sourceBody = {
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
    }
    const wireBody = JSON.parse(JSON.stringify(sourceBody)) as Record<string, unknown>

    expect(canonicalJson(wireBody)).toBe(
      '{"api":"20240226","items":[{"content":"ciphertext","content_type":"Note","created_at":"2026-08-18T12:34:56.789Z","deleted":false,"updated_at_timestamp":1787056496789,"uuid":"note-1"}],"limit":150,"shared_vault_uuids":["vault-1"],"sync_token":"token"}',
    )
    expect(computeSyncCommandDigest(wireBody)).toBe('ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61')
  })

  it('preserves the original 20200115 protocol vector for older compatible clients', () => {
    const logicalBody = {
      api: '20200115',
      items: [{ uuid: 'note-1', content: 'ciphertext', content_type: 'Note', deleted: false }],
      sync_token: 'token',
    }

    expect(canonicalJson(logicalBody)).toBe(
      '{"api":"20200115","items":[{"content":"ciphertext","content_type":"Note","deleted":false,"uuid":"note-1"}],"sync_token":"token"}',
    )
    expect(computeSyncCommandDigest(logicalBody)).toBe(
      'e4c8512aab76dd9aca235be947afc7829b5ea652db89f93f672f69648a5e885e',
    )
  })

  it('sorts object keys recursively while preserving array order and JSON null slots', () => {
    expect(canonicalJson({ z: undefined, b: [{ y: 2, x: 1 }, undefined], a: null })).toBe(
      '{"a":null,"b":[{"x":1,"y":2},null]}',
    )
  })
})
