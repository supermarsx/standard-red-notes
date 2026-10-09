import {
  isInviteRealtimeBatch,
  isOpaqueCursor,
  type AccountSyncCommandMetadata,
  type AccountSyncTransportContext,
  type AccountSyncTransportRequest,
} from '@standardnotes/services'
import {
  CollaborationAuthorizationTransportRequest,
  CollaborationAuthorizationTransportResult,
  decodeFileBinaryFrame,
  DEFAULT_RPC_CREDIT_BYTES,
  digestSyncBody,
  encodeFileBinaryFrame,
  fileBinaryPayloadDigest,
  fileBinaryPayloadMatchesDigest,
  isFileIdentifier,
  isFileSha256,
  isSyncIdentifier,
  isWorkerFileDownloadRequest,
  isWorkerFileUploadRequest,
  MAX_FILE_BINARY_FRAME_BYTES,
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_TRANSFER_CREDIT_BYTES,
  SocketFileBinaryFrame,
  WorkerFileDownloadRequest,
  WorkerFileUploadRequest,
  frameByteLength,
  isSyncServerFrame,
  MainToSyncWorkerMessage,
  MAX_SYNC_BUFFERED_BYTES,
  MAX_SYNC_FRAME_BYTES,
  MAX_RPC_CREDIT_BYTES,
  normalizeSyncRequestForWire,
  payloadByteLength,
  SYNC_CHANNEL,
  SYNC_PROTOCOL_VERSION,
  SyncClientFrame,
  SyncFallbackReason,
  isPermanentSyncFallbackReason,
  syncCloseFallbackReason,
  syncFallbackDisposition,
  SyncServerFrame,
  SyncNegotiatedOperation,
  SyncTicket,
  SyncTransportState,
  SyncWorkerToMainMessage,
  WorkerAuthenticatedRpcRequest,
  utf8Bytes,
} from './syncTransportProtocol'
import {
  IndexedDbSyncOutbox,
  isSyncOutboxUnavailable,
  OWNER_LEASE_TTL_MS,
  SyncOutboxRecord,
  SyncOutboxStore,
} from './SyncTransportOutbox'

/**
 * The gateway's own budget for authenticating a fresh socket
 * (`wg/syncProtocol.ts` SYNC_AUTH_DEADLINE_MS). Mirrored, not imported, exactly
 * as SYNC_BACKEND_TIMEOUT_MS below is: the worker bundle takes no server
 * dependency.
 */
const SYNC_AUTH_DEADLINE_MS = 5_000
/**
 * Deliberately later than the server's own auth deadline, for the same reason
 * COMMAND_ACK_TIMEOUT_MS is later than the backend timeout.
 *
 * *** AUTH NEVER GOT THE MARGIN COMMAND WAS GIVEN. *** Both numbers were 5 000, so
 * the two verdicts raced on every handshake. In practice the gateway's timer starts
 * earlier (it is armed when the socket is accepted, this one when the AUTH frame is
 * written) so the server usually won — and the close it sent arrived with no stated
 * cause this client could attribute, reporting `DEGRADED` with no reason at all.
 * When the client won instead it blamed its own ack timeout for a handshake the
 * server was in the middle of answering. Wrong either way, and invisible either way,
 * because a tie is not a failure anyone can see in a log.
 *
 * Two seconds rather than five: a handshake is one round trip against a deadline
 * the gateway enforces itself, so the margin only has to outlast the gateway's own
 * close, not a backend call. A socket that is genuinely dead still falls to
 * PONG_DEADLINE_MS or to this, whichever the lane reaches first.
 */
const AUTH_ACK_TIMEOUT_MS = SYNC_AUTH_DEADLINE_MS + 2_000
/**
 * The gateway's own budget for a durable sync command (`wg/syncProtocol.ts`
 * SYNC_BACKEND_TIMEOUT_MS). Mirrored, not imported: the worker bundle does not
 * take a server dependency.
 */
const SYNC_BACKEND_TIMEOUT_MS = 15_000
/**
 * Deliberately later than the server's own deadline. Set equal to it, the two
 * verdicts raced: the client could tear the socket down for "no answer" in the
 * same millisecond the gateway was answering, turning a decided command into an
 * ambiguous one that only a STATUS round trip could settle.
 */
const COMMAND_ACK_TIMEOUT_MS = SYNC_BACKEND_TIMEOUT_MS + 5_000
const HEARTBEAT_INTERVAL_MS = 30_000
/**
 * Two heartbeat periods without a PONG. Below this a single slow tick would
 * close a healthy socket; above it a half-open connection (a proxy that dropped
 * the TCP session without a FIN) stays "READY" long enough to be discovered by
 * the next command's ack deadline instead, which costs that command a fallback.
 */
const PONG_DEADLINE_MS = 2 * HEARTBEAT_INTERVAL_MS
const OWNER_RENEW_INTERVAL_MS = 5_000
/**
 * Reconnects allowed per connected session, replenished by every successful
 * handshake. The budget bounds a dial loop against a broken endpoint; it is not
 * a lifetime quota, and spending it once must not leave every later command
 * with zero reconnects.
 */
const MAX_RECONNECT_ATTEMPTS = 3
/**
 * The first reconnect window. Doubled per attempt spent and capped at
 * MAX_RECONNECT_DELAY_MS, so the three attempts this client is allowed draw their
 * delay from windows of 1 s, 2 s and 4 s.
 *
 * *** THE OLD EXPRESSION WAS A CONSTANT WITH NO JITTER. *** It read
 * `max(1000, random() * min(5000, 250 * 2 ** attempts))`, and `attempts` can only
 * be 0, 1 or 2, so the windows were 250 ms, 500 ms and 1 000 ms — every one of them
 * at or below the 1 000 ms floor the `max` imposed. The delay was therefore exactly
 * 1 000 ms on all three attempts whatever `random()` returned: no backoff, and no
 * de-synchronisation. Every client in a fleet re-dialled in the same second after a
 * gateway restart, three times, and the third attempt was spent 3 s after the first.
 */
const RECONNECT_BACKOFF_BASE_MS = 1_000
/** No backoff window grows past this, however many attempts have been spent. */
const MAX_RECONNECT_DELAY_MS = 5_000
/**
 * The delay is drawn from the UPPER half of the window:
 * `window * (0.5 + random() * 0.5)`.
 *
 * Jitter is applied to the whole delay rather than to a window the floor then
 * swallows, which is what made the old expression constant. Half the window is
 * enough spread to break a fleet-wide thundering herd — a restarting gateway sees
 * its clients arrive across a 500 ms, then 1 s, then 2 s band instead of three
 * single seconds — while keeping the lower bound a definite fraction of the window
 * rather than letting a draw near zero re-dial immediately.
 */
const RECONNECT_JITTER_FLOOR = 0.5
/**
 * How long a socket must survive its own handshake to count as having worked.
 *
 * Longer than any dial plus handshake (a ticket mint and one round trip) and
 * shorter than one HEARTBEAT_INTERVAL_MS, so a socket that lived long enough to
 * exchange a single PING/PONG is never counted against this client.
 */
const MIN_HEALTHY_SOCKET_LIFETIME_MS = 10_000
/**
 * Handshakes that died inside MIN_HEALTHY_SOCKET_LIFETIME_MS tolerated in a row
 * before this client stops dialling and stays on HTTP.
 */
const MAX_SHORT_LIVED_HANDSHAKES = 3
/**
 * How long the lane stays on HTTP once that many handshakes have died young — and,
 * equally, how long without one before the counter decays back to zero.
 *
 * *** WHY A SEPARATE COUNTER EXISTS AT ALL. *** `AUTHENTICATED` resets
 * `reconnectAttempts` to zero, because the budget is per connected session rather
 * than a lifetime quota. Read on its own that is right; read against a condition
 * that kills the socket moments AFTER the handshake it is a loop with no bound, and
 * the backoff above is its only pacing. Each cycle mints a ticket, and the ticket
 * bucket is keyed on the bearer digest — shared by every tab of the session — so one
 * looping tab spends the whole account's allowance and the other tabs are refused a
 * socket they could have used. A handshake that immediately dies is not evidence the
 * lane works, so it must not replenish the budget that bounds the dialling.
 */
const HANDSHAKE_LOOP_HOLD_MS = 60_000
const OPAQUE_SESSION_SCOPE_PATTERN = /^sync-session-v1:[a-f0-9]{64}$/u

/**
 * In-place credential refreshes this client will ask ONE socket for.
 *
 * The gateway's own budget is eight per socket; this is deliberately smaller so
 * the client always gives up first and never learns its bound by being closed.
 * It is NOT reset by a successful refresh — that is exactly the loop shape (a
 * refusal refreshes, the refusal recurs, the refresh succeeds again, forever) —
 * and not by the clock, so no periodic caller can replenish it. It is reset only
 * by a new `AUTHENTICATED` handshake, which is a genuinely new socket carrying a
 * freshly minted credential that needs no refresh in the first place.
 *
 * Four covers four token rotations inside one socket's life. The fifth refusal
 * takes the pre-existing recovery (re-ticket, then durable recovery), which
 * cannot be lost and cannot double-apply.
 */
const MAX_SESSION_REFRESH_ATTEMPTS = 4

/**
 * How long one refresh may take, measured from the moment the worker asks the
 * main thread for a ticket.
 *
 * Something must bound it or a parked operation waits forever: parking clears the
 * command's ack deadline (the alternative is the ack deadline firing and closing
 * a healthy socket mid-refresh, which is precisely the reconnect this change
 * exists to avoid). Generous enough for one authenticated HTTP round trip plus
 * the gateway's own call to the session plane.
 */
const SESSION_REFRESH_TIMEOUT_MS = 10_000

/**
 * The gateway's own `failAndClose` addresses its final ERROR frame to
 * `requestId`/`commandId` `'protocol'` — it belongs to the socket, not to any
 * command. Mirrored, not imported: the worker bundle takes no server dependency.
 */
const SYNC_PROTOCOL_FRAME_ID = 'protocol'

/**
 * Response statuses on the API_RPC lane that a credential refresh can plausibly
 * repair. 498 is auth's "this access token is expired"; 401 is "this request did
 * not authenticate", which a rotated token also produces. Both are answered by
 * the gateway's authentication middleware BEFORE any handler runs.
 */
const REFRESHABLE_RPC_STATUSES = new Set([401, 498])

/**
 * Every operation this build knows the gateway may advertise. An `AUTHENTICATED`
 * frame naming anything outside this set is rejected, because an unrecognized
 * operation means the peer is speaking a protocol this client cannot bound.
 * Recognizing an operation here is deliberately weaker than consuming it: a lane
 * stays unused until a caller opts into it, but its presence must never cost the
 * socket. `FILES_V1` is recognized-not-consumed today — the gateway advertises it
 * whenever a files adapter is ready, and without this entry that handshake would
 * drop sync itself to HTTP.
 */
const FILES_NEGOTIATED_OPERATION: SyncNegotiatedOperation = 'FILES_V1'

/**
 * Gateway file errors worth another attempt on a later connection. Everything
 * else (integrity, range, not-found, denied) describes a stable condition that a
 * retry would only reproduce.
 */
const RETRYABLE_FILE_ERROR_CODES = new Set([
  'OPERATION_UNAVAILABLE',
  'FILE_BACKEND_ERROR',
  'FILE_TRANSFER_CAPACITY',
  'FILE_DEADLINE_EXCEEDED',
  'FILE_BACKPRESSURE',
])

/**
 * Command refusals the gateway raises INSTEAD of dispatching, so no durable write
 * can have happened and the identical COMMAND may be sent again.
 *
 * `BUSY` is the whole set and it is a lease verdict, not a fault: the command lease
 * is keyed on (user, device), so BUSY means another command of this device holds it
 * and will hand it back — or, once, that the lease store did not answer. The gateway
 * says so in terms ("answer BUSY, which the client retries after backoff") and the
 * client did the opposite: it took the ERROR default, demanded durable recovery, and
 * closed a perfectly healthy socket, losing collaboration rooms, the invite
 * subscription, the socket budget and any in-flight file transfer with it.
 */
const RESENDABLE_COMMAND_REFUSAL_CODES = new Set(['BUSY'])

/**
 * API_RPC refusals the gateway raises BEFORE it dispatches the request, so no
 * handler ran and HTTP may be asked the same question.
 *
 * `safeToFallback` is read by `WebApplication.controlPlaneRpc` and means exactly
 * "this request provably had no effect, so retrying it over HTTP cannot apply
 * anything twice". Every server ERROR frame used to be reported `safeToFallback:
 * false`, so `BUSY` — which is the gateway refusing the NINTH concurrent RPC at an
 * admission check, before any dispatch — threw at the caller where HTTP would have
 * answered immediately.
 *
 * `RPC_PATH_FORBIDDEN` is deliberately NOT here even though it is also pre-dispatch:
 * `WebApplication.httpOnlyJsonRequest` exists and is documented to exist because
 * that refusal throws, and changing it is a decision for that file's owner.
 */
const PRE_DISPATCH_RPC_REFUSAL_CODES = new Set([
  'BUSY',
  'OPERATION_UNAVAILABLE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'SOCKET_LIMIT',
  'SOCKET_BUDGET_LOST',
  'SYNC_DISABLED',
])

/**
 * Refusals raised after the request ran. The answer the lane could not carry is
 * still available over HTTP, but only a READ may be asked again: for a mutation the
 * client cannot establish whether it applied, which is the same line
 * `parkRpcForSessionRefresh` draws and for the same reason.
 *
 * `RESULT_TOO_LARGE` is the case that motivated this: the socket frame cap is the
 * one limit HTTP does not have, so the lane refusing on size is precisely when HTTP
 * is the right answer — and the client was throwing instead.
 */
const POST_DISPATCH_READ_RETRYABLE_RPC_CODES = new Set(['RESULT_TOO_LARGE', 'BACKEND_TIMEOUT', 'BACKEND_ERROR'])

/**
 * Refusals raised AFTER the backend was called, so the durable write MAY have
 * landed. Resolved by re-asking STATUS and NEVER by re-sending the COMMAND — which
 * is the same rule the credential refresh follows, and for the same reason: STATUS
 * is a query, and the only replay it can lead to is on an explicit `UNKNOWN`.
 *
 * `BACKEND_TIMEOUT` is sent from the `catch` around `backend.execute`, so it is
 * ambiguous by construction. It is NOT a pre-write refusal, whatever the close code
 * suggests, and treating it as one would be the single move that could apply a
 * mutation twice.
 */
const RESTATABLE_COMMAND_REFUSAL_CODES = new Set(['BACKEND_TIMEOUT'])

/** Two, then the pre-existing fallback. Bounded so a stuck lease cannot spin. */
const MAX_COMMAND_REFUSAL_RETRIES = 2
const COMMAND_REFUSAL_RETRY_DELAY_MS = 1_000

/**
 * The local send buffer never drained inside the deadline.
 *
 * *** WHY THIS CLASS EXISTS: `'backpressure'` WAS A REASON NOTHING COULD EMIT. ***
 * It has been a declared `SyncFallbackReason` with its own explanation sentence and
 * its own counter in the admin pane since the lane was written, and every throw out
 * of `sendWithBackpressure` was a plain `Error` that the command path's catch
 * collapsed onto `'outbox-unavailable'` — a reason about IndexedDB. So the pane
 * showed a structurally dead counter, and a client genuinely outrunning its socket
 * was reported as a broken local database.
 *
 * Thrown ONLY for the drain deadline. "The socket is gone" and "the socket changed
 * underneath us" are not backpressure and keep their existing reasons.
 */
class SyncBackpressureError extends Error {}

const NEGOTIABLE_OPERATIONS: ReadonlySet<SyncNegotiatedOperation> = new Set([
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  'FILES_V1',
])

/**
 * What a close actually carries.
 *
 * *** THE REASON USED TO BE DISCARDED AT THE TYPE LEVEL. *** This was declared
 * `{ code?: number }`, the wiring read `event.code ?? 0`, and the spec double
 * mirrored the narrow type — so no client test could even express a server that
 * states its cause, and about a dozen distinct gateway causes reached the user as
 * a bare `SOCKET_CLOSED`. A native `WebSocket` has carried `reason` and `wasClean`
 * all along; the gateway's `failAndClose` puts its message in `reason` and
 * `gateway.attach.test.ts` asserts `{ code: 1008, reason: 'sync rate limit
 * exceeded' }` on the wire.
 *
 * `reason` is read ONLY to pick a `SyncFallbackReason` from a closed set (see
 * `syncCloseFallbackReason`). Server text never reaches the ledger, the pane or a
 * log line — a close reason is attacker-influenceable in principle and the ledger
 * is written to be pasted in public.
 */
export type SyncSocketCloseEvent = {
  readonly code?: number
  /** The server's stated cause. Classified, never stored or rendered verbatim. */
  readonly reason?: string
  /** False when no close frame arrived, so there is no server statement to trust. */
  readonly wasClean?: boolean
}

export interface SyncSocketLike {
  readonly readyState: number
  readonly bufferedAmount: number
  /**
   * Set to `'arraybuffer'` before the socket opens so FILES_V1 download chunks
   * arrive as `ArrayBuffer` rather than `Blob`. Optional because sockets that
   * predate the files lane (and the test doubles built against them) never
   * carry binary frames; those keep working untouched.
   */
  binaryType?: string
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: ((event: SyncSocketCloseEvent) => void) | null
  send(data: string): void
  /**
   * Writes a binary FILES_V1 frame. Separate from {@link send} so a socket double
   * that never carries file transfers does not have to model binary writes, and
   * so a caller cannot accidentally pass bytes where a JSON frame is expected.
   */
  sendBinary(data: Uint8Array): void
  close(code?: number, reason?: string): void
}

export type SyncWorkerRuntimeDependencies = {
  outbox?: SyncOutboxStore
  socketFactory?: (endpoint: string) => SyncSocketLike
  postMessage: (message: SyncWorkerToMainMessage) => void
  now?: () => number
  random?: () => number
  uuid?: () => string
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  subtle?: SubtleCrypto
}

type ActiveRequest =
  | {
      clientRequestId: string
      sessionScope: string
      mode: 'execute' | 'recover'
      body: AccountSyncTransportRequest
      context?: AccountSyncTransportContext
    }
  | {
      clientRequestId: string
      sessionScope: string
      mode: 'collaboration'
      request: CollaborationAuthorizationTransportRequest
      commandId: string
      phase: 'discovery' | 'grant'
      socketGeneration?: number
      discovery?: CollaborationEpochDiscoveryHandshake
      /** One fresh discovery per request after the gateway reports the challenge expired. */
      discoveryRetried?: boolean
    }
  | {
      clientRequestId: string
      sessionScope: string
      mode: 'rpc-bootstrap'
    }
  | {
      clientRequestId: string
      sessionScope: string
      mode: 'invite-bootstrap'
    }

type ActiveRpcRequest = {
  clientRequestId: string
  sessionScope: string
  request: WorkerAuthenticatedRpcRequest
  commandId: string
  sent: boolean
  accepted: boolean
  responseStarted: boolean
  expectedChunkIndex: number
  deadlineTimer?: ReturnType<typeof setTimeout>
  /**
   * One credential refresh per request, independent of the socket's own budget.
   * Without it a lane that answers 401 for a reason a refresh cannot fix would
   * alternate refresh and retry until the request's deadline.
   */
  refreshRetried?: boolean
  /**
   * The refusing response, withheld while a refresh is attempted.
   *
   * Withheld rather than discarded: if the refresh does not succeed this exact
   * answer is delivered, so the caller's existing net still fires — a GET 401/498
   * is what `WebApplication.controlPlaneRpc` degrades to HTTP on, and a refresh
   * that fails must not turn that degradation into a thrown error.
   */
  deferredResponse?: { status: number; headers: Record<string, string>; hasBody: boolean; body?: unknown }
}

/**
 * One operation held while the socket's credential is refreshed, and what the
 * refresh's outcome does to it. Parking NEVER mutates the operation's durable
 * identity: a command keeps its outbox record, command id and digest, and an RPC
 * keeps its request object including any idempotency key, so a resume reuses the
 * key the server dedupes on rather than minting a new one.
 */
type ParkedRefreshOperation =
  /** The durable SYNC_ITEMS command currently in `outboxRecord`. */
  | { kind: 'command' }
  /** A GET RPC with no idempotency key; see `parkRpcForSessionRefresh`. */
  | { kind: 'rpc'; clientRequestId: string }
  /** A collaboration authorization the gateway refused `SESSION_STALE`. */
  | { kind: 'collaboration'; clientRequestId: string }
  /**
   * Nothing to resume: repair the SOCKET's credential and stop.
   *
   * *** THE CREDENTIAL BELONGS TO THE SOCKET, NOT TO THE REQUEST THAT NOTICED. ***
   * A refusal only one lane can replay must still repair the connection, or the four
   * lanes that cannot see that refusal stay stranded on a credential the server has
   * already started refusing — which is exactly how an admin read could 401 while
   * sync looked healthy. Used by the file lanes (whose transfers are resumed by
   * their caller, not here) and by an RPC refusal that is not safe to retry in
   * place.
   */
  | { kind: 'socket' }

type ActiveSessionRefresh = {
  /** Correlates the main thread's ticket answer; a mismatched answer is discarded. */
  refreshId: string
  /** `requestId`/`commandId` of the REAUTH frame. The gateway echoes both back. */
  commandId: string
  sessionScope: string
  socketGeneration: number
  /** True once REAUTH bytes are on the socket, so a server verdict may be believed. */
  sent: boolean
  parked: ParkedRefreshOperation[]
  timer?: ReturnType<typeof setTimeout>
}

type ActiveInviteSubscription = {
  clientRequestId: string
  sessionScope: string
  commandId: string
  cursor?: string
  limit: number
  sent: boolean
  awaitingAck?: string
  ackReady?: boolean
  /**
   * True once this subscription's owner has been told the lane is not carrying it
   * right now — an `INVITE_ERROR` or an `INVITE_DEFERRED` went out.
   *
   * It exists so the teardown path can speak for an orphaned subscription without
   * speaking over a caller that already settled it: posting an `INVITE_ERROR` after
   * an `INVITE_DEFERRED` would un-park the coordinator and drive exactly the
   * reconnect-per-backoff-tick loop the deferral was written to stop. Cleared when
   * the subscription is actually on the wire again.
   */
  settled?: boolean
}

