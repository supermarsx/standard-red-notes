import type {
  AccountSyncCommandMetadata,
  AccountSyncHttpFallback,
  AccountSyncTransportContext,
  AccountSyncTransportInterface,
  AccountSyncTransportRecoveryResult,
  AccountSyncTransportRequest,
  AccountSyncTransportResult,
  InviteRealtimeBatch,
} from '@standardnotes/services'
import type { HttpResponse, RawSyncResponse } from '@standardnotes/snjs'
import * as SyncTransportWorkerModule from './syncTransport.worker'
import sharedSyncWorkerUrl from './syncTransport.sharedworker'
import { SharedSyncWorkerClient } from './SharedSyncWorkerClient'
import { WebBuildRevision } from '../../Constants/BuildRevision'
import {
  CollaborationAuthorizationTransportRequest,
  CollaborationAuthorizationTransportResult,
  AuthenticatedRpcRequest as AuthenticatedRpcRequestInput,
  DEFAULT_FILE_TRANSFER_CREDIT_BYTES,
  DEFAULT_FILE_TRANSFER_DEADLINE_MS,
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_MIME_TYPE_BYTES,
  MAX_FILE_TRANSFER_BYTES,
  DEFAULT_RPC_CREDIT_BYTES,
  DEFAULT_RPC_DEADLINE_MS,
  isSocketFileResourceReference,
  isSyncCommandRefusalCode,
  type SyncCommandRefusalCode,
  MainToSyncWorkerMessage,
  MAX_RPC_CREDIT_BYTES,
  SocketFileResourceReference,
  MAX_RPC_DEADLINE_MS,
  MIN_RPC_DEADLINE_MS,
  normalizeSyncRequestForWire,
  SYNC_FALLBACK_REASON_EXPLANATIONS,
  SyncFallbackReason,
  SyncTransportState,
  SyncNegotiatedOperation,
  SyncWorkerToMainMessage,
  utf8Bytes,
  WorkerAuthenticatedRpcRequest,
} from './syncTransportProtocol'
import { LANE_STATE_CARRIER, LaneDegradationLedger, type LaneLedgerReading } from './LaneDegradationLedger'
import { OWNER_LEASE_TTL_MS } from './SyncTransportOutbox'
import { authoredLogMessage } from '@standardnotes/utils'

/**
 * *** THE REASON A PRODUCTION FAILURE READ `{ errorType: "Error", errorCode: undefined,
 * status: undefined }` AND NOTHING ELSE. ***
 *
 * Every rejection this transport produces carries a message that is a string literal
 * written in this file, and `safeErrorLogMetadata` strips the message of an arbitrary
 * error on purpose — an upstream one routinely carries a bearer token or an e-mail
 * address. Marking ours tells that function the message is authored, so a sync failure
 * logs WHICH refusal it was instead of only that something threw. Correct here, and
 * only here, because these messages are literals: see `AuthoredLogMessageMarker`.
 */
const transportError = (message: string): Error => authoredLogMessage(new Error(message))

type SyncWorkerLike = {
  onmessage: ((event: MessageEvent<SyncWorkerToMainMessage>) => void) | null
  onerror: (() => void) | null
  onexpired?: (() => void) | null
  postMessage(message: MainToSyncWorkerMessage): void
  terminate(): void
}

const SyncTransportWorker = ((SyncTransportWorkerModule as { default?: { new (): Worker } }).default ??
  (SyncTransportWorkerModule as unknown as { new (): Worker })) as { new (): Worker }

const BARRIER_TIMEOUT_MS = 5_000

/** A build revision as the bundles carry it: a full commit, or empty for a build made without one. */
const WORKER_BUILD_REVISION = /^(?:[0-9a-f]{40})?$/

export type SyncWorkerBuildReading =
  | { readonly state: 'no-worker' }
  | { readonly state: 'silent'; readonly silentForMs: number }
  | { readonly state: 'reported'; readonly revision: string }

export type AuthenticatedSyncScopeInput = {
  applicationIdentifier: string
  host: string
  userUuid: string
  accessToken: string
}

