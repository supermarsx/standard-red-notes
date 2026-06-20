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
 * Decrypt a share envelope with the fragment key. Throws if the envelope is
 * malformed or the key is wrong (so the viewer can show an "invalid link"
 * message). Pass a `crypto` to reuse one; omit it to have one created internally.
 */
export async function decryptShare(encryptedPayload: string, keyHex: string, crypto?: ShareCrypto): Promise<SharePayload> {
  if (crypto) {
    return decryptWith(encryptedPayload, keyHex, crypto)
  }

  const webCrypto = new SNWebCrypto()
  await webCrypto.initialize()
  try {
    return decryptWith(encryptedPayload, keyHex, webCrypto)
  } finally {
    webCrypto.deinit()
  }
}

function decryptWith(encryptedPayload: string, keyHex: string, crypto: ShareCrypto): SharePayload {
  const { nonce, ciphertext } = JSON.parse(encryptedPayload) as { nonce: string; ciphertext: string }
  const plaintext = crypto.xchacha20Decrypt(ciphertext, nonce, keyHex)
  if (plaintext === null) {
    throw new Error('Failed to decrypt share payload.')
  }
  return JSON.parse(plaintext) as SharePayload
}
