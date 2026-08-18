import { canonicalSyncCommandJson, computeSyncCommandDigest, logicalSyncCommandPayload } from './SyncCommandDigest'

describe('gateway sync command digest', () => {
  it('matches the current wire-normalized HTTP/WebSocket fixture including required limit', () => {
    const source = {
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
      command: { id: 'excluded', digest: 'excluded' },
    }
    const wire = JSON.parse(JSON.stringify(source)) as Record<string, unknown>
    const logical = logicalSyncCommandPayload(wire)

    expect(canonicalSyncCommandJson(logical)).toBe(
      '{"api":"20240226","items":[{"content":"ciphertext","content_type":"Note","created_at":"2026-08-18T12:34:56.789Z","deleted":false,"updated_at_timestamp":1787056496789,"uuid":"note-1"}],"limit":150,"shared_vault_uuids":["vault-1"],"sync_token":"token"}',
    )
    expect(computeSyncCommandDigest(logical)).toBe('ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61')
  })
})
