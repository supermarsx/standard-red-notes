/**
 * Standard Red Notes: MCP scoped token key-wrapping.
 *
 * The web client wraps the account's items keys under a high-entropy secret the
 * server NEVER sees and uploads only the ciphertext. The MCP bridge later
 * appends the same secret (the trailing segment of the issued token) to derive
 * the wrapping key and decrypt the items keys.
 *
 * This algorithm is the canonical contract: the bridge MUST mirror it
 * byte-for-byte. Do not change the constants, the KDF, the cipher, or the
 * payload/envelope JSON shapes without updating the bridge in lockstep.
 */

/**
 * Minimal structural subset of `@standardnotes/sncrypto-common`'s
 * `PureCryptoInterface` needed for key wrapping. Declared structurally so this
 * file does not need a direct dependency on sncrypto-common; both `SNWebCrypto`
 * (web) and the bridge's crypto implementation satisfy it.
 */
export interface WrapCrypto {
  generateRandomKey(bits: number): string
  argon2(password: string, salt: string, iterations: number, bytes: number, length: number): string
  xchacha20Encrypt(plaintext: string, nonce: string, key: string, assocData?: string): string
  xchacha20Decrypt(ciphertext: string, nonce: string, key: string, assocData?: string): string | null
}

export const ITERATIONS = 5
export const MEMORY_BYTES = 67108864
export const KEY_LENGTH = 32

export type WrappableItemsKey = {
  uuid: string
  itemsKey: string
  version: string
}

export type WrapResult = {
  wrappedKeys: string
  kdfSalt: string
  kdfParams: string
  /** NEVER sent to the server. Appended to the issued token client-side. */
  wrapSecret: string
}

/**
 * Wrap the given items keys under a freshly generated secret.
 * Returns the ciphertext envelope plus the wrap secret (which the caller appends
 * to the server token and shows the user once, never persisting it).
 */
export async function wrapItemsKeys(itemsKeys: WrappableItemsKey[], crypto: WrapCrypto): Promise<WrapResult> {
  const wrapSecret = crypto.generateRandomKey(256) // 64 hex chars, NEVER sent to server
  const kdfSalt = crypto.generateRandomKey(128) // 32 hex chars
  const wrapKey = crypto.argon2(wrapSecret, kdfSalt, ITERATIONS, MEMORY_BYTES, KEY_LENGTH) // 64 hex chars

  const payload = JSON.stringify({ v: 1, itemsKeys })
  const nonce = crypto.generateRandomKey(192) // 48 hex chars (24-byte xchacha nonce)
  const ciphertext = crypto.xchacha20Encrypt(payload, nonce, wrapKey)

  const wrappedKeys = JSON.stringify({ nonce, ciphertext })
  const kdfParams = JSON.stringify({
    alg: 'argon2id',
    iterations: ITERATIONS,
    bytes: MEMORY_BYTES,
    length: KEY_LENGTH,
  })

  return { wrappedKeys, kdfSalt, kdfParams, wrapSecret }
}

/**
 * Inverse of {@link wrapItemsKeys}. Exists so a unit test can prove round-trip
 * correctness and to document the exact algorithm the MCP bridge must copy.
 */
export function unwrapItemsKeys(
  wrappedKeys: string,
  kdfSalt: string,
  kdfParams: string,
  wrapSecret: string,
  crypto: WrapCrypto,
): WrappableItemsKey[] {
  const params = JSON.parse(kdfParams) as { iterations: number; bytes: number; length: number }
  const wrapKey = crypto.argon2(wrapSecret, kdfSalt, params.iterations, params.bytes, params.length)

  const { nonce, ciphertext } = JSON.parse(wrappedKeys) as { nonce: string; ciphertext: string }
  const plaintext = crypto.xchacha20Decrypt(ciphertext, nonce, wrapKey)
  if (plaintext === null) {
    throw new Error('Failed to decrypt wrapped items keys.')
  }

  const payload = JSON.parse(plaintext) as { v: number; itemsKeys: WrappableItemsKey[] }
  return payload.itemsKeys
}
