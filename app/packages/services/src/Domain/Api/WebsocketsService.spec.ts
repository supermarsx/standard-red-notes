import { WebSocketApiServiceInterface } from '@standardnotes/api'

import { WebSocketsService } from './WebsocketsService'
import { WebSocketsServiceEvent } from './WebSocketsServiceEvent'
import { StorageServiceInterface } from '../Storage/StorageServiceInterface'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { StorageKey } from '../Storage/StorageKeys'

describe('webSocketsService', () => {
  const webSocketUrl = ''

  let storageService: StorageServiceInterface
  let webSocketApiService: WebSocketApiServiceInterface
  let internalEventBus: InternalEventBusInterface
  let services: WebSocketsService[]

  const createService = () => {
    const service = new WebSocketsService(storageService, webSocketUrl, webSocketApiService, internalEventBus)
    services.push(service)
    return service
  }

  beforeEach(() => {
    services = []
    storageService = {} as jest.Mocked<StorageServiceInterface>
    storageService.setValue = jest.fn()

    internalEventBus = {} as jest.Mocked<InternalEventBusInterface>
    internalEventBus.publish = jest.fn()

    webSocketApiService = {} as jest.Mocked<WebSocketApiServiceInterface>
    webSocketApiService.createConnectionToken = jest.fn().mockReturnValue({ token: 'foobar' })
  })

  afterEach(() => {
    services.forEach((service) => service.deinit())
  })

  describe('setWebSocketUrl()', () => {
    it('saves url in local storage', () => {
      const webSocketUrl = 'wss://test-websocket'
      createService().setWebSocketUrl(webSocketUrl)
      expect(storageService.setValue).toHaveBeenCalledWith(StorageKey.WebSocketUrl, webSocketUrl)
    })

    it('exposes only the configured URL and awaits the dedicated transport session-revocation barrier', async () => {
      const service = createService()
      const revoke = jest.fn().mockResolvedValue(undefined)
      const unregister = service.onSyncTransportSessionRevoked(revoke)
      service.setWebSocketUrl('wss://self-hosted.example.test')

      expect(service.hasConfiguredWebSocketUrl()).toBe(true)
      expect(service.getConfiguredWebSocketUrl()).toBe('wss://self-hosted.example.test')

      service.closeWebSocketConnection()
      expect(revoke).not.toHaveBeenCalled()

      await service.revokeSyncTransportSession()
      expect(revoke).toHaveBeenCalledTimes(1)

      unregister()
      await service.revokeSyncTransportSession()
      expect(revoke).toHaveBeenCalledTimes(1)
    })
  })

  describe('authorizeCollaborationRoom()', () => {
    it('returns only a capability bound to the requested room and canonical server revision', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn().mockResolvedValue({
        status: 200,
        data: {
          capability: 'capability-1',
          room: 'note-1',
          expiresIn: 300,
          serverUpdatedAtTimestamp: 1_723_456_789_000_000,
          collaborationProtocolVersion: 2,
        },
      })

      await expect(createService().authorizeCollaborationRoom('note-1')).resolves.toEqual({
        capability: 'capability-1',
        serverUpdatedAtTimestamp: 1_723_456_789_000_000,
        collaborationProtocolVersion: 2,
      })
    })

    it.each([
      [
        'wrong room',
        { capability: 'cap', room: 'note-2', collaborationProtocolVersion: 2, serverUpdatedAtTimestamp: 123 },
      ],
      ['missing revision', { capability: 'cap', room: 'note-1', collaborationProtocolVersion: 2 }],
      [
        'unsafe revision',
        {
          capability: 'cap',
          room: 'note-1',
          collaborationProtocolVersion: 2,
          serverUpdatedAtTimestamp: Number.MAX_VALUE,
        },
      ],
      [
        'legacy protocol',
        { capability: 'cap', room: 'note-1', collaborationProtocolVersion: 1, serverUpdatedAtTimestamp: 123 },
      ],
    ])('fails closed for %s', async (_case, data) => {
      webSocketApiService.authorizeCollaboration = jest.fn().mockResolvedValue({ status: 200, data })
      await expect(createService().authorizeCollaborationRoom('note-1')).resolves.toBeUndefined()
    })

    it('requires exact lease and bootstrap-challenge echoes', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn().mockResolvedValue({
        status: 200,
        data: {
          capability: 'capability-1',
          room: 'note-1',
          expiresIn: 300,
          serverUpdatedAtTimestamp: 123,
          collaborationProtocolVersion: 2,
          leaseRequestId: 'lease-1',
          bootstrapChallenge: 'different-challenge',
        },
      })

      await expect(
        createService().authorizeCollaborationRoom('note-1', 'lease-1', 'challenge-1'),
      ).resolves.toBeUndefined()
      expect(webSocketApiService.authorizeCollaboration).toHaveBeenCalledWith('note-1', 'lease-1', 'challenge-1')
    })
  })

  describe('SYNC_ITEMS_PUSHED message (Phase 1A)', () => {
    const emitMessage = (service: WebSocketsService, data: unknown): WebSocketsServiceEvent[] => {
      const events: WebSocketsServiceEvent[] = []
      const captured: Record<string, unknown> = {}
      service.addEventObserver((event, payload) => {
        events.push(event)
        captured[event as string] = payload
        return Promise.resolve()
      })
      ;(service as unknown as { onWebSocketMessage: (e: MessageEvent) => void }).onWebSocketMessage({
        data: JSON.stringify(data),
      } as MessageEvent)
      ;(service as unknown as { lastCaptured: Record<string, unknown> }).lastCaptured = captured
      return events
    }

    it('emits SyncItemsPushed with the encrypted payloads and tokens for a well-formed push', () => {
      const service = createService()
      const events = emitMessage(service, {
        type: 'SYNC_ITEMS_PUSHED',
        payload: {
          items: [{ uuid: 'a', content: 'enc' }],
          syncToken: 'new-token',
          baseSyncToken: 'base-token',
        },
      })

      expect(events).toContain(WebSocketsServiceEvent.SyncItemsPushed)
      const captured = (service as unknown as { lastCaptured: Record<string, unknown> }).lastCaptured
      expect(captured[WebSocketsServiceEvent.SyncItemsPushed]).toEqual({
        items: [{ uuid: 'a', content: 'enc' }],
        syncToken: 'new-token',
        baseSyncToken: 'base-token',
      })
    })

    it('degrades a malformed push to the plain ItemsChangedOnServer notification', () => {
      const service = createService()
      const events = emitMessage(service, {
        type: 'SYNC_ITEMS_PUSHED',
        payload: { items: 'not-an-array', syncToken: 'x' },
      })

      expect(events).toContain(WebSocketsServiceEvent.ItemsChangedOnServer)
      expect(events).not.toContain(WebSocketsServiceEvent.SyncItemsPushed)
    })

    it('emits WebSocketDidOpen on connection open for reconnect backfill', () => {
      const service = createService()
      const events: WebSocketsServiceEvent[] = []
      service.addEventObserver((event) => {
        events.push(event)
        return Promise.resolve()
      })
      ;(service as unknown as { onWebSocketOpen: () => void }).onWebSocketOpen()

      expect(events).toContain(WebSocketsServiceEvent.WebSocketDidOpen)
    })

    it('emits WebSocketDidClose so encrypted room consumers fail closed immediately', () => {
      const service = createService()
      const events: WebSocketsServiceEvent[] = []
      service.addEventObserver((event) => {
        events.push(event)
        return Promise.resolve()
      })
      const closeCode = (service as unknown as { CLOSE_CONNECTION_CODE: number }).CLOSE_CONNECTION_CODE
      ;(service as unknown as { onWebSocketClose: (event: { code: number }) => void }).onWebSocketClose({
        code: closeCode,
      })

      expect(events).toContain(WebSocketsServiceEvent.WebSocketDidClose)
    })
  })

  describe('malformed inbound frame (unguarded JSON.parse)', () => {
    // Pump a RAW non-JSON text frame straight through the message handler (not
    // via JSON.stringify) — modelling a proxy/gateway that answers the client's
    // raw `'ping'` heartbeat with a plain text `pong`/keepalive.
    const pumpRaw = (
      service: WebSocketsService,
      raw: string,
    ): { events: WebSocketsServiceEvent[]; run: () => void } => {
      const events: WebSocketsServiceEvent[] = []
      service.addEventObserver((event) => {
        events.push(event)
        return Promise.resolve()
      })
      const run = () =>
        (service as unknown as { onWebSocketMessage: (e: { data: string }) => void }).onWebSocketMessage({
          data: raw,
        })
      return { events, run }
    }

    it('does not throw and emits no event for a non-JSON text frame', () => {
      const service = createService()
      // FALSE-GREEN: without the try/catch guard, JSON.parse('pong') throws an
      // uncaught SyntaxError inside the onmessage handler → this call throws → RED.
      const { events, run } = pumpRaw(service, 'pong')

      expect(run).not.toThrow()
      expect(events).toHaveLength(0)
    })

    it('does not throw for an empty text frame', () => {
      const service = createService()
      const { events, run } = pumpRaw(service, '')

      expect(run).not.toThrow()
      expect(events).toHaveLength(0)
    })

    it('still processes a well-formed frame after the guard (no behaviour change for valid JSON)', () => {
      const service = createService()
      const { events, run } = pumpRaw(service, JSON.stringify({ type: 'ITEMS_CHANGED_ON_SERVER' }))

      expect(run).not.toThrow()
      expect(events).toContain(WebSocketsServiceEvent.ItemsChangedOnServer)
    })

    it('dispatches the gateway response-claim grant to collaboration subscribers', () => {
      const service = createService()
      const handler = jest.fn()
      service.onCollaborationFrame(handler)
      const frame = {
        t: 'yjs-response-granted',
        room: 'note-1',
        stateRequestId: 'state-request-1',
        leaseRequestId: 'lease-1',
        protocolVersion: 2,
      }
      const { run } = pumpRaw(service, JSON.stringify(frame))

      expect(run).not.toThrow()
      expect(handler).toHaveBeenCalledWith(frame)
    })
  })

  describe('connecting guard (concurrent-dial timing)', () => {
    // A fake WebSocket that records every construction and only transitions to
    // OPEN / CLOSED when the test explicitly drives it — modelling the real
    // CONNECTING handshake window during which the bug fired.
    class FakeWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      static instances: FakeWebSocket[] = []

      readyState: number = FakeWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onclose: ((event: { code?: number }) => void) | null = null
      onmessage: ((event: { data: unknown }) => void) | null = null
      sent: string[] = []

      constructor(public url: string) {
        FakeWebSocket.instances.push(this)
      }

      send(data: string): void {
        this.sent.push(data)
      }

      close(code?: number): void {
        this.readyState = FakeWebSocket.CLOSED
        this.onclose?.({ code })
      }

      // Test drivers for the terminal transitions.
      fireOpen(): void {
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.()
      }
      fireClose(code: number): void {
        this.readyState = FakeWebSocket.CLOSED
        this.onclose?.({ code })
      }
      fireMessage(data: unknown): void {
        this.onmessage?.({ data })
      }
    }

    const DIAL_URL = 'wss://test-websocket'
    let originalWebSocket: unknown

    const createDialService = () => {
      const service = new WebSocketsService(storageService, DIAL_URL, webSocketApiService, internalEventBus)
      services.push(service)
      return service
    }

    beforeEach(() => {
      FakeWebSocket.instances = []
      originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
      ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
      // A well-formed token response (createWebSocketConnectionToken reads
      // response.data.token) so the dial reaches `new WebSocket(...)`.
      webSocketApiService.createConnectionToken = jest.fn().mockResolvedValue({ data: { token: 'tok' } })
      // Keep reconnect backoff timers inert so a scheduled retry can't race the
      // assertions or spawn a second real dial.
      jest.spyOn(global, 'setTimeout').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>)
    })

    afterEach(() => {
      ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
      jest.restoreAllMocks()
    })

    it('coalesces a concurrent dial while the first socket is still CONNECTING (exactly one socket + one heartbeat arm)', async () => {
      const setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>)

      const service = createDialService()

      // First dial completes construction; the socket is created but has NOT yet
      // opened (still CONNECTING) — exactly the window the old `finally`-clear
      // exposed. A second dial arrives before any open.
      await service.startWebSocketConnection()
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CONNECTING)

      await service.startWebSocketConnection()

      // FALSE-GREEN: pre-fix (`connecting` cleared in `finally`) the second dial
      // sees connecting=false and !OPEN → builds a SECOND socket (length 2).
      expect(FakeWebSocket.instances).toHaveLength(1)

      // Drive every constructed socket to OPEN. Post-fix there is one → one
      // heartbeat arm. Pre-fix there were two → beginWebSocketHeartbeat runs
      // twice (orphaning the first socket + re-arming the interval).
      FakeWebSocket.instances.forEach((ws) => ws.fireOpen())
      expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    })

    it('clears connecting on the failed-token terminal path so a later dial is not dead-locked', async () => {
      const service = createDialService()

      // Force the token fetch to fail → the failed-token terminal path runs.
      webSocketApiService.createConnectionToken = jest.fn().mockRejectedValueOnce(new Error('token fetch failed'))
      const first = await service.startWebSocketConnection()
      expect(first.isFailed()).toBe(true)
      expect(FakeWebSocket.instances).toHaveLength(0)

      // With the token now succeeding, a fresh dial MUST proceed and build a
      // socket. If `connecting` were left set on the failed path the service would
      // be permanently stuck: the guard would short-circuit to Result.ok() and
      // construct nothing. (Removing `this.connecting = false` from that path
      // turns this assertion red — the false-green proof for the terminal clear.)
      webSocketApiService.createConnectionToken = jest.fn().mockResolvedValue({ data: { token: 'tok' } })
      const second = await service.startWebSocketConnection()
      expect(second.isFailed()).toBe(false)
      expect(FakeWebSocket.instances).toHaveLength(1)
    })

    it('clears connecting on close so a reconnect dial can proceed (no dead-lock after a drop)', async () => {
      const service = createDialService()

      await service.startWebSocketConnection()
      expect(FakeWebSocket.instances).toHaveLength(1)

      // Socket drops before ever opening (non-application close code).
      FakeWebSocket.instances[0].fireClose(1006)

      // A subsequent dial must be able to build a fresh socket.
      const again = await service.startWebSocketConnection()
      expect(again.isFailed()).toBe(false)
      expect(FakeWebSocket.instances).toHaveLength(2)
    })

    it('ignores stale message, open, and close callbacks after a replacement socket becomes current', async () => {
      const setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockReturnValue(11 as unknown as ReturnType<typeof setInterval>)
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined)
      const service = createDialService()
      const collaborationHandler = jest.fn()
      service.onCollaborationFrame(collaborationHandler)

      await service.startWebSocketConnection()
      const staleSocket = FakeWebSocket.instances[0]
      staleSocket.fireOpen()
      expect(setIntervalSpy).toHaveBeenCalledTimes(1)

      // Model close/restart overlap: A is closing, so a manual start is allowed
      // to install B before A's delayed close callback arrives.
      staleSocket.readyState = FakeWebSocket.CLOSING
      await service.startWebSocketConnection()
      const currentSocket = FakeWebSocket.instances[1]
      currentSocket.fireOpen()
      expect(setIntervalSpy).toHaveBeenCalledTimes(2)

      collaborationHandler.mockClear()
      clearIntervalSpy.mockClear()
      staleSocket.fireMessage(JSON.stringify({ t: 'room-sync', room: 'old-session-note' }))
      staleSocket.fireOpen()
      staleSocket.fireClose(1006)

      expect(collaborationHandler).not.toHaveBeenCalled()
      expect(setIntervalSpy).toHaveBeenCalledTimes(2)
      expect(clearIntervalSpy).not.toHaveBeenCalled()
      expect(service.isWebSocketConnectionOpen()).toBe(true)
    })
  })
})
