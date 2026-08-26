import type {
  AccountSyncCommandMetadata,
  AccountSyncTransportContext,
  AccountSyncTransportRequest,
  InviteRealtimeBatch,
} from '@standardnotes/services'

export const SYNC_PROTOCOL_VERSION = 1 as const
export const SYNC_CHANNEL = 'sync' as const
export const MAX_SYNC_FRAME_BYTES = 512 * 1024
export const MAX_SYNC_BUFFERED_BYTES = 256 * 1024
export const DEFAULT_RPC_DEADLINE_MS = 30_000
export const MIN_RPC_DEADLINE_MS = 1_000
export const MAX_RPC_DEADLINE_MS = 120_000
export const DEFAULT_RPC_CREDIT_BYTES = 256 * 1024
export const MAX_RPC_CREDIT_BYTES = 4 * 1024 * 1024

/**
 * FILES_V1 bounds. Every value here mirrors `websocket-gateway/src/filesProtocol.ts`
 * exactly and exists so the client can reject an oversized or out-of-range frame
 * without waiting for the server to. They are ceilings to respect, never budgets
 * to raise: the gateway enforces the same numbers and will close or error on a
 * client that exceeds them.
 */
export const FILES_PROTOCOL_VERSION = 1 as const
export const MAX_FILE_CHUNK_BYTES = 256 * 1024
export const MAX_FILE_BINARY_HEADER_BYTES = 4 * 1024
export const MAX_FILE_BINARY_FRAME_BYTES = MAX_FILE_CHUNK_BYTES + MAX_FILE_BINARY_HEADER_BYTES + 8
export const MAX_FILE_TRANSFER_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_FILE_TRANSFER_CREDIT_BYTES = 4 * 1024 * 1024
export const DEFAULT_FILE_TRANSFER_CREDIT_BYTES = 512 * 1024
export const MIN_FILE_TRANSFER_DEADLINE_MS = 1_000
export const MAX_FILE_TRANSFER_DEADLINE_MS = 120_000
export const DEFAULT_FILE_TRANSFER_DEADLINE_MS = 30_000

const FILE_BINARY_MAGIC = [0x53, 0x52, 0x4e, 0x46] as const
const FILE_BINARY_PREFIX_BYTES = 8
const FILE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const FILE_SHA256_PATTERN = /^[a-f0-9]{64}$/u

/**
 * The server's view of which stored object a transfer refers to.
 *
 * `remoteIdentifier` is the whole identity and must reach the wire byte-identical
 * to `FileContent['remoteIdentifier']`. It is not merely a lookup key: the same
 * string is the xchacha20 AAD in both the encryptor and the decryptor, so any
 * derivation, normalization or re-generation applied on the way out would break
 * decryption authentication rather than produce a clean not-found.
 */
export type SocketFileResourceReference =
  | {
      ownershipType: 'user'
      remoteIdentifier: string
      fileUuid: string
    }
  | {
      ownershipType: 'shared-vault'
      remoteIdentifier: string
      fileUuid: string
      sharedVaultUuid: string
      /**
       * Not a capability, and not the client asserting anything. The gateway
       * checks `sharedVaultUuid` against the authenticated session's own
       * membership list, and cross-checks this value against the claims of the
       * credential it mints itself — so a wrong or invented owner fails closed
       * rather than granting anything. It must still come from the vault listing
       * that genuinely records it, never from inference or a default.
       */
      sharedVaultOwnerUuid: string
    }

export type SocketFileBinaryHeader = {
  kind: 'UPLOAD_CHUNK' | 'DOWNLOAD_CHUNK'
  requestId: string
  transferId: string
  generation: number
  index: number
  offset: number
  declaredSize: number
  byteLength: number
  sha256: string
  final: boolean
}

export function isFileIdentifier(value: unknown): value is string {
  return typeof value === 'string' && FILE_IDENTIFIER_PATTERN.test(value)
}

