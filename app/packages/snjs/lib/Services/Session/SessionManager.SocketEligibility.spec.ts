import { SessionManager } from './SessionManager'
import { Session, SessionToken } from '@standardnotes/domain-core'
import { WebSocketsService } from '@standardnotes/services'

describe('SessionManager websocket eligibility', () => {
  type SocketsLike = {
    hasConfiguredWebSocketUrl: () => boolean
    startWebSocketConnection: () => Promise<unknown>
    revokeSyncTransportSession: () => Promise<void>
    closeWebSocketConnection: () => void
  }

  const createManagerWith = <S extends SocketsLike>(sockets: S) => {
    const apiService = {
      setInvalidSessionObserver: jest.fn(),
      setSession: jest.fn(),
      setUser: jest.fn(),
      getSession: jest.fn(),
      signOut: jest.fn().mockResolvedValue(undefined),
    }
    const httpService = { setSession: jest.fn() }
    const manager = new SessionManager(
      {} as never,
      apiService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sockets as never,
      httpService as never,
      {} as never,
      {} as never,
      'workspace',
      {} as never,
      { execute: jest.fn(() => ({ isFailed: () => false, getValue: () => true })) } as never,
      {} as never,
    )
    return { manager, sockets, apiService }
  }

  const createManager = (configured: boolean) =>
    createManagerWith({
      hasConfiguredWebSocketUrl: jest.fn().mockReturnValue(configured),
      startWebSocketConnection: jest.fn().mockResolvedValue(undefined),
      revokeSyncTransportSession: jest.fn().mockResolvedValue(undefined),
      closeWebSocketConnection: jest.fn(),
    })

  const restoreSession = (manager: SessionManager) => {
    ;(manager as unknown as { setSession: (session: unknown) => void }).setSession({ accessToken: 'secret' })
  }

  const liveSession = () => {
    const accessToken = SessionToken.create('2:session-a:access', Date.now() + 60_000).getValue()
    const refreshToken = SessionToken.create('2:session-a:refresh', Date.now() + 120_000).getValue()
    return Session.create(accessToken, refreshToken).getValue()
  }

  it('starts the configured self-hosted websocket without a first-party-host gate', () => {
    const { manager, sockets } = createManager(true)

    restoreSession(manager)

    expect(sockets.startWebSocketConnection).toHaveBeenCalledTimes(1)
  })

  it('does not infer a websocket endpoint when none was configured', () => {
    const { manager, sockets } = createManager(false)

    restoreSession(manager)

    expect(sockets.startWebSocketConnection).not.toHaveBeenCalled()
  })

  // B4 / N10: desktop, mobile and the clipper inject no gateway URL, so the
  // session-restore dial at stage 09 depends on the URL derived from the sync
  // host having been loaded first. Drives the real WebSocketsService so the
  // derivation and the eligibility gate are proven together. FALSE-GREEN:
  // drop the derived-URL tail in WebSocketsService.loadWebSocketUrl → the
  // gate stays closed and nothing dials → RED.
  it('a gateway URL derived from the sync host makes the session-restore dial happen', () => {
    const storage = { getValue: jest.fn().mockReturnValue(undefined), setValue: jest.fn() }
    const realSockets = new WebSocketsService(
      storage as never,
      '',
      { createConnectionToken: jest.fn() } as never,
      { publish: jest.fn() } as never,
    )
    const start = jest.spyOn(realSockets, 'startWebSocketConnection').mockResolvedValue(undefined as never)
    const { manager } = createManagerWith(realSockets)

    realSockets.loadWebSocketUrl('https://notes.example.com')
    restoreSession(manager)

    expect(realSockets.getConfiguredWebSocketUrl()).toBe('wss://notes.example.com/sockets')
    expect(start).toHaveBeenCalledTimes(1)
    realSockets.deinit()
  })

  it('a sync host that yields no derivable gateway URL leaves the restore dial off', () => {
    const storage = { getValue: jest.fn().mockReturnValue(undefined), setValue: jest.fn() }
    const realSockets = new WebSocketsService(
      storage as never,
      '',
      { createConnectionToken: jest.fn() } as never,
      { publish: jest.fn() } as never,
    )
    const start = jest.spyOn(realSockets, 'startWebSocketConnection').mockResolvedValue(undefined as never)
    const { manager } = createManagerWith(realSockets)

    realSockets.loadWebSocketUrl('https://notes.example.com/sub-path')
    restoreSession(manager)

    expect(start).not.toHaveBeenCalled()
    realSockets.deinit()
  })

  it('awaits sync-worker quarantine before revoking the server session and closing the socket', async () => {
    const { manager, sockets, apiService } = createManager(true)
    let releaseQuarantine: () => void = () => undefined
    sockets.revokeSyncTransportSession.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseQuarantine = resolve
      }),
    )
    apiService.getSession.mockReturnValue(liveSession())

    const signOut = manager.signOut()
    await Promise.resolve()
    expect(apiService.signOut).not.toHaveBeenCalled()
    expect(sockets.closeWebSocketConnection).not.toHaveBeenCalled()

    releaseQuarantine()
    await signOut
    expect(apiService.signOut).toHaveBeenCalledTimes(1)
    expect(sockets.closeWebSocketConnection).toHaveBeenCalledTimes(1)
  })

  // N43. FALSE-GREEN: rethrow `syncTransportRevocationError` after the
  // finally block → signOut() rejects → RED.
  it('logs instead of throwing when the worker quarantine fails after the server sign-out completed', async () => {
    const { manager, sockets, apiService } = createManager(true)
    const quarantineFailure = new Error('outbox unreadable')
    sockets.revokeSyncTransportSession.mockRejectedValue(quarantineFailure)
    apiService.getSession.mockReturnValue(liveSession())
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(manager.signOut()).resolves.toBeUndefined()

    expect(apiService.signOut).toHaveBeenCalledTimes(1)
    expect(sockets.closeWebSocketConnection).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('quarantine'), quarantineFailure)
    consoleError.mockRestore()
  })
})