/**
 * One in-flight FILES_V1 download.
 *
 * Identity is `transferId` + `generation`, which is what the gateway itself uses
 * to invalidate a transfer: a re-opened download replaces the previous
 * generation, and a frame carrying a stale one is discarded rather than applied.
 * Nothing here is keyed on an object reference, so re-rendering or re-applying
 * the file item cannot restart a transfer.
 */
type ActiveFileDownload = {
  clientRequestId: string
  sessionScope: string
  request: WorkerFileDownloadRequest
  /** Echoed by the gateway on FILES_ACCEPTED / FILES_COMPLETE / ERROR. */
  commandId: string
  /** Echoed by the gateway inside every binary chunk header. */
  requestId: string
  accepted: boolean
  transferId?: string
  generation?: number
  declaredSize: number
  nextIndex: number
  nextOffset: number
  /** Chunks handed to the main thread; once above zero, HTTP replay is unsafe. */
  chunksForwarded: number
  outstandingCreditBytes: number
  deadlineTimer?: ReturnType<typeof setTimeout>
}

/**
 * One in-flight FILES_V1 upload, from the worker's point of view.
 *
 * The worker deliberately holds no opinion about resume, replay safety, or what
 * to send next — `SocketUploadTransfer` on the main thread owns all of that, and
 * it is pure and tested. This is a frame pump: it opens, writes the chunks it is
 * handed, relays acknowledgements, and reports failures.
 */
type ActiveFileUpload = {
  clientRequestId: string
  sessionScope: string
  request: WorkerFileUploadRequest
  /** Echoed by the gateway on FILES_ACCEPTED / FILES_COMPLETE / ERROR. */
  commandId: string
  /** Carried in every binary chunk header this upload emits. */
  requestId: string
  accepted: boolean
  transferId?: string
  generation?: number
  /** True once FINISH bytes are on the socket; from then on nothing is replayable. */
  finishSent: boolean
  deadlineTimer?: ReturnType<typeof setTimeout>
}

type CollaborationEpochDiscoveryHandshake = {
  challenge: string
  requestId: string
  roomEpoch: string
  collaborationSecurityEpoch: string
  expiresAt: number
}

function defaultUuid(): string {
  return crypto.randomUUID()
}

function parseStoredBody(record: SyncOutboxRecord): AccountSyncTransportRequest | undefined {
  try {
    const frame = JSON.parse(record.bytes) as SyncClientFrame
    const payload = frame.payload as { command?: unknown; body?: AccountSyncTransportRequest }
    return payload.command === 'SYNC_ITEMS' && payload.body && typeof payload.body === 'object'
      ? payload.body
      : undefined
  } catch {
    return undefined
  }
}

function validSessionScope(sessionScope: string): boolean {
  return OPAQUE_SESSION_SCOPE_PATTERN.test(sessionScope)
}

/**
 * Dedicated-worker state machine. It never receives an access/refresh token.
 *
 * That isolation is why this worker has no access to the app's crypto provider,
 * and must not acquire one: it holds no keys, so it can neither encrypt nor
 * decrypt, and a file's bytes pass through it opaquely. The consequence for
 * FILES_V1 is a deliberate split of the two digests it deals with. The per-chunk
 * digest is verified here with `crypto.subtle`, which workers have and which
 * needs no key. The digest of a whole file — required by `FILES_UPLOAD_FINISH` —
 * is computed on the main thread beside the encryptor that produces those bytes,
 * because that is where the file actually exists in plaintext-adjacent form. Do
 * not "simplify" this by giving the worker a crypto provider; the boundary is the
 * point, not an oversight.
 */
export class SyncTransportWorkerRuntime {
  private readonly outbox: SyncOutboxStore
  private readonly socketFactory: (endpoint: string) => SyncSocketLike
  private readonly now: () => number
  private readonly random: () => number
  private readonly uuid: () => string
  private readonly scheduleTimeout: typeof globalThis.setTimeout
  private readonly cancelTimeout: typeof globalThis.clearTimeout
  private readonly scheduleInterval: typeof globalThis.setInterval
  private readonly cancelInterval: typeof globalThis.clearInterval
  private readonly subtle: SubtleCrypto
  private readonly ownerId: string

  private state: SyncTransportState = 'HTTP_ONLY'
  private socket?: SyncSocketLike
  private socketGeneration = 0
  private active?: ActiveRequest
  private authorization?: SyncTicket
  private sessionScope?: string
  private transportScope?: string
  private outboxRecord?: SyncOutboxRecord
  private sequence = 1
  private accepted = false
  /** True once COMMAND bytes have been handed to WebSocket.send. */
  private commandSent = false
  private resultDelivered = false
  private reconnectAttempts = 0
  /**
   * When THIS socket's `AUTHENTICATED` landed, or undefined if it never did.
   *
   * Cleared on every close, so a socket that was refused before it authenticated
   * can never be charged with dying young — the dial loop this measures is
   * specifically the one that gets past the handshake and then loses the socket.
   */
  private socketAuthenticatedAt?: number
  /** Consecutive handshakes that died inside MIN_HEALTHY_SOCKET_LIFETIME_MS. */
  private shortLivedHandshakes = 0
  /** When the most recent one died, so the run above decays instead of accruing. */
  private lastShortLivedHandshakeAt?: number
  /** While this is in the future no ticket is asked for; the lane stays on HTTP. */
  private handshakeLoopHeldUntil?: number
  /** Live only for the span of a hold, to announce its end. Never gates the hold. */
  private handshakeLoopHoldTimer?: ReturnType<typeof setTimeout>
  /** One re-ticket per request after the gateway reports the ticket's bearer stale. */
  private reticketedForStaleSession = false
  /** Retries spent on a retryable command refusal, per command. */
  private commandRefusalRetries = 0
  /**
   * Set once the server answers `LIVE_SYNC_DISABLED`: item sync is refused for this
   * account for the rest of the worker's life, so later commands go to HTTP without
   * spending a socket round trip, while every other lane keeps using the socket.
   */
  private liveSyncDisabled = false
  private negotiatedOperations = new Set<SyncNegotiatedOperation>()
  private readonly rpcRequests = new Map<string, ActiveRpcRequest>()
  private readonly fileDownloads = new Map<string, ActiveFileDownload>()
  private readonly fileUploads = new Map<string, ActiveFileUpload>()
  private inviteSubscription?: ActiveInviteSubscription
  private shuttingDown = false
  private ackTimeout?: ReturnType<typeof setTimeout>
  private pongTimeout?: ReturnType<typeof setTimeout>
  private reconnectTimeout?: ReturnType<typeof setTimeout>
  /** Live only between a retryable command refusal and the retry it schedules. */
  private commandRetryTimeout?: ReturnType<typeof setTimeout>
  private heartbeatInterval?: ReturnType<typeof setInterval>
  private ownerRenewInterval?: ReturnType<typeof setInterval>
  /** Live only while an invite subscription is parked on a `deferred` fallback reason. */
  private deferredInviteWatch?: ReturnType<typeof setInterval>
  /**
   * The last scope this tab dialled, kept after the lease is released so the
   * next request can read the lease before paying for a ticket to discover the
   * same thing. Cleared only when the session changes.
   */
  private lastTransportScope?: string
  /** A READY socket that did not negotiate the invite lane never will (see sendInviteSubscription). */
  private inviteEventsUnavailable = false
  /** At most one credential refresh is in flight; concurrent refusals join it. */
  private sessionRefresh?: ActiveSessionRefresh
  /** Refreshes asked for on THIS socket. Reset only by a new AUTHENTICATED handshake. */
  private sessionRefreshAttempts = 0
  /**
   * The gateway ANSWERED that it will not refresh this socket's credential —
   * `OPERATION_UNAVAILABLE` (the deployment composed no session revalidator) or
   * `REAUTH_REJECTED` (the ticket was unknown, replayed, or not bound to this
   * user, session and device). Both are structural, so this latch lives for the
   * worker's whole life rather than the socket's: one worker instance serves
   * exactly one session scope, so asking again after a reconnect could only mint
   * and spend another one-use ticket to be told the same thing.
   */
  private sessionRefreshUnsupported = false

  /**
   * The `code` of the protocol-addressed ERROR frame this socket's gateway sent, if
   * it sent one.
   *
   * Cleared where a socket is CREATED, and deliberately nowhere else. Clearing it
   * after a close as well would look tidier and would make the one reset that
   * matters unobservable: several teardown paths drop the socket reference before
   * closing it, so their `onClose` returns at the identity guard and never runs. One
   * reset, at the only moment a new connection can begin, covers all of them.
   */
  private protocolErrorCode?: string

  constructor(private readonly dependencies: SyncWorkerRuntimeDependencies) {
    this.outbox = dependencies.outbox ?? new IndexedDbSyncOutbox()
    this.socketFactory =
      dependencies.socketFactory ??
      ((endpoint) => {
        if (typeof WebSocket === 'undefined') {
          throw new Error('WebSocket is unavailable')
        }
        const socket = new WebSocket(endpoint)
        const adapted = socket as unknown as SyncSocketLike & { sendBinary: (data: Uint8Array) => void }
        adapted.sendBinary = (data: Uint8Array) => socket.send(data.slice().buffer)
        return adapted
      })
    this.now = dependencies.now ?? Date.now
    this.random = dependencies.random ?? Math.random
    this.uuid = dependencies.uuid ?? defaultUuid
    this.scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout.bind(globalThis)
    this.cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
    this.scheduleInterval = dependencies.setInterval ?? globalThis.setInterval.bind(globalThis)
    this.cancelInterval = dependencies.clearInterval ?? globalThis.clearInterval.bind(globalThis)
    this.subtle = dependencies.subtle ?? crypto.subtle
    this.ownerId = this.uuid()
  }

  async handle(message: MainToSyncWorkerMessage): Promise<void> {
    switch (message.type) {
      case 'EXECUTE':
        await this.execute(message.clientRequestId, message.body, message.sessionScope, message.context)
        break
      case 'RECOVER':
        await this.recover(message.clientRequestId, message.sessionScope, message.replayOverHttp)
        break
      case 'AUTHORIZE_COLLABORATION':
        await this.authorizeCollaboration(message.clientRequestId, message.sessionScope, message.request)
        break
      case 'OPEN_RPC':
        await this.openRpc(message.clientRequestId, message.sessionScope, message.request)
        break
      case 'CANCEL_RPC':
        await this.cancelRpc(message.clientRequestId)
        break
      case 'RPC_CREDIT':
        await this.creditRpc(message.clientRequestId, message.creditBytes)
        break
      case 'SUBSCRIBE_INVITE_EVENTS':
        await this.subscribeInviteEvents(message.clientRequestId, message.sessionScope, message.cursor, message.limit)
        break
      case 'ACK_INVITE_EVENTS':
        await this.ackInviteEvents(message.clientRequestId, message.cursor)
        break
      case 'UNSUBSCRIBE_INVITE_EVENTS':
        this.unsubscribeInviteEvents(message.clientRequestId)
        break
      case 'OPEN_FILE_DOWNLOAD':
        await this.openFileDownload(message.clientRequestId, message.sessionScope, message.request)
        break
      case 'FILE_DOWNLOAD_CREDIT':
        await this.creditFileDownload(message.clientRequestId, message.creditBytes)
        break
      case 'CANCEL_FILE_DOWNLOAD':
        await this.cancelFileDownload(message.clientRequestId, 'CANCELLED')
        break
      case 'OPEN_FILE_UPLOAD':
        await this.openFileUpload(message.clientRequestId, message.sessionScope, message.request)
        break
      case 'SEND_FILE_CHUNK':
        await this.sendFileChunk(message.clientRequestId, message.index, message.offset, message.bytes)
        break
      case 'FINISH_FILE_UPLOAD':
        await this.finishFileUpload(message)
        break
      case 'CANCEL_FILE_UPLOAD':
        await this.cancelFileUpload(message.clientRequestId, 'CANCELLED')
        break
      case 'CONNECT':
        await this.connect(message.clientRequestId, message.sessionScope, message.authorization)
        break
      case 'TICKET_UNAVAILABLE':
        if (this.active?.clientRequestId === message.clientRequestId) {
          await this.fallback(message.reason)
        }
        break
      case 'SESSION_REFRESH_TICKET':
        await this.sendSessionRefresh(message.refreshId, message.ticket, message.deviceId)
        break
      case 'SESSION_REFRESH_UNAVAILABLE':
        if (this.sessionRefresh?.refreshId === message.refreshId) {
          await this.settleSessionRefresh('failed')
        }
        break
      case 'CHECKPOINT_DURABLE':
        await this.checkpointDurable(message.requestId, message.sessionScope, message.commandId)
        break
      case 'SESSION_REVOKED':
        await this.revokeSession(message.requestId, message.sessionScope)
        break
      case 'RELEASE_OWNER':
        await this.releaseOwnership()
        break
      case 'SHUTDOWN':
        await this.shutdown()
        break
    }
  }

  private async recover(
    clientRequestId: string,
    sessionScope: string,
    replayOverHttp?: SyncFallbackReason,
  ): Promise<void> {
    if (this.shuttingDown || !validSessionScope(sessionScope)) {
      this.dependencies.postMessage({ type: 'RECOVERY_EMPTY', clientRequestId })
      return
    }
    if (this.activeBlocksNewWork()) {
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
      return
    }
    let record: SyncOutboxRecord | undefined
    try {
      record = await this.outbox.oldest(sessionScope)
    } catch (error) {
      // A store that will not open cannot be read, so STATUS can never be asked
      // about whatever it may hold and no amount of retrying changes that.
      // Reporting "recovery required" here wedged every later sync until
      // sign-out; reporting "nothing to recover" lets the ordinary HTTP sync
      // proceed, and the record — if there is one — is reconciled by the next
      // recovery once the store opens again.
      this.dependencies.postMessage({
        type: isSyncOutboxUnavailable(error) ? 'RECOVERY_EMPTY' : 'RECOVERY_REQUIRED',
        clientRequestId,
      })
      return
    }
    try {
      if (!record || record.sessionScope !== sessionScope || record.revoked === true) {
        this.dependencies.postMessage({ type: 'RECOVERY_EMPTY', clientRequestId })
        return
      }
      const recoveredBody = parseStoredBody(record)
      if (!recoveredBody) {
        this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
        return
      }
      this.active = { clientRequestId, sessionScope, mode: 'recover', body: recoveredBody }
      this.sessionScope = sessionScope
      this.outboxRecord = record
      this.accepted = false
      this.commandSent = record.dispatchedAt !== undefined
      this.resultDelivered = false
      this.reticketedForStaleSession = false
      this.commandRefusalRetries = 0
      this.dependencies.postMessage({
        type: 'COMMAND_PERSISTED',
        clientRequestId,
        body: recoveredBody,
        command: {
          id: record.commandId,
          digest: record.digest,
          sequence: record.sequence,
          ...(record.operationId ? { operationId: record.operationId } : {}),
        },
      })
      if (replayOverHttp) {
        // The socket is ruled out for this session, so STATUS can never be asked.
        // The HTTP path carries the command identity and the server journal
        // answers it idempotently — the same guarantee the UNKNOWN path relies on.
        await this.fallback(replayOverHttp, record, false, true)
        return
      }
      if (this.socket?.readyState === 1 && this.state === 'READY' && this.transportScope) {
        await this.prepareActiveRequest()
        return
      }
      await this.requestTicket(clientRequestId, sessionScope, false)
    } catch {
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
    }
  }

  private async execute(
    clientRequestId: string,
    body: AccountSyncTransportRequest,
    sessionScope: string,
    context?: AccountSyncTransportContext,
  ): Promise<void> {
    if (this.shuttingDown || !validSessionScope(sessionScope)) {
      this.postFallback(clientRequestId, body, 'worker-error')
      return
    }
    if (this.activeBlocksNewWork()) {
      // Never create a parallel HTTP owner while an earlier command may be in
      // flight. The durable owner must be reconciled first.
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
      return
    }
    let normalizedBody: AccountSyncTransportRequest
    try {
      normalizedBody = normalizeSyncRequestForWire(body)
    } catch {
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
      return
    }
    try {
      const stale = await this.outbox.oldest(sessionScope)
      if (stale) {
        this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
        return
      }
    } catch (error) {
      if (isSyncOutboxUnavailable(error)) {
        // Nothing was ever written for this command, so there is no durable
        // owner to reconcile and HTTP is free to take it. Demanding a recovery
        // that this store can never serve locked the account out of sync
        // entirely; the store is re-opened on the next attempt.
        this.postFallback(clientRequestId, normalizedBody, 'outbox-unavailable')
        return
      }
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
      return
    }
    this.active = { clientRequestId, sessionScope, mode: 'execute', body: normalizedBody, context }
    this.sessionScope = sessionScope
    this.accepted = false
    this.commandSent = false
    this.resultDelivered = false
    this.reticketedForStaleSession = false
    this.commandRefusalRetries = 0

    if (this.socket?.readyState === 1 && this.state === 'READY' && this.transportScope) {
      await this.prepareActiveRequest()
      return
    }

    await this.requestTicket(clientRequestId, sessionScope, false)
  }

  /**
   * A command may take over a connection-only bootstrap: both exist only to get
   * a socket up, and the RPC request or invite subscription that asked for one
   * is re-sent on the command's ticket the moment AUTH lands. Refusing the
   * command instead (`RECOVERY_REQUIRED`) failed a sync that had nothing to
   * recover, every time a keystroke met an assistant call.
   *
   * The takeover itself is the later `this.active = …` assignment, deliberately
   * not done here: a caller that bails out before it (nothing to recover, an
   * unusable store) must leave the bootstrap running, or the ticket already in
   * flight for it would arrive to no owner and its RPC would hang to its
   * deadline.
   */
  private activeBlocksNewWork(): boolean {
    return this.active !== undefined && this.active.mode !== 'invite-bootstrap' && this.active.mode !== 'rpc-bootstrap'
  }

  /**
   * The one place that asks the main thread for a ticket. A tab that cannot own
   * the socket used to find out only after minting and spending a one-use
   * ticket — an authenticated request plus a server-side ticket write per sync,
   * for the life of the tab. The lease lives in this worker's own store, so the
   * cheap read answers it first.
   */
  private async requestTicket(clientRequestId: string, sessionScope: string, reconnect: boolean): Promise<void> {
    // The dial loop's actual bound. The reconnect budget alone cannot be one,
    // because `AUTHENTICATED` replenishes it; this hold is armed by handshakes that
    // died young and is not replenished by anything but the clock, so while it
    // stands no ticket is minted however the request arrived — a reconnect, a new
    // command, an RPC or an invite subscription.
    if (this.handshakeLoopHeld()) {
      await this.fallback('reconnect-gap')
      return
    }
    if (await this.socketOwnedByAnotherTab(sessionScope)) {
      await this.fallback('multi-tab-not-owner')
      return
    }
    this.transition('HALF_OPEN')
    this.dependencies.postMessage({ type: 'NEED_TICKET', clientRequestId, reconnect })
  }

  /**
   * Only ever true when another owner holds an unexpired lease on the scope this
   * tab last dialled. An unreadable store, an expired lease, our own lease or a
   * tab that has never connected all fall through to the ordinary ticket path,
   * so this can delay a handover by at most one lease TTL and can never deny a
   * socket that is actually free.
   */
  private async socketOwnedByAnotherTab(sessionScope: string): Promise<boolean> {
    const transportScope = this.transportScope ?? this.lastTransportScope
    try {
      // Exact while this tab knows the scope it dials; otherwise — a tab that
      // has not connected once, which is every tab on its first sync — the
      // session-wide read, because the scope string only arrives with a ticket
      // and asking for one is the cost being avoided.
      return transportScope
        ? await this.outbox.heldByAnotherOwner(transportScope, sessionScope, this.ownerId, this.now())
        : await this.outbox.sessionHeldByAnotherOwner(sessionScope, this.ownerId, this.now())
    } catch {
      return false
    }
  }

  private async authorizeCollaboration(
    clientRequestId: string,
    sessionScope: string,
    request: CollaborationAuthorizationTransportRequest,
  ): Promise<void> {
    if (this.shuttingDown || !validSessionScope(sessionScope)) {
      this.dependencies.postMessage({ type: 'COLLABORATION_FALLBACK', clientRequestId, reason: 'worker-error' })
      return
    }
    if (this.active) {
      this.dependencies.postMessage({ type: 'COLLABORATION_FALLBACK', clientRequestId, reason: 'reconnect-gap' })
      return
    }
    this.active = {
      clientRequestId,
      sessionScope,
      mode: 'collaboration',
      request,
      commandId: this.uuid(),
      phase: 'discovery',
    }
    this.sessionScope = sessionScope
    if (this.socket?.readyState === 1 && this.state === 'READY' && this.transportScope) {
      await this.prepareActiveRequest()
      return
    }
    await this.requestTicket(clientRequestId, sessionScope, false)
  }

  private async openRpc(
    clientRequestId: string,
    sessionScope: string,
    request: WorkerAuthenticatedRpcRequest,
  ): Promise<void> {
    if (
      this.shuttingDown ||
      !validSessionScope(sessionScope) ||
      !isValidWorkerRpcRequest(request) ||
      this.rpcRequests.has(clientRequestId)
    ) {
      this.dependencies.postMessage({
        type: 'RPC_ERROR',
        clientRequestId,
        code: 'INVALID_REQUEST',
        retryable: false,
        safeToFallback: true,
      })
      return
    }
    const rpc: ActiveRpcRequest = {
      clientRequestId,
      sessionScope,
      request,
      commandId: this.uuid(),
      sent: false,
      accepted: false,
      responseStarted: false,
      expectedChunkIndex: 0,
    }
    rpc.deadlineTimer = this.scheduleTimeout(() => {
      void this.cancelRpc(clientRequestId, 'DEADLINE_EXCEEDED')
    }, request.deadlineMs)
    this.rpcRequests.set(clientRequestId, rpc)

    if (this.socket?.readyState === 1 && this.state === 'READY' && this.transportScope) {
      await this.sendRpc(rpc)
      return
    }
    if (!this.active) {
      this.active = { clientRequestId, sessionScope, mode: 'rpc-bootstrap' }
      this.sessionScope = sessionScope
      await this.requestTicket(clientRequestId, sessionScope, false)
    }
  }

