import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import type { Provider } from '@lexical/yjs'
import {
  COLLABORATION_MAX_TRANSFER_BYTES,
  COLLABORATION_PRESENCE_HEARTBEAT_INTERVAL_MS,
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborationRequestId,
  type CollabChannel,
  type CollabFrame,
} from './CollabChannel'
import { EphemeralRoomPresence, type CollaborationPresenceActivity } from './EphemeralRoomPresence'
import { isCollaborationCipherError, type RoomCipher } from './RoomCrypto'
import type { ActiveEditorCollaborationLease } from './useCollaborationRoomAccess'

type Listener = (...args: never[]) => void
const MAX_JOIN_RETRIES = 5
export const YJS_CHUNK_PLAINTEXT_BYTES = 128 * 1024
export const MAX_YJS_TRANSFER_BYTES = COLLABORATION_MAX_TRANSFER_BYTES
export const MAX_YJS_TRANSFER_CHUNKS = MAX_YJS_TRANSFER_BYTES / YJS_CHUNK_PLAINTEXT_BYTES
export const YJS_TRANSFER_TIMEOUT_MS = 10_000
const MAX_INBOUND_TRANSFERS = 4
const MAX_INBOUND_RESERVED_BYTES = 8 * 1024 * 1024
const MAX_INBOUND_RESERVED_CHUNKS = 64
export const MAX_INBOUND_CHUNK_DECRYPTS = MAX_INBOUND_RESERVED_CHUNKS
const MAX_RECENT_TRANSFER_IDS = 64
const RETRY_COOLDOWN_MS = 1_000
const CONTROL_RESPONSE_TIMEOUT_MS = 10_000
/** Exceeds the 75s distributed editor-lease TTL before bootstrap re-election. */
const MAX_CORRELATED_STATE_ATTEMPTS = 8
const MAX_STATE_ESTABLISHMENT_ATTEMPTS = 3
const MAX_LOCAL_OUTBOUND_RETRIES = 3
const LOCAL_OUTBOUND_RETRY_BASE_MS = 250
const MAX_PENDING_RESPONSE_CLAIMS = 64
const RESPONSE_CLAIM_TTL_MS = 30_000
export const MAX_INBOUND_CRYPTO_OPERATIONS = 64
export const MAX_INBOUND_CRYPTO_BYTES = 8 * 1024 * 1024
export const MAX_ACTIVE_INBOUND_CRYPTO = 8
const MAX_ACTIVE_AWARENESS_CRYPTO = 2
const MAX_YJS_CLIENT_ID = 0xffff_ffff
const STATE_READY_AWARENESS_FIELD = 'srnStateReady'
export const MAX_OUTBOUND_YJS_PENDING_OPERATIONS = 512
export const MAX_OUTBOUND_YJS_PENDING_INPUT_BYTES = MAX_YJS_TRANSFER_BYTES
export const MAX_AWARENESS_PLAINTEXT_BYTES = 64 * 1024
const MAX_AWARENESS_ENCODED_BYTES = Math.ceil((MAX_AWARENESS_PLAINTEXT_BYTES + 64) / 3) * 4 + 512
export const MAX_AWARENESS_CLIENTS_PER_UPDATE = 32
export const MAX_REMOTE_AWARENESS_CLIENTS = 64
/** Bound exact state checks before cumulative CRDT history can grow unchecked. */
export const YJS_STATE_BUDGET_CHECK_BYTES = 256 * 1024
export const YJS_STATE_BUDGET_CHECK_UPDATES = 8_192
const MAX_UNVERIFIED_YJS_STATE_BYTES = MAX_YJS_TRANSFER_BYTES * 2
const MAX_AWARENESS_NAME_LENGTH = 128
const MAX_AWARENESS_COLOR_LENGTH = 64
const MAX_AWARENESS_USER_UUID_LENGTH = 128
const MAX_AWARENESS_JSON_DEPTH = 5
const MAX_AWARENESS_JSON_NODES = 128

type YjsChunkFrame = Extract<CollabFrame, { t: 'yjs-chunk' }>
type YjsChunkMetadata = Omit<YjsChunkFrame, 't' | 'payload'>

const encodeChunkAdditionalData = (metadata: YjsChunkMetadata): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify([
      'standard-red-notes:yjs-chunk:v2',
      COLLABORATION_PROTOCOL_VERSION,
      metadata.room,
      metadata.transferId,
      metadata.index,
      metadata.count,
      metadata.totalBytes,
      metadata.stateRequestId ?? null,
    ]),
  )

const encodeFrameAdditionalData = (
  room: string,
  frameType: 'yjs' | 'awareness',
  transferId?: string,
  stateRequestId?: string,
): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify([
      'standard-red-notes:collaboration-frame:v2',
      COLLABORATION_PROTOCOL_VERSION,
      room,
      frameType,
      transferId ?? null,
      stateRequestId ?? null,
    ]),
  )

type InboundTransfer = {
  count: number
  totalBytes: number
  expiresAt: number
  reservedIndexes: Set<number>
  chunks: Map<number, Uint8Array>
  receivedBytes: number
  stateRequestId?: string
}

type InboundCryptoJob = {
  kind: 'yjs' | 'awareness'
  ciphertextBytes: number
  run(): Promise<void>
}

type RetryControlFrame = Extract<CollabFrame, { t: 'yjs-retry' }>

export type EncryptedYjsProviderOptions = {
  /** The hook has already activated this lease before Lexical was allowed to mount. */
  activeLease: ActiveEditorCollaborationLease
  shouldBootstrap: boolean
  /** Synchronous final canonical-revision guard before any relay subscription or send. */
  validateAttachment(): boolean
  /** Full freshness-barrier + reserve/activate flow used on socket reconnect. */
  reactivate(): Promise<ActiveEditorCollaborationLease | { reason: string; requiresRemount?: true }>
  /** Epoch used to construct the immutable cipher; defaults to the initial lease epoch. */
  expectedRoomEpoch?: string
  /** Fatal transport limits fall back to the ordinary encrypted editor path. */
  onFatal(reason: string): void
  /** Release/remount after bounded peer-state recovery so bootstrap can be re-elected. */
  onBootstrapRetry?(): void
  /** Distinct from retained offline readiness: true only while transport owns canonical state. */
  setCanonicalOwnership?(active: boolean): void
  /** Transient, deduped activity sourced from encrypted awareness labels. */
  onPresenceActivity?(activity: CollaborationPresenceActivity): void
}

/**
 * A yjs provider that syncs a Y.Doc over the gateway relay through the supplied
 * RoomCipher. The product entry point supplies a non-extractable key derived
 * from the matching client-only account/vault key material and fails closed
 * before mounting this provider when that source is unavailable. Implements the @lexical/yjs
 * `Provider` interface so it can drive @lexical/react's CollaborationPlugin.
 *
 * Sync model (no central server, peer-to-peer over the relay):
 *  - local doc change  -> encrypt incremental update -> broadcast `yjs` frame;
 *  - inbound `yjs`     -> decrypt -> Y.applyUpdate(origin=this) (no echo back);
 *  - a peer joining    -> gateway sends us `room-sync` -> we reply with the FULL
 *                         encoded state so the newcomer converges (yjs updates
 *                         are commutative + idempotent, so full-state is safe).
 * Awareness (cursors/presence) rides the same channel as `awareness` frames.
 */
export class EncryptedYjsProvider implements Provider {
  public readonly awareness: Provider['awareness']
  private readonly yAwareness: Awareness
  private readonly listeners: Record<string, Set<Listener>> = {}
  private readonly canonicalReadyListeners = new Set<(ready: boolean) => void>()
  private unsubscribe: (() => void) | null = null
  private unsubscribeStatus: (() => void) | null = null
  private connected = false
  private joined = false
  private joinRequestId: string
  private initialCapabilityConsumed = false
  private joining = false
  private joinRetryAttempts = 0
  private joinRetryTimeout: ReturnType<typeof setTimeout> | undefined
  // In-flight encrypt/send/decrypt work. Entries REMOVE THEMSELVES on settle so
  // this never grows unbounded over a long editing session (awareness fires on
  // every cursor move); flush() still works for tests by awaiting the live set.
  private readonly pending = new Set<Promise<void>>()
  private readonly inboundTransfers = new Map<string, InboundTransfer>()
  private inboundReservedBytes = 0
  private inboundReservedChunks = 0
  // Independent from transfer reservations: rejecting/releasing a transfer
  // cannot erase the cost of an AES-GCM operation that has already started.
  private inboundChunkDecrypts = 0
  private inboundCleanupTimeout: ReturnType<typeof setTimeout> | undefined
  private readonly recentTransferIds = new Map<string, number>()
  private lastRetryRequestAt = Number.NEGATIVE_INFINITY
  private lastStateResponseAt = Number.NEGATIVE_INFINITY
  private stateResponseInFlight = false
  private stateResponsePending = false
  private pendingStateResponseRequestId: string | undefined
  private stateResponseTimeout: ReturnType<typeof setTimeout> | undefined
  private lastSyncFailure: string | undefined
  private currentLease: ActiveEditorCollaborationLease | undefined
  private transportGeneration = 0
  private reactivatingGeneration: number | undefined
  private awaitingStateRequestId: string | undefined
  private recoveryStateRequestId: string | undefined
  private recoveryStateRequestTimeout: ReturnType<typeof setTimeout> | undefined
  private recoveryStateAttempts = 0
  private readonly recoveryReasons = new Set<'inbound' | 'outbound'>()
  private stateRequestTimeout: ReturnType<typeof setTimeout> | undefined
  private correlatedStateAttempts = 0
  private stateServingReady = false
  private awaitingBootstrapSeed = false
  private stateEstablishingGeneration: number | undefined
  private pendingRetryBeforeReady: RetryControlFrame | undefined
  private readonly pendingResponseClaims = new Map<string, { leaseRequestId: string; expiresAt: number }>()
  private retainedLocalAwarenessState: Record<string, unknown> | undefined
  private readonly acceptanceWaiters = new Map<
    string,
    { resolve(): void; reject(): void; timeout: ReturnType<typeof setTimeout> }
  >()
  private readonly inboundCryptoQueue: InboundCryptoJob[] = []
  private inboundCryptoActive = 0
  private inboundAwarenessActive = 0
  private inboundCryptoBytes = 0
  private outboundCryptoTail: Promise<void> = Promise.resolve()
  private outboundCryptoActive = 0
  private outboundCryptoQueued = 0
  private localOutboundActive = false
  private pendingLocalYjsUpdate: Uint8Array | undefined
  private pendingLocalYjsOperations = 0
  private pendingLocalYjsInputBytes = 0
  private pendingLocalAwarenessUpdate: Uint8Array | undefined
  private localOutboundRetryTimeout: ReturnType<typeof setTimeout> | undefined
  private localOutboundRetryBlocked = false
  private localOutboundFailureAttempts = 0
  private lastEncodedDocumentBytes = 0
  private unverifiedDocumentUpdateBytes = 0
  private unverifiedDocumentUpdates = 0
  private initialDocumentWithinBudget = true
  private terminallyDestroyed = false
  private readonly expectedRoomEpoch?: string
  private readonly ephemeralPresence?: EphemeralRoomPresence
  private presenceHeartbeatInterval: ReturnType<typeof setInterval> | undefined