export function isFileSha256(value: unknown): value is string {
  return typeof value === 'string' && FILE_SHA256_PATTERN.test(value)
}

export function isFileTransferSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_FILE_TRANSFER_BYTES
}

/**
 * Mirrors the gateway's `validateFileBinaryHeader`. The exact-key check matters:
 * an extra field would mean the peer is describing something this build does not
 * model, and silently ignoring it is how a transfer ends up applied under
 * assumptions the client never verified.
 */
export function isFileBinaryHeader(value: unknown, actualByteLength: number): value is SocketFileBinaryHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const expectedKeys = [
    'byteLength',
    'declaredSize',
    'final',
    'generation',
    'index',
    'kind',
    'offset',
    'requestId',
    'sha256',
    'transferId',
  ]
  const actualKeys = Object.keys(value).sort()
  const header = value as Partial<SocketFileBinaryHeader>
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    (header.kind === 'UPLOAD_CHUNK' || header.kind === 'DOWNLOAD_CHUNK') &&
    isFileIdentifier(header.requestId) &&
    isFileIdentifier(header.transferId) &&
    Number.isSafeInteger(header.generation) &&
    Number(header.generation) >= 1 &&
    Number.isSafeInteger(header.index) &&
    Number(header.index) >= 0 &&
    Number.isSafeInteger(header.offset) &&
    Number(header.offset) >= 0 &&
    isFileTransferSize(header.declaredSize) &&
    Number.isSafeInteger(header.byteLength) &&
    Number(header.byteLength) >= 1 &&
    Number(header.byteLength) <= MAX_FILE_CHUNK_BYTES &&
    Number(header.byteLength) === actualByteLength &&
    Number(header.offset) + Number(header.byteLength) <= Number(header.declaredSize) &&
    isFileSha256(header.sha256) &&
    typeof header.final === 'boolean' &&
    header.final === (Number(header.offset) + Number(header.byteLength) === Number(header.declaredSize))
  )
}

export type SocketFileBinaryFrame = { header: SocketFileBinaryHeader; bytes: Uint8Array }

export class FileBinaryFrameError extends Error {
  override readonly name = 'FileBinaryFrameError'

  constructor(readonly code: 'FILE_FRAME_TOO_LARGE' | 'FILE_FRAME_MALFORMED' | 'FILE_FRAME_UNSUPPORTED') {
    super(`File binary frame rejected: ${code}`)
  }
}

/**
 * Structural half of the gateway's `decodeFileBinaryFrame`. The payload digest is
 * verified separately by {@link fileBinaryPayloadMatchesDigest} because
 * SHA-256 in a browser worker is only available asynchronously — splitting the
 * two keeps this function usable from synchronous frame routing while making the
 * digest check impossible to skip, since the bytes are useless until it passes.
 */
export function decodeFileBinaryFrame(raw: Uint8Array): SocketFileBinaryFrame {
  if (raw.byteLength > MAX_FILE_BINARY_FRAME_BYTES) {
    throw new FileBinaryFrameError('FILE_FRAME_TOO_LARGE')
  }
  if (raw.byteLength < FILE_BINARY_PREFIX_BYTES) {
    throw new FileBinaryFrameError('FILE_FRAME_MALFORMED')
  }
  if (FILE_BINARY_MAGIC.some((byte, index) => raw[index] !== byte)) {
    throw new FileBinaryFrameError('FILE_FRAME_MALFORMED')
  }
  if (raw[4] !== FILES_PROTOCOL_VERSION) {
    throw new FileBinaryFrameError('FILE_FRAME_UNSUPPORTED')
  }
  const kindByte = raw[5]
  const headerLength = (raw[6] << 8) | raw[7]
  if (
    (kindByte !== 1 && kindByte !== 2) ||
    headerLength < 2 ||
    headerLength > MAX_FILE_BINARY_HEADER_BYTES ||
    FILE_BINARY_PREFIX_BYTES + headerLength > raw.byteLength
  ) {
    throw new FileBinaryFrameError('FILE_FRAME_MALFORMED')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Decode(raw.subarray(FILE_BINARY_PREFIX_BYTES, FILE_BINARY_PREFIX_BYTES + headerLength)))
  } catch {
    throw new FileBinaryFrameError('FILE_FRAME_MALFORMED')
  }
  const bytes = raw.subarray(FILE_BINARY_PREFIX_BYTES + headerLength)
  if (!isFileBinaryHeader(parsed, bytes.byteLength)) {
    throw new FileBinaryFrameError('FILE_FRAME_MALFORMED')
  }
  if (parsed.kind !== (kindByte === 1 ? 'UPLOAD_CHUNK' : 'DOWNLOAD_CHUNK')) {
    throw new FileBinaryFrameError('FILE_FRAME_MALFORMED')
  }
  return { header: parsed, bytes }
}

