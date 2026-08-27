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
  SyncServerFrame,
  SyncNegotiatedOperation,
  SyncTicket,
  SyncTransportState,
  SyncWorkerToMainMessage,
  WorkerAuthenticatedRpcRequest,
  utf8Bytes,
} from './syncTransportProtocol'
import { IndexedDbSyncOutbox, SyncOutboxRecord, SyncOutboxStore } from './SyncTransportOutbox'

const AUTH_ACK_TIMEOUT_MS = 5_000
const COMMAND_ACK_TIMEOUT_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 30_000
const OWNER_LEASE_TTL_MS = 15_000
const OWNER_RENEW_INTERVAL_MS = 5_000
const MAX_RECONNECT_ATTEMPTS = 2
const OPAQUE_SESSION_SCOPE_PATTERN = /^sync-session-v1:[a-f0-9]{64}$/u

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

const NEGOTIABLE_OPERATIONS: ReadonlySet<SyncNegotiatedOperation> = new Set([
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  'FILES_V1',
])

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
  onclose: ((event: { code?: number }) => void) | null
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
  private negotiatedOperations = new Set<SyncNegotiatedOperation>()
  private readonly rpcRequests = new Map<string, ActiveRpcRequest>()
  private readonly fileDownloads = new Map<string, ActiveFileDownload>()
  private readonly fileUploads = new Map<string, ActiveFileUpload>()
  private inviteSubscription?: ActiveInviteSubscription
  private shuttingDown = false
  private ackTimeout?: ReturnType<typeof setTimeout>
  private reconnectTimeout?: ReturnType<typeof setTimeout>
  private heartbeatInterval?: ReturnType<typeof setInterval>
  private ownerRenewInterval?: ReturnType<typeof setInterval>

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
        await this.recover(message.clientRequestId, message.sessionScope)
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
      case 'CHECKPOINT_DURABLE':
        await this.checkpointDurable(message.requestId, message.sessionScope, message.commandId)
        break
      case 'SESSION_REVOKED':
        await this.revokeSession(message.requestId, message.sessionScope)
        break
      case 'SHUTDOWN':
        await this.shutdown()
        break
    }
  }

  private async recover(clientRequestId: string, sessionScope: string): Promise<void> {
    if (this.shuttingDown || !validSessionScope(sessionScope)) {
      this.dependencies.postMessage({ type: 'RECOVERY_EMPTY', clientRequestId })
      return
    }
    if (this.active) {
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
      return
    }
    try {
      const record = await this.outbox.oldest(sessionScope)
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
      if (this.socket?.readyState === 1 && this.state === 'READY' && this.transportScope) {
        await this.prepareActiveRequest()
        return
      }
      this.transition('HALF_OPEN')
      this.dependencies.postMessage({ type: 'NEED_TICKET', clientRequestId, reconnect: false })
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
    if (this.active?.mode === 'invite-bootstrap') {
      // A command may supersede the connection-only invite bootstrap. The
      // subscription is sent after AUTH on the command's ticket instead.
      this.active = undefined
    }
    if (this.active) {
      // Never create a parallel HTTP owner while an earlier command may be in
      // flight. The durable owner must be reconciled first.
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
      return
    }
    let normalizedBody: AccountSyncTransportRequest
    try {
      normalizedBody = normalizeSyncRequestForWire(body)
      const stale = await this.outbox.oldest(sessionScope)
      if (stale) {
        this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
        return
      }
    } catch {
      this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
      return
    }
    this.active = { clientRequestId, sessionScope, mode: 'execute', body: normalizedBody, context }
    this.sessionScope = sessionScope
    this.accepted = false
    this.commandSent = false
    this.resultDelivered = false

    if (this.socket?.readyState === 1 && this.state === 'READY' && this.transportScope) {
      await this.prepareActiveRequest()
      return
    }

    this.transition('HALF_OPEN')
    this.dependencies.postMessage({ type: 'NEED_TICKET', clientRequestId, reconnect: false })
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
    this.transition('HALF_OPEN')
    this.dependencies.postMessage({ type: 'NEED_TICKET', clientRequestId, reconnect: false })
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
      this.transition('HALF_OPEN')
      this.dependencies.postMessage({ type: 'NEED_TICKET', clientRequestId, reconnect: false })
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
      this.transition('HALF_OPEN')
      this.dependencies.postMessage({ type: 'NEED_TICKET', clientRequestId, reconnect: false })
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
      this.failFileDownload(download, code, RETRYABLE_FILE_ERROR_CODES.has(code))
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
      this.failFileUpload(upload, code, RETRYABLE_FILE_ERROR_CODES.has(code))
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
    if (authorization.expiresAt <= this.now() + 1_000) {
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
    socket.onclose = (event) => void this.onClose(socket, event.code ?? 0)
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
        !operations.includes('SYNC_ITEMS') ||
        operations.some((operation) => !NEGOTIABLE_OPERATIONS.has(operation as SyncNegotiatedOperation))
      ) {
        await this.fallback('auth-failed')
        return
      }
      this.clearAckDeadline()
      this.sequence = Number(nextSequence)
      this.negotiatedOperations = new Set(operations as SyncNegotiatedOperation[])
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
        if (frame.payload.code === 'NOT_AUTHORIZED') {
          const clientRequestId = this.active.clientRequestId
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
        this.deliverResult(frame.payload.result)
        break
      case 'STATUS':
        this.clearAckDeadline()
        if (frame.payload.status === 'COMMITTED') {
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
      this.dependencies.postMessage({
        type: 'INVITE_ERROR',
        clientRequestId: subscription.clientRequestId,
        code: 'OPERATION_UNAVAILABLE',
        retryable: true,
      })
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

  private failInviteSubscription(subscription: ActiveInviteSubscription, code: string, retryable: boolean): void {
    this.dependencies.postMessage({
      type: 'INVITE_ERROR',
      clientRequestId: subscription.clientRequestId,
      code,
      retryable,
    })
    if (!retryable && this.inviteSubscription === subscription) {
      this.inviteSubscription = undefined
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
      case 'ERROR':
        this.failRpc(
          rpc,
          typeof frame.payload.code === 'string' ? frame.payload.code : 'RPC_ERROR',
          frame.payload.retryable === true,
          false,
        )
        break
      default:
        break
    }
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
    } catch {
      await this.fallback('outbox-unavailable', this.outboxRecord)
    }
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
        throw new Error('Sync socket backpressure deadline exceeded before write.')
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
      }
      this.dependencies.postMessage({ type: 'CHECKPOINT_CLEARED', requestId, sessionScope, commandId })
    } catch {
      this.dependencies.postMessage({ type: 'CHECKPOINT_FAILED', requestId, sessionScope, commandId })
    }
  }

  private async onClose(socket: SyncSocketLike, code: number): Promise<void> {
    if (this.socket !== socket) {
      return
    }
    this.socket = undefined
    this.clearAckDeadline()
    this.clearHeartbeat()
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
    if (this.active?.mode === 'collaboration' && this.active.socketGeneration !== undefined) {
      await this.fallbackCollaboration('reconnect-gap', false)
      return
    }
    this.transition('DEGRADED', code >= 4000 ? 'server-kill' : undefined)
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
      return
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      await this.fallback(this.outboxRecord ? 'reconnect-gap' : 'proxy-failed', this.outboxRecord)
      return
    }
    const delay = this.random() * Math.min(5_000, 250 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimeout = this.scheduleTimeout(() => {
      this.reconnectTimeout = undefined
      if (this.active) {
        this.transition('HALF_OPEN')
        this.dependencies.postMessage({
          type: 'NEED_TICKET',
          clientRequestId: this.active.clientRequestId,
          reconnect: true,
        })
      }
    }, delay)
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
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private clearHeartbeat(): void {
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
        .then((owned) => {
          if (!owned) {
            void this.fallback('multi-tab-not-owner', this.outboxRecord)
          }
        })
        .catch(() => this.fallback('outbox-unavailable', this.outboxRecord))
    }, OWNER_RENEW_INTERVAL_MS)
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
      this.transition('HTTP_FALLBACK', reason)
      if (!preserveHealthySocket) {
        await this.closeSocketAndReleaseOwner()
      }
      return
    }
    if (active.mode === 'invite-bootstrap') {
      const subscription = this.inviteSubscription
      if (subscription?.clientRequestId === active.clientRequestId) {
        // A structurally absent capability is not a transient fault. Reporting it as retryable
        // makes the durable invite coordinator reconnect against it for the life of the tab.
        const retryable = !isPermanentSyncFallbackReason(reason)
        this.dependencies.postMessage({
          type: 'INVITE_ERROR',
          clientRequestId: active.clientRequestId,
          code: reason.toUpperCase().replaceAll('-', '_'),
          retryable,
        })
        subscription.sent = false
        if (!retryable) {
          this.inviteSubscription = undefined
        }
      }
      this.active = undefined
      this.transition('DEGRADED', reason)
      if (!preserveHealthySocket) {
        await this.closeSocketAndReleaseOwner()
      }
      return
    }
    if (active.mode === 'collaboration') {
      await this.fallbackCollaboration(reason, preserveHealthySocket)
      return
    }
    const recordBelongsToActive = record?.sessionScope === active.sessionScope
    if (recordBelongsToActive && this.commandSent && !confirmedNoSideEffect) {
      await this.requireDurableRecovery(active.clientRequestId, reason, preserveHealthySocket)
      return
    }
    this.transition('HTTP_FALLBACK', reason)
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
      await this.closeSocketAndReleaseOwner()
    } else {
      this.transition('READY')
    }
  }

  private async requireDurableRecovery(
    clientRequestId: string,
    reason: SyncFallbackReason,
    preserveHealthySocket: boolean,
  ): Promise<void> {
    this.clearAckDeadline()
    this.dependencies.postMessage({ type: 'RECOVERY_REQUIRED', clientRequestId })
    this.active = undefined
    this.resultDelivered = false
    this.accepted = false
    // Retain outboxRecord and commandSent. The next recoverPending call must
    // query STATUS for this exact command id/digest before any replay.
    this.transition('DEGRADED', reason)
    if (!preserveHealthySocket) {
      await this.closeSocketAndReleaseOwner()
    }
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
      await this.closeSocketAndReleaseOwner()
    } else {
      this.transition('READY')
    }
  }

  private postFallback(clientRequestId: string, body: AccountSyncTransportRequest, reason: SyncFallbackReason): void {
    this.dependencies.postMessage({ type: 'HTTP_FALLBACK', clientRequestId, reason, body })
  }

  private transition(state: SyncTransportState, reason?: SyncFallbackReason): void {
    this.state = state
    this.dependencies.postMessage({ type: 'STATE', state, ...(reason ? { reason } : {}) })
  }

  private async closeSocketAndReleaseOwner(): Promise<void> {
    this.clearAckDeadline()
    this.clearHeartbeat()
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
    if (this.inviteSubscription) {
      this.inviteSubscription.sent = false
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
    this.outboxRecord = undefined
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
    this.outboxRecord = undefined
    this.outbox.close()
    this.transition('HTTP_ONLY')
  }
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
    typeof payload.epochDiscoveryChallenge !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(payload.epochDiscoveryChallenge) ||
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
