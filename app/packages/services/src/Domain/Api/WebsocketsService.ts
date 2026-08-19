import { isErrorResponse } from '@standardnotes/responses'
import { DomainEventInterface } from '@standardnotes/domain-events'
import { WebSocketApiServiceInterface } from '@standardnotes/api'
import { WebSocketsServiceEvent } from './WebSocketsServiceEvent'
import { StorageServiceInterface } from '../Storage/StorageServiceInterface'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { AbstractService } from '../Service/AbstractService'
import { StorageKey } from '../Storage/StorageKeys'
import { Result } from '@standardnotes/domain-core'

/**
 * Collaborative-editing relay frames carried over the same authenticated gateway
 * socket (see websocket-gateway/src/rooms.ts). A room id is a note uuid; payloads
 * are end-to-end-encrypted yjs sync/awareness blobs the gateway cannot read.
 */
export type CollaborationFrame =
  // `cap` is the short-lived signed capability proving this user may join the
  // room; obtained via authorizeCollaborationRoom() and required by the gateway.
  | {
      t: 'room-reserve'
      room: string
      cap: string
      requestId: string
      role: 'editor'
      protocolVersion: 3
      expectedRoomEpoch: string
    }
  | {
      t: 'room-join'
      room: string
      cap?: string
      requestId?: string
      role?: 'editor' | 'comment'
      protocolVersion?: 3
      expectedRoomEpoch?: string
    }
  | { t: 'room-leave'; room: string; requestId?: string }
  | {
      t: 'room-presence-heartbeat'
      room: string
      requestId: string
      expectedRoomEpoch: string
      protocolVersion: 3
      clientId: number
    }
  | {
      t: 'room-presence'
      room: string
      roomEpoch: string
      protocolVersion: 3
      action: 'joined'
      presenceId: string
      userUuid: string
      clientId: number
      ttlMilliseconds: number
    }
  | {
      t: 'room-presence'
      room: string
      roomEpoch: string
      protocolVersion: 3
      action: 'left'
      presenceId: string
      userUuid?: string
      clientId?: number
      reason: 'clean-leave' | 'disconnect' | 'heartbeat-timeout' | 'revoked'
    }
  | {
      t: 'room-reserved'
      room: string
      requestId: string
      bootstrap: boolean
      bootstrapChallenge?: string
      protocolVersion: 3
      maxTransferBytes: number
      roomEpoch: string
    }
  | {
      t: 'room-joined'
      room: string
      requestId?: string
      bootstrap?: boolean
      protocolVersion?: number
      maxTransferBytes?: number
      roomEpoch?: string
    }
  | { t: 'room-sync'; room: string }
  | { t: 'yjs'; room: string; payload: string; transferId?: string; stateRequestId?: string }
  | {
      t: 'yjs-chunk'
      room: string
      transferId: string
      index: number
      count: number
      totalBytes: number
      payload: string
      stateRequestId?: string
    }
  | { t: 'yjs-retry'; room: string; requestId: string; requesterClientId: number }
  | { t: 'yjs-response-claim'; room: string; stateRequestId: string; leaseRequestId: string }
  | {
      t: 'yjs-response-granted'
      room: string
      stateRequestId: string
      leaseRequestId: string
      protocolVersion: 3
    }
  | { t: 'yjs-accepted'; room: string; transferId: string; protocolVersion: 3 }
  | { t: 'awareness'; room: string; payload: string }
  // Gateway -> client: the join was refused (no/invalid capability or no access).
  | { t: 'room-denied'; room: string; requestId?: string; roomEpoch?: string }
  // Standard Red Notes: an end-to-end-encrypted note-comment event. `payload` is
  // a base64(iv ‖ ciphertext) blob encrypted with the same per-room key as the
  // yjs frames, so the gateway never sees comment text. Used to push new/edited
  // comments live to collaborators who have the same note open.
  | { t: 'comment'; room: string; payload: string }

const COLLABORATION_FRAME_TYPES = new Set([
  'room-join',
  'room-reserve',
  'room-reserved',
  'room-leave',
  'room-presence-heartbeat',
  'room-presence',
  'room-joined',
  'room-sync',
  'yjs',
  'yjs-chunk',
  'yjs-retry',
  'yjs-response-claim',
  'yjs-response-granted',
  'yjs-accepted',
  'awareness',
  'comment',
  'room-denied',
])

