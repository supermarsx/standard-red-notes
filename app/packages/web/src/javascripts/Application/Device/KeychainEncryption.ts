/**
 * Standard Red Notes: KEYCHAIN-AT-REST WRAPPING (device-bound WebCrypto envelope).
 *
 * Pure infrastructure for wrapping/unwrapping the localStorage `keychain` blob under a
 * device-bound, NON-EXPORTABLE AES-GCM CryptoKey that lives in its own tiny IndexedDB
 * database. The key bits are generated with `extractable: false`, so page JS can never read
 * them; only encrypt/decrypt operations are possible, and the key vanishes when the browser
 * clears IndexedDB.
 *
 * This module is deliberately SELF-CONTAINED and DOM/WebCrypto-only — it mirrors the
 * snjs-free style of CrossTabCoordinator and imports nothing from snjs/services/sncrypto so
 * it can sit BELOW snjs inside WebDevice. It makes NO policy decisions: it does not decide
 * *when* to wrap. WebDevice (E2), behind an off-by-default flag, drives the migration/read/
 * write flow and is responsible for routing every undecryptable/key-lost case into an empty
 * `{}` (which the existing BaseMigration keychain-repair path then re-derives from the
 * account password — no silent data loss).
 *
 * Envelope written to localStorage['keychain'] when wrapped:
 *   { "__srnKeychainEnc": 1, "alg": "AES-GCM", "iv": "<base64 12-byte>", "ct": "<base64>" }
 * Absence of __srnKeychainEnc => legacy plaintext RawKeychainValue. Presence => wrapped.
 *
 * ROBUSTNESS CONTRACT (relied on by E2):
 *   - isWrappingAvailable() and deleteDeviceKey() NEVER throw.
 *   - encryptKeychain()/decryptKeychain() may throw ONLY for genuine crypto failure; a GCM
 *     auth failure (tamper / wrong key) surfaces as a thrown/rejected error so E2 can treat
 *     it as "read as empty {}".
 */

/** Current envelope format version / discriminator value. Bump on any format change. */
export const KEYCHAIN_ENC_VERSION = 1 as const

/** AES-GCM is the only algorithm this module uses. */
const ALG = 'AES-GCM' as const

/** GCM standard IV size: 12 random bytes, fresh per encrypt call. */
const IV_BYTE_LENGTH = 12

/** Own tiny IndexedDB database holding the single device key record. */
const DB_NAME = 'srn-device-keychain-key'
const STORE_NAME = 'keys'
const RECORD_ID = 'keychain-wrap-key'

/**
 * The wrapped-keychain envelope. `iv` and `ct` are base64. `__srnKeychainEnc` is the version
 * marker that discriminates a wrapped blob from a legacy plaintext RawKeychainValue.
 */
export interface KeychainEncryptionEnvelope {
  __srnKeychainEnc: typeof KEYCHAIN_ENC_VERSION
  alg: typeof ALG
  /** base64 of the 12-byte random IV used for this ciphertext. */
  iv: string
  /** base64 of the AES-GCM ciphertext (includes the auth tag). */
  ct: string
}

/** Convenience alias matching the exported type name E2 consumes. */
export type Envelope = KeychainEncryptionEnvelope

// ---------------------------------------------------------------------------
// Global-scope resolution (self/worker-safe, mirrors CrossTabCoordinator/sncrypto)
// ---------------------------------------------------------------------------

interface CryptoGlobalScope {
  crypto?: Crypto
  indexedDB?: IDBFactory
  btoa?: (data: string) => string
  atob?: (data: string) => string
}

/**
 * Resolve the ambient global generically: prefer `self` (defined in Web Workers and on the
 * main thread), then `globalThis`, then `window`. Resolved lazily on every call so callers/
 * tests can swap `crypto`/`indexedDB` between invocations.
 */
function getGlobalScope(): CryptoGlobalScope {
  if (typeof self !== 'undefined') {
    return self as unknown as CryptoGlobalScope
  }
  if (typeof globalThis !== 'undefined') {
    return globalThis as unknown as CryptoGlobalScope
  }
  return window as unknown as CryptoGlobalScope
}

function getSubtle(): SubtleCrypto | undefined {
  return getGlobalScope().crypto?.subtle
}

function getRandom(): Crypto | undefined {
  const crypto = getGlobalScope().crypto
  return crypto && typeof crypto.getRandomValues === 'function' ? crypto : undefined
}

function getIndexedDB(): IDBFactory | undefined {
  return getGlobalScope().indexedDB
}

// ---------------------------------------------------------------------------
// Base64 <-> bytes (self-contained; no libsodium/sncrypto dependency)
// ---------------------------------------------------------------------------

/** Encode raw bytes to a standard (non-URL-safe) base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  const scope = getGlobalScope()
  let binary = ''
  // Chunk to stay well under the argument-count limit of String.fromCharCode.apply.
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, chunk as unknown as number[])
  }
  if (!scope.btoa) {
    throw new Error('base64 encoder (btoa) unavailable')
  }
  return scope.btoa(binary)
}

/** Decode a standard base64 string back to raw bytes. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const scope = getGlobalScope()
  if (!scope.atob) {
    throw new Error('base64 decoder (atob) unavailable')
  }
  const binary = scope.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// IndexedDB (own tiny DB for the device key)
// ---------------------------------------------------------------------------

/**
 * Open (creating on first use) the device-key database. Rejects on any open error/block or if
 * IndexedDB is unavailable. Callers are responsible for `db.close()`.
 */
function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = getIndexedDB()
    if (!idb) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = idb.open(DB_NAME, 1)
    } catch (error) {
      // Some environments (private mode) throw synchronously from open().
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Out-of-line keys: the record id is passed explicitly to put()/get().
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB open failed'))
    }
    request.onblocked = () => {
      reject(new Error('IndexedDB open blocked'))
    }
  })
}