/** Derive a non-secret epoch that stays stable when only token secret material rotates. */
export async function deriveOpaqueSyncSessionScope(
  input: AuthenticatedSyncScopeInput,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const tokenParts = input.accessToken.split(':')
  const stableSessionIdentifier =
    tokenParts.length >= 3 && /^\d+$/u.test(tokenParts[0]) && tokenParts[1].length > 0
      ? `${tokenParts[0]}:${tokenParts[1]}`
      : input.accessToken
  const material = JSON.stringify({
    version: 1,
    applicationIdentifier: input.applicationIdentifier,
    host: input.host,
    userUuid: input.userUuid,
    sessionIdentifier: stableSessionIdentifier,
  })
  const digest = await subtle.digest('SHA-256', utf8Bytes(material) as unknown as BufferSource)
  const digestHex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sync-session-v1:${digestHex}`
}

export type SyncCapability = {
  id: 'ws-sync'
  version: 1
  endpoint: string
}

export type SyncTicketResponse = {
  ticket: string
  expiresAt: number
  /**
   * Server clock at issue time, when the server reports it. Together with
   * `expiresAt` it gives the ticket's lifetime without trusting either clock to
   * agree with the other; without it the client performs no local expiry check.
   */
  issuedAt?: number
  endpoint: string
  capability: 'ws-sync'
  version: 1
}

/**
 * A control-plane request the server ANSWERED with a non-success status. Only an
 * answer can prove the capability absent; a thrown request (network error,
 * timeout) or a bare `undefined` proves nothing and must stay retryable. `code`
 * and `transient` come from the JSON error body when the server sent one
 * (`{ error: { code: 'SYNC_DISABLED', transient: true } }` during a store outage).
 */
export type SyncControlPlaneRefusal = {
  refused: true
  status: number
  code?: string
  transient?: boolean
}

export function isSyncControlPlaneRefusal(value: unknown): value is SyncControlPlaneRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { refused?: unknown }).refused === true &&
    Number.isSafeInteger((value as { status?: unknown }).status)
  )
}

export interface SyncTransportControlPlane {
  /**
   * Compatibility probe used only after ticket issuance says the operation is
   * unavailable. Return the list the server answered with, a refusal for a
   * non-success answer, `undefined` when the answer could not be read, and throw
   * on a network failure.
   */
  getCapabilities?(): Promise<{ capabilities: SyncCapability[] } | SyncControlPlaneRefusal | undefined>
  /** Same contract: refusal for a non-success answer, `undefined` for an unreadable one, throw on network failure. */
  createTicket(deviceId: string): Promise<SyncTicketResponse | SyncControlPlaneRefusal | undefined>
}

export type WebSocketSyncTransportOptions = {
  controlPlane: SyncTransportControlPlane
  getConfiguredWebSocketUrl: () => string | undefined
  /** Stable for access-token refresh, different for logout/new-login. */
  getAuthenticatedSessionScope: () => Promise<string | undefined>
  deviceId: string
  isHttpOnly?: () => boolean
  isItemServerAcknowledged?: (uuid: string) => boolean
  canSaveCollaborativeItem?: (uuid: string) => boolean
  getCollaborationSaveFence?: (uuid: string) => { room: string; token: string } | undefined
  workerFactory?: () => SyncWorkerLike
  environment?: {
    hasWorker: boolean
    hasWebSocket: boolean
    hasIndexedDb: boolean
    /** Defaults to `location.protocol`; only http(s) pages have an origin the sync lane can use. */
    pageProtocol?: string
  }
}

type TransportResponse = HttpResponse<RawSyncResponse>

/** Whether the HTTP sync endpoint answered a round with a success, read off the status alone. */
function isSuccessfulSyncResponse(response: TransportResponse | undefined): boolean {
  const status = (response as { status?: unknown } | undefined)?.status

  return typeof status === 'number' && status >= 200 && status < 300
}
type CapabilityProbeVerdict = 'present' | 'absent' | 'unknown'
type PendingResult =
  AccountSyncTransportResult<TransportResponse> | AccountSyncTransportRecoveryResult<TransportResponse> | undefined

type PendingExecution = {
  mode: 'execute' | 'recover'
  sessionScope: string
  body?: AccountSyncTransportRequest
  httpFallback: AccountSyncHttpFallback<TransportResponse>
  resolve: (result: PendingResult) => void
  reject: (error: unknown) => void
  persisted?: { body: AccountSyncTransportRequest; command: AccountSyncCommandMetadata }
}

type Barrier = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type PendingCollaborationAuthorization = {
  sessionScope: string
  resolve: (result: CollaborationAuthorizationTransportResult | null | undefined) => void
  reject: (error: unknown) => void
}

export type InviteRealtimeSubscriptionOptions = {
  cursor?: string
  limit?: number
  /** Must resolve to the exact batch cursor only after authoritative state and its checkpoint are durable. */
  applyBatch(batch: InviteRealtimeBatch): Promise<string>
  /** Must complete the authoritative HTTP snapshot and reset its checkpoint before resolving. */
  reconcile(input: {
    reason: 'BOOTSTRAP_REQUIRED' | 'CURSOR_EXPIRED' | 'CURSOR_INVALID'
    cursor: string
  }): Promise<void>
  onReady?: (cursor: string) => void
  onError?: (error: AuthenticatedRpcError) => void
  /**
   * The lane is not open because a `deferred` fallback reason holds — another tab of
   * this account owns the socket. Separate from `onError` because nothing failed: the
   * subscription stays registered here and in the worker, and is re-sent on the next
   * authenticated socket, so the owner must park rather than dispose and re-dial.
   */
  onDeferred?: (deferral: { reason: SyncFallbackReason; resumeAfterMilliseconds: number }) => void
}

type PendingInviteSubscription = {
  sessionScope: string
  options: InviteRealtimeSubscriptionOptions
  tail: Promise<void>
}

export type AuthenticatedRpcResponse = {
  status: number
  headers: Record<string, string>
  body?: unknown
  stream?: ReadableStream<Uint8Array>
  transport: 'websocket'
}

export type AuthenticatedRpcStreamRequest = AuthenticatedRpcRequestInput & {
  signal?: AbortSignal
}

export class AuthenticatedRpcError extends Error {
  override readonly name = 'AuthenticatedRpcError'

  constructor(
    readonly code: string,
    readonly retryable: boolean,
    /** True only when no RPC request bytes crossed the authenticated socket. */
    readonly safeToFallback: boolean,
  ) {
    super(`Authenticated websocket RPC failed: ${code}`)
  }
}

type PendingRpc = {
  sessionScope: string
  accepted: boolean
  responseResolved: boolean
  resolve: (response: AuthenticatedRpcResponse) => void
  reject: (error: unknown) => void
  response?: AuthenticatedRpcResponse
  streamController?: ReadableStreamDefaultController<Uint8Array>
  creditToReturn: number
  abortCleanup?: () => void
}

type RpcWorkerMessage = Extract<
  SyncWorkerToMainMessage,
  { type: 'RPC_ACCEPTED' | 'RPC_RESPONSE' | 'RPC_CHUNK' | 'RPC_END' | 'RPC_ERROR' }
>

type FileDownloadWorkerMessage = Extract<
  SyncWorkerToMainMessage,
  { type: 'FILE_DOWNLOAD_ACCEPTED' | 'FILE_DOWNLOAD_CHUNK' | 'FILE_DOWNLOAD_COMPLETE' | 'FILE_DOWNLOAD_ERROR' }
>

export type SocketFileDownloadRequest = {
  /**
   * Passed through to the gateway byte-identical. This is the same string the
   * file's encryptor and decryptor use as the xchacha20 AAD, so it is never
   * derived, normalized or regenerated on this path.
   */
  remoteIdentifier: string
  fileUuid: string
  /**
   * Present only for a file that lives in a shared vault, and only when both
   * values come from the vault listing that genuinely records them. Omitted, the
   * transfer is opened as a personal resource.
   */
  sharedVault?: { sharedVaultUuid: string; sharedVaultOwnerUuid: string }
  /** The client's own authenticated total, i.e. the sum of `encryptedChunkSizes`. */
  declaredSize: number
  /** Receives the encrypted stream in order. Backpressure: credit is returned only once this resolves. */
  onBytes: (bytes: Uint8Array) => Promise<void>
  signal?: AbortSignal
}

export type SocketFileDownloadOutcome =
  | { outcome: 'completed'; sha256: string }
  /** No socket, or the gateway does not advertise FILES_V1. Nothing was attempted. */
  | { outcome: 'unavailable' }
  | { outcome: 'aborted' }
  | {
      outcome: 'failed'
      code: string
      retryable: boolean
      /** True only if no byte reached `onBytes`, so an HTTP retry cannot double-feed the decryptor. */
      safeToFallback: boolean
    }

type PendingFileDownload = {
  sessionScope: string
  request: SocketFileDownloadRequest
  settle: (outcome: SocketFileDownloadOutcome) => void
  settled: boolean
  bytesDelivered: number
  tail: Promise<void>
  abortCleanup?: () => void
}

type FileUploadWorkerMessage = Extract<
  SyncWorkerToMainMessage,
  { type: 'FILE_UPLOAD_ACCEPTED' | 'FILE_UPLOAD_CHUNK_ACK' | 'FILE_UPLOAD_COMPLETE' | 'FILE_UPLOAD_ERROR' }
>

export type SocketFileUploadRequest = {
  /** Passed through to the gateway byte-identical; also this file's xchacha20 AAD. */
  remoteIdentifier: string
  fileUuid: string
  sharedVault?: { sharedVaultUuid: string; sharedVaultOwnerUuid: string }
  /** Plaintext length. The gateway's size check refuses zero, so an empty file has no lane here. */
  decryptedSize: number
  /** The ENCRYPTED total. Re-asserted by the gateway in every binary frame header and again at FINISH. */
  declaredSize: number
  mimeType: string
  signal?: AbortSignal
}

export type SocketFileUploadPosition = {
  transferId: string
  generation: number
  resumeId: string
  nextIndex: number
  nextOffset: number
  declaredSize: number
  /** The gateway's own per-frame payload limit, reported so callers need not redeclare it. */
  maxFrameBytes: number
}

export type SocketFileUploadFailure = {
  outcome: 'failed'
  code: string
  retryable: boolean
  /** Only what the socket observed; the caller's upload state machine has the final say. */
  safeToFallback: boolean
}

export type SocketFileUploadOpenOutcome =
  | { outcome: 'opened'; position: SocketFileUploadPosition; session: SocketFileUploadSession }
  /** No socket, or the gateway does not advertise FILES_V1. Nothing was attempted. */
  | { outcome: 'unavailable' }
  | { outcome: 'aborted' }
  | SocketFileUploadFailure

export type SocketFileUploadAcknowledgement = {
  outcome: 'acknowledged'
  transferId: string
  generation: number
  index: number
  duplicate: boolean
  nextIndex: number
  nextOffset: number
  resumeId: string
}

export type SocketFileUploadChunkOutcome =
  SocketFileUploadAcknowledgement | { outcome: 'aborted' } | SocketFileUploadFailure

export type SocketFileUploadFinishOutcome =
  { outcome: 'completed'; sha256: string } | { outcome: 'aborted' } | SocketFileUploadFailure

/**
 * One opened FILES_V1 upload. Strictly sequential: exactly one `sendChunk` may be
 * outstanding, because the gateway's chunk acks carry no client correlation id of
 * their own and because the whole purpose of an ack is to learn where the server
 * actually is before deciding what to send next.
 */
export interface SocketFileUploadSession {
  sendChunk(chunk: { index: number; offset: number; bytes: Uint8Array }): Promise<SocketFileUploadChunkOutcome>
  finish(input: {
    transferId: string
    generation: number
    declaredSize: number
    sha256: string
  }): Promise<SocketFileUploadFinishOutcome>
  cancel(): void
}

type PendingFileUploadStep =
  | { kind: 'open'; settle: (outcome: SocketFileUploadOpenOutcome) => void }
  | { kind: 'chunk'; settle: (outcome: SocketFileUploadChunkOutcome) => void }
  | { kind: 'finish'; settle: (outcome: SocketFileUploadFinishOutcome) => void }

type PendingFileUpload = {
  sessionScope: string
  /** The step currently awaiting an answer, if any. Never more than one. */
  step?: PendingFileUploadStep
  /** True once FINISH has been written, which is what makes a replay unsafe. */
  finishAttempted: boolean
  closed: boolean
  abortCleanup?: () => void
}

const CAPABILITY_REPROBE_MS = 60_000

/**
 * How long the worker is given to hand its multi-tab owner lease back before the
 * page terminates it. Short enough to be invisible on a tab close, long enough
 * for one IndexedDB write.
 */
const WORKER_SHUTDOWN_GRACE_MS = 500

/**
 * The worker lane rides a same-origin websocket, so it only makes sense from a
 * page served over http(s). Electron `file:`, a React Native webview or an
 * extension popup have no such origin and run the legacy socket lane only.
 */
function pageOriginSupportsSyncLane(pageProtocol: string | undefined): boolean {
  const protocol = pageProtocol ?? (globalThis as { location?: { protocol?: unknown } }).location?.protocol
  return protocol === undefined || protocol === 'http:' || protocol === 'https:'
}

/**
 * Statuses with which a server states that this endpoint does not exist here.
 * Anything else — 5xx from a proxy mid-deploy, 429, 401 — says nothing about the
 * capability and must stay retryable.
 */
const CAPABILITY_ABSENT_STATUSES = new Set([404, 410, 501])

function refusalProvesCapabilityAbsent(refusal: SyncControlPlaneRefusal): boolean {
  if (CAPABILITY_ABSENT_STATUSES.has(refusal.status)) {
    return true
  }
  // 503 SYNC_DISABLED without `transient` is the gateway saying the lane is
  // switched off by configuration; with `transient: true` its stores are still
  // coming up and the very same request may succeed seconds later.
  return refusal.status === 503 && refusal.code === 'SYNC_DISABLED' && refusal.transient !== true
}

function defaultHttpOnly(): boolean {
  const injected = (globalThis as { _sync_transport?: unknown })._sync_transport
  if (injected === 'http-only') {
    return true
  }
  try {
    return globalThis.localStorage?.getItem('standardnotes.sync-transport') === 'http-only'
  } catch {
    return false
  }
}

function normalizeCommittedResult(result: unknown): TransportResponse | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined
  }
  const candidate = result as { status?: unknown; data?: unknown }
  if (typeof candidate.status === 'number' && candidate.data && typeof candidate.data === 'object') {
    return result as TransportResponse
  }
  return { status: 200, data: result as RawSyncResponse } as TransportResponse
}

/**
 * Whether saves currently ride the socket. `code` says why not: a gateway refusal
 * code or `LIVE_SYNC_DISABLED` (a worker hold), `SOCKET_NOT_READY`, or
 * `SYNC_ITEMS_UNAVAILABLE` (the socket negotiated no item sync). `heldUntil`, epoch
 * milliseconds on this client's clock, is when a refusal window ends.
 */
export type SyncSaveLane = {
  usable: boolean
  code?: SyncCommandRefusalCode | 'LIVE_SYNC_DISABLED' | 'SOCKET_NOT_READY' | 'SYNC_ITEMS_UNAVAILABLE'
  heldUntil?: number
}

/** The window given to a SAVE_LANE hold whose fields this build cannot read: the worker's shortest. */
const UNREADABLE_SAVE_LANE_HOLD_MS = 30_000

/** Main-thread facade. The worker receives only short-lived tickets and opaque sync bodies. */
export class WebSocketSyncTransport implements AccountSyncTransportInterface<TransportResponse> {
  private worker?: SyncWorkerLike
  /** When the current worker was started, and the build it has said it is. */
  private workerBuildReport?: { readonly startedAtMs: number; readonly revision?: string }
  private workerSessionScope?: string
  private readonly pending = new Map<string, PendingExecution>()
  private readonly pendingCollaboration = new Map<string, PendingCollaborationAuthorization>()
  private readonly pendingInviteSubscriptions = new Map<string, PendingInviteSubscription>()
  private readonly pendingRpcs = new Map<string, PendingRpc>()
  private readonly pendingFileDownloads = new Map<string, PendingFileDownload>()
  private readonly pendingFileUploads = new Map<string, PendingFileUpload>()
  private readonly checkpointBarriers = new Map<string, Barrier>()
  private readonly revocationBarriers = new Map<string, Barrier>()
  private readonly revokedSessionScopes = new Set<string>()
  private readonly acknowledgedRevokedSessionScopes = new Set<string>()
  private state: SyncTransportState = 'HTTP_ONLY'
  private requestCounter = 0
  private deinitialized = false
  private executionTail: Promise<void> = Promise.resolve()
  private negotiated?: {
    sessionScope: string
    protocolVersion: 1
    endpoint: string
    operations: ReadonlySet<SyncNegotiatedOperation>
  }
  private capabilityProbe?: Promise<CapabilityProbeVerdict>
  /**
   * Negative ticket cache. It stores the classified reason with its deadline and
   * replays that exact reason, so a transient `ticket-unavailable` never gets
   * rewritten into the permanent `capability-unavailable` for the next request.
   */
  private ticketFailureCache?: { reason: SyncFallbackReason; until: number }
  private fallbackReason?: SyncFallbackReason
  /**
   * Signature of the last transition this transport announced to the console, so
   * a state that is re-reported on every sync round (HTTP_FALLBACK with the same
   * reason is the normal case on a gateway that advertises no SYNC_ITEMS) is
   * logged once per genuine change rather than once per save.
   */
  private lastLoggedTransition?: string
  /**
   * Kept apart from `lastLoggedTransition` on purpose: a parked invite lane and the
   * transport state move independently, and sharing one slot would let a state line
   * in between re-announce a deferral nothing has changed about.
   */
  private lastLoggedInviteDeferral?: string
  /** Same reasoning again, for the pre-sync recovery probe standing down. */
  private lastLoggedRecoveryDeferral?: string
  private pageHideListener?: () => void
  private shutdownBarrier?: () => void
  private shutdownWorker?: SyncWorkerLike
  /**
   * The session-long record of what this lane has done. In memory and bounded; see
   * `LaneDegradationLedger` for why it does not survive a reload.
   */
  private readonly ledger = new LaneDegradationLedger({ baselineState: 'HTTP_ONLY' })
  /** The worker's refusal hold as last reported; `heldUntil` undefined means until further notice. */
  private saveLaneHold?: { code: NonNullable<SyncSaveLane['code']>; heldUntil?: number }
  private saveLaneTimer?: ReturnType<typeof setTimeout>
  private publishedSaveLane?: SyncSaveLane
  private readonly saveLaneListeners = new Set<(lane: SyncSaveLane) => void>()
  private readonly refusedItems = new Map<string, { fenceToken?: string; until: number }>()
  private readonly saveRefusalListeners = new Set<(room: string, fenceToken: string | undefined) => void>()

  constructor(private readonly options: WebSocketSyncTransportOptions) {
    try {
      const stored: unknown = JSON.parse(globalThis.localStorage.getItem(this.socketOnlyStorageKey) ?? '[]')
      if (Array.isArray(stored)) {
        for (const uuid of stored) {
          if (typeof uuid === 'string' && uuid.length <= 128) {
            this.socketOnlyItems.add(uuid)
          }
        }
      }
    } catch {
      /* Storage can be unavailable; new live rooms fail closed below. */
    }
  }

  get transportState(): SyncTransportState {
    return this.state
  }

  /**
   * What this client has watched the lane do over this page's life.
   *
   * Read by the admin Diagnostics pane and by nothing else. `transportStatus` above
   * answers "where am I now" and cannot answer "did it ever fall back" — after a
   * recovery the two readings are identical to a lane that never moved, which is
   * precisely the question an operator opens that pane with.
   */
  get laneDegradationLedger(): LaneLedgerReading {
    return this.ledger.view()
  }

  /**
   * Count a control-plane read the socket lane refused and HTTP then served.
   *
   * Called from `WebApplication.controlPlaneRpc`, at the exact branch that discards
   * the socket's answer and retries over HTTP. Recorded THERE rather than inferred
   * here from an RPC status, so the counter cannot come to disagree with the
   * behaviour it claims to count — the degradation is one `if`, and this is inside
   * it.
   */
  recordControlPlaneRejection(status: number): void {
    this.ledger.recordControlPlaneRejection(status)
  }

  /**
   * Move the lane, with the cause, in one place.
   *
   * *** THE REASON IS A PARAMETER, NOT AN OMISSION. *** Twelve code paths assigned
   * `this.state` directly and only three of them touched `this.fallbackReason`, so
   * the pane's "Reported fallback reason" row read "not reported" on transports that
   * had a perfectly good closed code available — and on the paths that merely
   * re-asserted HTTP_ONLY it could print a STALE reason describing a condition that
   * had already cleared, which is worse: a row refusing a value must not be paired
   * with one claiming a reading. Routing every assignment through here makes
   * "no cause" a decision a caller has to write down, and gives the ledger the one
   * seam it needs to see every transition.
   */
  private setTransportState(
    state: SyncTransportState,
    reason: SyncFallbackReason | undefined,
    socketPreserved = false,
  ): void {
    this.state = state
    this.fallbackReason = reason
    this.ledger.recordTransition(state, reason, socketPreserved)
    this.publishSaveLane()
  }

  /**
   * Whether a save made now would ride the socket: the socket is READY, it
   * negotiated SYNC_ITEMS, and the worker holds no refusal window or
   * live-sync-disabled verdict. Anything else sends saves over HTTP.
   *
   * Read by live collaboration, which must never let a room's body be saved over
   * HTTP while other people are in it (see `CollaborationSaverElection`). When a
   * refusal window runs out the lane reads usable again: the next save probes it,
   * and a repeated refusal starts a new, longer window.
   */
  get saveLane(): SyncSaveLane {
    const hold = this.saveLaneHold
    if (hold && (hold.heldUntil === undefined || Date.now() < hold.heldUntil)) {
      return { usable: false, code: hold.code, ...(hold.heldUntil !== undefined ? { heldUntil: hold.heldUntil } : {}) }
    }
    if (this.state !== 'READY') {
      return { usable: false, code: 'SOCKET_NOT_READY' }
    }
    if (!this.negotiated?.operations.has('SYNC_ITEMS')) {
      return { usable: false, code: 'SYNC_ITEMS_UNAVAILABLE' }
    }
    return { usable: true }
  }

  /** Called with the new reading whenever `saveLane` changes. Returns an unsubscribe. */
  subscribeSaveLane(listener: (lane: SyncSaveLane) => void): () => void {
    this.saveLaneListeners.add(listener)
    return () => {
      this.saveLaneListeners.delete(listener)
    }
  }

  private publishSaveLane(): void {
    if (this.saveLaneTimer !== undefined) {
      clearTimeout(this.saveLaneTimer)
      this.saveLaneTimer = undefined
    }
    const lane = this.saveLane
    // A window that is still running ends by the clock, which posts nothing.
    if (lane.heldUntil !== undefined && !this.deinitialized) {
      this.saveLaneTimer = setTimeout(
        () => {
          this.saveLaneTimer = undefined
          this.publishSaveLane()
        },
        Math.max(0, lane.heldUntil - Date.now()),
      )
    }
    const previous = this.publishedSaveLane
    if (
      previous &&
      previous.usable === lane.usable &&
      previous.code === lane.code &&
      previous.heldUntil === lane.heldUntil
    ) {
      return
    }
    this.publishedSaveLane = lane
    for (const listener of [...this.saveLaneListeners]) {
      try {
        listener(lane)
      } catch (error) {
        console.error('[sync-transport] A save-lane observer threw.', error)
      }
    }
  }

  private applySaveLaneMessage(message: Extract<SyncWorkerToMainMessage, { type: 'SAVE_LANE' }>): void {
    if (!message.held) {
      this.saveLaneHold = undefined
    } else if (message.code === 'LIVE_SYNC_DISABLED') {
      this.saveLaneHold = { code: 'LIVE_SYNC_DISABLED' }
    } else if (
      isSyncCommandRefusalCode(message.code) &&
      typeof message.holdForMilliseconds === 'number' &&
      Number.isSafeInteger(message.holdForMilliseconds) &&
      message.holdForMilliseconds > 0
    ) {
      this.saveLaneHold = { code: message.code, heldUntil: Date.now() + message.holdForMilliseconds }
    } else {
      // Admitted by shape only. A hold this build cannot read is still a hold; it
      // is given the shortest window the worker ever uses rather than none.
      this.saveLaneHold = { code: 'NOT_AUTHORIZED', heldUntil: Date.now() + UNREADABLE_SAVE_LANE_HOLD_MS }
    }
    this.publishSaveLane()
  }

  subscribeSaveRefusals(listener: (room: string, fenceToken: string | undefined) => void): () => void {
    this.saveRefusalListeners.add(listener)
    return () => this.saveRefusalListeners.delete(listener)
  }

  /**
   * One lane standing down on its own, with the socket — if there is one — left
   * exactly as it was.
   *
   * *** TWO CASES, AND ONLY ONE OF THEM IS A FACT ABOUT THE TRANSPORT. ***
   *
   * While the transport is ON THE SOCKET, a single request sent to HTTP is a
   * per-lane event: nothing fell back, the socket is up, and the next request
   * rides it. It is counted in the ledger and it must NOT touch `fallbackReason`.
   * It used to — routed through `setTransportState` at the current state — and
   * since no later transition arrives to clear it (the worker's state never
   * moved), a READY transport reported a fallback reason for the life of the
   * page, and the ledger gained a phantom READY the pane counted as a recovery.
   *
   * While the transport is NOT on the socket, the lane's cause IS the transport's
   * current reason — a tab standing down for a sibling is told so here before any
   * STATE message says it — so it is recorded as before.
   */
  private recordLaneStandDown(reason: SyncFallbackReason): void {
    if (LANE_STATE_CARRIER[this.state] === 'socket') {
      this.ledger.recordLaneStandDown(reason)
      return
    }
    this.setTransportState(this.state, reason, true)
  }

  /**
   * Which build this tab's sync worker says it is.
   *
   * Three answers, kept apart because they mean different things to whoever
   * reads them: there is no worker; there is one and it has said; there is one
   * and it has not said for `silentForMs` — which, past the moment a worker
   * needs to start, is a worker from before it could say anything.
   */
  get workerBuild(): SyncWorkerBuildReading {
    const report = this.workerBuildReport
    if (this.worker === undefined || report === undefined) {
      return { state: 'no-worker' }
    }
    if (report.revision === undefined) {
      return { state: 'silent', silentForMs: Math.max(0, Date.now() - report.startedAtMs) }
    }

    return { state: 'reported', revision: report.revision }
  }

  get transportStatus(): {
    state: SyncTransportState
    fallbackReason?: SyncFallbackReason
    operations: readonly SyncNegotiatedOperation[]
  } {
    return {
      state: this.state,
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
      operations: this.negotiated ? [...this.negotiated.operations] : [],
    }
  }

  recoverPending(
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
  ): Promise<AccountSyncTransportRecoveryResult<TransportResponse> | undefined> {
    return this.enqueue(() => this.recoverPendingOrdered(httpFallback))
  }

  /**
   * *** WHERE A SYNC ROUND IS COUNTED, AND WHY HERE. ***
   *
   * Every path through `executeOrdered` ends in exactly one of three ways: the
   * worker's committed RESULT resolves it without the HTTP fallback ever being
   * called; the fallback is called and its response is returned; or it rejects.
   * So the fallback is wrapped to notice being called, and the round is recorded
   * where the promise settles — one place, instead of a counter at each of the
   * eight sites that can send a round to HTTP, where the ninth would be missed.
   *
   * An HTTP response that is not a success is `failed` and not `http`: the HTTP
   * client resolves with an error response rather than throwing, and "carried by
   * HTTP" must not be claimable by a 401 or a 500.
   */
  execute(
    request: AccountSyncTransportRequest,
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
    context?: AccountSyncTransportContext,
  ): Promise<AccountSyncTransportResult<TransportResponse>> {
    const socketOnly = context?.socketOnly === true || this.containsSocketOnlyItems(request)
    context = { ...context, ...(socketOnly ? { socketOnly: true } : {}) }
    let servedOverHttp: boolean | undefined
    // EVERY argument is forwarded, by spread and not by name. The fallback takes
    // the durable command's metadata as a second argument on a replay, and a
    // wrapper declared with one parameter compiles and silently drops it.
    const observedFallback: AccountSyncHttpFallback<TransportResponse> = async (...args) => {
      if (socketOnly || this.containsSocketOnlyItems(args[0])) {
        throw transportError('Live collaboration saves require the socket save lane.')
      }
      const response = await httpFallback(...args)
      servedOverHttp = isSuccessfulSyncResponse(response)
      return response
    }

    return this.enqueue(() => this.executeOrdered(request, observedFallback, context)).then(
      (result) => {
        this.ledger.recordSyncRound(servedOverHttp === undefined ? 'socket' : servedOverHttp ? 'http' : 'failed')
        const complete = () => {
          if (!isSuccessfulSyncResponse(result.response)) {
            return
          }
          const data = result.response.data
          for (const saved of (data && 'saved_items' in data ? data.saved_items : []) ?? []) {
            if (!this.activeSocketOnlyItems.has(saved.uuid) && this.options.isItemServerAcknowledged?.(saved.uuid)) {
              this.socketOnlyItems.delete(saved.uuid)
            }
          }
          this.persistSocketOnlyItems()
        }
        const checkpoint = result.markCheckpointDurable
        if (!checkpoint) {
          complete()
          return result
        }
        return {
          ...result,
          markCheckpointDurable: async () => {
            await checkpoint?.()
            complete()
          },
        }
      },
      (error: unknown) => {
        this.ledger.recordSyncRound('failed')
        throw error
      },
    )
  }

  // Keep the constraint after the editor unmounts: a delayed dirty batch must not
  // become an HTTP write simply because its originating room has disappeared.
  private readonly socketOnlyItems = new Set<string>()
  private readonly activeSocketOnlyItems = new Set<string>()
  private socketReadinessConsumer?: { clientRequestId: string; sessionScope: string }
  private socketReadinessSetup?: Promise<void>
  private socketReadinessUpdateRequested = false
  private readonly collaborationSaverPermissions = new Map<string, boolean>()

  setCollaborationSaver(room: string, canSave: boolean): void {
    this.collaborationSaverPermissions.set(room, canSave)
    this.worker?.postMessage({ type: 'SET_COLLABORATION_SAVER', room, canSave })
  }

  private isCollaborativeSaveRefused(uuid: string): boolean {
    const refused = this.refusedItems.get(uuid)
    if (refused) {
      if (refused.until > Date.now() && this.options.getCollaborationSaveFence?.(uuid)?.token === refused.fenceToken) {
        return true
      }
      this.refusedItems.delete(uuid)
    }
    return false
  }

  isCollaborativeItemUploadAllowed(uuid: string): boolean {
    if (this.isCollaborativeSaveRefused(uuid)) {
      return false
    }
    if (!this.socketOnlyItems.has(uuid)) {
      return true
    }
    return this.activeSocketOnlyItems.has(uuid)
      ? this.collaborationSaverPermissions.get(uuid) === true
      : this.saveLane.usable
  }

  private get socketOnlyStorageKey(): string {
    return `standardnotes-collaboration-socket-only:${this.options.deviceId}`
  }

  private persistSocketOnlyItems(): boolean {
    try {
      globalThis.localStorage.setItem(this.socketOnlyStorageKey, JSON.stringify([...this.socketOnlyItems]))
      return true
    } catch {
      return false
    }
  }

  requireSocketSavesForItem(uuid: string): boolean {
    this.socketOnlyItems.add(uuid)
    this.activeSocketOnlyItems.add(uuid)
    this.maintainSocketReadiness()
    return this.persistSocketOnlyItems()
  }

  releaseSocketSavesForItem(uuid: string, serverAcknowledged: boolean): void {
    this.activeSocketOnlyItems.delete(uuid)
    this.maintainSocketReadiness()
    if (serverAcknowledged) {
      this.socketOnlyItems.delete(uuid)
      this.persistSocketOnlyItems()
    }
  }

  private maintainSocketReadiness(): void {
    if (this.deinitialized) {
      return
    }
    if (this.socketReadinessSetup) {
      this.socketReadinessUpdateRequested = true
      return
    }
    const operation = this.updateSocketReadiness()
    this.socketReadinessSetup = operation
    void operation
      .finally(() => {
        if (this.socketReadinessSetup === operation) {
          this.socketReadinessSetup = undefined
          if (this.socketReadinessUpdateRequested) {
            this.socketReadinessUpdateRequested = false
            this.maintainSocketReadiness()
          }
        }
      })
      .catch(() => undefined)
  }

  private async updateSocketReadiness(): Promise<void> {
    if (this.activeSocketOnlyItems.size === 0) {
      if (this.socketReadinessConsumer) {
        this.worker?.postMessage({
          type: 'RELEASE_SOCKET_READY',
          clientRequestId: this.socketReadinessConsumer.clientRequestId,
        })
        this.socketReadinessConsumer = undefined
      }
      return
    }
    if (this.socketReadinessConsumer || !this.environmentSupported() || this.sessionLaneUnavailableReason()) {
      return
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      return
    }
    const worker = await this.workerForSession(sessionScope)
    const currentScope = await this.currentSessionScope()
    if (
      !worker ||
      this.worker !== worker ||
      this.workerSessionScope !== sessionScope ||
      currentScope !== sessionScope ||
      this.revokedSessionScopes.has(sessionScope) ||
      this.deinitialized ||
      this.activeSocketOnlyItems.size === 0
    ) {
      return
    }
    const clientRequestId = this.nextRequestId('socket-ready')
    this.socketReadinessConsumer = { clientRequestId, sessionScope }
    worker.postMessage({ type: 'KEEP_SOCKET_READY', clientRequestId, sessionScope })
  }

  private containsSocketOnlyItems(request: AccountSyncTransportRequest): boolean {
    return request.items.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { uuid?: unknown }).uuid === 'string' &&
        this.socketOnlyItems.has((item as { uuid: string }).uuid),
    )
  }

  /**
   * `expectedRoomEpoch` is optional by design rather than vestigial. Omitted, the
   * worker discovers the room epoch itself and grants against whatever it finds.
   * Supplied, it pins the request: `SyncTransportWorkerRuntime` compares it to the
   * discovered epoch and denies before the grant leg is ever sent, so a caller
   * holding state from a since-rotated room is cut off during discovery instead of
   * receiving a capability for the new epoch.
   */
  authorizeCollaborationRoom(
    noteUuid: string,
    leaseRequestId?: string,
    bootstrapChallenge?: string,
    expectedRoomEpoch?: string,
  ): Promise<CollaborationAuthorizationTransportResult | null | undefined> {
    return this.enqueue(() =>
      this.authorizeCollaborationRoomOrdered({
        noteUuid,
        collaborationProtocolVersion: 3,
        ...(leaseRequestId ? { leaseRequestId } : {}),
        ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
        ...(expectedRoomEpoch ? { expectedRoomEpoch } : {}),
      }),
    )
  }

  /**
   * Opens a multiplexed authenticated RPC on the worker-owned sync socket.
   * Callers may use HTTP only when a rejected AuthenticatedRpcError explicitly
   * has `safeToFallback === true`; requests are never replayed after being sent.
   */
  async openAuthenticatedRpcStream(request: AuthenticatedRpcStreamRequest): Promise<AuthenticatedRpcResponse> {
    const normalized = normalizeAuthenticatedRpcRequest(request)
    if (this.deinitialized || !this.environmentSupported()) {
      throw new AuthenticatedRpcError('SOCKET_UNAVAILABLE', true, true)
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      throw new AuthenticatedRpcError('SESSION_UNAVAILABLE', false, true)
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      throw new AuthenticatedRpcError('WORKER_UNAVAILABLE', true, true)
    }
    const clientRequestId = this.nextRequestId('rpc')
    return new Promise<AuthenticatedRpcResponse>((resolve, reject) => {
      const pending: PendingRpc = {
        sessionScope,
        accepted: false,
        responseResolved: false,
        resolve,
        reject,
        creditToReturn: 0,
      }
      if (request.signal?.aborted) {
        reject(new AuthenticatedRpcError('CANCELLED', false, true))
        return
      }
      if (request.signal) {
        const abort = () => worker.postMessage({ type: 'CANCEL_RPC', clientRequestId })
        request.signal.addEventListener('abort', abort, { once: true })
        pending.abortCleanup = () => request.signal?.removeEventListener('abort', abort)
      }
      this.pendingRpcs.set(clientRequestId, pending)
      worker.postMessage({ type: 'OPEN_RPC', clientRequestId, sessionScope, request: normalized })
    })
  }

  /**
   * True only when a live, authenticated socket has actually negotiated FILES_V1.
   *
   * Never optimistic and never a promise: this reads the operation list the
   * gateway sent in `AUTHENTICATED`, so it is false on every deployment that
   * does not serve the lane, false before the socket is up, and false again the
   * moment the socket degrades. Callers use it to decide whether to try the
   * socket at all, which is what keeps the HTTP path completely untouched where
   * the lane is absent.
   */
  isFileLaneAvailable(): boolean {
    return (
      !this.deinitialized &&
      this.state === 'READY' &&
      this.negotiated?.operations.has('FILES_V1') === true &&
      this.worker !== undefined
    )
  }

  /**
   * Streams one file's encrypted bytes over the negotiated socket.
   *
   * Opens nothing on its own: with no socket already up and advertising
   * FILES_V1 this returns `unavailable` without a ticket request or a connection
   * attempt, and the caller proceeds over HTTP exactly as before.
   *
   * Authorization is unchanged, not relaxed. The client sends only the resource
   * reference; the gateway mints its own single-use credential and re-validates
   * the session per operation, so this lane cannot move bytes that the HTTP path
   * would have refused.
   */
  async downloadFileOverSocket(request: SocketFileDownloadRequest): Promise<SocketFileDownloadOutcome> {
    if (!this.isFileLaneAvailable() || !this.environmentSupported()) {
      return { outcome: 'unavailable' }
    }
    const resource: SocketFileResourceReference = request.sharedVault
      ? {
          ownershipType: 'shared-vault',
          remoteIdentifier: request.remoteIdentifier,
          fileUuid: request.fileUuid,
          sharedVaultUuid: request.sharedVault.sharedVaultUuid,
          sharedVaultOwnerUuid: request.sharedVault.sharedVaultOwnerUuid,
        }
      : { ownershipType: 'user', remoteIdentifier: request.remoteIdentifier, fileUuid: request.fileUuid }
    if (
      !Number.isSafeInteger(request.declaredSize) ||
      request.declaredSize < 1 ||
      !isSocketFileResourceReference(resource)
    ) {
      return { outcome: 'unavailable' }
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope) || this.workerSessionScope !== sessionScope) {
      return { outcome: 'unavailable' }
    }
    const worker = this.worker
    if (!worker || !this.isFileLaneAvailable()) {
      return { outcome: 'unavailable' }
    }
    if (request.signal?.aborted) {
      return { outcome: 'aborted' }
    }

    const clientRequestId = this.nextRequestId('file-download')
    return new Promise<SocketFileDownloadOutcome>((resolve) => {
      const pending: PendingFileDownload = {
        sessionScope,
        request,
        settle: resolve,
        settled: false,
        bytesDelivered: 0,
        tail: Promise.resolve(),
      }
      if (request.signal) {
        const abort = () => {
          worker.postMessage({ type: 'CANCEL_FILE_DOWNLOAD', clientRequestId })
          this.settleFileDownload(clientRequestId, pending, { outcome: 'aborted' })
        }
        request.signal.addEventListener('abort', abort, { once: true })
        pending.abortCleanup = () => request.signal?.removeEventListener('abort', abort)
      }
      this.pendingFileDownloads.set(clientRequestId, pending)
      worker.postMessage({
        type: 'OPEN_FILE_DOWNLOAD',
        clientRequestId,
        sessionScope,
        request: {
          resource,
          declaredSize: request.declaredSize,
          initialCreditBytes: DEFAULT_FILE_TRANSFER_CREDIT_BYTES,
          deadlineMs: DEFAULT_FILE_TRANSFER_DEADLINE_MS,
        },
      })
    })
  }

  /**
   * Opens one file upload on the negotiated socket.
   *
   * Opens nothing on its own: with no socket already up and advertising FILES_V1
   * this answers `unavailable` without a ticket request or a connection attempt,
   * and the caller uploads over HTTP exactly as before. Authorization is
   * unchanged — the client sends only a resource reference and the gateway mints
   * its own single-use credential per operation — so this lane cannot move bytes
   * the HTTP path would have refused.
   *
   * Every validation below mirrors one the worker and the gateway perform anyway.
   * Duplicating them is deliberate: a request this client already knows will be
   * refused should cost no round trip, and should leave no transfer in a state
   * that then needs resolving.
   */
  async uploadFileOverSocket(request: SocketFileUploadRequest): Promise<SocketFileUploadOpenOutcome> {
    if (!this.isFileLaneAvailable() || !this.environmentSupported()) {
      return { outcome: 'unavailable' }
    }
    const resource: SocketFileResourceReference = request.sharedVault
      ? {
          ownershipType: 'shared-vault',
          remoteIdentifier: request.remoteIdentifier,
          fileUuid: request.fileUuid,
          sharedVaultUuid: request.sharedVault.sharedVaultUuid,
          sharedVaultOwnerUuid: request.sharedVault.sharedVaultOwnerUuid,
        }
      : { ownershipType: 'user', remoteIdentifier: request.remoteIdentifier, fileUuid: request.fileUuid }
    if (
      !isSocketFileResourceReference(resource) ||
      !isTransferSize(request.decryptedSize) ||
      // The 5 GiB cap bounds the ENCRYPTED total, so the per-chunk overhead eats
      // into it. Checking the decrypted size here instead would admit a band of
      // files that the gateway then refuses at the open.
      !isTransferSize(request.declaredSize) ||
      !isSendableMimeType(request.mimeType)
    ) {
      return { outcome: 'unavailable' }
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope) || this.workerSessionScope !== sessionScope) {
      return { outcome: 'unavailable' }
    }
    const worker = this.worker
    if (!worker || !this.isFileLaneAvailable()) {
      return { outcome: 'unavailable' }
    }
    if (request.signal?.aborted) {
      return { outcome: 'aborted' }
    }

    const clientRequestId = this.nextRequestId('file-upload')
    const pending: PendingFileUpload = { sessionScope, finishAttempted: false, closed: false }
    this.pendingFileUploads.set(clientRequestId, pending)
    if (request.signal) {
      const abort = () => this.cancelFileUpload(clientRequestId, pending)
      request.signal.addEventListener('abort', abort, { once: true })
      pending.abortCleanup = () => request.signal?.removeEventListener('abort', abort)
    }

    const opened = await new Promise<SocketFileUploadOpenOutcome>((resolve) => {
      pending.step = { kind: 'open', settle: resolve }
      worker.postMessage({
        type: 'OPEN_FILE_UPLOAD',
        clientRequestId,
        sessionScope,
        request: {
          resource,
          decryptedSize: request.decryptedSize,
          declaredSize: request.declaredSize,
          mimeType: request.mimeType,
          deadlineMs: DEFAULT_FILE_TRANSFER_DEADLINE_MS,
        },
      })
    })
    if (opened.outcome !== 'opened') {
      this.closeFileUpload(clientRequestId, pending)
    }
    return opened
  }

  private fileUploadSession(clientRequestId: string, pending: PendingFileUpload): SocketFileUploadSession {
    return {
      sendChunk: (chunk) =>
        this.awaitFileUploadStep<SocketFileUploadChunkOutcome>(clientRequestId, pending, (settle, worker) => {
          pending.step = { kind: 'chunk', settle }
          worker.postMessage({
            type: 'SEND_FILE_CHUNK',
            clientRequestId,
            index: chunk.index,
            offset: chunk.offset,
            bytes: chunk.bytes,
          })
        }),
      finish: (input) =>
        this.awaitFileUploadStep<SocketFileUploadFinishOutcome>(clientRequestId, pending, (settle, worker) => {
          // Marked before the write. The client cannot know whether bytes it wrote
          // arrived, so "FINISH was attempted" is the only transition point that
          // never under-states the risk of the upload already having been applied.
          pending.finishAttempted = true
          pending.step = { kind: 'finish', settle }
          worker.postMessage({
            type: 'FINISH_FILE_UPLOAD',
            clientRequestId,
            transferId: input.transferId,
            generation: input.generation,
            declaredSize: input.declaredSize,
            sha256: input.sha256,
          })
        }),
      cancel: () => this.cancelFileUpload(clientRequestId, pending),
    }
  }

  private awaitFileUploadStep<T extends SocketFileUploadChunkOutcome | SocketFileUploadFinishOutcome>(
    clientRequestId: string,
    pending: PendingFileUpload,
    write: (settle: (outcome: T) => void, worker: SyncWorkerLike) => void,
  ): Promise<T> {
    const unusable = {
      outcome: 'failed',
      code: 'SOCKET_CLOSED',
      retryable: true,
      safeToFallback: !pending.finishAttempted,
    } as T
    const worker = this.worker
    if (pending.closed || this.pendingFileUploads.get(clientRequestId) !== pending || !worker) {
      return Promise.resolve(unusable)
    }
    if (pending.step) {
      // One outstanding step at a time: a second concurrent write would make the
      // next ack ambiguous, and an ambiguous ack is a wrong `nextOffset`.
      return Promise.resolve({
        outcome: 'failed',
        code: 'FILE_STEP_IN_FLIGHT',
        retryable: false,
        safeToFallback: false,
      } as T)
    }
    return new Promise<T>((resolve) => write(resolve, worker))
  }

  private handleFileUploadWorkerMessage(message: FileUploadWorkerMessage, pending: PendingFileUpload): void {
    const step = pending.step
    if (message.type === 'FILE_UPLOAD_ERROR') {
      const failure: SocketFileUploadFailure = {
        outcome: 'failed',
        code: message.code,
        retryable: message.retryable,
        // The worker reports what the socket saw; this thread additionally knows
        // whether FINISH was ever written, and that is the stricter of the two.
        safeToFallback: message.safeToFallback && !pending.finishAttempted,
      }
      this.settleFileUploadStep(pending, failure)
      this.closeFileUpload(message.clientRequestId, pending)
      return
    }
    if (message.type === 'FILE_UPLOAD_ACCEPTED') {
      if (step?.kind !== 'open') {
        return
      }
      pending.step = undefined
      step.settle({
        outcome: 'opened',
        position: {
          transferId: message.transferId,
          generation: message.generation,
          resumeId: message.resumeId,
          nextIndex: message.nextIndex,
          nextOffset: message.nextOffset,
          declaredSize: message.declaredSize,
          maxFrameBytes: MAX_FILE_CHUNK_BYTES,
        },
        session: this.fileUploadSession(message.clientRequestId, pending),
      })
      return
    }
    if (message.type === 'FILE_UPLOAD_CHUNK_ACK') {
      if (step?.kind !== 'chunk') {
        return
      }
      pending.step = undefined
      step.settle({
        outcome: 'acknowledged',
        transferId: message.transferId,
        generation: message.generation,
        index: message.index,
        duplicate: message.duplicate,
        nextIndex: message.nextIndex,
        nextOffset: message.nextOffset,
        resumeId: message.resumeId,
      })
      return
    }
    if (step?.kind !== 'finish') {
      return
    }
    pending.step = undefined
    step.settle({ outcome: 'completed', sha256: message.sha256 })
    this.closeFileUpload(message.clientRequestId, pending)
  }

  private settleFileUploadStep(pending: PendingFileUpload, failure: SocketFileUploadFailure): void {
    const step = pending.step
    if (!step) {
      return
    }
    pending.step = undefined
    if (step.kind === 'open') {
      step.settle(failure)
      return
    }
    step.settle(failure)
  }

  private cancelFileUpload(clientRequestId: string, pending: PendingFileUpload): void {
    if (pending.closed) {
      return
    }
    this.worker?.postMessage({ type: 'CANCEL_FILE_UPLOAD', clientRequestId })
    this.settleFileUploadStep(pending, {
      outcome: 'failed',
      code: 'FILE_CANCELLED',
      retryable: false,
      safeToFallback: !pending.finishAttempted,
    })
    this.closeFileUpload(clientRequestId, pending)
  }

  private closeFileUpload(clientRequestId: string, pending: PendingFileUpload): void {
    pending.closed = true
    if (this.pendingFileUploads.get(clientRequestId) === pending) {
      this.pendingFileUploads.delete(clientRequestId)
    }
    pending.abortCleanup?.()
    pending.abortCleanup = undefined
  }

  private failAllFileUploads(code: string, sessionScope?: string): void {
    for (const [clientRequestId, pending] of [...this.pendingFileUploads]) {
      if (sessionScope !== undefined && pending.sessionScope !== sessionScope) {
        continue
      }
      this.settleFileUploadStep(pending, {
        outcome: 'failed',
        code,
        retryable: false,
        safeToFallback: !pending.finishAttempted,
      })
      this.closeFileUpload(clientRequestId, pending)
    }
  }

  async subscribeInviteEvents(options: InviteRealtimeSubscriptionOptions): Promise<() => void> {
    if (this.deinitialized || !this.environmentSupported()) {
      throw new AuthenticatedRpcError('SOCKET_UNAVAILABLE', true, true)
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      throw new AuthenticatedRpcError('SESSION_UNAVAILABLE', false, true)
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      throw new AuthenticatedRpcError('WORKER_UNAVAILABLE', true, true)
    }
    const limit = options.limit ?? 100
    if (
      (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 2_048)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new AuthenticatedRpcError('INVALID_REQUEST', false, true)
    }
    for (const [requestId, pending] of this.pendingInviteSubscriptions) {
      this.pendingInviteSubscriptions.delete(requestId)
      this.worker?.postMessage({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId: requestId })
      pending.options.onError?.(new AuthenticatedRpcError('REPLACED', false, true))
    }
    const clientRequestId = this.nextRequestId('invite-events')
    const pending: PendingInviteSubscription = { sessionScope, options, tail: Promise.resolve() }
    this.pendingInviteSubscriptions.set(clientRequestId, pending)
    worker.postMessage({
      type: 'SUBSCRIBE_INVITE_EVENTS',
      clientRequestId,
      sessionScope,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit,
    })
    return () => {
      if (this.pendingInviteSubscriptions.get(clientRequestId) !== pending) {
        return
      }
      this.pendingInviteSubscriptions.delete(clientRequestId)
      this.worker?.postMessage({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId })
    }
  }

  async notifySessionRevoked(): Promise<void> {
    const sourceWorker = this.worker
    const sessionScope = (await this.currentSessionScope()) ?? this.workerSessionScope
    if (this.worker !== sourceWorker) {
      return
    }
    return this.revokeSessionScope(sessionScope, sourceWorker)
  }

  private async revokeSessionScope(
    sessionScope: string | undefined,
    sourceWorker: SyncWorkerLike | undefined,
  ): Promise<void> {
    if (this.worker !== sourceWorker) {
      return
    }
    if (!sessionScope) {
      this.terminateWorker()
      // No reason, and the previous one is CLEARED rather than carried: the lane is
      // down because the session it rode is gone, and whatever sent it to HTTP
      // before that describes a condition nobody can act on any more.
      this.setTransportState('HTTP_ONLY', undefined)
      return
    }
    if (this.acknowledgedRevokedSessionScopes.has(sessionScope)) {
      this.terminateWorker()
      this.setTransportState('HTTP_ONLY', undefined)
      return
    }
    this.revokedSessionScopes.add(sessionScope)
    const error = transportError('Websocket sync session was revoked.')
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionScope === sessionScope) {
        pending.reject(error)
        this.pending.delete(requestId)
      }
    }
    for (const [requestId, pending] of this.pendingCollaboration) {
      if (pending.sessionScope === sessionScope) {
        pending.reject(error)
        this.pendingCollaboration.delete(requestId)
      }
    }
    for (const [requestId, pending] of this.pendingRpcs) {
      if (pending.sessionScope === sessionScope) {
        this.rejectRpc(requestId, pending, new AuthenticatedRpcError('SESSION_REVOKED', false, false))
      }
    }
    for (const [requestId, pending] of this.pendingInviteSubscriptions) {
      if (pending.sessionScope === sessionScope) {
        pending.options.onError?.(new AuthenticatedRpcError('SESSION_REVOKED', false, false))
        this.pendingInviteSubscriptions.delete(requestId)
      }
    }
    this.failAllFileDownloads('SESSION_REVOKED', sessionScope)
    this.failAllFileUploads('SESSION_REVOKED', sessionScope)
    this.negotiated = undefined

    if (!this.environmentSupported()) {
      this.terminateWorker()
      this.setTransportState('HTTP_ONLY', 'unsupported-browser')
      return
    }

    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      // KEEPS the reason on purpose: the only way to arrive here is
      // `workerForSession` having failed, and it has already recorded why.
      this.setTransportState('HTTP_ONLY', this.fallbackReason)
      return
    }
    if (this.worker !== worker) {
      return
    }
    const requestId = this.nextRequestId('revoke')
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.revocationBarriers.delete(requestId)
          reject(transportError('Timed out waiting for sync session quarantine.'))
        }, BARRIER_TIMEOUT_MS)
        this.revocationBarriers.set(requestId, { resolve, reject, timeout })
        worker.postMessage({ type: 'SESSION_REVOKED', requestId, sessionScope })
      })
      this.acknowledgedRevokedSessionScopes.add(sessionScope)
    } finally {
      if (this.worker === worker) {
        this.terminateWorker()
        this.setTransportState('HTTP_ONLY', undefined)
      }
    }
  }

  deinit(): void {
    if (this.deinitialized) {
      return
    }
    this.deinitialized = true
    this.unregisterPageHideRelease()
    const worker = this.worker
    this.worker = undefined
    this.workerSessionScope = undefined
    if (worker) {
      // `terminate()` used to run in the same tick as SHUTDOWN, so the worker
      // never reached the line that hands its owner lease back and the next tab
      // waited out the whole lease TTL before it could sync over the socket.
      void this.terminateAfterShutdown(worker)
      worker.postMessage({ type: 'SHUTDOWN' })
    }
    const error = transportError('Websocket sync transport was deinitialized.')
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    for (const pending of this.pendingCollaboration.values()) {
      pending.reject(error)
    }
    this.pendingCollaboration.clear()
    for (const [requestId, pending] of this.pendingRpcs) {
      this.rejectRpc(requestId, pending, new AuthenticatedRpcError('SHUTDOWN', false, false))
    }
    for (const pending of this.pendingInviteSubscriptions.values()) {
      pending.options.onError?.(new AuthenticatedRpcError('SHUTDOWN', false, false))
    }
    this.pendingInviteSubscriptions.clear()
    this.failAllFileDownloads('SHUTDOWN')
    this.failAllFileUploads('SHUTDOWN')
    this.negotiated = undefined
    this.saveLaneHold = undefined
    this.rejectAllBarriers(error)
    // A deliberate shutdown is not a fallback and must not leave one reported.
    this.setTransportState('HTTP_ONLY', undefined)
    this.saveLaneListeners.clear()
    this.saveRefusalListeners.clear()
    this.refusedItems.clear()
    if (this.saveLaneTimer !== undefined) {
      clearTimeout(this.saveLaneTimer)
      this.saveLaneTimer = undefined
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionTail
    let release: () => void = () => undefined
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(async () => {
      try {
        return await operation()
      } finally {
        release()
      }
    })
  }

  private async recoverPendingOrdered(
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
  ): Promise<AccountSyncTransportRecoveryResult<TransportResponse> | undefined> {
    if (this.deinitialized || !this.environmentSupported()) {
      return undefined
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      return undefined
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      return undefined
    }
    // The kill switch (and a platform with no socket lane) must cover recovery
    // too: a record dispatched before the switch flipped can never be asked
    // STATUS again, so the worker replays it over HTTP with its identity.
    const replayOverHttp = this.sessionLaneUnavailableReason()
    const clientRequestId = this.nextRequestId('recover')
    return new Promise<AccountSyncTransportRecoveryResult<TransportResponse> | undefined>((resolve, reject) => {
      this.pending.set(clientRequestId, {
        mode: 'recover',
        sessionScope,
        httpFallback,
        resolve: resolve as (result: PendingResult) => void,
        reject,
      })
      worker.postMessage({
        type: 'RECOVER',
        clientRequestId,
        sessionScope,
        ...(replayOverHttp ? { replayOverHttp } : {}),
      })
    })
  }

  /**
   * Reasons that rule the worker lane out for the whole session before any
   * ticket is worth requesting: the operator/user http-only switch, no configured
   * websocket URL, a URL that is not ws(s), or a page origin that is not http(s).
   * `capability-unavailable` is right for the last three — they are structural,
   * and nothing a retry can change.
   */
  private sessionLaneUnavailableReason(): SyncFallbackReason | undefined {
    if (this.options.isHttpOnly?.() === true || (!this.options.isHttpOnly && defaultHttpOnly())) {
      return 'http-only'
    }
    const configuredUrl = this.options.getConfiguredWebSocketUrl()
    if (!configuredUrl) {
      return 'capability-unavailable'
    }
    let configuredEndpoint: URL
    try {
      configuredEndpoint = new URL(configuredUrl)
    } catch {
      return 'capability-unavailable'
    }
    if (configuredEndpoint.protocol !== 'wss:' && configuredEndpoint.protocol !== 'ws:') {
      return 'capability-unavailable'
    }
    if (!pageOriginSupportsSyncLane(this.options.environment?.pageProtocol)) {
      return 'capability-unavailable'
    }
    return undefined
  }

  private async executeOrdered(
    request: AccountSyncTransportRequest,
    httpFallback: AccountSyncHttpFallback<TransportResponse>,
    context?: AccountSyncTransportContext,
  ): Promise<AccountSyncTransportResult<TransportResponse>> {
    const normalizedRequest = normalizeSyncRequestForWire(request)
    for (const item of normalizedRequest.items) {
      if (typeof item !== 'object' || item === null) {
        continue
      }
      const uuid = (item as { uuid?: unknown }).uuid
      if (
        typeof uuid === 'string' &&
        this.socketOnlyItems.has(uuid) &&
        !this.activeSocketOnlyItems.has(uuid) &&
        this.saveLane.usable
      ) {
        // A departed room's retained local body may recover as an ordinary
        // socket-only write. The DB fence still refuses it while a room saver
        // owns the note; after release/expiry CAS handles true divergences.
        this.setCollaborationSaver(uuid, true)
      }
    }
    const proofs = normalizedRequest.items.flatMap((item) => {
      const proof =
        typeof item === 'object' && item !== null
          ? this.options.getCollaborationSaveFence?.((item as { uuid: string }).uuid)
          : undefined
      return proof ? [proof] : []
    })
    if (proofs.length > 0) {
      normalizedRequest.collaboration_save_fences = proofs
    }
    if (
      normalizedRequest.items.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (this.options.canSaveCollaborativeItem?.((item as { uuid: string }).uuid) === false ||
            this.isCollaborativeSaveRefused((item as { uuid: string }).uuid)),
      )
    ) {
      throw transportError('Only the elected collaboration saver may dispatch this note.')
    }
    if (this.deinitialized) {
      this.setTransportState('HTTP_ONLY', undefined)
      return { response: await httpFallback(normalizedRequest) }
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope) {
      // There is no closed reason for "this client is not signed in", and
      // inventing one would put a fault on screen for an ordinary signed-out tab.
      this.setTransportState('HTTP_ONLY', undefined)
      return { response: await httpFallback(normalizedRequest) }
    }
    if (this.revokedSessionScopes.has(sessionScope)) {
      throw transportError('Websocket sync session was revoked.')
    }
    // Decided here, not in the worker: a platform with no socket lane used to pay
    // a worker round trip plus an IndexedDB read on every sync only to be told so.
    const laneUnavailable = this.sessionLaneUnavailableReason()
    if (laneUnavailable) {
      this.setTransportState('HTTP_ONLY', laneUnavailable)
      return { response: await httpFallback(normalizedRequest) }
    }
    if (!this.environmentSupported()) {
      // *** THE REASON THE PANE WAS MISSING. *** `unsupported-browser` has been in
      // the protocol, with its own explanation sentence, since the lane was written
      // — and the only code that ever emitted it is inside the worker, which a
      // browser failing THIS check never gets to start. So the one client that can
      // never use the socket at all was also the one reporting no cause for it.
      this.setTransportState('HTTP_ONLY', 'unsupported-browser')
      return { response: await httpFallback(normalizedRequest) }
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      return { response: await httpFallback(normalizedRequest) }
    }

    const clientRequestId = this.nextRequestId('sync')
    // A room can become live while this request waits in the ordered queue or
    // for session/worker setup. Persist its current transport constraint with
    // the command, independently of the main thread's retained UUID marker.
    if (this.containsSocketOnlyItems(normalizedRequest) || normalizedRequest.collaboration_save_fences?.length) {
      context = { ...context, socketOnly: true }
    }
    for (const [room, canSave] of this.collaborationSaverPermissions) {
      worker.postMessage({ type: 'SET_COLLABORATION_SAVER', room, canSave })
    }
    return new Promise<AccountSyncTransportResult<TransportResponse>>((resolve, reject) => {
      this.pending.set(clientRequestId, {
        mode: 'execute',
        sessionScope,
        body: normalizedRequest,
        httpFallback,
        resolve: resolve as (result: PendingResult) => void,
        reject,
      })
      worker.postMessage({ type: 'EXECUTE', clientRequestId, body: normalizedRequest, sessionScope, context })
    })
  }

  private async authorizeCollaborationRoomOrdered(
    request: CollaborationAuthorizationTransportRequest,
  ): Promise<CollaborationAuthorizationTransportResult | null | undefined> {
    if (this.deinitialized || !this.environmentSupported()) {
      return undefined
    }
    const sessionScope = await this.currentSessionScope()
    if (!sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      return undefined
    }
    const worker = await this.workerForSession(sessionScope)
    if (!worker) {
      return undefined
    }
    const clientRequestId = this.nextRequestId('collaboration')
    return new Promise<CollaborationAuthorizationTransportResult | null | undefined>((resolve, reject) => {
      this.pendingCollaboration.set(clientRequestId, { sessionScope, resolve, reject })
      worker.postMessage({ type: 'AUTHORIZE_COLLABORATION', clientRequestId, sessionScope, request })
    })
  }

  private environmentSupported(): boolean {
    const environment = this.options.environment ?? {
      hasWorker: typeof Worker !== 'undefined',
      hasWebSocket: typeof WebSocket !== 'undefined',
      hasIndexedDb: typeof indexedDB !== 'undefined',
    }
    return environment.hasWorker && environment.hasWebSocket && environment.hasIndexedDb
  }

  private async currentSessionScope(): Promise<string | undefined> {
    try {
      return await this.options.getAuthenticatedSessionScope()
    } catch {
      return undefined
    }
  }

  private async workerForSession(sessionScope: string): Promise<SyncWorkerLike | undefined> {
    if (this.worker && this.workerSessionScope !== sessionScope) {
      await this.quarantineWorkerScope(this.workerSessionScope)
    }
    if (this.worker) {
      return this.worker
    }
    try {
      let worker: SyncWorkerLike
      if (this.options.workerFactory) {
        worker = this.options.workerFactory()
      } else if (typeof SharedWorker !== 'undefined' && sharedSyncWorkerUrl) {
        // sessionScope is already an opaque hash of authenticated identity and
        // its session epoch. Creation stays synchronous so concurrent consumers
        // attach exactly one port per page.
        const name = `srn-sync:${WebBuildRevision}:${sessionScope}`
        try {
          worker = new SharedSyncWorkerClient(
            new SharedWorker(sharedSyncWorkerUrl, { name }),
            sessionScope,
            WebBuildRevision,
          )
        } catch {
          worker = new SyncTransportWorker() as unknown as SyncWorkerLike
        }
      } else {
        worker = new SyncTransportWorker() as unknown as SyncWorkerLike
      }
      if (this.deinitialized || this.revokedSessionScopes.has(sessionScope)) {
        worker.terminate()
        return undefined
      }
      worker.onmessage = (event) => {
        // A terminated/replaced worker can still have callbacks queued. Only its
        // own graceful shutdown acknowledgment may outlive active ownership.
        if (event.data.type === 'SHUTDOWN_COMPLETE') {
          if (this.shutdownWorker === worker) {
            this.shutdownBarrier?.()
          }
          return
        }
        if (this.worker === worker && !this.deinitialized) {
          void this.onWorkerMessage(event.data)
        }
      }
      worker.onerror = () => {
        if (this.worker === worker && !this.deinitialized) {
          void this.onWorkerError()
        }
      }
      worker.onexpired = () => {
        if (this.worker === worker && !this.deinitialized) {
          void this.onWorkerError().then(() => this.maintainSocketReadiness())
        }
      }
      this.worker = worker
      this.workerBuildReport = { startedAtMs: Date.now() }
      this.workerSessionScope = sessionScope
      this.registerPageHideRelease()
      return worker
    } catch {
      // The Worker constructor threw: a blocked worker script, an exhausted
      // process budget, a CSP that forbids the bundle. `worker-error` is the
      // transport's own name for exactly this and was being dropped on the floor.
      this.setTransportState('HTTP_ONLY', 'worker-error')
      return undefined
    }
  }

  private async quarantineWorkerScope(sessionScope: string | undefined): Promise<void> {
    const worker = this.worker
    if (!worker || !sessionScope) {
      this.terminateWorker()
      return
    }
    this.revokedSessionScopes.add(sessionScope)
    const requestId = this.nextRequestId('rotate')
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.revocationBarriers.delete(requestId)
          reject(transportError('Timed out rotating the sync session worker.'))
        }, BARRIER_TIMEOUT_MS)
        this.revocationBarriers.set(requestId, { resolve, reject, timeout })
        worker.postMessage({ type: 'SESSION_REVOKED', requestId, sessionScope })
      })
      this.acknowledgedRevokedSessionScopes.add(sessionScope)
    } finally {
      if (this.worker === worker) {
        this.terminateWorker()
      }
    }
  }

  private terminateWorker(): void {
    const worker = this.worker
    this.worker = undefined
    this.workerBuildReport = undefined
    this.workerSessionScope = undefined
    this.socketReadinessConsumer = undefined
    this.negotiated = undefined
    // The hold lived in that worker; the next one starts without it.
    this.saveLaneHold = undefined
    this.refusedItems.clear()
    worker?.terminate()
    this.publishSaveLane()
  }

  /** Terminates on `SHUTDOWN_COMPLETE`, or when the grace window runs out. */
  private terminateAfterShutdown(worker: SyncWorkerLike): Promise<void> {
    this.negotiated = undefined
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (this.shutdownBarrier === finish) {
          this.shutdownBarrier = undefined
          this.shutdownWorker = undefined
        }
        worker.terminate()
        resolve()
      }
      const timeout = setTimeout(finish, WORKER_SHUTDOWN_GRACE_MS)
      this.shutdownBarrier = finish
      this.shutdownWorker = worker
    })
  }

  /**
   * A tab being closed or navigated away from should hand the socket over at
   * once rather than leaving the next tab to wait out the lease. `pagehide`
   * fires for both, and for the back/forward cache, where the worker's own
   * in-flight check keeps the release from costing anything.
   */
  private registerPageHideRelease(): void {
    if (this.pageHideListener || typeof globalThis.addEventListener !== 'function') {
      return
    }
    const listener = () => {
      this.worker?.postMessage({ type: 'RELEASE_OWNER' })
    }
    this.pageHideListener = listener
    globalThis.addEventListener('pagehide', listener)
  }

  private unregisterPageHideRelease(): void {
    const listener = this.pageHideListener
    this.pageHideListener = undefined
    if (listener && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('pagehide', listener)
    }
  }

  /**
   * Standard Red Notes (t99): say out loud which transport carries saves.
   *
   * This lane degrades to HTTP silently and correctly — a gateway with no durable
   * command port withholds SYNC_ITEMS, every other capability negotiates, and the
   * socket stays open — so there was NO signal anywhere that saves had left the
   * socket. The only readout was `transportStatus`, rendered exclusively in the
   * admin-gated diagnostics pane, which the affected user usually cannot open. The
   * observable symptom was a burst of `POST /v1/items` and no way to explain it.
   *
   * One line per genuine transition, never per sync round: `announceTransition` is
   * reached on every STATE message and a fallback re-reports the same state and
   * reason for each save, so the signature is deduplicated.
   */
  private announceTransition(state: SyncTransportState, reason: SyncFallbackReason | undefined): void {
    // DEGRADED and HTTP_FALLBACK are ONE announcement for the reader — saves are on
    // HTTP — and the worker posts both of them for a single unchanged cause, because
    // each lane classifies its own refusal: the invite lane posted DEGRADED while the
    // sync and collaboration lanes posted HTTP_FALLBACK for the same
    // `multi-tab-not-owner`. Keyed per state, the signature flipped on every lane and
    // the identical status line was re-logged forever. Keyed per cause, it settles.
    // HTTP_ONLY keeps its own key: it is a different statement ("never the socket").
    const fallbackState = state === 'DEGRADED' || state === 'HTTP_FALLBACK'
    const signature = fallbackState ? `ON_HTTP:${reason ?? 'none'}` : `${state}:${reason ?? 'none'}`
    if (this.lastLoggedTransition === signature) {
      return
    }
    this.lastLoggedTransition = signature

    const usesHttp = state === 'HTTP_ONLY' || fallbackState
    if (!usesHttp) {
      // CONNECTING/AUTHENTICATING/HALF_OPEN are steps on the way to READY, and
      // READY itself is announced by announceNegotiation with the operation list.
      return
    }

    if (!reason) {
      // A socket closed below code 4000 carries no verdict, so the worker has none to
      // report. Saying "is using HTTP" and stopping asserted a settled state with a
      // cause it did not have; the honest line names the gap and what happens next.
      console.warn(
        `[sync-transport] Account sync left the websocket (state ${state}) and NO cause was reported with` +
          ' the transition. Every save is one POST /v1/items meanwhile.' +
          (fallbackState ? ' The next transition names a cause if the transport determines one.' : ''),
      )
      return
    }

    console.warn(
      `[sync-transport] Account sync is using HTTP (state ${state}, reason ${reason}).` +
        ` Every save is one POST /v1/items. ${SYNC_FALLBACK_REASON_EXPLANATIONS[reason]}`,
    )
  }

  /**
   * The durable invite stream is parked, not broken. Said once per cause, as
   * `console.info`, because the condition is expected: `console.error` here was most
   * of a production console flood for a state the transport's own copy calls "not a
   * fault".
   */
  /**
   * The pre-sync recovery probe found a durable command belonging to the tab that holds
   * the lane. Said once per cause, as `console.info`, for the same reason the invite
   * deferral is: nothing failed, and this used to surface as a `console.error` —
   * `Sync transport recovery failed before collecting uploads` — once per sync, while
   * silently costing this tab every upload in the same cycle.
   */
  private announceRecoveryDeferral(reason: SyncFallbackReason): void {
    const signature = `RECOVERY_DEFERRED:${reason}`
    if (this.lastLoggedRecoveryDeferral === signature) {
      return
    }
    this.lastLoggedRecoveryDeferral = signature
    // eslint-disable-next-line no-console
    console.info(
      `[sync-transport] A durable sync command belongs to the tab that holds the socket (reason ${reason}).` +
        ` ${SYNC_FALLBACK_REASON_EXPLANATIONS[reason]}` +
        ' That tab reconciles it; this one syncs over HTTP in the meantime and keeps uploading.',
    )
  }

  private announceInviteDeferral(reason: SyncFallbackReason): void {
    const signature = `INVITE_DEFERRED:${reason}`
    if (this.lastLoggedInviteDeferral === signature) {
      return
    }
    this.lastLoggedInviteDeferral = signature
    // eslint-disable-next-line no-console
    console.info(
      `[sync-transport] Durable invite events are waiting for the socket (reason ${reason}).` +
        ` ${SYNC_FALLBACK_REASON_EXPLANATIONS[reason]}` +
        ' The subscription stays registered and resumes by itself when this tab takes the lane;' +
        ' nothing is retrying and nothing failed.',
    )
  }

  /**
   * *** THE ONE LINE THAT SAYS THIS TAB TOOK ITSELF OUT OF SERVICE. ***
   *
   * The worker stops dialling for a minute when several handshakes in a row
   * authenticate and then die within seconds, because that loop re-dials at the
   * backoff rate for as long as the tab is open and each cycle spends a ticket out of
   * a bucket keyed on the session — so one looping tab starves every other tab of
   * the account.
   *
   * Every refusal the hold then produces is reported as `reconnect-gap`, and that is
   * the truth about each request and no account at all of the tab having withdrawn
   * itself: "the socket was gone long enough that the session could not be resumed"
   * reads as a passing network event, not as a minute of deliberate stand-down.
   * Without this line the operator sees saves on HTTP, a plausible transient cause,
   * and nothing anywhere saying what is actually holding the lane down or when it
   * lifts.
   *
   * `console.warn`, unlike the invite deferral above: a tab standing down for a
   * sibling is an expected steady state, whereas sockets dying seconds after a
   * successful handshake means something between this browser and the gateway is
   * tearing them down, and that is worth a reader's attention.
   */
  private announceDialHold(holdForMilliseconds: number, handshakes: number): void {
    const seconds = Math.max(1, Math.round(holdForMilliseconds / 1000))
    console.warn(
      `[sync-transport] This tab has STOPPED dialling the websocket for ${seconds}s:` +
        ` ${handshakes} connections in a row authenticated and then died within seconds.` +
        ' Saves and every other lane stay on HTTP and keep working, no ticket is being spent,' +
        ' and nothing is retrying — the tab dials again by itself when the hold lifts.' +
        ' A repeat means something between this browser and the gateway is closing sockets' +
        ' straight after the handshake.',
    )
  }

  /** The counterpart, so the stand-down above has a stated end rather than a silence. */
  private announceDialHoldEnded(): void {
    // eslint-disable-next-line no-console
    console.info(
      '[sync-transport] The websocket dial hold has lifted; this tab tries the socket again on' +
        ' its next sync. Nothing was lost while it stood down.',
    )
  }

  /**
   * The gateway refused one save before executing it, with a code that names why.
   *
   * One lane standing down on a socket that stays up, so it is a ledger stand-down
   * and never a transition. Logged once per refusal — never per held save: the
   * worker holds later saves on HTTP for at least 30 s after each one, so this line
   * cannot repeat per keystroke.
   *
   * SECURITY: the code is admitted by enum membership and the window by shape; an
   * unrecognised value is reported as such, never echoed.
   */
  private announceSaveRefusal(refusal: { code: unknown; holdForMilliseconds: unknown }): void {
    this.recordLaneStandDown('save-refused')
    const code = isSyncCommandRefusalCode(refusal.code) ? refusal.code : 'an unrecognised code'
    const hold =
      typeof refusal.holdForMilliseconds === 'number' &&
      Number.isSafeInteger(refusal.holdForMilliseconds) &&
      refusal.holdForMilliseconds > 0
        ? ` for the next ${Math.max(1, Math.round(refusal.holdForMilliseconds / 1000))}s`
        : ' for a while'
    console.warn(
      `[sync-transport] Socket save refused: ${code}; sent over HTTP.` +
        ' The gateway refused it before executing it, so nothing was lost.' +
        ` The socket stays up for every other lane; saves go over HTTP${hold}, then the socket is tried again.`,
    )
  }

  /** The counterpart: a successful negotiation, with what the socket actually carries. */
  private announceNegotiation(operations: readonly SyncNegotiatedOperation[]): void {
    const signature = `NEGOTIATED:${[...operations].join(',')}`
    if (this.lastLoggedTransition === signature) {
      return
    }
    this.lastLoggedTransition = signature

    const carriesSync = operations.includes('SYNC_ITEMS')
    const list = operations.join(', ') || 'nothing'
    // eslint-disable-next-line no-console
    console.info(
      carriesSync
        ? `[sync-transport] Account sync is on the websocket. Negotiated: ${list}.`
        : `[sync-transport] Websocket negotiated ${list}, but NOT SYNC_ITEMS — saves stay on HTTP.` +
            ' The server bound no durable sync command port (see SYNCING_SERVER_GRPC_UNBOUND).',
    )
  }

  private async onWorkerMessage(message: SyncWorkerToMainMessage): Promise<void> {
    if (message.type === 'WORKER_BUILD') {
      // Admitted by shape. It is a value from another bundle, and what it is
      // compared with is a commit: anything else is "it did not say".
      if (this.workerBuildReport !== undefined && WORKER_BUILD_REVISION.test(message.revision)) {
        this.workerBuildReport = { ...this.workerBuildReport, revision: message.revision }
      }
      return
    }
    if (message.type === 'SHUTDOWN_COMPLETE') {
      // The worker-bound callback owns shutdown acknowledgments; a bare message
      // cannot identify which retiring worker completed its cleanup.
      return
    }
    if (message.type === 'DIAL_HOLD_ARMED') {
      this.announceDialHold(message.holdForMilliseconds, message.handshakes)
      return
    }
    if (message.type === 'DIAL_HOLD_ENDED') {
      this.announceDialHoldEnded()
      return
    }
    if (message.type === 'SAVE_LANE') {
      this.applySaveLaneMessage(message)
      return
    }
    if (message.type === 'SAVE_ITEMS_REFUSED') {
      const until = Date.now() + message.holdForMilliseconds
      for (const item of message.items) {
        this.refusedItems.set(item.uuid, { fenceToken: item.fenceToken, until })
        if (message.protectItems) {
          this.socketOnlyItems.add(item.uuid)
        }
        for (const listener of [...this.saveRefusalListeners]) {
          try {
            listener(item.uuid, item.fenceToken)
          } catch (error) {
            console.error('[sync-transport] A save-refusal observer threw.', error)
          }
        }
      }
      if (message.protectItems) {
        this.persistSocketOnlyItems()
      }
      return
    }
    if (message.type === 'STATE') {
      this.setTransportState(message.state, message.reason, message.socketPreserved === true)
      this.announceTransition(message.state, message.reason)
      if (message.reason === 'multi-tab-not-owner') {
        // Another tab owns the socket for this scope and its lease stands for a
        // known span. Asking again before then can only mint and spend another
        // one-use ticket to be told the same thing, once per sync per tab.
        this.ticketFailureCache = { reason: 'multi-tab-not-owner', until: Date.now() + OWNER_LEASE_TTL_MS }
      }
      // A worker-initiated close never posts DEGRADED (its own onClose is skipped),
      // so HTTP_FALLBACK must clear the negotiation too or the negative ticket
      // cache is bypassed on every sync and the reported operations go stale.
      //
      // ...but ONLY when the socket is actually gone. A fallback that deliberately
      // KEEPS a healthy socket (`operation-unavailable`, `frame-too-large`) posts
      // HTTP_FALLBACK and then immediately posts READY again, and `NEGOTIATED` is
      // only ever posted after a fresh handshake — so clearing here left the steady
      // state as `{ state: READY, operations: [] }` on a socket still carrying every
      // operation it negotiated. That is not merely a wrong readout: `negotiated` is
      // what `isFileLaneAvailable()` and the API_RPC gate in `execute()` read, so a
      // single refused operation silently pushed FILES_V1 and every control-plane
      // request onto HTTP for the life of the connection. On a deployment where one
      // operation is permanently unavailable that fired on every round, forever.
      //
      // The worker reports which case it is, because only the worker knows: at the
      // moment this transition is posted its socket reference is still set even when
      // it is about to be closed, so the main thread cannot infer it.
      const socketIsGone = message.socketPreserved !== true
      if (
        socketIsGone &&
        (message.state === 'DEGRADED' || message.state === 'HTTP_ONLY' || message.state === 'HTTP_FALLBACK')
      ) {
        this.negotiated = undefined
      }
      this.publishSaveLane()
      return
    }
    if (message.type === 'NEGOTIATED') {
      this.negotiated = {
        sessionScope: message.sessionScope,
        protocolVersion: message.protocolVersion,
        endpoint: message.endpoint,
        operations: new Set(message.operations),
      }
      this.ticketFailureCache = undefined
      this.fallbackReason = undefined
      this.announceNegotiation(message.operations)
      this.publishSaveLane()
      return
    }
    if (message.type === 'CHECKPOINT_CLEARED' || message.type === 'CHECKPOINT_FAILED') {
      const barrier = this.checkpointBarriers.get(message.requestId)
      if (barrier) {
        clearTimeout(barrier.timeout)
        this.checkpointBarriers.delete(message.requestId)
        if (message.type === 'CHECKPOINT_CLEARED') {
          barrier.resolve()
        } else {
          barrier.reject(transportError('Could not clear the durable sync command checkpoint.'))
        }
      }
      return
    }
    if (message.type === 'SESSION_REVOKED_ACK' || message.type === 'SESSION_REVOKED_FAILED') {
      const barrier = this.revocationBarriers.get(message.requestId)
      if (barrier) {
        clearTimeout(barrier.timeout)
        this.revocationBarriers.delete(message.requestId)
        if (message.type === 'SESSION_REVOKED_ACK') {
          barrier.resolve()
        } else {
          barrier.reject(transportError('Could not quarantine the revoked sync session.'))
        }
      }
      return
    }
    if (message.type === 'NEED_SESSION_REFRESH') {
      await this.supplySessionRefreshTicket(message.refreshId, message.sessionScope)
      return
    }
    if (message.type === 'SESSION_NOT_AUTHORIZED') {
      const sourceWorker = this.worker
      if (!sourceWorker || this.workerSessionScope !== message.sessionScope) {
        return
      }
      const currentScope = await this.currentSessionScope()
      if (this.worker !== sourceWorker || currentScope !== message.sessionScope) {
        return
      }
      /**
       * The gateway closed the socket because the session plane says this session
       * does not authenticate — a sign-out, a deletion, an explicit revocation or a
       * ban, as opposed to merely an old access token (which it reports as
       * SESSION_STALE and which leaves the socket alone). Terminal by construction:
       * the worker only reports it after its own REAUTH was answered that way, and
       * it never infers it from a failed ticket mint or a timeout.
       *
       * `notifySessionRevoked` is the clean-termination path that already exists and
       * is already tested: it quarantines the scope so nothing re-dials or mints
       * another ticket, rejects every pending operation non-retryably, hands the
       * worker its SESSION_REVOKED barrier and ends at HTTP_ONLY. Nothing retries
       * this lane afterwards; the next HTTP request meets the same refusal and the
       * session layer's own 401 handling takes the user to sign in again. The
       * socket deliberately does not sign anyone out by itself.
       */
      await this.revokeSessionScope(message.sessionScope, sourceWorker)
      return
    }
    const pending = 'clientRequestId' in message ? this.pending.get(message.clientRequestId) : undefined
    const collaborationPending =
      'clientRequestId' in message ? this.pendingCollaboration.get(message.clientRequestId) : undefined
    const rpcPending = 'clientRequestId' in message ? this.pendingRpcs.get(message.clientRequestId) : undefined
    const invitePending =
      'clientRequestId' in message ? this.pendingInviteSubscriptions.get(message.clientRequestId) : undefined

    if (message.type === 'NEED_TICKET') {
      const sessionScope =
        pending?.sessionScope ??
        collaborationPending?.sessionScope ??
        rpcPending?.sessionScope ??
        invitePending?.sessionScope ??
        (this.socketReadinessConsumer?.clientRequestId === message.clientRequestId
          ? this.socketReadinessConsumer.sessionScope
          : undefined)
      if (sessionScope) {
        // The worker checks the shared owner lease before emitting NEED_TICKET.
        // Only a request correlated to this transport can override its older
        // sibling-owner cache after ownership has become available.
        if (this.ticketFailureCache?.reason === 'multi-tab-not-owner') {
          this.ticketFailureCache = undefined
        }
        await this.supplyTicket(message.clientRequestId, sessionScope)
      }
      return
    }
    if (
      message.type === 'INVITE_READY' ||
      message.type === 'INVITE_BATCH' ||
      message.type === 'INVITE_RECONCILE' ||
      message.type === 'INVITE_ERROR' ||
      message.type === 'INVITE_DEFERRED'
    ) {
      if (invitePending) {
        this.handleInviteWorkerMessage(message, invitePending)
      }
      return
    }
    if (
      message.type === 'RPC_ACCEPTED' ||
      message.type === 'RPC_RESPONSE' ||
      message.type === 'RPC_CHUNK' ||
      message.type === 'RPC_END' ||
      message.type === 'RPC_ERROR'
    ) {
      if (rpcPending) {
        this.handleRpcWorkerMessage(message, rpcPending)
      }
      return
    }
    if (
      message.type === 'FILE_DOWNLOAD_ACCEPTED' ||
      message.type === 'FILE_DOWNLOAD_CHUNK' ||
      message.type === 'FILE_DOWNLOAD_COMPLETE' ||
      message.type === 'FILE_DOWNLOAD_ERROR'
    ) {
      const fileDownloadPending = this.pendingFileDownloads.get(message.clientRequestId)
      if (fileDownloadPending) {
        this.handleFileDownloadWorkerMessage(message, fileDownloadPending)
      }
      return
    }

    if (
      message.type === 'FILE_UPLOAD_ACCEPTED' ||
      message.type === 'FILE_UPLOAD_CHUNK_ACK' ||
      message.type === 'FILE_UPLOAD_COMPLETE' ||
      message.type === 'FILE_UPLOAD_ERROR'
    ) {
      const fileUploadPending = this.pendingFileUploads.get(message.clientRequestId)
      if (fileUploadPending) {
        this.handleFileUploadWorkerMessage(message, fileUploadPending)
      }
      return
    }
    if (
      message.type === 'COLLABORATION_RESULT' ||
      message.type === 'COLLABORATION_DENIED' ||
      message.type === 'COLLABORATION_FALLBACK'
    ) {
      if (!collaborationPending) {
        return
      }
      this.pendingCollaboration.delete(message.clientRequestId)
      if (message.type === 'COLLABORATION_FALLBACK') {
        // A single lane standing down, with the socket left as it was. On a live
        // socket that is a per-lane event the ledger counts and the transport's
        // own state and reason are untouched by; see `recordLaneStandDown`.
        this.recordLaneStandDown(message.reason)
        collaborationPending.resolve(undefined)
      } else if (message.type === 'COLLABORATION_DENIED') {
        if (message.reason) {
          collaborationPending.reject(
            new AuthenticatedRpcError(
              message.reason === 'epoch-mismatch' ? 'COLLABORATION_EPOCH_CHANGED' : 'COLLABORATION_NOT_AUTHORIZED',
              false,
              false,
            ),
          )
        } else {
          collaborationPending.resolve(null)
        }
      } else {
        collaborationPending.resolve(message.result)
      }
      return
    }
    if (!pending) {
      return
    }

    switch (message.type) {
      case 'COMMAND_PERSISTED':
        pending.persisted = { body: message.body, command: message.command }
        break
      case 'RECOVERY_EMPTY':
        this.pending.delete(message.clientRequestId)
        pending.resolve(undefined)
        break
      case 'RECOVERY_DEFERRED':
        this.pending.delete(message.clientRequestId)
        // One lane standing down while the socket (another tab's) stays up, which is
        // the shape `COLLABORATION_FALLBACK` is recorded with: the state does not move.
        // This tab is not on the socket here, so the cause becomes the transport's
        // current reason. Said once per cause, because it is expected and not a fault.
        this.recordLaneStandDown(message.reason)
        this.announceRecoveryDeferral(message.reason)
        pending.resolve(undefined)
        break
      case 'RECOVERY_REQUIRED':
        this.pending.delete(message.clientRequestId)
        pending.reject(
          transportError(
            message.reason === 'socket-save-refused'
              ? 'The collaboration socket save was refused. Its local changes remain pending until a saving device recovers.'
              : 'Durable sync recovery must complete before a new command can execute.',
          ),
        )
        break
      case 'HTTP_FALLBACK':
        if (message.refusal !== undefined) {
          this.announceSaveRefusal(message.refusal)
        }
        await this.resolveHttpFallback(message.clientRequestId, pending, message.body, message.command)
        break
      case 'RESULT': {
        const response = normalizeCommittedResult(message.result)
        if (!response) {
          // COMMITTED proves the mutation may have taken effect. A malformed
          // response must retain the durable outbox for STATUS reconciliation;
          // replaying it over HTTP here would create a second transport owner.
          pending.reject(
            transportError('Committed websocket sync response was malformed; durable recovery is required.'),
          )
          this.pending.delete(message.clientRequestId)
          return
        }
        const persisted = pending.persisted
        if (!persisted) {
          pending.reject(transportError('Committed websocket sync response has no durable command identity.'))
          this.pending.delete(message.clientRequestId)
          return
        }
        this.pending.delete(message.clientRequestId)
        const result: AccountSyncTransportResult<TransportResponse> = {
          response,
          markCheckpointDurable: this.createDurableCheckpoint(pending.sessionScope, message.commandId),
        }
        pending.resolve(pending.mode === 'recover' ? { ...result, request: persisted.body } : result)
        break
      }
      default:
        break
    }
  }

  private handleRpcWorkerMessage(message: RpcWorkerMessage, pending: PendingRpc): void {
    switch (message.type) {
      case 'RPC_ACCEPTED':
        pending.accepted = true
        return
      case 'RPC_RESPONSE': {
        const response: AuthenticatedRpcResponse = {
          status: message.status,
          headers: message.headers,
          transport: 'websocket',
          ...(!message.stream && Object.hasOwn(message, 'body') ? { body: message.body } : {}),
        }
        if (message.stream) {
          const clientRequestId = message.clientRequestId
          response.stream = new ReadableStream<Uint8Array>(
            {
              start: (controller) => {
                pending.streamController = controller
              },
              pull: () => {
                const creditBytes = pending.creditToReturn
                if (creditBytes > 0) {
                  pending.creditToReturn = 0
                  this.worker?.postMessage({ type: 'RPC_CREDIT', clientRequestId, creditBytes })
                }
              },
              cancel: () => {
                this.worker?.postMessage({ type: 'CANCEL_RPC', clientRequestId })
              },
            },
            { highWaterMark: 1, size: () => 1 },
          )
          pending.responseResolved = true
          pending.resolve(response)
        } else {
          pending.response = response
        }
        return
      }
      case 'RPC_CHUNK':
        if (!pending.streamController) {
          this.rejectRpc(message.clientRequestId, pending, new AuthenticatedRpcError('INVALID_RESPONSE', false, false))
          this.worker?.postMessage({ type: 'CANCEL_RPC', clientRequestId: message.clientRequestId })
          return
        }
        try {
          pending.streamController.enqueue(decodeRpcBase64(message.bytes, message.byteLength))
          pending.creditToReturn = Math.min(MAX_RPC_CREDIT_BYTES, pending.creditToReturn + message.byteLength)
        } catch {
          this.rejectRpc(message.clientRequestId, pending, new AuthenticatedRpcError('INVALID_RESPONSE', false, false))
          this.worker?.postMessage({ type: 'CANCEL_RPC', clientRequestId: message.clientRequestId })
        }
        return
      case 'RPC_END':
        if (pending.streamController) {
          pending.streamController.close()
        } else if (pending.response) {
          pending.responseResolved = true
          pending.resolve(pending.response)
        } else {
          this.rejectRpc(message.clientRequestId, pending, new AuthenticatedRpcError('INVALID_RESPONSE', false, false))
          return
        }
        this.cleanupRpc(message.clientRequestId, pending)
        return
      case 'RPC_ERROR': {
        const error = new AuthenticatedRpcError(message.code, message.retryable, message.safeToFallback)
        this.rejectRpc(message.clientRequestId, pending, error)
        return
      }
    }
  }

  private handleInviteWorkerMessage(
    message: Extract<
      SyncWorkerToMainMessage,
      { type: 'INVITE_READY' | 'INVITE_BATCH' | 'INVITE_RECONCILE' | 'INVITE_ERROR' | 'INVITE_DEFERRED' }
    >,
    pending: PendingInviteSubscription,
  ): void {
    if (message.type === 'INVITE_READY') {
      // The lane is live, so a later deferral is a new fact and must be said again.
      this.lastLoggedInviteDeferral = undefined
      pending.options.onReady?.(message.cursor)
      return
    }
    if (message.type === 'INVITE_DEFERRED') {
      // Deliberately NOT routed to `onError`: nothing failed, the subscription is
      // still registered in the worker, and the owner tells its lifecycle to park.
      // Routed through onError this read as a failure in the console and drove one
      // reconnect per coordinator backoff tick for the life of the tab.
      this.announceInviteDeferral(message.reason)
      pending.options.onDeferred?.({
        reason: message.reason,
        resumeAfterMilliseconds: message.resumeAfterMilliseconds,
      })
      return
    }
    if (message.type === 'INVITE_ERROR') {
      pending.options.onError?.(new AuthenticatedRpcError(message.code, message.retryable, false))
      return
    }

    const clientRequestId = message.clientRequestId
    const operation = pending.tail.then(async () => {
      if (this.pendingInviteSubscriptions.get(clientRequestId) !== pending) {
        return
      }
      if (message.type === 'INVITE_BATCH') {
        const ackCursor = await pending.options.applyBatch(message.batch)
        if (ackCursor !== message.batch.nextCursor) {
          throw new AuthenticatedRpcError('INVITE_ACK_MISMATCH', false, false)
        }
        if (this.pendingInviteSubscriptions.get(clientRequestId) === pending) {
          this.worker?.postMessage({ type: 'ACK_INVITE_EVENTS', clientRequestId, cursor: ackCursor })
        }
        return
      }

      await pending.options.reconcile({ reason: message.reason, cursor: message.cursor })
      if (this.pendingInviteSubscriptions.get(clientRequestId) === pending) {
        this.worker?.postMessage({
          type: 'SUBSCRIBE_INVITE_EVENTS',
          clientRequestId,
          sessionScope: pending.sessionScope,
          cursor: message.cursor,
          limit: pending.options.limit ?? 100,
        })
      }
    })
    pending.tail = operation.catch((error) => {
      const failure =
        error instanceof AuthenticatedRpcError ? error : new AuthenticatedRpcError('INVITE_APPLY_FAILED', true, false)
      if (this.pendingInviteSubscriptions.get(clientRequestId) === pending) {
        // The worker/server are both intentionally holding the batch unacked.
        // End this subscription so the lifecycle owner can retry from its last
        // durable checkpoint; leaving it registered would deadlock forever.
        this.pendingInviteSubscriptions.delete(clientRequestId)
        this.worker?.postMessage({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId })
      }
      pending.options.onError?.(failure)
    })
  }

  /**
   * Applies download messages strictly in arrival order, and returns socket
   * credit only after `onBytes` has resolved. Chaining onto a per-download tail
   * is what makes the credit window mean "consumed" rather than "received" —
   * without it a slow consumer would keep granting credit and the encrypted
   * stream would pile up in memory ahead of the decryptor.
   */
  private handleFileDownloadWorkerMessage(message: FileDownloadWorkerMessage, pending: PendingFileDownload): void {
    if (message.type === 'FILE_DOWNLOAD_ACCEPTED') {
      return
    }
    if (message.type === 'FILE_DOWNLOAD_ERROR') {
      this.settleFileDownload(message.clientRequestId, pending, {
        outcome: 'failed',
        code: message.code,
        retryable: message.retryable,
        // The worker reports what crossed to this thread; this thread knows what
        // actually reached the decryptor, and that is the stricter of the two.
        safeToFallback: message.safeToFallback && pending.bytesDelivered === 0,
      })
      return
    }

    const clientRequestId = message.clientRequestId
    const operation = pending.tail.then(async () => {
      if (this.pendingFileDownloads.get(clientRequestId) !== pending || pending.settled) {
        return
      }
      if (message.type === 'FILE_DOWNLOAD_CHUNK') {
        await pending.request.onBytes(message.bytes)
        pending.bytesDelivered += message.bytes.byteLength
        if (this.pendingFileDownloads.get(clientRequestId) === pending && !pending.settled) {
          this.worker?.postMessage({
            type: 'FILE_DOWNLOAD_CREDIT',
            clientRequestId,
            creditBytes: message.bytes.byteLength,
          })
        }
        return
      }
      if (pending.bytesDelivered !== message.declaredSize) {
        this.settleFileDownload(clientRequestId, pending, {
          outcome: 'failed',
          code: 'FILE_TRUNCATED',
          retryable: false,
          safeToFallback: pending.bytesDelivered === 0,
        })
        return
      }
      this.settleFileDownload(clientRequestId, pending, { outcome: 'completed', sha256: message.sha256 })
    })
    pending.tail = operation.catch(() => {
      this.worker?.postMessage({ type: 'CANCEL_FILE_DOWNLOAD', clientRequestId })
      this.settleFileDownload(clientRequestId, pending, {
        outcome: 'failed',
        code: 'FILE_CONSUMER_FAILED',
        retryable: false,
        // The consumer already saw bytes, so it owns whatever partial state it
        // built. Restarting the same file over HTTP would feed them a second time.
        safeToFallback: false,
      })
    })
  }

  private settleFileDownload(
    clientRequestId: string,
    pending: PendingFileDownload,
    outcome: SocketFileDownloadOutcome,
  ): void {
    if (pending.settled) {
      return
    }
    pending.settled = true
    if (this.pendingFileDownloads.get(clientRequestId) === pending) {
      this.pendingFileDownloads.delete(clientRequestId)
    }
    pending.abortCleanup?.()
    pending.settle(outcome)
  }

  private failAllFileDownloads(code: string, sessionScope?: string): void {
    for (const [clientRequestId, pending] of [...this.pendingFileDownloads]) {
      if (sessionScope !== undefined && pending.sessionScope !== sessionScope) {
        continue
      }
      this.settleFileDownload(clientRequestId, pending, {
        outcome: 'failed',
        code,
        retryable: false,
        safeToFallback: pending.bytesDelivered === 0,
      })
    }
  }

  private rejectRpc(clientRequestId: string, pending: PendingRpc, error: AuthenticatedRpcError): void {
    if (pending.streamController) {
      try {
        pending.streamController.error(error)
      } catch {
        // The stream may already be cancelled or closed.
      }
    }
    if (!pending.responseResolved) {
      pending.reject(error)
    }
    this.cleanupRpc(clientRequestId, pending)
  }

  private cleanupRpc(clientRequestId: string, pending: PendingRpc): void {
    if (this.pendingRpcs.get(clientRequestId) === pending) {
      this.pendingRpcs.delete(clientRequestId)
    }
    pending.abortCleanup?.()
  }

  /**
   * Standard Red Notes: mint a ticket for an in-place credential refresh.
   *
   * Deliberately NOT `supplyTicket`. That one exists to get a socket up and is
   * entangled with everything that decision needs: the negative ticket cache, the
   * capability probe, per-request pending maps, the endpoint it resolves and the
   * `CONNECT` it posts. None of that applies here — a live socket has already
   * proved the capability exists and is already dialled. This is the one thing
   * that cannot be done anywhere else: `POST /v1/sockets/sync/ticket` over
   * authenticated HTTP, where the browser attaches the CURRENT session itself and
   * the gateway captures the credential server-side off a real request. The
   * refusal path touches nothing: a transient failure must not poison the ticket
   * cache for the socket that is up and working.
   */
  private async supplySessionRefreshTicket(refreshId: string, sessionScope: string): Promise<void> {
    const worker = this.worker
    if (!worker) {
      return
    }
    const unavailable = () => worker.postMessage({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId })
    if (this.deinitialized || this.workerSessionScope !== sessionScope || this.revokedSessionScopes.has(sessionScope)) {
      unavailable()
      return
    }
    let ticket: SyncTicketResponse | SyncControlPlaneRefusal | undefined
    try {
      ticket = await this.options.controlPlane.createTicket(this.options.deviceId)
    } catch {
      unavailable()
      return
    }
    /**
     * Re-read the live scope AFTER the mint. The ticket is bound server-side to
     * the user, session and device it was minted for, and the gateway closes the
     * socket outright when a presented ticket is not bound to the identity the
     * socket was admitted with. A sign-out or a different sign-in landing inside
     * the round trip is exactly that mismatch, so it must never be sent.
     */
    const currentScope = await this.currentSessionScope().catch(() => undefined)
    if (
      this.worker !== worker ||
      this.workerSessionScope !== sessionScope ||
      currentScope !== sessionScope ||
      this.revokedSessionScopes.has(sessionScope) ||
      !ticket ||
      isSyncControlPlaneRefusal(ticket) ||
      ticket.capability !== 'ws-sync' ||
      ticket.version !== 1 ||
      typeof ticket.ticket !== 'string' ||
      ticket.ticket.length < 32
    ) {
      unavailable()
      return
    }
    worker.postMessage({
      type: 'SESSION_REFRESH_TICKET',
      refreshId,
      ticket: ticket.ticket,
      deviceId: this.options.deviceId,
    })
  }

  private async supplyTicket(clientRequestId: string, sessionScope: string): Promise<void> {
    const worker = this.worker
    if (
      !worker ||
      (!this.pending.has(clientRequestId) &&
        !this.pendingCollaboration.has(clientRequestId) &&
        !this.pendingRpcs.has(clientRequestId) &&
        !this.pendingInviteSubscriptions.has(clientRequestId) &&
        this.socketReadinessConsumer?.clientRequestId !== clientRequestId) ||
      this.workerSessionScope !== sessionScope
    ) {
      return
    }
    const ownsWorker = () => this.worker === worker && !this.deinitialized && this.workerSessionScope === sessionScope
    const unavailable = (reason: SyncFallbackReason) => {
      if (ownsWorker()) {
        worker.postMessage({ type: 'TICKET_UNAVAILABLE', clientRequestId, reason })
      }
    }
    const laneUnavailable = this.sessionLaneUnavailableReason()
    if (laneUnavailable) {
      unavailable(laneUnavailable)
      return
    }
    // sessionLaneUnavailableReason() just parsed this successfully.
    const configuredEndpoint = new URL(this.options.getConfiguredWebSocketUrl() as string)

    // The cache exists so background syncs do not repeat ticket + capability
    // requests every 30 s. The invite stream and RPC callers are not background
    // syncs: they arrive once per launch and a stale verdict stands them down
    // for the life of the tab, so they always get a fresh answer.
    const bootstrap = this.pendingInviteSubscriptions.has(clientRequestId) || this.pendingRpcs.has(clientRequestId)
    const cached = this.ticketFailureCache
    // `multi-tab-not-owner` is the exception: it is not a verdict about the
    // deployment but about this tab, it expires with the other tab's lease, and
    // a bootstrap that ignores it burns a ticket on every one of its retries.
    if (
      cached &&
      !this.negotiated &&
      Date.now() < cached.until &&
      (!bootstrap || cached.reason === 'multi-tab-not-owner')
    ) {
      unavailable(cached.reason)
      return
    }
    const cacheAndReport = (reason: SyncFallbackReason) => {
      if (ownsWorker()) {
        this.ticketFailureCache = { reason, until: Date.now() + CAPABILITY_REPROBE_MS }
        unavailable(reason)
      }
    }

    let ticket: SyncTicketResponse | SyncControlPlaneRefusal | undefined
    let receivedAt: number
    try {
      ticket = await this.options.controlPlane.createTicket(this.options.deviceId)
      if (!ownsWorker()) {
        return
      }
      receivedAt = Date.now()
    } catch {
      if (!ownsWorker()) {
        return
      }
      // No answer at all (network error, timeout, aborted fetch). The capability
      // may well exist; only a probe that the server answers can say otherwise.
      cacheAndReport((await this.probeCapabilityOnce()) === 'absent' ? 'capability-unavailable' : 'ticket-unavailable')
      return
    }
    try {
      const currentScope = await this.currentSessionScope()
      if (!ownsWorker()) {
        return
      }
      if (currentScope !== sessionScope || this.revokedSessionScopes.has(sessionScope)) {
        const pending = this.pending.get(clientRequestId)
        const collaborationPending = this.pendingCollaboration.get(clientRequestId)
        const rpcPending = this.pendingRpcs.get(clientRequestId)
        const invitePending = this.pendingInviteSubscriptions.get(clientRequestId)
        this.pending.delete(clientRequestId)
        this.pendingCollaboration.delete(clientRequestId)
        this.pendingInviteSubscriptions.delete(clientRequestId)
        pending?.reject(transportError('Authenticated session changed while acquiring a sync ticket.'))
        collaborationPending?.reject(transportError('Authenticated session changed while authorizing collaboration.'))
        if (rpcPending) {
          this.rejectRpc(clientRequestId, rpcPending, new AuthenticatedRpcError('SESSION_CHANGED', false, true))
        }
        invitePending?.options.onError?.(new AuthenticatedRpcError('SESSION_CHANGED', false, true))
        if (ownsWorker()) {
          await this.quarantineWorkerScope(sessionScope)
        }
        return
      }
      if (isSyncControlPlaneRefusal(ticket)) {
        // The server answered. Only an answer that says "not here" is permanent;
        // a 5xx, 429 or a transient SYNC_DISABLED is the same request succeeding
        // a little later.
        cacheAndReport(refusalProvesCapabilityAbsent(ticket) ? 'capability-unavailable' : 'ticket-unavailable')
        return
      }
      if (
        !ticket ||
        ticket.capability !== 'ws-sync' ||
        ticket.version !== 1 ||
        typeof ticket.ticket !== 'string' ||
        ticket.ticket.length < 32 ||
        !Number.isSafeInteger(ticket.expiresAt)
      ) {
        // Unreadable or malformed answer. A positive capability probe does not
        // make a failing ticket issuer healthy, so this is still cached — but
        // as the retryable reason unless the probe proves the capability absent.
        cacheAndReport(
          (await this.probeCapabilityOnce()) === 'absent' ? 'capability-unavailable' : 'ticket-unavailable',
        )
        return
      }
      this.ticketFailureCache = undefined
      const relativeEndpoint = ticket.endpoint
      const endpoint = new URL(relativeEndpoint, configuredEndpoint).toString()
      // Express expiry on the local clock from the server's own lifetime span.
      // Comparing the server's absolute `expiresAt` to Date.now() kept every
      // ticket out of the lane on a browser clock ≥ 29 s ahead of the server.
      const lifetimeMs = Number.isSafeInteger(ticket.issuedAt) ? ticket.expiresAt - Number(ticket.issuedAt) : undefined
      worker.postMessage({
        type: 'CONNECT',
        clientRequestId,
        sessionScope,
        authorization: {
          endpoint,
          ticket: ticket.ticket,
          expiresAt: ticket.expiresAt,
          deviceId: this.options.deviceId,
          ...(lifetimeMs !== undefined && lifetimeMs > 0 ? { localExpiresAt: receivedAt + lifetimeMs } : {}),
        },
      })
    } catch {
      cacheAndReport('ticket-unavailable')
    }
  }

  /**
   * `'absent'` only when the server answered that the capability is not offered:
   * a list without `ws-sync`, or a status that says the endpoint does not exist.
   * A thrown probe, an unreadable answer or any other refusal is `'unknown'`.
   */
  private probeCapabilityOnce(): Promise<CapabilityProbeVerdict> {
    if (!this.options.controlPlane.getCapabilities) {
      return Promise.resolve('unknown')
    }
    if (this.capabilityProbe) {
      return this.capabilityProbe
    }
    const probe = this.options.controlPlane
      .getCapabilities()
      .then((response): CapabilityProbeVerdict => {
        if (isSyncControlPlaneRefusal(response)) {
          return refusalProvesCapabilityAbsent(response) ? 'absent' : 'unknown'
        }
        if (!response || !Array.isArray(response.capabilities)) {
          return 'unknown'
        }
        return response.capabilities.some((candidate) => candidate.id === 'ws-sync' && candidate.version === 1)
          ? 'present'
          : 'absent'
      })
      .catch((): CapabilityProbeVerdict => 'unknown')
      .finally(() => {
        if (this.capabilityProbe === probe) {
          this.capabilityProbe = undefined
        }
      })
    this.capabilityProbe = probe
    return probe
  }

  private async resolveHttpFallback(
    clientRequestId: string,
    pending: PendingExecution,
    body: AccountSyncTransportRequest,
    command?: AccountSyncCommandMetadata,
  ): Promise<void> {
    /**
     * Claim the terminal transition before crossing the async HTTP boundary.
     * Worker close/error/timeout paths can converge on the same durable command;
     * without this compare-and-delete, two queued HTTP_FALLBACK messages (or a
     * worker error racing one) could issue the same POST concurrently. The server
     * command journal makes that mutation idempotent, but the client must still
     * guarantee one fallback request and one acknowledgement per execution.
     */
    if (this.pending.get(clientRequestId) !== pending) {
      return
    }
    this.pending.delete(clientRequestId)
    try {
      if (this.containsSocketOnlyItems(body)) {
        throw transportError('Live collaboration saves require the socket save lane.')
      }
      const response = await pending.httpFallback(body, command)
      const result: AccountSyncTransportResult<TransportResponse> = {
        response,
        ...(command
          ? {
              markCheckpointDurable: this.createDurableCheckpoint(pending.sessionScope, command.id),
            }
          : {}),
      }
      pending.resolve(pending.mode === 'recover' ? { ...result, request: body } : result)
    } catch (error) {
      pending.reject(error)
    }
  }

  private markCheckpointDurable(sessionScope: string, commandId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const requestId = this.nextRequestId('checkpoint')
      void this.workerForSession(sessionScope)
        .then((worker) => {
          if (!worker) {
            reject(transportError('Sync worker is unavailable for durable checkpoint acknowledgement.'))
            return
          }
          const timeout = setTimeout(() => {
            this.checkpointBarriers.delete(requestId)
            reject(transportError('Timed out clearing the durable sync command checkpoint.'))
          }, BARRIER_TIMEOUT_MS)
          this.checkpointBarriers.set(requestId, { resolve, reject, timeout })
          worker.postMessage({ type: 'CHECKPOINT_DURABLE', requestId, sessionScope, commandId })
        })
        .catch(reject)
    })
  }

  private createDurableCheckpoint(sessionScope: string, commandId: string): () => Promise<void> {
    let checkpoint: Promise<void> | undefined
    return () => {
      checkpoint ??= this.markCheckpointDurable(sessionScope, commandId)
      return checkpoint
    }
  }

  private async onWorkerError(): Promise<void> {
    this.terminateWorker()
    this.setTransportState('DEGRADED', 'worker-error')
    this.negotiated = undefined
    for (const pending of this.pendingCollaboration.values()) {
      pending.resolve(undefined)
    }
    this.pendingCollaboration.clear()
    for (const [requestId, pending] of this.pendingRpcs) {
      this.rejectRpc(requestId, pending, new AuthenticatedRpcError('WORKER_ERROR', true, false))
    }
    for (const pending of this.pendingInviteSubscriptions.values()) {
      pending.options.onError?.(new AuthenticatedRpcError('WORKER_ERROR', true, false))
    }
    this.pendingInviteSubscriptions.clear()
    this.failAllFileDownloads('WORKER_ERROR')
    this.failAllFileUploads('WORKER_ERROR')
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [, pending] of entries) {
      const persisted = pending.persisted
      if (!persisted) {
        pending.reject(transportError('Sync worker failed before durable command identity was confirmed.'))
        continue
      }
      // COMMAND_PERSISTED can race the worker's socket write. Once the worker
      // itself is gone the main thread cannot prove the command stayed local,
      // so retain IndexedDB state and require STATUS recovery instead of HTTP.
      pending.reject(transportError('Sync worker failed after command persistence; durable recovery is required.'))
    }
    this.rejectAllBarriers(transportError('Sync worker failed during an acknowledgement barrier.'))
  }

  private rejectAllBarriers(error: Error): void {
    for (const barriers of [this.checkpointBarriers, this.revocationBarriers]) {
      for (const barrier of barriers.values()) {
        clearTimeout(barrier.timeout)
        barrier.reject(error)
      }
      barriers.clear()
    }
  }

  private nextRequestId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.requestCounter}`
  }
}