  constructor(
    public readonly doc: Y.Doc,
    private readonly room: string,
    private readonly channel: CollabChannel,
    private readonly cipher: RoomCipher,
    private readonly initialCapability?: string,
    leaseRequestId?: string,
    private readonly options?: EncryptedYjsProviderOptions,
  ) {
    this.joinRequestId = leaseRequestId ?? createCollaborationRequestId()
    this.currentLease = options?.activeLease
    this.expectedRoomEpoch = options?.expectedRoomEpoch ?? options?.activeLease.roomEpoch
    this.yAwareness = new Awareness(doc)
    // y-protocols Awareness is structurally compatible with lexical's
    // ProviderAwareness at runtime; the field type differs only in the UserState
    // shape it carries.
    this.awareness = this.yAwareness as unknown as Provider['awareness']
    if (this.options && this.expectedRoomEpoch) {
      this.ephemeralPresence = new EphemeralRoomPresence({
        room: this.room,
        roomEpoch: this.expectedRoomEpoch,
        localClientId: this.doc.clientID,
        resolveEncryptedAwarenessIdentity: (clientId) => this.resolveEncryptedAwarenessIdentity(clientId),
        onActivity: (activity) => this.options?.onPresenceActivity?.(activity),
        onTerminalClient: (clientId, reason) => this.removeRemoteAwarenessClient(clientId, `room-presence-${reason}`),
      })
    }
    // Lexical may reuse a retained Y.Doc across a transport reconnect. Seed the
    // accounting baseline from that exact state; treating it as an empty doc
    // would let the next small remote update bypass the transfer budget.
    try {
      this.lastEncodedDocumentBytes = Y.encodeStateAsUpdate(doc).byteLength
      this.initialDocumentWithinBudget = this.lastEncodedDocumentBytes <= MAX_YJS_TRANSFER_BYTES
    } catch {
      this.initialDocumentWithinBudget = false
    }
  }

  // --- @lexical/yjs Provider event emitter -------------------------------

  on(type: string, cb: Listener): void {
    ;(this.listeners[type] ??= new Set()).add(cb)
  }

  off(type: string, cb: Listener): void {
    this.listeners[type]?.delete(cb)
  }

  private emit(type: string, ...args: never[]): void {
    this.listeners[type]?.forEach((cb) => cb(...args))
  }

  /** Product-only readiness: true means this Y.Doc has proved canonical state. */
  onCanonicalReadyChange(listener: (ready: boolean) => void): () => void {
    this.canonicalReadyListeners.add(listener)
    return () => this.canonicalReadyListeners.delete(listener)
  }

  isCanonicalReady(): boolean {
    return this.stateServingReady
  }

  private setStateServingReady(ready: boolean): void {
    if (this.stateServingReady === ready) {
      return
    }
    this.stateServingReady = ready
    if (!ready) {
      this.setCanonicalOwnership(false)
    }
    for (const listener of this.canonicalReadyListeners) {
      listener(ready)
    }
  }

  private setCanonicalOwnership(active: boolean): void {
    try {
      this.options?.setCanonicalOwnership?.(active)
    } catch {
      // Ownership notification is a local lifecycle guard; never let a stale
      // React closure make provider teardown or recovery throw.
    }
  }

  /**
   * Re-check the exact note/key authorization at every production crypto
   * boundary. Security observers release the lease synchronously, while this
   * guard closes the smaller event-to-render race for queued socket/doc work.
   */
  private validateLiveAttachment(): boolean {
    if (!this.options) {
      return true
    }
    let valid = false
    try {
      valid = this.options.validateAttachment()
    } catch {
      valid = false
    }
    if (valid) {
      return true
    }
    const wasJoined = this.joined
    this.joined = false
    this.stopPresenceHeartbeat()
    this.ephemeralPresence?.clear()
    this.setStateServingReady(false)
    this.awaitingBootstrapSeed = false
    this.stateEstablishingGeneration = undefined
    this.pendingRetryBeforeReady = undefined
    this.setLocalStateReadiness(false)
    this.clearStateRequest()
    this.clearStateResponseQueue()
    this.clearPendingResponseClaims()
    this.rejectAcceptanceWaiters()
    this.clearInboundTransfers()
    this.clearInboundCryptoQueue()
    this.clearLocalOutboundQueue()
    this.clearRemoteAwareness('invalid-live-attachment')
    this.currentLease?.release()
    this.currentLease = undefined
    if (wasJoined) {
      this.emit('sync', false as never)
    }
    return false
  }

  // --- lifecycle ---------------------------------------------------------

  connect(): void {
    if (this.connected || this.terminallyDestroyed) {
      return
    }
    if (!this.initialDocumentWithinBudget) {
      this.fatal('Live collaboration stopped because this note exceeds the safe realtime transfer limit.')
      return
    }
    if (this.options) {
      let valid = false
      try {
        valid = this.options.validateAttachment()
      } catch {
        valid = false
      }
      if (!valid) {
        this.currentLease?.release()
        this.currentLease = undefined
        return
      }
    }
    this.transportGeneration += 1
    this.connected = true
    this.setCanonicalOwnership(false)

    this.doc.on('update', this.onLocalDocUpdate)
    this.yAwareness.on('update', this.onLocalAwarenessUpdate)
    this.unsubscribe = this.channel.subscribe(this.onFrame)
    this.unsubscribeStatus = this.channel.subscribeStatus?.(this.onTransportStatus) ?? null
    this.restoreLocalAwarenessState()
    this.setLocalStateReadiness(this.stateServingReady && this.hasDocumentState())

    if (this.currentLease) {
      // The hook has already received `room-joined` and completed its post-ack
      // revision barrier. Attaching must not replay this consume-once activation.
      this.track(this.attachActiveLease(this.currentLease))
    } else if (this.options) {
      // React StrictMode may run effect cleanup/setup against the same provider.
      // The consumed initial lease was released by disconnect, so production
      // must perform the full reserve/activate flow instead of attempting the
      // legacy unreserved join path.
      this.track(this.reactivateAfterReconnect(this.transportGeneration))
    } else {
      // Compatibility path for direct provider consumers. Production mounts
      // always provide an already-active v2 lease through `options`.
      void this.joinWithCapability()
    }
  }

  private async joinWithCapability(): Promise<void> {
    if (this.joining || !this.connected || !this.channel.isConnected()) {
      return
    }
    this.joining = true
    try {
      let capability: string | undefined
      if (!this.initialCapabilityConsumed) {
        capability = this.initialCapability
        this.initialCapabilityConsumed = true
      }
      if (!capability) {
        try {
          capability = await this.channel.authorize(this.room)
        } catch {
          capability = undefined
        }
      }
      // A concurrent disconnect() may have run while we awaited; don't join if so.
      if (!this.connected || !this.channel.isConnected() || !capability) {
        // Denied / unavailable: do not attempt to join. The gateway would reject a
        // capability-less join anyway; skipping avoids a pointless room-denied round trip.
        if (this.connected && this.channel.isConnected()) {
          this.scheduleJoinRetry()
        }
        return
      }
      try {
        this.channel.send({
          t: 'room-join',
          room: this.room,
          cap: capability,
          requestId: this.joinRequestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        })
      } catch {
        // A reconnect race may close the transport between capability minting
        // and send. Stay fail-closed; durable encrypted sync remains available.
        this.scheduleJoinRetry()
      }
    } finally {
      this.joining = false
    }
  }

  private async attachActiveLease(lease: ActiveEditorCollaborationLease): Promise<void> {
    if (!this.connected || !this.channel.isConnected()) {
      lease.release()
      return
    }
    if (
      lease.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
      lease.maxTransferBytes !== MAX_YJS_TRANSFER_BYTES ||
      lease.roomEpoch !== this.expectedRoomEpoch
    ) {
      lease.release()
      if (this.currentLease === lease) {
        this.currentLease = undefined
      }
      this.fatal('Live collaboration stopped because the gateway protocol is incompatible.')
      return
    }

    const previousLease = this.currentLease
    this.currentLease = lease
    if (previousLease && previousLease !== lease) {
      previousLease.release()
      this.clearPendingResponseClaims()
    }
    this.joinRequestId = lease.requestId
    this.joined = true
    this.startPresenceHeartbeat()
    this.joinRetryAttempts = 0
    this.clearJoinRetry()
    this.clearStateRequest()
    this.correlatedStateAttempts = 0
    this.recoveryStateAttempts = 0
    this.emit('sync', false as never)

    try {
      this.setLocalStateReadiness(this.stateServingReady && this.hasDocumentState())
      try {
        await this.broadcastLocalAwareness()
      } catch {
        // Presence is transient and best-effort. It must never gate canonical
        // document establishment or leave an otherwise valid editor read-only.
        console.error('[collab] encrypted-awareness-initial-frame-failed')
      }
      if (!this.connected || !this.joined || this.currentLease !== lease) {
        return
      }

      // A retained document already established in this mounted provider can
      // immediately merge after reconnect. A fresh document must not advertise
      // an empty pre-seed snapshot as canonical state.
      if (this.stateServingReady && this.hasDocumentState()) {
        await this.broadcastFullState(undefined, true)
        if (!this.connected || !this.joined || this.currentLease !== lease) {
          return
        }
        this.lastSyncFailure = undefined
        this.setCanonicalOwnership(true)
        this.emit('sync', true as never)
        if (!lease.shouldBootstrap) {
          this.requestCorrelatedFullState()
        }
        return
      }

      if (lease.shouldBootstrap) {
        // A reconnect may elect this retained provider after it originally
        // mounted as a non-bootstrapper. Lexical captured the original false
        // shouldBootstrap prop, so only a hook-driven remount can seed safely.
        if (this.options && !this.options.shouldBootstrap) {
          this.requestBootstrapFailover()
          return
        }
        if (this.hasDocumentState()) {
          // The original bootstrap may have seeded the retained Y.Doc just
          // before the socket/ACK disappeared. Lexical will not bootstrap a
          // nonempty root again, so explicitly re-prove that retained state.
          this.awaitingBootstrapSeed = true
          this.track(this.establishCurrentDocumentState(this.transportGeneration))
          return
        }
        this.awaitingBootstrapSeed = true
        this.lastSyncFailure = undefined
        // Lexical's sync handler now applies the exact canonical initial state.
        // The resulting first local Yjs update is sent with acceptance below;
        // only then may this provider serve room-sync/retry requests.
        this.emit('sync', true as never)
      } else {
        this.awaitingBootstrapSeed = false
        this.requestCorrelatedFullState()
      }
    } catch {
      if (this.connected && this.joined) {
        this.reportSyncFailure('encrypted-yjs-initial-state-not-accepted')
        if (this.stateServingReady && this.hasDocumentState()) {
          // A retained canonical document (including offline edits) must not be
          // abandoned after one transient reconnect send/acceptance failure.
          // Reuse the bounded establishment loop, which either proves the full
          // snapshot or remounts through bootstrap failover.
          this.track(this.establishCurrentDocumentState(this.transportGeneration))
        } else {
          this.requestBootstrapFailover()
        }
      }
    }
  }

  private async reactivateAfterReconnect(generation = this.transportGeneration): Promise<void> {
    if (
      this.reactivatingGeneration === generation ||
      generation !== this.transportGeneration ||
      !this.options ||
      !this.connected ||
      !this.channel.isConnected()
    ) {
      return
    }
    this.reactivatingGeneration = generation
    try {
      const lease = await this.options.reactivate()
      if ('reason' in lease) {
        if (lease.requiresRemount) {
          this.options.onBootstrapRetry?.()
        } else if (this.connected && this.channel.isConnected()) {
          this.scheduleJoinRetry()
        }
        return
      }
      if (generation !== this.transportGeneration || !this.connected || !this.channel.isConnected()) {
        lease.release()
        return
      }
      if (!this.options.validateAttachment()) {
        lease.release()
        return
      }
      await this.attachActiveLease(lease)
    } catch {
      if (this.connected && this.channel.isConnected()) {
        this.scheduleJoinRetry()
      }
    } finally {
      if (this.reactivatingGeneration === generation) {
        this.reactivatingGeneration = undefined
      }
    }
  }

  private startPresenceHeartbeat(): void {
    this.stopPresenceHeartbeat()
    this.sendPresenceHeartbeat()
    if (!this.connected || !this.joined || !this.currentLease || !this.expectedRoomEpoch) {
      return
    }
    this.presenceHeartbeatInterval = setInterval(
      () => this.sendPresenceHeartbeat(),
      COLLABORATION_PRESENCE_HEARTBEAT_INTERVAL_MS,
    )
  }

  private stopPresenceHeartbeat(): void {
    if (this.presenceHeartbeatInterval !== undefined) {
      clearInterval(this.presenceHeartbeatInterval)
      this.presenceHeartbeatInterval = undefined
    }
  }

