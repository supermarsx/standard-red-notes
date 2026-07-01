/* eslint-disable @typescript-eslint/no-explicit-any */
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'
import {
  KEYCHAIN_ENC_VERSION,
  isEnvelope,
  isWrappingAvailable,
  getOrCreateDeviceKey,
  encryptKeychain,
  decryptKeychain,
  deleteDeviceKey,
  type Envelope,
} from './KeychainEncryption'

/**
 * The jest jsdom environment provides NO IndexedDB, NO SubtleCrypto (only getRandomValues),
 * and NO TextEncoder/TextDecoder, and `fake-indexeddb` is not a dependency of this package
 * (see Database.spec.ts). So we polyfill the browser globals the module legitimately expects:
 *   - crypto        -> Node's WebCrypto (real AES-GCM, non-exportable keys)
 *   - TextEncoder/Decoder -> Node's util implementations
 *   - indexedDB     -> a tiny persistent in-memory fake (below), mirroring the hand-rolled
 *                      IDB-mock style already used by Database.spec.ts.
 *
 * The fake persists store data across opens (module-level `databases` map) so we can exercise
 * the idempotency / simulated-reload cases, and fires request/transaction handlers on
 * microtasks to mimic real IndexedDB event ordering (request.onsuccess before tx.oncomplete).
 */

// ---------------------------------------------------------------------------
// Persistent in-memory IndexedDB fake
// ---------------------------------------------------------------------------

type StoreData = Map<string, unknown>
const databases = new Map<string, Map<string, StoreData>>()

/** When set, the next indexedDB.open(...) request errors (private-mode simulation). */
let failNextOpen = false

class FakeOpenRequest {
  public onsuccess: ((event: any) => void) | null = null
  public onerror: ((event: any) => void) | null = null
  public onblocked: ((event: any) => void) | null = null
  public onupgradeneeded: ((event: any) => void) | null = null
  public result: any = undefined
  public error: any = null
}

class FakeRequest {
  public onsuccess: ((event: any) => void) | null = null
  public onerror: ((event: any) => void) | null = null
  public result: any = undefined
  public error: any = null
}

class FakeObjectStore {
  constructor(
    private data: StoreData,
    private tx: FakeTransaction,
  ) {}

  get(key: string): FakeRequest {
    return this.tx.schedule((req) => {
      req.result = this.data.get(key)
    })
  }

  put(value: unknown, key: string): FakeRequest {
    return this.tx.schedule(() => {
      this.data.set(key, value)
    })
  }

  delete(key: string): FakeRequest {
    return this.tx.schedule(() => {
      this.data.delete(key)
    })
  }
}

class FakeTransaction {
  public oncomplete: (() => void) | null = null
  public onerror: ((event: any) => void) | null = null
  public onabort: ((event: any) => void) | null = null
  public error: any = null
  private pending = 0

  constructor(private data: StoreData) {}

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this.data, this)
  }

  schedule(apply: (req: FakeRequest) => void): FakeRequest {
    const req = new FakeRequest()
    this.pending++
    queueMicrotask(() => {
      try {
        apply(req)
        req.onsuccess && req.onsuccess({ target: req })
      } catch (error) {
        req.error = error
        req.onerror && req.onerror({ target: req })
      }
      this.pending--
      if (this.pending === 0) {
        queueMicrotask(() => this.oncomplete && this.oncomplete())
      }
    })
    return req
  }
}

class FakeDatabase {
  public objectStoreNames = { contains: (name: string) => this.stores.has(name) }

  constructor(private stores: Map<string, StoreData>) {}

  createObjectStore(name: string): void {
    this.stores.set(name, new Map())
  }

  transaction(storeName: string): FakeTransaction {
    const data = this.stores.get(storeName)
    if (!data) {
      throw new DOMException('NotFoundError', 'NotFoundError')
    }
    return new FakeTransaction(data)
  }

  close(): void {
    /* no-op for the fake */
  }
}

