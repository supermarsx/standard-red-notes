import { WebSocketsServiceEvent } from '@standardnotes/snjs'
import { addToast } from '@standardnotes/toast'
import type { WebApplication } from '@/Application/WebApplication'
import {
  PENDING_MFA_APPROVALS_POLL_INTERVAL_MS,
  PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS,
  PENDING_MFA_APPROVALS_VISIBILITY_POLL_THROTTLE_MS,
  PendingMfaApprovalsNotifier,
} from './PendingMfaApprovalsNotifier'

jest.mock('@standardnotes/toast', () => ({
  ToastType: { Regular: 'regular' },
  addToast: jest.fn(),
  dismissToast: jest.fn(),
}))

type SocketObserver = (event: WebSocketsServiceEvent, data?: unknown) => Promise<void> | void

type PendingApprovalsResponse = { status: number; data: { pendingApprovals: unknown[] } }

function createApplication(initial: { socketOpen?: boolean; signedIn?: boolean } = {}) {
  const state = { socketOpen: initial.socketOpen ?? false, signedIn: initial.signedIn ?? true }
  const observers: SocketObserver[] = []
  const socketDisposer = jest.fn()
  const listPendingMfaApprovals = jest.fn(async (): Promise<PendingApprovalsResponse> => ({
    status: 200,
    data: { pendingApprovals: [] },
  }))
  const application = {
    sockets: {
      addEventObserver: (observer: SocketObserver) => {
        observers.push(observer)
        return socketDisposer
      },
      isWebSocketConnectionOpen: () => state.socketOpen,
    },
    sessions: { getUser: () => (state.signedIn ? { uuid: 'user-uuid' } : undefined) },
    legacyApi: { listPendingMfaApprovals },
    openPreferences: jest.fn(),
  }
  return {
    application: application as unknown as WebApplication,
    state,
    observers,
    socketDisposer,
    listPendingMfaApprovals,
  }
}

const OPEN_INTERVAL = PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS
const CLOSED_INTERVAL = PENDING_MFA_APPROVALS_POLL_INTERVAL_MS
const VISIBILITY_THROTTLE = PENDING_MFA_APPROVALS_VISIBILITY_POLL_THROTTLE_MS

let visibilityState: DocumentVisibilityState = 'visible'

async function setVisibility(next: DocumentVisibilityState): Promise<void> {
  visibilityState = next
  document.dispatchEvent(new Event('visibilitychange'))
  await jest.advanceTimersByTimeAsync(0)
}

describe('PendingMfaApprovalsNotifier safety-net poll', () => {
  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibilityState })
  })

  beforeEach(() => {
    visibilityState = 'visible'
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('pins the approved cadences: 120 s with an OPEN socket, 20 s without, 5 s visibility throttle', () => {
    expect(OPEN_INTERVAL).toBe(120_000)
    expect(CLOSED_INTERVAL).toBe(20_000)
    expect(VISIBILITY_THROTTLE).toBe(5_000)
  })

  it('keeps polling every 120 s while the socket is OPEN instead of trusting a best-effort push', async () => {
    const { application, listPendingMfaApprovals } = createApplication({ socketOpen: true })
    const notifier = new PendingMfaApprovalsNotifier(application)

    await jest.advanceTimersByTimeAsync(OPEN_INTERVAL - CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(OPEN_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)

    notifier.deinit()
  })

  it('polls every 20 s when no socket is open, where the poll is the only delivery path', async () => {
    const { application, listPendingMfaApprovals } = createApplication({ socketOpen: false })
    const notifier = new PendingMfaApprovalsNotifier(application)

    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL - 1)
    expect(listPendingMfaApprovals).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(1)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)

    notifier.deinit()
  })

  it('picks a closed socket up at the next tick rather than waiting out the open-socket cadence', async () => {
    const { application, state, listPendingMfaApprovals } = createApplication({ socketOpen: true })
    const notifier = new PendingMfaApprovalsNotifier(application)

    await jest.advanceTimersByTimeAsync(3 * CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).not.toHaveBeenCalled()

    state.socketOpen = false
    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    notifier.deinit()
  })

  it('skips ticks while hidden and polls at once on becoming visible, throttled to 5 s', async () => {
    const { application, listPendingMfaApprovals } = createApplication({ socketOpen: true })
    const notifier = new PendingMfaApprovalsNotifier(application)

    await setVisibility('hidden')
    await jest.advanceTimersByTimeAsync(2 * OPEN_INTERVAL)
    expect(listPendingMfaApprovals).not.toHaveBeenCalled()

    await setVisibility('visible')
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    await setVisibility('hidden')
    await jest.advanceTimersByTimeAsync(VISIBILITY_THROTTLE - 1)
    await setVisibility('visible')
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    await setVisibility('hidden')
    await jest.advanceTimersByTimeAsync(1)
    await setVisibility('visible')
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)

    notifier.deinit()
  })

  it('surfaces each pending approval once across the push frame and the poll', async () => {
    const { application, observers, listPendingMfaApprovals } = createApplication({ socketOpen: false })
    const notifier = new PendingMfaApprovalsNotifier(application)
    const approval = {
      challengeId: 'challenge-1',
      requestingUserAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0',
      requestingIpAddress: '203.0.113.9',
      expiresAt: Date.now() + 120_000,
    }

    await observers[0](WebSocketsServiceEvent.MfaApprovalRequested, approval)
    expect(addToast).toHaveBeenCalledTimes(1)

    listPendingMfaApprovals.mockResolvedValueOnce({
      status: 200,
      data: { pendingApprovals: [approval, { ...approval, challengeId: 'challenge-2' }] },
    })
    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)
    expect(addToast).toHaveBeenCalledTimes(2)
    expect(addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'New sign-in awaiting your approval', autoClose: false }),
    )

    notifier.deinit()
  })

  it('never polls without a signed-in user', async () => {
    const { application, listPendingMfaApprovals } = createApplication({ socketOpen: false, signedIn: false })
    const notifier = new PendingMfaApprovalsNotifier(application)

    await jest.advanceTimersByTimeAsync(OPEN_INTERVAL)
    await setVisibility('hidden')
    await setVisibility('visible')
    expect(listPendingMfaApprovals).not.toHaveBeenCalled()

    notifier.deinit()
  })

  it('deinit stops the safety net, the visibility wake and the socket observer', async () => {
    const { application, socketDisposer, listPendingMfaApprovals } = createApplication({ socketOpen: false })
    const notifier = new PendingMfaApprovalsNotifier(application)

    notifier.deinit()
    expect(socketDisposer).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(2 * OPEN_INTERVAL)
    await setVisibility('hidden')
    await setVisibility('visible')
    expect(listPendingMfaApprovals).not.toHaveBeenCalled()
  })
})