/**
 * Standard Red Notes (Phase 1A): payload carried by a SYNC_ITEMS_PUSHED message.
 * `items` are the SAME end-to-end-encrypted item representations the client
 * already receives for retrieved items over HTTP — the gateway and this service
 * never see plaintext. `baseSyncToken` is the server's sync token immediately
 * BEFORE the change; the client only fast-applies when its current token equals
 * it, otherwise it discards and reconciles via HTTP. `syncToken` is the new
 * token to adopt after applying.
 */
export interface SyncItemsPushedData {
  items: unknown[]
  syncToken: string
  baseSyncToken: string
}

export type CollaborationRoomAuthorization = {
  capability: string
  serverUpdatedAtTimestamp: number
  collaborationProtocolVersion: 3
  roomEpoch: string
  collaborationSecurityEpoch: string
  leaseRequestId?: string
  bootstrapChallenge?: string
}

export type CollaborationRoomEpochDiscovery = {
  room: string
  serverUpdatedAtTimestamp: number
  collaborationProtocolVersion: 3
  roomEpoch: string
  collaborationSecurityEpoch: string
}

/**
 * `expectedRoomEpoch` pins the request to an epoch the caller already holds. The
 * worker aborts during epoch discovery when the discovered epoch differs, before
 * any grant is issued. Omitting it is what left that pre-grant abort unreachable
 * from production, so pass it whenever the caller has an epoch to bind to; the
 * echoed-epoch check in `normalizeCollaborationAuthorization` still backs it up.
 */
export type CollaborationRoomAuthorizationTransport = (
  noteUuid: string,
  leaseRequestId?: string,
  bootstrapChallenge?: string,
  expectedRoomEpoch?: string,
) => Promise<
  (CollaborationRoomAuthorization & { epochDiscovery: false; room: string; expiresIn: number }) | null | undefined
>

export class WebSocketsService extends AbstractService<
  WebSocketsServiceEvent,
  DomainEventInterface | SyncItemsPushedData | undefined