const fakeIndexedDB = {
  open(name: string): FakeOpenRequest {
    const req = new FakeOpenRequest()
    const isNew = !databases.has(name)
    if (!databases.has(name)) {
      databases.set(name, new Map())
    }
    const stores = databases.get(name) as Map<string, StoreData>
    const db = new FakeDatabase(stores)
    req.result = db
    queueMicrotask(() => {
      if (failNextOpen) {
        failNextOpen = false
        req.error = new DOMException('open failed', 'UnknownError')
        req.onerror && req.onerror({ target: req })
        return
      }
      if (isNew) {
        req.onupgradeneeded && req.onupgradeneeded({ target: req })
      }
      req.onsuccess && req.onsuccess({ target: req })
    })
    return req
  },
} as unknown as IDBFactory

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

const originalCrypto = (globalThis as any).crypto
const originalIndexedDB = (globalThis as any).indexedDB

const installRealCrypto = () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
}

beforeAll(() => {
  installRealCrypto()
  ;(globalThis as any).TextEncoder = TextEncoder
  ;(globalThis as any).TextDecoder = TextDecoder
  Object.defineProperty(globalThis, 'indexedDB', { value: fakeIndexedDB, configurable: true, writable: true })
})

afterAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'indexedDB', { value: originalIndexedDB, configurable: true, writable: true })
})

beforeEach(() => {
  // Fresh device between tests.
  databases.clear()
  failNextOpen = false
  installRealCrypto()
  Object.defineProperty(globalThis, 'indexedDB', { value: fakeIndexedDB, configurable: true, writable: true })
})

// base64 helpers local to the test (independent of the module internals) for tamper cases.
const b64ToBytes = (b64: string) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return bytes
}
const bytesToB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

// ---------------------------------------------------------------------------
// Tests (plan recovery matrix — the cases not needing WebDevice)
// ---------------------------------------------------------------------------