/** Digest half of frame decoding; see {@link decodeFileBinaryFrame}. */
export async function fileBinaryPayloadMatchesDigest(
  frame: SocketFileBinaryFrame,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<boolean> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', frame.bytes as unknown as BufferSource))
  if (digest.byteLength !== 32) {
    return false
  }
  let difference = 0
  for (let index = 0; index < 32; index++) {
    difference |= digest[index] ^ Number.parseInt(frame.header.sha256.slice(index * 2, index * 2 + 2), 16)
  }
  return difference === 0
}

/** Hex digest of one chunk payload, for a binary frame header. */
export async function fileBinaryPayloadDigest(
  bytes: Uint8Array,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as unknown as BufferSource))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Inverse of {@link decodeFileBinaryFrame}, byte-for-byte identical to the
 * gateway's `encodeFileBinaryFrame`: 4-byte `SRNF` magic, version, kind, a
 * big-endian uint16 header length, the JSON header, then the payload.
 *
 * Validates before emitting rather than after. A frame the gateway would reject
 * costs a round trip and, on an upload, leaves the transfer in a state the client
 * then has to resolve — so anything checkable locally is checked locally.
 */
export function encodeFileBinaryFrame(header: SocketFileBinaryHeader, bytes: Uint8Array): Uint8Array {
  if (!isFileBinaryHeader(header, bytes.byteLength)) {
    throw new FileBinaryFrameError('FILE_FRAME_MALFORMED')
  }
  const headerBytes = utf8Bytes(JSON.stringify(header))
  if (headerBytes.byteLength > MAX_FILE_BINARY_HEADER_BYTES) {
    throw new FileBinaryFrameError('FILE_FRAME_TOO_LARGE')
  }
  const frame = new Uint8Array(FILE_BINARY_PREFIX_BYTES + headerBytes.byteLength + bytes.byteLength)
  frame.set(FILE_BINARY_MAGIC, 0)
  frame[4] = FILES_PROTOCOL_VERSION
  frame[5] = header.kind === 'UPLOAD_CHUNK' ? 1 : 2
  frame[6] = (headerBytes.byteLength >> 8) & 0xff
  frame[7] = headerBytes.byteLength & 0xff
  frame.set(headerBytes, FILE_BINARY_PREFIX_BYTES)
  frame.set(bytes, FILE_BINARY_PREFIX_BYTES + headerBytes.byteLength)
  if (frame.byteLength > MAX_FILE_BINARY_FRAME_BYTES) {
    throw new FileBinaryFrameError('FILE_FRAME_TOO_LARGE')
  }
  return frame
}

/**
 * Must stay a superset of every operation the gateway can advertise
 * (`websocket-gateway/src/syncProtocol.ts`). The worker rejects an
 * `AUTHENTICATED` frame carrying an operation outside this set, so an operation
 * missing here does not merely disable its own lane — it fails the handshake and
 * drops the whole socket, sync included, to HTTP.
 */
