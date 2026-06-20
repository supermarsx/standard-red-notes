import {
  AppLockPasskeyCredential,
  buildAppLockAuthenticationOptions,
  buildAppLockRegistrationOptions,
  bytesToBase64Url,
  generateLocalChallenge,
  hasRegisteredAppLockPasskey,
  normalizeAppLockPasskeyCredential,
  rpIdFromHostname,
} from './appLockPasskey'

const credential = (overrides: Partial<AppLockPasskeyCredential> = {}): AppLockPasskeyCredential => ({
  credentialId: 'abc123',
  label: 'This device',
  registeredAt: 1_700_000_000_000,
  ...overrides,
})

describe('normalizeAppLockPasskeyCredential', () => {
  it('returns null for missing/garbage input', () => {
    expect(normalizeAppLockPasskeyCredential(undefined)).toBeNull()
    expect(normalizeAppLockPasskeyCredential(null)).toBeNull()
    expect(normalizeAppLockPasskeyCredential({} as AppLockPasskeyCredential)).toBeNull()
    expect(normalizeAppLockPasskeyCredential({ credentialId: '   ' })).toBeNull()
    expect(normalizeAppLockPasskeyCredential(42 as unknown as AppLockPasskeyCredential)).toBeNull()
  })

  it('round-trips a valid credential', () => {
    const input = credential()
    expect(normalizeAppLockPasskeyCredential(input)).toEqual(input)
  })

  it('trims the credential id and defaults a missing label', () => {
    const result = normalizeAppLockPasskeyCredential({ credentialId: '  xyz  ', registeredAt: 123 })
    expect(result).toEqual({ credentialId: 'xyz', label: 'This device', registeredAt: 123 })
  })

  it('defaults registeredAt when not finite', () => {
    const result = normalizeAppLockPasskeyCredential({ credentialId: 'x', registeredAt: NaN })
    expect(result?.credentialId).toBe('x')
    expect(Number.isFinite(result?.registeredAt)).toBe(true)
  })
})

describe('hasRegisteredAppLockPasskey', () => {
  it('is false for missing/garbage and true for a valid credential', () => {
    expect(hasRegisteredAppLockPasskey(undefined)).toBe(false)
    expect(hasRegisteredAppLockPasskey(null)).toBe(false)
    expect(hasRegisteredAppLockPasskey({ credentialId: '' })).toBe(false)
    expect(hasRegisteredAppLockPasskey(credential())).toBe(true)
  })
})

describe('bytesToBase64Url / generateLocalChallenge', () => {
  it('encodes bytes as url-safe base64 without padding', () => {
    // 0xfb 0xff -> standard base64 "+/8=" -> url-safe no-pad "-_8"
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
    expect(bytesToBase64Url(new Uint8Array([0]))).toBe('AA')
  })

  it('generates a non-empty url-safe challenge with no padding or unsafe chars', () => {
    const challenge = generateLocalChallenge()
    expect(challenge.length).toBeGreaterThan(0)
    expect(challenge).not.toMatch(/[+/=]/)
  })

  it('generates a fresh challenge each call', () => {
    expect(generateLocalChallenge()).not.toBe(generateLocalChallenge())
  })
})

describe('rpIdFromHostname', () => {
  it('returns the hostname, falling back to localhost', () => {
    expect(rpIdFromHostname('app.example.com')).toBe('app.example.com')
    expect(rpIdFromHostname('  notes.local  ')).toBe('notes.local')
    expect(rpIdFromHostname('')).toBe('localhost')
    expect(rpIdFromHostname(undefined)).toBe('localhost')
    expect(rpIdFromHostname(null)).toBe('localhost')
  })
})

describe('buildAppLockRegistrationOptions', () => {
  it('requires a platform authenticator with user verification', () => {
    const options = buildAppLockRegistrationOptions({ rpId: 'localhost' }) as Record<string, any>
    expect(options.rp.id).toBe('localhost')
    expect(options.authenticatorSelection.authenticatorAttachment).toBe('platform')
    expect(options.authenticatorSelection.userVerification).toBe('required')
    expect(options.challenge).toBeTruthy()
    expect(Array.isArray(options.pubKeyCredParams)).toBe(true)
  })

  it('honors an explicit challenge', () => {
    const options = buildAppLockRegistrationOptions({ rpId: 'localhost', challenge: 'fixed' }) as Record<string, any>
    expect(options.challenge).toBe('fixed')
  })
})

describe('buildAppLockAuthenticationOptions', () => {
  it('scopes the assertion to the registered credential and requires UV', () => {
    const options = buildAppLockAuthenticationOptions({ rpId: 'localhost', credentialId: 'abc123' }) as Record<
      string,
      any
    >
    expect(options.rpId).toBe('localhost')
    expect(options.userVerification).toBe('required')
    expect(options.allowCredentials).toEqual([{ id: 'abc123', type: 'public-key' }])
    expect(options.challenge).toBeTruthy()
  })
})
