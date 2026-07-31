import {
  assistantAuthorizeOrigin,
  isValidAssistantSubscriptionId,
  isValidAssistantPairingState,
  safeAssistantAuthorizeUrl,
} from './subscriptionPairing'

describe('subscription pairing browser guards', () => {
  it('accepts portable ids and rejects whitespace, traversal, controls, and oversized ids', () => {
    expect(isValidAssistantSubscriptionId('default')).toBe(true)
    expect(isValidAssistantSubscriptionId('team-a.prod_2')).toBe(true)
    expect(isValidAssistantSubscriptionId(' team')).toBe(false)
    expect(isValidAssistantSubscriptionId('../team')).toBe(false)
    expect(isValidAssistantSubscriptionId('team/one')).toBe(false)
    expect(isValidAssistantSubscriptionId(`team\none`)).toBe(false)
    expect(isValidAssistantSubscriptionId('a'.repeat(129))).toBe(false)
  })

  it('accepts only a 32-byte base64url OAuth state', () => {
    expect(isValidAssistantPairingState('A'.repeat(43))).toBe(true)
    expect(isValidAssistantPairingState('A'.repeat(42))).toBe(false)
    expect(isValidAssistantPairingState(`${'A'.repeat(42)}=`)).toBe(false)
  })

  it('permits HTTPS and loopback HTTP but rejects active/non-network URLs and credentials', () => {
    expect(safeAssistantAuthorizeUrl('https://auth.example.test/oauth?state=opaque')).toContain('https://')
    expect(safeAssistantAuthorizeUrl('http://localhost:1455/auth')).toContain('http://localhost')
    expect(safeAssistantAuthorizeUrl('javascript:alert(1)')).toBeNull()
    expect(safeAssistantAuthorizeUrl('data:text/html,unsafe')).toBeNull()
    expect(safeAssistantAuthorizeUrl('http://auth.example.test/oauth')).toBeNull()
    for (const raw of [
      'http://2130706433/oauth',
      'http://0x7f000001/oauth',
      'http://0177.0.0.1/oauth',
      'http://0x7f.0.0.1/oauth',
      'http://127.1/oauth',
      'http://127.0.1/oauth',
    ]) {
      expect(safeAssistantAuthorizeUrl(raw)).toBeNull()
    }
    for (const raw of ['http://localhost:1455/oauth', 'http://127.0.0.1:1455/oauth', 'http://[::1]:1455/oauth']) {
      expect(safeAssistantAuthorizeUrl(raw)).not.toBeNull()
    }
    expect(safeAssistantAuthorizeUrl('https://user:pass@auth.example.test/oauth')).toBeNull()
    expect(safeAssistantAuthorizeUrl('https://auth.example.test/oauth#fragment')).toBeNull()
  })

  it.each([
    ' https://auth.example.test/oauth',
    'https://auth.example.test/oauth ',
    'https://auth.example.test/\toauth',
    String.raw`https:\\auth.example.test\oauth`,
    String.raw`https://trusted.example.test\@evil.example.test/oauth`,
    'https://trusted.example.test@evil.example.test/oauth',
    `https://auth.example.test/oauth\u202e`,
  ])('rejects raw authorize URL syntax that could be normalized deceptively: %s', (raw) => {
    expect(safeAssistantAuthorizeUrl(raw)).toBeNull()
  })

  it('requires exactly one matching state when an expected pairing state is supplied', () => {
    const state = 'A'.repeat(43)
    expect(safeAssistantAuthorizeUrl(`https://auth.example.test/oauth?state=${state}`, state)).not.toBeNull()
    expect(safeAssistantAuthorizeUrl(`https://auth.example.test/oauth?state=${'B'.repeat(43)}`, state)).toBeNull()
    expect(safeAssistantAuthorizeUrl('https://auth.example.test/oauth', state)).toBeNull()
    expect(safeAssistantAuthorizeUrl(`https://auth.example.test/oauth?state=${state}&state=${state}`, state)).toBeNull()
  })

  it('exposes only a sanitized provider origin for administrator verification', () => {
    const raw = 'https://auth.example.test/oauth/authorize?state=STATE_SENTINEL&client_id=client'
    expect(assistantAuthorizeOrigin(raw)).toBe('https://auth.example.test')
    expect(assistantAuthorizeOrigin(raw)).not.toContain('STATE_SENTINEL')
    expect(assistantAuthorizeOrigin('javascript:alert(1)')).toBeNull()
  })
})