/** Read the single record from the store; resolves undefined when absent. */
function readRecord(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let request: IDBRequest
    try {
      request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(RECORD_ID)
    } catch (error) {
      reject(error)
      return
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
  })
}

/**
 * Put a value under RECORD_ID and AWAIT transaction.oncomplete so the write is durable before
 * we return (the crash-safety ordering the plan mandates: the key must be persisted before any
 * envelope is written to localStorage).
 */
function putRecordDurable(db: IDBDatabase, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = db.transaction(STORE_NAME, 'readwrite')
    } catch (error) {
      reject(error)
      return
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'))
    const request = transaction.objectStore(STORE_NAME).put(value, RECORD_ID)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB put failed'))
  })
}

/** Delete the single record. Deleting an absent record is a no-op success in IndexedDB. */
function deleteRecord(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = db.transaction(STORE_NAME, 'readwrite')
    } catch (error) {
      reject(error)
      return
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB delete failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB delete aborted'))
    transaction.objectStore(STORE_NAME).delete(RECORD_ID)
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True iff `parsed` looks like a wrapped envelope, i.e. it carries the __srnKeychainEnc
 * marker. Value-agnostic (any version number counts) so future format bumps are still
 * recognized as envelopes rather than mistaken for legacy plaintext.
 */
export function isEnvelope(parsed: unknown): parsed is Envelope {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { __srnKeychainEnc?: unknown }).__srnKeychainEnc !== undefined
  )
}

/**
 * Probe whether wrapping is possible in this environment WITHOUT throwing. Requires BOTH a
 * usable SubtleCrypto (secure context / present) AND a working IndexedDB open. Returns false
 * in private-mode / no-subtle / non-secure-context. Never throws.
 *
 * Opening the device-key DB here is harmless: it creates only an empty store (no key record),
 * and the DB is closed again immediately.
 */
export async function isWrappingAvailable(): Promise<boolean> {
  try {
    if (!getSubtle() || !getRandom()) {
      return false
    }
    if (!getIndexedDB()) {
      return false
    }
    const db = await openKeyDatabase()
    db.close()
    return true
  } catch {
    return false
  }
}

/**
 * Return the device-bound wrapping key, creating and durably persisting it on first use.
 *
 * Opens DB `srn-device-keychain-key`, store `keys`, record `keychain-wrap-key`. If present,
 * returns the stored CryptoKey object (structured-cloneable even though extractable=false).
 * Otherwise generates a NON-EXPORTABLE AES-GCM-256 key, puts it, and AWAITS
 * transaction.oncomplete (durability) BEFORE returning.
 *
 * Idempotent: a second call reuses the stored key. Throws if SubtleCrypto/IndexedDB are
 * unavailable — callers must gate on isWrappingAvailable() first.
 */
export async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  const subtle = getSubtle()
  if (!subtle) {
    throw new Error('SubtleCrypto unavailable')
  }
  const db = await openKeyDatabase()
  try {
    const existing = await readRecord(db)
    if (existing) {
      return existing as CryptoKey
    }
    // extractable is false: the raw key bits can never be read out by page JS.
    const key = await subtle.generateKey({ name: ALG, length: 256 }, false, ['encrypt', 'decrypt'])
    await putRecordDurable(db, key)
    return key
  } finally {
    db.close()
  }
}

/**
 * AES-GCM-encrypt `plaintext` under `key`, producing an envelope. A fresh 12-byte random IV is
 * generated per call. The GCM auth tag is included in the ciphertext, so tamper/wrong-key is
 * detectable on decrypt.
 */
export async function encryptKeychain(plaintext: string, key: CryptoKey): Promise<Envelope> {
  const subtle = getSubtle()
  const randomSource = getRandom()
  if (!subtle || !randomSource) {
    throw new Error('SubtleCrypto unavailable')
  }
  const iv = randomSource.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
  const encoded: BufferSource = new TextEncoder().encode(plaintext) as unknown as BufferSource
  const ciphertext = await subtle.encrypt({ name: ALG, iv }, key, encoded)
  return {
    __srnKeychainEnc: KEYCHAIN_ENC_VERSION,
    alg: ALG,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

/**
 * AES-GCM-decrypt an envelope under `key`, returning the original plaintext string. Throws
 * (rejects) on GCM auth failure — tampered ciphertext or the wrong/rotated key. The caller
 * (WebDevice/E2) converts a throw (or a missing key) into an empty `{}` so the existing
 * account-password keychain-repair flow can re-derive the key.
 */
export async function decryptKeychain(envelope: Envelope, key: CryptoKey): Promise<string> {
  const subtle = getSubtle()
  if (!subtle) {
    throw new Error('SubtleCrypto unavailable')
  }
  const iv = base64ToBytes(envelope.iv)
  const ciphertext = base64ToBytes(envelope.ct)
  const decrypted = await subtle.decrypt({ name: ALG, iv }, key, ciphertext)
  return new TextDecoder().decode(decrypted)
}

/**
 * Delete the device key record (used by WebDevice.clearRawKeychainValue /
 * clearAllDataFromDevice). NEVER throws: a missing DB / unavailable IndexedDB / delete error is
 * swallowed, since clearing must always succeed from the caller's perspective.
 */
export async function deleteDeviceKey(): Promise<void> {
  try {
    if (!getIndexedDB()) {
      return
    }
    const db = await openKeyDatabase()
    try {
      await deleteRecord(db)
    } finally {
      db.close()
    }
  } catch {
    // Never throw on missing DB / unavailable IndexedDB.
  }
}