> {
  private CLOSE_CONNECTION_CODE = 3123
  private HEARTBEAT_DELAY = 360_000

  /**
   * Reconnect backoff (Standard Red Notes hardening).
   *
   * Previously `onWebSocketClose` re-dialled immediately with no delay, no cap
   * and no coalescing — when the server was unreachable each failed dial closed
   * instantly and synchronously scheduled the next one, producing a tight
   * reconnect storm that hammered the token endpoint and the socket server.
   *
   * We now use exponential backoff with full jitter and a max cap. The backoff
   * resets to the base delay only once a connection has stayed open long enough
   * to be considered stable (see RECONNECT_STABLE_MS), so a server that accepts
   * the socket and then drops it immediately cannot reset the backoff and keep
   * us in a fast loop.
   */
  private RECONNECT_BASE_MS = 1_000
  private RECONNECT_MAX_MS = 30_000
  /** A connection must stay open this long before its backoff is reset. */
  private RECONNECT_STABLE_MS = 10_000

  private reconnectAttempts = 0
  private reconnectTimeout?: ReturnType<typeof setTimeout>
  private stableConnectionTimeout?: ReturnType<typeof setTimeout>
  /**
   * Guards against concurrent dials (sign-in + close + online all racing). Held
   * true from the start of a dial until the socket actually OPENS or CLOSES — not
   * merely until `new WebSocket()` returns — because during the CONNECTING
   * handshake neither guard (this flag, nor isWebSocketConnectionOpen() which
   * needs OPEN) would otherwise be true, so a second trigger would build a
   * duplicate socket that orphans the first and leaks its heartbeat interval.
   * Cleared on EVERY terminal path (onWebSocketOpen, onWebSocketClose,
   * failed-token, catch) — miss one and the service dead-locks permanently in the
   * "connecting" state, which is worse than the leak.
   */
  private connecting = false

  private webSocket?: WebSocket
  private webSocketHeartbeatInterval?: ReturnType<typeof setInterval>
  private collaborationFrameHandlers = new Set<(frame: CollaborationFrame) => void>()
  private syncSessionRevocationHandlers = new Set<() => void | Promise<void>>()
  private collaborationAuthorizationTransport?: CollaborationRoomAuthorizationTransport
  private collaborationAuthorizationRequests = new Map<string, Promise<CollaborationRoomAuthorization | undefined>>()
  private collaborationAuthorizationCache = new Map<
    string,
    { authorization: CollaborationRoomAuthorization; expiresAt: number }
  >()

  constructor(
    private storageService: StorageServiceInterface,
    private webSocketUrl: string | undefined,
    private webSocketApiService: WebSocketApiServiceInterface,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
  }

  public setWebSocketUrl(url: string | undefined): void {
    this.webSocketUrl = url
    this.storageService.setValue(StorageKey.WebSocketUrl, url)
  }

  /** Current operator-configured gateway URL; never substitutes a first-party host. */
  public getConfiguredWebSocketUrl(): string | undefined {
    return this.webSocketUrl
  }

  public hasConfiguredWebSocketUrl(): boolean {
    return typeof this.webSocketUrl === 'string' && this.webSocketUrl.length > 0
  }

  /** Register the dedicated sync worker for explicit session teardown. */
  public onSyncTransportSessionRevoked(handler: () => void | Promise<void>): () => void {
    this.syncSessionRevocationHandlers.add(handler)
    return () => this.syncSessionRevocationHandlers.delete(handler)
  }

  /** Prefer the authenticated worker socket for room capability minting. */
  public setCollaborationAuthorizationTransport(
    transport: CollaborationRoomAuthorizationTransport | undefined,
  ): () => void {
    this.collaborationAuthorizationTransport = transport
    return () => {
      if (this.collaborationAuthorizationTransport === transport) {
        this.collaborationAuthorizationTransport = undefined
      }
    }
  }

  public async revokeSyncTransportSession(): Promise<void> {
    this.collaborationAuthorizationCache.clear()
    this.collaborationAuthorizationRequests.clear()
    const results = await Promise.allSettled([...this.syncSessionRevocationHandlers].map((handler) => handler()))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) {
      throw failure.reason
    }
  }

  public loadWebSocketUrl(): void {
    const storedValue = this.storageService.getValue<string | undefined>(StorageKey.WebSocketUrl)
    // Read the injected fallback off `globalThis` rather than a bare `window`: `window`
    // is undeclared in non-DOM runtimes (react-native, headless node/mcp) where it errors
    // at type-check and throws ReferenceError at runtime. `globalThis` is always defined
    // (in a browser/WebView `globalThis === window`), so no typeof guard is needed.
    const windowFallbackUrl = (globalThis as { _websocket_url?: string })._websocket_url
    this.webSocketUrl = storedValue || this.webSocketUrl || windowFallbackUrl
  }

  async startWebSocketConnection(): Promise<Result<void>> {
    if (!this.webSocketUrl) {
      return Result.fail('WebSocket URL is not set')
    }

    // Coalesce near-simultaneous triggers (sign-in, a close-driven reconnect, an
    // online/visibility event) into at most one in-flight dial. Any of them that
    // arrive while a dial is pending are folded into the one already running.
    if (this.connecting) {
      return Result.ok()
    }
    if (this.isWebSocketConnectionOpen()) {
      return Result.ok()
    }

    // A manual/explicit start supersedes any scheduled backoff retry.
    this.clearReconnectTimeout()
    this.connecting = true

    try {
      const webSocketConectionToken = await this.createWebSocketConnectionToken()
      if (webSocketConectionToken === undefined) {
        // Treat a failed token fetch like a failed connection: back off instead
        // of letting the caller hammer us with immediate retries. This is a
        // TERMINAL path that never wires up a socket, so nothing downstream would
        // ever clear `connecting` — clear it here or the service dead-locks in a
        // permanent "connecting" state and can never dial again.
        this.connecting = false
        this.scheduleReconnect()
        return Result.fail('Failed to create WebSocket connection token')
      }

      const webSocket = new WebSocket(`${this.webSocketUrl}?authToken=${webSocketConectionToken}`)
      this.webSocket = webSocket
      // Adapt at the assignment seam: react-native's WebSocket event types declare `.data`
      // and `.code` as optional, which isn't assignable to our strict handler params. Coerce
      // here so the internal handlers keep their exact `{ data: string }` / `{ code: number }`
      // contracts and the file compiles under both DOM (web/services) and RN (mobile) libs.
      // Every callback is bound to the exact socket instance that installed it.
      // A closing socket from a prior session can otherwise fire after its
      // replacement has opened and clear the replacement's heartbeat, publish a
      // false disconnect, or inject old-session frames into current consumers.
      webSocket.onmessage = (event) => {
        if (this.webSocket === webSocket) {
          this.onWebSocketMessage({ data: String(event.data ?? '') })
        }
      }
      webSocket.onclose = (event) => {
        if (this.webSocket === webSocket) {
          this.onWebSocketClose({ code: event.code ?? 0 })
        }
      }
      webSocket.onopen = () => {
        if (this.webSocket === webSocket) {
          this.onWebSocketOpen()
        }
      }

      // Deliberately DO NOT clear `connecting` here: the socket is still
      // CONNECTING. It is cleared only once onWebSocketOpen / onWebSocketClose
      // fires, so a concurrent dial during the handshake is coalesced away
      // instead of building a duplicate socket.
      return Result.ok()
    } catch (error) {
      // TERMINAL path: no socket handlers were wired, so nothing will ever clear
      // `connecting` later — clear it here or the service dead-locks.
      this.connecting = false
      this.scheduleReconnect()
      return Result.fail(`Error starting WebSocket connection: ${(error as Error).message}`)
    }
  }

  private onWebSocketOpen(): void {
    // The dial is now resolved (socket OPEN): release the connecting guard so a
    // later dial can proceed. From here isWebSocketConnectionOpen() coalesces
    // duplicate triggers instead.
    this.connecting = false

    // Don't reset the backoff yet: a server that accepts then instantly drops
    // the socket must not be able to reset us into a fast loop. Only reset once
    // the connection has proven stable for RECONNECT_STABLE_MS.
    this.clearStableConnectionTimeout()
    this.stableConnectionTimeout = setTimeout(() => {
      this.reconnectAttempts = 0
    }, this.RECONNECT_STABLE_MS)

    this.beginWebSocketHeartbeat()

    // Notify realtime consumers. The account-sync worker owns its own resume /
    // STATUS flow; this legacy push/collaboration reconnect no longer forces an
    // unconditional full HTTP backfill.
    void this.notifyEvent(WebSocketsServiceEvent.WebSocketDidOpen)
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = undefined
    }
  }

  private clearStableConnectionTimeout(): void {
    if (this.stableConnectionTimeout) {
      clearTimeout(this.stableConnectionTimeout)
      this.stableConnectionTimeout = undefined
    }
  }

  /**
   * Schedule a reconnect using exponential backoff with full jitter, capped at
   * RECONNECT_MAX_MS. Full jitter (random in [0, backoff]) spreads retries so a
   * fleet of clients reconnecting after a server blip doesn't thundering-herd.
   * Coalesced: if a retry is already scheduled, this is a no-op.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return
    }

    const exponential = Math.min(this.RECONNECT_MAX_MS, this.RECONNECT_BASE_MS * 2 ** this.reconnectAttempts)
    const delay = Math.random() * exponential
    this.reconnectAttempts += 1

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined
      void this.startWebSocketConnection()
    }, delay)
  }

  isWebSocketConnectionOpen(): boolean {
    // The right operand `WebSocket.OPEN` is evaluated even when `this.webSocket` is
    // undefined; in a headless runtime lacking a global `WebSocket` that throws. Guard
    // the global so this returns false (not throws) on the auto-sync tick.
    if (typeof WebSocket === 'undefined') {
      return false
    }
    return this.webSocket?.readyState === WebSocket.OPEN
  }

  public closeWebSocketConnection(): void {
    // An explicit close must cancel any pending reconnect so we don't re-dial a
    // socket the app just asked us to tear down (e.g. on sign-out).
    this.clearReconnectTimeout()
    this.clearStableConnectionTimeout()
    this.clearWebSocketHeartbeat()
    this.reconnectAttempts = 0
    this.webSocket?.close(this.CLOSE_CONNECTION_CODE, 'Closing application')
  }

  private beginWebSocketHeartbeat(): void {
    this.clearWebSocketHeartbeat()
    this.webSocketHeartbeatInterval = setInterval(this.websocketHeartbeat.bind(this), this.HEARTBEAT_DELAY)
  }

  private clearWebSocketHeartbeat(): void {
    if (this.webSocketHeartbeatInterval) {
      clearInterval(this.webSocketHeartbeatInterval)
      this.webSocketHeartbeatInterval = undefined
    }
  }

  private websocketHeartbeat(): void {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send('ping')
    }
  }

  /**
   * Send a collaborative-editing relay frame over the live socket. No-ops (drops
   * the frame) if the socket is not open — the yjs room-sync handshake recovers
   * any state missed while disconnected.
   */
  sendCollaborationFrame(frame: CollaborationFrame): void {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(frame))
    }
  }

  /**
   * Standard Red Notes: obtain a short-lived signed capability authorizing this
   * user to join the realtime collaboration room for `noteUuid`. The gateway
   * requires it on `room-join` and rejects joins without a valid one. Returns the
   * capability plus the canonical server revision, or undefined if either is
   * missing/mismatched or the call fails (callers must NOT join without both).
   */
  async authorizeCollaborationRoom(
    noteUuid: string,
    leaseRequestId?: string,
    bootstrapChallenge?: string,
    expectedRoomEpoch?: string,
  ): Promise<CollaborationRoomAuthorization | undefined> {
    if (expectedRoomEpoch !== undefined && !isValidCollaborationEpoch(expectedRoomEpoch)) {
      return undefined
    }
    const key = JSON.stringify([
      noteUuid,
      leaseRequestId ?? null,
      bootstrapChallenge ?? null,
      expectedRoomEpoch ?? null,
    ])
    const cached = this.collaborationAuthorizationCache.get(key)
    if (cached && cached.expiresAt > Date.now() + 5_000) {
      return cached.authorization
    }
    this.collaborationAuthorizationCache.delete(key)
    const inFlight = this.collaborationAuthorizationRequests.get(key)
    if (inFlight) {
      return inFlight
    }

    const request = this.requestCollaborationAuthorization(
      noteUuid,
      leaseRequestId,
      bootstrapChallenge,
      expectedRoomEpoch,
    )
      .then((result) => {
        if (!result) {
          return undefined
        }
        this.collaborationAuthorizationCache.set(key, {
          authorization: result.authorization,
          expiresAt: Date.now() + result.expiresIn * 1_000,
        })
        return result.authorization
      })
      .catch(() => undefined)
      .finally(() => this.collaborationAuthorizationRequests.delete(key))
    this.collaborationAuthorizationRequests.set(key, request)
    return request
  }

  private async requestCollaborationAuthorization(
    noteUuid: string,
    leaseRequestId?: string,
    bootstrapChallenge?: string,
    expectedRoomEpoch?: string,
  ): Promise<{ authorization: CollaborationRoomAuthorization; expiresIn: number } | undefined> {
    if (expectedRoomEpoch !== undefined && !isValidCollaborationEpoch(expectedRoomEpoch)) {
      return undefined
    }
    const socketResult = await this.collaborationAuthorizationTransport?.(
      noteUuid,
      leaseRequestId,
      bootstrapChallenge,
      expectedRoomEpoch,
    )
    if (socketResult === null) {
      return undefined
    }
    const socketAuthorization = normalizeCollaborationAuthorization(
      socketResult,
      noteUuid,
      leaseRequestId,
      bootstrapChallenge,
      expectedRoomEpoch,
    )
    if (socketAuthorization) {
      return socketAuthorization
    }

    let exactRoomEpoch = expectedRoomEpoch
    if (!isValidCollaborationEpoch(exactRoomEpoch)) {
      const discoveryResponse = await this.webSocketApiService.discoverCollaborationRoomEpoch(noteUuid)
      if (isErrorResponse(discoveryResponse)) {
        return undefined
      }
      const discovery = normalizeCollaborationEpochDiscovery(discoveryResponse.data, noteUuid)
      if (!discovery) {
        return undefined
      }
      exactRoomEpoch = discovery.roomEpoch
    }

    const response = await this.webSocketApiService.authorizeCollaboration(
      noteUuid,
      leaseRequestId,
      bootstrapChallenge,
      exactRoomEpoch,
    )
    return isErrorResponse(response)
      ? undefined
      : normalizeCollaborationAuthorization(response.data, noteUuid, leaseRequestId, bootstrapChallenge, exactRoomEpoch)
  }

  async discoverCollaborationRoomEpoch(noteUuid: string): Promise<CollaborationRoomEpochDiscovery | undefined> {
    try {
      const response = await this.webSocketApiService.discoverCollaborationRoomEpoch(noteUuid)
      return isErrorResponse(response) ? undefined : normalizeCollaborationEpochDiscovery(response.data, noteUuid)
    } catch {
      return undefined
    }
  }

  /** Subscribe to inbound collaboration frames. Returns an unsubscribe fn. */
  onCollaborationFrame(handler: (frame: CollaborationFrame) => void): () => void {
    this.collaborationFrameHandlers.add(handler)
    return () => {
      this.collaborationFrameHandlers.delete(handler)
    }
  }

  private onWebSocketMessage(messageEvent: { data: string }) {
    // Defensive: an inbound text frame is not guaranteed to be JSON. The client
    // itself sends a raw `'ping'` heartbeat, and a gateway/proxy that answers a
    // text `pong`/keepalive would otherwise throw an uncaught exception here on
    // every beat. Mirror the "malformed push must not throw" discipline below
    // (and authorizeCollaborationRoom's try/catch): drop the frame and return.
    let eventData
    try {
      eventData = JSON.parse(messageEvent.data)
    } catch {
      return
    }
    if (typeof eventData.t === 'string' && COLLABORATION_FRAME_TYPES.has(eventData.t)) {
      this.collaborationFrameHandlers.forEach((handler) => handler(eventData as CollaborationFrame))
      return
    }
    switch (eventData.type) {
      case 'ITEMS_CHANGED_ON_SERVER':
        void this.notifyEvent(WebSocketsServiceEvent.ItemsChangedOnServer, eventData)
        break
      case 'SYNC_ITEMS_PUSHED':
        // Standard Red Notes (Phase 1A): the server pushed the changed encrypted
        // payloads + tokens. Forward the payload to the sync service, which
        // decides whether to fast-apply (token continuity) or fall back to HTTP.
        // Defensive parsing: a malformed push must not throw — it just won't be
        // applied, and the regular HTTP sync remains the backstop.
        if (
          eventData.payload &&
          Array.isArray(eventData.payload.items) &&
          typeof eventData.payload.syncToken === 'string' &&
          typeof eventData.payload.baseSyncToken === 'string'
        ) {
          void this.notifyEvent(WebSocketsServiceEvent.SyncItemsPushed, {
            items: eventData.payload.items,
            syncToken: eventData.payload.syncToken,
            baseSyncToken: eventData.payload.baseSyncToken,
          })
        } else {
          // Malformed/unknown push shape — degrade to a normal notify-then-pull.
          void this.notifyEvent(WebSocketsServiceEvent.ItemsChangedOnServer, eventData)
        }
        break
      case 'USER_ROLES_CHANGED':
        void this.notifyEvent(WebSocketsServiceEvent.UserRoleMessageReceived, eventData)
        break
      case 'NOTIFICATION_ADDED_FOR_USER':
        void this.notifyEvent(WebSocketsServiceEvent.NotificationAddedForUser, eventData.payload)
        break
      case 'MESSAGE_SENT_TO_USER':
        void this.notifyEvent(WebSocketsServiceEvent.MessageSentToUser, eventData.payload)
        break
      case 'USER_INVITED_TO_SHARED_VAULT':
        void this.notifyEvent(WebSocketsServiceEvent.UserInvitedToSharedVault, eventData.payload)
        break
      case 'MFA_APPROVAL_REQUESTED':
        // Standard Red Notes: push-MFA approval request from a new device.
        void this.notifyEvent(WebSocketsServiceEvent.MfaApprovalRequested, eventData)
        break
      default:
        break
    }
  }

  private onWebSocketClose(event: { code: number }) {
    // The dial is resolved (socket CLOSED) on every code path below: release the
    // connecting guard so the next dial (a reconnect, or an explicit restart) can
    // proceed. Leaving it set here would dead-lock the service permanently.
    this.connecting = false

    this.clearWebSocketHeartbeat()
    // The socket didn't survive: cancel the pending "stable" reset so a flapping
    // server can't reset our backoff.
    this.clearStableConnectionTimeout()
    void this.notifyEvent(WebSocketsServiceEvent.WebSocketDidClose)

    const closedByApplication = event.code === this.CLOSE_CONNECTION_CODE
    if (closedByApplication) {
      this.webSocket = undefined

      return
    }

    if (this.webSocket?.readyState === WebSocket.CLOSED) {
      // Back off instead of re-dialling immediately. This is the fix for the
      // reconnect storm: repeated failures now grow the delay (capped + jittered)
      // rather than busy-looping.
      this.scheduleReconnect()
    }
  }

  private async createWebSocketConnectionToken(): Promise<string | undefined> {
    try {
      const response = await this.webSocketApiService.createConnectionToken()
      if (isErrorResponse(response)) {
        console.error(response.data.error)

        return undefined
      }

      return response.data.token
    } catch (error) {
      console.error('Caught error:', (error as Error).message)

      return undefined
    }
  }

  override deinit(): void {
    super.deinit()
    this.clearReconnectTimeout()
    this.clearStableConnectionTimeout()
    ;(this.storageService as unknown) = undefined
    ;(this.webSocketApiService as unknown) = undefined
    this.closeWebSocketConnection()
    this.syncSessionRevocationHandlers.clear()
    this.collaborationAuthorizationCache.clear()
    this.collaborationAuthorizationRequests.clear()
    this.collaborationAuthorizationTransport = undefined
  }
}