  private sendPresenceHeartbeat(): void {
    const lease = this.currentLease
    if (
      !lease ||
      !this.expectedRoomEpoch ||
      !this.connected ||
      !this.joined ||
      !this.channel.isConnected() ||
      !this.validateLiveAttachment()
    ) {
      return
    }
    try {
      this.channel.send({
        t: 'room-presence-heartbeat',
        room: this.room,
        requestId: lease.requestId,
        expectedRoomEpoch: this.expectedRoomEpoch,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        clientId: this.doc.clientID,
      })
    } catch {
      // Ephemeral presence is best-effort and never gates document durability.
    }
  }

  disconnect(): void {
    if (!this.connected) {
      return
    }
    this.transportGeneration += 1
    this.reactivatingGeneration = undefined
    this.connected = false
    this.joined = false
    this.stopPresenceHeartbeat()
    this.ephemeralPresence?.clear()
    this.setCanonicalOwnership(false)
    this.awaitingBootstrapSeed = false
    this.stateEstablishingGeneration = undefined
    this.pendingRetryBeforeReady = undefined
    this.retainLocalAwarenessState()
    this.setLocalStateReadiness(false)
    this.clearStateRequest()
    this.clearStateResponseQueue()
    this.clearPendingResponseClaims()
    this.rejectAcceptanceWaiters()
    this.clearJoinRetry()
    this.clearInboundTransfers()
    this.clearInboundCryptoQueue()
    this.clearLocalOutboundQueue()
    this.clearRemoteAwareness('provider-disconnect')
    removeAwarenessStates(this.yAwareness, [this.doc.clientID], 'disconnect')
    this.doc.off('update', this.onLocalDocUpdate)
    this.yAwareness.off('update', this.onLocalAwarenessUpdate)
    try {
      this.unsubscribe?.()
    } catch {
      // Local listener cleanup must not make editor teardown throw.
    }
    this.unsubscribe = null
    try {
      this.unsubscribeStatus?.()
    } catch {
      // Transport-observer cleanup must not make editor teardown throw.
    }
    this.unsubscribeStatus = null
    this.currentLease?.release()
    this.currentLease = undefined
  }

  /** Irreversible terminal cleanup; ordinary disconnect remains reconnectable. */
  destroy(): void {
    if (this.terminallyDestroyed) {
      return
    }
    this.disconnect()
    this.terminallyDestroyed = true
    this.currentLease?.release()
    this.currentLease = undefined
    this.clearStateRequest()
    this.clearStateResponseQueue()
    this.clearPendingResponseClaims()
    this.rejectAcceptanceWaiters()
    this.clearJoinRetry()
    this.clearInboundTransfers()
    this.clearInboundCryptoQueue()
    this.clearLocalOutboundQueue()
    this.stopPresenceHeartbeat()
    this.ephemeralPresence?.clear()
    this.yAwareness.destroy()
    this.retainedLocalAwarenessState = undefined
    this.setStateServingReady(false)
    this.canonicalReadyListeners.clear()
    for (const listeners of Object.values(this.listeners)) {
      listeners.clear()
    }
  }

  /** Count of in-flight encrypt/send/decrypt operations (for tests/leak guards). */
  getPendingCount(): number {
    return this.pending.size
  }

  /** Bounded receiver accounting exposed for regression/leak tests. */
  getInboundTransferStats(): { transfers: number; reservedBytes: number; reservedChunks: number } {
    return {
      transfers: this.inboundTransfers.size,
      reservedBytes: this.inboundReservedBytes,
      reservedChunks: this.inboundReservedChunks,
    }
  }

  /** In-flight inbound chunk decryptions, independently hard-capped. */
  getInboundChunkDecryptCount(): number {
    return this.inboundChunkDecrypts
  }

  getInboundCryptoStats(): { active: number; queued: number; ciphertextBytes: number } {
    return {
      active: this.inboundCryptoActive,
      queued: this.inboundCryptoQueue.length,
      ciphertextBytes: this.inboundCryptoBytes,
    }
  }

  getOutboundCryptoStats(): {
    active: number
    queued: number
    pendingYjsOperations: number
    pendingYjsInputBytes: number
    pendingAwareness: number
  } {
    return {
      active: this.outboundCryptoActive,
      queued: this.outboundCryptoQueued,
      pendingYjsOperations: this.pendingLocalYjsOperations,
      pendingYjsInputBytes: this.pendingLocalYjsInputBytes,
      pendingAwareness: this.pendingLocalAwarenessUpdate ? 1 : 0,
    }
  }

  /** A non-secret machine-readable failure reason for status UI/tests. */
  getLastSyncFailure(): string | undefined {
    return this.lastSyncFailure
  }

  isRoomJoined(): boolean {
    return this.joined
  }

  /** Resolves once all in-flight encrypt/send work settles (used by tests). */
  async flush(): Promise<void> {
    while (this.pending.size) {
      await Promise.all([...this.pending])
    }
  }

  // --- outbound ----------------------------------------------------------

