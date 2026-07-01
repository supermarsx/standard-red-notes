/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebDevice } from './WebDevice'
import * as KeychainEncryption from './KeychainEncryption'

/**
 * Standard Red Notes: WebDevice keychain-at-rest wrapping tests (t15-e2).
 *
 * Covers the plan's recovery matrix through WebDevice:
 *   - flag OFF (SHIPPED default): plaintext path, no envelope, no crypto calls at all.
 *   - flag ON + available: legacy plaintext migrates on first read (envelope written), and
 *     setKeychainValue writes a wrapped envelope.
 *   - wrapped round-trip (case 3): decrypt returns the original RawKeychainValue.
 *   - key loss / decrypt failure (cases 4 & 5): getKeychainValue resolves to {} and NEVER
 *     throws — routing into the existing account-password repair flow.
 *   - clearRawKeychainValue (case 10): removes the blob AND deletes the device key.
 *   - namespaced get/set/clear (case 11): round-trip through the wrapping layer via the base
 *     class.
 *   - cross-tab (case 12): emitKeychainChanged still fires after a wrapped write.
 *
 * KeychainEncryption (E1) is mocked so we can force available/unavailable, key-missing, and
 * decrypt-throw WITHOUT touching real WebCrypto/IndexedDB. The mock keeps isEnvelope's real
 * discriminator semantics and uses a base64 "cipher" so wrapped round-trips are exercised.
 */

jest.mock('./KeychainEncryption', () => {
  const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8')
  return {
    __esModule: true,
    KEYCHAIN_ENC_VERSION: 1,
    // Real discriminator semantics: presence of the marker => envelope.
    isEnvelope: (parsed: any) => typeof parsed === 'object' && parsed !== null && parsed.__srnKeychainEnc !== undefined,
    isWrappingAvailable: jest.fn(async () => true),
    getOrCreateDeviceKey: jest.fn(async () => ({ type: 'mock-crypto-key' })),
    encryptKeychain: jest.fn(async (plaintext: string) => ({
      __srnKeychainEnc: 1,
      alg: 'AES-GCM',
      iv: 'mock-iv',
      ct: encode(plaintext),
    })),
    decryptKeychain: jest.fn(async (envelope: any) => decode(envelope.ct)),
    deleteDeviceKey: jest.fn(async () => undefined),
  }
})

const mocked = KeychainEncryption as jest.Mocked<typeof KeychainEncryption> & {
  isEnvelope: (p: unknown) => boolean
}

const KEYCHAIN_STORAGE_KEY = 'keychain'

type Wrapped = { __srnKeychainEnc: number; alg: string; iv: string; ct: string }

/** A representative RawKeychainValue-shaped blob (root key material per identifier). */
const sampleKeychain = {
  'workspace-a': { version: '004', masterKey: 'mk-a', dataAuthenticationKey: 'dak-a' },
}

/**
 * Build a WebDevice with the cross-tab coordinator stubbed (so no real BroadcastChannel /
 * storage listener is created) and the wrapping flag forced to `flagOn`. Returns the device
 * plus the emit spy so tests can assert cross-tab notification.
 */
const makeDevice = (flagOn: boolean) => {
  const device = new WebDevice('test-version')
  const emitKeychainChanged = jest.fn()
  jest.spyOn(device as any, 'getCrossTabCoordinator').mockReturnValue({ emitKeychainChanged } as any)
  jest.spyOn(device as any, 'isWrappingEnabled').mockReturnValue(flagOn)
  return { device, emitKeychainChanged }
}

const readStoredParsed = (): any => {
  const raw = localStorage.getItem(KEYCHAIN_STORAGE_KEY)
  return raw == null ? null : JSON.parse(raw)
}