export type SyncNegotiatedOperation =
  'SYNC_ITEMS' | 'AUTHORIZE_COLLABORATION' | 'API_RPC' | 'STREAM_ASSISTANT' | 'INVITE_EVENTS' | 'FILES_V1'

export type SyncTransportState =
  'HTTP_ONLY' | 'CONNECTING' | 'AUTHENTICATING' | 'READY' | 'DEGRADED' | 'HTTP_FALLBACK' | 'HALF_OPEN'

export type SyncCommandPayload = {
  command: 'SYNC_ITEMS'
  body: AccountSyncTransportRequest
}

export type CollaborationAuthorizationTransportRequest = {
  noteUuid: string
  collaborationProtocolVersion: 3
  leaseRequestId?: string
  bootstrapChallenge?: string
  /**
   * Pins the request to a room epoch the caller already holds. When set, the worker
   * aborts with COLLABORATION_DENIED if discovery reports a different epoch, rather
   * than proceeding to the grant leg. Absent, the worker adopts whatever epoch it
   * discovers.
   */
  expectedRoomEpoch?: string
}

export type CollaborationAuthorizationTransportResult = {
  epochDiscovery: false
  capability: string
  room: string
  expiresIn: number
  serverUpdatedAtTimestamp: number
  collaborationProtocolVersion: 3
  roomEpoch: string
  collaborationSecurityEpoch: string
  leaseRequestId?: string
  bootstrapChallenge?: string
}

export type AuthenticatedRpcMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type AuthenticatedRpcRequest = {
  method: AuthenticatedRpcMethod
  /** Same-origin relative `/v1/` path; absolute targets are rejected. */
  path: string
  headers?: Record<string, string>
  body?: unknown
  idempotencyKey?: string
  deadlineMs?: number
  initialCreditBytes?: number
  stream?: boolean
}

export type WorkerAuthenticatedRpcRequest = Omit<
  AuthenticatedRpcRequest,
  'deadlineMs' | 'initialCreditBytes' | 'stream'
> & {
  deadlineMs: number
  initialCreditBytes: number
  stream: boolean
}

/**
 * A download the worker may open on the socket.
 *
 * `declaredSize` is the client's own authenticated total (the sum of
 * `encryptedChunkSizes` from the decrypted file item), not something learned from
 * the server. The worker requires the server's accepted `declaredSize` to equal
 * it, so a server that reports a different length is refused rather than
 * followed — the file metadata the user's key authenticated is the authority on
 * how many bytes this file has.
 */
export type WorkerFileDownloadRequest = {
  resource: SocketFileResourceReference
  declaredSize: number
  initialCreditBytes: number
  deadlineMs: number
}

/**
 * Mirrors the gateway's `isFileResourceReference`. The exact-key counts matter as
 * much as the field checks: a `user` reference carrying shared-vault fields, or a
 * shared-vault reference missing them, is rejected here rather than sent for the
 * server to refuse.
 */
export function isSocketFileResourceReference(value: unknown): value is SocketFileResourceReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const resource = value as Partial<
    Omit<Extract<SocketFileResourceReference, { ownershipType: 'shared-vault' }>, 'ownershipType'>
  > & { ownershipType?: unknown }
  if (!isFileIdentifier(resource.remoteIdentifier) || !isFileIdentifier(resource.fileUuid)) {
    return false
  }
  if (resource.ownershipType === 'user') {
    return Object.keys(resource).length === 3
  }
  return (
    resource.ownershipType === 'shared-vault' &&
    Object.keys(resource).length === 5 &&
    isFileIdentifier(resource.sharedVaultUuid) &&
    isFileIdentifier(resource.sharedVaultOwnerUuid)
  )
}