const RPC_REQUEST_HEADER_NAMES = new Set([
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
  'x-shared-vault-owner-context',
  'x-snjs-version',
  'x-application-version',
])

function normalizeAuthenticatedRpcRequest(request: AuthenticatedRpcStreamRequest): WorkerAuthenticatedRpcRequest {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    throw new AuthenticatedRpcError('INVALID_METHOD', false, true)
  }
  if (
    typeof request.path !== 'string' ||
    !request.path.startsWith('/v1/') ||
    request.path.startsWith('//') ||
    request.path.includes('\\') ||
    request.path.includes('#') ||
    utf8Bytes(request.path).byteLength > 2_048
  ) {
    throw new AuthenticatedRpcError('INVALID_PATH', false, true)
  }
  try {
    const parsed = new URL(request.path, 'http://rpc.invalid')
    if (parsed.origin !== 'http://rpc.invalid' || `${parsed.pathname}${parsed.search}` !== request.path) {
      throw transportError('non-canonical path')
    }
  } catch {
    throw new AuthenticatedRpcError('INVALID_PATH', false, true)
  }
  if (request.method === 'GET' && Object.hasOwn(request, 'body')) {
    throw new AuthenticatedRpcError('GET_BODY_FORBIDDEN', false, true)
  }
  if (
    request.method !== 'GET' &&
    (typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.idempotencyKey))
  ) {
    throw new AuthenticatedRpcError('IDEMPOTENCY_KEY_REQUIRED', false, true)
  }
  const deadlineMs = request.deadlineMs ?? DEFAULT_RPC_DEADLINE_MS
  const initialCreditBytes = request.initialCreditBytes ?? DEFAULT_RPC_CREDIT_BYTES
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < MIN_RPC_DEADLINE_MS ||
    deadlineMs > MAX_RPC_DEADLINE_MS ||
    !Number.isSafeInteger(initialCreditBytes) ||
    initialCreditBytes <= 0 ||
    initialCreditBytes > MAX_RPC_CREDIT_BYTES
  ) {
    throw new AuthenticatedRpcError('INVALID_LIMITS', false, true)
  }
  const headers: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(request.headers ?? {})) {
    const name = rawName.toLowerCase()
    if (
      rawName !== name ||
      !RPC_REQUEST_HEADER_NAMES.has(name) ||
      typeof value !== 'string' ||
      value.length > 1_024 ||
      /[\r\n]/u.test(value)
    ) {
      throw new AuthenticatedRpcError('INVALID_HEADERS', false, true)
    }
    headers[name] = value
  }

  let body: unknown
  if (Object.hasOwn(request, 'body') && request.body !== undefined) {
    try {
      body = JSON.parse(JSON.stringify(request.body))
    } catch {
      throw new AuthenticatedRpcError('INVALID_BODY', false, true)
    }
  }
  return {
    method: request.method,
    path: request.path,
    deadlineMs,
    initialCreditBytes,
    stream: request.stream ?? false,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
  }
}

function decodeRpcBase64(value: string, expectedLength: number): Uint8Array {
  if (value.length % 4 !== 0 || (value.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/u.test(value))) {
    throw transportError('Invalid RPC base64 chunk.')
  }
  const decoded = globalThis.atob(value)
  if (decoded.length !== expectedLength) {
    throw transportError('RPC chunk length mismatch.')
  }
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

/**
 * Mirrors the gateway's `isFileTransferSize`. Applied to the ENCRYPTED total as
 * well as the decrypted one, because the 5 GiB cap bounds the encrypted stream.
 */
function isTransferSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_FILE_TRANSFER_BYTES
}

/** Mirrors the gateway's `isFileMimeType`: non-empty, bounded, no control characters. */
function isSendableMimeType(value: string): boolean {
  return (
    value.length > 0 &&
    utf8Bytes(value).byteLength <= MAX_FILE_MIME_TYPE_BYTES &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}
