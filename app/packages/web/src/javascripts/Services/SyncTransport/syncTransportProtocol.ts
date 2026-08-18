import type { AccountSyncCommandMetadata, AccountSyncTransportRequest } from '@standardnotes/services'

export const SYNC_PROTOCOL_VERSION = 1 as const
export const SYNC_CHANNEL = 'sync' as const
export const MAX_SYNC_FRAME_BYTES = 512 * 1024
export const MAX_SYNC_BUFFERED_BYTES = 256 * 1024

export type SyncTransportState =
  'HTTP_ONLY' | 'CONNECTING' | 'AUTHENTICATING' | 'READY' | 'DEGRADED' | 'HTTP_FALLBACK' | 'HALF_OPEN'

export type SyncCommandPayload = {
  command: 'SYNC_ITEMS'
  body: AccountSyncTransportRequest
}

export type SyncClientFrame = {
  version: typeof SYNC_PROTOCOL_VERSION
  channel: typeof SYNC_CHANNEL
  type: 'AUTH' | 'COMMAND' | 'STATUS' | 'PING'
  requestId: string
  commandId: string
  sequence: number
  payloadLength: number
  payload: Record<string, unknown>
  digest?: string
}

export type SyncServerFrame = {
  version: typeof SYNC_PROTOCOL_VERSION
  channel: typeof SYNC_CHANNEL
  type: 'AUTHENTICATED' | 'ACCEPTED' | 'COMMITTED' | 'STATUS' | 'ERROR' | 'PONG'
  requestId: string
  commandId: string
  sequence: number
  payloadLength: number
  payload: Record<string, unknown>
  digest?: string
}

export type SyncTicket = {
  endpoint: string
  ticket: string
  expiresAt: number
  deviceId: string
}

export type MainToSyncWorkerMessage =
  | {
      type: 'EXECUTE'
      clientRequestId: string
      body: AccountSyncTransportRequest
      sessionScope: string
    }
  | { type: 'RECOVER'; clientRequestId: string; sessionScope: string }
  | { type: 'CONNECT'; clientRequestId: string; sessionScope: string; authorization: SyncTicket }
  | { type: 'TICKET_UNAVAILABLE'; clientRequestId: string; reason: SyncFallbackReason }
  | { type: 'CHECKPOINT_DURABLE'; requestId: string; sessionScope: string; commandId: string }
  | { type: 'SESSION_REVOKED'; requestId: string; sessionScope: string }
  | { type: 'SHUTDOWN' }

export type SyncFallbackReason =
  | 'http-only'
  | 'unsupported-browser'
  | 'capability-unavailable'
  | 'ticket-unavailable'
  | 'ticket-expired'
  | 'auth-failed'
  | 'proxy-failed'
  | 'frame-too-large'
  | 'result-too-large'
  | 'ack-timeout'
  | 'server-kill'
  | 'reconnect-gap'
  | 'backpressure'
  | 'outbox-unavailable'
  | 'multi-tab-not-owner'
  | 'worker-error'

export type SyncWorkerToMainMessage =
  | { type: 'NEED_TICKET'; clientRequestId: string; reconnect: boolean }
  | {
      type: 'COMMAND_PERSISTED'
      clientRequestId: string
      body: AccountSyncTransportRequest
      command: AccountSyncCommandMetadata
    }
  | {
      type: 'HTTP_FALLBACK'
      clientRequestId: string
      reason: SyncFallbackReason
      body: AccountSyncTransportRequest
      command?: AccountSyncCommandMetadata
    }
  | { type: 'RESULT'; clientRequestId: string; commandId: string; result: unknown }
  | { type: 'RECOVERY_EMPTY'; clientRequestId: string }
  | { type: 'RECOVERY_REQUIRED'; clientRequestId: string }
  | { type: 'STATE'; state: SyncTransportState; reason?: SyncFallbackReason }
  | { type: 'CHECKPOINT_CLEARED'; requestId: string; sessionScope: string; commandId: string }
  | { type: 'CHECKPOINT_FAILED'; requestId: string; sessionScope: string; commandId: string }
  | { type: 'SESSION_REVOKED_ACK'; requestId: string; sessionScope: string }
  | { type: 'SESSION_REVOKED_FAILED'; requestId: string; sessionScope: string }

/**
 * Materializes the exact value that JSON HTTP serialization puts on the wire.
 * This must happen before hashing so values with JSON projections (for example
 * Date) cannot hash differently on websocket and HTTP replay paths.
 */
export function normalizeSyncRequestForWire(body: AccountSyncTransportRequest): AccountSyncTransportRequest {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(body)
  } catch {
    throw new Error('Sync request is not JSON serializable.')
  }
  if (serialized === undefined) {
    throw new Error('Sync request has no JSON wire representation.')
  }

  let normalized: unknown
  try {
    normalized = JSON.parse(serialized)
  } catch {
    throw new Error('Sync request has an invalid JSON wire representation.')
  }
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('Sync request must serialize to a JSON object.')
  }
  return normalized as AccountSyncTransportRequest
}

/**
 * Frozen v1 canonicalization shared with HTTP durable-command replay. Object
 * keys are recursively sorted, undefined object values are omitted, and arrays
 * retain order (undefined slots serialize as null).
 */
export function canonicalSyncJson(value: unknown): string {
  if (value === undefined) {
    return 'null'
  }
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSyncJson(entry)).join(',')}]`
  }
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(object[key])}`)
    .join(',')}}`
}

export async function digestSyncBody(
  body: AccountSyncTransportRequest,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', utf8Bytes(canonicalSyncJson(body)) as unknown as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function payloadByteLength(payload: Record<string, unknown>): number {
  return utf8Bytes(JSON.stringify(payload)).byteLength
}

export function frameByteLength(frame: SyncClientFrame): number {
  return utf8Bytes(JSON.stringify(frame)).byteLength
}

/** Small worker-safe UTF-8 encoder that does not depend on a DOM TextEncoder global. */
export function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00)
        index += 1
      }
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint)
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

export function isSyncServerFrame(value: unknown): value is SyncServerFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const frame = value as Partial<SyncServerFrame>
  if (
    frame.version !== SYNC_PROTOCOL_VERSION ||
    frame.channel !== SYNC_CHANNEL ||
    typeof frame.type !== 'string' ||
    typeof frame.requestId !== 'string' ||
    typeof frame.commandId !== 'string' ||
    !Number.isSafeInteger(frame.sequence) ||
    !Number.isSafeInteger(frame.payloadLength) ||
    !frame.payload ||
    typeof frame.payload !== 'object' ||
    Array.isArray(frame.payload)
  ) {
    return false
  }
  return payloadByteLength(frame.payload as Record<string, unknown>) === frame.payloadLength
}
