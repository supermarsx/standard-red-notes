// Encryption primitives for collaborative (yjs) updates.
//
// These primitives provide end-to-end encryption only when the caller supplies
// a non-extractable AES-256-GCM key derived from client-only key material. The
// live product path derives that key per note from the matching client-only
// account/vault root key for signed-in owners or write/admin collaborators and
// otherwise keeps ordinary encrypted sync.
// AES-GCM uses a random 96-bit IV per message; payload is base64(iv ‖ ciphertext).

const IV_BYTES = 12
const INVALID_ROOM_KEY =
  'Collaboration requires a non-extractable AES-256-GCM CryptoKey with encrypt and decrypt access.'

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle) {
    throw new Error('WebCrypto SubtleCrypto unavailable')
  }
  return c.subtle
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export interface RoomCipher {
  encrypt(plaintext: Uint8Array): Promise<string>
  decrypt(payload: string): Promise<Uint8Array>
}

/**
 * AES-GCM cipher over a client-only room key.
 *
 * Accepting a CryptoKey instead of a string is an intentional security
 * boundary: public identifiers such as a vault systemIdentifier must never be
 * accepted as key material. The key must also be non-extractable so this layer
 * cannot accidentally serialize it into a relay frame or log.
 */
export function createRoomCipher(key: CryptoKey): RoomCipher {
  const algorithm = typeof key === 'object' && key !== null ? (key.algorithm as AesKeyAlgorithm) : undefined
  const usages = typeof key === 'object' && key !== null ? key.usages : undefined
  if (
    typeof key !== 'object' ||
    key === null ||
    key.type !== 'secret' ||
    key.extractable ||
    algorithm?.name !== 'AES-GCM' ||
    algorithm.length !== 256 ||
    !Array.isArray(usages) ||
    !usages.includes('encrypt') ||
    !usages.includes('decrypt')
  ) {
    throw new Error(INVALID_ROOM_KEY)
  }

  return {
    async encrypt(plaintext) {
      const iv = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(IV_BYTES))
      const ct = new Uint8Array(
        await subtle().encrypt(
          { name: 'AES-GCM', iv: iv as unknown as BufferSource },
          key,
          plaintext as unknown as BufferSource,
        ),
      )
      const joined = new Uint8Array(iv.length + ct.length)
      joined.set(iv, 0)
      joined.set(ct, iv.length)
      return toBase64(joined)
    },
    async decrypt(payload) {
      const joined = fromBase64(payload)
      const iv = joined.subarray(0, IV_BYTES)
      const ct = joined.subarray(IV_BYTES)
      const pt = await subtle().decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        ct as unknown as BufferSource,
      )
      return new Uint8Array(pt)
    },
  }
}