function normalizeCollaborationAuthorization(
  value: unknown,
  noteUuid: string,
  leaseRequestId?: string,
  bootstrapChallenge?: string,
  expectedRoomEpoch?: string,
): { authorization: CollaborationRoomAuthorization; expiresIn: number } | undefined {
  const candidate = value as
    | {
        capability?: unknown
        room?: unknown
        expiresIn?: unknown
        serverUpdatedAtTimestamp?: unknown
        collaborationProtocolVersion?: unknown
        epochDiscovery?: unknown
        roomEpoch?: unknown
        collaborationSecurityEpoch?: unknown
        leaseRequestId?: unknown
        bootstrapChallenge?: unknown
      }
    | undefined
  if (
    typeof candidate?.capability !== 'string' ||
    candidate.capability.length === 0 ||
    candidate.room !== noteUuid ||
    candidate.epochDiscovery !== false ||
    candidate.collaborationProtocolVersion !== 3 ||
    !isValidCollaborationEpoch(candidate.roomEpoch) ||
    (expectedRoomEpoch !== undefined && candidate.roomEpoch !== expectedRoomEpoch) ||
    !isValidCollaborationEpoch(candidate.collaborationSecurityEpoch) ||
    candidate.leaseRequestId !== leaseRequestId ||
    candidate.bootstrapChallenge !== bootstrapChallenge ||
    !Number.isSafeInteger(candidate.serverUpdatedAtTimestamp) ||
    Number(candidate.serverUpdatedAtTimestamp) <= 0 ||
    !Number.isSafeInteger(candidate.expiresIn) ||
    Number(candidate.expiresIn) <= 0
  ) {
    return undefined
  }
  return {
    authorization: {
      capability: candidate.capability,
      serverUpdatedAtTimestamp: Number(candidate.serverUpdatedAtTimestamp),
      collaborationProtocolVersion: 3,
      roomEpoch: candidate.roomEpoch,
      collaborationSecurityEpoch: candidate.collaborationSecurityEpoch,
      ...(leaseRequestId ? { leaseRequestId } : {}),
      ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
    },
    expiresIn: Number(candidate.expiresIn),
  }
}

