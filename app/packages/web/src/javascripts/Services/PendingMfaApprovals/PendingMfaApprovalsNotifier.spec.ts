/**
 * `@standardnotes/snjs` resolves to its PREBUILT `dist/snjs.js` here, not to the
 * `@standardnotes/services` source the types come from. A member added to
 * `WebSocketsServiceEvent` therefore typechecks while being `undefined` at test
 * runtime until snjs is rebuilt — so a frame assertion written against the real enum
 * can pass for the wrong reason (comparing `undefined === undefined`) or fail on a
 * stale artifact. Mocking the two symbols this service uses makes the suite say what
 * it means regardless of build order, exactly as the sibling TrustedDevices and
 * PendingMfaApprovals specs already do.
 *
 * The literals below are the enum's own values; `isErrorResponse` keeps its real
 * contract (an explicit error field is an error, a 200 payload is not).
 */
jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (response: unknown) => Boolean((response as { error?: unknown })?.error),
  WebSocketsServiceEvent: {
    MfaApprovalRequested: 'MfaApprovalRequested',
    MfaApprovalResolved: 'MfaApprovalResolved',
  },
}))

import { WebSocketsServiceEvent } from '@standardnotes/snjs'
import { addToast, dismissToast } from '@standardnotes/toast'
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

  /**
   * Standard Red Notes (t103): the other direction of the same property, and the one
   * that was never pinned. A tab mounts while its push socket is still CONNECTING —
   * the 101 takes tens of milliseconds and the first tick is 20 s later, so this is
   * the ordinary case, not a corner — and `isWebSocketConnectionOpen()` is false at
   * that moment. If the cadence were sampled once (at construction, or in an effect
   * whose dependencies omit the socket) the tab would poll every 20 s for the life of
   * the page against a socket that opened milliseconds in. It is re-read per tick, and
   * this is what says so.
   */
  it('converges onto the open-socket cadence when the connection lands after it mounted', async () => {
    const { application, state, listPendingMfaApprovals } = createApplication({ socketOpen: false })
    const notifier = new PendingMfaApprovalsNotifier(application)

    // Precondition: it really is on the fast cadence to begin with, so the slow
    // cadence proved below is a change and not the starting state.
    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    // The socket finishes connecting.
    state.socketOpen = true

    // Five further ticks of the FAST interval. A cadence frozen at mount would have
    // polled on every one of them, so the count here is 1 or 6 — never ambiguous.
    const frozenCadencePolls = 5
    await jest.advanceTimersByTimeAsync(frozenCadencePolls * CLOSED_INTERVAL)
    expect(frozenCadencePolls).toBeGreaterThan(1)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    // ...and it polls once the OPEN cadence has elapsed since the last poll.
    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)

    // Settled, not a one-off: the next poll is another full open interval away.
    await jest.advanceTimersByTimeAsync(OPEN_INTERVAL - CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(3)

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

  /**
   * The other half of moving this off HTTP: once SOME trusted session answers the
   * request, auth pushes MFA_APPROVAL_RESOLVED to the account's sockets, so the
   * "awaiting your approval" toast this session raised can be retired without any
   * session re-reading the inbox.
   */
  describe('retiring a toast on the resolved push', () => {
    const approval = {
      challengeId: 'challenge-1',
      requestingUserAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0',
      requestingIpAddress: '203.0.113.9',
      expiresAt: Date.now() + 120_000,
    }

    it('dismisses the toast the resolved frame names', async () => {
      ;(addToast as jest.Mock).mockReturnValue('toast-for-challenge-1')
      const { application, observers } = createApplication({ socketOpen: true })
      const notifier = new PendingMfaApprovalsNotifier(application)

      await observers[0](WebSocketsServiceEvent.MfaApprovalRequested, approval)
      expect(addToast).toHaveBeenCalledTimes(1)
      expect(dismissToast).not.toHaveBeenCalled()

      await observers[0](WebSocketsServiceEvent.MfaApprovalResolved, {
        challengeId: approval.challengeId,
        status: 'approved',
      })

      expect(dismissToast).toHaveBeenCalledTimes(1)
      expect(dismissToast).toHaveBeenCalledWith('toast-for-challenge-1')

      notifier.deinit()
    })

    it('leaves a toast for a different challenge alone', async () => {
      ;(addToast as jest.Mock).mockReturnValue('toast-for-challenge-1')
      const { application, observers } = createApplication({ socketOpen: true })
      const notifier = new PendingMfaApprovalsNotifier(application)

      await observers[0](WebSocketsServiceEvent.MfaApprovalRequested, approval)
      await observers[0](WebSocketsServiceEvent.MfaApprovalResolved, { challengeId: 'someone-elses' })

      expect(dismissToast).not.toHaveBeenCalled()

      notifier.deinit()
    })

    /**
     * The id is matched only when it ARRIVES as a string. The numeric 42 below would
     * stringify onto the '42' key the toast is held under, so a frame whose id is
     * coerced rather than type-checked would dismiss a toast it does not name.
     */
    it('ignores a resolved frame whose challenge id is not a string', async () => {
      ;(addToast as jest.Mock).mockReturnValue('toast-for-challenge-42')
      const { application, observers } = createApplication({ socketOpen: true })
      const notifier = new PendingMfaApprovalsNotifier(application)

      await observers[0](WebSocketsServiceEvent.MfaApprovalRequested, { ...approval, challengeId: '42' })
      expect(addToast).toHaveBeenCalledTimes(1)

      await observers[0](WebSocketsServiceEvent.MfaApprovalResolved, { challengeId: 42 })

      expect(dismissToast).not.toHaveBeenCalled()

      notifier.deinit()
    })

    it('keeps the challenge remembered, so a stale poll cannot re-toast a settled request', async () => {
      ;(addToast as jest.Mock).mockReturnValue('toast-for-challenge-1')
      const { application, observers, listPendingMfaApprovals } = createApplication({ socketOpen: false })
      const notifier = new PendingMfaApprovalsNotifier(application)

      await observers[0](WebSocketsServiceEvent.MfaApprovalRequested, approval)
      await observers[0](WebSocketsServiceEvent.MfaApprovalResolved, { challengeId: approval.challengeId })

      listPendingMfaApprovals.mockResolvedValueOnce({ status: 200, data: { pendingApprovals: [approval] } })
      await jest.advanceTimersByTimeAsync(CLOSED_INTERVAL)

      expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)
      expect(addToast).toHaveBeenCalledTimes(1)

      notifier.deinit()
    })
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
