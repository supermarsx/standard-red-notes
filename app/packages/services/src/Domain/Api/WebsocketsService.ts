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
 * Why a `room-denied` frame was sent (contract C1, declared in
 * websocket-gateway/src/rooms.ts and mirrored verbatim here and in
 * web/Components/SuperEditor/Collaboration/CollabChannel.ts). The gateway
 * always sets it; a consumer that meets a frame without one (an older gateway)
 * must treat it as `'policy'`.
 */
export type RoomDeniedReason =
  | 'epoch-mismatch'
  | 'security-revoked'
  | 'rate-limited'
  | 'relay-unhealthy'
  | 'capability-invalid'
  | 'room-full'
  | 'reservation-expired'
  | 'room-limit'
  | 'policy'

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
      // Contract C3: relative ms the gateway keeps this reservation before it
      // expires unactivated. Optional until every gateway sends it.
      activationTtlMs?: number
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
  // Gateway -> client (contract C2): a `yjs-retry` found no other activated
  // editor lease in the room, so no peer will ever answer the state request
  // `requestId`; the requester fails over to bootstrap immediately.
  | { t: 'yjs-no-responder'; room: string; requestId: string }
  | { t: 'awareness'; room: string; payload: string }
  // Gateway -> client: the join was refused. `reason` says why (contract C1);
  // `roomEpoch` is present iff `reason === 'epoch-mismatch'` and carries the
  // room's current epoch so the client can re-enter after a fresh discovery.
  | { t: 'room-denied'; room: string; requestId?: string; roomEpoch?: string; reason: RoomDeniedReason }
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
  'yjs-no-responder',
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
  /** RFC 6455 policy violation: the gateway refused this token, session, path or socket budget. */
  private POLICY_VIOLATION_CLOSE_CODE = 1008
  /** Application code used when this client gives up on a socket that stopped answering pings. */
  private HALF_OPEN_CLOSE_CODE = 4000
  /**
   * Text `ping` cadence while OPEN. The gateway answers a text `ping` with a
   * text `pong`; any inbound frame within PONG_DEADLINE_MS of a ping proves the
   * path is alive. A laptop that slept or a NAT that dropped the mapping leaves
   * the socket OPEN in the browser's eyes while nothing can cross it, and only a
   * write with a deadline can tell (the socket is otherwise "open" forever).
   */
  private HEARTBEAT_DELAY = 60_000
  private PONG_DEADLINE_MS = 120_000

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
   * us in a fast loop. After RECONNECT_LONG_AFTER_ATTEMPTS consecutive failures
   * the cap grows to RECONNECT_LONG_MAX_MS: an outage that has already lasted
   * a minute is not worth a token mint every 30 s per tab.
   */
  private RECONNECT_BASE_MS = 1_000
  private RECONNECT_MAX_MS = 30_000
  private RECONNECT_LONG_AFTER_ATTEMPTS = 6
  private RECONNECT_LONG_MAX_MS = 300_000
  /** A connection must stay open this long before its backoff is reset. */
  private RECONNECT_STABLE_MS = 10_000
  /**
   * Minimum time between re-dials triggered by reconnectIfClosed() (R17
   * residual). Its callers — the app's `online`/`visibilitychange`/focus
   * handlers — live outside this class and can fire in rapid bursts: a
   * flapping network re-raises `online` on every blip, and alt-tabbing raises
   * `visibilitychange` on every switch. Each call cancels the pending backoff
   * and resets reconnectAttempts to 0 before dialling, so without a floor a
   * burst like that defeats the exponential backoff entirely and hammers a
   * refusing gateway exactly as hard as the reconnect storm this class exists
   * to prevent. A single, isolated foreground return still dials immediately:
   * only a re-trigger within this window of the last one is suppressed.
   */
  private RECONNECT_IF_CLOSED_MIN_INTERVAL_MS = 5_000

  private reconnectAttempts = 0
  private lastReconnectIfClosedDialAt = 0
  private reconnectTimeout?: ReturnType<typeof setTimeout>
  private stableConnectionTimeout?: ReturnType<typeof setTimeout>
  private pongDeadlineTimeout?: ReturnType<typeof setTimeout>
  /**
   * Bumped by every dial and by closeWebSocketConnection(). A dial whose token
   * mint resolves after the generation moved on was superseded (the app closed
   * the connection, or a newer dial took over) and must not build a socket with
   * a token minted under a session that may be gone.
   */
  private dialGeneration = 0
  /**
   * True from the first explicit start until closeWebSocketConnection(). Only a
   * requested connection is re-dialled by reconnectIfClosed(): an offline
   * workspace or a signed-out app must not mint tokens on every focus.
   */
  private connectionRequested = false
  /**
   * Set by closeWebSocketConnection() before the socket is closed so a close
   * event that echoes an unexpected code (a CONNECTING socket closes with 1006,
   * not the requested 3123) is never mistaken for a server-side drop.
   */
  private closedByApplication = false
  /** One console.error per outage; reset when a socket opens or the app closes the connection. */
  private reportedDialFailure = false
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

  /**
   * The gateway URL implied by an API host: `http(s)://host[:port]` (an optional
   * trailing slash is fine) becomes `ws(s)://host[:port]/sockets`, the same
   * same-origin rule the web build applies in its index.html. Anything else —
   * another scheme, a sub-path, a query, credentials — yields undefined so a
   * deployment we cannot reason about keeps dialling nothing rather than the
   * wrong thing. A regex rather than `URL` so it behaves identically in every
   * runtime that loads this package (browser, WebView, headless node).
   */
  public static deriveWebSocketUrl(apiHost: string | undefined): string | undefined {
    if (typeof apiHost !== 'string') {
      return undefined
    }
    const match = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?\/?$/i.exec(apiHost.trim())
    if (!match) {
      return undefined
    }
    const [, scheme, host, port = ''] = match
    return `${scheme.toLowerCase() === 'https' ? 'wss' : 'ws'}://${host}${port}/sockets`
  }

  /**
   * Store an explicit gateway URL, or — when the caller has none — the one
   * derived from `apiHost`. A custom server picked in the UI therefore keeps a
   * socket instead of silently dropping it for the session (R20).
   */
  public setWebSocketUrl(url: string | undefined, apiHost?: string): void {
    const nextUrl = url || WebSocketsService.deriveWebSocketUrl(apiHost)
    this.webSocketUrl = nextUrl
    this.storageService.setValue(StorageKey.WebSocketUrl, nextUrl)
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

  /**
   * Resolve the gateway URL for this launch: a URL stored by the picker wins,
   * then the one the host page injected at start-up, then the legacy
   * `globalThis._websocket_url` hook, and finally the URL derived from the API
   * host. Desktop, mobile and the clipper inject nothing, so the derivation is
   * what gives them a socket at all (B4).
   */
  public loadWebSocketUrl(apiHost?: string): void {
    const storedValue = this.storageService.getValue<string | undefined>(StorageKey.WebSocketUrl)
    // Read the injected fallback off `globalThis` rather than a bare `window`: `window`
    // is undeclared in non-DOM runtimes (react-native, headless node/mcp) where it errors
    // at type-check and throws ReferenceError at runtime. `globalThis` is always defined
    // (in a browser/WebView `globalThis === window`), so no typeof guard is needed.
    const windowFallbackUrl = (globalThis as { _websocket_url?: string })._websocket_url
    this.webSocketUrl =
      storedValue || this.webSocketUrl || windowFallbackUrl || WebSocketsService.deriveWebSocketUrl(apiHost)
  }

  /**
   * Contract C11: dial again after the app came back online or to the
   * foreground. No-op without a URL, while a dial is in flight, while the
   * socket is OPEN, and — so an offline workspace or a signed-out app never
   * mints tokens on focus — until the app has asked for a connection since
   * the last closeWebSocketConnection(). Otherwise any pending backoff is
   * cancelled, the attempt counter reset and a dial started now: a socket
   * that gave up (1008, a 503 mint) gets one fresh try per foreground event.
   *
   * Also throttled to at most one such reset-and-redial per
   * RECONNECT_IF_CLOSED_MIN_INTERVAL_MS (R17 residual): a burst of calls from
   * a flapping `online`/`visibilitychange`/focus source is coalesced into the
   * first one, so it cannot repeatedly zero the backoff and hammer a refusing
   * gateway. A re-trigger inside the window is a silent no-op — it does not
   * touch the pending backoff timer or the attempt counter — so a real
   * scheduled retry underneath it is unaffected.
   */
  public reconnectIfClosed(): void {
    if (!this.webSocketUrl || !this.connectionRequested || this.connecting || this.isWebSocketConnectionOpen()) {
      return
    }
    const now = Date.now()
    if (now - this.lastReconnectIfClosedDialAt < this.RECONNECT_IF_CLOSED_MIN_INTERVAL_MS) {
      return
    }
    this.lastReconnectIfClosedDialAt = now
    this.clearReconnectTimeout()
    this.reconnectAttempts = 0
    void this.startWebSocketConnection()
  }

  /**
   * Standard Red Notes (t99): revive a lane that was ABANDONED rather than one
   * that is backing off.
   *
   * A TERMINAL mint failure (503 "no gateway attached", 403) routes to
   * stopUntilNextSignInOrForeground(), which clears the retry timer and the
   * attempt counter and schedules NOTHING. Recovery then depends entirely on an
   * `online`/`focus`/`visibilitychange` event reaching reconnectIfClosed() — so a
   * tab that keeps focus and stays online never recovers. A deploy is a few
   * seconds of 503 from the mint route, and any tab open across one latches this
   * way; the user then pays a 30 s HTTP sync instead of a 5 min one and loses
   * pushes, invites, MFA approvals and collaboration, silently and indefinitely.
   *
   * This is deliberately NOT reconnectIfClosed(): that resets `reconnectAttempts`
   * to 0 and cancels the pending timer, and its 5 s throttle only coalesces a
   * BURST. A caller on a 30 s cadence is always outside that window, so it would
   * zero the backoff on every tick and the long cap could never be reached —
   * reintroducing exactly the "token mint every 30 s per tab" that
   * RECONNECT_LONG_AFTER_ATTEMPTS / RECONNECT_LONG_MAX_MS exist to escape.
   *
   * So: if a retry is already scheduled, the retryable path owns recovery and
   * this is a no-op. Only the abandoned state — closed, with nothing pending —
   * gets a dial, and that dial still passes every reconnectIfClosed() guard
   * (URL, connectionRequested, not connecting, not OPEN) and its throttle.
   */
  public reconnectIfAbandoned(): void {
    if (this.reconnectTimeout) {
      return
    }
    this.reconnectIfClosed()
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
    this.connectionRequested = true
    this.closedByApplication = false
    this.connecting = true
    const generation = ++this.dialGeneration

    try {
      const mint = await this.createWebSocketConnectionToken()
      if (generation !== this.dialGeneration) {
        // closeWebSocketConnection() (or a newer dial) superseded this one while
        // the token was minting; that path owns `connecting` now and a socket
        // must not be built with a token from a session that may be gone.
        return Result.fail('WebSocket dial superseded')
      }
      if ('failure' in mint) {
        // This is a TERMINAL path that never wires up a socket, so nothing
        // downstream would ever clear `connecting` — clear it here or the
        // service dead-locks in a permanent "connecting" state.
        this.connecting = false
        if (mint.failure === 'retryable') {
          // Treat a failed token fetch like a failed connection: back off instead
          // of letting the caller hammer us with immediate retries.
          this.scheduleReconnect()
        } else {
          // The server said no in a way that will not change on its own (no
          // gateway attached, this session may not hold a socket). Stop until
          // the next sign-in or foreground event instead of minting forever.
          this.stopUntilNextSignInOrForeground()
        }
        return Result.fail('Failed to create WebSocket connection token')
      }

      const webSocket = new WebSocket(`${this.webSocketUrl}?authToken=${mint.token}`)
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
      if (generation !== this.dialGeneration) {
        return Result.fail('WebSocket dial superseded')
      }
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
    this.reportedDialFailure = false

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

    const cap =
      this.reconnectAttempts >= this.RECONNECT_LONG_AFTER_ATTEMPTS ? this.RECONNECT_LONG_MAX_MS : this.RECONNECT_MAX_MS
    const exponential = Math.min(cap, this.RECONNECT_BASE_MS * 2 ** this.reconnectAttempts)
    const delay = Math.random() * exponential
    this.reconnectAttempts += 1

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined
      void this.startWebSocketConnection()
    }, delay)
  }

  /**
   * The gateway refused us for a reason that will not change until the user
   * signs in again or the app returns to the foreground (a 1008 policy close,
   * a 503 "no gateway" or 403 mint). Drop the backoff loop entirely; the next
   * setSession() or reconnectIfClosed() dials again from attempt 0 (R17).
   */
  private stopUntilNextSignInOrForeground(): void {
    this.clearReconnectTimeout()
    this.reconnectAttempts = 0
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
    // socket the app just asked us to tear down (e.g. on sign-out), and must
    // abandon a dial that is still minting its token.
    this.dialGeneration += 1
    this.connecting = false
    this.connectionRequested = false
    this.closedByApplication = true
    this.reportedDialFailure = false
    this.clearReconnectTimeout()
    this.clearStableConnectionTimeout()
    this.clearWebSocketHeartbeat()
    this.reconnectAttempts = 0

    // Detach BEFORE closing (R18): a CONNECTING socket's close() fails the
    // handshake and reports 1006, not the 3123 we asked for, and an OPEN socket
    // on a dead path never gets its close echoed at all. With `this.webSocket`
    // cleared first, the identity guard on the handlers drops that late close
    // instead of treating it as a server drop and re-arming the backoff loop.
    const webSocket = this.webSocket
    this.webSocket = undefined
    if (!webSocket) {
      return
    }
    const wasLive = typeof WebSocket !== 'undefined' && webSocket.readyState !== WebSocket.CLOSED
    try {
      webSocket.close(this.CLOSE_CONNECTION_CODE, 'Closing application')
    } catch {
      /* already closing; nothing more to do */
    }
    if (wasLive) {
      // The detached handler would have published this; keep the contract for
      // the consumers that fail closed on it (encrypted rooms).
      void this.notifyEvent(WebSocketsServiceEvent.WebSocketDidClose)
    }
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
    this.clearPongDeadline()
  }

  private clearPongDeadline(): void {
    if (this.pongDeadlineTimeout) {
      clearTimeout(this.pongDeadlineTimeout)
      this.pongDeadlineTimeout = undefined
    }
  }

  private websocketHeartbeat(): void {
    if (this.webSocket?.readyState !== WebSocket.OPEN) {
      return
    }
    this.webSocket.send('ping')
    // One deadline per silence, not per ping: it is cleared by the first
    // inbound frame of any kind and re-armed by the next ping after that.
    if (!this.pongDeadlineTimeout) {
      this.pongDeadlineTimeout = setTimeout(() => {
        this.pongDeadlineTimeout = undefined
        this.handleUnresponsiveSocket()
      }, this.PONG_DEADLINE_MS)
    }
  }

  /**
   * Half-open detection (D3): nothing came back within PONG_DEADLINE_MS of a
   * ping. The browser still reports the socket OPEN, so isWebSocketConnectionOpen()
   * would keep suppressing the sync poll and no reconnect would ever run. Give
   * the socket up ourselves: detach it (its eventual 1006 may take minutes and
   * is dropped by the identity guard), tell consumers, and re-dial.
   */
  private handleUnresponsiveSocket(): void {
    const webSocket = this.webSocket
    if (!webSocket) {
      return
    }
    this.webSocket = undefined
    this.clearWebSocketHeartbeat()
    this.clearStableConnectionTimeout()
    try {
      webSocket.close(this.HALF_OPEN_CLOSE_CODE, 'No pong within the deadline')
    } catch {
      /* the path is dead; the close frame goes nowhere either way */
    }
    void this.notifyEvent(WebSocketsServiceEvent.WebSocketDidClose)
    this.scheduleReconnect()
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
    // Any inbound frame — including the text `pong` the parse below rejects —
    // proves the path is alive, so the half-open deadline is cleared first.
    this.clearPongDeadline()
    let eventData
    try {
      eventData = JSON.parse(messageEvent.data)
    } catch {
      return
    }
    // A JSON `null`, number, string or boolean parses fine but has no fields;
    // reading `.t` off null would throw outside the try above (N11).
    if (eventData === null || typeof eventData !== 'object') {
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
    this.webSocket = undefined
    void this.notifyEvent(WebSocketsServiceEvent.WebSocketDidClose)

    // closeWebSocketConnection() detaches the socket before closing it, so this
    // handler normally never sees an application close; the flag and the echoed
    // code are kept as belt and braces for a runtime that fires synchronously.
    if (this.closedByApplication || event.code === this.CLOSE_CONNECTION_CODE) {
      return
    }

    if (event.code === this.POLICY_VIOLATION_CLOSE_CODE) {
      // The gateway refused this socket outright (bad token, revoked session,
      // wrong path, per-user budget). Dialling again every 30 s changes nothing
      // and costs a token mint per attempt per tab (R17).
      this.stopUntilNextSignInOrForeground()
      return
    }

    // Back off instead of re-dialling immediately. This is the fix for the
    // reconnect storm: repeated failures now grow the delay (capped + jittered)
    // rather than busy-looping.
    this.scheduleReconnect()
  }

  /**
   * Mint the short-lived token the gateway requires on the upgrade. A 503 (no
   * gateway attached to this deployment) or 403 (this session may not hold a
   * socket) is `terminal`: nothing this client does will change it, so the
   * caller stops instead of backing off. Everything else — a 5xx, a network
   * error, a thrown request — is `retryable`.
   */
  private async createWebSocketConnectionToken(): Promise<{ token: string } | { failure: 'terminal' | 'retryable' }> {
    try {
      const response = await this.webSocketApiService.createConnectionToken()
      if (isErrorResponse(response)) {
        this.reportDialFailure(response.data.error)
        const terminal = response.status === 503 || response.status === 403
        return { failure: terminal ? 'terminal' : 'retryable' }
      }
      const token = response.data.token
      if (typeof token !== 'string' || token.length === 0) {
        this.reportDialFailure('The connection token response carried no token.')
        return { failure: 'retryable' }
      }

      return { token }
    } catch (error) {
      this.reportDialFailure((error as Error).message)

      return { failure: 'retryable' }
    }
  }

  /** Log the first failure of an outage only; the backoff already tells the rest. */
  private reportDialFailure(detail: unknown): void {
    if (this.reportedDialFailure) {
      return
    }
    this.reportedDialFailure = true
    console.error('Could not open the realtime websocket; retrying in the background.', detail)
  }

  override deinit(): void {
    // Close BEFORE the dependencies are nulled (R18): the close used to run
    // last, so a socket still CONNECTING (or one whose peer never echoed the
    // close) reported 1006 later, the reconnect timer re-armed, and every tick
    // minted through an undefined api service — a zombie loop logging
    // "Caught error:" for the life of the page.
    this.closeWebSocketConnection()
    super.deinit()
    ;(this.storageService as unknown) = undefined
    ;(this.webSocketApiService as unknown) = undefined
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