function normalizeCollaborationEpochDiscovery(
  value: unknown,
  noteUuid: string,
): CollaborationRoomEpochDiscovery | undefined {
  const candidate = value as
    | {
        epochDiscovery?: unknown
        capability?: unknown
        expiresIn?: unknown
        room?: unknown
        roomEpoch?: unknown
        collaborationSecurityEpoch?: unknown
        serverUpdatedAtTimestamp?: unknown
        collaborationProtocolVersion?: unknown
      }
    | undefined
  if (
    candidate?.epochDiscovery !== true ||
    candidate.capability !== undefined ||
    candidate.expiresIn !== undefined ||
    candidate.room !== noteUuid ||
    candidate.collaborationProtocolVersion !== 3 ||
    !isValidCollaborationEpoch(candidate.roomEpoch) ||
    !isValidCollaborationEpoch(candidate.collaborationSecurityEpoch) ||
    !Number.isSafeInteger(candidate.serverUpdatedAtTimestamp) ||
    Number(candidate.serverUpdatedAtTimestamp) <= 0
  ) {
    return undefined
  }
  return {
    room: noteUuid,
    serverUpdatedAtTimestamp: Number(candidate.serverUpdatedAtTimestamp),
    collaborationProtocolVersion: 3,
    roomEpoch: candidate.roomEpoch,
    collaborationSecurityEpoch: candidate.collaborationSecurityEpoch,
  }
}

function isValidCollaborationEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}
