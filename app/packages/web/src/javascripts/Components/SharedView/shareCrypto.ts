/**
 * Standard Red Notes: public share-link crypto.
 *
 * A signed-in user shares a note (or tag bundle) read-only via a URL whose secret
 * key lives in the URL fragment (#...), so the server never sees it. The server
 * stores only the ciphertext envelope (`encryptedPayload`) keyed by a shareId.
 *
 * Unlike the MCP token wrapping, NO argon2 KDF is needed here: the fragment key is
 * itself a freshly generated 256-bit XChaCha20 key (high-entropy), so it is used
 * directly. The envelope shape is `{ v, nonce, ciphertext }` (JSON string).
 *
 * The crypto primitives are declared structurally (see {@link ShareCrypto}) so
 * this file does not need a direct dependency on sncrypto-common; `SNWebCrypto`
 * satisfies the interface, and unit tests can inject a libsodium-backed adapter.
 */

import { SNWebCrypto } from '@standardnotes/sncrypto-web'

/**
 * Minimal structural subset of `@standardnotes/sncrypto-common`'s
 * `PureCryptoInterface` needed for share encryption. Both `SNWebCrypto` and the
 * test adapter satisfy it.
 */
export interface ShareCrypto {
  generateRandomKey(bits: number): string
  xchacha20Encrypt(plaintext: string, nonce: string, key: string, assocData?: string): string
  xchacha20Decrypt(ciphertext: string, nonce: string, key: string, assocData?: string): string | null
}

/** A shared note. */
export type SharedNotePayload = {
  kind: 'note'
  title: string
  text: string
}

/** A shared tag bundle: the tag title plus the notes it contains. */
export type SharedTagPayload = {
  kind: 'tag'
  title: string
  notes: { title: string; text: string }[]
}

export type SharePayload = SharedNotePayload | SharedTagPayload

export type EncryptShareResult = {
  /** Ciphertext envelope JSON. Sent to the server; safe to store in plaintext. */
  encryptedPayload: string
  /** 64-hex (32-byte) XChaCha20 key. Goes in the URL fragment, NEVER sent to the server. */
  keyHex: string
}

/**
 * Why a decrypt attempt failed. These are NOT interchangeable, and collapsing
 * them is what made every share-link failure render the same unactionable
 * sentence:
 *
 *  - `crypto-unavailable`: libsodium never initialized, so nothing was attempted.
 *    Nothing is wrong with the link.
 *  - `malformed-envelope`: the stored `encryptedPayload` is not our
 *    `{ v, nonce, ciphertext }` JSON. The SERVER side of the share is wrong; the
 *    key was never used.
 *  - `wrong-key`: the envelope is well formed but this key does not open it (AEAD
 *    verification failed, or the plaintext is not a share payload). The link's
 *    fragment is wrong or truncated.
 */
export type ShareDecryptFailureReason = 'crypto-unavailable' | 'malformed-envelope' | 'wrong-key'

/**
 * A decrypt failure that says WHICH of the three unrelated things went wrong, so
 * the viewer can tell the reader something they can act on. Carries no key and no
 * plaintext — only the reason, a fixed message, and the underlying error.
 *
 * Consumers should read `.reason` rather than use `instanceof`: the viewer and
 * this module can be separated by a module mock or two bundle copies, and an
 * `instanceof` check that quietly fails would silently re-conflate the states.
 */
export class ShareDecryptError extends Error {
  readonly reason: ShareDecryptFailureReason
  /** The underlying error, when there was one. Never contains the key or plaintext. */
  readonly underlying?: unknown

  constructor(reason: ShareDecryptFailureReason, message: string, underlying?: unknown) {
    super(message)
    this.name = 'ShareDecryptError'
    this.reason = reason
    this.underlying = underlying
  }
}

/**
 * Encrypt a share payload under a freshly generated fragment key.
 *
 * Pass a `crypto` to reuse one (e.g. in a loop / test); omit it to have a
 * `SNWebCrypto` created, initialized, and deinited internally.
 */
export async function encryptShare(payloadObj: SharePayload, crypto?: ShareCrypto): Promise<EncryptShareResult> {
  if (crypto) {
    return encryptWith(payloadObj, crypto)
  }

  const webCrypto = new SNWebCrypto()
  await webCrypto.initialize()
  try {
    return encryptWith(payloadObj, webCrypto)
  } finally {
    webCrypto.deinit()
  }
}

function encryptWith(payloadObj: SharePayload, crypto: ShareCrypto): EncryptShareResult {
  const keyHex = crypto.generateRandomKey(256) // 64 hex chars (32-byte xchacha key) -> URL fragment
  const nonce = crypto.generateRandomKey(192) // 48 hex chars (24-byte xchacha nonce)
  const ciphertext = crypto.xchacha20Encrypt(JSON.stringify(payloadObj), nonce, keyHex) // base64

  const encryptedPayload = JSON.stringify({ v: 1, nonce, ciphertext })
  return { encryptedPayload, keyHex }
}

/**
 * Decrypt a share envelope with the fragment key. Always throws a
 * {@link ShareDecryptError} on failure, whose `reason` says which of the three
 * unrelated failures happened, so the viewer can say something actionable
 * instead of one catch-all sentence. Pass a `crypto` to reuse one; omit it to
 * have one created internally.
 */
export async function decryptShare(
  encryptedPayload: string,
  keyHex: string,
  crypto?: ShareCrypto,
): Promise<SharePayload> {
  if (crypto) {
    return decryptWith(encryptedPayload, keyHex, crypto)
  }

  // Creating AND initializing SNWebCrypto loads libsodium's WASM. A failure here
  // means we never attempted a decrypt, so it must NOT be reported as a bad link.
  let webCrypto: SNWebCrypto
  try {
    webCrypto = new SNWebCrypto()
    await webCrypto.initialize()
  } catch (error) {
    throw new ShareDecryptError('crypto-unavailable', 'Could not initialize the browser crypto library.', error)
  }

  try {
    return decryptWith(encryptedPayload, keyHex, webCrypto)
  } finally {
    webCrypto.deinit()
  }
}

function decryptWith(encryptedPayload: string, keyHex: string, crypto: ShareCrypto): SharePayload {
  let envelope: unknown
  try {
    envelope = JSON.parse(encryptedPayload)
  } catch (error) {
    throw new ShareDecryptError('malformed-envelope', 'Share envelope is not valid JSON.', error)
  }

  const { nonce, ciphertext } = (envelope ?? {}) as { nonce?: unknown; ciphertext?: unknown }
  if (typeof nonce !== 'string' || typeof ciphertext !== 'string') {
    throw new ShareDecryptError('malformed-envelope', 'Share envelope has no nonce/ciphertext pair.')
  }

  // A non-hex key makes libsodium's decoders throw rather than return null, so a
  // truncated fragment must not escape as an untyped error.
  let plaintext: string | null
  try {
    plaintext = crypto.xchacha20Decrypt(ciphertext, nonce, keyHex)
  } catch (error) {
    throw new ShareDecryptError('wrong-key', 'Failed to decrypt share payload.', error)
  }
  if (plaintext === null) {
    throw new ShareDecryptError('wrong-key', 'Failed to decrypt share payload.')
  }

  try {
    return JSON.parse(plaintext) as SharePayload
  } catch (error) {
    throw new ShareDecryptError('wrong-key', 'Decrypted share payload is not valid JSON.', error)
  }
}
