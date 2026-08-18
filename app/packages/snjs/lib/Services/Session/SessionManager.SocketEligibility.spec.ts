import { SessionManager } from './SessionManager'
import { Session, SessionToken } from '@standardnotes/domain-core'

describe('SessionManager websocket eligibility', () => {
  const createManager = (configured: boolean) => {
    const apiService = {
      setInvalidSessionObserver: jest.fn(),
      setSession: jest.fn(),
      setUser: jest.fn(),
      getSession: jest.fn(),
      signOut: jest.fn().mockResolvedValue(undefined),
    }
    const httpService = { setSession: jest.fn() }
    const sockets = {
      hasConfiguredWebSocketUrl: jest.fn().mockReturnValue(configured),
      startWebSocketConnection: jest.fn().mockResolvedValue(undefined),
      revokeSyncTransportSession: jest.fn().mockResolvedValue(undefined),
      closeWebSocketConnection: jest.fn(),
    }
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

  it('starts the configured self-hosted websocket without a first-party-host gate', () => {
    const { manager, sockets } = createManager(true)

    ;(manager as unknown as { setSession: (session: unknown) => void }).setSession({ accessToken: 'secret' })

    expect(sockets.startWebSocketConnection).toHaveBeenCalledTimes(1)
  })

  it('does not infer a websocket endpoint when none was configured', () => {
    const { manager, sockets } = createManager(false)

    ;(manager as unknown as { setSession: (session: unknown) => void }).setSession({ accessToken: 'secret' })

    expect(sockets.startWebSocketConnection).not.toHaveBeenCalled()
  })

  it('awaits sync-worker quarantine before revoking the server session and closing the socket', async () => {
    const { manager, sockets, apiService } = createManager(true)
    let releaseQuarantine: () => void = () => undefined
    sockets.revokeSyncTransportSession.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseQuarantine = resolve
      }),
    )
    const accessToken = SessionToken.create('2:session-a:access', Date.now() + 60_000).getValue()
    const refreshToken = SessionToken.create('2:session-a:refresh', Date.now() + 120_000).getValue()
    apiService.getSession.mockReturnValue(Session.create(accessToken, refreshToken).getValue())

    const signOut = manager.signOut()
    await Promise.resolve()
    expect(apiService.signOut).not.toHaveBeenCalled()
    expect(sockets.closeWebSocketConnection).not.toHaveBeenCalled()

    releaseQuarantine()
    await signOut
    expect(apiService.signOut).toHaveBeenCalledTimes(1)
    expect(sockets.closeWebSocketConnection).toHaveBeenCalledTimes(1)
  })
})
