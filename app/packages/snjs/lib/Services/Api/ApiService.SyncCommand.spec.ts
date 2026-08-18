import { LegacyApiService } from './ApiService'

describe('LegacyApiService durable sync command request', () => {
  it('adds both frozen replay headers while leaving the semantic sync body unchanged', () => {
    const service = Object.create(LegacyApiService.prototype) as LegacyApiService
    Object.assign(service, { host: 'https://sync.example.test', session: undefined })

    const request = service.getSyncHttpRequest([], 'sync-token', 'cursor-token', 150, ['vault-1'], {
      id: 'command-1',
      digest: 'a'.repeat(64),
      sequence: 4,
    })

    expect(request.customHeaders).toEqual([
      { key: 'x-sync-command-id', value: 'command-1' },
      { key: 'x-sync-command-digest', value: 'a'.repeat(64) },
    ])
    expect(request.params).toEqual({
      items: [],
      sync_token: 'sync-token',
      cursor_token: 'cursor-token',
      limit: 150,
      shared_vault_uuids: ['vault-1'],
      api: '20240226',
    })
    expect(request.params).not.toHaveProperty('command')
  })
})
