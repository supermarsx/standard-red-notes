/**
 * @jest-environment jsdom
 */
import sodium from 'libsodium-wrappers-sumo'

import { decryptShare, encryptShare, ShareCrypto, SharePayload } from './shareCrypto'

/**
 * Real libsodium-backed crypto that mirrors `@standardnotes/sncrypto-web`'s
 * `SNWebCrypto` primitives byte-for-byte (XChaCha20-Poly1305 IETF, ORIGINAL
 * base64, hex encodings).
 *
 * We use libsodium directly rather than importing SNWebCrypto because the web
 * package ships a no-op stub mock for it (src/javascripts/__mocks__) and its
 * published build is ESM that jest's CommonJS runtime cannot load. This adapter
 * exercises the exact same underlying primitives, proving the share envelope
 * round-trips correctly.
 */
class TestCrypto implements ShareCrypto {
  generateRandomKey(bits: number): string {
    return sodium.to_hex(sodium.randombytes_buf(bits / 8))
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

describe('share link crypto', () => {
  let crypto: TestCrypto

  beforeAll(async () => {
    await sodium.ready
    crypto = new TestCrypto()
  })

  it('round-trips a note payload with the returned fragment key', async () => {
    const payload: SharePayload = {
      kind: 'note',
      title: 'My shared note',
      text: 'Hello **world** with `code` and a snake_case_id.',
    }

    const { encryptedPayload, keyHex } = await encryptShare(payload, crypto)
    const decrypted = await decryptShare(encryptedPayload, keyHex, crypto)

    expect(decrypted).toEqual(payload)
  })

  it('round-trips a tag bundle payload', async () => {
    const payload: SharePayload = {
      kind: 'tag',
      title: 'Recipes',
      notes: [
        { title: 'Bread', text: 'Flour, water, salt, yeast.' },
        { title: 'Soup', text: 'Vegetables and broth.' },
      ],
    }

    const { encryptedPayload, keyHex } = await encryptShare(payload, crypto)
    const decrypted = await decryptShare(encryptedPayload, keyHex, crypto)

    expect(decrypted).toEqual(payload)
  })

  it('produces a 64-hex fragment key and an opaque envelope that does not leak plaintext', async () => {
    const payload: SharePayload = { kind: 'note', title: 'Secret', text: 'super-secret-body' }

    const { encryptedPayload, keyHex } = await encryptShare(payload, crypto)

    expect(keyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(encryptedPayload).not.toContain('super-secret-body')
    expect(encryptedPayload).not.toContain('Secret')
    expect(encryptedPayload).not.toContain(keyHex)
  })

  it('throws when decrypting with the wrong key', async () => {
    const payload: SharePayload = { kind: 'note', title: 'T', text: 'body' }
    const { encryptedPayload } = await encryptShare(payload, crypto)
    const wrongKey = crypto.generateRandomKey(256)

    await expect(decryptShare(encryptedPayload, wrongKey, crypto)).rejects.toThrow()
  })
})
