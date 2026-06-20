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

  const createService = () => {
    return new WebSocketsService(storageService, webSocketUrl, webSocketApiService, internalEventBus)
  }

  beforeEach(() => {
    storageService = {} as jest.Mocked<StorageServiceInterface>
    storageService.setValue = jest.fn()

    internalEventBus = {} as jest.Mocked<InternalEventBusInterface>
    internalEventBus.publish = jest.fn()

    webSocketApiService = {} as jest.Mocked<WebSocketApiServiceInterface>
    webSocketApiService.createConnectionToken = jest.fn().mockReturnValue({ token: 'foobar' })
  })

  describe('setWebSocketUrl()', () => {
    it('saves url in local storage', () => {
      const webSocketUrl = 'wss://test-websocket'
      createService().setWebSocketUrl(webSocketUrl)
      expect(storageService.setValue).toHaveBeenCalledWith(StorageKey.WebSocketUrl, webSocketUrl)
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
  })
})
