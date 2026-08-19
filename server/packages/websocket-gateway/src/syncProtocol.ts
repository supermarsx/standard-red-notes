import { createHash, timingSafeEqual } from 'node:crypto'
import {
  DEFAULT_FILE_TRANSFER_CREDIT_BYTES,
  DEFAULT_FILE_TRANSFER_DEADLINE_MS,
  MAX_FILE_METADATA_ENTRIES,
  MAX_FILE_TRANSFER_BYTES,
  MAX_FILE_TRANSFER_CREDIT_BYTES,
  MAX_FILE_TRANSFER_DEADLINE_MS,
  MIN_FILE_TRANSFER_DEADLINE_MS,
  isFileIdentifier,
  isFileMimeType,
  isFileResourceReference,
  isFileSha256,
  isFileTransferSize,
  type FileResourceReference,
} from './filesProtocol.js'

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
export const MAX_RPC_PATH_BYTES = 2_048
export const MAX_RPC_DEADLINE_MS = 120_000
export const MIN_RPC_DEADLINE_MS = 1_000
export const DEFAULT_RPC_DEADLINE_MS = 30_000
export const MAX_RPC_CREDIT_BYTES = 4 * 1024 * 1024
export const DEFAULT_RPC_CREDIT_BYTES = 256 * 1024
export const MAX_INVITE_CURSOR_BYTES = 2_048
export const MAX_INVITE_REPLAY_BATCH = 100

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u

export type SyncClientFrameType =
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
  | 'FILES_METADATA'
  | 'FILES_UPLOAD_OPEN'
  | 'FILES_UPLOAD_FINISH'
  | 'FILES_DOWNLOAD_OPEN'
  | 'FILES_CREDIT'
  | 'FILES_CANCEL'
export type SyncServerFrameType =
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

export type SyncNegotiatedOperation =
  'SYNC_ITEMS' | 'AUTHORIZE_COLLABORATION' | 'API_RPC' | 'STREAM_ASSISTANT' | 'INVITE_EVENTS' | 'FILES_V1'

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

export interface SyncCollaborationAuthorizationPayload extends JsonObject {
  noteUuid: string
  collaborationProtocolVersion: 2
  leaseRequestId?: string
  bootstrapChallenge?: string
}

export type SyncRpcMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface SyncRpcRequestPayload extends JsonObject {
  method: SyncRpcMethod
  /** Same-origin relative URL only. Absolute/protocol-relative URLs are invalid. */
  path: string
  body?: unknown
  headers?: JsonObject
  deadlineMs: number
  initialCreditBytes: number
  stream: boolean
  idempotencyKey?: string
}

export interface SyncRpcControlPayload extends JsonObject {
  targetRequestId: string
}

export interface SyncRpcCreditPayload extends SyncRpcControlPayload {
  creditBytes: number
}

export interface SyncInviteSubscribePayload extends JsonObject {
  cursor?: string
  limit: number
}

export interface SyncInviteAckPayload extends JsonObject {
  cursor: string
}

export interface SyncFilesMetadataPayload extends JsonObject {
  resources: FileResourceReference[]
  deadlineMs: number
}

export interface SyncFilesUploadOpenPayload extends JsonObject {
  resource: FileResourceReference
  decryptedSize: number
  declaredSize: number
  mimeType: string
  deadlineMs: number
  resumeId?: string
}

export interface SyncFilesTransferPayload extends JsonObject {
  transferId: string
  generation: number
}

export interface SyncFilesUploadFinishPayload extends SyncFilesTransferPayload {
  declaredSize: number
  sha256: string
  deadlineMs: number
}

export interface SyncFilesDownloadOpenPayload extends JsonObject {
  resource: FileResourceReference
  offset: number
  initialCreditBytes: number
  deadlineMs: number
  resumeId?: string
}

export interface SyncFilesCreditPayload extends SyncFilesTransferPayload {
  creditBytes: number
}