export function isWorkerFileDownloadRequest(value: unknown): value is WorkerFileDownloadRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const request = value as Partial<WorkerFileDownloadRequest>
  return (
    isSocketFileResourceReference(request.resource) &&
    isFileTransferSize(request.declaredSize) &&
    Number.isSafeInteger(request.initialCreditBytes) &&
    Number(request.initialCreditBytes) > 0 &&
    Number(request.initialCreditBytes) <= MAX_FILE_TRANSFER_CREDIT_BYTES &&
    Number.isSafeInteger(request.deadlineMs) &&
    Number(request.deadlineMs) >= MIN_FILE_TRANSFER_DEADLINE_MS &&
    Number(request.deadlineMs) <= MAX_FILE_TRANSFER_DEADLINE_MS
  )
}

export type SyncClientFrame = {
  version: typeof SYNC_PROTOCOL_VERSION
  channel: typeof SYNC_CHANNEL
  type:
    | 'AUTH'
    | 'COMMAND'
    | 'STATUS'
    | 'PING'
    | 'COLLABORATION_AUTHORIZE'
    | 'RPC_REQUEST'
    | 'RPC_CANCEL'
    | 'RPC_CREDIT'
    | 'INVITE_SUBSCRIBE'
    | 'INVITE_ACK'
    | 'FILES_DOWNLOAD_OPEN'
    | 'FILES_CREDIT'
    | 'FILES_CANCEL'
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
  type:
    | 'AUTHENTICATED'
    | 'ACCEPTED'
    | 'COMMITTED'
    | 'STATUS'
    | 'ERROR'
    | 'PONG'
    | 'COLLABORATION_AUTHORIZED'
    | 'RPC_ACCEPTED'
    | 'RPC_RESPONSE'
    | 'RPC_CHUNK'
    | 'RPC_END'
    | 'INVITE_READY'
    | 'INVITE_BATCH'
    | 'INVITE_RECONCILE'
    | 'FILES_METADATA'
    | 'FILES_ACCEPTED'
    | 'FILES_CHUNK_ACK'
    | 'FILES_COMPLETE'
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
      context?: AccountSyncTransportContext
    }
  | { type: 'RECOVER'; clientRequestId: string; sessionScope: string }
  | {
      type: 'AUTHORIZE_COLLABORATION'
      clientRequestId: string
      sessionScope: string
      request: CollaborationAuthorizationTransportRequest
    }
  | {
      type: 'OPEN_RPC'
      clientRequestId: string
      sessionScope: string
      request: WorkerAuthenticatedRpcRequest
    }
  | { type: 'CANCEL_RPC'; clientRequestId: string }
  | { type: 'RPC_CREDIT'; clientRequestId: string; creditBytes: number }
  | {
      type: 'SUBSCRIBE_INVITE_EVENTS'
      clientRequestId: string
      sessionScope: string
      cursor?: string
      limit: number
    }
  | { type: 'ACK_INVITE_EVENTS'; clientRequestId: string; cursor: string }
  | { type: 'UNSUBSCRIBE_INVITE_EVENTS'; clientRequestId: string }
  | {
      type: 'OPEN_FILE_DOWNLOAD'
      clientRequestId: string
      sessionScope: string
      request: WorkerFileDownloadRequest
    }
  | { type: 'FILE_DOWNLOAD_CREDIT'; clientRequestId: string; creditBytes: number }
  | { type: 'CANCEL_FILE_DOWNLOAD'; clientRequestId: string }
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
  | 'operation-unavailable'

/**
 * Reasons that describe a structural absence rather than a transient fault: this deployment
 * does not advertise the websocket sync capability at all, or this client is configured or
 * built never to use it. Retrying on a timer cannot make any of them succeed, so long-lived
 * consumers must stand down and wait for a lifecycle event (relaunch, sign-in) instead of
 * reconnecting forever.
 */
const PERMANENT_SYNC_FALLBACK_REASONS = new Set<SyncFallbackReason>([
  'http-only',
  'unsupported-browser',
  'capability-unavailable',
])

