import { WebApplication } from './WebApplication'

type WakeSignalCoordinator = {
  hasLiveSubscription: jest.Mock
  reconnectIfStopped: jest.Mock
}

// The helper under test is invoked off the prototype against a plain object that
// carries only what it reads (`sessions.isSignedIn`), like the other focused specs.
const armInviteRealtimeWakeSignals = (
  WebApplication.prototype as unknown as {
    armInviteRealtimeWakeSignals: (
      this: unknown,
      start: () => Promise<void>,
      coordinator: WakeSignalCoordinator,
    ) => () => void
  }
).armInviteRealtimeWakeSignals

function arm(options: { signedIn?: boolean; live?: boolean } = {}) {
  const signedIn = options.signedIn ?? true
  const live = options.live ?? false
  const start = jest.fn(async () => undefined)
  const coordinator: WakeSignalCoordinator = {
    hasLiveSubscription: jest.fn(() => live),
    reconnectIfStopped: jest.fn(() => true),
  }
  const dispose = armInviteRealtimeWakeSignals.call({ sessions: { isSignedIn: () => signedIn } }, start, coordinator)
  return { start, coordinator, dispose }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let visibilityState: DocumentVisibilityState = 'visible'

async function setVisibility(next: DocumentVisibilityState): Promise<void> {
  visibilityState = next
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
}

async function goOnline(): Promise<void> {
  window.dispatchEvent(new Event('online'))
  await flush()
}

describe('WebApplication invite realtime wake signals', () => {
  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibilityState })
  })

  beforeEach(() => {
    visibilityState = 'visible'
  })

  it('re-arms a stood-down invite stream when connectivity returns', async () => {
    const { start, coordinator, dispose } = arm()

    await goOnline()

    expect(start).toHaveBeenCalledTimes(1)
    expect(coordinator.reconnectIfStopped).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('re-arms when the tab becomes visible, and ignores it going hidden', async () => {
    const { start, coordinator, dispose } = arm()

    await setVisibility('hidden')
    expect(start).not.toHaveBeenCalled()

    await setVisibility('visible')
    expect(start).toHaveBeenCalledTimes(1)
    expect(coordinator.reconnectIfStopped).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('does nothing while the subscription is live', async () => {
    const { start, coordinator, dispose } = arm({ live: true })

    await goOnline()
    await setVisibility('visible')

    expect(coordinator.hasLiveSubscription).toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(coordinator.reconnectIfStopped).not.toHaveBeenCalled()
    dispose()
  })

  it('does nothing without a signed-in session', async () => {
    const { start, coordinator, dispose } = arm({ signedIn: false })

    await goOnline()
    await setVisibility('visible')

    expect(start).not.toHaveBeenCalled()
    expect(coordinator.reconnectIfStopped).not.toHaveBeenCalled()
    dispose()
  })

  it('stops listening once disposed', async () => {
    const { start, coordinator, dispose } = arm()

    dispose()
    await goOnline()
    await setVisibility('visible')

    expect(start).not.toHaveBeenCalled()
    expect(coordinator.reconnectIfStopped).not.toHaveBeenCalled()
  })
})
