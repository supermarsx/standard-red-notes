import { ApplicationEvent, Environment, namespacedKey, Platform, RawStorageKey, SNLog } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { WebOrDesktopDevice } from './Device/WebOrDesktopDevice'
import { WebSocketSyncTransport } from '@/Services/SyncTransport/WebSocketSyncTransport'
import type { CollaborationRoomAuthorizationTransport } from '@standardnotes/services'
import { TextEncoder as NodeTextEncoder } from 'node:util'

if (!globalThis.TextEncoder) {
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder })
}

jest.mock('@standardnotes/sncrypto-web', () => {
  return {
    SNWebCrypto: class {
      initialize() {
        return Promise.resolve()
      }
      generateUUID() {
        return 'mock-uuid'
      }
    },
  }
})

describe('web application', () => {
  let application: WebApplication

  // eslint-disable-next-line no-console
  SNLog.onLog = console.log
  SNLog.onError = console.error

  beforeEach(async () => {
    const identifier = '123'

    window.matchMedia = jest.fn().mockReturnValue({ matches: false, addListener: jest.fn() })

    const device = {
      environment: Environment.Desktop,
      appVersion: '1.2.3',
      setApplication: jest.fn(),
      openDatabase: jest.fn().mockReturnValue(Promise.resolve()),
      getRawStorageValue: jest.fn().mockImplementation(async (key) => {
        if (key === namespacedKey(identifier, RawStorageKey.SnjsVersion)) {
          return '10.0.0'
        }
        return undefined
      }),
      setRawStorageValue: jest.fn(),
    } as unknown as jest.Mocked<WebOrDesktopDevice>

    application = new WebApplication(device, Platform.MacWeb, identifier, 'https://sync', 'https://socket')

    await application.prepareForLaunch({ receiveChallenge: jest.fn() })
  })

  it('should create application', () => {
    expect(application).toBeTruthy()
  })

  it('installs the modern collaboration authorization and session-revocation hooks', async () => {
    const inspectableApplication = application as unknown as {
      _webSocketSyncTransport: WebSocketSyncTransport
      installWebSocketSyncTransport(): void
    }
    // Use the real seam type rather than a hand-rolled copy: the local duplicate is
    // what let the transport's arity drift out of sync with its only caller.
    let authorizationTransport: CollaborationRoomAuthorizationTransport | undefined
    let sessionRevocationHandler: (() => void | Promise<void>) | undefined
    const setCollaborationAuthorizationTransport = jest.fn((transport: CollaborationRoomAuthorizationTransport) => {
      authorizationTransport = transport
      return jest.fn()
    })
    const onSyncTransportSessionRevoked = jest.fn((handler: () => void | Promise<void>) => {
      sessionRevocationHandler = handler
      return jest.fn()
    })
    Object.assign(application.sockets, {
      setCollaborationAuthorizationTransport,
      onSyncTransportSessionRevoked,
    })
    inspectableApplication.installWebSocketSyncTransport()
    const grant = {
      epochDiscovery: false as const,
      capability: 'capability-1',
      room: 'note-1',
      expiresIn: 300,
      serverUpdatedAtTimestamp: 123,
      collaborationProtocolVersion: 3 as const,
      roomEpoch: 'room_epoch_00000001',
      collaborationSecurityEpoch: 'security_epoch_0001',
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'bootstrap-1',
    }
    const authorize = jest
      .spyOn(inspectableApplication._webSocketSyncTransport, 'authorizeCollaborationRoom')
      .mockResolvedValue(grant)

    expect(setCollaborationAuthorizationTransport).toHaveBeenCalledTimes(1)
    await expect(authorizationTransport?.('note-1', 'lease-1', 'bootstrap-1')).resolves.toEqual(grant)
    expect(authorize).toHaveBeenCalledWith('note-1', 'lease-1', 'bootstrap-1', undefined)

    // The lambda used to accept three arguments, silently dropping the caller's
    // epoch pin before it could reach the worker's pre-grant abort.
    await expect(authorizationTransport?.('note-1', 'lease-1', 'bootstrap-1', 'room_epoch_00000001')).resolves.toEqual(
      grant,
    )
    expect(authorize).toHaveBeenLastCalledWith('note-1', 'lease-1', 'bootstrap-1', 'room_epoch_00000001')

    const notifySessionRevoked = jest
      .spyOn(inspectableApplication._webSocketSyncTransport, 'notifySessionRevoked')
      .mockResolvedValue(undefined)
    expect(onSyncTransportSessionRevoked).toHaveBeenCalledTimes(1)
    await sessionRevocationHandler?.()
    expect(notifySessionRevoked).toHaveBeenCalledTimes(1)
  })

  it('owns one durable invite subscription per authenticated scope and performs no healthy polling', async () => {
    type InspectableApplication = {
      getOpaqueAuthenticatedSyncSessionScope(): Promise<string | undefined>
      notifyEvent(event: ApplicationEvent): Promise<void>
    }
    const inspectableApplication = application as unknown as InspectableApplication

    let signedIn = true
    let sessionScope = 'opaque-session-a'
    jest.spyOn(application.sessions, 'isSignedIn').mockImplementation(() => signedIn)
    jest
      .spyOn(inspectableApplication, 'getOpaqueAuthenticatedSyncSessionScope')
      .mockImplementation(async () => sessionScope)

    const disposeFirst = jest.fn()
    const disposeSecond = jest.fn()
    const subscriptions: Parameters<WebSocketSyncTransport['subscribeInviteEvents']>[0][] = []
    jest.spyOn(WebSocketSyncTransport.prototype, 'subscribeInviteEvents').mockImplementation(async (options) => {
      subscriptions.push(options)
      return subscriptions.length === 1 ? disposeFirst : disposeSecond
    })
    const vaultSnapshot = jest.fn().mockResolvedValue(undefined)
    const subscriptionSnapshot = jest.fn().mockResolvedValue(undefined)
    application.vaultInvites.reconcileInviteRealtimeSnapshot = vaultSnapshot
    application.subscriptions.reconcileInviteRealtimeSnapshot = subscriptionSnapshot
    const authoritativeSync = jest.spyOn(application.sync, 'sync').mockResolvedValue(undefined)

    await inspectableApplication.notifyEvent(ApplicationEvent.SignedIn)
    await inspectableApplication.notifyEvent(ApplicationEvent.SignedIn)
    expect(subscriptions).toHaveLength(1)

    await subscriptions[0]?.reconcile({ reason: 'BOOTSTRAP_REQUIRED', cursor: 'cursor-1' })
    expect(vaultSnapshot).toHaveBeenCalledTimes(1)
    expect(subscriptionSnapshot).toHaveBeenCalledTimes(1)
    expect(authoritativeSync).toHaveBeenCalledTimes(1)

    subscriptions[0]?.onReady?.('cursor-1')
    subscriptions[0]?.onReady?.('cursor-1')
    await Promise.resolve()
    expect(vaultSnapshot).toHaveBeenCalledTimes(1)
    expect(subscriptionSnapshot).toHaveBeenCalledTimes(1)
    expect(authoritativeSync).toHaveBeenCalledTimes(1)

    sessionScope = 'opaque-session-b'
    await inspectableApplication.notifyEvent(ApplicationEvent.SignedIn)
    expect(subscriptions).toHaveLength(2)
    expect(disposeFirst).toHaveBeenCalledTimes(1)

    signedIn = false
    await inspectableApplication.notifyEvent(ApplicationEvent.SignedOut)
    expect(disposeSecond).toHaveBeenCalledTimes(1)
  })
})
