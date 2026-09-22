import { WebSocketApiServiceInterface } from '@standardnotes/api'

import { WebSocketsService } from './WebsocketsService'
import { WebSocketsServiceEvent } from './WebSocketsServiceEvent'
import { StorageServiceInterface } from '../Storage/StorageServiceInterface'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { StorageKey } from '../Storage/StorageKeys'

describe('webSocketsService', () => {
  const webSocketUrl = ''
  const roomEpoch = 'room_epoch_0000000000000001'
  const securityEpoch = 'security_epoch_0000000000000001'
  const validGrant = {
    epochDiscovery: false as const,
    capability: 'capability-1',
    room: 'note-1',
    expiresIn: 300,
    serverUpdatedAtTimestamp: 123,
    collaborationProtocolVersion: 3 as const,
    roomEpoch,
    collaborationSecurityEpoch: securityEpoch,
  }

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
          ...validGrant,
          serverUpdatedAtTimestamp: 1_723_456_789_000_000,
        },
      })

      await expect(
        createService().authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch),
      ).resolves.toEqual({
        capability: 'capability-1',
        serverUpdatedAtTimestamp: 1_723_456_789_000_000,
        collaborationProtocolVersion: 3,
        roomEpoch,
        collaborationSecurityEpoch: securityEpoch,
      })
    })

    it.each([
      ['wrong room', { room: 'note-2' }],
      ['missing revision', { serverUpdatedAtTimestamp: undefined }],
      ['unsafe revision', { serverUpdatedAtTimestamp: Number.MAX_VALUE }],
      ['legacy protocol', { collaborationProtocolVersion: 2 }],
      ['discovery response', { epochDiscovery: true, capability: undefined, expiresIn: undefined }],
      ['wrong room epoch', { roomEpoch: 'room_epoch_0000000000000002' }],
      ['missing security epoch', { collaborationSecurityEpoch: undefined }],
    ])('fails closed for %s', async (_case, override) => {
      webSocketApiService.authorizeCollaboration = jest
        .fn()
        .mockResolvedValue({ status: 200, data: { ...validGrant, ...override } })
      await expect(
        createService().authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch),
      ).resolves.toBeUndefined()
    })

    it('requires exact lease and bootstrap-challenge echoes', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn().mockResolvedValue({
        status: 200,
        data: {
          ...validGrant,
          leaseRequestId: 'lease-1',
          bootstrapChallenge: 'different-challenge',
        },
      })

      await expect(
        createService().authorizeCollaborationRoom('note-1', 'lease-1', 'challenge-1', roomEpoch),
      ).resolves.toBeUndefined()
      expect(webSocketApiService.authorizeCollaboration).toHaveBeenCalledWith(
        'note-1',
        'lease-1',
        'challenge-1',
        roomEpoch,
      )
    })

    it('coalesces and caches valid socket authorizations without issuing an HTTP request', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn()
      const socketAuthorize = jest.fn().mockResolvedValue({
        ...validGrant,
        capability: 'socket-capability',
      })
      const service = createService()
      service.setCollaborationAuthorizationTransport(socketAuthorize)

      const [first, second] = await Promise.all([
        service.authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch),
        service.authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch),
      ])
      const cached = await service.authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch)

      expect(first).toEqual(second)
      expect(cached).toEqual(first)
      expect(socketAuthorize).toHaveBeenCalledTimes(1)
      expect(webSocketApiService.authorizeCollaboration).not.toHaveBeenCalled()
    })

    // The socket transport used to be invoked with three arguments, dropping the
    // caller's epoch pin. That left the worker's pre-grant abort -- it denies during
    // epoch discovery when the room has rotated -- unreachable from production, so a
    // rotated room was only caught afterwards by the echoed-epoch check below.
    it('forwards the caller epoch pin to the socket transport', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn()
      const socketAuthorize = jest
        .fn()
        .mockResolvedValue({ ...validGrant, leaseRequestId: 'lease-1', bootstrapChallenge: 'challenge-1' })
      const service = createService()
      service.setCollaborationAuthorizationTransport(socketAuthorize)

      await expect(
        service.authorizeCollaborationRoom('note-1', 'lease-1', 'challenge-1', roomEpoch),
      ).resolves.toMatchObject({ capability: 'capability-1', roomEpoch })

      expect(socketAuthorize).toHaveBeenCalledWith('note-1', 'lease-1', 'challenge-1', roomEpoch)
      expect(webSocketApiService.authorizeCollaboration).not.toHaveBeenCalled()
    })

    it('still rejects a socket grant echoing an epoch other than the pin', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn()
      webSocketApiService.discoverCollaborationRoomEpoch = jest.fn()
      const socketAuthorize = jest.fn().mockResolvedValue({ ...validGrant, roomEpoch: 'room_epoch_0000000000000002' })
      const service = createService()
      service.setCollaborationAuthorizationTransport(socketAuthorize)

      await expect(
        service.authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch),
      ).resolves.toBeUndefined()
      expect(socketAuthorize).toHaveBeenCalledWith('note-1', undefined, undefined, roomEpoch)
    })

    it('treats an explicit socket denial as final and does not retry it over HTTP', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn()
      const service = createService()
      service.setCollaborationAuthorizationTransport(jest.fn().mockResolvedValue(null))

      await expect(
        service.authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch),
      ).resolves.toBeUndefined()
      expect(webSocketApiService.authorizeCollaboration).not.toHaveBeenCalled()
    })

    it('accepts only the final exact-epoch grant from the socket transport', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn()
      webSocketApiService.discoverCollaborationRoomEpoch = jest.fn()
      const socketAuthorize = jest.fn().mockResolvedValue(validGrant)
      const service = createService()
      service.setCollaborationAuthorizationTransport(socketAuthorize)

      await expect(service.authorizeCollaborationRoom('note-1')).resolves.toEqual({
        capability: 'capability-1',
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 3,
        roomEpoch,
        collaborationSecurityEpoch: securityEpoch,
      })

      expect(socketAuthorize).toHaveBeenCalledWith('note-1', undefined, undefined, undefined)
      expect(webSocketApiService.discoverCollaborationRoomEpoch).not.toHaveBeenCalled()
      expect(webSocketApiService.authorizeCollaboration).not.toHaveBeenCalled()
    })

    it('performs discovery before the exact-epoch HTTP grant when no socket transport handles it', async () => {
      webSocketApiService.discoverCollaborationRoomEpoch = jest.fn().mockResolvedValue({
        status: 200,
        data: {
          epochDiscovery: true,
          room: 'note-1',
          serverUpdatedAtTimestamp: 123,
          collaborationProtocolVersion: 3,
          roomEpoch,
          collaborationSecurityEpoch: securityEpoch,
        },
      })
      webSocketApiService.authorizeCollaboration = jest.fn().mockResolvedValue({ status: 200, data: validGrant })

      await expect(createService().authorizeCollaborationRoom('note-1')).resolves.toEqual({
        capability: 'capability-1',
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 3,
        roomEpoch,
        collaborationSecurityEpoch: securityEpoch,
      })

      expect(webSocketApiService.discoverCollaborationRoomEpoch).toHaveBeenCalledWith('note-1')
      expect(webSocketApiService.authorizeCollaboration).toHaveBeenCalledWith('note-1', undefined, undefined, roomEpoch)
    })

    it('fails closed before transport for a malformed explicitly requested epoch', async () => {
      webSocketApiService.authorizeCollaboration = jest.fn()
      webSocketApiService.discoverCollaborationRoomEpoch = jest.fn()
      const socketAuthorize = jest.fn()
      const service = createService()
      service.setCollaborationAuthorizationTransport(socketAuthorize)

      await expect(
        service.authorizeCollaborationRoom('note-1', undefined, undefined, 'invalid epoch'),
      ).resolves.toBeUndefined()

      expect(socketAuthorize).not.toHaveBeenCalled()
      expect(webSocketApiService.discoverCollaborationRoomEpoch).not.toHaveBeenCalled()
      expect(webSocketApiService.authorizeCollaboration).not.toHaveBeenCalled()
    })

    it('discovers an epoch without accepting a capability or expiresIn', async () => {
      const socketAuthorize = jest.fn()
      webSocketApiService.discoverCollaborationRoomEpoch = jest.fn().mockResolvedValue({
        status: 200,
        data: {
          epochDiscovery: true,
          room: 'note-1',
          serverUpdatedAtTimestamp: 123,
          collaborationProtocolVersion: 3,
          roomEpoch,
          collaborationSecurityEpoch: securityEpoch,
        },
      })

      const service = createService()
      service.setCollaborationAuthorizationTransport(socketAuthorize)
      await expect(service.discoverCollaborationRoomEpoch('note-1')).resolves.toEqual({
        room: 'note-1',
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 3,
        roomEpoch,
        collaborationSecurityEpoch: securityEpoch,
      })
      expect(socketAuthorize).not.toHaveBeenCalled()
    })

    it('rejects a discovery response that contains join capability material', async () => {
      webSocketApiService.discoverCollaborationRoomEpoch = jest.fn().mockResolvedValue({
        status: 200,
        data: {
          ...validGrant,
          epochDiscovery: true,
        },
      })

      await expect(createService().discoverCollaborationRoomEpoch('note-1')).resolves.toBeUndefined()
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

    // N11: these parse as valid JSON, so the parse guard lets them through; a
    // `null` then threw a TypeError on `.t` outside the try. FALSE-GREEN: drop
    // the `eventData === null || typeof eventData !== 'object'` guard → 'null'
    // throws → RED.
    it.each(['null', '42', '"pong"', 'true'])('drops the scalar JSON frame %s without throwing', (raw) => {
      const service = createService()
      const { events, run } = pumpRaw(service, raw)

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
        protocolVersion: 3,
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
      // Fake timers: a scheduled backoff retry only runs when a test advances
      // the clock, so it cannot race the assertions or spawn a second dial.
      jest.useFakeTimers()
    })

    afterEach(() => {
      services.forEach((service) => service.deinit())
      services = []
      ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
      jest.restoreAllMocks()
      jest.useRealTimers()
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

  describe('gateway URL derivation (B4 / R20)', () => {
    it.each([
      ['https://notes.example.com', 'wss://notes.example.com/sockets'],
      ['http://localhost:3001', 'ws://localhost:3001/sockets'],
      ['https://notes.example.com/', 'wss://notes.example.com/sockets'],
      ['HTTPS://Notes.Example.com:8443', 'wss://Notes.Example.com:8443/sockets'],
      ['http://127.0.0.1:3000', 'ws://127.0.0.1:3000/sockets'],
      ['http://[::1]:3000', 'ws://[::1]:3000/sockets'],
    ])('derives %s → %s', (apiHost, expected) => {
      expect(WebSocketsService.deriveWebSocketUrl(apiHost)).toBe(expected)
    })

    it.each([
      ['a sub-path', 'https://example.com/notes'],
      ['a query string', 'https://example.com/?x=1'],
      ['credentials', 'https://user:pw@example.com'],
      ['a websocket URL', 'wss://example.com'],
      ['a file origin', 'file:///index.html'],
      ['an empty host', ''],
      ['garbage', 'not a url'],
    ])('refuses %s', (_case, apiHost) => {
      expect(WebSocketsService.deriveWebSocketUrl(apiHost)).toBeUndefined()
    })

    it('refuses an undefined host', () => {
      expect(WebSocketsService.deriveWebSocketUrl(undefined)).toBeUndefined()
    })

    // FALSE-GREEN: drop the `|| WebSocketsService.deriveWebSocketUrl(apiHost)`
    // tail in loadWebSocketUrl → the URL stays '' → RED.
    it('loadWebSocketUrl(host) falls back to the derived URL when nothing is stored, configured or injected', () => {
      storageService.getValue = jest.fn().mockReturnValue(undefined)
      const service = createService()

      service.loadWebSocketUrl('http://localhost:3001')

      expect(service.getConfiguredWebSocketUrl()).toBe('ws://localhost:3001/sockets')
      expect(service.hasConfiguredWebSocketUrl()).toBe(true)
    })

    it('loadWebSocketUrl(host) leaves the URL unset when the host is not derivable', () => {
      storageService.getValue = jest.fn().mockReturnValue(undefined)
      const service = createService()

      service.loadWebSocketUrl('https://example.com/notes')

      expect(service.hasConfiguredWebSocketUrl()).toBe(false)
    })

    it('a stored URL wins over the derived one', () => {
      storageService.getValue = jest.fn().mockReturnValue('wss://stored.example.test/sockets')
      const service = createService()

      service.loadWebSocketUrl('http://localhost:3001')

      expect(service.getConfiguredWebSocketUrl()).toBe('wss://stored.example.test/sockets')
    })

    // FALSE-GREEN: revert setWebSocketUrl to store `url` as given → stores
    // undefined and hasConfiguredWebSocketUrl() is false → RED.
    it('setWebSocketUrl(undefined, host) derives and persists the derived URL', () => {
      const service = createService()

      service.setWebSocketUrl(undefined, 'https://custom.example.com')

      expect(service.getConfiguredWebSocketUrl()).toBe('wss://custom.example.com/sockets')
      expect(storageService.setValue).toHaveBeenCalledWith(StorageKey.WebSocketUrl, 'wss://custom.example.com/sockets')
    })

    it('setWebSocketUrl(url, host) keeps an explicit URL over the derived one', () => {
      const service = createService()

      service.setWebSocketUrl('wss://gateway.example.com/sockets', 'https://custom.example.com')

      expect(service.getConfiguredWebSocketUrl()).toBe('wss://gateway.example.com/sockets')
    })
  })

  describe('reconnect lifecycle (fake timers, browser-faithful socket)', () => {
    // Mirrors the WHATWG contract the plain FakeWebSocket above glosses over:
    // close() on a CONNECTING socket *fails* the handshake and the close event
    // carries 1006, not the code the caller asked for; close() on an OPEN
    // socket echoes the requested code (what `ws` does server-side). With
    // `echoClose = false` the peer never answers the close frame at all (a
    // half-open TCP path): the socket sits in CLOSING until the test fires the
    // eventual 1006 itself.
    class BrowserLikeWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      static instances: BrowserLikeWebSocket[] = []

      readyState: number = BrowserLikeWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onclose: ((event: { code?: number }) => void) | null = null
      onmessage: ((event: { data: unknown }) => void) | null = null
      sent: string[] = []
      closeCalls: Array<number | undefined> = []
      echoClose = true

      constructor(public url: string) {
        BrowserLikeWebSocket.instances.push(this)
      }

      send(data: string): void {
        this.sent.push(data)
      }

      close(code?: number): void {
        this.closeCalls.push(code)
        if (this.readyState === BrowserLikeWebSocket.CLOSED) {
          return
        }
        const wasConnecting = this.readyState === BrowserLikeWebSocket.CONNECTING
        if (!this.echoClose) {
          this.readyState = BrowserLikeWebSocket.CLOSING
          return
        }
        this.readyState = BrowserLikeWebSocket.CLOSED
        this.onclose?.({ code: wasConnecting ? 1006 : code })
      }

      fireOpen(): void {
        this.readyState = BrowserLikeWebSocket.OPEN
        this.onopen?.()
      }
      fireClose(code: number): void {
        this.readyState = BrowserLikeWebSocket.CLOSED
        this.onclose?.({ code })
      }
      fireMessage(data: unknown): void {
        this.onmessage?.({ data })
      }
    }

    const DIAL_URL = 'wss://gateway.test/sockets'
    const okToken = () => ({ status: 200, data: { token: 'tok' } })
    const errorToken = (status: number) => ({ status, data: { error: { message: `mint failed ${status}` } } })

    let originalWebSocket: unknown
    let createConnectionToken: jest.Mock
    let consoleError: jest.SpyInstance
    let timeoutSpy: jest.SpyInstance

    const sockets = () => BrowserLikeWebSocket.instances
    const lastDelay = () => timeoutSpy.mock.calls[timeoutSpy.mock.calls.length - 1][1] as number
    /** Let a dial's awaited token mint settle without moving the clock. */
    const flush = () => jest.advanceTimersByTimeAsync(0)
    const observeEvents = (service: WebSocketsService): WebSocketsServiceEvent[] => {
      const events: WebSocketsServiceEvent[] = []
      service.addEventObserver((event) => {
        events.push(event)
        return Promise.resolve()
      })
      return events
    }

    const createDialService = (url: string = DIAL_URL) => {
      const service = new WebSocketsService(storageService, url, webSocketApiService, internalEventBus)
      services.push(service)
      return service
    }

    beforeEach(() => {
      jest.useFakeTimers()
      BrowserLikeWebSocket.instances = []
      originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
      ;(globalThis as { WebSocket?: unknown }).WebSocket = BrowserLikeWebSocket
      createConnectionToken = jest.fn().mockImplementation(async () => okToken())
      webSocketApiService.createConnectionToken = createConnectionToken
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      timeoutSpy = jest.spyOn(globalThis, 'setTimeout')
      // Full jitter at its maximum → deterministic delays equal to the cap curve.
      jest.spyOn(Math, 'random').mockReturnValue(1)
    })

    afterEach(() => {
      services.forEach((service) => service.deinit())
      services = []
      ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
      jest.restoreAllMocks()
      jest.useRealTimers()
    })

    it('backs off 1→2→4→8→16→30 s, then 64→128→256→300 s after six failures, minting a fresh token per dial', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      expect(sockets()).toHaveLength(1)

      const delays: number[] = []
      for (let i = 0; i < 11; i++) {
        const before = timeoutSpy.mock.calls.length
        sockets()[i].fireClose(1006)
        expect(timeoutSpy.mock.calls.length).toBe(before + 1)
        delays.push(timeoutSpy.mock.calls[before][1] as number)
        await jest.advanceTimersByTimeAsync(delays[i])
        expect(sockets()).toHaveLength(i + 2)
      }

      // FALSE-GREEN: revert the RECONNECT_LONG_* cap → 30 000 from the 6th
      // failure on → RED on the tail of this list.
      expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 64_000, 128_000, 256_000, 300_000, 300_000])
      expect(createConnectionToken).toHaveBeenCalledTimes(12)
      expect(new Set(sockets().map((ws) => ws.url))).toEqual(new Set([`${DIAL_URL}?authToken=tok`]))
    })

    it('resets the backoff only after the socket has stayed OPEN for 10 s', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      sockets()[0].fireClose(1006)
      await jest.advanceTimersByTimeAsync(1_000)
      sockets()[1].fireClose(1006)
      await jest.advanceTimersByTimeAsync(2_000)

      // Accept-then-drop before 10 s must not reset: next delay is still 4 s.
      sockets()[2].fireOpen()
      await jest.advanceTimersByTimeAsync(9_999)
      let before = timeoutSpy.mock.calls.length
      sockets()[2].fireClose(1006)
      expect(timeoutSpy.mock.calls[before][1]).toBe(4_000)
      await jest.advanceTimersByTimeAsync(4_000)

      // Stable for 10 s → the next drop starts again at 1 s.
      sockets()[3].fireOpen()
      await jest.advanceTimersByTimeAsync(10_000)
      before = timeoutSpy.mock.calls.length
      sockets()[3].fireClose(1006)
      expect(timeoutSpy.mock.calls[before][1]).toBe(1_000)
    })

    // R18 / e5 probe E. FALSE-GREEN: in closeWebSocketConnection() keep the
    // socket reference and leave `closedByApplication` false (the fix is those
    // two redundant layers) → the 1006 the browser reports for a CONNECTING
    // close reaches onWebSocketClose → a backoff timer re-arms → a second
    // socket is dialled and a second token minted → RED.
    it('closeWebSocketConnection() during CONNECTING dials no second socket and mints no second token', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      expect(sockets()[0].readyState).toBe(BrowserLikeWebSocket.CONNECTING)

      service.closeWebSocketConnection()

      expect(sockets()[0].closeCalls).toEqual([3123])
      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(600_000)
      expect(sockets()).toHaveLength(1)
      expect(createConnectionToken).toHaveBeenCalledTimes(1)
      expect(service.isWebSocketConnectionOpen()).toBe(false)
    })

    it('closeWebSocketConnection() while the token is still minting builds no socket and does not dead-lock a later start', async () => {
      const service = createDialService()
      let resolveMint: (value: unknown) => void = () => undefined
      createConnectionToken.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMint = resolve
          }),
      )

      const dial = service.startWebSocketConnection()
      service.closeWebSocketConnection()
      resolveMint(okToken())
      const result = await dial

      expect(result.isFailed()).toBe(true)
      expect(sockets()).toHaveLength(0)
      expect(jest.getTimerCount()).toBe(0)

      await service.startWebSocketConnection()
      expect(sockets()).toHaveLength(1)
    })

    it('closeWebSocketConnection() of an OPEN socket publishes WebSocketDidClose exactly once', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      sockets()[0].fireOpen()
      const events = observeEvents(service)

      service.closeWebSocketConnection()

      expect(events.filter((event) => event === WebSocketsServiceEvent.WebSocketDidClose)).toHaveLength(1)
      expect(jest.getTimerCount()).toBe(0)
    })

    // R18 / e5 probe F. FALSE-GREEN: the same two-line revert as above (keep
    // the reference, flag off) → the 1006 re-arms a timer → RED. Closing after
    // the dependencies were nulled is what made every tick of that loop mint
    // through an undefined api service and log "Caught error:"; deinit now
    // closes first, and the detach keeps the loop from starting at all.
    it('deinit() during CONNECTING leaves no timer, dials nothing and logs nothing', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()

      service.deinit()
      services = services.filter((candidate) => candidate !== service)

      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(600_000)
      expect(sockets()).toHaveLength(1)
      expect(createConnectionToken).toHaveBeenCalledTimes(1)
      expect(consoleError).not.toHaveBeenCalled()
    })

    // R18 / e5 probe F2: a peer that never echoes the close frame.
    it('deinit() while OPEN followed by a late 1006 from the abandoned socket re-arms nothing', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      const ws = sockets()[0]
      ws.fireOpen()
      ws.echoClose = false

      service.deinit()
      services = services.filter((candidate) => candidate !== service)
      expect(ws.readyState).toBe(BrowserLikeWebSocket.CLOSING)

      ws.fireClose(1006)

      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(600_000)
      expect(sockets()).toHaveLength(1)
      expect(consoleError).not.toHaveBeenCalled()
    })

    // R17. FALSE-GREEN: drop the 1008 branch in onWebSocketClose → a backoff
    // timer is armed and a second socket dialled → RED.
    it('a 1008 policy close stops re-dialling; reconnectIfClosed() then tries exactly once more', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      sockets()[0].fireOpen()

      sockets()[0].fireClose(1008)

      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(600_000)
      expect(sockets()).toHaveLength(1)
      expect(createConnectionToken).toHaveBeenCalledTimes(1)

      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(2)
      expect(createConnectionToken).toHaveBeenCalledTimes(2)
    })

    // R17 / R7. FALSE-GREEN: classify every mint error as retryable → a
    // backoff timer is armed and the mint repeats → RED.
    it.each([503, 403])(
      'a %i token mint stops dialling and logs once; reconnectIfClosed() mints once more',
      async (status) => {
        createConnectionToken.mockImplementation(async () => errorToken(status))
        const service = createDialService()

        const result = await service.startWebSocketConnection()

        expect(result.isFailed()).toBe(true)
        expect(sockets()).toHaveLength(0)
        expect(jest.getTimerCount()).toBe(0)
        await jest.advanceTimersByTimeAsync(600_000)
        expect(createConnectionToken).toHaveBeenCalledTimes(1)
        expect(consoleError).toHaveBeenCalledTimes(1)

        service.reconnectIfClosed()
        await flush()
        expect(createConnectionToken).toHaveBeenCalledTimes(2)
        expect(jest.getTimerCount()).toBe(0)
      },
    )

    // R17 (log demotion). FALSE-GREEN: log on every failure → 5 errors → RED.
    it('a retryable mint failure backs off and logs only the first failure of each outage', async () => {
      createConnectionToken.mockImplementation(async () => errorToken(500))
      const service = createDialService()
      await service.startWebSocketConnection()
      for (let i = 0; i < 4; i++) {
        await jest.advanceTimersByTimeAsync(lastDelay())
      }
      expect(createConnectionToken).toHaveBeenCalledTimes(5)
      expect(consoleError).toHaveBeenCalledTimes(1)

      // The outage ends when a socket opens; the next outage logs again.
      createConnectionToken.mockImplementation(async () => okToken())
      await jest.advanceTimersByTimeAsync(lastDelay())
      sockets()[0].fireOpen()
      createConnectionToken.mockImplementation(async () => errorToken(500))
      sockets()[0].fireClose(1006)
      await jest.advanceTimersByTimeAsync(lastDelay())

      expect(consoleError).toHaveBeenCalledTimes(2)
    })

    it('a thrown mint (host not set yet, aborted fetch) is retryable and logged once', async () => {
      createConnectionToken.mockImplementation(async () => {
        throw new Error('host not set')
      })
      const service = createDialService()

      await service.startWebSocketConnection()
      await jest.advanceTimersByTimeAsync(lastDelay())

      expect(createConnectionToken).toHaveBeenCalledTimes(2)
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(1)
    })

    // D3 half-open detection. FALSE-GREEN: never arm the pong deadline in
    // websocketHeartbeat → the silent socket stays OPEN and no second socket
    // is ever dialled → RED.
    it('pings every 60 s and gives up a socket that answers nothing for 120 s, re-dialling from attempt 0', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      const ws = sockets()[0]
      ws.fireOpen()
      ws.echoClose = false
      const events = observeEvents(service)

      await jest.advanceTimersByTimeAsync(60_000)
      expect(ws.sent).toEqual(['ping'])
      ws.fireMessage('pong')

      // Answered: the deadline from the 60 s ping is cleared; the 120 s ping
      // re-arms it (expires at 240 s) and the 180 s ping leaves it alone.
      await jest.advanceTimersByTimeAsync(120_000)
      expect(ws.sent).toEqual(['ping', 'ping', 'ping'])
      expect(sockets()).toHaveLength(1)
      expect(service.isWebSocketConnectionOpen()).toBe(true)

      await jest.advanceTimersByTimeAsync(60_000)
      expect(ws.closeCalls).toEqual([4000])
      expect(service.isWebSocketConnectionOpen()).toBe(false)
      expect(events).toContain(WebSocketsServiceEvent.WebSocketDidClose)

      await jest.advanceTimersByTimeAsync(1_000)
      expect(sockets()).toHaveLength(2)
      expect(createConnectionToken).toHaveBeenCalledTimes(2)

      // The abandoned socket's eventual 1006 is ignored.
      ws.fireClose(1006)
      expect(jest.getTimerCount()).toBe(0)
      expect(sockets()).toHaveLength(2)
    })

    it('any inbound frame — not just a pong — satisfies the deadline', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      const ws = sockets()[0]
      ws.fireOpen()

      await jest.advanceTimersByTimeAsync(60_000)
      ws.fireMessage(JSON.stringify({ type: 'ITEMS_CHANGED_ON_SERVER' }))
      await jest.advanceTimersByTimeAsync(119_000)

      expect(ws.closeCalls).toEqual([])
      expect(service.isWebSocketConnectionOpen()).toBe(true)
    })

    // Contract C11.
    it('reconnectIfClosed() is a no-op without a URL, before a connection was requested, while CONNECTING and while OPEN', async () => {
      const noUrl = createDialService('')
      noUrl.reconnectIfClosed()
      const neverRequested = createDialService()
      neverRequested.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(0)
      expect(createConnectionToken).not.toHaveBeenCalled()

      const service = createDialService()
      await service.startWebSocketConnection()
      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(1)

      sockets()[0].fireOpen()
      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(1)
      expect(createConnectionToken).toHaveBeenCalledTimes(1)
    })

    // FALSE-GREEN: make reconnectIfClosed() return without dialling when a
    // backoff timer is pending → still 1 socket after flush → RED.
    it('reconnectIfClosed() cancels a pending backoff and dials immediately from attempt 0, but never after the app closed the socket', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      sockets()[0].fireOpen()
      sockets()[0].fireClose(1006)
      expect(jest.getTimerCount()).toBe(1)

      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(2)
      expect(jest.getTimerCount()).toBe(0)

      // Attempt counter was reset: the next drop backs off from 1 s again.
      sockets()[1].fireClose(1006)
      expect(lastDelay()).toBe(1_000)

      service.closeWebSocketConnection()
      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(2)
    })

    // R17 residual. FALSE-GREEN: drop the throttle floor from
    // reconnectIfClosed() → a flapping focus/online burst re-dials on every
    // call within the window → RED (3 sockets/tokens instead of 2 at the
    // burst checkpoint).
    it('reconnectIfClosed() throttles rapid re-triggers to a minimum interval, so a flapping focus/online burst cannot defeat the backoff', async () => {
      const service = createDialService()
      await service.startWebSocketConnection()
      // 1008: the gateway refuses outright, so no backoff timer is armed —
      // isolates the throttle from the unrelated scheduled-retry timer.
      sockets()[0].fireClose(1008)

      // A genuine, isolated foreground return still dials immediately.
      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(2)
      expect(createConnectionToken).toHaveBeenCalledTimes(2)

      sockets()[1].fireClose(1008)

      // A flapping burst well within the throttle window (rapid focus/blur,
      // or a flapping network re-raising `online`) must be coalesced away
      // rather than each re-dialling.
      await jest.advanceTimersByTimeAsync(500)
      service.reconnectIfClosed()
      await flush()
      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(2)
      expect(createConnectionToken).toHaveBeenCalledTimes(2)

      // Once the throttle window has fully elapsed since the last dial, a
      // further re-trigger dials again.
      await jest.advanceTimersByTimeAsync(5_000)
      service.reconnectIfClosed()
      await flush()
      expect(sockets()).toHaveLength(3)
      expect(createConnectionToken).toHaveBeenCalledTimes(3)
    })
  })
})
