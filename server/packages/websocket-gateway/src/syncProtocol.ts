import { createHash, timingSafeEqual } from 'node:crypto'

export const SYNC_PROTOCOL_VERSION = 1 as const
export const SYNC_CHANNEL = 'sync' as const
/** Kept below the legacy gateway's 544 KiB transport ceiling. */
export const MAX_SYNC_FRAME_BYTES = 512 * 1024
export const SYNC_AUTH_DEADLINE_MS = 5_000
export const SYNC_BACKEND_TIMEOUT_MS = 15_000
export const MAX_SYNC_BUFFERED_BYTES = 256 * 1024
export const MAX_SYNC_QUEUED_FRAMES = 8
export const MAX_SYNC_QUEUED_BYTES = MAX_SYNC_FRAME_BYTES
/** Unsigned 32-bit sequence space leaves no unsafe-integer increment edge. */
export const MAX_SYNC_SEQUENCE = 0xffff_ffff
export const MAX_SYNC_RESUME_SEQUENCE = MAX_SYNC_SEQUENCE - 1

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u

export type SyncClientFrameType = 'AUTH' | 'COMMAND' | 'STATUS' | 'PING'
export type SyncServerFrameType = 'AUTHENTICATED' | 'ACCEPTED' | 'COMMITTED' | 'STATUS' | 'ERROR' | 'PONG'

export type JsonObject = Record<string, unknown>

interface SyncFrameBase<TType extends string, TPayload extends JsonObject> {
  version: typeof SYNC_PROTOCOL_VERSION
  channel: typeof SYNC_CHANNEL
  type: TType
  requestId: string
  commandId: string
  sequence: number
  payloadLength: number
  payload: TPayload
}

export interface SyncAuthPayload extends JsonObject {
  ticket: string
  deviceId: string
  resumeSequence?: number
}

export interface SyncCommandPayload extends JsonObject {
  command: 'SYNC_ITEMS'
  body: JsonObject
}

export type SyncAuthFrame = SyncFrameBase<'AUTH', SyncAuthPayload>
export type SyncCommandFrame = SyncFrameBase<'COMMAND', SyncCommandPayload> & { digest: string }
export type SyncStatusRequestFrame = SyncFrameBase<'STATUS', JsonObject> & { digest: string }
export type SyncPingFrame = SyncFrameBase<'PING', JsonObject>
export type SyncClientFrame = SyncAuthFrame | SyncCommandFrame | SyncStatusRequestFrame | SyncPingFrame

export type SyncServerFrame = SyncFrameBase<SyncServerFrameType, JsonObject> & { digest?: string }

export type SyncProtocolErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'MALFORMED_JSON'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_SEQUENCE'
  | 'INVALID_PAYLOAD_LENGTH'
  | 'INVALID_DIGEST'

