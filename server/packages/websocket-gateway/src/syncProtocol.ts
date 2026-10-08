import { createHash, timingSafeEqual } from 'node:crypto'
import {
  DEFAULT_FILE_TRANSFER_CREDIT_BYTES,
  DEFAULT_FILE_TRANSFER_DEADLINE_MS,
  MAX_FILE_BINARY_FRAME_BYTES,
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
/**
 * How much one sync socket may have waiting to be written before the gateway
 * treats the peer as not consuming. See `SyncCommandHandler`'s
 * `maxEgressBufferedBytes` for the three ways the old 256 KiB figure broke the
 * FILES_V1 binary plane that shares this socket; in short, it is smaller than a
 * single download frame, so a working transfer tripped the slow-consumer guard.
 *
 * The number is the largest credit a client may grant
 * (`MAX_FILE_TRANSFER_CREDIT_BYTES`) plus one whole frame — exactly the
 * buffering the download protocol already authorises, so the guard cannot fire
 * on a transfer the gateway itself agreed to, and no more than that.
 */
export const MAX_SYNC_EGRESS_BUFFERED_BYTES = MAX_FILE_TRANSFER_CREDIT_BYTES + MAX_FILE_BINARY_FRAME_BYTES
export const MAX_SYNC_QUEUED_FRAMES = 8
/**
 * The JSON command plane's ingress-queue budget: the frame depth the queue
 * advertises, at this plane's own per-frame ceiling.
 *
 * WHY NOT ONE FRAME. This was `MAX_SYNC_FRAME_BYTES` — exactly ONE maximum frame
 * — while `MAX_SYNC_QUEUED_FRAMES` advertised eight. A ceiling equal to one frame
 * means one frame of concurrency, so the advertised depth was a fiction here for
 * the same arithmetic reason it was on the binary plane, and overrunning it did
 * not pause the socket, it closed it 1013.
 *
 * HOW LONG THE WINDOW IS. `queuedBytes` is released only once a frame is FULLY
 * processed, and `process` awaits `handleCommand`, which awaits TWO
 * `authorizeCommand` calls, the durable `backend.execute` and the lease release —
 * bounded only by {@link SYNC_BACKEND_TIMEOUT_MS} (15 s). Measured live on a
 * single container, an ordinary `SYNC_ITEMS` COMMAND took 47 ms from write to
 * COMMITTED. For every millisecond of that, a 400 KB command held 409,902 of the
 * 524,288 bytes, so any further frame above 114,386 bytes was refused — and the
 * refusal is `failAndClose`, not a wait, so one more ordinary frame took EVERY
 * lane on the socket down (SYNC_ITEMS, API_RPC, collaboration, invites, files,
 * status) on a healthy connection. Each frame was individually legal (under
 * `MAX_SYNC_FRAME_BYTES`, so `ws` and the frame check passed it) and the pair was
 * nowhere near this plane's token bucket, so nothing else objected.
 *
 * WHERE THAT WINDOW IS ACTUALLY OPEN, measured rather than assumed. The refusal is
 * proven at this layer: `syncCommandHandler.test.ts` ->
 * 'admits two ordinary command frames whose combined size exceeds one frame'
 * closes 1013 without this widening. It could NOT be reproduced live on a SINGLE
 * container: a 400 KB COMMAND followed by a 153,904-byte one at gaps of 0, 1, 2,
 * 5, 10 and 20 ms inside that 47 ms window survived every time, because the
 * gateway did not READ the second frame until the first was released (admission is
 * synchronous, so a read would have closed the socket at once and never did). The
 * difference from the binary plane, where the overlap WAS reproduced live, is that
 * a file chunk's `fs` write is real I/O and a DirectCall backend over synchronous
 * better-sqlite3 is not: an await that resolves through microtasks alone never
 * returns libuv to the poll phase, so no socket read is delivered. On compose the
 * same await is a real gRPC round trip, which does reach the poll phase — so the
 * window is expected to be open there. That last step is an inference from the
 * three measurements above, not a measurement of compose itself.
 *
 * WHAT STILL PROTECTS THIS PLANE at the new figure, in the order a client meets
 * them: the per-frame ceiling `MAX_SYNC_FRAME_BYTES` is unchanged, and `ws`'s
 * `maxPayload` above it; then the plane's own token bucket,
 * `DEFAULT_SYNC_WEBSOCKET_INGRESS_LIMITS` — 2 MiB of burst and 512 KiB/s
 * sustained, with 32 frames / 16 per second. That bucket is now the BINDING
 * protection against bulk JSON, because 2 MiB of burst is less than this
 * allowance: a client cannot fill the queue by volume before the bucket refuses
 * it, and a bucket refusal is the better-named outcome (metric
 * `rate_limit/ingress`, close 1008 naming the plane) than a queue kill. What
 * remains is a hard bound on UN-PROCESSED ingress a socket can make the gateway
 * retain, and the FRAME count is what binds it — which is what the queue says.
 * Overrunning it still ends in `backpressure/ingress` and 1013 'Sync command
 * queue is full.', naming this plane and no other.
 */
export const MAX_SYNC_QUEUED_BYTES = MAX_SYNC_QUEUED_FRAMES * MAX_SYNC_FRAME_BYTES
/**
 * The FILES_V1 BINARY plane's own ingress-queue budget, kept separate from the
 * JSON command plane's {@link MAX_SYNC_QUEUED_BYTES} above.
 *
 * WHY THIS EXISTS. The ingress queue admits `MAX_SYNC_QUEUED_FRAMES` frames,
 * but every frame of either plane used to be charged against one 512 KiB
 * allowance -- `MAX_SYNC_QUEUED_BYTES` as it then was, a single
 * `MAX_SYNC_FRAME_BYTES`, i.e. the largest single JSON frame. (That plane's own
 * allowance has since been widened the same way; see it above.)
 * A binary frame is `MAX_FILE_BINARY_FRAME_BYTES` (266,248 bytes), so TWO of
 * them are 532,496 and the second one was refused: `failAndClose('BACKPRESSURE',
 * 'File transfer queue is full.', 1013)`. The 8-frame allowance was therefore
 * unreachable on the binary plane -- the real figure was ONE -- and exceeding
 * it closed the socket rather than pausing it.
 *
 * Measured on a single container built from `main`, uploading 4,194,304 bytes
 * (16 frames) over `/sockets/sync`: with one frame outstanding at a time every
 * run completed (3.47 MB/s on loopback); with TWO outstanding the socket closed
 * `1013 File transfer queue is full.` after exactly two frames, every run. The
 * shipped browser client reaches this on its own pacing policy --
 * `sendBinaryWithBackpressure` waits only while `bufferedAmount` exceeds its own
 * 256 KiB figure, which a flushed send buffer clears long before the gateway has
 * processed the frame -- and that probe closed 3/3.
 *
 * WHAT THE NUMBER MEANS. Exactly the 8 frames the queue already advertises, at
 * the binary plane's own frame size, so the FRAME count is the binding
 * constraint on this plane instead of an invisible byte wall. It is still a hard
 * per-socket bound on un-processed ingress (~2.03 MiB), and the per-FRAME
 * ceilings are untouched: `MAX_SYNC_FRAME_BYTES` for JSON,
 * `MAX_FILE_BINARY_FRAME_BYTES` for binary, `MAX_WEBSOCKET_MESSAGE_BYTES` in
 * `ws` itself. The rate at which bytes may arrive remains
 * `DEFAULT_SYNC_WEBSOCKET_FILE_INGRESS_LIMITS`, which this does not touch.
 *
 * The two planes are counted SEPARATELY rather than sharing one larger
 * allowance. Sharing one was the other half of the same defect: a JSON command
 * frame arriving while a binary frame was still queued was charged the binary
 * frame's bytes, so an ordinary sync command sent during a file transfer could
 * close the socket 1013 on its own. Separate counters leave the JSON plane's
 * admission byte-identical to what it always was.
 */
export const MAX_SYNC_QUEUED_BINARY_BYTES = MAX_SYNC_QUEUED_FRAMES * MAX_FILE_BINARY_FRAME_BYTES
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
  | 'REAUTH'
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
  | 'REAUTHENTICATED'
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

/**
 * Marks a COMMITTED result the socket cannot carry. When a COMMITTED frame or a
 * STATUS answer with `status: 'COMMITTED'` would exceed MAX_SYNC_FRAME_BYTES,
 * the gateway sends a STATUS frame `{ status: 'COMMITTED', code: 'RESULT_TOO_LARGE' }`
 * with NO `result` (same requestId/commandId/digest) and the client fetches the
 * journaled result over HTTP by command id/digest. `ERROR RESULT_TOO_LARGE`
 * remains the answer for oversized INGRESS only.
 */
export const SYNC_RESULT_TOO_LARGE_STATUS_CODE = 'RESULT_TOO_LARGE' as const

/** Payload of a COMMITTED frame and of every STATUS answer. */
export interface SyncCommandResultPayload extends JsonObject {
  status: 'UNKNOWN' | 'ACCEPTED' | 'COMMITTED' | 'ERROR'
  result?: JsonObject
  /** Backend code for `status: 'ERROR'`, or RESULT_TOO_LARGE on a payload-less COMMITTED answer. */
  code?: string
}

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

/**
 * Standard Red Notes: in-place session-credential refresh.
 *
 * A socket authenticates once and then replays the credential captured at ticket
 * mint for its whole life, so a token rotation strands every lane that
 * revalidates (sync, collaboration, API_RPC, files) while HTTP keeps working.
 * REAUTH lets a LIVE socket present a current credential without being torn
 * down and without changing the worker's session-stable scope key.
 *
 * The payload is deliberately identical to AUTH minus `resumeSequence`: an
 * OPAQUE one-use ticket and the device it was minted for. The credential itself
 * is NOT in this frame and must never be — it is captured server-side from a
 * real authenticated request at `POST /v1/sockets/sync/ticket` and read back out
 * of the gateway's own ticket store, so a client cannot choose, forge or widen
 * what the socket will replay. `resumeSequence` is absent because resuming is an
 * admission concern; a REAUTH is an ordinary mid-stream frame and keeps the
 * sequence it was sent with.
 */
export interface SyncReauthPayload extends JsonObject {
  ticket: string
  deviceId: string
}

export interface SyncCommandPayload extends JsonObject {
  command: 'SYNC_ITEMS'
  body: JsonObject
}

export type SyncCollaborationAuthorizationPayload = JsonObject &
  (
    | {
        noteUuid: string
        collaborationProtocolVersion: 3
        epochDiscovery: true
      }
    | {
        noteUuid: string
        collaborationProtocolVersion: 3
        expectedRoomEpoch: string
        epochDiscoveryChallenge: string
        epochDiscoveryRequestId: string
        leaseRequestId?: string
        bootstrapChallenge?: string
      }
  )

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
export type SyncReauthFrame = SyncFrameBase<'REAUTH', SyncReauthPayload>
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
  | SyncReauthFrame
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

/**
 * Codes an RPC adapter may ask the gateway to report instead of `BACKEND_ERROR`,
 * for the cases where the adapter DECIDED to refuse rather than failed to answer.
 *
 * Closed on purpose, and deliberately not a free string: a refusal code is public
 * — it reaches the client in an ERROR frame — so it names a policy, never the
 * request that tripped it. `RPC_PATH_FORBIDDEN` says "this lane does not carry
 * that route"; it must never carry the route, which comes off a client frame.
 *
 * `RPC_PATH_FORBIDDEN` exists because the adapter's own route block-list used to
 * surface as `BACKEND_ERROR`, which is what a dead backend reports. One code for
 * "we will not do that" and "the service is broken" sent a live diagnosis in the
 * wrong direction: an operator probing a blocked route read it as an outage.
 */
export type SyncApiRpcRefusalCode = 'RPC_PATH_FORBIDDEN'

export const SYNC_API_RPC_REFUSAL_ERROR_NAME = 'SyncApiRpcRefusalError'

export const SYNC_API_RPC_REFUSAL_CODES: ReadonlySet<string> = new Set<SyncApiRpcRefusalCode>(['RPC_PATH_FORBIDDEN'])

/**
 * Thrown by an RPC adapter to refuse a request as a matter of policy.
 *
 * The gateway recognizes it by `name` rather than `instanceof`, exactly as the
 * files lane recognizes its adapter errors: the adapters live in other packages
 * and may be bundled with their own copy of this module, where `instanceof` would
 * silently fail and collapse the refusal back onto `BACKEND_ERROR`.
 *
 * The constructor takes the code and nothing else, so there is no parameter
 * through which a request path could reach the wire or a log line.
 */
export class SyncApiRpcRefusalError extends Error {
  constructor(readonly code: SyncApiRpcRefusalCode) {
    super(code)
    this.name = SYNC_API_RPC_REFUSAL_ERROR_NAME
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

  if (type === 'REAUTH') {
    if (!hasExactKeys(parsed, commonKeys) || !hasExactKeys(parsed.payload as JsonObject, ['ticket', 'deviceId'])) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid REAUTH frame fields.')
    }
    const payload = parsed.payload as JsonObject
    if (
      typeof payload.ticket !== 'string' ||
      payload.ticket.length < 32 ||
      payload.ticket.length > 256 ||
      !isSyncDeviceId(payload.deviceId) ||
      // AUTH is pinned to sequence 0; a REAUTH is a mid-stream frame and can
      // never be the first one, so sequence 0 is refused here rather than being
      // left for the handler. The two frames are then structurally distinct and
      // a REAUTH cannot stand in for admission.
      Number(parsed.sequence) < 1
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', 'Invalid REAUTH payload.')
    }
    return parsed as unknown as SyncReauthFrame
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
    const expectedRoomEpoch = payload.expectedRoomEpoch
    const epochDiscoveryChallenge = payload.epochDiscoveryChallenge
    const epochDiscoveryRequestId = payload.epochDiscoveryRequestId
    const epochDiscovery = payload.epochDiscovery
    const discoveryKeys = ['noteUuid', 'collaborationProtocolVersion', 'epochDiscovery']
    const grantKeys = [
      'noteUuid',
      'collaborationProtocolVersion',
      'expectedRoomEpoch',
      'epochDiscoveryChallenge',
      'epochDiscoveryRequestId',
      ...(Object.hasOwn(payload, 'leaseRequestId') ? ['leaseRequestId'] : []),
      ...(Object.hasOwn(payload, 'bootstrapChallenge') ? ['bootstrapChallenge'] : []),
    ]
    if (
      !hasExactKeys(parsed, commonKeys) ||
      !hasExactKeys(payload, epochDiscovery === true ? discoveryKeys : grantKeys) ||
      typeof payload.noteUuid !== 'string' ||
      payload.noteUuid.length === 0 ||
      payload.noteUuid.length > 200 ||
      payload.collaborationProtocolVersion !== 3 ||
      (epochDiscovery !== true &&
        (!isValidCollaborationEpoch(expectedRoomEpoch) ||
          !isIdentifier(epochDiscoveryChallenge) ||
          !isIdentifier(epochDiscoveryRequestId) ||
          (leaseRequestId !== undefined && !isIdentifier(leaseRequestId)) ||
          (bootstrapChallenge !== undefined && !isIdentifier(bootstrapChallenge)) ||
          (bootstrapChallenge !== undefined && leaseRequestId === undefined)))
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

function isValidCollaborationEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value)
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
