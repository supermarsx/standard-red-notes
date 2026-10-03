/**
 * @jest-environment jsdom
 */
import sodium from 'libsodium-wrappers-sumo'

import { decryptShare, encryptShare, ShareCrypto, ShareDecryptError, SharePayload } from './shareCrypto'

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

  /**
   * A failed decrypt used to be a bare `new Error`, so the viewer could not tell
   * "the server stored something that is not a share envelope" from "this key
   * does not open it" — and it rendered one sentence for both. `reason` is what
   * the viewer now switches on, so each of these is pinned against real
   * libsodium rather than a stub.
   */
  describe('failure reasons', () => {
    const reasonOf = async (encryptedPayload: string, keyHex: string): Promise<unknown> => {
      try {
        await decryptShare(encryptedPayload, keyHex, crypto)
      } catch (error) {
        return (error as ShareDecryptError).reason
      }
      throw new Error('expected decryptShare to reject')
    }

    it('reports a non-JSON envelope as malformed-envelope', async () => {
      await expect(reasonOf('<!doctype html>', crypto.generateRandomKey(256))).resolves.toBe('malformed-envelope')
    })

    it('reports an envelope with no nonce/ciphertext pair as malformed-envelope', async () => {
      await expect(reasonOf('{"v":1}', crypto.generateRandomKey(256))).resolves.toBe('malformed-envelope')
      await expect(reasonOf('{"v":1,"nonce":"aa"}', crypto.generateRandomKey(256))).resolves.toBe('malformed-envelope')
      await expect(reasonOf('null', crypto.generateRandomKey(256))).resolves.toBe('malformed-envelope')
    })

    it('reports a well-formed envelope opened with the wrong key as wrong-key', async () => {
      const { encryptedPayload } = await encryptShare({ kind: 'note', title: 'T', text: 'body' }, crypto)

      await expect(reasonOf(encryptedPayload, crypto.generateRandomKey(256))).resolves.toBe('wrong-key')
    })

    it('reports a truncated (non-hex-length) fragment key as wrong-key, not as a crash', async () => {
      const { encryptedPayload, keyHex } = await encryptShare({ kind: 'note', title: 'T', text: 'body' }, crypto)

      // A hand-copied link losing its tail is the single most likely bad key.
      await expect(reasonOf(encryptedPayload, keyHex.slice(0, 40))).resolves.toBe('wrong-key')
    })

    it('carries a ShareDecryptError whose message leaks neither the key nor the plaintext', async () => {
      const { encryptedPayload, keyHex } = await encryptShare(
        { kind: 'note', title: 'Secret', text: 'super-secret-body' },
        crypto,
      )
      const wrongKey = crypto.generateRandomKey(256)

      await expect(decryptShare(encryptedPayload, wrongKey, crypto)).rejects.toMatchObject({
        name: 'ShareDecryptError',
        reason: 'wrong-key',
      })

      let message = ''
      try {
        await decryptShare(encryptedPayload, wrongKey, crypto)
      } catch (error) {
        message = (error as ShareDecryptError).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain(wrongKey)
      expect(message).not.toContain(keyHex)
      expect(message).not.toContain('super-secret-body')
    })
  })
})