describe('WebDevice keychain-at-rest wrapping', () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    // Restore default mock behaviors (clearAllMocks wipes implementations set per-test).
    ;(mocked.isWrappingAvailable as jest.Mock).mockImplementation(async () => true)
    ;(mocked.getOrCreateDeviceKey as jest.Mock).mockImplementation(async () => ({
      type: 'mock-crypto-key',
    }))
    ;(mocked.encryptKeychain as jest.Mock).mockImplementation(async (plaintext: string) => ({
      __srnKeychainEnc: 1,
      alg: 'AES-GCM',
      iv: 'mock-iv',
      ct: Buffer.from(plaintext, 'utf8').toString('base64'),
    }))
    ;(mocked.decryptKeychain as jest.Mock).mockImplementation(async (envelope: Wrapped) =>
      Buffer.from(envelope.ct, 'base64').toString('utf8'),
    )
    ;(mocked.deleteDeviceKey as jest.Mock).mockImplementation(async () => undefined)
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  describe('flag OFF (SHIPPED default) — status-quo plaintext', () => {
    it('writes plaintext with NO envelope and NO crypto calls', async () => {
      const { device, emitKeychainChanged } = makeDevice(false)

      await device.setKeychainValue(sampleKeychain as any)

      const stored = readStoredParsed()
      expect(mocked.isEnvelope(stored)).toBe(false)
      expect(stored).toEqual(sampleKeychain)
      expect(mocked.getOrCreateDeviceKey).not.toHaveBeenCalled()
      expect(mocked.encryptKeychain).not.toHaveBeenCalled()
      expect(mocked.isWrappingAvailable).not.toHaveBeenCalled()
      expect(emitKeychainChanged).toHaveBeenCalledTimes(1)
    })

    it('reads legacy plaintext back unchanged and does NOT migrate', async () => {
      const { device } = makeDevice(false)
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(sampleKeychain))

      const value = await device.getKeychainValue()

      expect(value).toEqual(sampleKeychain)
      // Still plaintext — no migration when the flag is OFF.
      expect(mocked.isEnvelope(readStoredParsed())).toBe(false)
      expect(mocked.encryptKeychain).not.toHaveBeenCalled()
      expect(mocked.getOrCreateDeviceKey).not.toHaveBeenCalled()
    })
  })

  describe('case 2 — legacy plaintext lazily migrates on first read (flag ON + available)', () => {
    it('rewrites storage as an envelope but returns the original plaintext', async () => {
      const { device } = makeDevice(true)
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(sampleKeychain))

      const value = await device.getKeychainValue()

      // Returns the plaintext value regardless.
      expect(value).toEqual(sampleKeychain)
      // Storage is now a wrapped envelope.
      const stored = readStoredParsed()
      expect(mocked.isEnvelope(stored)).toBe(true)
      expect(mocked.encryptKeychain).toHaveBeenCalledTimes(1)
      expect(mocked.encryptKeychain).toHaveBeenCalledWith(JSON.stringify(sampleKeychain), expect.anything())
      // And it decrypts back to the same value on a subsequent read (round-trip).
      const reread = await device.getKeychainValue()
      expect(reread).toEqual(sampleKeychain)
    })

    it('leaves plaintext intact when wrapping is unavailable (private mode / no subtle)', async () => {
      ;(mocked.isWrappingAvailable as jest.Mock).mockResolvedValue(false)
      const { device } = makeDevice(true)
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(sampleKeychain))

      const value = await device.getKeychainValue()

      expect(value).toEqual(sampleKeychain)
      expect(mocked.isEnvelope(readStoredParsed())).toBe(false)
      expect(mocked.encryptKeychain).not.toHaveBeenCalled()
    })
  })

  describe('case 3 — wrapped write + round-trip read (flag ON)', () => {
    it('setKeychainValue writes an envelope and getKeychainValue decrypts it back', async () => {
      const { device, emitKeychainChanged } = makeDevice(true)

      await device.setKeychainValue(sampleKeychain as any)

      const stored = readStoredParsed()
      expect(mocked.isEnvelope(stored)).toBe(true)
      expect(mocked.getOrCreateDeviceKey).toHaveBeenCalled()
      expect(mocked.encryptKeychain).toHaveBeenCalledTimes(1)
      expect(emitKeychainChanged).toHaveBeenCalledTimes(1)

      // Simulate a reload: a fresh device re-reads the same localStorage envelope.
      const { device: reloaded } = makeDevice(true)
      const value = await reloaded.getKeychainValue()
      expect(value).toEqual(sampleKeychain)
      expect(mocked.decryptKeychain).toHaveBeenCalled()
    })
  })

  describe('case 4 — IndexedDB cleared, envelope retained (device key lost)', () => {
    it('returns {} and does NOT throw when the device key is missing', async () => {
      const { device } = makeDevice(true)
      // Pre-seed a wrapped envelope, then simulate the key being gone.
      const envelope: Wrapped = {
        __srnKeychainEnc: 1,
        alg: 'AES-GCM',
        iv: 'mock-iv',
        ct: Buffer.from(JSON.stringify(sampleKeychain), 'utf8').toString('base64'),
      }
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(envelope))
      ;(mocked.getOrCreateDeviceKey as jest.Mock).mockRejectedValue(new Error('key gone'))

      const value = await device.getKeychainValue()

      expect(value).toEqual({})
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('case 5 — tampered / undecryptable ciphertext (GCM auth failure)', () => {
    it('returns {} and does NOT throw when decrypt rejects', async () => {
      const { device } = makeDevice(true)
      const envelope: Wrapped = { __srnKeychainEnc: 1, alg: 'AES-GCM', iv: 'mock-iv', ct: 'dGFtcGVy' }
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(envelope))
      ;(mocked.decryptKeychain as jest.Mock).mockRejectedValue(new Error('GCM auth failed'))

      const value = await device.getKeychainValue()

      expect(value).toEqual({})
      expect(warnSpy).toHaveBeenCalled()
    })

    it('the unwrap path stays active even when the flag is OFF', async () => {
      const { device } = makeDevice(false)
      const envelope: Wrapped = {
        __srnKeychainEnc: 1,
        alg: 'AES-GCM',
        iv: 'mock-iv',
        ct: Buffer.from(JSON.stringify(sampleKeychain), 'utf8').toString('base64'),
      }
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(envelope))

      const value = await device.getKeychainValue()

      expect(value).toEqual(sampleKeychain)
      expect(mocked.decryptKeychain).toHaveBeenCalled()
    })
  })

  describe('fresh install (case 1) & corrupt storage', () => {
    it('returns {} when no keychain exists, with no crypto or migration', async () => {
      const { device } = makeDevice(true)
      const value = await device.getKeychainValue()
      expect(value).toEqual({})
      expect(mocked.encryptKeychain).not.toHaveBeenCalled()
      expect(mocked.getOrCreateDeviceKey).not.toHaveBeenCalled()
    })

    it('returns {} (no throw) when storage is corrupt non-JSON', async () => {
      const { device } = makeDevice(true)
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, '{not-valid-json')
      const value = await device.getKeychainValue()
      expect(value).toEqual({})
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('case 10 — clearRawKeychainValue', () => {
    it('removes the blob, notifies peers, AND deletes the device key', async () => {
      const { device, emitKeychainChanged } = makeDevice(true)
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(sampleKeychain))

      await device.clearRawKeychainValue()

      expect(localStorage.getItem(KEYCHAIN_STORAGE_KEY)).toBeNull()
      expect(emitKeychainChanged).toHaveBeenCalledTimes(1)
      expect(mocked.deleteDeviceKey).toHaveBeenCalledTimes(1)
    })
  })

  describe('case 11 — namespaced get/set/clear round-trip through wrapping (flag ON)', () => {
    it('adds, reads, and removes a workspace entry through the wrapped layer', async () => {
      const { device } = makeDevice(true)
      const entry = { version: '004', masterKey: 'mk-b' }

      // Add a workspace entry (base class reads {} then writes wrapped).
      await device.setNamespacedKeychainValue(entry as any, 'workspace-b' as any)
      expect(mocked.isEnvelope(readStoredParsed())).toBe(true)

      // Read it back through decrypt.
      const got = await device.getNamespacedKeychainValue('workspace-b' as any)
      expect(got).toEqual(entry)

      // Remove it; storage remains a wrapped envelope of {}.
      await device.clearNamespacedKeychainValue('workspace-b' as any)
      expect(mocked.isEnvelope(readStoredParsed())).toBe(true)
      const afterClear = await device.getNamespacedKeychainValue('workspace-b' as any)
      expect(afterClear).toBeUndefined()
    })
  })

  describe('case 12 — cross-tab notification preserved', () => {
    it('emitKeychainChanged fires after a wrapped write', async () => {
      const { device, emitKeychainChanged } = makeDevice(true)
      await device.setKeychainValue(sampleKeychain as any)
      expect(emitKeychainChanged).toHaveBeenCalledTimes(1)
    })

    it('refuses to write (throws) and does not persist when locked by another tab', async () => {
      const { device, emitKeychainChanged } = makeDevice(true)
      jest.spyOn(device as any, 'isKeychainLocked').mockReturnValue(true)

      await expect(device.setKeychainValue(sampleKeychain as any)).rejects.toThrow(/changed in another tab/i)
      expect(localStorage.getItem(KEYCHAIN_STORAGE_KEY)).toBeNull()
      expect(emitKeychainChanged).not.toHaveBeenCalled()
      expect(mocked.encryptKeychain).not.toHaveBeenCalled()
    })
  })

  describe('write-path fallback', () => {
    it('falls back to plaintext (never loses the write) when wrapping throws', async () => {
      ;(mocked.encryptKeychain as jest.Mock).mockRejectedValue(new Error('subtle boom'))
      const { device, emitKeychainChanged } = makeDevice(true)

      await device.setKeychainValue(sampleKeychain as any)

      const stored = readStoredParsed()
      expect(mocked.isEnvelope(stored)).toBe(false)
      expect(stored).toEqual(sampleKeychain)
      expect(emitKeychainChanged).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalled()
    })
  })
})
