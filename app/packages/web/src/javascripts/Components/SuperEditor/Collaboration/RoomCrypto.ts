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
  encrypt(plaintext: Uint8Array, additionalData?: Uint8Array): Promise<string>
  decrypt(payload: string, additionalData?: Uint8Array): Promise<Uint8Array>
}

export const COLLABORATION_CIPHER_ENVELOPE_VERSION = 1 as const
export const COLLABORATION_REPLAY_WINDOW_SIZE = 2_048
export const MAX_COLLABORATION_SENDER_EPOCHS = 128
export const MAX_COLLABORATION_REPLAY_SCOPES = 256

const COLLABORATION_ENVELOPE_PREFIX = `srn-collab-e${COLLABORATION_CIPHER_ENVELOPE_VERSION}`
const COLLABORATION_ENVELOPE_DOMAIN = 'Standard Red Notes encrypted collaboration envelope v1'
const COLLABORATION_EPOCH_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export type CollaborationCipherErrorCode =
  'INVALID_ENVELOPE' | 'EPOCH_MISMATCH' | 'REPLAYED' | 'SEQUENCE_WINDOW' | 'SENDER_LIMIT'

export class CollaborationCipherError extends Error {
  constructor(readonly code: CollaborationCipherErrorCode) {
    super(`Encrypted collaboration frame rejected: ${code.toLowerCase().replaceAll('_', '-')}`)
    this.name = 'CollaborationCipherError'
  }
}

export function isCollaborationCipherError(error: unknown): error is CollaborationCipherError {
  return error instanceof CollaborationCipherError
}

export function isValidCollaborationRoomEpoch(value: unknown): value is string {
  return typeof value === 'string' && COLLABORATION_EPOCH_PATTERN.test(value)
}

type CollaborationEnvelopeHeader = {
  v: typeof COLLABORATION_CIPHER_ENVELOPE_VERSION
  roomEpoch: string
  senderEpoch: string
  sequence: number
}

type ReplayWindow = {
  highestSequence: number
  seen: Set<number>
}

/**
 * Replay state is deliberately independent from one cipher object. React can
 * recreate an editor/comment cipher while the gateway keeps the same room-key
 * epoch alive; sharing this bounded ledger prevents that remount from making
 * already-applied ciphertext acceptable again.
 */
export class CollaborationReplayLedger {
  private readonly replayWindows = new Map<string, ReplayWindow>()
  private readonly pendingSequences = new Set<string>()

  reserve(senderEpoch: string, sequence: number): string {
    const window = this.replayWindows.get(senderEpoch)
    if (window) {
      if (window.seen.has(sequence)) {
        throw new CollaborationCipherError('REPLAYED')
      }
      if (sequence <= window.highestSequence - COLLABORATION_REPLAY_WINDOW_SIZE) {
        throw new CollaborationCipherError('SEQUENCE_WINDOW')
      }
    }
    const pendingKey = `${senderEpoch}:${sequence}`
    if (this.pendingSequences.has(pendingKey)) {
      throw new CollaborationCipherError('REPLAYED')
    }
    this.pendingSequences.add(pendingKey)
    return pendingKey
  }

  commit(senderEpoch: string, sequence: number): void {
    let window = this.replayWindows.get(senderEpoch)
    if (!window) {
      if (this.replayWindows.size >= MAX_COLLABORATION_SENDER_EPOCHS) {
        throw new CollaborationCipherError('SENDER_LIMIT')
      }
      window = { highestSequence: sequence, seen: new Set() }
      this.replayWindows.set(senderEpoch, window)
    } else if (sequence > window.highestSequence) {
      window.highestSequence = sequence
    }
    if (window.seen.has(sequence) || sequence <= window.highestSequence - COLLABORATION_REPLAY_WINDOW_SIZE) {
      throw new CollaborationCipherError(window.seen.has(sequence) ? 'REPLAYED' : 'SEQUENCE_WINDOW')
    }
    window.seen.add(sequence)
    const floor = window.highestSequence - COLLABORATION_REPLAY_WINDOW_SIZE
    for (const seenSequence of window.seen) {
      if (seenSequence <= floor) {
        window.seen.delete(seenSequence)
      }
    }
  }