  private async cancelRpc(clientRequestId: string, code = 'CANCELLED'): Promise<void> {
    const rpc = this.rpcRequests.get(clientRequestId)
    if (!rpc) {
      return
    }
    if (rpc.sent && this.socket?.readyState === 1 && this.state === 'READY') {
      const payload = { targetRequestId: rpc.commandId }
      const frame: SyncClientFrame = {
        version: SYNC_PROTOCOL_VERSION,
        channel: SYNC_CHANNEL,
        type: 'RPC_CANCEL',
        requestId: this.uuid(),
        commandId: this.uuid(),
        sequence: this.sequence++,
        payloadLength: payloadByteLength(payload),
        payload,
      }
      try {
        await this.sendWithBackpressure(JSON.stringify(frame))
      } catch {
        // The terminal local cancellation below is authoritative for the caller.
      }
    }
    this.failRpc(rpc, code, code === 'DEADLINE_EXCEEDED', !rpc.sent)
  }

  private async creditRpc(clientRequestId: string, creditBytes: number): Promise<void> {
    const rpc = this.rpcRequests.get(clientRequestId)
    if (
      !rpc?.sent ||
      !Number.isSafeInteger(creditBytes) ||
      creditBytes <= 0 ||
      creditBytes > MAX_RPC_CREDIT_BYTES ||
      this.socket?.readyState !== 1 ||
      this.state !== 'READY'
    ) {
      return
    }
    const payload = { targetRequestId: rpc.commandId, creditBytes }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'RPC_CREDIT',
      requestId: this.uuid(),
      commandId: this.uuid(),
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
    } catch {
      this.failRpc(rpc, 'SOCKET_CLOSED', true, false)
    }
  }

  private async subscribeInviteEvents(
    clientRequestId: string,
    sessionScope: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<void> {
    if (
      this.shuttingDown ||
      !validSessionScope(sessionScope) ||
      (cursor !== undefined && !isOpaqueCursor(cursor)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      this.dependencies.postMessage({
        type: 'INVITE_ERROR',
        clientRequestId,
        code: 'INVALID_REQUEST',
        retryable: false,
      })
      return
    }
    if (this.sessionScope && this.sessionScope !== sessionScope) {
      this.dependencies.postMessage({
        type: 'INVITE_ERROR',
        clientRequestId,
        code: 'SESSION_CHANGED',
        retryable: false,
      })
      return
    }
    if (this.inviteEventsUnavailable) {
      // Already answered for this session by a socket that reached READY without
      // the lane (see sendInviteSubscription). Dialling again to be told the
      // same thing is what the retry loop this flag exists to stop was doing.
      this.dependencies.postMessage({
        type: 'INVITE_ERROR',
        clientRequestId,
        code: 'OPERATION_UNAVAILABLE',
        retryable: false,
      })
      return
    }

    const subscription: ActiveInviteSubscription = {
      clientRequestId,
      sessionScope,
      commandId: this.uuid(),
      ...(cursor === undefined ? {} : { cursor }),
      limit,
      sent: false,
    }
    this.inviteSubscription = subscription
    this.sessionScope = sessionScope
    if (this.socket?.readyState === 1 && this.state === 'READY' && this.transportScope) {
      await this.sendInviteSubscription(subscription)
      return
    }
    if (!this.active) {
      this.active = { clientRequestId, sessionScope, mode: 'invite-bootstrap' }
      await this.requestTicket(clientRequestId, sessionScope, false)
    }
  }

  private async ackInviteEvents(clientRequestId: string, cursor: string): Promise<void> {
    const subscription = this.inviteSubscription
    if (
      !subscription ||
      subscription.clientRequestId !== clientRequestId ||
      subscription.awaitingAck !== cursor ||
      !isOpaqueCursor(cursor)
    ) {
      return
    }
    subscription.ackReady = true
    await this.sendInviteAckIfReady(subscription)
  }

  private async sendInviteAckIfReady(subscription: ActiveInviteSubscription): Promise<void> {
    const cursor = subscription.awaitingAck
    if (
      this.inviteSubscription !== subscription ||
      !subscription.ackReady ||
      !cursor ||
      this.socket?.readyState !== 1 ||
      this.state !== 'READY'
    ) {
      return
    }
    const payload = { cursor }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'INVITE_ACK',
      requestId: this.uuid(),
      commandId: this.uuid(),
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
      if (this.inviteSubscription === subscription) {
        subscription.cursor = cursor
        subscription.awaitingAck = undefined
        subscription.ackReady = undefined
      }
    } catch {
      this.dependencies.postMessage({
        type: 'INVITE_ERROR',
        clientRequestId: subscription.clientRequestId,
        code: 'SOCKET_CLOSED',
        retryable: true,
      })
      this.socket?.close(4000, 'invite acknowledgement failed')
    }
  }

  private unsubscribeInviteEvents(clientRequestId: string): void {
    if (this.inviteSubscription?.clientRequestId === clientRequestId) {
      this.inviteSubscription = undefined
      this.cancelDeferredInviteWatch()
      if (this.active?.mode === 'invite-bootstrap' && this.active.clientRequestId === clientRequestId) {
        this.active = undefined
      }
    }
  }

  /**
   * Opens a FILES_V1 download on an already-negotiated socket.
   *
   * Deliberately never bootstraps a connection. Unlike sync or RPC there is no
   * `files-bootstrap` mode and no `NEED_TICKET`: if the socket is not already up
   * and advertising FILES_V1, this reports OPERATION_UNAVAILABLE and the caller
   * uses HTTP exactly as it always has. A deployment that advertises nothing
   * therefore pays literally nothing for this lane — no ticket request, no
   * connection attempt, no new failure mode — which is the property that has to
   * hold, since that is the configuration nearly every deployment runs.
   */
  private async openFileDownload(
    clientRequestId: string,
    sessionScope: string,
    request: WorkerFileDownloadRequest,
  ): Promise<void> {
    if (
      this.shuttingDown ||
      !validSessionScope(sessionScope) ||
      !isWorkerFileDownloadRequest(request) ||
      this.fileDownloads.has(clientRequestId)
    ) {
      this.failFileDownloadMessage(clientRequestId, 'INVALID_REQUEST', false, true)
      return
    }
    if (this.sessionScope && this.sessionScope !== sessionScope) {
      this.failFileDownloadMessage(clientRequestId, 'SESSION_CHANGED', false, true)
      return
    }
    if (
      this.socket?.readyState !== 1 ||
      this.state !== 'READY' ||
      !this.negotiatedOperations.has(FILES_NEGOTIATED_OPERATION)
    ) {
      this.failFileDownloadMessage(clientRequestId, 'OPERATION_UNAVAILABLE', true, true)
      return
    }

    const download: ActiveFileDownload = {
      clientRequestId,
      sessionScope,
      request,
      commandId: this.uuid(),
      requestId: this.uuid(),
      accepted: false,
      declaredSize: request.declaredSize,
      nextIndex: 0,
      nextOffset: 0,
      chunksForwarded: 0,
      outstandingCreditBytes: 0,
    }
    download.deadlineTimer = this.scheduleTimeout(() => {
      void this.cancelFileDownload(clientRequestId, 'DEADLINE_EXCEEDED')
    }, request.deadlineMs)
    this.fileDownloads.set(clientRequestId, download)

    const payload = {
      // Forwarded as validated, not rebuilt field by field. `remoteIdentifier`
      // crosses byte-identical to the value the file item authenticated — it is
      // also the decryptor's AAD — and reconstructing the reference here is how a
      // shared-vault download would quietly lose its vault fields and be refused.
      resource: { ...download.request.resource },
      offset: 0,
      initialCreditBytes: request.initialCreditBytes,
      deadlineMs: request.deadlineMs,
    }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'FILES_DOWNLOAD_OPEN',
      requestId: download.requestId,
      commandId: download.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
      download.outstandingCreditBytes = request.initialCreditBytes
    } catch {
      this.failFileDownload(download, 'SOCKET_CLOSED', true)
    }
  }

  /**
   * Returns consumed credit to the gateway. The main thread sends this only after
   * the bytes have actually been written through the decryptor, so the socket
   * window reflects real consumption rather than mere arrival — the gateway pumps
   * only while credit remains, so a slow consumer stalls the sender instead of
   * accumulating an unbounded buffer in the worker.
   */
  private async creditFileDownload(clientRequestId: string, creditBytes: number): Promise<void> {
    const download = this.fileDownloads.get(clientRequestId)
    if (
      !download?.accepted ||
      download.transferId === undefined ||
      download.generation === undefined ||
      !Number.isSafeInteger(creditBytes) ||
      creditBytes <= 0 ||
      creditBytes > MAX_FILE_TRANSFER_CREDIT_BYTES ||
      this.socket?.readyState !== 1 ||
      this.state !== 'READY'
    ) {
      return
    }
    const granted = Math.min(creditBytes, MAX_FILE_TRANSFER_CREDIT_BYTES - download.outstandingCreditBytes)
    if (granted <= 0) {
      return
    }
    const payload = { transferId: download.transferId, generation: download.generation, creditBytes: granted }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'FILES_CREDIT',
      requestId: this.uuid(),
      commandId: this.uuid(),
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
      download.outstandingCreditBytes += granted
    } catch {
      this.failFileDownload(download, 'SOCKET_CLOSED', true)
    }
  }

  private async cancelFileDownload(clientRequestId: string, code: string): Promise<void> {
    const download = this.fileDownloads.get(clientRequestId)
    if (!download) {
      return
    }
    if (
      download.transferId !== undefined &&
      download.generation !== undefined &&
      this.socket?.readyState === 1 &&
      this.state === 'READY'
    ) {
      const payload = { transferId: download.transferId, generation: download.generation }
      const frame: SyncClientFrame = {
        version: SYNC_PROTOCOL_VERSION,
        channel: SYNC_CHANNEL,
        type: 'FILES_CANCEL',
        requestId: this.uuid(),
        commandId: this.uuid(),
        sequence: this.sequence++,
        payloadLength: payloadByteLength(payload),
        payload,
      }
      try {
        await this.sendWithBackpressure(JSON.stringify(frame))
      } catch {
        // The local termination below is authoritative for the caller either way.
      }
    }
    this.failFileDownload(download, code, code === 'DEADLINE_EXCEEDED')
  }

  private handleFilesServerFrame(download: ActiveFileDownload, frame: SyncServerFrame): void {
    if (frame.type === 'ERROR') {
      const code = typeof frame.payload.code === 'string' ? frame.payload.code : 'FILE_BACKEND_ERROR'
      this.failFileDownload(download, code, this.fileRefusalIsRetryable(code))
      return
    }
    if (frame.type === 'FILES_ACCEPTED') {
      const payload = frame.payload
      if (
        download.accepted ||
        payload.mode !== 'download' ||
        !isFileIdentifier(payload.transferId) ||
        !Number.isSafeInteger(payload.generation) ||
        Number(payload.generation) < 1 ||
        // The client's own authenticated metadata decides how long this file is.
        // A server reporting a different length is refused, not adopted.
        payload.declaredSize !== download.declaredSize ||
        payload.nextIndex !== 0 ||
        payload.nextOffset !== 0
      ) {
        this.failFileDownload(download, 'FILE_INVALID_STATE', false)
        return
      }
      download.accepted = true
      download.transferId = payload.transferId
      download.generation = Number(payload.generation)
      this.dependencies.postMessage({
        type: 'FILE_DOWNLOAD_ACCEPTED',
        clientRequestId: download.clientRequestId,
        declaredSize: download.declaredSize,
      })
      return
    }
    if (frame.type === 'FILES_COMPLETE') {
      const payload = frame.payload
      if (
        payload.mode !== 'download' ||
        payload.transferId !== download.transferId ||
        payload.generation !== download.generation ||
        payload.rangeStart !== 0 ||
        payload.declaredSize !== download.declaredSize ||
        !isFileSha256(payload.sha256) ||
        download.nextOffset !== download.declaredSize
      ) {
        this.failFileDownload(download, 'FILE_TRUNCATED', false)
        return
      }
      this.clearFileDownload(download)
      this.dependencies.postMessage({
        type: 'FILE_DOWNLOAD_COMPLETE',
        clientRequestId: download.clientRequestId,
        sha256: payload.sha256,
        declaredSize: download.declaredSize,
      })
    }
  }

  /**
   * A malformed or unattributable binary frame fails at most the transfer it
   * names. It never closes the socket: an advertised lane misbehaving must not
   * cost sync, collaboration and invites their transport.
   */
  private async handleFileBinaryFrame(raw: Uint8Array): Promise<void> {
    let decoded: SocketFileBinaryFrame
    try {
      decoded = decodeFileBinaryFrame(raw)
    } catch {
      return
    }
    if (decoded.header.kind !== 'DOWNLOAD_CHUNK') {
      return
    }
    const download = [...this.fileDownloads.values()].find(
      (candidate) =>
        candidate.requestId === decoded.header.requestId &&
        candidate.transferId === decoded.header.transferId &&
        candidate.generation === decoded.header.generation,
    )
    if (!download || !download.accepted) {
      return
    }
    if (
      decoded.header.index !== download.nextIndex ||
      decoded.header.offset !== download.nextOffset ||
      decoded.header.declaredSize !== download.declaredSize ||
      decoded.header.byteLength > download.outstandingCreditBytes
    ) {
      this.failFileDownload(download, 'FILE_CHUNK_OUT_OF_ORDER', false)
      return
    }
    let digestMatches: boolean
    try {
      digestMatches = await fileBinaryPayloadMatchesDigest(decoded, this.subtle)
    } catch {
      digestMatches = false
    }
    if (!digestMatches) {
      this.failFileDownload(download, 'FILE_INTEGRITY_MISMATCH', false)
      return
    }
    // The transfer can be cancelled or replaced while the digest is being
    // computed; re-establish that this frame is still the one expected.
    if (this.fileDownloads.get(download.clientRequestId) !== download || decoded.header.index !== download.nextIndex) {
      return
    }
    download.nextIndex += 1
    download.nextOffset += decoded.header.byteLength
    download.outstandingCreditBytes -= decoded.header.byteLength
    download.chunksForwarded += 1
    this.dependencies.postMessage({
      type: 'FILE_DOWNLOAD_CHUNK',
      clientRequestId: download.clientRequestId,
      bytes: decoded.bytes.slice(),
      offset: decoded.header.offset,
    })
  }

  /**
   * Is a gateway file refusal worth another attempt — and does it also mean the
   * SOCKET needs repairing?
   *
   * `SESSION_STALE` was simply absent from `RETRYABLE_FILE_ERROR_CODES`, so the one
   * refusal the gateway invented specifically to be repairable was reported to the
   * caller as a stable condition with no refresh asked for and no retry suggested.
   * The authorizers for both file lanes throw it, so a token rotation stranded every
   * transfer on the socket until something unrelated forced a reconnect.
   *
   * The transfer itself is NOT resumed here: an upload may have written bytes the
   * server kept and only the main thread knows what that means for replay, which is
   * why `safeToFallback` exists. Saying "retryable" and repairing the credential is
   * what makes the caller's own retry able to succeed.
   */
  private fileRefusalIsRetryable(code: string): boolean {
    if (code !== 'SESSION_STALE') {
      return RETRYABLE_FILE_ERROR_CODES.has(code)
    }
    this.refreshSocketCredential()
    // Retryable whether or not a refresh could be started: with one, this socket is
    // repaired; without one, the ordinary reconnect mints a fresh credential anyway.
    // Reporting it as stable was the defect, and it was stable in neither case.
    return true
  }

  private failFileDownload(download: ActiveFileDownload, code: string, retryable: boolean): void {
    if (this.fileDownloads.get(download.clientRequestId) !== download) {
      return
    }
    this.clearFileDownload(download)
    this.failFileDownloadMessage(download.clientRequestId, code, retryable, download.chunksForwarded === 0)
  }

  private failFileDownloadMessage(
    clientRequestId: string,
    code: string,
    retryable: boolean,
    safeToFallback: boolean,
  ): void {
    this.dependencies.postMessage({
      type: 'FILE_DOWNLOAD_ERROR',
      clientRequestId,
      code,
      retryable,
      safeToFallback,
    })
  }

  private clearFileDownload(download: ActiveFileDownload): void {
    if (download.deadlineTimer) {
      this.cancelTimeout(download.deadlineTimer)
      download.deadlineTimer = undefined
    }
    this.fileDownloads.delete(download.clientRequestId)
  }

  private failAllFileDownloads(code: string, retryable: boolean): void {
    for (const download of [...this.fileDownloads.values()]) {
      this.failFileDownload(download, code, retryable)
    }
  }

  /**
   * Opens a FILES_V1 upload on an already-negotiated socket.
   *
   * Gated exactly like a download and for the same reason: it never bootstraps a
   * connection. Without a live socket advertising FILES_V1 this reports
   * OPERATION_UNAVAILABLE and the caller uploads over HTTP as it always has, so a
   * deployment that advertises nothing performs no extra work and gains no new
   * failure mode from this lane existing.
   */
  private async openFileUpload(
    clientRequestId: string,
    sessionScope: string,
    request: WorkerFileUploadRequest,
  ): Promise<void> {
    if (
      this.shuttingDown ||
      !validSessionScope(sessionScope) ||
      !isWorkerFileUploadRequest(request) ||
      this.fileUploads.has(clientRequestId)
    ) {
      this.failFileUploadMessage(clientRequestId, 'INVALID_REQUEST', false, true)
      return
    }
    if (this.sessionScope && this.sessionScope !== sessionScope) {
      this.failFileUploadMessage(clientRequestId, 'SESSION_CHANGED', false, true)
      return
    }
    if (
      this.socket?.readyState !== 1 ||
      this.state !== 'READY' ||
      !this.negotiatedOperations.has(FILES_NEGOTIATED_OPERATION)
    ) {
      this.failFileUploadMessage(clientRequestId, 'OPERATION_UNAVAILABLE', true, true)
      return
    }

    const upload: ActiveFileUpload = {
      clientRequestId,
      sessionScope,
      request,
      commandId: this.uuid(),
      requestId: this.uuid(),
      accepted: false,
      finishSent: false,
    }
    upload.deadlineTimer = this.scheduleTimeout(() => {
      void this.cancelFileUpload(clientRequestId, 'DEADLINE_EXCEEDED')
    }, request.deadlineMs)
    this.fileUploads.set(clientRequestId, upload)

    const payload = {
      // Forwarded as validated, never rebuilt field by field: reconstructing it
      // here is exactly how a shared-vault upload would lose its vault fields.
      resource: { ...request.resource },
      decryptedSize: request.decryptedSize,
      declaredSize: request.declaredSize,
      mimeType: request.mimeType,
      deadlineMs: request.deadlineMs,
      ...(request.resumeId ? { resumeId: request.resumeId } : {}),
    }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'FILES_UPLOAD_OPEN',
      requestId: upload.requestId,
      commandId: upload.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
    } catch {
      this.failFileUpload(upload, 'SOCKET_CLOSED', true)
    }
  }

  /** Frames and writes one encrypted chunk handed down from the main thread. */
  private async sendFileChunk(
    clientRequestId: string,
    index: number,
    offset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const upload = this.fileUploads.get(clientRequestId)
    if (
      !upload?.accepted ||
      upload.transferId === undefined ||
      upload.generation === undefined ||
      upload.finishSent ||
      this.socket?.readyState !== 1 ||
      this.state !== 'READY'
    ) {
      return
    }
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_FILE_CHUNK_BYTES) {
      this.failFileUpload(upload, 'FILE_FRAME_TOO_LARGE', false)
      return
    }
    let encoded: Uint8Array
    try {
      const sha256 = await fileBinaryPayloadDigest(bytes, this.subtle)
      encoded = encodeFileBinaryFrame(
        {
          kind: 'UPLOAD_CHUNK',
          requestId: upload.requestId,
          transferId: upload.transferId,
          generation: upload.generation,
          index,
          offset,
          declaredSize: upload.request.declaredSize,
          byteLength: bytes.byteLength,
          sha256,
          final: offset + bytes.byteLength === upload.request.declaredSize,
        },
        bytes,
      )
    } catch {
      // A frame this client knows the gateway would reject is not worth a round
      // trip, and sending it would leave a transfer needing resolution.
      this.failFileUpload(upload, 'FILE_FRAME_MALFORMED', false)
      return
    }
    if (this.fileUploads.get(clientRequestId) !== upload) {
      return
    }
    try {
      await this.sendBinaryWithBackpressure(encoded)
    } catch {
      this.failFileUpload(upload, 'SOCKET_CLOSED', true)
    }
  }

  private async finishFileUpload(message: {
    clientRequestId: string
    transferId: string
    generation: number
    declaredSize: number
    sha256: string
  }): Promise<void> {
    const upload = this.fileUploads.get(message.clientRequestId)
    if (
      !upload?.accepted ||
      upload.transferId !== message.transferId ||
      upload.generation !== message.generation ||
      !isFileSha256(message.sha256) ||
      this.socket?.readyState !== 1 ||
      this.state !== 'READY'
    ) {
      return
    }
    const payload = {
      transferId: message.transferId,
      generation: message.generation,
      declaredSize: message.declaredSize,
      sha256: message.sha256,
      deadlineMs: upload.request.deadlineMs,
    }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'FILES_UPLOAD_FINISH',
      requestId: this.uuid(),
      commandId: upload.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    // Marked before the write, not after. The client cannot know whether bytes it
    // wrote arrived, so "I attempted FINISH" is the only transition point that
    // never under-estimates the risk of the upload already having been applied.
    upload.finishSent = true
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
    } catch {
      this.failFileUpload(upload, 'SOCKET_CLOSED', true)
    }
  }

  private async cancelFileUpload(clientRequestId: string, code: string): Promise<void> {
    const upload = this.fileUploads.get(clientRequestId)
    if (!upload) {
      return
    }
    if (
      upload.transferId !== undefined &&
      upload.generation !== undefined &&
      this.socket?.readyState === 1 &&
      this.state === 'READY'
    ) {
      const payload = { transferId: upload.transferId, generation: upload.generation }
      const frame: SyncClientFrame = {
        version: SYNC_PROTOCOL_VERSION,
        channel: SYNC_CHANNEL,
        type: 'FILES_CANCEL',
        requestId: this.uuid(),
        commandId: this.uuid(),
        sequence: this.sequence++,
        payloadLength: payloadByteLength(payload),
        payload,
      }
      try {
        await this.sendWithBackpressure(JSON.stringify(frame))
      } catch {
        // The local termination below is authoritative for the caller regardless.
      }
    }
    this.failFileUpload(upload, code, code === 'DEADLINE_EXCEEDED')
  }

  private handleFileUploadServerFrame(upload: ActiveFileUpload, frame: SyncServerFrame): void {
    if (frame.type === 'ERROR') {
      const code = typeof frame.payload.code === 'string' ? frame.payload.code : 'FILE_BACKEND_ERROR'
      this.failFileUpload(upload, code, this.fileRefusalIsRetryable(code))
      return
    }
    if (frame.type === 'FILES_ACCEPTED') {
      const payload = frame.payload
      if (
        payload.mode !== 'upload' ||
        !isFileIdentifier(payload.transferId) ||
        !isFileIdentifier(payload.resumeId) ||
        !Number.isSafeInteger(payload.generation) ||
        Number(payload.generation) < 1 ||
        payload.declaredSize !== upload.request.declaredSize ||
        !Number.isSafeInteger(payload.nextIndex) ||
        !Number.isSafeInteger(payload.nextOffset) ||
        Number(payload.nextOffset) > upload.request.declaredSize
      ) {
        this.failFileUpload(upload, 'FILE_INVALID_STATE', false)
        return
      }
      upload.accepted = true
      upload.transferId = payload.transferId
      upload.generation = Number(payload.generation)
      this.dependencies.postMessage({
        type: 'FILE_UPLOAD_ACCEPTED',
        clientRequestId: upload.clientRequestId,
        transferId: payload.transferId,
        generation: Number(payload.generation),
        resumeId: payload.resumeId,
        nextIndex: Number(payload.nextIndex),
        nextOffset: Number(payload.nextOffset),
        declaredSize: upload.request.declaredSize,
      })
      return
    }
    if (frame.type === 'FILES_CHUNK_ACK') {
      const payload = frame.payload
      if (
        payload.transferId !== upload.transferId ||
        payload.generation !== upload.generation ||
        !Number.isSafeInteger(payload.index) ||
        !Number.isSafeInteger(payload.nextIndex) ||
        !Number.isSafeInteger(payload.nextOffset) ||
        !isFileIdentifier(payload.resumeId)
      ) {
        return
      }
      this.dependencies.postMessage({
        type: 'FILE_UPLOAD_CHUNK_ACK',
        clientRequestId: upload.clientRequestId,
        transferId: String(payload.transferId),
        generation: Number(payload.generation),
        index: Number(payload.index),
        duplicate: payload.duplicate === true,
        nextIndex: Number(payload.nextIndex),
        nextOffset: Number(payload.nextOffset),
        resumeId: payload.resumeId,
      })
      return
    }
    if (frame.type === 'FILES_COMPLETE') {
      const payload = frame.payload
      if (payload.mode !== 'upload' || payload.transferId !== upload.transferId || !isFileSha256(payload.sha256)) {
        this.failFileUpload(upload, 'FILE_INVALID_STATE', false)
        return
      }
      this.clearFileUpload(upload)
      this.dependencies.postMessage({
        type: 'FILE_UPLOAD_COMPLETE',
        clientRequestId: upload.clientRequestId,
        sha256: payload.sha256,
      })
    }
  }

  private failFileUpload(upload: ActiveFileUpload, code: string, retryable: boolean): void {
    if (this.fileUploads.get(upload.clientRequestId) !== upload) {
      return
    }
    this.clearFileUpload(upload)
    this.failFileUploadMessage(upload.clientRequestId, code, retryable, !upload.finishSent)
  }

  private failFileUploadMessage(
    clientRequestId: string,
    code: string,
    retryable: boolean,
    safeToFallback: boolean,
  ): void {
    this.dependencies.postMessage({ type: 'FILE_UPLOAD_ERROR', clientRequestId, code, retryable, safeToFallback })
  }

  private clearFileUpload(upload: ActiveFileUpload): void {
    if (upload.deadlineTimer) {
      this.cancelTimeout(upload.deadlineTimer)
      upload.deadlineTimer = undefined
    }
    this.fileUploads.delete(upload.clientRequestId)
  }

  private failAllFileUploads(code: string, retryable: boolean): void {
    for (const upload of [...this.fileUploads.values()]) {
      this.failFileUpload(upload, code, retryable)
    }
  }

  private async connect(clientRequestId: string, sessionScope: string, authorization: SyncTicket): Promise<void> {
    if (
      !this.active ||
      this.active.clientRequestId !== clientRequestId ||
      this.active.sessionScope !== sessionScope ||
      !validSessionScope(sessionScope)
    ) {
      return
    }
    // Only a LOCAL-clock expiry is worth pre-checking; `expiresAt` is on the
    // server's clock and a browser running ahead of it would fail every ticket.
    if (authorization.localExpiresAt !== undefined && authorization.localExpiresAt <= this.now() + 1_000) {
      await this.fallback('ticket-expired')
      return
    }
    let endpoint: URL
    try {
      endpoint = new URL(authorization.endpoint)
    } catch {
      await this.fallback('proxy-failed')
      return
    }
    if (endpoint.protocol !== 'wss:' && endpoint.protocol !== 'ws:') {
      await this.fallback('proxy-failed')
      return
    }

    this.authorization = authorization
    this.sessionScope = sessionScope
    this.transportScope = `${sessionScope}|${endpoint.origin}${endpoint.pathname}|${authorization.deviceId}`
    this.lastTransportScope = this.transportScope
    try {
      const owner = await this.outbox.acquireOwner(
        this.transportScope,
        sessionScope,
        this.ownerId,
        this.now(),
        OWNER_LEASE_TTL_MS,
      )
      if (!owner) {
        await this.fallback('multi-tab-not-owner')
        return
      }
      this.beginOwnerRenewal()
    } catch {
      await this.fallback('outbox-unavailable')
      return
    }

    this.transition(this.reconnectAttempts > 0 ? 'HALF_OPEN' : 'CONNECTING')
    let socket: SyncSocketLike
    try {
      socket = this.socketFactory(endpoint.toString())
    } catch {
      await this.fallback('unsupported-browser')
      return
    }
    this.socket = socket
    this.socketGeneration += 1
    this.protocolErrorCode = undefined
    // Cleared at the one moment a new connection can begin, for the same reason
    // `protocolErrorCode` is: several teardown paths drop the socket reference
    // before closing it, so their `onClose` returns at the identity guard and never
    // runs. Left over from a previous socket, this would charge THIS socket's close
    // against a handshake that belonged to another one.
    this.socketAuthenticatedAt = undefined
    try {
      // Must be set before the socket opens, or FILES_V1 chunks would arrive as
      // Blobs. Guarded because the setter does not exist on every socket double.
      socket.binaryType = 'arraybuffer'
    } catch {
      // A socket that will not take binary simply never carries a file transfer.
    }
    socket.onopen = () => this.onOpen(socket)
    socket.onmessage = (event) => void this.onMessage(socket, event.data)
    socket.onerror = () => undefined
    socket.onclose = (event) => void this.onClose(socket, event)
  }

  private onOpen(socket: SyncSocketLike): void {
    if (this.socket !== socket || !this.authorization || !this.active) {
      return
    }
    this.transition('AUTHENTICATING')
    const payload: Record<string, unknown> = {
      ticket: this.authorization.ticket,
      deviceId: this.authorization.deviceId,
      ...(this.sequence > 1 ? { resumeSequence: this.sequence } : {}),
    }
    const authFrame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'AUTH',
      requestId: this.uuid(),
      commandId:
        this.outboxRecord?.commandId ?? (this.active.mode === 'collaboration' ? this.active.commandId : this.uuid()),
      sequence: 0,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    socket.send(JSON.stringify(authFrame))
    this.startAckDeadline(AUTH_ACK_TIMEOUT_MS)
  }

  private async onMessage(socket: SyncSocketLike, raw: unknown): Promise<void> {
    if (this.socket !== socket) {
      return
    }
    if (typeof raw !== 'string') {
      const binary = asBinaryFrame(raw)
      // Binary frames belong to FILES_V1 only. Anything else on this socket, or a
      // frame above the file ceiling, is dropped without disturbing the JSON lanes.
      if (binary && binary.byteLength <= MAX_FILE_BINARY_FRAME_BYTES && this.fileDownloads.size > 0) {
        await this.handleFileBinaryFrame(binary)
      }
      return
    }
    if (utf8Bytes(raw).byteLength > MAX_SYNC_FRAME_BYTES) {
      await this.fallback('frame-too-large')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.fallback('proxy-failed')
      return
    }
    if (!isSyncServerFrame(parsed)) {
      await this.fallback('proxy-failed')
      return
    }
    await this.handleServerFrame(parsed)
  }

  private async handleServerFrame(frame: SyncServerFrame): Promise<void> {
    if (frame.type === 'AUTHENTICATED') {
      if (this.state !== 'AUTHENTICATING') {
        return
      }
      const nextSequence = frame.payload.nextClientSequence
      const operations = frame.payload.operations
      if (
        frame.payload.capability !== 'ws-sync' ||
        frame.payload.protocolVersion !== 1 ||
        !Number.isSafeInteger(nextSequence) ||
        Number(nextSequence) < 1 ||
        !Array.isArray(operations) ||
        // SYNC_ITEMS is NOT required here. A deployment that binds no durable
        // sync command port serves collaboration, API RPC, invite events and
        // files over this socket while items sync over HTTP; demanding
        // SYNC_ITEMS threw that whole socket away and put every lane on HTTP.
        // The allow-list below stays closed: an unrecognised operation still
        // fails the handshake, which is the bd092f03 guarantee.
        operations.some((operation) => !NEGOTIABLE_OPERATIONS.has(operation as SyncNegotiatedOperation))
      ) {
        await this.fallback('auth-failed')
        return
      }
      this.clearAckDeadline()
      this.sequence = Number(nextSequence)
      this.negotiatedOperations = new Set(operations as SyncNegotiatedOperation[])
      // A new socket carries a credential captured moments ago, so the refresh
      // budget it has not spent starts over. This is the ONLY thing that
      // replenishes it: a success must not, or a refusal that keeps recurring
      // would refresh for as long as the tab is open. `sessionRefreshUnsupported`
      // is deliberately NOT cleared — the two refusals that set it are structural.
      this.sessionRefreshAttempts = 0
      this.socketAuthenticatedAt = this.now()
      // The reconnect budget is per connected session, not per tab. Without this
      // reset one bad patch of network spent it permanently, and every command
      // for the rest of the tab's life fell back to HTTP on its first close.
      //
      // ...but NOT while this client is in a run of handshakes that died young.
      // Replenishing the budget on a handshake is replenishing it on the strength
      // of a socket that has not yet survived anything, and a condition that kills
      // the socket moments after AUTH turns that into an unbounded ~1 Hz dial loop
      // (see HANDSHAKE_LOOP_HOLD_MS). The run decays on its own, so a genuine
      // patch of bad network still gets its budget back; what it cannot do is keep
      // handing one back to a loop that is spending the whole session's ticket
      // allowance.
      if (this.shortLivedHandshakes === 0) {
        this.reconnectAttempts = 0
      }
      this.transition('READY')
      this.dependencies.postMessage({
        type: 'NEGOTIATED',
        sessionScope: this.active?.sessionScope ?? this.sessionScope!,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        endpoint: this.authorization?.endpoint ?? '',
        operations: [...this.negotiatedOperations],
      })
      this.beginHeartbeat()
      await this.sendReadyRpcRequests()
      if (this.inviteSubscription) {
        await this.sendInviteSubscription(this.inviteSubscription)
      }
      await this.prepareActiveRequest()
      return
    }

    if (frame.type === 'PONG') {
      this.clearPongDeadline()
      return
    }
    // Before every lane lookup: a refresh frame belongs to the socket, not to any
    // request, and the socket-level refusal is addressed to `'protocol'`, which no
    // lane would recognise and which would otherwise fall through unnoticed.
    if (await this.handleSessionRefreshFrame(frame)) {
      return
    }
    // And before every other lane lookup, for the same reason and one more: the
    // gateway's LAST word before it closes is addressed to `'protocol'`, and a
    // lane lookup cannot match it. See `handleProtocolError`.
    if (await this.handleProtocolError(frame)) {
      return
    }
    const rpc = this.rpcByCommandId(frame.commandId)
    if (rpc) {
      this.handleRpcServerFrame(rpc, frame)
      return
    }
    const inviteSubscription = this.inviteSubscription
    if (inviteSubscription && frame.commandId === inviteSubscription.commandId) {
      this.handleInviteServerFrame(inviteSubscription, frame)
      return
    }
    const fileDownload = [...this.fileDownloads.values()].find((candidate) => candidate.commandId === frame.commandId)
    if (fileDownload) {
      this.handleFilesServerFrame(fileDownload, frame)
      return
    }
    // FILES_CHUNK_ACK is addressed by transferId rather than by the open frame's
    // commandId — the gateway sets `commandId` to the transferId when it
    // acknowledges a binary chunk — so uploads are matched on either.
    const fileUpload = [...this.fileUploads.values()].find(
      (candidate) => candidate.commandId === frame.commandId || candidate.transferId === frame.commandId,
    )
    if (fileUpload) {
      this.handleFileUploadServerFrame(fileUpload, frame)
      return
    }
    if (frame.type === 'ERROR' && this.state === 'AUTHENTICATING') {
      await this.fallback('auth-failed', this.outboxRecord)
      return
    }
    if (this.active?.mode === 'collaboration') {
      if (frame.commandId !== this.active.commandId) {
        return
      }
      if (frame.type === 'COLLABORATION_AUTHORIZED') {
        this.clearAckDeadline()
        const active = this.active
        if (
          active.sessionScope !== this.sessionScope ||
          active.socketGeneration !== this.socketGeneration ||
          this.socket?.readyState !== 1
        ) {
          await this.fallbackCollaboration('reconnect-gap', false)
          return
        }
        if (active.phase === 'discovery') {
          const discovery = parseCollaborationEpochDiscoveryResult(
            frame.payload,
            active.request,
            frame.requestId,
            this.now(),
          )
          if (!discovery) {
            await this.fallbackCollaboration('proxy-failed', false)
            return
          }
          if (active.request.expectedRoomEpoch && active.request.expectedRoomEpoch !== discovery.roomEpoch) {
            const clientRequestId = active.clientRequestId
            this.active = undefined
            this.reconnectAttempts = 0
            this.dependencies.postMessage({ type: 'COLLABORATION_DENIED', clientRequestId })
            return
          }
          active.phase = 'grant'
          active.discovery = discovery
          active.commandId = this.uuid()
          await this.sendCollaborationAuthorization()
          return
        }
        const result = parseCollaborationAuthorizationResult(
          frame.payload,
          active.request,
          active.discovery,
          this.now(),
        )
        if (!result) {
          await this.fallbackCollaboration('proxy-failed', false)
          return
        }
        const clientRequestId = active.clientRequestId
        this.active = undefined
        this.reconnectAttempts = 0
        this.dependencies.postMessage({ type: 'COLLABORATION_RESULT', clientRequestId, result })
        return
      }
      if (frame.type === 'ERROR') {
        this.clearAckDeadline()
        const active = this.active
        if (frame.payload.code === 'CHALLENGE_EXPIRED' && active.phase === 'grant' && !active.discoveryRetried) {
          // The one-use discovery challenge lapsed before the grant reached the
          // gateway. That is not a policy denial — run discovery once more on the
          // same socket rather than telling the caller it was refused.
          active.discoveryRetried = true
          active.phase = 'discovery'
          active.discovery = undefined
          active.commandId = this.uuid()
          await this.sendCollaborationAuthorization()
          return
        }
        if (
          frame.payload.code === 'SESSION_STALE' &&
          this.requestSessionRefresh({ kind: 'collaboration', clientRequestId: active.clientRequestId })
        ) {
          // *** THE GATEWAY ADDED THIS CODE SO THE CLIENT COULD REPAIR IN PLACE. ***
          // It distinguishes `SESSION_STALE` from `NOT_AUTHORIZED` precisely to say
          // "the credential is old, not wrong". This lane answered everything but
          // NOT_AUTHORIZED/CHALLENGE_EXPIRED/OPERATION_UNAVAILABLE with
          // `fallbackCollaboration('server-kill', false)`: the socket closed, the
          // owner lease released, the rooms gone — to fix one stale field that a
          // REAUTH on the socket we already hold repairs in milliseconds.
          //
          // The ack deadline is cleared because the refresh owns the timeout now;
          // left armed it would close the healthy socket mid-refresh, which is the
          // very teardown being avoided.
          this.clearAckDeadline()
          return
        }
        if (frame.payload.code === 'NOT_AUTHORIZED') {
          const clientRequestId = active.clientRequestId
          this.active = undefined
          this.reconnectAttempts = 0
          this.dependencies.postMessage({ type: 'COLLABORATION_DENIED', clientRequestId })
        } else {
          await this.fallbackCollaboration(
            frame.payload.code === 'OPERATION_UNAVAILABLE' ? 'operation-unavailable' : 'server-kill',
            frame.payload.code === 'OPERATION_UNAVAILABLE',
          )
        }
      }
      return
    }
    if (!this.outboxRecord || frame.commandId !== this.outboxRecord.commandId) {
      return
    }
    if (frame.digest && frame.digest !== this.outboxRecord.digest) {
      await this.fallback('proxy-failed')
      return
    }

    switch (frame.type) {
      case 'ACCEPTED':
        if (!this.accepted) {
          this.accepted = true
          this.startAckDeadline(COMMAND_ACK_TIMEOUT_MS)
        }
        break
      case 'COMMITTED':
        this.clearAckDeadline()
        if (isOversizedCommittedResult(frame.payload)) {
          await this.replayOversizedResultOverHttp()
          break
        }
        this.deliverResult(frame.payload.result)
        break
      case 'STATUS':
        this.clearAckDeadline()
        if (frame.payload.status === 'COMMITTED') {
          if (isOversizedCommittedResult(frame.payload)) {
            await this.replayOversizedResultOverHttp()
            break
          }
          this.deliverResult(frame.payload.result)
        } else if (frame.payload.status === 'UNKNOWN') {
          // The durable backend explicitly confirmed that the command did not
          // take effect. Only this result permits HTTP replay.
          await this.fallback('reconnect-gap', this.outboxRecord, false, true)
        } else {
          // ACCEPTED is post-admission and potentially post-effect. Keep the
          // outbox and query STATUS again after a bounded reconnect.
          this.accepted = true
          this.startAckDeadline(COMMAND_ACK_TIMEOUT_MS)
        }
        break
      case 'ERROR':
        if (frame.payload.code === 'SESSION_STALE') {
          // The ticket captured a bearer the auth service has since rotated. The
          // gateway refused before the backend saw the command, so the command is
          // intact and only the credential is wrong.
          //
          // FIRST try to repair the credential IN PLACE. A re-ticket fixes the same
          // field by throwing the socket away, and with it the collaboration rooms,
          // invite subscription, command lease, socket budget and any in-flight file
          // transfers riding the same connection. The parked command is resumed with
          // STATUS — never a second COMMAND — so the repair cannot apply anything
          // twice, and the ack deadline is cleared because the refresh owns the
          // timeout now (left armed it would close the healthy socket mid-refresh,
          // which is the very reconnect being avoided).
          if (this.requestSessionRefresh({ kind: 'command' })) {
            this.clearAckDeadline()
            break
          }
          if (!this.reticketedForStaleSession) {
            // No refresh available (or budget spent): the behaviour that existed
            // before — one fresh ticket on a fresh socket, then the STATUS query
            // that settles whether the command must be replayed over HTTP.
            this.reticketedForStaleSession = true
            await this.reticket()
            break
          }
        }
        if (frame.payload.code === 'LIVE_SYNC_DISABLED') {
          this.liveSyncDisabled = true
          await this.fallback('live-sync-disabled', this.outboxRecord, true, true)
          break
        }
        // A REFUSAL IS NOT A DEAD SOCKET. `BUSY` and `BACKEND_TIMEOUT` arrive on a
        // connection that is working and that the gateway itself expects the client
        // to use again; routing them to the ERROR default closed it and took the
        // other five lanes down with it.
        if (this.retryRefusedCommand(frame.payload.code)) {
          break
        }
        // ERROR RESULT_TOO_LARGE now means only "your COMMAND frame was too large
        // to ingest"; a committed result the socket cannot carry arrives as
        // STATUS COMMITTED + code instead (see replayOversizedResultOverHttp).
        await this.fallback(
          frame.payload.code === 'RESULT_TOO_LARGE' ? 'result-too-large' : 'server-kill',
          this.outboxRecord,
          frame.payload.code === 'RESULT_TOO_LARGE',
        )
        break
      default:
        break
    }
  }

  /**
   * The backend committed the command but the result is larger than one sync
   * frame. The HTTP path carries `x-sync-command-id`/`x-sync-command-digest`, so
   * the server journal serves the same committed result idempotently over the
   * unbounded transport. The socket is healthy and stays READY; the outbox record
   * is cleared by the checkpoint that follows the HTTP result. Before this, the
   * client demanded durable recovery, recovery asked STATUS, STATUS hit the same
   * cap, and the account wedged until sign-out while orphaning a socket per cycle.
   */
  private async replayOversizedResultOverHttp(): Promise<void> {
    await this.fallback('result-too-large', this.outboxRecord, true, true)
  }

  /** Drop the current socket and its ticket, keep the request, and ask for a fresh ticket. */
  private async reticket(): Promise<void> {
    const active = this.active
    if (!active) {
      return
    }
    this.clearAckDeadline()
    await this.closeSocketAndReleaseOwner({ redialling: true })
    await this.requestTicket(active.clientRequestId, active.sessionScope, true)
  }

  /*
   * ===========================================================================
   * Standard Red Notes: in-place session-credential refresh (client half).
   *
   * A sync socket replays the credential captured when its ticket was minted for
   * its whole life. A token rotation therefore strands every lane that
   * revalidates — sync, collaboration, API_RPC, files — while HTTP keeps reading
   * the live token per request and looks perfectly healthy. The server half
   * (53fd0129) accepts a `REAUTH` frame carrying an opaque one-use ticket; this
   * is the half that sends one.
   *
   * THREE PROPERTIES, in the order they matter:
   *
   * 1. NO REFUSED OPERATION IS LOST. Parking never discards anything. A command
   *    keeps its outbox record, `commandSent` and ack bookkeeping untouched, so
   *    every exit — refreshed, refused, socket closed, worker shut down — lands
   *    on a path that already existed and already surfaces the operation.
   *
   * 2. NOTHING IS APPLIED TWICE. A resumed command re-asks STATUS for its own
   *    command id and digest; it never re-sends the COMMAND frame. STATUS is a
   *    query, and the only replay it can lead to is on an explicit `UNKNOWN`,
   *    which is the backend stating the command did not take effect. A resumed
   *    RPC is restricted to requests carrying NO idempotency key, which given
   *    `isValidWorkerRpcRequest` is exactly GET.
   *
   * 3. IT CANNOT SPIN. One refresh in flight at a time, a per-socket attempt
   *    budget that nothing replenishes but a new handshake, and a latch for the
   *    two refusals that are structural rather than transient.
   * ===========================================================================
   */

  /**
   * Whether a refusal may be answered with a refresh rather than the recovery
   * that already existed.
   *
   * Every clause is a refusal to try, not a precondition to arrange. In
   * particular this requires a live READY socket: a refresh exists only to avoid
   * tearing one down, so with no socket to keep there is nothing to gain and the
   * ordinary reconnect — which mints a fresh credential anyway — is the answer.
   */
  private canRefreshSession(): boolean {
    return (
      !this.shuttingDown &&
      !this.sessionRefreshUnsupported &&
      this.state === 'READY' &&
      this.socket?.readyState === 1 &&
      this.sessionScope !== undefined &&
      (this.sessionRefresh !== undefined || this.sessionRefreshAttempts < MAX_SESSION_REFRESH_ATTEMPTS)
    )
  }

  /**
   * Park `operation` and make sure a refresh is running for it. Returns false
   * when no refresh will be attempted, in which case the caller MUST take the
   * path it would have taken before this existed.
   *
   * A second refusal arriving while a refresh is in flight joins that refresh and
   * spends no attempt: the credential is a property of the socket, so one refresh
   * repairs every lane riding it and a burst across lanes must cost one ticket,
   * not one per lane.
   */
  private requestSessionRefresh(operation: ParkedRefreshOperation): boolean {
    if (!this.canRefreshSession()) {
      return false
    }
    const existing = this.sessionRefresh
    if (existing) {
      existing.parked.push(operation)
      return true
    }
    const refresh: ActiveSessionRefresh = {
      refreshId: this.uuid(),
      commandId: this.uuid(),
      sessionScope: this.sessionScope as string,
      socketGeneration: this.socketGeneration,
      sent: false,
      parked: [operation],
    }
    this.sessionRefreshAttempts += 1
    this.sessionRefresh = refresh
    refresh.timer = this.scheduleTimeout(() => {
      if (this.sessionRefresh === refresh) {
        void this.settleSessionRefresh('failed')
      }
    }, SESSION_REFRESH_TIMEOUT_MS)
    this.dependencies.postMessage({
      type: 'NEED_SESSION_REFRESH',
      refreshId: refresh.refreshId,
      sessionScope: refresh.sessionScope,
    })
    return true
  }

  /**
   * Present the freshly minted ticket on the socket we already hold.
   *
   * A ticket that arrives after the connection it was meant for has gone must not
   * be spent on a different socket: the gateway compares it against the identity
   * that socket was ADMITTED with and closes the connection on a mismatch, so a
   * late ticket could end a healthy socket to deliver a refresh nobody is waiting
   * for. The primary defence is the discard in every teardown path, which clears
   * `sessionRefresh` before a replacement socket can exist, and that is what the
   * tests exercise. The `socketGeneration` comparison below is a second line
   * behind it and is deliberately unreachable today — a mutation of it survives,
   * which is the honest statement that the discard is doing the work; it is kept
   * so that a future teardown path which forgets to discard fails closed rather
   * than spending a bound ticket on the wrong connection.
   */
  private async sendSessionRefresh(refreshId: string, ticket: string, deviceId: string): Promise<void> {
    const refresh = this.sessionRefresh
    if (!refresh || refresh.refreshId !== refreshId || refresh.sent) {
      return
    }
    if (
      this.state !== 'READY' ||
      this.socket?.readyState !== 1 ||
      this.socketGeneration !== refresh.socketGeneration ||
      this.sessionScope !== refresh.sessionScope ||
      // Mirrors the gateway's own REAUTH envelope rule. A ticket it would refuse
      // costs an attempt here instead of costing the socket there.
      typeof ticket !== 'string' ||
      ticket.length < 32 ||
      ticket.length > 256 ||
      typeof deviceId !== 'string' ||
      deviceId.length === 0
    ) {
      await this.settleSessionRefresh('failed')
      return
    }
    const payload = { ticket, deviceId }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'REAUTH',
      requestId: refresh.commandId,
      commandId: refresh.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    if (frameByteLength(frame) > MAX_SYNC_FRAME_BYTES) {
      await this.settleSessionRefresh('failed')
      return
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
    } catch {
      await this.settleSessionRefresh('failed')
      return
    }
    if (this.sessionRefresh === refresh) {
      refresh.sent = true
    }
  }

  /**
   * Route a server frame that belongs to the refresh rather than to any lane.
   * Returns true when the frame was consumed.
   *
   * Two shapes arrive. The gateway's verdict on the refresh itself is addressed to
   * the REAUTH frame's own ids. A refusal that ENDS the socket is addressed to
   * `'protocol'` by `failAndClose`, and is believed only while our own REAUTH is
   * outstanding — `NOT_AUTHORIZED` is otherwise an ordinary per-command policy
   * denial, and mistaking one of those for a revocation would sign a lane off for
   * a vault the user merely cannot read.
   */
  private async handleSessionRefreshFrame(frame: SyncServerFrame): Promise<boolean> {
    const refresh = this.sessionRefresh
    if (!refresh) {
      return false
    }
    if (frame.commandId === refresh.commandId) {
      if (frame.type === 'REAUTHENTICATED') {
        await this.settleSessionRefresh(refresh.sent ? 'refreshed' : 'failed')
        return true
      }
      if (frame.type === 'ERROR') {
        if (frame.payload.code === 'OPERATION_UNAVAILABLE') {
          // This deployment composed no session revalidator. Structural.
          this.sessionRefreshUnsupported = true
        } else if (frame.payload.code === 'SESSION_STALE') {
          // We just minted a current credential and the session plane still would
          // not take it. Nothing is gained by presenting another one on this
          // socket, so the budget is spent rather than merely decremented.
          this.sessionRefreshAttempts = MAX_SESSION_REFRESH_ATTEMPTS
        }
        await this.settleSessionRefresh('failed')
        return true
      }
      return false
    }
    if (
      refresh.sent &&
      frame.type === 'ERROR' &&
      frame.commandId === SYNC_PROTOCOL_FRAME_ID &&
      frame.requestId === SYNC_PROTOCOL_FRAME_ID
    ) {
      if (frame.payload.code === 'NOT_AUTHORIZED') {
        await this.settleSessionRefresh('revoked')
        return true
      }
      if (frame.payload.code === 'REAUTH_REJECTED') {
        // Unknown, replayed, or not bound to this user, session and device. The
        // socket is already closing; never ask this session again.
        this.sessionRefreshUnsupported = true
        await this.settleSessionRefresh('failed')
        return true
      }
    }
    return false
  }

  /**
   * The gateway's LAST WORD before it closes the socket.
   *
   * `failAndClose` sends exactly one ERROR frame addressed `requestId = commandId =
   * 'protocol'` — it belongs to the connection, not to any command — and then
   * closes. The frame router matched that against no lane, fell through to the
   * outbox-commandId guard and returned, so the frame was consumed ONLY while
   * AUTHENTICATING or while a credential refresh was outstanding. At every other
   * moment `AUTH_TIMEOUT`, `BACKPRESSURE`, `SOCKET_LIMIT`, `OUT_OF_ORDER`,
   * `SEQUENCE_EXHAUSTED`, `SOCKET_BUDGET_LOST`, `INVITE_ACK_INVALID`,
   * `SYNC_DISABLED`, `INVALID_ENVELOPE` and `ALREADY_AUTHENTICATED` all vanished —
   * and the close that followed carried no cause either, so a dozen distinct
   * server decisions reached the user as a bare `SOCKET_CLOSED`.
   *
   * RECORDED rather than acted on, deliberately. The close is already on its way
   * and the close path already owns every lane riding this socket: it fails each
   * one and then either reconnects or falls back. What was missing was only the
   * CAUSE, and `syncCloseFallbackReason` prefers this code over the close code
   * precisely because 1008 collapses eleven causes onto one number.
   *
   * Ordered AFTER `handleSessionRefreshFrame`, which must keep first claim on a
   * protocol-addressed `NOT_AUTHORIZED`/`REAUTH_REJECTED` while its own REAUTH is
   * outstanding — that is the one case where the frame is a verdict about the
   * session and not merely an epitaph for the socket.
   */
  private async handleProtocolError(frame: SyncServerFrame): Promise<boolean> {
    if (
      frame.type !== 'ERROR' ||
      frame.commandId !== SYNC_PROTOCOL_FRAME_ID ||
      frame.requestId !== SYNC_PROTOCOL_FRAME_ID
    ) {
      return false
    }
    if (typeof frame.payload.code === 'string') {
      this.protocolErrorCode = frame.payload.code
    }
    if (this.state === 'AUTHENTICATING') {
      // The handshake's own refusal, which already had a path: the ticket is spent
      // and the request belongs on HTTP. Behaviour unchanged on purpose — only the
      // close attribution that follows it is new.
      await this.fallback('auth-failed', this.outboxRecord)
    }
    return true
  }

  /**
   * End the refresh and hand every parked operation its outcome.
   *
   * `revoked` is the only outcome that says anything about the session, and only
   * the gateway can produce it: a failed ticket mint, a timeout or an unreadable
   * answer are all `failed`, because an auth blip must never be able to sign a
   * user out. It is also latched, because a revoked session cannot be refreshed
   * by trying harder.
   */
  private async settleSessionRefresh(outcome: 'refreshed' | 'failed' | 'revoked'): Promise<void> {
    const refresh = this.sessionRefresh
    if (!refresh) {
      return
    }
    this.sessionRefresh = undefined
    if (refresh.timer) {
      this.cancelTimeout(refresh.timer)
      refresh.timer = undefined
    }
    if (outcome === 'revoked') {
      this.sessionRefreshUnsupported = true
      this.dependencies.postMessage({ type: 'SESSION_NOT_AUTHORIZED', sessionScope: refresh.sessionScope })
    }
    for (const parked of refresh.parked) {
      if (parked.kind === 'rpc') {
        await this.resumeRefreshedRpc(parked.clientRequestId, outcome)
      } else if (parked.kind === 'collaboration') {
        await this.resumeRefreshedCollaboration(parked.clientRequestId, outcome)
      } else if (parked.kind === 'command') {
        await this.resumeRefreshedCommand(outcome)
      }
      // `socket` parks nothing to resume: the credential was the whole point, and
      // the operation that asked was already answered on its own path.
    }
  }

  /**
   * Abandon a refresh without resuming anything, because the socket it belonged to
   * is gone.
   *
   * Deliberately NOT a `settleSessionRefresh('failed')`: the close path already
   * owns every operation on this socket and settles each one correctly — the
   * command through its retained outbox record (reconnect, then STATUS) and an
   * unsent RPC through the reconnect bootstrap that re-sends it. Resuming here as
   * well would have two owners racing for the same operation.
   */
  private discardSessionRefresh(): void {
    const refresh = this.sessionRefresh
    if (!refresh) {
      return
    }
    this.sessionRefresh = undefined
    if (refresh.timer) {
      this.cancelTimeout(refresh.timer)
      refresh.timer = undefined
    }
    for (const parked of refresh.parked) {
      if (parked.kind === 'rpc') {
        const rpc = this.rpcRequests.get(parked.clientRequestId)
        if (rpc) {
          // The withheld answer came from a socket that no longer exists, so it is
          // not an answer any more. The request itself is intact and unsent.
          rpc.deferredResponse = undefined
        }
      }
    }
  }

  /**
   * Resume the durable SYNC_ITEMS command the refusal belonged to.
   *
   * On success this sends STATUS and nothing else. That is written out here rather
   * than delegated to `prepareActiveCommand` so the no-double-apply property is
   * LOCAL: there is no branch at this call site that can mint or re-send a COMMAND
   * frame, whatever the rest of the state machine grows into. The command id and
   * digest are the server journal's idempotency identity and both are reused
   * verbatim, so a committed command is answered with its result, one the backend
   * confirms `UNKNOWN` is replayed over the identity-bearing HTTP path, and an
   * `ACCEPTED` one keeps waiting.
   *
   * On failure this is the behaviour that existed before an in-place refresh was
   * possible: one re-ticket for the request, and durable recovery after that.
   * `RECOVERY_REQUIRED` rejects the caller's promise, which is a real failure the
   * sync service handles — the command stays in the outbox and is reconciled
   * through STATUS by the next recovery, so it is never dropped.
   */
  private async resumeRefreshedCommand(outcome: 'refreshed' | 'failed' | 'revoked'): Promise<void> {
    const active = this.active
    if (!active || (active.mode !== 'execute' && active.mode !== 'recover')) {
      return
    }
    if (outcome === 'refreshed' && this.state === 'READY' && this.socket?.readyState === 1) {
      const record = this.outboxRecord
      if (record && record.sessionScope === active.sessionScope && record.revoked !== true) {
        try {
          await this.sendStatus(record)
        } catch {
          await this.fallback('server-kill', record)
        }
        return
      }
      // No durable record left to ask STATUS about, which is unreachable for a
      // command that was actually refused — only a record that exists can match the
      // refusing frame's id. Surfaced rather than trusted: `fallback` sends a
      // dispatched command to durable recovery and an undispatched one to the
      // identity-bearing HTTP replay. Minting a replacement command here would be
      // the one move that could apply a mutation twice.
      await this.fallback('server-kill', record)
      return
    }
    if (outcome === 'failed' && !this.reticketedForStaleSession && this.socket?.readyState === 1) {
      this.reticketedForStaleSession = true
      await this.reticket()
      return
    }
    // `server-kill` rather than a reason of its own: `fallback` routes a dispatched
    // command to durable recovery regardless of reason, and an undispatched one to
    // the identity-bearing HTTP replay. Inventing a reason here would only change
    // the diagnostic wording while both of those stay the same.
    await this.fallback('server-kill', this.outboxRecord)
  }

  /**
   * Resume the collaboration authorization the gateway refused `SESSION_STALE`.
   *
   * A fresh `commandId` and one more `AUTHORIZE_COLLABORATION` on the SAME socket,
   * from whichever phase the refusal interrupted — exactly what the
   * `CHALLENGE_EXPIRED` retry beside it already does, and for the same reason: the
   * refusal was a verdict on the credential, not on the request.
   *
   * There is no idempotency question here. Collaboration authorization is a grant
   * query, not a mutation: a discovery challenge is one-use and a grant that was
   * refused granted nothing, so re-asking cannot apply anything twice.
   */
  private async resumeRefreshedCollaboration(
    clientRequestId: string,
    outcome: 'refreshed' | 'failed' | 'revoked',
  ): Promise<void> {
    const active = this.active
    if (!active || active.mode !== 'collaboration' || active.clientRequestId !== clientRequestId) {
      // Cancelled or settled while parked; whatever did that already answered it.
      return
    }
    if (outcome === 'refreshed' && this.state === 'READY' && this.socket?.readyState === 1) {
      active.commandId = this.uuid()
      await this.sendCollaborationAuthorization()
      return
    }
    // The pre-existing behaviour, unchanged: the caller is told to use HTTP and the
    // socket goes, because a credential this socket cannot repair is one only a new
    // ticket can replace.
    await this.fallbackCollaboration('server-kill', false)
  }

  /**
   * Repair the socket's credential with nothing parked on the outcome.
   *
   * *** ONE MECHANISM, NOT THREE NEAR-DUPLICATES. *** Four lanes ride one socket and
   * only two of them can replay their own refusal. The rest — the file transfers,
   * and an RPC whose refusal is not safe to retry in place — must still be able to
   * say "the credential this connection is replaying is stale", or the next request
   * on every lane is refused the same way and the only cure is a reconnect that
   * discards the rooms, the invite subscription, the command lease, the socket budget
   * and every in-flight transfer.
   *
   * Returns whether a refresh is now running, which callers use only to decide how to
   * describe the refusal they are about to report — never to withhold it.
   */
  private refreshSocketCredential(): boolean {
    return this.requestSessionRefresh({ kind: 'socket' })
  }

  /**
   * Resume — or honestly refuse — the RPC whose 401/498 triggered the refresh.
   *
   * The retry is a fresh frame with a NEW `commandId` and the SAME request object.
   * That ordering is not cosmetic: the gateway refuses a second RPC bearing an
   * idempotency key it has already seen on this socket (`DUPLICATE_REQUEST`), so
   * only a request carrying no key can be retried in place at all — which is why
   * `parkRpcForSessionRefresh` admits GET and nothing else. A new `commandId`
   * keeps the frames unambiguous and cannot defeat a dedupe that is keyed on the
   * absent idempotency key.
   */
  private async resumeRefreshedRpc(
    clientRequestId: string,
    outcome: 'refreshed' | 'failed' | 'revoked',
  ): Promise<void> {
    const rpc = this.rpcRequests.get(clientRequestId)
    if (!rpc) {
      // Cancelled, deadlined or failed while parked. Already settled for its caller.
      return
    }
    const deferred = rpc.deferredResponse
    rpc.deferredResponse = undefined
    if (
      outcome === 'refreshed' &&
      this.state === 'READY' &&
      this.socket?.readyState === 1 &&
      rpc.sessionScope === this.sessionScope
    ) {
      rpc.sent = false
      rpc.accepted = false
      rpc.responseStarted = false
      rpc.expectedChunkIndex = 0
      await this.sendRpc(rpc)
      return
    }
    if (!deferred) {
      this.failRpc(rpc, 'SESSION_STALE', true, true)
      return
    }
    // Deliver the answer that was withheld, exactly as it would have arrived. The
    // caller's own handling of a 401/498 — degrade this read to HTTP — is the net
    // that kept working before this lane could refresh at all, and a refresh that
    // did not succeed must leave it intact.
    rpc.responseStarted = true
    this.dependencies.postMessage({
      type: 'RPC_RESPONSE',
      clientRequestId: rpc.clientRequestId,
      status: deferred.status,
      headers: deferred.headers,
      stream: false,
      ...(deferred.hasBody ? { body: deferred.body } : {}),
    })
    this.dependencies.postMessage({ type: 'RPC_END', clientRequestId: rpc.clientRequestId })
    this.finishRpc(rpc)
  }

  /**
   * Withhold a refusing API_RPC response and ask for a refresh, or decline.
   *
   * ADMITTED: a non-streaming GET with no idempotency key whose response has not
   * started, answered 401 or 498, not already refreshed once. Nothing else.
   *
   *   - GET only, and no idempotency key. For a mutation the client cannot
   *     establish whether the refused request was applied, and a replay carrying
   *     the same key is refused `DUPLICATE_REQUEST` by the gateway anyway, so
   *     there is no safe retry to attempt — it is surfaced instead.
   *   - Non-streaming only. The whole answer is then in this one frame and can be
   *     delivered verbatim later; a stream's refusal body arrives as chunks that
   *     would be dropped with the abandoned `commandId`, turning a withheld 401
   *     into an empty 401.
   *   - Before `responseStarted`. Nothing has crossed to the main thread, so the
   *     retry is invisible to the caller rather than a second response.
   *
   * The `commandId` is retired HERE rather than at retry time. The gateway always
   * follows a response with `RPC_END`, and that trailer must not find a request
   * whose response it believes has not started — that is reported as
   * `INVALID_RESPONSE` and would kill the request the refresh is trying to save.
   * Retired, the trailer matches nothing and is dropped, which is what the frame
   * router already does with every unaddressed frame.
   */
  private parkRpcForSessionRefresh(rpc: ActiveRpcRequest, frame: SyncServerFrame): boolean {
    if (
      rpc.responseStarted ||
      rpc.refreshRetried === true ||
      rpc.request.method !== 'GET' ||
      rpc.request.idempotencyKey !== undefined ||
      frame.payload.stream !== false ||
      !Number.isSafeInteger(frame.payload.status) ||
      !REFRESHABLE_RPC_STATUSES.has(Number(frame.payload.status)) ||
      !isStringRecord(frame.payload.headers) ||
      !this.canRefreshSession()
    ) {
      return false
    }
    // Asked BEFORE anything on the request is touched: a refusal to refresh must
    // leave the response to be delivered the ordinary way, and retiring the
    // `commandId` first would strand the caller on a trailer that matches nothing.
    if (!this.requestSessionRefresh({ kind: 'rpc', clientRequestId: rpc.clientRequestId })) {
      return false
    }
    rpc.refreshRetried = true
    rpc.deferredResponse = {
      status: Number(frame.payload.status),
      headers: frame.payload.headers,
      hasBody: Object.hasOwn(frame.payload, 'body'),
      ...(Object.hasOwn(frame.payload, 'body') ? { body: frame.payload.body } : {}),
    }
    rpc.commandId = this.uuid()
    rpc.sent = false
    rpc.accepted = false
    rpc.expectedChunkIndex = 0
    return true
  }

  private async prepareActiveRequest(): Promise<void> {
    if (this.active?.mode === 'invite-bootstrap') {
      this.active = undefined
      return
    }
    if (this.active?.mode === 'rpc-bootstrap') {
      this.active = undefined
      await this.sendReadyRpcRequests()
      return
    }
    if (this.active?.mode === 'collaboration') {
      await this.sendCollaborationAuthorization()
      return
    }
    await this.prepareActiveCommand()
  }

  private async sendInviteSubscription(subscription: ActiveInviteSubscription): Promise<void> {
    if (this.inviteSubscription !== subscription || this.state !== 'READY' || this.socket?.readyState !== 1) {
      return
    }
    if (!this.negotiatedOperations.has('INVITE_EVENTS')) {
      // The gateway advertises this lane whenever its invite store is ready for
      // the session, so a socket that reached READY without it describes a
      // deployment that does not serve it — not a moment that will pass.
      // Reported as retryable, the durable coordinator re-dialled every 30 s for
      // the life of the tab against a socket that would never carry the lane.
      this.inviteEventsUnavailable = true
      this.failInviteSubscription(subscription, 'OPERATION_UNAVAILABLE', false)
      return
    }
    const payload = {
      ...(subscription.cursor === undefined ? {} : { cursor: subscription.cursor }),
      limit: subscription.limit,
    }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'INVITE_SUBSCRIBE',
      requestId: subscription.commandId,
      commandId: subscription.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
      if (this.inviteSubscription === subscription) {
        subscription.sent = true
        subscription.settled = false
        // The lane is open again: whatever ownership the watch was waiting for has
        // transferred, so stop looking.
        this.cancelDeferredInviteWatch()
      }
    } catch {
      this.dependencies.postMessage({
        type: 'INVITE_ERROR',
        clientRequestId: subscription.clientRequestId,
        code: 'SOCKET_CLOSED',
        retryable: true,
      })
    }
  }

  private handleInviteServerFrame(subscription: ActiveInviteSubscription, frame: SyncServerFrame): void {
    switch (frame.type) {
      case 'INVITE_READY':
        if (!isOpaqueCursor(frame.payload.cursor) || frame.payload.cursor !== subscription.cursor) {
          this.failInviteSubscription(subscription, 'INVALID_RESPONSE', false)
          return
        }
        this.dependencies.postMessage({
          type: 'INVITE_READY',
          clientRequestId: subscription.clientRequestId,
          cursor: frame.payload.cursor,
        })
        return
      case 'INVITE_BATCH':
        if (!isInviteRealtimeBatch(frame.payload) || frame.payload.previousCursor !== subscription.cursor) {
          this.failInviteSubscription(subscription, 'INVALID_RESPONSE', false)
          return
        }
        if (subscription.awaitingAck !== undefined) {
          if (subscription.awaitingAck !== frame.payload.nextCursor) {
            this.failInviteSubscription(subscription, 'INVALID_RESPONSE', false)
            return
          }
          // Reconnect may replay the still-unacknowledged batch while the main
          // thread is applying it. Do not deliver a duplicate. If application
          // already completed while disconnected, acknowledge this replay now.
          void this.sendInviteAckIfReady(subscription)
          return
        }
        subscription.awaitingAck = frame.payload.nextCursor
        subscription.ackReady = false
        this.dependencies.postMessage({
          type: 'INVITE_BATCH',
          clientRequestId: subscription.clientRequestId,
          batch: frame.payload,
        })
        return
      case 'INVITE_RECONCILE':
        if (
          !isOpaqueCursor(frame.payload.cursor) ||
          (frame.payload.reason !== 'BOOTSTRAP_REQUIRED' &&
            frame.payload.reason !== 'CURSOR_EXPIRED' &&
            frame.payload.reason !== 'CURSOR_INVALID')
        ) {
          this.failInviteSubscription(subscription, 'INVALID_RESPONSE', false)
          return
        }
        subscription.sent = false
        subscription.awaitingAck = undefined
        subscription.ackReady = undefined
        this.dependencies.postMessage({
          type: 'INVITE_RECONCILE',
          clientRequestId: subscription.clientRequestId,
          reason: frame.payload.reason,
          cursor: frame.payload.cursor,
        })
        return
      case 'ERROR':
        this.failInviteSubscription(
          subscription,
          typeof frame.payload.code === 'string' ? frame.payload.code : 'INVITE_ERROR',
          frame.payload.retryable === true,
        )
        return
      default:
        return
    }
  }

  /**
   * Tell an invite subscription's owner that the lane is not carrying it right now.
   *
   * *** ONE PLACE, BECAUSE THERE ARE TWO RIGHT ANSWERS AND THE TEARDOWN PATH HAD
   * NEITHER. ***
   *
   *   - A `deferred` cause is not a failure: another tab of this account holds the
   *     lane and will hand it back. The subscription stays REGISTERED so the
   *     `AUTHENTICATED` handler re-sends it the moment any lane wins the lease, and
   *     the owner is told to park. Reported as a retryable `INVITE_ERROR` this drove
   *     one reconnect, one console failure line and one DEGRADED transition per
   *     coordinator backoff tick, forever — and `surrenderOwnership` closes the
   *     socket for exactly that cause, so a teardown reaching for the error shape
   *     would have brought it straight back.
   *   - Anything else is an `INVITE_ERROR`, and `retryable` decides between the
   *     coordinator's backoff and a permanent stand-down. A structurally absent
   *     capability must not be retryable; a socket that was simply torn down must be.
   *
   * `INVITE_ERROR` is also the ONLY signal that disposes the subscription on the main
   * thread: `handleTransportError` is the one path in the coordinator that clears its
   * `session.connection` symbol, and until that happens `hasLiveSubscription()`
   * answers true and the re-arm on `online` / `visibilitychange` returns at its first
   * line.
   *
   * Idempotent through `settled`, so a caller that has already answered for this
   * subscription is never spoken over by the teardown that follows it.
   */
  private settleInviteSubscription(
    subscription: ActiveInviteSubscription,
    reason: SyncFallbackReason | undefined,
  ): void {
    if (subscription.settled === true) {
      return
    }
    subscription.settled = true
    subscription.sent = false
    const disposition = reason === undefined ? 'retryable' : syncFallbackDisposition(reason)
    if (disposition === 'deferred' && reason !== undefined) {
      this.dependencies.postMessage({
        type: 'INVITE_DEFERRED',
        clientRequestId: subscription.clientRequestId,
        reason,
        resumeAfterMilliseconds: OWNER_LEASE_TTL_MS,
      })
      this.beginDeferredInviteWatch()
      return
    }
    const retryable = disposition === 'retryable'
    this.dependencies.postMessage({
      type: 'INVITE_ERROR',
      clientRequestId: subscription.clientRequestId,
      // No reason means the socket went away without one naming it, which is what
      // every teardown that is not a fallback looks like.
      code: reason === undefined ? 'SOCKET_CLOSED' : reason.toUpperCase().replaceAll('-', '_'),
      retryable,
    })
    if (!retryable && this.inviteSubscription === subscription) {
      this.inviteSubscription = undefined
      this.cancelDeferredInviteWatch()
    }
  }

  private failInviteSubscription(subscription: ActiveInviteSubscription, code: string, retryable: boolean): void {
    subscription.settled = true
    this.dependencies.postMessage({
      type: 'INVITE_ERROR',
      clientRequestId: subscription.clientRequestId,
      code,
      retryable,
    })
    if (!retryable && this.inviteSubscription === subscription) {
      this.inviteSubscription = undefined
      this.cancelDeferredInviteWatch()
    }
  }

  private async sendReadyRpcRequests(): Promise<void> {
    if (this.state !== 'READY' || this.socket?.readyState !== 1) {
      return
    }
    for (const rpc of this.rpcRequests.values()) {
      if (!rpc.sent && rpc.sessionScope === this.sessionScope) {
        await this.sendRpc(rpc)
      }
    }
  }

  private async sendRpc(rpc: ActiveRpcRequest): Promise<void> {
    if (rpc.sent || !this.negotiatedOperations.has('API_RPC')) {
      if (!this.negotiatedOperations.has('API_RPC')) {
        this.failRpc(rpc, 'OPERATION_UNAVAILABLE', true, true)
      }
      return
    }
    const payload = {
      method: rpc.request.method,
      path: rpc.request.path,
      deadlineMs: rpc.request.deadlineMs,
      initialCreditBytes: rpc.request.initialCreditBytes ?? DEFAULT_RPC_CREDIT_BYTES,
      stream: rpc.request.stream,
      ...(rpc.request.headers ? { headers: rpc.request.headers } : {}),
      ...(Object.hasOwn(rpc.request, 'body') ? { body: rpc.request.body } : {}),
      ...(rpc.request.idempotencyKey ? { idempotencyKey: rpc.request.idempotencyKey } : {}),
    }
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'RPC_REQUEST',
      requestId: rpc.commandId,
      commandId: rpc.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    if (frameByteLength(frame) > MAX_SYNC_FRAME_BYTES) {
      this.failRpc(rpc, 'FRAME_TOO_LARGE', false, true)
      return
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
      rpc.sent = true
    } catch {
      this.failRpc(rpc, 'SOCKET_CLOSED', true, false)
    }
  }

  private handleRpcServerFrame(rpc: ActiveRpcRequest, frame: SyncServerFrame): void {
    switch (frame.type) {
      case 'RPC_ACCEPTED':
        if (!rpc.accepted) {
          rpc.accepted = true
          this.dependencies.postMessage({ type: 'RPC_ACCEPTED', clientRequestId: rpc.clientRequestId })
        }
        break
      case 'RPC_RESPONSE': {
        if (
          !rpc.accepted ||
          rpc.responseStarted ||
          !Number.isSafeInteger(frame.payload.status) ||
          Number(frame.payload.status) < 100 ||
          Number(frame.payload.status) > 599 ||
          typeof frame.payload.stream !== 'boolean' ||
          !isStringRecord(frame.payload.headers)
        ) {
          this.failRpc(rpc, 'INVALID_RESPONSE', false, false)
          return
        }
        // Only sync emits SESSION_STALE. API_RPC reports a rotated credential as a
        // 401/498 RESPONSE, so a client driven by SESSION_STALE alone never notices
        // one here — which is how an admin read over this lane could 401 while the
        // socket looked healthy. Withheld, refreshed and retried where that is
        // provably safe; delivered untouched where it is not.
        if (this.parkRpcForSessionRefresh(rpc, frame)) {
          return
        }
        // *** A SUCCESS-SHAPED FRAME CARRYING A FAILURE STATUS. ***
        //
        // The park above withholds and retries a 401/498 only where that is provably
        // safe: a non-streaming keyless GET whose answer has not started. Everything
        // else — a stream (and the gateway streams whenever its adapter hands back a
        // stream, whatever the request asked for), a mutation, a second refusal for
        // the same request — was delivered verbatim and NOTHING asked for a refresh.
        // Measured live: after `POST /v1/sessions/refresh` the lane answered 498
        // forever in 4/4 runs, while the REAUTH that repairs it takes 21-30 ms.
        //
        // The status is a statement about the SOCKET's frozen credential, not about
        // the one request that happened to see it, so the connection is repaired even
        // when this request cannot be replayed — otherwise the four lanes that never
        // see an RPC status at all stay stranded on it. The response is still
        // delivered unchanged: `WebApplication.controlPlaneRpc` degrades a 401/498 GET
        // to HTTP on purpose, and that net must keep working while the repair runs.
        //
        // It cannot spin: the refresh budget is per socket and nothing but a new
        // handshake replenishes it.
        if (Number.isSafeInteger(frame.payload.status) && REFRESHABLE_RPC_STATUSES.has(Number(frame.payload.status))) {
          this.refreshSocketCredential()
        }
        rpc.responseStarted = true
        this.dependencies.postMessage({
          type: 'RPC_RESPONSE',
          clientRequestId: rpc.clientRequestId,
          status: Number(frame.payload.status),
          headers: frame.payload.headers,
          stream: frame.payload.stream,
          ...(Object.hasOwn(frame.payload, 'body') ? { body: frame.payload.body } : {}),
        })
        break
      }
      case 'RPC_CHUNK': {
        const bytes = frame.payload.bytes
        const byteLength = frame.payload.byteLength
        const index = frame.payload.index
        if (
          !rpc.responseStarted ||
          typeof bytes !== 'string' ||
          !Number.isSafeInteger(byteLength) ||
          Number(byteLength) < 0 ||
          Number(byteLength) > 64 * 1024 ||
          !Number.isSafeInteger(index) ||
          Number(index) !== rpc.expectedChunkIndex ||
          decodedBase64Length(bytes) !== Number(byteLength)
        ) {
          this.failRpc(rpc, 'INVALID_RESPONSE', false, false)
          return
        }
        rpc.expectedChunkIndex += 1
        this.dependencies.postMessage({
          type: 'RPC_CHUNK',
          clientRequestId: rpc.clientRequestId,
          bytes,
          byteLength: Number(byteLength),
        })
        break
      }
      case 'RPC_END':
        if (!rpc.responseStarted) {
          this.failRpc(rpc, 'INVALID_RESPONSE', false, false)
          return
        }
        this.dependencies.postMessage({ type: 'RPC_END', clientRequestId: rpc.clientRequestId })
        this.finishRpc(rpc)
        break
      case 'ERROR': {
        const code = typeof frame.payload.code === 'string' ? frame.payload.code : 'RPC_ERROR'
        // NOT a flat `false`. That answered "never fall back" for a refusal the
        // gateway raised before dispatching anything, so a control-plane read the
        // HTTP leg would have served threw at its caller instead.
        this.failRpc(rpc, code, frame.payload.retryable === true, this.rpcRefusalIsSafeToFallback(rpc, code))
        break
      }
      default:
        break
    }
  }

  /**
   * May HTTP be asked the same question?
   *
   * Two tiers, and the line between them is whether the request reached a handler.
   * A pre-dispatch refusal provably had no effect. A post-dispatch one may have, so
   * it is answered for a GET and nothing else — the gateway requires an idempotency
   * key on every other method precisely because their effect is not knowable from
   * the client, and `isValidWorkerRpcRequest` enforces that this lane only ever
   * carries a keyless request when it is a GET.
   */
  private rpcRefusalIsSafeToFallback(rpc: ActiveRpcRequest, code: string): boolean {
    if (rpc.responseStarted) {
      // Bytes already crossed to the main thread; a second answer is not a fallback.
      return false
    }
    if (PRE_DISPATCH_RPC_REFUSAL_CODES.has(code)) {
      return true
    }
    return rpc.request.method === 'GET' && POST_DISPATCH_READ_RETRYABLE_RPC_CODES.has(code)
  }

  private rpcByCommandId(commandId: string): ActiveRpcRequest | undefined {
    for (const rpc of this.rpcRequests.values()) {
      if (rpc.commandId === commandId) {
        return rpc
      }
    }
    return undefined
  }

  private failRpc(rpc: ActiveRpcRequest, code: string, retryable: boolean, safeToFallback: boolean): void {
    this.dependencies.postMessage({
      type: 'RPC_ERROR',
      clientRequestId: rpc.clientRequestId,
      code,
      retryable,
      safeToFallback,
    })
    this.finishRpc(rpc)
  }

  private finishRpc(rpc: ActiveRpcRequest): void {
    if (rpc.deadlineTimer) {
      this.cancelTimeout(rpc.deadlineTimer)
    }
    this.rpcRequests.delete(rpc.clientRequestId)
  }

  private async sendCollaborationAuthorization(): Promise<void> {
    const active = this.active
    const socketGeneration = this.socketGeneration
    if (
      !active ||
      active.mode !== 'collaboration' ||
      !this.transportScope ||
      !this.sessionScope ||
      active.sessionScope !== this.sessionScope ||
      this.state !== 'READY'
    ) {
      return
    }
    if (!this.negotiatedOperations.has('AUTHORIZE_COLLABORATION')) {
      await this.fallbackCollaboration('operation-unavailable', true)
      return
    }
    if (active.socketGeneration !== undefined && active.socketGeneration !== socketGeneration) {
      await this.fallbackCollaboration('reconnect-gap', false)
      return
    }
    active.socketGeneration = socketGeneration
    let payload: Record<string, unknown>
    if (active.phase === 'discovery') {
      payload = {
        noteUuid: active.request.noteUuid,
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
      }
    } else {
      const discovery = active.discovery
      if (!discovery || discovery.expiresAt <= this.now()) {
        await this.fallbackCollaboration('proxy-failed', false)
        return
      }
      payload = {
        noteUuid: active.request.noteUuid,
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: discovery.roomEpoch,
        epochDiscoveryChallenge: discovery.challenge,
        epochDiscoveryRequestId: discovery.requestId,
        ...(active.request.leaseRequestId ? { leaseRequestId: active.request.leaseRequestId } : {}),
        ...(active.request.bootstrapChallenge ? { bootstrapChallenge: active.request.bootstrapChallenge } : {}),
      }
    }
    const requestId = this.uuid()
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'COLLABORATION_AUTHORIZE',
      requestId,
      commandId: active.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
    }
    if (frameByteLength(frame) > MAX_SYNC_FRAME_BYTES) {
      await this.fallbackCollaboration('frame-too-large', true)
      return
    }
    try {
      await this.sendWithBackpressure(JSON.stringify(frame))
      this.startAckDeadline(COMMAND_ACK_TIMEOUT_MS)
    } catch {
      await this.fallbackCollaboration('proxy-failed', false)
    }
  }

  private async prepareActiveCommand(): Promise<void> {
    const active = this.active
    if (
      !active ||
      (active.mode !== 'execute' && active.mode !== 'recover') ||
      !this.transportScope ||
      !this.sessionScope ||
      this.state !== 'READY'
    ) {
      return
    }
    // The per-operation guard SYNC_ITEMS never had, matching the ones already
    // on INVITE_EVENTS, API_RPC, AUTHORIZE_COLLABORATION and FILES_V1. When the
    // server binds no durable command port it advertises everything else and
    // omits this one; items then sync over HTTP while the socket keeps serving
    // its other lanes.
    //
    // `preserveHealthySocket` is true because nothing is wrong with the socket
    // -- closing it here would drop the four lanes that ARE working, which is
    // the whole defect this change exists to fix. `confirmedNoSideEffect` is
    // true because we refuse before writing a frame, so no command can be in
    // flight; `fallback` still attaches any pre-existing outbox metadata so the
    // HTTP path can resolve a command left over from an earlier connection.
    //
    // The reason is `operation-unavailable`, deliberately NOT
    // `capability-unavailable`: the latter is a PERMANENT fallback reason that
    // tells long-lived consumers to stand down and stop reconnecting, which is
    // wrong for a socket that is up and healthy.
    if (!this.negotiatedOperations.has('SYNC_ITEMS')) {
      await this.fallback('operation-unavailable', undefined, true, true)
      return
    }
    // The server already told this session that item sync is off for the account.
    // A recovered record still carries its identity so the HTTP replay is idempotent.
    if (this.liveSyncDisabled) {
      await this.fallback('live-sync-disabled', this.outboxRecord, true, true)
      return
    }
    try {
      if (active.mode === 'recover') {
        const record = this.outboxRecord
        if (!record || record.sessionScope !== active.sessionScope || record.revoked === true) {
          this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId: active.clientRequestId })
          await this.closeSocketAndReleaseOwner()
          this.active = undefined
          return
        }
        await this.sendStatus(record)
        return
      }

      if (
        this.outboxRecord &&
        this.outboxRecord.sessionScope === active.sessionScope &&
        this.outboxRecord.revoked !== true
      ) {
        await this.sendStatus(this.outboxRecord)
        return
      }

      const stale = await this.outbox.oldest(active.sessionScope)
      if (stale) {
        this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId: active.clientRequestId })
        this.active = undefined
        await this.closeSocketAndReleaseOwner()
        return
      }

      const digest = await digestSyncBody(active.body, this.subtle)
      const payload = { command: 'SYNC_ITEMS' as const, body: active.body }
      const operationId = validOperationId(active.context?.operationId) ? active.context.operationId : undefined
      const operationIndex = validOperationIndex(active.context?.operationIndex) ? active.context.operationIndex : 0
      const stableCommandId = operationId
        ? operationIndex === 0
          ? operationId
          : `${operationId}:${operationIndex}`
        : undefined
      const frame: SyncClientFrame = {
        version: SYNC_PROTOCOL_VERSION,
        channel: SYNC_CHANNEL,
        type: 'COMMAND',
        requestId: this.uuid(),
        commandId: stableCommandId ?? this.uuid(),
        sequence: this.sequence++,
        payloadLength: payloadByteLength(payload),
        payload,
        digest,
      }
      if (frameByteLength(frame) > MAX_SYNC_FRAME_BYTES) {
        await this.fallback('frame-too-large', undefined, true)
        return
      }
      const record: SyncOutboxRecord = {
        sessionScope: active.sessionScope,
        transportScope: this.transportScope,
        commandId: frame.commandId,
        digest,
        sequence: frame.sequence,
        bytes: JSON.stringify(frame),
        createdAt: this.now(),
        ...(operationId ? { operationId } : {}),
      }
      await this.outbox.put(record)
      this.outboxRecord = record
      this.dependencies.postMessage({
        type: 'COMMAND_PERSISTED',
        clientRequestId: active.clientRequestId,
        body: active.body,
        command: {
          id: record.commandId,
          digest: record.digest,
          sequence: record.sequence,
          ...(record.operationId ? { operationId: record.operationId } : {}),
        },
      })
      // Persist the ambiguous-dispatch boundary before calling WebSocket.send.
      // A crash after this write but before the call is conservatively recovered
      // through STATUS; it can never create a duplicate HTTP owner.
      const dispatchingRecord: SyncOutboxRecord = { ...record, dispatchedAt: this.now() }
      await this.outbox.put(dispatchingRecord)
      this.outboxRecord = dispatchingRecord
      this.commandSent = true
      await this.sendWithBackpressure(dispatchingRecord.bytes)
      this.startAckDeadline(COMMAND_ACK_TIMEOUT_MS)
    } catch (error) {
      // Two different faults used to arrive here as one. An outbox write that fails
      // is `outbox-unavailable`; a send buffer that will not drain is the client
      // outrunning its socket, which is what `'backpressure'` is for and what
      // nothing in this build was able to report.
      await this.fallback(
        error instanceof SyncBackpressureError ? 'backpressure' : 'outbox-unavailable',
        this.outboxRecord,
      )
    }
  }

  /**
   * Standard Red Notes: a retryable refusal must not cost the socket.
   *
   * -------------------------------------------------------------------------------
   * WHAT THIS REPLACES
   * -------------------------------------------------------------------------------
   *
   * Nine distinct gateway refusals — BUSY, LEASE_LOST, BACKEND_TIMEOUT,
   * BACKEND_ERROR, COMMAND_ID_CONFLICT, READ_ONLY, CONTENT_LIMIT,
   * SHARED_VAULT_FORBIDDEN and NOT_AUTHORIZED — all fell through to one ERROR
   * default: `fallback('server-kill')`, which means durable recovery, a closed
   * socket, and all six lanes lost. Two of them describe a HEALTHY socket the
   * gateway expects to be used again, and those two are handled here. The other
   * seven are stable policy answers that a retry would only reproduce, so they keep
   * the existing path.
   *
   * -------------------------------------------------------------------------------
   * TWO TIERS, AND THE LINE BETWEEN THEM IS THE DURABLE WRITE
   * -------------------------------------------------------------------------------
   *
   * `BUSY` is sent INSTEAD of dispatching, so the identical COMMAND frame may be
   * sent again. `BACKEND_TIMEOUT` comes out of the `catch` around `backend.execute`,
   * so the write may have landed and only STATUS may be asked. Both reuse the SAME
   * command id and digest, which are the server journal's idempotency identity, so
   * neither tier can apply anything twice.
   *
   * *** THE SEQUENCE NUMBER IS WHY THE FRAME IS REBUILT. *** The stored outbox bytes
   * carry the sequence the frame was first sent with, and the gateway closes the
   * socket `OUT_OF_ORDER` on any frame whose sequence is not the next one it expects.
   * Replaying the stored bytes verbatim would therefore destroy the very socket this
   * exists to keep.
   *
   * Synchronous on purpose: it only arms a timer, and an `await` here would add a
   * microtask to the frame handler, which is enough to push a later `postMessage`
   * past what a caller's flush is waiting for.
   */
  private retryRefusedCommand(code: unknown): boolean {
    if (typeof code !== 'string') {
      return false
    }
    if (!RESENDABLE_COMMAND_REFUSAL_CODES.has(code) && !RESTATABLE_COMMAND_REFUSAL_CODES.has(code)) {
      return false
    }
    const active = this.active
    const record = this.outboxRecord
    if (
      !active ||
      (active.mode !== 'execute' && active.mode !== 'recover') ||
      !record ||
      record.sessionScope !== active.sessionScope ||
      record.revoked === true ||
      this.state !== 'READY' ||
      this.socket?.readyState !== 1 ||
      this.commandRefusalRetries >= MAX_COMMAND_REFUSAL_RETRIES
    ) {
      return false
    }
    // *** `recover` NEVER RE-SENDS A COMMAND. *** That mode only ever put a STATUS on
    // the wire, so a resend would introduce a command frame for an operation already
    // in durable recovery — the one move that could apply a mutation twice. The
    // gateway takes no lease for a STATUS and so cannot answer it BUSY, which makes
    // this a local guarantee rather than a reachable branch; it is written out so the
    // property does not depend on reading another package's control flow.
    const resend = RESENDABLE_COMMAND_REFUSAL_CODES.has(code) && active.mode === 'execute'
    this.commandRefusalRetries += 1
    const attempt = this.commandRefusalRetries
    // The refusal arrived instead of the ack this deadline was waiting for, and the
    // retry owns the next one. Left armed it would close the healthy socket at the
    // first refusal, which is the behaviour being removed.
    this.clearAckDeadline()
    const generation = this.socketGeneration
    this.commandRetryTimeout = this.scheduleTimeout(() => {
      this.commandRetryTimeout = undefined
      void this.sendRefusedCommandAgain(record, resend, generation)
    }, COMMAND_REFUSAL_RETRY_DELAY_MS * attempt)
    return true
  }

  /**
   * Put the refused command back on the SAME socket.
   *
   * Every guard is a refusal to act, not a precondition to arrange: anything that
   * moved the socket or the command while the backoff ran already owns the command
   * and settles it on a path that existed before this did.
   */
  private async sendRefusedCommandAgain(
    record: SyncOutboxRecord,
    resend: boolean,
    socketGeneration: number,
  ): Promise<void> {
    if (
      this.shuttingDown ||
      this.socketGeneration !== socketGeneration ||
      this.state !== 'READY' ||
      this.socket?.readyState !== 1 ||
      this.outboxRecord?.commandId !== record.commandId ||
      this.active === undefined
    ) {
      return
    }
    try {
      if (resend) {
        await this.sendWithBackpressure(this.resequencedCommand(record))
        this.startAckDeadline(COMMAND_ACK_TIMEOUT_MS)
      } else {
        await this.sendStatus(record)
      }
    } catch {
      // The socket died under the retry. `fallback` routes a dispatched command to
      // durable recovery, which is exactly where it would have gone without any of
      // this, so nothing is lost by the attempt.
      await this.fallback('server-kill', record)
    }
  }

  /**
   * The stored COMMAND frame with a fresh sequence and request id, and the same
   * command id, digest and payload.
   *
   * The sequence MUST move: the gateway refuses a frame whose sequence is not the
   * one it expects and closes the socket `OUT_OF_ORDER`. The command id and digest
   * MUST NOT: they are the journal's idempotency identity, and the whole claim that
   * a resend cannot apply anything twice rests on them being byte-identical.
   *
   * The outbox record is deliberately NOT rewritten with the new bytes. Nothing reads
   * the stored sequence — `parseStoredBody` takes the body and the HTTP replay takes
   * the id and digest — so a write here would add an IndexedDB failure mode to a
   * retry whose point is to avoid losing anything.
   */
  private resequencedCommand(record: SyncOutboxRecord): string {
    const frame = JSON.parse(record.bytes) as SyncClientFrame
    return JSON.stringify({ ...frame, requestId: this.uuid(), sequence: this.sequence++ })
  }

  private async sendStatus(record: SyncOutboxRecord): Promise<void> {
    const payload = {}
    const frame: SyncClientFrame = {
      version: SYNC_PROTOCOL_VERSION,
      channel: SYNC_CHANNEL,
      type: 'STATUS',
      requestId: this.uuid(),
      commandId: record.commandId,
      sequence: this.sequence++,
      payloadLength: payloadByteLength(payload),
      payload,
      digest: record.digest,
    }
    await this.sendWithBackpressure(JSON.stringify(frame))
    this.startAckDeadline(COMMAND_ACK_TIMEOUT_MS)
  }

  private async sendWithBackpressure(bytes: string): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) {
      throw new Error('Socket is not ready')
    }
    const deadline = this.now() + COMMAND_ACK_TIMEOUT_MS
    while (socket.bufferedAmount > MAX_SYNC_BUFFERED_BYTES) {
      if (this.now() >= deadline) {
        throw new SyncBackpressureError('Sync socket backpressure deadline exceeded before write.')
      }
      await new Promise<void>((resolve) => this.scheduleTimeout(resolve, 10))
      if (this.socket !== socket) {
        throw new Error('Sync socket changed before write.')
      }
    }
    socket.send(bytes)
  }

  /**
   * Binary sibling of {@link sendWithBackpressure}. A file chunk is up to 256 KiB
   * and an upload writes many back to back, so waiting on `bufferedAmount` is what
   * stops a large upload from queueing the whole file in the socket's send buffer
   * and starving the JSON lanes that share this connection.
   */
  private async sendBinaryWithBackpressure(bytes: Uint8Array): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) {
      throw new Error('Socket is not ready')
    }
    const deadline = this.now() + COMMAND_ACK_TIMEOUT_MS
    while (socket.bufferedAmount > MAX_SYNC_BUFFERED_BYTES) {
      if (this.now() >= deadline) {
        throw new Error('Sync socket backpressure deadline exceeded before binary write.')
      }
      await new Promise<void>((resolve) => this.scheduleTimeout(resolve, 10))
      if (this.socket !== socket) {
        throw new Error('Sync socket changed before binary write.')
      }
    }
    socket.sendBinary(bytes)
  }

  private deliverResult(result: unknown): void {
    if (!this.active || !this.outboxRecord || this.resultDelivered) {
      return
    }
    this.resultDelivered = true
    this.dependencies.postMessage({
      type: 'RESULT',
      clientRequestId: this.active.clientRequestId,
      commandId: this.outboxRecord.commandId,
      result,
    })
  }

  private async checkpointDurable(requestId: string, sessionScope: string, commandId: string): Promise<void> {
    try {
      await this.outbox.delete(sessionScope, commandId)
      if (
        this.outboxRecord?.commandId === commandId &&
        this.outboxRecord.sessionScope === sessionScope &&
        this.active?.sessionScope === sessionScope
      ) {
        this.outboxRecord = undefined
        this.active = undefined
        this.accepted = false
        this.commandSent = false
        this.resultDelivered = false
        this.reconnectAttempts = 0
        this.cancelCommandRetry()
      }
      this.dependencies.postMessage({ type: 'CHECKPOINT_CLEARED', requestId, sessionScope, commandId })
    } catch {
      this.dependencies.postMessage({ type: 'CHECKPOINT_FAILED', requestId, sessionScope, commandId })
    }
  }

  private async onClose(socket: SyncSocketLike, event: SyncSocketCloseEvent): Promise<void> {
    if (this.socket !== socket) {
      return
    }
    const code = event.code ?? 0
    this.socket = undefined
    const authenticatedAt = this.socketAuthenticatedAt
    this.socketAuthenticatedAt = undefined
    this.clearAckDeadline()
    this.cancelCommandRetry()
    this.clearHeartbeat()
    // The credential refresh belonged to THIS socket. Abandon it and let the close
    // path below own every operation that was parked on it, which it already does
    // correctly: the command through its retained outbox record, an unsent RPC
    // through the reconnect bootstrap.
    this.discardSessionRefresh()
    // A download cannot survive its socket: the gateway aborts the transfer on
    // disconnect, and its transferId/generation do not carry to a new connection.
    this.failAllFileDownloads('SOCKET_CLOSED', true)
    // An upload cannot survive its socket either, but unlike a download it may
    // have written bytes the server kept, so the main thread decides what that
    // means for replay safety.
    this.failAllFileUploads('SOCKET_CLOSED', true)
    for (const rpc of [...this.rpcRequests.values()]) {
      if (rpc.sent) {
        // Never replay a request after bytes crossed the socket. The server's
        // durable idempotency key remains available for an explicit caller retry.
        this.failRpc(rpc, 'SOCKET_CLOSED', true, false)
      }
    }
    if (this.shuttingDown) {
      return
    }
    // Charged before anything decides whether to dial again, because that decision
    // reads the run this records.
    if (authenticatedAt !== undefined && this.now() - authenticatedAt < MIN_HEALTHY_SOCKET_LIFETIME_MS) {
      this.noteShortLivedHandshake()
    }
    // *** WHAT THE SERVER ACTUALLY SAID. ***
    //
    // This used to be `code >= 4000 ? 'server-kill' : undefined`, and both arms were
    // wrong. No server close code anywhere in this stack is >= 4000 — the only three
    // 4000-closes are this client's own ack timeout, pong timeout and failed invite
    // acknowledgement — so `server-kill` was reported EXACTLY when the server had
    // killed nothing, and every genuine server close reported no cause at all. The
    // ledger only counts a transition that carries a reason, so the pane's
    // "degradations with cause X" sat at zero while the lane flapped.
    const closedReason = syncCloseFallbackReason({
      code,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(event.wasClean === undefined ? {} : { wasClean: event.wasClean }),
      ...(this.protocolErrorCode === undefined ? {} : { protocolErrorCode: this.protocolErrorCode }),
    })
    if (this.active?.mode === 'collaboration' && this.active.socketGeneration !== undefined) {
      // `reconnect-gap` only as the FLOOR. A collaboration grant lost to a rate
      // limit or a draining gateway said so in its close, and reporting the generic
      // gap for it discards the one fact the caller could act on.
      await this.fallbackCollaboration(closedReason ?? 'reconnect-gap', false)
      return
    }
    this.transition('DEGRADED', closedReason)
    if (!this.active) {
      const unsent = this.rpcRequests.values().next().value as ActiveRpcRequest | undefined
      if (unsent) {
        this.active = {
          clientRequestId: unsent.clientRequestId,
          sessionScope: unsent.sessionScope,
          mode: 'rpc-bootstrap',
        }
      }
    }
    if (!this.active && this.inviteSubscription) {
      this.inviteSubscription.sent = false
      this.active = {
        clientRequestId: this.inviteSubscription.clientRequestId,
        sessionScope: this.inviteSubscription.sessionScope,
        mode: 'invite-bootstrap',
      }
    }
    if (!this.active) {
      /**
       * *** AN IDLE TAB USED TO HOLD THE WHOLE ACCOUNT'S LANE WITH NO SOCKET. ***
       *
       * This return is the common case, not an edge: a tab whose last command
       * settled has no active request, and its socket then goes whenever the
       * network blips, a proxy times the connection out, or the heartbeat closes a
       * half-open one. Nothing here is in flight, so nothing reconnects — correct,
       * and the next command dials for itself.
       *
       * What was NOT correct is what it left running. `ownerRenewInterval` renews
       * the multi-tab owner lease every 5 s against a 15 s TTL, and this path
       * cancelled neither the interval nor the lease. The IDB row therefore stayed
       * alive for the life of the tab with no socket behind it: every sibling tab
       * read `heldByAnotherOwner === true`, stood down on `multi-tab-not-owner`
       * (a `deferred` reason the main thread caches for a lease TTL), and NOBODY
       * held a socket. Self-correction took up to five minutes under auto-sync —
       * whenever this tab's own next sync happened to dial — and never at all
       * under manual-sync mode.
       *
       * `closeSocketAndReleaseOwner` is exactly the right teardown and is reached
       * here with no work to settle: the socket reference is already gone, every
       * sent RPC and every file transfer was failed above, and an invite
       * subscription or an unsent RPC would have made `this.active` set and never
       * reached this line. A second tab now acquires inside one lease TTL.
       */
      await this.closeSocketAndReleaseOwner({ ...(closedReason ? { reason: closedReason } : {}) })
      return
    }
    if (this.handshakeLoopHeld()) {
      // Deliberately NOT the `proxy-failed` the budget-exhausted arm below reports
      // for a connection with no record: these sockets were not refused before
      // authenticating, they authenticated and then vanished, three times in a row.
      // `reconnect-gap` says that and is retryable, so when the hold decays the lane
      // tries again rather than standing down for good.
      await this.fallback('reconnect-gap', this.outboxRecord)
      return
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      await this.fallback(this.outboxRecord ? 'reconnect-gap' : 'proxy-failed', this.outboxRecord)
      return
    }
    const delay = this.nextReconnectDelayMs()
    this.reconnectAttempts += 1
    this.reconnectTimeout = this.scheduleTimeout(() => {
      this.reconnectTimeout = undefined
      const active = this.active
      if (active) {
        void this.requestTicket(active.clientRequestId, active.sessionScope, true)
      }
    }, delay)
  }

  /**
   * The backoff for the attempt about to be spent: an exponential window, capped,
   * with the delay drawn from its upper half. See RECONNECT_BACKOFF_BASE_MS for
   * what the previous expression actually computed.
   */
  private nextReconnectDelayMs(): number {
    const window = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** this.reconnectAttempts)
    return window * (RECONNECT_JITTER_FLOOR + this.random() * (1 - RECONNECT_JITTER_FLOOR))
  }

  /**
   * Record a handshake that did not survive MIN_HEALTHY_SOCKET_LIFETIME_MS, and arm
   * the HTTP hold once enough of them have happened in a row.
   *
   * The run DECAYS rather than accruing: a young death more than
   * HANDSHAKE_LOOP_HOLD_MS after the previous one starts the count again, so a tab
   * that is merely unlucky twice an hour never reaches the cap. Arming the hold also
   * clears the run, so each hold is paid for by its own fresh evidence instead of a
   * single historic trio keeping the lane on HTTP for the life of the tab.
   */
  private noteShortLivedHandshake(): void {
    const now = this.now()
    const previous = this.lastShortLivedHandshakeAt
    this.shortLivedHandshakes =
      previous !== undefined && now - previous <= HANDSHAKE_LOOP_HOLD_MS ? this.shortLivedHandshakes + 1 : 1
    this.lastShortLivedHandshakeAt = now
    if (this.shortLivedHandshakes >= MAX_SHORT_LIVED_HANDSHAKES) {
      this.handshakeLoopHeldUntil = now + HANDSHAKE_LOOP_HOLD_MS
      this.shortLivedHandshakes = 0
      this.lastShortLivedHandshakeAt = undefined
      // *** A CONTROL THAT SIDELINES THE TAB FOR A MINUTE MUST NOT BE SILENT. ***
      //
      // Every refusal the hold produces is reported as `reconnect-gap`, which is
      // honest about the one request and says nothing about the tab having withdrawn
      // itself. Announced here in its own right, so the operator looking at the
      // console can tell a transient gap from a deliberate stand-down and knows how
      // long it lasts.
      this.dependencies.postMessage({
        type: 'DIAL_HOLD_ARMED',
        holdForMilliseconds: HANDSHAKE_LOOP_HOLD_MS,
        handshakes: MAX_SHORT_LIVED_HANDSHAKES,
      })
      this.announceHandshakeLoopHoldExpiry()
    }
  }

  /**
   * Say when the hold ends, at the moment it ends.
   *
   * NARRATION AND TIDYING ONLY. `handshakeLoopHeld()` reads the deadline itself, so
   * a timer that never runs — a throttled worker, a tab the browser froze — cannot
   * extend the hold by a millisecond, and one that runs early cannot shorten it
   * either (it re-checks before clearing). It exists because the operator who saw
   * the lane take itself out of service is owed the line saying it is back, and
   * nothing else here would ever say so while the tab sits idle.
   */
  private announceHandshakeLoopHoldExpiry(): void {
    if (this.handshakeLoopHoldTimer) {
      this.cancelTimeout(this.handshakeLoopHoldTimer)
    }
    this.handshakeLoopHoldTimer = this.scheduleTimeout(() => {
      this.handshakeLoopHoldTimer = undefined
      if (this.handshakeLoopHeld() || this.shuttingDown) {
        return
      }
      this.handshakeLoopHeldUntil = undefined
      this.dependencies.postMessage({ type: 'DIAL_HOLD_ENDED' })
    }, HANDSHAKE_LOOP_HOLD_MS)
  }

  /** True while this client is holding on HTTP rather than dialling into a loop. */
  private handshakeLoopHeld(): boolean {
    return this.handshakeLoopHeldUntil !== undefined && this.now() < this.handshakeLoopHeldUntil
  }

  private startAckDeadline(timeoutMs: number): void {
    this.clearAckDeadline()
    this.ackTimeout = this.scheduleTimeout(() => {
      this.ackTimeout = undefined
      const socket = this.socket
      if (socket) {
        socket.close(4000, 'ack-timeout')
      } else {
        void this.fallback('ack-timeout', this.outboxRecord)
      }
    }, timeoutMs)
  }

  private clearAckDeadline(): void {
    if (this.ackTimeout) {
      this.cancelTimeout(this.ackTimeout)
      this.ackTimeout = undefined
    }
  }

  /**
   * Drop a pending command retry. Called wherever the socket or the command it
   * belongs to goes away; the retry's own guards would refuse to act anyway, so this
   * is about not leaving a timer behind rather than about correctness.
   */
  private cancelCommandRetry(): void {
    if (this.commandRetryTimeout) {
      this.cancelTimeout(this.commandRetryTimeout)
      this.commandRetryTimeout = undefined
    }
  }

  private beginHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatInterval = this.scheduleInterval(() => {
      if (!this.socket || this.socket.readyState !== 1 || this.state !== 'READY') {
        return
      }
      const payload = {}
      const frame: SyncClientFrame = {
        version: SYNC_PROTOCOL_VERSION,
        channel: SYNC_CHANNEL,
        type: 'PING',
        requestId: this.uuid(),
        commandId: this.outboxRecord?.commandId ?? this.uuid(),
        sequence: this.sequence++,
        payloadLength: payloadByteLength(payload),
        payload,
      }
      if (frameByteLength(frame) <= MAX_SYNC_FRAME_BYTES && this.socket.bufferedAmount <= MAX_SYNC_BUFFERED_BYTES) {
        this.socket.send(JSON.stringify(frame))
        this.awaitPong()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /**
   * One deadline covers however many pings go unanswered: a socket whose peer
   * has gone silent is dead after the first missed pair either way, and rearming
   * per ping would only move the same close a tick later. The close runs the
   * ordinary `onClose` path, so an idle tab re-dials instead of discovering the
   * dead connection through the next command's ack timeout.
   */
  private awaitPong(): void {
    if (this.pongTimeout) {
      return
    }
    this.pongTimeout = this.scheduleTimeout(() => {
      this.pongTimeout = undefined
      this.socket?.close(4000, 'pong-timeout')
    }, PONG_DEADLINE_MS)
  }

  private clearPongDeadline(): void {
    if (this.pongTimeout) {
      this.cancelTimeout(this.pongTimeout)
      this.pongTimeout = undefined
    }
  }

  private clearHeartbeat(): void {
    this.clearPongDeadline()
    if (this.heartbeatInterval) {
      this.cancelInterval(this.heartbeatInterval)
      this.heartbeatInterval = undefined
    }
  }

  private beginOwnerRenewal(): void {
    if (this.ownerRenewInterval) {
      this.cancelInterval(this.ownerRenewInterval)
    }
    this.ownerRenewInterval = this.scheduleInterval(() => {
      if (!this.transportScope || !this.sessionScope) {
        return
      }
      void this.outbox
        .renewOwner(this.transportScope, this.sessionScope, this.ownerId, this.now(), OWNER_LEASE_TTL_MS)
        .then((outcome) => {
          if (outcome === 'renewed') {
            return
          }
          /**
           * *** ONE REASON USED TO STAND FOR TWO DIFFERENT FACTS. ***
           *
           * Every falsy renewal mapped to `multi-tab-not-owner`, and that reason is
           * `deferred`: the main thread suppresses a further dial for a whole lease
           * TTL on the strength of it (`WebSocketSyncTransport.ticketFailureCache`),
           * because the condition it names clears by itself when the OTHER tab
           * closes. But `renewOwner` also answered falsy for this tab's own row
           * having aged out — which is what happens to a frozen or backgrounded tab,
           * whose 5 s interval simply did not run. A single tab with no sibling
           * anywhere therefore reported a sibling that did not exist and then parked
           * itself behind the phantom for a lease TTL at a time.
           *
           * `lapsed` means no live lease stands for this scope at all, so the lane
           * is free and the answer is to re-dial: `reconnect-gap` is `retryable`,
           * which is what makes the next command and the invite coordinator try
           * again instead of waiting. (A dedicated `owner-lease-lapsed` member would
           * name the cause more precisely on the diagnostics pane; it is not added
           * here because the pane's closed set lives in another owner's file.)
           */
          void this.surrenderOwnership(outcome === 'taken' ? 'multi-tab-not-owner' : 'reconnect-gap')
        })
        .catch(() => this.surrenderOwnership('outbox-unavailable'))
    }, OWNER_RENEW_INTERVAL_MS)
  }

  /**
   * The lease is gone — another tab took it while this one was frozen, or the
   * store stopped answering. With a request in flight the caller is told and the
   * socket goes; with none, the socket used to stay open and unowned until the
   * NEXT command was cut off by the following renewal tick, so two tabs each
   * held a live sync socket and one of them lost a command to prove it.
   */
  private async surrenderOwnership(reason: SyncFallbackReason): Promise<void> {
    if (this.active) {
      await this.fallback(reason, this.outboxRecord)
      return
    }
    this.transition(this.nonRecoveringState(reason), reason)
    await this.closeSocketAndReleaseOwner({ reason })
  }

  /**
   * The connection state to report for a fallback reason on a lane that is NOT
   * going to recover by itself.
   *
   * `DEGRADED` means "no usable socket and this transport is working on getting one
   * back" — the diagnostics pane reads it as the socket being live. A `deferred`
   * reason is not being worked on: another tab holds the lane and this tab is
   * waiting. Reporting DEGRADED for it both overstated recovery and made the
   * announced state flap, because the sync and collaboration lanes post
   * HTTP_FALLBACK for the identical cause — so one unchanged condition produced an
   * endless DEGRADED/HTTP_FALLBACK alternation in the console.
   */
  private nonRecoveringState(reason: SyncFallbackReason): SyncTransportState {
    return syncFallbackDisposition(reason) === 'deferred' ? 'HTTP_FALLBACK' : 'DEGRADED'
  }

  /**
   * Watch for the owner lease to become free while an invite subscription is parked
   * on a `deferred` reason.
   *
   * This is a watch, not a retry: each tick is a single read of this worker's own
   * lease store and it dials nothing until the lease is actually free, so a tab
   * waiting behind a long-lived sibling costs no ticket, no request and no log line.
   * Something has to look, because the lease lives in shared storage and no tab is
   * notified when another hands it back; without this the invite lane would wait for
   * whatever unrelated work dialled next (an auto-sync tick, up to five minutes
   * while the legacy socket is open — and never at all under manual-sync mode).
   */
  private beginDeferredInviteWatch(): void {
    if (this.deferredInviteWatch !== undefined || this.shuttingDown) {
      return
    }
    this.deferredInviteWatch = this.scheduleInterval(() => {
      const subscription = this.inviteSubscription
      if (!subscription || this.shuttingDown || this.socket || this.active) {
        if (!subscription || this.shuttingDown) {
          this.cancelDeferredInviteWatch()
        }
        return
      }
      void this.socketOwnedByAnotherTab(subscription.sessionScope).then(async (owned) => {
        if (owned || this.inviteSubscription !== subscription || this.socket || this.active || this.shuttingDown) {
          return
        }
        this.cancelDeferredInviteWatch()
        this.active = {
          clientRequestId: subscription.clientRequestId,
          sessionScope: subscription.sessionScope,
          mode: 'invite-bootstrap',
        }
        await this.requestTicket(subscription.clientRequestId, subscription.sessionScope, false)
      })
    }, OWNER_LEASE_TTL_MS)
  }

  private cancelDeferredInviteWatch(): void {
    if (this.deferredInviteWatch === undefined) {
      return
    }
    this.cancelInterval(this.deferredInviteWatch)
    this.deferredInviteWatch = undefined
  }

  /**
   * The page is going away. Handing the lease back turns the TTL handover into
   * an immediate one for the next tab. Skipped whenever anything is in flight:
   * a page that may yet be restored from the back/forward cache must not lose a
   * command, an RPC or a file transfer to a tidy-up.
   */
  private async releaseOwnership(): Promise<void> {
    if (
      this.shuttingDown ||
      !this.transportScope ||
      this.active ||
      this.outboxRecord ||
      this.rpcRequests.size > 0 ||
      this.fileDownloads.size > 0 ||
      this.fileUploads.size > 0
    ) {
      return
    }
    this.transition('DEGRADED')
    await this.closeSocketAndReleaseOwner()
  }

  private async fallback(
    reason: SyncFallbackReason,
    record: SyncOutboxRecord | undefined = this.outboxRecord,
    preserveHealthySocket = false,
    confirmedNoSideEffect = false,
  ): Promise<void> {
    const active = this.active
    if (!active) {
      return
    }
    if (active.mode === 'rpc-bootstrap') {
      const rpc = this.rpcRequests.get(active.clientRequestId)
      if (rpc) {
        this.failRpc(rpc, reason.toUpperCase().replaceAll('-', '_'), true, !rpc.sent)
      }
      this.active = undefined
      this.transition('HTTP_FALLBACK', reason, preserveHealthySocket)
      if (!preserveHealthySocket) {
        await this.closeSocketAndReleaseOwner({ reason })
      }
      return
    }
    if (active.mode === 'invite-bootstrap') {
      const subscription = this.inviteSubscription
      if (subscription?.clientRequestId === active.clientRequestId) {
        this.settleInviteSubscription(subscription, reason)
      }
      this.active = undefined
      this.transition(this.nonRecoveringState(reason), reason, preserveHealthySocket)
      if (!preserveHealthySocket) {
        await this.closeSocketAndReleaseOwner({ reason })
      }
      return
    }
    if (active.mode === 'collaboration') {
      await this.fallbackCollaboration(reason, preserveHealthySocket)
      return
    }
    const recordBelongsToActive = record?.sessionScope === active.sessionScope
    // A permanent reason answered to a recovery can never be resolved by STATUS
    // (no socket will ever exist for it), so the only exit is the identity-bearing
    // HTTP replay, which the server journal makes idempotent.
    //
    // Deliberately `isPermanentSyncFallbackReason` and NOT `syncFallbackDisposition`:
    // a `deferred` reason is the opposite case. A socket WILL exist for it once the
    // owning tab hands the lane back, so a command that may already have crossed the
    // wire must keep its STATUS round trip rather than be replayed on the strength of
    // the journal. Widening this to "not retryable" would trade a decided command for
    // an idempotent-replay assumption every time a second tab was open.
    const journalIdempotentReplay =
      confirmedNoSideEffect || (active.mode === 'recover' && isPermanentSyncFallbackReason(reason))
    if (recordBelongsToActive && this.commandSent && !journalIdempotentReplay) {
      await this.requireDurableRecovery(active.clientRequestId, reason)
      return
    }
    this.transition('HTTP_FALLBACK', reason, preserveHealthySocket)
    const storedBody = record?.sessionScope === active.sessionScope ? parseStoredBody(record) : undefined
    this.dependencies.postMessage({
      type: 'HTTP_FALLBACK',
      clientRequestId: active.clientRequestId,
      reason,
      body: storedBody ?? active.body,
      ...(record?.sessionScope === active.sessionScope
        ? {
            command: {
              id: record.commandId,
              digest: record.digest,
              sequence: record.sequence,
              ...(record.operationId ? { operationId: record.operationId } : {}),
            } satisfies AccountSyncCommandMetadata,
          }
        : {}),
    })
    this.active = undefined
    this.outboxRecord = undefined
    this.resultDelivered = false
    this.accepted = false
    this.commandSent = false
    if (!preserveHealthySocket) {
      await this.closeSocketAndReleaseOwner({ reason })
    } else {
      this.transition('READY')
    }
  }

  private async requireDurableRecovery(clientRequestId: string, reason: SyncFallbackReason): Promise<void> {
    this.clearAckDeadline()
    this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
    this.active = undefined
    this.resultDelivered = false
    this.accepted = false
    // Retain outboxRecord and commandSent. The next recoverPending call must
    // query STATUS for this exact command id/digest before any replay.
    //
    // The socket is always closed here, healthy or not: nothing reuses a socket
    // in DEGRADED (every entry point demands READY) and the next recovery dials
    // a new one, so a preserved socket was an authenticated orphan holding one of
    // the account's per-user socket slots until the tab closed.
    await this.closeSocketAndReleaseOwner({ reason })
    this.transition('DEGRADED', reason)
  }

  private async fallbackCollaboration(reason: SyncFallbackReason, preserveHealthySocket: boolean): Promise<void> {
    const active = this.active
    if (!active || active.mode !== 'collaboration') {
      return
    }
    const clientRequestId = active.clientRequestId
    this.clearAckDeadline()
    this.active = undefined
    this.dependencies.postMessage({ type: 'COLLABORATION_FALLBACK', clientRequestId, reason })
    if (!preserveHealthySocket) {
      this.transition('HTTP_FALLBACK', reason)
      await this.closeSocketAndReleaseOwner({ reason })
    } else {
      this.transition('READY')
    }
  }

  private postFallback(clientRequestId: string, body: AccountSyncTransportRequest, reason: SyncFallbackReason): void {
    this.dependencies.postMessage({ type: 'HTTP_FALLBACK', clientRequestId, reason, body })
  }

  /**
   * `socketPreserved` says whether this transition leaves a usable socket behind.
   * It is passed explicitly rather than read off `this.socket` because the socket
   * reference is still set at the moment a closing fallback posts its state — the
   * close happens after. It defaults to false so any transition that does not
   * claim preservation keeps the old, safe behaviour on the main thread.
   */
  private transition(state: SyncTransportState, reason?: SyncFallbackReason, socketPreserved = false): void {
    this.state = state
    this.dependencies.postMessage({
      type: 'STATE',
      state,
      ...(reason ? { reason } : {}),
      ...(socketPreserved ? { socketPreserved: true } : {}),
    })
  }

  /**
   * Drop this socket, release the owner lease, and settle every lane riding it.
   *
   * `redialling` is passed by the ONE caller that drops a socket in order to replace
   * it immediately: `reticket`. Its new handshake re-sends the invite subscription,
   * so telling the subscription's owner the lane is gone would make it dispose and
   * re-subscribe underneath a worker that is already doing exactly that.
   *
   * `reason` is the CAUSE, and it is not decoration: a `deferred` cause
   * (`multi-tab-not-owner`) must reach the invite subscription as a park and never as
   * a retryable error. `surrenderOwnership` closes the socket for precisely that
   * cause with no active request, so a teardown that assumed "the socket went away,
   * retry" would tell the coordinator to re-dial against a lease another tab holds.
   */
  private async closeSocketAndReleaseOwner({
    redialling = false,
    reason,
  }: { redialling?: boolean; reason?: SyncFallbackReason } = {}): Promise<void> {
    this.clearAckDeadline()
    this.cancelCommandRetry()
    this.clearHeartbeat()
    this.discardSessionRefresh()
    if (this.reconnectTimeout) {
      this.cancelTimeout(this.reconnectTimeout)
      this.reconnectTimeout = undefined
    }
    if (this.ownerRenewInterval) {
      this.cancelInterval(this.ownerRenewInterval)
      this.ownerRenewInterval = undefined
    }
    const socket = this.socket
    this.socket = undefined
    for (const rpc of [...this.rpcRequests.values()]) {
      if (rpc.sent) {
        this.failRpc(rpc, 'SOCKET_CLOSED', true, false)
      }
    }
    if (socket && socket.readyState < 2) {
      socket.close(1000, 'transport-fallback')
    }
    if (this.transportScope && this.sessionScope) {
      try {
        await this.outbox.releaseOwner(this.transportScope, this.sessionScope, this.ownerId)
      } catch {
        // Lease expiry provides the bounded recovery path if explicit release fails.
      }
    }
    this.transportScope = undefined
    this.authorization = undefined
    this.negotiatedOperations.clear()
    const subscription = this.inviteSubscription
    if (subscription) {
      subscription.sent = false
      /**
       * *** A TEARDOWN USED TO ORPHAN THIS SUBSCRIPTION PERMANENTLY. ***
       *
       * Clearing `sent` and posting NOTHING left the coordinator's
       * `session.connection` symbol set, so `hasLiveSubscription()` answered true
       * forever: the `online` and `visibilitychange` re-arm in `WebApplication`
       * returned at its first line for the rest of the tab's life, and the durable
       * invite stream was silently dead with every diagnostic claiming it was live.
       *
       * Only an `INVITE_ERROR` clears that symbol — `handleTransportError` is the
       * one path in the coordinator that disposes the subscription — and `retryable`
       * is what decides between its backoff and a permanent stand-down. A socket
       * torn down is retryable by construction: the next dial gets a fresh one.
       */
      if (!this.shuttingDown && !redialling) {
        this.settleInviteSubscription(subscription, reason)
      }
    }
  }

  private async revokeSession(requestId: string, sessionScope: string): Promise<void> {
    this.shuttingDown = true
    let quarantined = false
    try {
      if (validSessionScope(sessionScope)) {
        await this.outbox.quarantineSessionScope(sessionScope)
        quarantined = true
      }
    } catch {
      quarantined = false
    }
    await this.closeSocketAndReleaseOwner()
    this.failAllFileDownloads('SESSION_REVOKED', false)
    this.failAllFileUploads('SESSION_REVOKED', false)
    for (const rpc of [...this.rpcRequests.values()]) {
      this.failRpc(rpc, 'SESSION_REVOKED', false, false)
    }
    this.authorization = undefined
    this.active = undefined
    this.inviteSubscription = undefined
    this.cancelDeferredInviteWatch()
    this.outboxRecord = undefined
    this.liveSyncDisabled = false
    this.inviteEventsUnavailable = false
    this.lastTransportScope = undefined
    this.outbox.close()
    this.transition('HTTP_ONLY')
    this.dependencies.postMessage(
      quarantined
        ? { type: 'SESSION_REVOKED_ACK', requestId, sessionScope }
        : { type: 'SESSION_REVOKED_FAILED', requestId, sessionScope },
    )
  }

  private async shutdown(): Promise<void> {
    this.shuttingDown = true
    await this.closeSocketAndReleaseOwner()
    this.failAllFileDownloads('SHUTDOWN', false)
    this.failAllFileUploads('SHUTDOWN', false)
    for (const rpc of [...this.rpcRequests.values()]) {
      this.failRpc(rpc, 'SHUTDOWN', false, false)
    }
    this.authorization = undefined
    this.active = undefined
    this.inviteSubscription = undefined
    this.cancelDeferredInviteWatch()
    if (this.handshakeLoopHoldTimer) {
      this.cancelTimeout(this.handshakeLoopHoldTimer)
      this.handshakeLoopHoldTimer = undefined
    }
    this.outboxRecord = undefined
    this.outbox.close()
    this.transition('HTTP_ONLY')
    // The owner lease is released by now. Saying so lets the main thread stop
    // waiting and terminate; without it the wait always ran to its full bound.
    this.dependencies.postMessage({ type: 'SHUTDOWN_COMPLETE' })
  }
}

/**
 * A COMMITTED verdict whose result the socket could not carry: the gateway sends
 * `{ status: 'COMMITTED', code: 'RESULT_TOO_LARGE' }` with no `result` in place of
 * the oversized frame, both on the command leg and in answer to STATUS.
 */
function isOversizedCommittedResult(payload: Record<string, unknown>): boolean {
  return payload.code === 'RESULT_TOO_LARGE' && payload.result === undefined
}

function validOperationId(operationId: unknown): operationId is string {
  return (
    typeof operationId === 'string' && operationId.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(operationId)
  )
}

function validOperationIndex(operationIndex: unknown): operationIndex is number {
  return Number.isSafeInteger(operationIndex) && Number(operationIndex) >= 0
}

/** Normalizes the binary shapes a WebSocket can deliver into a single view. */
function asBinaryFrame(raw: unknown): Uint8Array | undefined {
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw)
  }
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  return undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function isValidWorkerRpcRequest(request: WorkerAuthenticatedRpcRequest): boolean {
  if (
    !request ||
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ||
    typeof request.path !== 'string' ||
    !request.path.startsWith('/v1/') ||
    request.path.startsWith('//') ||
    request.path.includes('\\') ||
    request.path.includes('#') ||
    utf8Bytes(request.path).byteLength > 2_048 ||
    !Number.isSafeInteger(request.deadlineMs) ||
    request.deadlineMs < 1_000 ||
    request.deadlineMs > 120_000 ||
    !Number.isSafeInteger(request.initialCreditBytes) ||
    request.initialCreditBytes <= 0 ||
    request.initialCreditBytes > MAX_RPC_CREDIT_BYTES ||
    typeof request.stream !== 'boolean' ||
    (request.headers !== undefined && !isStringRecord(request.headers)) ||
    (request.method === 'GET' && Object.hasOwn(request, 'body')) ||
    (request.method !== 'GET' &&
      (typeof request.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.idempotencyKey)))
  ) {
    return false
  }
  try {
    const parsed = new URL(request.path, 'http://rpc.invalid')
    return parsed.origin === 'http://rpc.invalid' && `${parsed.pathname}${parsed.search}` === request.path
  } catch {
    return false
  }
}