describe('KeychainEncryption', () => {
  describe('isEnvelope', () => {
    it('is true only when the __srnKeychainEnc marker is present', () => {
      expect(isEnvelope({ __srnKeychainEnc: 1, alg: 'AES-GCM', iv: 'x', ct: 'y' })).toBe(true)
      // Value-agnostic: a future version bump is still recognized as an envelope.
      expect(isEnvelope({ __srnKeychainEnc: 2 })).toBe(true)
    })

    it('is false for legacy plaintext / non-objects', () => {
      expect(isEnvelope({ someIdentifier: { masterKey: 'abc' } })).toBe(false)
      expect(isEnvelope({})).toBe(false)
      expect(isEnvelope(null)).toBe(false)
      expect(isEnvelope(undefined)).toBe(false)
      expect(isEnvelope('a string')).toBe(false)
      expect(isEnvelope(42)).toBe(false)
    })
  })

  describe('isWrappingAvailable', () => {
    it('(case 1 env) is true when subtle + indexedDB are present and open works', async () => {
      await expect(isWrappingAvailable()).resolves.toBe(true)
    })

    it('(case 6) is false when SubtleCrypto is unavailable, never throws', async () => {
      // Simulate a non-secure-context / no-subtle environment: crypto without `subtle`.
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: (webcrypto as any).getRandomValues.bind(webcrypto) },
        configurable: true,
        writable: true,
      })
      await expect(isWrappingAvailable()).resolves.toBe(false)
    })

    it('(case 7) is false when indexedDB is entirely unavailable', async () => {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
      await expect(isWrappingAvailable()).resolves.toBe(false)
    })

    it('(case 7) is false when indexedDB.open errors (private mode), never throws', async () => {
      failNextOpen = true
      await expect(isWrappingAvailable()).resolves.toBe(false)
    })
  })

  describe('getOrCreateDeviceKey', () => {
    it('(case 1) creates a non-exportable AES-GCM key on first use', async () => {
      const key = await getOrCreateDeviceKey()
      expect(key).toBeDefined()
      expect((key as CryptoKey).extractable).toBe(false)
      expect((key as CryptoKey).algorithm.name).toBe('AES-GCM')
      expect((key as CryptoKey).usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']))
    })

    it('(case 8/9) is idempotent — a second call returns the same stored key', async () => {
      const first = await getOrCreateDeviceKey()
      const second = await getOrCreateDeviceKey()
      expect(second).toBe(first)
    })
  })

  describe('encrypt/decrypt round-trip', () => {
    it('(case 2) decrypt(encrypt(x)) === x for a realistic keychain JSON', async () => {
      const key = await getOrCreateDeviceKey()
      const plaintext = JSON.stringify({
        'workspace-1': { version: '004', masterKey: 'a'.repeat(64), dataAuthenticationKey: 'b'.repeat(64) },
      })
      const envelope = await encryptKeychain(plaintext, key)
      await expect(decryptKeychain(envelope, key)).resolves.toBe(plaintext)
    })

    it('produces the exact envelope shape with a 12-byte base64 IV and the version marker', async () => {
      const key = await getOrCreateDeviceKey()
      const envelope = await encryptKeychain('{}', key)
      expect(envelope.__srnKeychainEnc).toBe(KEYCHAIN_ENC_VERSION)
      expect(envelope.alg).toBe('AES-GCM')
      expect(typeof envelope.iv).toBe('string')
      expect(typeof envelope.ct).toBe('string')
      expect(isEnvelope(envelope)).toBe(true)
      expect(b64ToBytes(envelope.iv).length).toBe(12)
      // JSON must survive a serialize round-trip (localStorage stores a string).
      expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)
    })

    it('uses a fresh random IV per call (same plaintext -> different iv/ct)', async () => {
      const key = await getOrCreateDeviceKey()
      const a = await encryptKeychain('same', key)
      const b = await encryptKeychain('same', key)
      expect(a.iv).not.toBe(b.iv)
      expect(a.ct).not.toBe(b.ct)
    })

    it('round-trips unicode payloads', async () => {
      const key = await getOrCreateDeviceKey()
      const plaintext = 'clé-🔐-café-日本語'
      const envelope = await encryptKeychain(plaintext, key)
      await expect(decryptKeychain(envelope, key)).resolves.toBe(plaintext)
    })

    it('(case 8/9) a value encrypted with the first key decrypts after a simulated reopen', async () => {
      const key1 = await getOrCreateDeviceKey()
      const envelope = await encryptKeychain('persist-me', key1)
      // Simulated reload: the module re-opens the same (persisted) DB and reads the key back.
      const key2 = await getOrCreateDeviceKey()
      await expect(decryptKeychain(envelope, key2)).resolves.toBe('persist-me')
    })
  })

  describe('tamper / wrong-key detection', () => {
    it('(case 5) a byte-flipped ciphertext fails GCM auth (decrypt throws)', async () => {
      const key = await getOrCreateDeviceKey()
      const envelope = await encryptKeychain('secret', key)
      const bytes = b64ToBytes(envelope.ct)
      bytes[0] ^= 0xff
      const tampered: Envelope = { ...envelope, ct: bytesToB64(bytes) }
      await expect(decryptKeychain(tampered, key)).rejects.toBeDefined()
    })

    it('(case 4/KEY-LOST) decrypting under a different key fails GCM auth', async () => {
      const key1 = await getOrCreateDeviceKey()
      const envelope = await encryptKeychain('secret', key1)
      // Simulate IndexedDB cleared then re-created: delete the record, regenerate a fresh key.
      await deleteDeviceKey()
      const key2 = await getOrCreateDeviceKey()
      expect(key2).not.toBe(key1)
      await expect(decryptKeychain(envelope, key2)).rejects.toBeDefined()
    })
  })

  describe('deleteDeviceKey', () => {
    it('removes the stored record so the next getOrCreateDeviceKey generates a new key', async () => {
      const first = await getOrCreateDeviceKey()
      await deleteDeviceKey()
      const second = await getOrCreateDeviceKey()
      expect(second).not.toBe(first)
    })

    it('is safe (never throws) when the record / DB is absent', async () => {
      // No key was ever created in this fresh test.
      await expect(deleteDeviceKey()).resolves.toBeUndefined()
    })

    it('is safe (never throws) when indexedDB is entirely unavailable', async () => {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
      await expect(deleteDeviceKey()).resolves.toBeUndefined()
    })
  })
})