export class SyncProtocolError extends Error {
  constructor(
    readonly code: SyncProtocolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SyncProtocolError'
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

export function isSyncDeviceId(value: unknown): value is string {
  return isIdentifier(value)
}

export function syncPayloadLength(payload: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

/** Canonical protocol-v1 JSON: object keys sort recursively; array order is semantic. */
export function canonicalSyncJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSyncJson(entry)).join(',')}]`
  }
  const object = value as JsonObject
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(object[key])}`).join(',')}}`
}

/**
 * Protocol-v1 digest domain: the logical SyncItems body only. The WebSocket
 * envelope and command discriminator are deliberately excluded so a command
 * can be replayed over authenticated HTTP with the identical id/digest pair.
 */
export function digestSyncCommandBody(body: JsonObject): string {
  return createHash('sha256').update(canonicalSyncJson(body), 'utf8').digest('hex')
}

/** Published cross-transport vector; the syncing server and clients assert this exact value. */
export const SYNC_COMMAND_DIGEST_TEST_VECTOR = Object.freeze({
  body: {
    api: '20200115',
    items: [{ uuid: 'note-1', content: 'ciphertext', content_type: 'Note', deleted: false }],
    sync_token: 'token',
  },
  canonical:
    '{"api":"20200115","items":[{"content":"ciphertext","content_type":"Note","deleted":false,"uuid":"note-1"}],"sync_token":"token"}',
  digest: 'e4c8512aab76dd9aca235be947afc7829b5ea652db89f93f672f69648a5e885e',
})

/** Current JSON-wire fixture shared with the HTTP durable-command path. */
export const CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR = Object.freeze({
  body: {
    api: '20240226',
    items: [
      {
        uuid: 'note-1',
        content: 'ciphertext',
        content_type: 'Note',
        deleted: false,
        created_at: '2026-08-18T12:34:56.789Z',
        updated_at_timestamp: 1_787_056_496_789,
      },
    ],
    sync_token: 'token',
    limit: 150,
    shared_vault_uuids: ['vault-1'],
  },
  canonical:
    '{"api":"20240226","items":[{"content":"ciphertext","content_type":"Note","created_at":"2026-08-18T12:34:56.789Z","deleted":false,"updated_at_timestamp":1787056496789,"uuid":"note-1"}],"limit":150,"shared_vault_uuids":["vault-1"],"sync_token":"token"}',
  digest: 'ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61',
})

export function constantTimeDigestMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !DIGEST_PATTERN.test(provided) || !DIGEST_PATTERN.test(expected)) {
    return false
  }
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
}

function validateBase(frame: JsonObject): void {
  if (frame.version !== SYNC_PROTOCOL_VERSION) {
    throw new SyncProtocolError('UNSUPPORTED_VERSION', 'Unsupported sync protocol version.')
  }
  if (frame.channel !== SYNC_CHANNEL || typeof frame.type !== 'string') {
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid sync frame channel or type.')
  }
  if (!isIdentifier(frame.requestId) || !isIdentifier(frame.commandId)) {
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid sync frame identifier.')
  }
  if (
    !Number.isSafeInteger(frame.sequence) ||
    Number(frame.sequence) < 0 ||
    Number(frame.sequence) > MAX_SYNC_SEQUENCE
  ) {
    throw new SyncProtocolError('INVALID_SEQUENCE', 'Invalid sync frame sequence.')
  }
  if (!Number.isSafeInteger(frame.payloadLength) || Number(frame.payloadLength) < 0) {
    throw new SyncProtocolError('INVALID_PAYLOAD_LENGTH', 'Invalid sync payload length.')
  }
  if (!isJsonObject(frame.payload)) {
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Sync frame payload must be an object.')
  }
  if (syncPayloadLength(frame.payload) !== frame.payloadLength) {
    throw new SyncProtocolError('INVALID_PAYLOAD_LENGTH', 'Sync payload length does not match its envelope.')
  }
}

export function parseSyncClientFrame(raw: string, rawBytes = Buffer.byteLength(raw, 'utf8')): SyncClientFrame {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0 || rawBytes > MAX_SYNC_FRAME_BYTES) {
    throw new SyncProtocolError('FRAME_TOO_LARGE', 'Sync frame exceeds the transport limit.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new SyncProtocolError('MALFORMED_JSON', 'Sync frame is not valid JSON.')
  }
  if (!isJsonObject(parsed)) {
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Sync frame must be an object.')
  }
  validateBase(parsed)

  const type = parsed.type as SyncClientFrameType
  const commonKeys = ['version', 'channel', 'type', 'requestId', 'commandId', 'sequence', 'payloadLength', 'payload']
  if (type === 'AUTH') {
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(parsed.payload as JsonObject, [
        'ticket',
        'deviceId',
        ...(Object.hasOwn(parsed.payload as JsonObject, 'resumeSequence') ? ['resumeSequence'] : []),
      ])
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid AUTH frame fields.')
    }
    const payload = parsed.payload as JsonObject
    if (
      typeof payload.ticket !== 'string' ||
      payload.ticket.length < 32 ||
      payload.ticket.length > 256 ||
      !isSyncDeviceId(payload.deviceId) ||
      (payload.resumeSequence !== undefined &&
        (!Number.isSafeInteger(payload.resumeSequence) ||
          Number(payload.resumeSequence) < 0 ||
          Number(payload.resumeSequence) > MAX_SYNC_RESUME_SEQUENCE)) ||
      parsed.sequence !== 0
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid AUTH payload.')
    }
    return parsed as unknown as SyncAuthFrame
  }

  if (type === 'COMMAND') {
    if (!hasExactKeys(parsed, [...commonKeys, 'digest'])) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid COMMAND frame fields.')
    }
    const payload = parsed.payload as JsonObject
    if (
      !hasExactKeys(payload, ['command', 'body']) ||
      payload.command !== 'SYNC_ITEMS' ||
      !isJsonObject(payload.body)
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid sync command payload.')
    }
    const expectedDigest = digestSyncCommandBody(payload.body)
    if (!constantTimeDigestMatches(parsed.digest, expectedDigest)) {
      throw new SyncProtocolError('INVALID_DIGEST', 'Sync command digest mismatch.')
    }
    return parsed as unknown as SyncCommandFrame
  }

  if (type === 'STATUS') {
    if (!hasExactKeys(parsed, [...commonKeys, 'digest']) || !hasExactKeys(parsed.payload as JsonObject, [])) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid STATUS frame fields.')
    }
    if (typeof parsed.digest !== 'string' || !DIGEST_PATTERN.test(parsed.digest)) {
      throw new SyncProtocolError('INVALID_DIGEST', 'Invalid status digest.')
    }
    return parsed as unknown as SyncStatusRequestFrame
  }

  if (type === 'PING') {
    if (!hasExactKeys(parsed, commonKeys) || !hasExactKeys(parsed.payload as JsonObject, [])) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid PING frame fields.')
    }
    return parsed as unknown as SyncPingFrame
  }

  throw new SyncProtocolError('INVALID_ENVELOPE', 'Unsupported sync frame type.')
}

export function createSyncServerFrame(input: {
  type: SyncServerFrameType
  requestId: string
  commandId: string
  sequence: number
  payload?: JsonObject
  digest?: string
}): SyncServerFrame {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > MAX_SYNC_SEQUENCE) {
    throw new SyncProtocolError('INVALID_SEQUENCE', 'Invalid sync server sequence.')
  }
  const payload = input.payload ?? {}
  return {
    version: SYNC_PROTOCOL_VERSION,
    channel: SYNC_CHANNEL,
    type: input.type,
    requestId: input.requestId,
    commandId: input.commandId,
    sequence: input.sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
    ...(input.digest ? { digest: input.digest } : {}),
  }
}