  private readonly onLocalDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Remote updates are applied with this provider as their origin; do not echo.
    if (origin === this) {
      return
    }
    // Account even while the socket is temporarily down. An established,
    // retained Y.Doc remains editable offline, but its CRDT history must still
    // stay inside the same bounded full-state envelope used on reconnect.
    if (!this.accountDocumentUpdate(update.byteLength) || !this.connected || !this.joined) {
      return
    }
    if (!this.validateLiveAttachment()) {
      return
    }
    if (this.awaitingBootstrapSeed) {
      // establishCurrentDocumentState sets this generation synchronously before
      // its first await. Do not allocate/track one resolved Promise per keystroke
      // while acceptance is deferred.
      if (this.stateEstablishingGeneration !== this.transportGeneration) {
        this.track(this.establishCurrentDocumentState(this.transportGeneration))
      }
      return
    }
    // A fresh non-bootstrapper is read-only/loading until it has applied a
    // correlated established state. Never let an empty local binding update
    // race ahead and masquerade as canonical content.
    if (!this.stateServingReady) {
      return
    }
    this.enqueueLocalYjsUpdate(update)
  }

  private readonly onTransportStatus = (connected: boolean): void => {
    if (!this.connected) {
      return
    }
    this.transportGeneration += 1
    const generation = this.transportGeneration
    if (connected) {
      this.clearJoinRetry()
      this.joinRetryAttempts = 0
      if (this.options) {
        this.track(this.reactivateAfterReconnect(generation))
      } else {
        void this.joinWithCapability()
      }
      return
    }

    this.setCanonicalOwnership(false)

    this.clearJoinRetry()
    this.clearStateRequest()
    this.clearStateResponseQueue()
    this.clearPendingResponseClaims()
    this.awaitingBootstrapSeed = false
    this.stateEstablishingGeneration = undefined
    this.pendingRetryBeforeReady = undefined
    this.setLocalStateReadiness(false)
    this.rejectAcceptanceWaiters()
    this.clearInboundTransfers()
    this.clearInboundCryptoQueue()
    this.clearLocalOutboundQueue()
    this.stopPresenceHeartbeat()
    this.ephemeralPresence?.clear()
    if (this.joined) {
      this.joined = false
      this.emit('sync', false as never)
    }
    this.currentLease?.release()
    this.currentLease = undefined
    // A closed socket cannot carry live awareness. Remove remote cursors now so
    // the UI never presents stale peers as online while the local Y.Doc remains
    // mounted and continues accepting offline edits.
    this.clearRemoteAwareness('transport-disconnect')
  }

  private readonly onLocalAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === 'remote' || !this.connected || !this.joined) {
      return
    }
    if (!this.validateLiveAttachment()) {
      return
    }
    const changed = [...changes.added, ...changes.updated, ...changes.removed]
    const update = encodeAwarenessUpdate(this.yAwareness, changed)
    this.enqueueLocalAwarenessUpdate(update)
  }

  private enqueueLocalYjsUpdate(update: Uint8Array): void {
    if (update.byteLength === 0 || update.byteLength > MAX_YJS_TRANSFER_BYTES) {
      this.fatal('Live collaboration stopped because a local update exceeds the safe realtime transfer limit.')
      return
    }
    const nextOperations = this.pendingLocalYjsOperations + 1
    const nextInputBytes = this.pendingLocalYjsInputBytes + update.byteLength
    if (nextOperations > MAX_OUTBOUND_YJS_PENDING_OPERATIONS || nextInputBytes > MAX_OUTBOUND_YJS_PENDING_INPUT_BYTES) {
      this.fatal('Live collaboration stopped because local realtime changes exceeded the bounded encryption queue.')
      return
    }
    try {
      const copied = new Uint8Array(update)
      const merged = this.pendingLocalYjsUpdate ? Y.mergeUpdates([this.pendingLocalYjsUpdate, copied]) : copied
      if (merged.byteLength > MAX_YJS_TRANSFER_BYTES) {
        this.fatal('Live collaboration stopped because pending local changes exceed the safe realtime transfer limit.')
        return
      }
      this.pendingLocalYjsUpdate = merged
      this.pendingLocalYjsOperations = nextOperations
      this.pendingLocalYjsInputBytes = nextInputBytes
    } catch {
      this.fatal('Live collaboration stopped because pending local changes could not be merged safely.')
      return
    }
    this.drainLocalOutboundQueue()
  }

  private enqueueLocalAwarenessUpdate(update: Uint8Array): void {
    if (update.byteLength === 0 || update.byteLength > MAX_AWARENESS_PLAINTEXT_BYTES) {
      this.fatal('Live collaboration stopped because local presence exceeds the safe realtime limit.')
      return
    }
    // Presence is transient. Keep only the latest snapshot while another local
    // frame is encrypted; cursor-move storms must not create a promise queue.
    this.pendingLocalAwarenessUpdate = new Uint8Array(update)
    this.drainLocalOutboundQueue()
  }

  private drainLocalOutboundQueue(): void {
    if (this.localOutboundActive || this.localOutboundRetryBlocked || !this.connected || !this.joined) {
      return
    }

    let kind: 'yjs' | 'awareness'
    let update: Uint8Array
    let yjsOperations = 0
    let yjsInputBytes = 0
    if (this.pendingLocalYjsUpdate) {
      kind = 'yjs'
      update = this.pendingLocalYjsUpdate
      yjsOperations = this.pendingLocalYjsOperations
      yjsInputBytes = this.pendingLocalYjsInputBytes
      this.pendingLocalYjsUpdate = undefined
      this.pendingLocalYjsOperations = 0
      this.pendingLocalYjsInputBytes = 0
    } else if (this.pendingLocalAwarenessUpdate) {
      kind = 'awareness'
      update = this.pendingLocalAwarenessUpdate
      this.pendingLocalAwarenessUpdate = undefined
    } else {
      return
    }

    this.localOutboundActive = true
    const generation = this.transportGeneration
    const operation =
      kind === 'yjs'
        ? this.sendEncryptedUpdate(update, undefined, false, generation).then(
            () => {
              this.localOutboundFailureAttempts = 0
              this.recoveryReasons.delete('outbound')
              if (this.recoveryReasons.size === 0) {
                this.clearRecoveryStateRequest()
                this.recoveryStateAttempts = 0
              }
              if (this.lastSyncFailure === 'encrypted-yjs-frame-failed') {
                this.lastSyncFailure = undefined
                this.emit('sync', true as never)
              }
            },
            () => {
              this.requeueFailedLocalYjsUpdate(update, yjsOperations, yjsInputBytes, generation)
            },
          )
        : this.sendEncryptedAwareness(update, generation).catch(() => undefined)
    this.track(
      operation.finally(() => {
        this.localOutboundActive = false
        this.drainLocalOutboundQueue()
      }),
    )
  }

  private requeueFailedLocalYjsUpdate(
    failedUpdate: Uint8Array,
    failedOperations: number,
    failedInputBytes: number,
    generation: number,
  ): void {
    if (generation !== this.transportGeneration || !this.connected || !this.joined || !this.validateLiveAttachment()) {
      return
    }
    const nextOperations = failedOperations + this.pendingLocalYjsOperations
    const nextInputBytes = failedInputBytes + this.pendingLocalYjsInputBytes
    if (nextOperations > MAX_OUTBOUND_YJS_PENDING_OPERATIONS || nextInputBytes > MAX_OUTBOUND_YJS_PENDING_INPUT_BYTES) {
      this.fatal('Live collaboration stopped because failed local changes exceeded the bounded retry queue.')
      return
    }
    try {
      this.pendingLocalYjsUpdate = this.pendingLocalYjsUpdate
        ? Y.mergeUpdates([failedUpdate, this.pendingLocalYjsUpdate])
        : new Uint8Array(failedUpdate)
      if (this.pendingLocalYjsUpdate.byteLength > MAX_YJS_TRANSFER_BYTES) {
        this.fatal('Live collaboration stopped because failed local changes exceed the safe realtime transfer limit.')
        return
      }
      this.pendingLocalYjsOperations = nextOperations
      this.pendingLocalYjsInputBytes = nextInputBytes
    } catch {
      this.fatal('Live collaboration stopped because failed local changes could not be requeued safely.')
      return
    }

    this.localOutboundFailureAttempts += 1
    this.reportSyncFailure('encrypted-yjs-frame-failed')
    this.requestFullStateRetry(createCollaborationRequestId(), 'outbound')
    this.localOutboundRetryBlocked = true
    if (this.localOutboundFailureAttempts >= MAX_LOCAL_OUTBOUND_RETRIES) {
      // Keep the bounded merged update until correlated recovery or reconnect;
      // spinning forever on a broken cipher/socket would burn CPU and still lose
      // the edit. markRecoveryStateApplied unblocks this exact queue.
      return
    }
    const delay = LOCAL_OUTBOUND_RETRY_BASE_MS * 2 ** (this.localOutboundFailureAttempts - 1)
    this.localOutboundRetryTimeout = setTimeout(() => {
      this.localOutboundRetryTimeout = undefined
      this.localOutboundRetryBlocked = false
      this.drainLocalOutboundQueue()
    }, delay)
  }

  private clearLocalOutboundQueue(): void {
    if (this.localOutboundRetryTimeout !== undefined) {
      clearTimeout(this.localOutboundRetryTimeout)
      this.localOutboundRetryTimeout = undefined
    }
    this.localOutboundRetryBlocked = false
    this.localOutboundFailureAttempts = 0
    this.pendingLocalYjsUpdate = undefined
    this.pendingLocalYjsOperations = 0
    this.pendingLocalYjsInputBytes = 0
    this.pendingLocalAwarenessUpdate = undefined
  }

  private runOutboundCrypto(operation: () => Promise<void>): Promise<void> {
    this.outboundCryptoQueued += 1
    const result = this.outboundCryptoTail
      .catch(() => undefined)
      .then(async () => {
        this.outboundCryptoQueued -= 1
        this.outboundCryptoActive += 1
        try {
          await operation()
        } finally {
          this.outboundCryptoActive -= 1
        }
      })
    this.outboundCryptoTail = result.catch(() => undefined)
    return result
  }

  private async broadcastFullState(stateRequestId?: string, awaitAcceptance = false): Promise<void> {
    if (!this.connected || !this.joined) {
      return
    }
    const generation = this.transportGeneration
    await this.sendEncryptedUpdate(this.encodeFullStateWithinBudget(), stateRequestId, awaitAcceptance, generation)
  }

  private accountDocumentUpdate(updateBytes: number): boolean {
    if (!Number.isSafeInteger(updateBytes) || updateBytes <= 0 || updateBytes > MAX_YJS_TRANSFER_BYTES) {
      this.fatal('Live collaboration stopped because a document update exceeds the safe realtime state budget.')
      return false
    }
    this.unverifiedDocumentUpdateBytes += updateBytes
    this.unverifiedDocumentUpdates += 1
    if (this.lastEncodedDocumentBytes + this.unverifiedDocumentUpdateBytes > MAX_UNVERIFIED_YJS_STATE_BYTES) {
      // Fail before allocating a potentially unbounded full-state buffer. The
      // cumulative updates are a conservative upper bound between exact checks.
      this.fatal('Live collaboration stopped because this note exceeds the safe realtime state budget.')
      return false
    }
    if (
      this.unverifiedDocumentUpdateBytes >= YJS_STATE_BUDGET_CHECK_BYTES ||
      this.unverifiedDocumentUpdates >= YJS_STATE_BUDGET_CHECK_UPDATES
    ) {
      try {
        this.encodeFullStateWithinBudget()
      } catch {
        return false
      }
    }
    return true
  }

  private encodeFullStateWithinBudget(): Uint8Array {
    if (this.lastEncodedDocumentBytes + this.unverifiedDocumentUpdateBytes > MAX_UNVERIFIED_YJS_STATE_BYTES) {
      this.fatal('Live collaboration stopped because this note exceeds the safe realtime state budget.')
      throw new Error('encrypted-yjs-state-budget-preflight-failed')
    }
    const state = Y.encodeStateAsUpdate(this.doc)
    if (state.byteLength > MAX_YJS_TRANSFER_BYTES) {
      this.fatal('Live collaboration stopped because this note exceeds the safe realtime transfer limit.')
      throw new Error('encrypted-yjs-state-budget-exceeded')
    }
    this.lastEncodedDocumentBytes = state.byteLength
    this.unverifiedDocumentUpdateBytes = 0
    this.unverifiedDocumentUpdates = 0
    return state
  }

  /**
   * Validate an authenticated remote update before it can touch the live Y.Doc.
   * Y.applyUpdate notifies Lexical observers synchronously, so checking after the
   * apply is too late: an over-budget state can already reach UI and persistence.
   *
   * Most updates use the conservative encoded-state accounting bound. At each
   * bounded checkpoint (or whenever that bound approaches the hard limit), a
   * disposable mirror receives the current full state plus the candidate update.
   * Only a mirror whose exact encoded state fits may update the live document.
   */
  private applyRemoteUpdateWithinBudget(update: Uint8Array): boolean {
    if (
      !Number.isSafeInteger(update.byteLength) ||
      update.byteLength <= 0 ||
      update.byteLength > MAX_YJS_TRANSFER_BYTES
    ) {
      this.fatal('Live collaboration stopped because a remote update exceeds the safe realtime state budget.')
      return false
    }

    const nextUnverifiedBytes = this.unverifiedDocumentUpdateBytes + update.byteLength
    const nextUnverifiedUpdates = this.unverifiedDocumentUpdates + 1
    const conservativeBytes = this.lastEncodedDocumentBytes + nextUnverifiedBytes
    if (conservativeBytes > MAX_UNVERIFIED_YJS_STATE_BYTES) {
      this.fatal('Live collaboration stopped because this note exceeds the safe realtime state budget.')
      return false
    }

    const requiresExactPreflight =
      conservativeBytes > MAX_YJS_TRANSFER_BYTES ||
      nextUnverifiedBytes >= YJS_STATE_BUDGET_CHECK_BYTES ||
      nextUnverifiedUpdates >= YJS_STATE_BUDGET_CHECK_UPDATES
    let exactCandidateBytes: number | undefined
    if (requiresExactPreflight) {
      const candidate = new Y.Doc()
      try {
        const currentState = Y.encodeStateAsUpdate(this.doc)
        if (currentState.byteLength > MAX_YJS_TRANSFER_BYTES) {
          this.fatal('Live collaboration stopped because this note exceeds the safe realtime transfer limit.')
          return false
        }
        Y.applyUpdate(candidate, currentState)
        Y.applyUpdate(candidate, update)
        exactCandidateBytes = Y.encodeStateAsUpdate(candidate).byteLength
        if (exactCandidateBytes > MAX_YJS_TRANSFER_BYTES) {
          this.fatal('Live collaboration stopped because a remote update exceeds the safe realtime transfer limit.')
          return false
        }
      } finally {
        candidate.destroy()
      }
    }

    Y.applyUpdate(this.doc, update, this)
    if (exactCandidateBytes !== undefined) {
      this.lastEncodedDocumentBytes = exactCandidateBytes
      this.unverifiedDocumentUpdateBytes = 0
      this.unverifiedDocumentUpdates = 0
    } else {
      this.unverifiedDocumentUpdateBytes = nextUnverifiedBytes
      this.unverifiedDocumentUpdates = nextUnverifiedUpdates
    }
    return true
  }

  /**
   * Encrypt and send one Yjs update. Large updates are split before encryption,
   * keeping every opaque relay frame well below the gateway's existing 512 KiB
   * payload ceiling. Transfer metadata contains only bounded routing/length
   * information; every note byte remains inside an independently authenticated
   * AES-GCM ciphertext. Canonical room/transfer/index/count/size metadata is
   * authenticated as AES-GCM additional data so the relay cannot cut and paste
   * a valid ciphertext into another chunk position or transfer.
   */
  private sendEncryptedUpdate(
    update: Uint8Array,
    stateRequestId?: string,
    awaitAcceptance = false,
    expectedGeneration = this.transportGeneration,
  ): Promise<void> {
    return this.runOutboundCrypto(() =>
      this.encryptAndSendUpdate(update, stateRequestId, awaitAcceptance, expectedGeneration),
    )
  }

  private async encryptAndSendUpdate(
    update: Uint8Array,
    stateRequestId?: string,
    awaitAcceptance = false,
    expectedGeneration = this.transportGeneration,
  ): Promise<void> {
    if (expectedGeneration !== this.transportGeneration || !this.validateLiveAttachment()) {
      return
    }
    if (update.byteLength > MAX_YJS_TRANSFER_BYTES) {
      this.fatal('Live collaboration stopped because this note exceeds the safe realtime transfer limit.')
      throw new Error('encrypted-yjs-transfer-too-large')
    }
    if (update.byteLength <= YJS_CHUNK_PLAINTEXT_BYTES) {
      const transferId = awaitAcceptance ? createCollaborationRequestId() : undefined
      const acceptance = transferId ? this.waitForAcceptance(transferId) : undefined
      let payload: string
      try {
        payload = await this.cipher.encrypt(
          update,
          encodeFrameAdditionalData(this.room, 'yjs', transferId, stateRequestId),
        )
      } catch (error) {
        if (transferId) {
          this.rejectAcceptance(transferId)
        }
        await acceptance?.catch(() => undefined)
        throw error
      }
      if (
        this.connected &&
        this.joined &&
        expectedGeneration === this.transportGeneration &&
        this.validateLiveAttachment()
      ) {
        try {
          this.channel.send({
            t: 'yjs',
            room: this.room,
            payload,
            ...(transferId ? { transferId } : {}),
            ...(stateRequestId ? { stateRequestId } : {}),
          })
        } catch (error) {
          if (transferId) {
            this.rejectAcceptance(transferId)
          }
          await acceptance?.catch(() => undefined)
          throw error
        }
      } else if (transferId) {
        this.rejectAcceptance(transferId)
      }
      if (acceptance) {
        await acceptance
      }
      return
    }

    const transferId = createCollaborationRequestId()
    const acceptance = awaitAcceptance ? this.waitForAcceptance(transferId) : undefined
    const count = Math.ceil(update.byteLength / YJS_CHUNK_PLAINTEXT_BYTES)
    try {
      for (let index = 0; index < count; index += 1) {
        const start = index * YJS_CHUNK_PLAINTEXT_BYTES
        const metadata: YjsChunkMetadata = {
          room: this.room,
          transferId,
          index,
          count,
          totalBytes: update.byteLength,
          ...(stateRequestId ? { stateRequestId } : {}),
        }
        const payload = await this.cipher.encrypt(
          update.subarray(start, start + YJS_CHUNK_PLAINTEXT_BYTES),
          encodeChunkAdditionalData(metadata),
        )
        if (
          !this.connected ||
          !this.joined ||
          expectedGeneration !== this.transportGeneration ||
          !this.validateLiveAttachment()
        ) {
          throw new Error('encrypted-yjs-transfer-interrupted')
        }
        this.channel.send({
          t: 'yjs-chunk',
          room: this.room,
          transferId,
          index,
          count,
          totalBytes: update.byteLength,
          payload,
          ...(stateRequestId ? { stateRequestId } : {}),
        })
      }
    } catch (error) {
      if (acceptance) {
        this.rejectAcceptance(transferId)
        await acceptance.catch(() => undefined)
      }
      throw error
    }
    if (acceptance) {
      await acceptance
    }
  }

  private async broadcastLocalAwareness(): Promise<void> {
    if (!this.connected || !this.joined || !this.validateLiveAttachment()) {
      return
    }
    const update = encodeAwarenessUpdate(this.yAwareness, [this.doc.clientID])
    await this.sendEncryptedAwareness(update, this.transportGeneration)
  }

  private sendEncryptedAwareness(update: Uint8Array, expectedGeneration: number): Promise<void> {
    return this.runOutboundCrypto(async () => {
      if (
        update.byteLength === 0 ||
        update.byteLength > MAX_AWARENESS_PLAINTEXT_BYTES ||
        expectedGeneration !== this.transportGeneration ||
        !this.connected ||
        !this.joined ||
        !this.validateLiveAttachment()
      ) {
        return
      }
      const payload = await this.cipher.encrypt(update, encodeFrameAdditionalData(this.room, 'awareness'))
      if (
        this.connected &&
        this.joined &&
        expectedGeneration === this.transportGeneration &&
        this.validateLiveAttachment()
      ) {
        this.channel.send({ t: 'awareness', room: this.room, payload })
      }
    })
  }

  // --- inbound -----------------------------------------------------------

  private normalizeAwarenessState(state: unknown): Record<string, unknown> | null {
    if (state === null) {
      return null
    }
    if (typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('invalid-awareness-state')
    }
    const value = state as Record<string, unknown>
    const allowed = new Set(['name', 'color', 'focusing', 'anchorPos', 'focusPos', 'awarenessData'])
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new Error('invalid-awareness-field')
    }
    const normalized: Record<string, unknown> = {}
    if (value.name !== undefined) {
      if (typeof value.name !== 'string' || value.name.length > MAX_AWARENESS_NAME_LENGTH) {
        throw new Error('invalid-awareness-name')
      }
      normalized.name = value.name
    }
    if (value.color !== undefined) {
      if (typeof value.color !== 'string' || value.color.length > MAX_AWARENESS_COLOR_LENGTH) {
        throw new Error('invalid-awareness-color')
      }
      normalized.color = value.color
    }
    if (value.focusing !== undefined) {
      if (typeof value.focusing !== 'boolean') {
        throw new Error('invalid-awareness-focus')
      }
      normalized.focusing = value.focusing
    }
    for (const field of ['anchorPos', 'focusPos'] as const) {
      if (value[field] !== undefined) {
        const counter = { nodes: 0 }
        if (!this.isBoundedAwarenessJson(value[field], 0, counter)) {
          throw new Error('invalid-awareness-position')
        }
        normalized[field] = value[field]
      }
    }
    if (value.awarenessData !== undefined) {
      if (
        typeof value.awarenessData !== 'object' ||
        value.awarenessData === null ||
        Array.isArray(value.awarenessData)
      ) {
        throw new Error('invalid-awareness-data')
      }
      const awarenessData = value.awarenessData as Record<string, unknown>
      if (Object.keys(awarenessData).some((key) => key !== 'userUuid' && key !== STATE_READY_AWARENESS_FIELD)) {
        throw new Error('invalid-awareness-data-field')
      }
      const normalizedData: Record<string, unknown> = {}
      if (awarenessData.userUuid !== undefined) {
        if (
          typeof awarenessData.userUuid !== 'string' ||
          awarenessData.userUuid.length === 0 ||
          awarenessData.userUuid.length > MAX_AWARENESS_USER_UUID_LENGTH
        ) {
          throw new Error('invalid-awareness-user')
        }
        normalizedData.userUuid = awarenessData.userUuid
      }
      if (awarenessData[STATE_READY_AWARENESS_FIELD] !== undefined) {
        if (typeof awarenessData[STATE_READY_AWARENESS_FIELD] !== 'boolean') {
          throw new Error('invalid-awareness-readiness')
        }
        normalizedData[STATE_READY_AWARENESS_FIELD] = awarenessData[STATE_READY_AWARENESS_FIELD]
      }
      normalized.awarenessData = normalizedData
    }
    return normalized
  }

  private isBoundedAwarenessJson(value: unknown, depth: number, counter: { nodes: number }): boolean {
    counter.nodes += 1
    if (counter.nodes > MAX_AWARENESS_JSON_NODES || depth > MAX_AWARENESS_JSON_DEPTH) {
      return false
    }
    if (value === null || typeof value === 'boolean') {
      return true
    }
    if (typeof value === 'number') {
      return Number.isFinite(value)
    }
    if (typeof value === 'string') {
      return value.length <= 256
    }
    if (Array.isArray(value)) {
      return value.length <= 32 && value.every((entry) => this.isBoundedAwarenessJson(entry, depth + 1, counter))
    }
    if (typeof value !== 'object') {
      return false
    }
    const entries = Object.entries(value as Record<string, unknown>)
    return (
      entries.length <= 32 &&
      entries.every(
        ([key, entry]) =>
          key.length <= 64 &&
          key !== '__proto__' &&
          key !== 'constructor' &&
          key !== 'prototype' &&
          this.isBoundedAwarenessJson(entry, depth + 1, counter),
      )
    )
  }

  private validateInboundAwareness(update: Uint8Array): { update: Uint8Array; liveClientIds: number[] } | undefined {
    if (update.byteLength === 0 || update.byteLength > MAX_AWARENESS_PLAINTEXT_BYTES) {
      return undefined
    }
    try {
      const decoder = decoding.createDecoder(update)
      const count = decoding.readVarUint(decoder)
      if (count > MAX_AWARENESS_CLIENTS_PER_UPDATE) {
        return undefined
      }
      const clientIds: number[] = []
      const seen = new Set<number>()
      for (let index = 0; index < count; index += 1) {
        const clientId = decoding.readVarUint(decoder)
        const clock = decoding.readVarUint(decoder)
        if (
          !Number.isSafeInteger(clientId) ||
          clientId < 0 ||
          clientId > MAX_YJS_CLIENT_ID ||
          clientId === this.doc.clientID ||
          !Number.isSafeInteger(clock) ||
          seen.has(clientId)
        ) {
          return undefined
        }
        seen.add(clientId)
        clientIds.push(clientId)
        decoding.readVarString(decoder)
      }
      if (decoding.hasContent(decoder)) {
        return undefined
      }

      let stateIndex = 0
      const liveClientIds: number[] = []
      const normalized = modifyAwarenessUpdate(update, (state: unknown) => {
        const clientId = clientIds[stateIndex++]
        const normalizedState = this.normalizeAwarenessState(state)
        if (normalizedState !== null) {
          liveClientIds.push(clientId)
        }
        return normalizedState
      })
      if (stateIndex !== clientIds.length || normalized.byteLength > MAX_AWARENESS_PLAINTEXT_BYTES) {
        return undefined
      }
      return { update: normalized, liveClientIds }
    } catch {
      return undefined
    }
  }

  private remoteAwarenessClientIds(): Set<number> {
    const ids = new Set<number>()
    for (const clientId of this.yAwareness.getStates().keys()) {
      if (clientId !== this.doc.clientID) {
        ids.add(clientId)
      }
    }
    for (const clientId of this.yAwareness.meta.keys()) {
      if (clientId !== this.doc.clientID) {
        ids.add(clientId)
      }
    }
    return ids
  }

  private clearRemoteAwareness(origin: string): void {
    const remoteClientIds = [...this.remoteAwarenessClientIds()]
    if (remoteClientIds.length > 0) {
      removeAwarenessStates(this.yAwareness, remoteClientIds, origin)
      for (const clientId of remoteClientIds) {
        this.yAwareness.meta.delete(clientId)
      }
    }
  }

  private removeRemoteAwarenessClient(clientId: number, origin: string): void {
    if (clientId === this.doc.clientID) {
      return
    }
    if (this.yAwareness.getStates().has(clientId) || this.yAwareness.meta.has(clientId)) {
      removeAwarenessStates(this.yAwareness, [clientId], origin)
      this.yAwareness.meta.delete(clientId)
    }
  }

  private resolveEncryptedAwarenessIdentity(clientId: number): { userUuid?: string; label?: string } | undefined {
    const state = this.yAwareness.getStates().get(clientId)
    if (typeof state !== 'object' || state === null) {
      return undefined
    }
    const candidate = state as Record<string, unknown>
    const awarenessData = candidate.awarenessData
    return {
      ...(typeof candidate.name === 'string' ? { label: candidate.name } : {}),
      ...(typeof awarenessData === 'object' &&
      awarenessData !== null &&
      typeof (awarenessData as Record<string, unknown>).userUuid === 'string'
        ? { userUuid: (awarenessData as Record<string, unknown>).userUuid as string }
        : {}),
    }
  }

  private readonly onFrame = (frame: CollabFrame): void => {
    if (frame.room !== this.room) {
      return
    }
    if (this.options && this.joined && !this.validateLiveAttachment()) {
      return
    }
    const frameGeneration = this.transportGeneration
    switch (frame.t) {
      case 'room-joined':
        if (!this.connected || this.options || frame.requestId !== this.joinRequestId) {
          break
        }
        this.joined = true
        this.markStateServingReady()
        this.joinRetryAttempts = 0
        this.clearJoinRetry()
        this.track(Promise.all([this.broadcastFullState(), this.broadcastLocalAwareness()]).then(() => undefined))
        queueMicrotask(() => {
          if (this.connected && this.joined) {
            this.emit('sync', true as never)
          }
        })
        break
      case 'room-denied':
        if (frame.requestId === this.joinRequestId) {
          const shouldReauthorize = this.joined
          this.transportGeneration += 1
          const generation = this.transportGeneration
          this.joined = false
          this.setCanonicalOwnership(false)
          this.awaitingBootstrapSeed = false
          this.stateEstablishingGeneration = undefined
          this.pendingRetryBeforeReady = undefined
          this.setLocalStateReadiness(false)
          this.clearStateRequest()
          this.clearStateResponseQueue()
          this.clearPendingResponseClaims()
          this.rejectAcceptanceWaiters()
          this.clearInboundTransfers()
          this.clearInboundCryptoQueue()
          this.clearLocalOutboundQueue()
          this.stopPresenceHeartbeat()
          this.ephemeralPresence?.clear()
          this.clearRemoteAwareness('room-denied')
          this.emit('sync', false as never)
          if (shouldReauthorize && this.connected) {
            if (this.options) {
              const expiredLease = this.currentLease
              this.currentLease = undefined
              expiredLease?.release()
              void this.reactivateAfterReconnect(generation)
            } else {
              void this.joinWithCapability()
            }
          }
        }
        break
      case 'room-presence':
        if (this.joined) {
          this.ephemeralPresence?.accept(frame)
        }
        break
      case 'room-sync':
        // Production v2 newcomers issue an explicit correlated retry and the
        // gateway suppresses room-wide room-sync broadcasts. Keep this only for
        // direct legacy provider consumers used outside the active-lease path.
        if (this.joined && this.stateServingReady && !this.options) {
          this.queueStateResponse()
        }
        break
      case 'yjs':
        if (!this.joined) {
          break
        }
        this.enqueueInboundCrypto({
          kind: 'yjs',
          ciphertextBytes: frame.payload.length,
          run: async () => {
            if (!this.validateLiveAttachment()) {
              return
            }
            const update = await this.cipher.decrypt(
              frame.payload,
              encodeFrameAdditionalData(this.room, 'yjs', frame.transferId, frame.stateRequestId),
            )
            if (
              this.connected &&
              this.joined &&
              frameGeneration === this.transportGeneration &&
              this.validateLiveAttachment()
            ) {
              if (!this.applyRemoteUpdateWithinBudget(update)) {
                return
              }
              this.markRecoveryStateApplied(frame.stateRequestId)
              if (
                frame.stateRequestId !== undefined &&
                frame.stateRequestId === this.awaitingStateRequestId &&
                this.hasDocumentState()
              ) {
                this.beginCorrelatedStateEstablishment(frame.stateRequestId)
              }
            }
          },
        })
        break
      case 'yjs-chunk':
        if (this.joined) {
          this.enqueueInboundCrypto({
            kind: 'yjs',
            ciphertextBytes: frame.payload.length,
            run: () => this.receiveEncryptedChunk(frame, frameGeneration),
          })
        }
        break
      case 'yjs-retry':
        if (this.joined && this.isValidRetryControlFrame(frame)) {
          if (!this.stateServingReady) {
            this.pendingRetryBeforeReady = frame
          } else {
            this.handleStateRetry(frame)
          }
        }
        break
      case 'yjs-response-granted':
        this.acceptStateResponseGrant(frame)
        break
      case 'yjs-accepted':
        if (
          this.joined &&
          frame.protocolVersion === COLLABORATION_PROTOCOL_VERSION &&
          this.isValidTransferId(frame.transferId)
        ) {
          this.resolveAcceptance(frame.transferId)
        }
        break
      case 'awareness':
        if (!this.joined) {
          break
        }
        if (
          typeof frame.payload !== 'string' ||
          frame.payload.length === 0 ||
          frame.payload.length > MAX_AWARENESS_ENCODED_BYTES
        ) {
          this.fatal('Live collaboration stopped because a remote presence frame exceeded safe limits.')
          break
        }
        this.enqueueInboundCrypto({
          kind: 'awareness',
          ciphertextBytes: frame.payload.length,
          run: async () => {
            if (!this.validateLiveAttachment()) {
              return
            }
            const update = await this.cipher.decrypt(frame.payload, encodeFrameAdditionalData(this.room, 'awareness'))
            const validated = this.validateInboundAwareness(update)
            if (!validated) {
              this.clearRemoteAwareness('invalid-remote-awareness')
              this.fatal('Live collaboration stopped because a remote presence frame was invalid.')
              return
            }
            const resultingRemoteIds = this.remoteAwarenessClientIds()
            for (const clientId of validated.liveClientIds) {
              resultingRemoteIds.add(clientId)
            }
            if (resultingRemoteIds.size > MAX_REMOTE_AWARENESS_CLIENTS) {
              this.clearRemoteAwareness('remote-awareness-capacity')
              this.fatal('Live collaboration stopped because remote presence exceeded safe capacity.')
              return
            }
            if (
              this.connected &&
              this.joined &&
              frameGeneration === this.transportGeneration &&
              this.validateLiveAttachment()
            ) {
              applyAwarenessUpdate(this.yAwareness, validated.update, 'remote')
              this.ephemeralPresence?.reconcileEncryptedAwareness()
              if (this.remoteAwarenessClientIds().size > MAX_REMOTE_AWARENESS_CLIENTS) {
                this.clearRemoteAwareness('remote-awareness-capacity')
                this.fatal('Live collaboration stopped because remote presence exceeded safe capacity.')
              }
            }
          },
        })
        break
    }
  }

  private track(p: Promise<void>): void {
    const settled = p
      // Do not log thrown objects: a custom cipher/channel error could include
      // plaintext, ciphertext, key material, or a capability in its message.
      .catch(() => console.error('[collab] encrypted frame processing failed'))
      .finally(() => this.pending.delete(settled))
    this.pending.add(settled)
  }

  private trackYjsWork(promise: Promise<void>, requestRetryOnFailure: boolean): void {
    this.track(
      promise.catch(() => {
        this.reportSyncFailure('encrypted-yjs-frame-failed')
        if (requestRetryOnFailure) {
          this.requestFullStateRetry(createCollaborationRequestId())
        }
      }),
    )
  }

  /**
   * One shared, byte-accounted scheduler covers every inbound WebCrypto path.
   * Yjs work always wins queued capacity; awareness is capped to two active
   * decryptions and a queued awareness update is replaced by the newest one.
   */
  private enqueueInboundCrypto(job: InboundCryptoJob): void {
    if (!this.validateLiveAttachment()) {
      return
    }
    if (!Number.isSafeInteger(job.ciphertextBytes) || job.ciphertextBytes <= 0) {
      return
    }

    if (job.kind === 'awareness') {
      const queuedAwareness = this.inboundCryptoQueue.findIndex((candidate) => candidate.kind === 'awareness')
      if (queuedAwareness >= 0) {
        const [replaced] = this.inboundCryptoQueue.splice(queuedAwareness, 1)
        this.inboundCryptoBytes -= replaced.ciphertextBytes
      }
    }

    if (
      this.inboundCryptoActive + this.inboundCryptoQueue.length >= MAX_INBOUND_CRYPTO_OPERATIONS ||
      this.inboundCryptoBytes + job.ciphertextBytes > MAX_INBOUND_CRYPTO_BYTES
    ) {
      if (job.kind === 'yjs') {
        this.reportSyncFailure('encrypted-yjs-crypto-capacity-exceeded')
        this.requestFullStateRetry(createCollaborationRequestId())
      }
      return
    }

    this.inboundCryptoQueue.push(job)
    this.inboundCryptoBytes += job.ciphertextBytes
    this.drainInboundCryptoQueue()
  }

  private drainInboundCryptoQueue(): void {
    while (this.inboundCryptoActive < MAX_ACTIVE_INBOUND_CRYPTO && this.inboundCryptoQueue.length > 0) {
      let index = this.inboundCryptoQueue.findIndex((job) => job.kind === 'yjs')
      if (index < 0) {
        if (this.inboundAwarenessActive >= MAX_ACTIVE_AWARENESS_CRYPTO) {
          return
        }
        index = 0
      }
      const [job] = this.inboundCryptoQueue.splice(index, 1)
      this.inboundCryptoActive += 1
      if (job.kind === 'awareness') {
        this.inboundAwarenessActive += 1
      }
      const work = job
        .run()
        .catch((error: unknown) => {
          const shouldRetry = this.handleCipherFailure(error, 'encrypted-yjs-frame-failed')
          if (job.kind === 'yjs' && shouldRetry) {
            this.requestFullStateRetry(createCollaborationRequestId())
          }
        })
        .finally(() => {
          this.inboundCryptoActive -= 1
          if (job.kind === 'awareness') {
            this.inboundAwarenessActive -= 1
          }
          this.inboundCryptoBytes -= job.ciphertextBytes
          this.drainInboundCryptoQueue()
        })
      this.track(work)
    }
  }

  private clearInboundCryptoQueue(): void {
    for (const job of this.inboundCryptoQueue) {
      this.inboundCryptoBytes -= job.ciphertextBytes
    }
    this.inboundCryptoQueue.length = 0
  }

  private async receiveEncryptedChunk(frame: YjsChunkFrame, expectedGeneration: number): Promise<void> {
    if (expectedGeneration !== this.transportGeneration || !this.validateLiveAttachment()) {
      return
    }
    this.cleanupExpiredTransfers()
    if (!this.isValidChunkMetadata(frame)) {
      this.reportSyncFailure('encrypted-yjs-chunk-metadata-invalid')
      if (this.isValidTransferId(frame.transferId)) {
        this.rejectTransfer(frame.transferId, true)
      }
      return
    }
    if (this.recentTransferIds.has(frame.transferId)) {
      this.reportSyncFailure('encrypted-yjs-chunk-duplicate')
      return
    }

    let transfer = this.inboundTransfers.get(frame.transferId)
    if (!transfer) {
      if (
        this.inboundTransfers.size >= MAX_INBOUND_TRANSFERS ||
        this.inboundReservedBytes + frame.totalBytes > MAX_INBOUND_RESERVED_BYTES ||
        this.inboundReservedChunks + frame.count > MAX_INBOUND_RESERVED_CHUNKS
      ) {
        this.reportSyncFailure('encrypted-yjs-transfer-capacity-exceeded')
        this.requestFullStateRetry(frame.transferId)
        return
      }
      transfer = {
        count: frame.count,
        totalBytes: frame.totalBytes,
        expiresAt: Date.now() + YJS_TRANSFER_TIMEOUT_MS,
        reservedIndexes: new Set(),
        chunks: new Map(),
        receivedBytes: 0,
        ...(frame.stateRequestId ? { stateRequestId: frame.stateRequestId } : {}),
      }
      this.inboundTransfers.set(frame.transferId, transfer)
      this.inboundReservedBytes += frame.totalBytes
      this.inboundReservedChunks += frame.count
      this.scheduleInboundCleanup()
    } else if (
      transfer.count !== frame.count ||
      transfer.totalBytes !== frame.totalBytes ||
      transfer.stateRequestId !== frame.stateRequestId
    ) {
      this.reportSyncFailure('encrypted-yjs-chunk-metadata-mismatch')
      this.rejectTransfer(frame.transferId, true)
      return
    }

    if (transfer.reservedIndexes.has(frame.index)) {
      this.reportSyncFailure('encrypted-yjs-chunk-duplicate')
      this.rejectTransfer(frame.transferId, true)
      return
    }
    if (this.inboundChunkDecrypts >= MAX_INBOUND_CHUNK_DECRYPTS) {
      this.reportSyncFailure('encrypted-yjs-chunk-decrypt-capacity-exceeded')
      this.rejectTransfer(frame.transferId, true)
      return
    }
    transfer.reservedIndexes.add(frame.index)
    this.inboundChunkDecrypts += 1

    let chunk: Uint8Array
    try {
      chunk = await this.cipher.decrypt(frame.payload, encodeChunkAdditionalData(frame))
    } catch (error) {
      const shouldRetry = this.handleCipherFailure(error, 'encrypted-yjs-chunk-decryption-failed')
      this.rejectTransfer(frame.transferId, shouldRetry)
      return
    } finally {
      // Do not reset this in clearInboundTransfers(): disconnect/reject can
      // release metadata while WebCrypto work is still outstanding.
      this.inboundChunkDecrypts -= 1
    }

    if (expectedGeneration !== this.transportGeneration || !this.validateLiveAttachment()) {
      return
    }

    const current = this.inboundTransfers.get(frame.transferId)
    if (current !== transfer) {
      return
    }
    const expectedBytes = Math.min(
      YJS_CHUNK_PLAINTEXT_BYTES,
      frame.totalBytes - frame.index * YJS_CHUNK_PLAINTEXT_BYTES,
    )
    if (chunk.byteLength !== expectedBytes) {
      this.reportSyncFailure('encrypted-yjs-chunk-size-invalid')
      this.rejectTransfer(frame.transferId, true)
      return
    }
    transfer.chunks.set(frame.index, chunk)
    transfer.receivedBytes += chunk.byteLength

    if (transfer.chunks.size !== transfer.count) {
      return
    }
    if (transfer.receivedBytes !== transfer.totalBytes) {
      this.reportSyncFailure('encrypted-yjs-transfer-size-invalid')
      this.rejectTransfer(frame.transferId, true)
      return
    }

    const update = new Uint8Array(transfer.totalBytes)
    for (let index = 0; index < transfer.count; index += 1) {
      const part = transfer.chunks.get(index)
      if (!part) {
        this.reportSyncFailure('encrypted-yjs-transfer-incomplete')
        this.rejectTransfer(frame.transferId, true)
        return
      }
      update.set(part, index * YJS_CHUNK_PLAINTEXT_BYTES)
    }
    this.releaseTransfer(frame.transferId, true)
    if (
      this.connected &&
      this.joined &&
      expectedGeneration === this.transportGeneration &&
      this.validateLiveAttachment()
    ) {
      if (!this.applyRemoteUpdateWithinBudget(update)) {
        return
      }
      this.markRecoveryStateApplied(transfer.stateRequestId)
      if (
        transfer.stateRequestId !== undefined &&
        transfer.stateRequestId === this.awaitingStateRequestId &&
        this.hasDocumentState()
      ) {
        this.beginCorrelatedStateEstablishment(transfer.stateRequestId)
      }
    }
  }

  /**
   * Classify only our non-secret cipher codes. Never inspect or log an arbitrary
   * thrown message: custom ciphers may include plaintext or key material there.
   */
  private handleCipherFailure(error: unknown, fallback: string): boolean {
    if (!isCollaborationCipherError(error)) {
      this.reportSyncFailure(fallback)
      return true
    }
    switch (error.code) {
      case 'REPLAYED':
      case 'SEQUENCE_WINDOW':
        this.reportSyncFailure('encrypted-envelope-replay-rejected')
        return false
      case 'EPOCH_MISMATCH':
        this.reportSyncFailure('encrypted-envelope-epoch-mismatch')
        this.fatal('Live collaboration stopped because the encrypted room epoch changed. Reconnect to continue.')
        return false
      case 'SENDER_LIMIT':
        this.reportSyncFailure('encrypted-envelope-sender-capacity')
        this.fatal('Live collaboration stopped because the encrypted room exceeded safe sender capacity.')
        return false
      case 'INVALID_ENVELOPE':
        this.reportSyncFailure('encrypted-envelope-invalid')
        return true
    }
  }

  private isValidChunkMetadata(frame: YjsChunkFrame): boolean {
    return (
      this.isValidTransferId(frame.transferId) &&
      Number.isSafeInteger(frame.index) &&
      Number.isSafeInteger(frame.count) &&
      Number.isSafeInteger(frame.totalBytes) &&
      frame.count >= 2 &&
      frame.count <= MAX_YJS_TRANSFER_CHUNKS &&
      frame.index >= 0 &&
      frame.index < frame.count &&
      frame.totalBytes > YJS_CHUNK_PLAINTEXT_BYTES &&
      frame.totalBytes <= MAX_YJS_TRANSFER_BYTES &&
      Math.ceil(frame.totalBytes / YJS_CHUNK_PLAINTEXT_BYTES) === frame.count &&
      typeof frame.payload === 'string' &&
      frame.payload.length > 0 &&
      frame.payload.length <= 512 * 1024 &&
      (frame.stateRequestId === undefined || this.isValidTransferId(frame.stateRequestId))
    )
  }

  private isValidTransferId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128
  }

  private rejectTransfer(transferId: string, retry: boolean): void {
    if (this.inboundTransfers.has(transferId)) {
      this.releaseTransfer(transferId, true)
    }
    if (retry) {
      this.requestFullStateRetry(transferId)
    }
  }

  private releaseTransfer(transferId: string, remember: boolean): void {
    const transfer = this.inboundTransfers.get(transferId)
    if (!transfer) {
      return
    }
    this.inboundTransfers.delete(transferId)
    this.inboundReservedBytes -= transfer.totalBytes
    this.inboundReservedChunks -= transfer.count
    if (remember) {
      this.recentTransferIds.set(transferId, Date.now() + YJS_TRANSFER_TIMEOUT_MS)
      while (this.recentTransferIds.size > MAX_RECENT_TRANSFER_IDS) {
        const oldest = this.recentTransferIds.keys().next().value as string | undefined
        if (!oldest) {
          break
        }
        this.recentTransferIds.delete(oldest)
      }
    }
    this.scheduleInboundCleanup()
  }

  private cleanupExpiredTransfers(): void {
    const now = Date.now()
    for (const [transferId, transfer] of [...this.inboundTransfers]) {
      if (transfer.expiresAt <= now) {
        this.reportSyncFailure('encrypted-yjs-transfer-timeout')
        this.rejectTransfer(transferId, true)
      }
    }
    for (const [transferId, expiresAt] of [...this.recentTransferIds]) {
      if (expiresAt <= now) {
        this.recentTransferIds.delete(transferId)
      }
    }
    this.scheduleInboundCleanup()
  }

  private scheduleInboundCleanup(): void {
    if (this.inboundCleanupTimeout !== undefined) {
      clearTimeout(this.inboundCleanupTimeout)
      this.inboundCleanupTimeout = undefined
    }
    const expiries = [
      ...[...this.inboundTransfers.values()].map((transfer) => transfer.expiresAt),
      ...this.recentTransferIds.values(),
    ]
    if (expiries.length === 0) {
      return
    }
    const delay = Math.max(0, Math.min(...expiries) - Date.now())
    this.inboundCleanupTimeout = setTimeout(() => {
      this.inboundCleanupTimeout = undefined
      this.cleanupExpiredTransfers()
    }, delay)
  }

  private clearInboundTransfers(): void {
    if (this.inboundCleanupTimeout !== undefined) {
      clearTimeout(this.inboundCleanupTimeout)
      this.inboundCleanupTimeout = undefined
    }
    this.inboundTransfers.clear()
    this.recentTransferIds.clear()
    this.inboundReservedBytes = 0
    this.inboundReservedChunks = 0
  }

  private requestFullStateRetry(requestId: string, reason: 'inbound' | 'outbound' = 'inbound'): void {
    this.recoveryReasons.add(reason)
    const now = Date.now()
    if (
      !this.connected ||
      !this.joined ||
      this.recoveryStateRequestId !== undefined ||
      this.recoveryStateRequestTimeout !== undefined
    ) {
      return
    }
    const cooldownRemaining = RETRY_COOLDOWN_MS - (now - this.lastRetryRequestAt)
    if (cooldownRemaining > 0) {
      this.recoveryStateRequestTimeout = setTimeout(() => {
        this.recoveryStateRequestTimeout = undefined
        this.requestFullStateRetry(createCollaborationRequestId(), reason)
      }, cooldownRemaining)
      return
    }
    if (this.recoveryStateAttempts >= MAX_CORRELATED_STATE_ATTEMPTS) {
      if (this.options) {
        this.requestBootstrapFailover()
      } else {
        this.fatal('Live collaboration stopped after bounded state-recovery attempts failed.')
      }
      return
    }
    this.lastRetryRequestAt = now
    this.recoveryStateAttempts += 1
    this.recoveryStateRequestId = requestId
    try {
      this.channel.send({
        t: 'yjs-retry',
        room: this.room,
        requestId,
        requesterClientId: this.doc.clientID,
      })
      this.recoveryStateRequestTimeout = setTimeout(() => {
        if (this.recoveryStateRequestId !== requestId) {
          return
        }
        this.recoveryStateRequestId = undefined
        this.recoveryStateRequestTimeout = undefined
        this.reportSyncFailure('encrypted-yjs-recovery-state-timeout')
        this.requestFullStateRetry(createCollaborationRequestId(), reason)
      }, CONTROL_RESPONSE_TIMEOUT_MS)
    } catch {
      if (this.recoveryStateRequestId === requestId) {
        this.recoveryStateRequestId = undefined
      }
      this.reportSyncFailure('encrypted-yjs-recovery-state-request-failed')
      this.recoveryStateRequestTimeout = setTimeout(() => {
        this.recoveryStateRequestTimeout = undefined
        this.requestFullStateRetry(createCollaborationRequestId(), reason)
      }, RETRY_COOLDOWN_MS)
    }
  }

  private markRecoveryStateApplied(stateRequestId: string | undefined): void {
    if (stateRequestId === undefined || stateRequestId !== this.recoveryStateRequestId) {
      return
    }
    this.recoveryStateRequestId = undefined
    if (this.recoveryStateRequestTimeout !== undefined) {
      clearTimeout(this.recoveryStateRequestTimeout)
      this.recoveryStateRequestTimeout = undefined
    }
    this.recoveryStateAttempts = 0
    this.recoveryReasons.clear()
    if (this.pendingLocalYjsUpdate) {
      if (this.localOutboundRetryTimeout !== undefined) {
        clearTimeout(this.localOutboundRetryTimeout)
        this.localOutboundRetryTimeout = undefined
      }
      this.localOutboundFailureAttempts = 0
      this.localOutboundRetryBlocked = false
      this.drainLocalOutboundQueue()
    } else {
      this.lastSyncFailure = undefined
      this.emit('sync', true as never)
    }
  }

  private isValidRetryControlFrame(frame: RetryControlFrame): boolean {
    return (
      this.isValidTransferId(frame.requestId) &&
      Number.isSafeInteger(frame.requesterClientId) &&
      frame.requesterClientId >= 0 &&
      frame.requesterClientId <= MAX_YJS_CLIENT_ID
    )
  }

  private setLocalStateReadiness(ready: boolean): void {
    const current = (this.yAwareness.getLocalState() ?? this.retainedLocalAwarenessState ?? {}) as Record<
      string,
      unknown
    >
    const currentAwarenessData =
      typeof current.awarenessData === 'object' && current.awarenessData !== null
        ? (current.awarenessData as Record<string, unknown>)
        : {}
    if (currentAwarenessData[STATE_READY_AWARENESS_FIELD] === ready) {
      return
    }
    this.yAwareness.setLocalState({
      ...current,
      awarenessData: {
        ...currentAwarenessData,
        [STATE_READY_AWARENESS_FIELD]: ready,
      },
    })
  }

  private retainLocalAwarenessState(): void {
    const current = this.yAwareness.getLocalState()
    if (current) {
      this.retainedLocalAwarenessState = {
        ...(current as Record<string, unknown>),
        awarenessData:
          typeof (current as Record<string, unknown>).awarenessData === 'object' &&
          (current as Record<string, unknown>).awarenessData !== null
            ? { ...((current as Record<string, unknown>).awarenessData as Record<string, unknown>) }
            : {},
      }
    }
  }

  private restoreLocalAwarenessState(): void {
    if (this.yAwareness.getLocalState() === null && this.retainedLocalAwarenessState) {
      this.yAwareness.setLocalState({
        ...this.retainedLocalAwarenessState,
        awarenessData:
          typeof this.retainedLocalAwarenessState.awarenessData === 'object' &&
          this.retainedLocalAwarenessState.awarenessData !== null
            ? { ...(this.retainedLocalAwarenessState.awarenessData as Record<string, unknown>) }
            : {},
      })
    }
  }

  private markStateServingReady(): void {
    this.setStateServingReady(true)
    this.setCanonicalOwnership(this.connected && this.joined)
    this.setLocalStateReadiness(true)
    const pending = this.pendingRetryBeforeReady
    this.pendingRetryBeforeReady = undefined
    if (pending) {
      this.handleStateRetry(pending)
    }
  }

  private handleStateRetry(frame: RetryControlFrame): void {
    if (this.options) {
      this.claimStateResponse(frame)
    } else {
      this.respondToElectedRetry(frame)
    }
  }

  /**
   * Every ready production peer submits only a small lease-bound claim. The
   * gateway/Redis NX arbitration grants exactly one peer globally, so divergent
   * or cyclic awareness views cannot amplify full encrypted note snapshots.
   */
  private claimStateResponse(frame: RetryControlFrame): void {
    const lease = this.currentLease
    if (
      !this.options ||
      !lease ||
      frame.requesterClientId === this.doc.clientID ||
      !this.connected ||
      !this.joined ||
      !this.stateServingReady ||
      !this.hasDocumentState() ||
      !this.validateLiveAttachment()
    ) {
      return
    }
    this.cleanupPendingResponseClaims()
    if (this.pendingResponseClaims.has(frame.requestId)) {
      return
    }
    while (this.pendingResponseClaims.size >= MAX_PENDING_RESPONSE_CLAIMS) {
      const oldest = this.pendingResponseClaims.keys().next().value as string | undefined
      if (!oldest) {
        return
      }
      this.pendingResponseClaims.delete(oldest)
    }
    this.pendingResponseClaims.set(frame.requestId, {
      leaseRequestId: lease.requestId,
      expiresAt: Date.now() + RESPONSE_CLAIM_TTL_MS,
    })
    try {
      this.channel.send({
        t: 'yjs-response-claim',
        room: this.room,
        stateRequestId: frame.requestId,
        leaseRequestId: lease.requestId,
      })
    } catch {
      this.pendingResponseClaims.delete(frame.requestId)
    }
  }

  private acceptStateResponseGrant(frame: Extract<CollabFrame, { t: 'yjs-response-granted' }>): void {
    if (
      !this.options ||
      !this.connected ||
      !this.joined ||
      !this.stateServingReady ||
      frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
      !this.isValidTransferId(frame.stateRequestId) ||
      !this.isValidTransferId(frame.leaseRequestId) ||
      !this.validateLiveAttachment()
    ) {
      return
    }
    this.cleanupPendingResponseClaims()
    const claim = this.pendingResponseClaims.get(frame.stateRequestId)
    if (
      !claim ||
      claim.leaseRequestId !== frame.leaseRequestId ||
      this.currentLease?.requestId !== frame.leaseRequestId
    ) {
      return
    }
    this.pendingResponseClaims.delete(frame.stateRequestId)
    this.queueStateResponse(frame.stateRequestId)
  }

  private cleanupPendingResponseClaims(): void {
    const now = Date.now()
    for (const [stateRequestId, claim] of this.pendingResponseClaims) {
      if (claim.expiresAt <= now) {
        this.pendingResponseClaims.delete(stateRequestId)
      }
    }
  }

  private clearPendingResponseClaims(): void {
    this.pendingResponseClaims.clear()
  }

  private awarenessStateIsReady(state: unknown): boolean {
    if (typeof state !== 'object' || state === null) {
      return false
    }
    const awarenessData = (state as Record<string, unknown>).awarenessData
    return (
      typeof awarenessData === 'object' &&
      awarenessData !== null &&
      (awarenessData as Record<string, unknown>)[STATE_READY_AWARENESS_FIELD] === true
    )
  }

  private retryElectionHash(requestId: string): number {
    let hash = 0x811c9dc5
    const input = `${this.room}\u0000${requestId}`
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
  }

  private respondToElectedRetry(frame: RetryControlFrame): void {
    const candidates = [...this.yAwareness.getStates()]
      .filter(
        ([clientId, state]) =>
          clientId !== frame.requesterClientId &&
          Number.isSafeInteger(clientId) &&
          clientId >= 0 &&
          clientId <= MAX_YJS_CLIENT_ID &&
          this.awarenessStateIsReady(state),
      )
      .map(([clientId]) => clientId)
      .sort((first, second) => first - second)
    if (candidates.length === 0) {
      return
    }
    const elected = candidates[this.retryElectionHash(frame.requestId) % candidates.length]
    if (elected === this.doc.clientID) {
      this.queueStateResponse(frame.requestId)
    }
  }

  /**
   * One global response gate covers both unique-id retry floods and room-sync
   * join storms. At most one full-state encryption is active and one latest
   * correlated request is retained for the next cooldown window.
   */
  private queueStateResponse(requestId?: string): void {
    if (!this.connected || !this.joined || !this.stateServingReady || !this.hasDocumentState()) {
      return
    }
    if (!this.stateResponsePending || requestId !== undefined) {
      this.pendingStateResponseRequestId = requestId
    }
    this.stateResponsePending = true
    this.drainStateResponseQueue()
  }

  private drainStateResponseQueue(): void {
    if (
      !this.stateResponsePending ||
      this.stateResponseInFlight ||
      this.stateResponseTimeout !== undefined ||
      !this.connected ||
      !this.joined ||
      !this.stateServingReady
    ) {
      return
    }
    const delay = RETRY_COOLDOWN_MS - (Date.now() - this.lastStateResponseAt)
    if (delay > 0) {
      this.stateResponseTimeout = setTimeout(() => {
        this.stateResponseTimeout = undefined
        this.drainStateResponseQueue()
      }, delay)
      return
    }

    const requestId = this.pendingStateResponseRequestId
    this.pendingStateResponseRequestId = undefined
    this.stateResponsePending = false
    this.stateResponseInFlight = true
    this.lastStateResponseAt = Date.now()
    this.trackYjsWork(
      this.broadcastFullState(requestId).finally(() => {
        this.stateResponseInFlight = false
        this.drainStateResponseQueue()
      }),
      false,
    )
  }

  private clearStateResponseQueue(): void {
    if (this.stateResponseTimeout !== undefined) {
      clearTimeout(this.stateResponseTimeout)
      this.stateResponseTimeout = undefined
    }
    this.stateResponsePending = false
    this.pendingStateResponseRequestId = undefined
  }

  private requestCorrelatedFullState(): void {
    if (!this.connected || !this.joined) {
      return
    }
    this.clearStateRequest()
    this.correlatedStateAttempts += 1
    const requestId = createCollaborationRequestId()
    this.awaitingStateRequestId = requestId
    this.stateRequestTimeout = setTimeout(() => {
      if (this.awaitingStateRequestId !== requestId) {
        return
      }
      this.awaitingStateRequestId = undefined
      this.stateRequestTimeout = undefined
      this.reportSyncFailure('encrypted-yjs-correlated-state-timeout')
      if (this.connected && this.joined) {
        if (this.correlatedStateAttempts >= MAX_CORRELATED_STATE_ATTEMPTS) {
          this.requestBootstrapFailover()
        } else {
          this.requestCorrelatedFullState()
        }
      }
    }, CONTROL_RESPONSE_TIMEOUT_MS)
    try {
      this.channel.send({
        t: 'yjs-retry',
        room: this.room,
        requestId,
        requesterClientId: this.doc.clientID,
      })
    } catch {
      this.awaitingStateRequestId = undefined
      if (this.stateRequestTimeout !== undefined) {
        clearTimeout(this.stateRequestTimeout)
      }
      this.reportSyncFailure('encrypted-yjs-state-request-failed')
      this.stateRequestTimeout = setTimeout(() => {
        this.stateRequestTimeout = undefined
        if (!this.connected || !this.joined) {
          return
        }
        if (this.correlatedStateAttempts >= MAX_CORRELATED_STATE_ATTEMPTS) {
          this.requestBootstrapFailover()
        } else {
          this.requestCorrelatedFullState()
        }
      }, RETRY_COOLDOWN_MS)
    }
  }

  private beginCorrelatedStateEstablishment(stateRequestId: string): void {
    if (stateRequestId !== this.awaitingStateRequestId || !this.hasDocumentState()) {
      return
    }
    this.clearStateRequest()
    this.correlatedStateAttempts = 0
    this.track(this.establishCurrentDocumentState(this.transportGeneration))
  }

  private clearStateRequest(): void {
    this.awaitingStateRequestId = undefined
    this.clearRecoveryStateRequest()
    this.recoveryReasons.clear()
    if (this.stateRequestTimeout !== undefined) {
      clearTimeout(this.stateRequestTimeout)
      this.stateRequestTimeout = undefined
    }
  }

  private clearRecoveryStateRequest(): void {
    this.recoveryStateRequestId = undefined
    if (this.recoveryStateRequestTimeout !== undefined) {
      clearTimeout(this.recoveryStateRequestTimeout)
      this.recoveryStateRequestTimeout = undefined
    }
  }

  private hasDocumentState(): boolean {
    // An unseeded Y.Doc has a one-byte empty state vector. A canonical blank
    // Lexical document still creates Yjs structs and therefore a larger vector.
    return Y.encodeStateVector(this.doc).byteLength > 1
  }

  /**
   * Prove one nonempty full state was accepted before serving it to others.
   * Acceptance windows provide bounded backoff; after three failed windows the
   * hook remounts and re-runs canonical bootstrap election instead of hanging.
   */
  private async establishCurrentDocumentState(generation: number): Promise<void> {
    if (this.stateEstablishingGeneration === generation || !this.hasDocumentState()) {
      return
    }
    this.stateEstablishingGeneration = generation
    try {
      for (let attempt = 0; attempt < MAX_STATE_ESTABLISHMENT_ATTEMPTS; attempt += 1) {
        if (generation !== this.transportGeneration || !this.connected || !this.joined) {
          return
        }
        try {
          await this.broadcastFullState(undefined, true)
          if (generation !== this.transportGeneration || !this.connected || !this.joined) {
            return
          }
          this.awaitingBootstrapSeed = false
          this.markStateServingReady()
          this.lastSyncFailure = undefined
          this.emit('sync', true as never)
          // Capture any local Yjs structs created while the accepted snapshot
          // was in flight. Readiness is set first, so subsequent edits relay as
          // incrementals and cannot fall into another pre-ready gap.
          this.trackYjsWork(this.broadcastFullState(), false)
          return
        } catch {
          // Retry with a fresh full snapshot after the bounded acceptance
          // window; thrown errors are deliberately not logged with payloads.
        }
      }
      if (generation === this.transportGeneration && this.connected && this.joined) {
        this.reportSyncFailure('encrypted-yjs-state-establishment-failed')
        this.requestBootstrapFailover()
      }
    } finally {
      if (this.stateEstablishingGeneration === generation) {
        this.stateEstablishingGeneration = undefined
      }
    }
  }

  private requestBootstrapFailover(): void {
    if (!this.connected || !this.options) {
      return
    }
    this.awaitingBootstrapSeed = false
    this.setStateServingReady(false)
    this.setLocalStateReadiness(false)
    this.pendingRetryBeforeReady = undefined
    this.clearStateRequest()
    this.clearStateResponseQueue()
    this.clearPendingResponseClaims()
    this.joined = false
    this.clearLocalOutboundQueue()
    this.stopPresenceHeartbeat()
    this.ephemeralPresence?.clear()
    this.clearRemoteAwareness('bootstrap-failover')
    this.currentLease?.release()
    this.currentLease = undefined
    this.emit('sync', false as never)
    this.options.onBootstrapRetry?.()
  }

  private waitForAcceptance(transferId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.acceptanceWaiters.delete(transferId)
        reject(new Error('encrypted-yjs-acceptance-timeout'))
      }, CONTROL_RESPONSE_TIMEOUT_MS)
      this.acceptanceWaiters.set(transferId, {
        timeout,
        resolve: () => {
          clearTimeout(timeout)
          this.acceptanceWaiters.delete(transferId)
          resolve()
        },
        reject: () => {
          clearTimeout(timeout)
          this.acceptanceWaiters.delete(transferId)
          reject(new Error('encrypted-yjs-acceptance-rejected'))
        },
      })
    })
  }

  private resolveAcceptance(transferId: string): void {
    this.acceptanceWaiters.get(transferId)?.resolve()
  }

  private rejectAcceptance(transferId: string): void {
    this.acceptanceWaiters.get(transferId)?.reject()
  }

  private rejectAcceptanceWaiters(): void {
    for (const waiter of [...this.acceptanceWaiters.values()]) {
      waiter.reject()
    }
  }

  private fatal(reason: string): void {
    this.lastSyncFailure = 'encrypted-yjs-fatal'
    this.joined = false
    this.setStateServingReady(false)
    this.awaitingBootstrapSeed = false
    this.stateEstablishingGeneration = undefined
    this.pendingRetryBeforeReady = undefined
    this.setLocalStateReadiness(false)
    this.clearStateRequest()
    this.clearStateResponseQueue()
    this.clearPendingResponseClaims()
    this.rejectAcceptanceWaiters()
    this.clearInboundTransfers()
    this.clearInboundCryptoQueue()
    this.clearLocalOutboundQueue()
    this.stopPresenceHeartbeat()
    this.ephemeralPresence?.clear()
    this.clearRemoteAwareness('collaboration-fatal')
    this.currentLease?.release()
    this.currentLease = undefined
    this.emit('sync', false as never)
    this.options?.onFatal(reason)
  }

  private reportSyncFailure(reason: string): void {
    this.lastSyncFailure = reason
    this.emit('sync', false as never)
    console.error(`[collab] ${reason}`)
  }

  private scheduleJoinRetry(): void {
    if (this.joinRetryTimeout !== undefined || !this.connected || !this.channel.isConnected()) {
      return
    }
    if (this.joinRetryAttempts >= MAX_JOIN_RETRIES) {
      // Never leave a mounted editor permanently waiting on an open socket.
      // Production remounts through the bootstrap preparation barrier; direct
      // consumers receive an explicit fatal fallback.
      if (this.options) {
        this.requestBootstrapFailover()
      } else {
        this.fatal('Live collaboration stopped after bounded authorization retries failed.')
      }
      return
    }
    const baseDelay = Math.min(30_000, 1_000 * 2 ** this.joinRetryAttempts)
    const delay = baseDelay * (0.5 + Math.random() * 0.5)
    this.joinRetryAttempts += 1
    this.joinRetryTimeout = setTimeout(() => {
      this.joinRetryTimeout = undefined
      if (this.options) {
        void this.reactivateAfterReconnect()
      } else {
        void this.joinWithCapability()
      }
    }, delay)
  }

  private clearJoinRetry(): void {
    if (this.joinRetryTimeout !== undefined) {
      clearTimeout(this.joinRetryTimeout)
      this.joinRetryTimeout = undefined
    }
  }
}