export type SyncAuthFrame = SyncFrameBase<'AUTH', SyncAuthPayload>
export type SyncCommandFrame = SyncFrameBase<'COMMAND', SyncCommandPayload> & { digest: string }
export type SyncStatusRequestFrame = SyncFrameBase<'STATUS', JsonObject> & { digest: string }
export type SyncPingFrame = SyncFrameBase<'PING', JsonObject>
export type SyncCollaborationAuthorizationFrame = SyncFrameBase<
  'COLLABORATION_AUTHORIZE',
  SyncCollaborationAuthorizationPayload
>
export type SyncRpcRequestFrame = SyncFrameBase<'RPC_REQUEST', SyncRpcRequestPayload>
export type SyncRpcCancelFrame = SyncFrameBase<'RPC_CANCEL', SyncRpcControlPayload>
export type SyncRpcCreditFrame = SyncFrameBase<'RPC_CREDIT', SyncRpcCreditPayload>
export type SyncInviteSubscribeFrame = SyncFrameBase<'INVITE_SUBSCRIBE', SyncInviteSubscribePayload>
export type SyncInviteAckFrame = SyncFrameBase<'INVITE_ACK', SyncInviteAckPayload>
export type SyncFilesMetadataFrame = SyncFrameBase<'FILES_METADATA', SyncFilesMetadataPayload>
export type SyncFilesUploadOpenFrame = SyncFrameBase<'FILES_UPLOAD_OPEN', SyncFilesUploadOpenPayload>
export type SyncFilesUploadFinishFrame = SyncFrameBase<'FILES_UPLOAD_FINISH', SyncFilesUploadFinishPayload>
export type SyncFilesDownloadOpenFrame = SyncFrameBase<'FILES_DOWNLOAD_OPEN', SyncFilesDownloadOpenPayload>
export type SyncFilesCreditFrame = SyncFrameBase<'FILES_CREDIT', SyncFilesCreditPayload>
export type SyncFilesCancelFrame = SyncFrameBase<'FILES_CANCEL', SyncFilesTransferPayload>
export type SyncClientFrame =
  | SyncAuthFrame
  | SyncCommandFrame
  | SyncStatusRequestFrame
  | SyncPingFrame
  | SyncCollaborationAuthorizationFrame
  | SyncRpcRequestFrame
  | SyncRpcCancelFrame
  | SyncRpcCreditFrame
  | SyncInviteSubscribeFrame
  | SyncInviteAckFrame
  | SyncFilesMetadataFrame
  | SyncFilesUploadOpenFrame
  | SyncFilesUploadFinishFrame
  | SyncFilesDownloadOpenFrame
  | SyncFilesCreditFrame
  | SyncFilesCancelFrame

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

function isRpcPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/v1/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('#') ||
    Buffer.byteLength(value, 'utf8') > MAX_RPC_PATH_BYTES
  ) {
    return false
  }
  try {
    const parsed = new URL(value, 'http://rpc.invalid')
    return parsed.origin === 'http://rpc.invalid' && `${parsed.pathname}${parsed.search}` === value
  } catch {
    return false
  }
}

const RPC_HEADER_NAMES = new Set([
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
  'x-shared-vault-owner-context',
])

