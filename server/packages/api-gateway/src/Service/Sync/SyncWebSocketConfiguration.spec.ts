import {
  parseOptionalPositiveInteger,
  parseWebSocketSyncEnabled,
  resolveWebSocketSyncAllowedOrigins,
} from './SyncWebSocketConfiguration'

describe('WebSocket sync deployment configuration', () => {
  it.each([undefined, '', 'true'])('defaults to enabled for %p', (value) => {
    expect(parseWebSocketSyncEnabled(value)).toBe(true)
  })

  it('honors only the exact false kill switch', () => {
    expect(parseWebSocketSyncEnabled('false')).toBe(false)
    for (const invalid of ['FALSE', ' false', '0', 'yes']) {
      expect(() => parseWebSocketSyncEnabled(invalid)).toThrow(
        'WEBSOCKET_SYNC_ENABLED must be exactly "true" or "false" when set.',
      )
    }
  })

  it('uses a strict comma-separated explicit origin list', () => {
    expect(
      resolveWebSocketSyncAllowedOrigins(
        'https://notes.example, http://localhost:3001,https://notes.example',
        'https://ignored.example/path',
      ),
    ).toEqual(['https://notes.example', 'http://localhost:3001'])
  })

  it.each(['*', 'null', 'file:///tmp/app', 'https://notes.example/path', 'https://user@notes.example', ''])(
    'rejects unsafe explicit origin %p',
    (origin) => {
      if (origin === '') {
        expect(resolveWebSocketSyncAllowedOrigins(origin, undefined)).toEqual([])
      } else {
        expect(() => resolveWebSocketSyncAllowedOrigins(origin, undefined)).toThrow(
          'WEBSOCKET_SYNC_ALLOWED_ORIGINS contains an unsafe or invalid origin',
        )
      }
    },
  )

  it('derives only the exact http(s) origin from PUBLIC_URL', () => {
    expect(resolveWebSocketSyncAllowedOrigins(undefined, 'https://notes.example/app?source=selfhost')).toEqual([
      'https://notes.example',
    ])
    expect(resolveWebSocketSyncAllowedOrigins(undefined, 'file:///tmp/app')).toEqual([])
    expect(resolveWebSocketSyncAllowedOrigins(undefined, 'not a url')).toEqual([])
    expect(resolveWebSocketSyncAllowedOrigins(undefined, undefined)).toEqual([])
  })

  it('strictly parses optional positive integer limits', () => {
    expect(parseOptionalPositiveInteger('LIMIT', undefined, 10)).toBeUndefined()
    expect(parseOptionalPositiveInteger('LIMIT', '4', 10)).toBe(4)
    expect(() => parseOptionalPositiveInteger('LIMIT', '0', 10)).toThrow('LIMIT must be a positive integer')
    expect(() => parseOptionalPositiveInteger('LIMIT', '11', 10)).toThrow('no greater than 10')
  })
})