  release(pendingKey: string): void {
    this.pendingSequences.delete(pendingKey)
  }
}

const sharedReplayLedgers = new WeakMap<object, Map<string, CollaborationReplayLedger>>()

export function createCollaborationReplayLedger(): CollaborationReplayLedger {
  return new CollaborationReplayLedger()
}

/** App-lifetime, content-free replay state shared by remounted room ciphers. */
export function getCollaborationReplayLedger(
  owner: object,
  room: string,
  roomEpoch: string,
): CollaborationReplayLedger {
  if (!owner || typeof owner !== 'object' || !room || room.length > 512 || !isValidCollaborationRoomEpoch(roomEpoch)) {
    throw new CollaborationCipherError('EPOCH_MISMATCH')
  }
  let ownerLedgers = sharedReplayLedgers.get(owner)
  if (!ownerLedgers) {
    ownerLedgers = new Map()
    sharedReplayLedgers.set(owner, ownerLedgers)
  }
  const scope = JSON.stringify([room, roomEpoch])
  const existing = ownerLedgers.get(scope)
  if (existing) {
    ownerLedgers.delete(scope)
    ownerLedgers.set(scope, existing)
    return existing
  }
  while (ownerLedgers.size >= MAX_COLLABORATION_REPLAY_SCOPES) {
    const oldest = ownerLedgers.keys().next().value as string | undefined
    if (!oldest) {
      break
    }
    ownerLedgers.delete(oldest)
  }
  const created = createCollaborationReplayLedger()
  ownerLedgers.set(scope, created)
  return created
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new CollaborationCipherError('INVALID_ENVELOPE')
  }
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4))
  const decoded = fromBase64(`${standard}${padding}`)
  if (toBase64Url(decoded) !== value) {
    throw new CollaborationCipherError('INVALID_ENVELOPE')
  }
  return decoded
}

function createSenderEpoch(): string {
  const random = new Uint8Array(16)
  globalThis.crypto.getRandomValues(random)
  return toBase64Url(random)
}

function encodeEnvelopeHeader(header: CollaborationEnvelopeHeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(header))
}

function decodeEnvelopeHeader(encoded: string): { header: CollaborationEnvelopeHeader; bytes: Uint8Array } {
  let bytes: Uint8Array
  let candidate: unknown
  try {
    bytes = fromBase64Url(encoded)
    candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    if (isCollaborationCipherError(error)) {
      throw error
    }
    throw new CollaborationCipherError('INVALID_ENVELOPE')
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new CollaborationCipherError('INVALID_ENVELOPE')
  }
  const value = candidate as Record<string, unknown>
  if (
    Object.keys(value).length !== 4 ||
    value.v !== COLLABORATION_CIPHER_ENVELOPE_VERSION ||
    !isValidCollaborationRoomEpoch(value.roomEpoch) ||
    !isValidCollaborationRoomEpoch(value.senderEpoch) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) <= 0
  ) {
    throw new CollaborationCipherError('INVALID_ENVELOPE')
  }
  const header: CollaborationEnvelopeHeader = {
    v: COLLABORATION_CIPHER_ENVELOPE_VERSION,
    roomEpoch: value.roomEpoch,
    senderEpoch: value.senderEpoch,
    sequence: Number(value.sequence),
  }
  if (toBase64Url(encodeEnvelopeHeader(header)) !== encoded) {
    throw new CollaborationCipherError('INVALID_ENVELOPE')
  }
  return { header, bytes }
}

function envelopeAdditionalData(header: Uint8Array, additionalData?: Uint8Array): Uint8Array {
  const callerData = additionalData ?? new Uint8Array()
  const domain = new TextEncoder().encode(COLLABORATION_ENVELOPE_DOMAIN)
  const output = new Uint8Array(domain.length + 4 + header.length + 4 + callerData.length)
  let offset = 0
  output.set(domain, offset)
  offset += domain.length
  const view = new DataView(output.buffer)
  view.setUint32(offset, header.length)
  offset += 4
  output.set(header, offset)
  offset += header.length
  view.setUint32(offset, callerData.length)
  offset += 4
  output.set(callerData, offset)
  return output
}