function decodedBase64Length(value: string): number {
  if (value.length === 0) {
    return 0
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return -1
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function parseCollaborationAuthorizationResult(
  payload: Record<string, unknown>,
  request: CollaborationAuthorizationTransportRequest,
  discovery: CollaborationEpochDiscoveryHandshake | undefined,
  now: number,
): CollaborationAuthorizationTransportResult | undefined {
  if (
    !discovery ||
    discovery.expiresAt <= now ||
    payload.epochDiscovery === true ||
    typeof payload.capability !== 'string' ||
    payload.capability.length === 0 ||
    payload.room !== request.noteUuid ||
    !Number.isSafeInteger(payload.expiresIn) ||
    Number(payload.expiresIn) <= 0 ||
    !Number.isSafeInteger(payload.serverUpdatedAtTimestamp) ||
    Number(payload.serverUpdatedAtTimestamp) <= 0 ||
    payload.collaborationProtocolVersion !== 3 ||
    !isValidCollaborationEpoch(payload.roomEpoch) ||
    !isValidCollaborationEpoch(payload.collaborationSecurityEpoch) ||
    payload.roomEpoch !== discovery.roomEpoch ||
    payload.collaborationSecurityEpoch !== discovery.collaborationSecurityEpoch ||
    payload.leaseRequestId !== request.leaseRequestId ||
    payload.bootstrapChallenge !== request.bootstrapChallenge
  ) {
    return undefined
  }
  return {
    epochDiscovery: false,
    capability: payload.capability,
    room: request.noteUuid,
    expiresIn: Number(payload.expiresIn),
    serverUpdatedAtTimestamp: Number(payload.serverUpdatedAtTimestamp),
    collaborationProtocolVersion: 3,
    roomEpoch: payload.roomEpoch,
    collaborationSecurityEpoch: payload.collaborationSecurityEpoch,
    ...(request.leaseRequestId ? { leaseRequestId: request.leaseRequestId } : {}),
    ...(request.bootstrapChallenge ? { bootstrapChallenge: request.bootstrapChallenge } : {}),
  }
}

function parseCollaborationEpochDiscoveryResult(
  payload: Record<string, unknown>,
  request: CollaborationAuthorizationTransportRequest,
  responseRequestId: string,
  now: number,
): CollaborationEpochDiscoveryHandshake | undefined {
  const allowedKeys = new Set([
    'epochDiscovery',
    'room',
    'serverUpdatedAtTimestamp',
    'collaborationProtocolVersion',
    'roomEpoch',
    'collaborationSecurityEpoch',
    'epochDiscoveryChallenge',
    'epochDiscoveryRequestId',
    'challengeExpiresAt',
  ])
  if (
    Object.keys(payload).some((key) => !allowedKeys.has(key)) ||
    payload.epochDiscovery !== true ||
    payload.room !== request.noteUuid ||
    !Number.isSafeInteger(payload.serverUpdatedAtTimestamp) ||
    Number(payload.serverUpdatedAtTimestamp) <= 0 ||
    payload.collaborationProtocolVersion !== 3 ||
    !isValidCollaborationEpoch(payload.roomEpoch) ||
    !isValidCollaborationEpoch(payload.collaborationSecurityEpoch) ||
    // Both values are echoed back inside the grant frame, where the gateway
    // holds every identifier to IDENTIFIER_PATTERN and closes the whole sync
    // socket when one fails. The old rule here accepted a leading `-` or `_`,
    // which base64url produces 2/64 of the time: those handshakes minted a
    // challenge this client could not present, and the socket died proving it.
    // Refusing locally costs one clean HTTP fallback instead.
    !isSyncIdentifier(payload.epochDiscoveryChallenge) ||
    payload.epochDiscoveryChallenge.length < 32 ||
    !isSyncIdentifier(responseRequestId) ||
    payload.epochDiscoveryRequestId !== responseRequestId ||
    !Number.isSafeInteger(payload.challengeExpiresAt) ||
    Number(payload.challengeExpiresAt) <= now ||
    Number(payload.challengeExpiresAt) > now + 60_000
  ) {
    return undefined
  }
  return {
    challenge: payload.epochDiscoveryChallenge,
    requestId: responseRequestId,
    roomEpoch: payload.roomEpoch,
    collaborationSecurityEpoch: payload.collaborationSecurityEpoch,
    expiresAt: Number(payload.challengeExpiresAt),
  }
}

function isValidCollaborationEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value)
}
