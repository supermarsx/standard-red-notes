import {
  InviteRealtimeApplicationLifecycle,
  InviteRealtimeSessionCoordinator,
} from './InviteRealtimeApplicationLifecycle'

describe('InviteRealtimeApplicationLifecycle', () => {
  const createCoordinator = (): jest.Mocked<InviteRealtimeSessionCoordinator> => ({
    startSession: jest.fn().mockResolvedValue(undefined),
    stopSession: jest.fn(),
  })

  it('starts exactly one coordinator session for duplicate authenticated lifecycle notifications', async () => {
    const coordinator = createCoordinator()
    const lifecycle = new InviteRealtimeApplicationLifecycle({
      coordinator,
      isSignedIn: () => true,
      getSessionScope: jest.fn().mockResolvedValue('opaque-session-a'),
    })

    await Promise.all([lifecycle.startIfAuthenticated(), lifecycle.startIfAuthenticated()])
    await lifecycle.startIfAuthenticated()

    expect(coordinator.startSession).toHaveBeenCalledTimes(1)
    expect(coordinator.startSession).toHaveBeenCalledWith('opaque-session-a')
    expect(coordinator.stopSession).not.toHaveBeenCalled()
  })

  it('switches coordinator sessions when the authenticated scope changes', async () => {
    const coordinator = createCoordinator()
    let sessionScope = 'opaque-session-a'
    const lifecycle = new InviteRealtimeApplicationLifecycle({
      coordinator,
      isSignedIn: () => true,
      getSessionScope: async () => sessionScope,
    })

    await lifecycle.startIfAuthenticated()
    sessionScope = 'opaque-session-b'
    await lifecycle.startIfAuthenticated()

    expect(coordinator.startSession.mock.calls).toEqual([['opaque-session-a'], ['opaque-session-b']])
  })

  it('synchronously aborts the active session and rejects a late scope lookup after sign-out', async () => {
    const coordinator = createCoordinator()
    let signedIn = true
    let resolveScope!: (scope: string) => void
    const scope = new Promise<string>((resolve) => {
      resolveScope = resolve
    })
    const lifecycle = new InviteRealtimeApplicationLifecycle({
      coordinator,
      isSignedIn: () => signedIn,
      getSessionScope: () => scope,
    })

    const starting = lifecycle.startIfAuthenticated()
    signedIn = false
    lifecycle.stop()
    expect(coordinator.stopSession).toHaveBeenCalledTimes(1)

    resolveScope('stale-session')
    await starting
    expect(coordinator.startSession).not.toHaveBeenCalled()
  })

  it('clears a failed start so the next lifecycle notification can reconnect from its durable cursor', async () => {
    const coordinator = createCoordinator()
    coordinator.startSession.mockRejectedValueOnce(new Error('socket unavailable'))
    const lifecycle = new InviteRealtimeApplicationLifecycle({
      coordinator,
      isSignedIn: () => true,
      getSessionScope: async () => 'opaque-session-a',
    })

    await expect(lifecycle.startIfAuthenticated()).rejects.toThrow('socket unavailable')
    await lifecycle.startIfAuthenticated()

    expect(coordinator.startSession).toHaveBeenCalledTimes(2)
    expect(coordinator.stopSession).toHaveBeenCalledTimes(1)
  })
})
