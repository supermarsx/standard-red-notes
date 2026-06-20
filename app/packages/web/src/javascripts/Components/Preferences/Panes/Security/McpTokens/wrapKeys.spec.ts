/**
 * @jest-environment jsdom
 */
import sodium from 'libsodium-wrappers-sumo'

import { wrapItemsKeys, unwrapItemsKeys, WrapCrypto, WrappableItemsKey } from './wrapKeys'

/**
 * Real libsodium-backed crypto that mirrors `@standardnotes/sncrypto-web`'s
 * `SNWebCrypto` primitives byte-for-byte (argon2id via crypto_pwhash with the
 * default algorithm, XChaCha20-Poly1305 IETF, ORIGINAL base64, hex encodings).
 *
 * We use libsodium directly rather than importing SNWebCrypto because the web
 * package ships a no-op stub mock for it (src/javascripts/__mocks__) and its
 * published build is ESM that jest's CommonJS runtime cannot load. This adapter
 * exercises the exact same underlying primitives the bridge will use, proving
 * the wrapping contract is self-consistent and reproducible.
 */
class TestCrypto implements WrapCrypto {
  generateRandomKey(bits: number): string {
    return sodium.to_hex(sodium.randombytes_buf(bits / 8))
  }

  argon2(password: string, salt: string, iterations: number, bytes: number, length: number): string {
    return sodium.crypto_pwhash(
      length,
      sodium.from_string(password),
      sodium.from_hex(salt),
      iterations,
      bytes,
      sodium.crypto_pwhash_ALG_DEFAULT,
      'hex',
    )
  }

  xchacha20Encrypt(plaintext: string, nonce: string, key: string, assocData?: string): string {
    const buffer = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      assocData || null,
      null,
      sodium.from_hex(nonce),
      sodium.from_hex(key),
    )
    return sodium.to_base64(buffer, sodium.base64_variants.ORIGINAL)
  }

  xchacha20Decrypt(ciphertext: string, nonce: string, key: string, assocData?: string): string | null {
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL),
        assocData || null,
        sodium.from_hex(nonce),
        sodium.from_hex(key),
        'text',
      )
    } catch {
      return null
    }
  }
}

describe('MCP token key wrapping', () => {
  let crypto: TestCrypto

  beforeAll(async () => {
    // Libsodium must be ready before any crypto primitive is called.
    await sodium.ready
    crypto = new TestCrypto()
  })

  it('round-trips items keys with the returned wrap secret', async () => {
    const itemsKeys: WrappableItemsKey[] = [
      {
        uuid: '11111111-1111-1111-1111-111111111111',
        itemsKey: 'a'.repeat(64),
        version: '004',
      },
      {
        uuid: '22222222-2222-2222-2222-222222222222',
        itemsKey: 'b'.repeat(64),
        version: '004',
      },
    ]

    const { wrappedKeys, kdfSalt, kdfParams, wrapSecret } = await wrapItemsKeys(itemsKeys, crypto)

    const unwrapped = unwrapItemsKeys(wrappedKeys, kdfSalt, kdfParams, wrapSecret, crypto)

    expect(unwrapped).toEqual(itemsKeys)
  })

  it('produces an opaque envelope that does not leak plaintext key material', async () => {
    const itemsKeys: WrappableItemsKey[] = [
      {
        uuid: '33333333-3333-3333-3333-333333333333',
        itemsKey: 'c'.repeat(64),
        version: '004',
      },
    ]

    const { wrappedKeys, wrapSecret } = await wrapItemsKeys(itemsKeys, crypto)

    expect(wrappedKeys).not.toContain('c'.repeat(64))
    expect(wrappedKeys).not.toContain(wrapSecret)
  })

  it('fails to unwrap with the wrong secret', async () => {
    const itemsKeys: WrappableItemsKey[] = [
      {
        uuid: '44444444-4444-4444-4444-444444444444',
        itemsKey: 'd'.repeat(64),
        version: '004',
      },
    ]

    const { wrappedKeys, kdfSalt, kdfParams } = await wrapItemsKeys(itemsKeys, crypto)
    const wrongSecret = crypto.generateRandomKey(256)

    expect(() => unwrapItemsKeys(wrappedKeys, kdfSalt, kdfParams, wrongSecret, crypto)).toThrow()
  })
})
