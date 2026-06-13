// End-to-end encryption for collaborative (yjs) updates.
//
// The gateway relays opaque base64 blobs and never holds a key, so every yjs
// sync/awareness update is encrypted client-side with a key only the note's
// collaborators share (derived from the vault key + note id). AES-256-GCM with a
// random 96-bit IV per message; payload on the wire is base64(iv ‖ ciphertext).

const IV_BYTES = 12

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle) throw new Error('WebCrypto SubtleCrypto unavailable')
  return c.subtle
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Derive a stable per-room AES-GCM key from a shared secret (e.g. the vault key)
 * and the room id (note uuid), via HKDF-SHA-256. Collaborators holding the same
 * secret deterministically derive the same key without any key exchange.
 */
export async function deriveRoomKey(sharedSecret: string, room: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const base = await subtle().importKey('raw', enc.encode(sharedSecret), 'HKDF', false, ['deriveKey'])
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('srn-collab-v1'), info: enc.encode(room) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export interface RoomCipher {
  encrypt(plaintext: Uint8Array): Promise<string>
  decrypt(payload: string): Promise<Uint8Array>
}

/** AES-GCM cipher over a derived room key. */
export function createRoomCipher(key: CryptoKey): RoomCipher {
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

/**
 * Passthrough "cipher" (base64 only, NO encryption) for development against a
 * fully self-hosted, trusted gateway where E2E is not required. Never use this
 * when collaborators are untrusted or the relay is shared.
 */
export function createPlaintextCipher(): RoomCipher {
  return {
    async encrypt(plaintext) {
      return toBase64(plaintext)
    },
    async decrypt(payload) {
      return fromBase64(payload)
    },
  }
}