function isRpcHeaders(value: unknown): value is JsonObject {
  if (!isJsonObject(value) || Object.keys(value).length > RPC_HEADER_NAMES.size) {
    return false
  }
  return Object.entries(value).every(
    ([name, headerValue]) =>
      RPC_HEADER_NAMES.has(name.toLowerCase()) &&
      name === name.toLowerCase() &&
      typeof headerValue === 'string' &&
      headerValue.length <= 1_024 &&
      !/[\r\n]/u.test(headerValue),
  )
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

  if (type === 'COLLABORATION_AUTHORIZE') {
    const payload = parsed.payload as JsonObject
    const leaseRequestId = payload.leaseRequestId
    const bootstrapChallenge = payload.bootstrapChallenge
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, [
        'noteUuid',
        'collaborationProtocolVersion',
        ...(Object.hasOwn(payload, 'leaseRequestId') ? ['leaseRequestId'] : []),
        ...(Object.hasOwn(payload, 'bootstrapChallenge') ? ['bootstrapChallenge'] : []),
      ]) ||
      typeof payload.noteUuid !== 'string' ||
      payload.noteUuid.length === 0 ||
      payload.noteUuid.length > 200 ||
      payload.collaborationProtocolVersion !== 2 ||
      (leaseRequestId !== undefined &&
        (typeof leaseRequestId !== 'string' || leaseRequestId.length === 0 || leaseRequestId.length > 128)) ||
      (bootstrapChallenge !== undefined &&
        (typeof bootstrapChallenge !== 'string' ||
          bootstrapChallenge.length === 0 ||
          bootstrapChallenge.length > 128)) ||
      (bootstrapChallenge !== undefined && leaseRequestId === undefined)
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid collaboration authorization frame.')
    }
    return parsed as unknown as SyncCollaborationAuthorizationFrame
  }

  if (type === 'RPC_REQUEST') {
    const payload = parsed.payload as JsonObject
    const optionalKeys = [
      ...(Object.hasOwn(payload, 'body') ? ['body'] : []),
      ...(Object.hasOwn(payload, 'headers') ? ['headers'] : []),
      ...(Object.hasOwn(payload, 'idempotencyKey') ? ['idempotencyKey'] : []),
    ]
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, ['method', 'path', 'deadlineMs', 'initialCreditBytes', 'stream', ...optionalKeys]) ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(payload.method)) ||
      !isRpcPath(payload.path) ||
      !Number.isSafeInteger(payload.deadlineMs) ||
      Number(payload.deadlineMs) < MIN_RPC_DEADLINE_MS ||
      Number(payload.deadlineMs) > MAX_RPC_DEADLINE_MS ||
      !Number.isSafeInteger(payload.initialCreditBytes) ||
      Number(payload.initialCreditBytes) <= 0 ||
      Number(payload.initialCreditBytes) > MAX_RPC_CREDIT_BYTES ||
      typeof payload.stream !== 'boolean' ||
      (payload.headers !== undefined && !isRpcHeaders(payload.headers)) ||
      (payload.idempotencyKey !== undefined && !isIdentifier(payload.idempotencyKey)) ||
      (payload.method === 'GET' && Object.hasOwn(payload, 'body'))
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid RPC request frame.')
    }
    return parsed as unknown as SyncRpcRequestFrame
  }

  if (type === 'RPC_CANCEL' || type === 'RPC_CREDIT') {
    const payload = parsed.payload as JsonObject
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, type === 'RPC_CANCEL' ? ['targetRequestId'] : ['targetRequestId', 'creditBytes']) ||
      !isIdentifier(payload.targetRequestId) ||
      (type === 'RPC_CREDIT' &&
        (!Number.isSafeInteger(payload.creditBytes) ||
          Number(payload.creditBytes) <= 0 ||
          Number(payload.creditBytes) > MAX_RPC_CREDIT_BYTES))
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', `Invalid ${type} frame.`)
    }
    return parsed as unknown as SyncRpcCancelFrame | SyncRpcCreditFrame
  }

  if (type === 'INVITE_SUBSCRIBE') {
    const payload = parsed.payload as JsonObject
    const optional = Object.hasOwn(payload, 'cursor') ? ['cursor'] : []
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, ['limit', ...optional]) ||
      !Number.isSafeInteger(payload.limit) ||
      Number(payload.limit) < 1 ||
      Number(payload.limit) > MAX_INVITE_REPLAY_BATCH ||
      (payload.cursor !== undefined && !isInviteCursor(payload.cursor))
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid invite subscription frame.')
    }
    return parsed as unknown as SyncInviteSubscribeFrame
  }

  if (type === 'INVITE_ACK') {
    const payload = parsed.payload as JsonObject
    if (!hasExactKeys(parsed, commonKeys) || !hasExactKeys(payload, ['cursor']) || !isInviteCursor(payload.cursor)) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid invite acknowledgement frame.')
    }
    return parsed as unknown as SyncInviteAckFrame
  }

  if (type === 'FILES_METADATA') {
    const payload = parsed.payload as JsonObject
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, ['resources', 'deadlineMs']) ||
      !Array.isArray(payload.resources) ||
      payload.resources.length < 1 ||
      payload.resources.length > MAX_FILE_METADATA_ENTRIES ||
      !payload.resources.every(isFileResourceReference) ||
      !isFileDeadline(payload.deadlineMs)
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid FILES metadata frame.')
    }
    return parsed as unknown as SyncFilesMetadataFrame
  }

  if (type === 'FILES_UPLOAD_OPEN') {
    const payload = parsed.payload as JsonObject
    const optional = Object.hasOwn(payload, 'resumeId') ? ['resumeId'] : []
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, ['resource', 'decryptedSize', 'declaredSize', 'mimeType', 'deadlineMs', ...optional]) ||
      !isFileResourceReference(payload.resource) ||
      !isFileTransferSize(payload.decryptedSize) ||
      !isFileTransferSize(payload.declaredSize) ||
      !isFileMimeType(payload.mimeType) ||
      !isFileDeadline(payload.deadlineMs) ||
      (payload.resumeId !== undefined && !isFileIdentifier(payload.resumeId))
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid FILES upload-open frame.')
    }
    return parsed as unknown as SyncFilesUploadOpenFrame
  }

  if (type === 'FILES_UPLOAD_FINISH') {
    const payload = parsed.payload as JsonObject
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, ['transferId', 'generation', 'declaredSize', 'sha256', 'deadlineMs']) ||
      !isFileTransferControl(payload) ||
      !isFileTransferSize(payload.declaredSize) ||
      !isFileSha256(payload.sha256) ||
      !isFileDeadline(payload.deadlineMs)
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid FILES upload-finish frame.')
    }
    return parsed as unknown as SyncFilesUploadFinishFrame
  }

  if (type === 'FILES_DOWNLOAD_OPEN') {
    const payload = parsed.payload as JsonObject
    const optional = Object.hasOwn(payload, 'resumeId') ? ['resumeId'] : []
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, ['resource', 'offset', 'initialCreditBytes', 'deadlineMs', ...optional]) ||
      !isFileResourceReference(payload.resource) ||
      !Number.isSafeInteger(payload.offset) ||
      Number(payload.offset) < 0 ||
      Number(payload.offset) > MAX_FILE_TRANSFER_BYTES ||
      !isFileCredit(payload.initialCreditBytes) ||
      !isFileDeadline(payload.deadlineMs) ||
      (payload.resumeId !== undefined && !isFileIdentifier(payload.resumeId))
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid FILES download-open frame.')
    }
    return parsed as unknown as SyncFilesDownloadOpenFrame
  }

  if (type === 'FILES_CREDIT' || type === 'FILES_CANCEL') {
    const payload = parsed.payload as JsonObject
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(
        payload,
        type === 'FILES_CREDIT' ? ['transferId', 'generation', 'creditBytes'] : ['transferId', 'generation'],
      ) ||
      !isFileTransferControl(payload) ||
      (type === 'FILES_CREDIT' && !isFileCredit(payload.creditBytes))
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', `Invalid ${type} frame.`)
    }
    return parsed as unknown as SyncFilesCreditFrame | SyncFilesCancelFrame
  }

  throw new SyncProtocolError('INVALID_ENVELOPE', 'Unsupported sync frame type.')
}

function isFileDeadline(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= MIN_FILE_TRANSFER_DEADLINE_MS &&
    Number(value) <= MAX_FILE_TRANSFER_DEADLINE_MS
  )
}

function isInviteCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_INVITE_CURSOR_BYTES
}

function isFileCredit(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_FILE_TRANSFER_CREDIT_BYTES
}

function isFileTransferControl(payload: JsonObject): boolean {
  return (
    isFileIdentifier(payload.transferId) && Number.isSafeInteger(payload.generation) && Number(payload.generation) > 0
  )
}

export const FILES_CONTROL_DEFAULTS = Object.freeze({
  deadlineMs: DEFAULT_FILE_TRANSFER_DEADLINE_MS,
  initialCreditBytes: DEFAULT_FILE_TRANSFER_CREDIT_BYTES,
})

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