function parseCollaborationEnvelope(payload: string): {
  header: CollaborationEnvelopeHeader
  headerBytes: Uint8Array
  ciphertext: string
} {
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== COLLABORATION_ENVELOPE_PREFIX || !parts[1] || !parts[2]) {
    throw new CollaborationCipherError('INVALID_ENVELOPE')
  }
  const decoded = decodeEnvelopeHeader(parts[1])
  return { header: decoded.header, headerBytes: decoded.bytes, ciphertext: parts[2] }
}

/**
 * Adds a room-epoch and per-sender monotonic sequence envelope around AES-GCM.
 *
 * The gateway still sees only opaque ciphertext. The authenticated envelope
 * prevents a captured frame from being cut into a different room epoch or
 * applied twice during this room-key lifetime, while a bounded sliding window
 * permits the provider's parallel decrypt queue to finish out of order.
 * Missing/legacy envelopes and an absent or mismatched negotiated room epoch
 * fail closed; callers must never fall back to the raw v2 cipher.
 */
export function createCollaborationRoomCipher(
  key: CryptoKey,
  roomEpoch: string,
  senderEpoch = createSenderEpoch(),
  replayLedger = createCollaborationReplayLedger(),
): RoomCipher {
  if (!isValidCollaborationRoomEpoch(roomEpoch) || !isValidCollaborationRoomEpoch(senderEpoch)) {
    throw new CollaborationCipherError('EPOCH_MISMATCH')
  }
  const cipher = createRoomCipher(key)
  let nextSequence = 0

  const assertCanReceive = (header: CollaborationEnvelopeHeader): string => {
    if (header.roomEpoch !== roomEpoch || header.senderEpoch === senderEpoch) {
      throw new CollaborationCipherError('EPOCH_MISMATCH')
    }
    return replayLedger.reserve(header.senderEpoch, header.sequence)
  }

  const commitReceived = (header: CollaborationEnvelopeHeader): void => {
    replayLedger.commit(header.senderEpoch, header.sequence)
  }

  return {
    async encrypt(plaintext, additionalData) {
      if (nextSequence >= Number.MAX_SAFE_INTEGER) {
        throw new CollaborationCipherError('SEQUENCE_WINDOW')
      }
      nextSequence += 1
      const header: CollaborationEnvelopeHeader = {
        v: COLLABORATION_CIPHER_ENVELOPE_VERSION,
        roomEpoch,
        senderEpoch,
        sequence: nextSequence,
      }
      const headerBytes = encodeEnvelopeHeader(header)
      const ciphertext = await cipher.encrypt(plaintext, envelopeAdditionalData(headerBytes, additionalData))
      return `${COLLABORATION_ENVELOPE_PREFIX}.${toBase64Url(headerBytes)}.${ciphertext}`
    },
    async decrypt(payload, additionalData) {
      const { header, headerBytes, ciphertext } = parseCollaborationEnvelope(payload)
      const pendingKey = assertCanReceive(header)
      try {
        const plaintext = await cipher.decrypt(ciphertext, envelopeAdditionalData(headerBytes, additionalData))
        commitReceived(header)
        return plaintext
      } finally {
        replayLedger.release(pendingKey)
      }
    },
  }
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
    async encrypt(plaintext, additionalData) {
      const iv = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(IV_BYTES))
      const ct = new Uint8Array(
        await subtle().encrypt(
          {
            name: 'AES-GCM',
            iv: iv as unknown as BufferSource,
            ...(additionalData ? { additionalData: additionalData as unknown as BufferSource } : {}),
          },
          key,
          plaintext as unknown as BufferSource,
        ),
      )
      const joined = new Uint8Array(iv.length + ct.length)
      joined.set(iv, 0)
      joined.set(ct, iv.length)
      return toBase64(joined)
    },
    async decrypt(payload, additionalData) {
      const joined = fromBase64(payload)
      const iv = joined.subarray(0, IV_BYTES)
      const ct = joined.subarray(IV_BYTES)
      const pt = await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: iv as unknown as BufferSource,
          ...(additionalData ? { additionalData: additionalData as unknown as BufferSource } : {}),
        },
        key,
        ct as unknown as BufferSource,
      )
      return new Uint8Array(pt)
    },
  }
}