export function isPermanentSyncFallbackReason(reason: SyncFallbackReason): boolean {
  return PERMANENT_SYNC_FALLBACK_REASONS.has(reason)
}

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
  | {
      type: 'COLLABORATION_RESULT'
      clientRequestId: string
      result?: CollaborationAuthorizationTransportResult
    }
  | { type: 'COLLABORATION_DENIED'; clientRequestId: string }
  | { type: 'COLLABORATION_FALLBACK'; clientRequestId: string; reason: SyncFallbackReason }
  | { type: 'RPC_ACCEPTED'; clientRequestId: string }
  | {
      type: 'RPC_RESPONSE'
      clientRequestId: string
      status: number
      headers: Record<string, string>
      body?: unknown
      stream: boolean
    }
  | { type: 'RPC_CHUNK'; clientRequestId: string; bytes: string; byteLength: number }
  | { type: 'RPC_END'; clientRequestId: string }
  | {
      type: 'RPC_ERROR'
      clientRequestId: string
      code: string
      retryable: boolean
      /** HTTP fallback is allowed only before a request is written to the socket. */
      safeToFallback: boolean
    }
  | { type: 'INVITE_READY'; clientRequestId: string; cursor: string }
  | { type: 'INVITE_BATCH'; clientRequestId: string; batch: InviteRealtimeBatch }
  | {
      type: 'INVITE_RECONCILE'
      clientRequestId: string
      reason: 'BOOTSTRAP_REQUIRED' | 'CURSOR_EXPIRED' | 'CURSOR_INVALID'
      cursor: string
    }
  | { type: 'INVITE_ERROR'; clientRequestId: string; code: string; retryable: boolean }
  | { type: 'FILE_DOWNLOAD_ACCEPTED'; clientRequestId: string; declaredSize: number }
  | { type: 'FILE_DOWNLOAD_CHUNK'; clientRequestId: string; bytes: Uint8Array; offset: number }
  | { type: 'FILE_DOWNLOAD_COMPLETE'; clientRequestId: string; sha256: string; declaredSize: number }
  | {
      type: 'FILE_DOWNLOAD_ERROR'
      clientRequestId: string
      code: string
      retryable: boolean
      /**
       * True only while no chunk has been forwarded to the main thread. Downloads
       * have no server-side effect, so this is not about the server: once a chunk
       * has crossed to the main thread it may already have been fed to the
       * stateful file decryptor, and restarting the same file over HTTP from byte
       * zero would double-feed it. The worker cannot observe main-thread
       * consumption, so "forwarded" is the conservative stand-in for "consumed".
       */
      safeToFallback: boolean
    }
  | {
      type: 'NEGOTIATED'
      sessionScope: string
      protocolVersion: typeof SYNC_PROTOCOL_VERSION
      endpoint: string
      operations: SyncNegotiatedOperation[]
    }
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

/** Worker-safe UTF-8 decoder, paired with {@link utf8Bytes}; rejects malformed sequences. */
export function utf8Decode(bytes: Uint8Array): string {
  let result = ''
  for (let index = 0; index < bytes.byteLength;) {
    const first = bytes[index]
    let codePoint: number
    let width: number
    if (first <= 0x7f) {
      codePoint = first
      width = 1
    } else if ((first & 0xe0) === 0xc0) {
      codePoint = first & 0x1f
      width = 2
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = first & 0x0f
      width = 3
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = first & 0x07
      width = 4
    } else {
      throw new Error('Invalid UTF-8 sequence.')
    }
    if (index + width > bytes.byteLength) {
      throw new Error('Truncated UTF-8 sequence.')
    }
    for (let offset = 1; offset < width; offset++) {
      const continuation = bytes[index + offset]
      if ((continuation & 0xc0) !== 0x80) {
        throw new Error('Invalid UTF-8 continuation byte.')
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f)
    }
    if (codePoint > 0x10ffff) {
      throw new Error('UTF-8 code point out of range.')
    }
    result += String.fromCodePoint(codePoint)
    index += width
  }
  return result
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
