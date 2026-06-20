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
  | { t: 'room-join'; room: string }
  | { t: 'room-leave'; room: string }
  | { t: 'room-sync'; room: string }
  | { t: 'yjs'; room: string; payload: string }
  | { t: 'awareness'; room: string; payload: string }

const COLLABORATION_FRAME_TYPES = new Set(['room-join', 'room-leave', 'room-sync', 'yjs', 'awareness'])

export class WebSocketsService extends AbstractService<WebSocketsServiceEvent, DomainEventInterface> {
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
  private reconnectTimeout?: NodeJS.Timeout
  private stableConnectionTimeout?: NodeJS.Timeout
  /** Guards against concurrent dials (sign-in + close + online all racing). */
  private connecting = false

  private webSocket?: WebSocket
  private webSocketHeartbeatInterval?: NodeJS.Timeout
  private collaborationFrameHandlers = new Set<(frame: CollaborationFrame) => void>()

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

  public loadWebSocketUrl(): void {
    const storedValue = this.storageService.getValue<string | undefined>(StorageKey.WebSocketUrl)
    this.webSocketUrl =
      storedValue ||
      this.webSocketUrl ||
      (
        window as {
          _websocket_url?: string
        }
      )._websocket_url
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
        // of letting the caller hammer us with immediate retries.
        this.scheduleReconnect()
        return Result.fail('Failed to create WebSocket connection token')
      }

      this.webSocket = new WebSocket(`${this.webSocketUrl}?authToken=${webSocketConectionToken}`)
      this.webSocket.onmessage = this.onWebSocketMessage.bind(this)
      this.webSocket.onclose = this.onWebSocketClose.bind(this)
      this.webSocket.onopen = this.onWebSocketOpen.bind(this)

      return Result.ok()
    } catch (error) {
      this.scheduleReconnect()
      return Result.fail(`Error starting WebSocket connection: ${(error as Error).message}`)
    } finally {
      this.connecting = false
    }
  }

  private onWebSocketOpen(): void {
    // Don't reset the backoff yet: a server that accepts then instantly drops
    // the socket must not be able to reset us into a fast loop. Only reset once
    // the connection has proven stable for RECONNECT_STABLE_MS.
    this.clearStableConnectionTimeout()
    this.stableConnectionTimeout = setTimeout(() => {
      this.reconnectAttempts = 0
    }, this.RECONNECT_STABLE_MS)

    this.beginWebSocketHeartbeat()
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
    return this.webSocket?.readyState === WebSocket.OPEN
  }

  public closeWebSocketConnection(): void {
    // An explicit close must cancel any pending reconnect so we don't re-dial a
    // socket the app just asked us to tear down (e.g. on sign-out).
    this.clearReconnectTimeout()
    this.clearStableConnectionTimeout()
    this.reconnectAttempts = 0
    this.webSocket?.close(this.CLOSE_CONNECTION_CODE, 'Closing application')
  }

  private beginWebSocketHeartbeat(): void {
    this.webSocketHeartbeatInterval = setInterval(this.websocketHeartbeat.bind(this), this.HEARTBEAT_DELAY)
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

  /** Subscribe to inbound collaboration frames. Returns an unsubscribe fn. */
  onCollaborationFrame(handler: (frame: CollaborationFrame) => void): () => void {
    this.collaborationFrameHandlers.add(handler)
    return () => {
      this.collaborationFrameHandlers.delete(handler)
    }
  }

  private onWebSocketMessage(messageEvent: MessageEvent) {
    const eventData = JSON.parse(messageEvent.data)
    if (typeof eventData.t === 'string' && COLLABORATION_FRAME_TYPES.has(eventData.t)) {
      this.collaborationFrameHandlers.forEach((handler) => handler(eventData as CollaborationFrame))
      return
    }
    switch (eventData.type) {
      case 'ITEMS_CHANGED_ON_SERVER':
        void this.notifyEvent(WebSocketsServiceEvent.ItemsChangedOnServer, eventData)
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

  private onWebSocketClose(event: CloseEvent) {
    if (this.webSocketHeartbeatInterval) {
      clearInterval(this.webSocketHeartbeatInterval)
    }
    this.webSocketHeartbeatInterval = undefined
    // The socket didn't survive: cancel the pending "stable" reset so a flapping
    // server can't reset our backoff.
    this.clearStableConnectionTimeout()

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
  }
}
