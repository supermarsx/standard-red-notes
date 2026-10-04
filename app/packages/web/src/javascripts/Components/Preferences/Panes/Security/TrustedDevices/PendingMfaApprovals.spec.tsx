/**
 * @jest-environment jsdom
 *
 * PendingMfaApprovals — the inbox must stop re-GETting state the socket announces.
 *
 * This pane used to poll `/v1/pending-mfa-approvals` every 6 s for as long as it was
 * open, regardless of whether a websocket was already delivering the very events it
 * was looking for. Every state change it polled for is now pushed or computable:
 *
 *   - a new request          -> MFA_APPROVAL_REQUESTED
 *   - a decision elsewhere   -> MFA_APPROVAL_RESOLVED
 *   - expiry                 -> local arithmetic on `expiresAt`, no request at all
 *
 * so the poll drops to the same lost-push safety net the app-wide notifier runs.
 * These tests pin the three things that could silently rot:
 *   (a) an OPEN push lane really does stretch the cadence (it is not still 6 s);
 *   (b) NO push lane keeps the short cadence — the socket is an optimisation, never
 *       a dependency, so desktop/mobile/no-gateway must behave as before;
 *   (c) the cadence is re-decided on every tick, so a socket that drops mid-interval
 *       is noticed at the next SHORT tick rather than after a full long one;
 *   (d) a resolution and an expiry retire their row with ZERO extra requests.
 *
 * The repo has no @testing-library, so React is driven directly with
 * react-dom/client's createRoot + act (mirroring TrustedDevices.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

// Plain (non-jest.fn) functions: this workspace's jest config resets mocks before
// every test, which would wipe a jest.fn implementation and leave these returning
// undefined — `WebSocketsServiceEvent.MfaApprovalResolved` would become undefined
// and every frame assertion below would pass for the wrong reason.
jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (response: unknown) => Boolean((response as { error?: unknown })?.error),
  WebSocketsServiceEvent: {
    MfaApprovalRequested: 'MfaApprovalRequested',
    MfaApprovalResolved: 'MfaApprovalResolved',
  },
}))

import PendingMfaApprovals from './PendingMfaApprovals'
import {
  PENDING_MFA_APPROVALS_POLL_INTERVAL_MS,
  PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS,
  PendingMfaApproval,
} from './pendingMfaApproval'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CLOSED_INTERVAL = PENDING_MFA_APPROVALS_POLL_INTERVAL_MS
const OPEN_INTERVAL = PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS

type SocketObserver = (event: string, data?: unknown) => void

const buildApproval = (overrides: Partial<PendingMfaApproval> = {}): PendingMfaApproval => ({
  uuid: 'approval-uuid',
  challengeId: 'challenge-abc',
  status: 'pending',
  requestingUserAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
  requestingIpAddress: '203.0.113.7',
  createdAt: Date.now() - 1000,
  expiresAt: Date.now() + 120_000,
  ...overrides,
})

function makeApplication(options: { socketOpen?: boolean; approvals?: PendingMfaApproval[] } = {}) {
  const state = { socketOpen: options.socketOpen ?? false }
  const observers: SocketObserver[] = []
  const listPendingMfaApprovals = jest
    .fn()
    .mockImplementation(async () => ({ data: { pendingApprovals: options.approvals ?? [] } }))

  const application = {
    legacyApi: {
      listPendingMfaApprovals,
      resolvePendingMfaApproval: jest.fn().mockResolvedValue({ data: { status: 'approved' } }),
    },
    sockets: {
      isWebSocketConnectionOpen: () => state.socketOpen,
      addEventObserver: (observer: SocketObserver) => {
        observers.push(observer)
        return () => undefined
      },
    },
  }

  return { application, state, observers, listPendingMfaApprovals }
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  jest.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  jest.useRealTimers()
})

const render = async (application: unknown) => {
  await act(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.render(createElement(PendingMfaApprovals, { application: application as any }))
  })
}

const advance = async (ms: number) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

const deviceRowCount = () => container.querySelectorAll('button').length / 2

describe('PendingMfaApprovals poll cadence', () => {
  it('reads the inbox once on mount', async () => {
    const { application, listPendingMfaApprovals } = makeApplication({ socketOpen: true })

    await render(application)

    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)
  })

  it('(a) does not re-read for the whole long interval while the push lane is open', async () => {
    const { application, listPendingMfaApprovals } = makeApplication({ socketOpen: true })
    await render(application)

    // The old pane issued a request every 6 s; it would have made ~19 by now.
    await advance(OPEN_INTERVAL - CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    await advance(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)
  })

  it('(b) keeps the short cadence when there is no push lane at all', async () => {
    const { application, listPendingMfaApprovals } = makeApplication({ socketOpen: false })
    await render(application)

    await advance(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)

    await advance(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(3)
  })

  it('(b) treats a socket whose state cannot be read as having no push lane', async () => {
    const { application, listPendingMfaApprovals } = makeApplication({ socketOpen: true })
    application.sockets.isWebSocketConnectionOpen = () => {
      throw new Error('application still launching')
    }
    await render(application)

    await advance(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)
  })

  it('(c) notices a socket that drops mid-interval at the next short tick', async () => {
    const { application, state, listPendingMfaApprovals } = makeApplication({ socketOpen: true })
    await render(application)

    await advance(CLOSED_INTERVAL * 2)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    state.socketOpen = false
    await advance(CLOSED_INTERVAL)

    // Re-decided per tick: it did NOT wait out the remaining ~100 s of the long one.
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)
  })

  /**
   * Standard Red Notes (t103): the missing direction of (c). The pane normally mounts
   * while the push socket is still CONNECTING — the 101 takes tens of milliseconds and
   * the first tick is 20 s later — so `isWebSocketConnectionOpen()` is false at mount
   * in the ordinary case. Were the cadence captured once (at mount, or in an effect
   * whose dependencies omit the socket) the pane would re-read the inbox every 20 s for
   * as long as it stayed open, against a socket that opened milliseconds in.
   */
  it('(c) converges onto the long cadence when the push lane lands after mount', async () => {
    const { application, state, listPendingMfaApprovals } = makeApplication({ socketOpen: false })
    await render(application)

    // Precondition: it starts on the short cadence, so the long one proved below is a
    // change rather than the state it mounted in.
    await advance(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)

    state.socketOpen = true

    // Five further short ticks. A cadence frozen at mount would re-read on each.
    const frozenCadenceReads = 5
    expect(frozenCadenceReads).toBeGreaterThan(1)
    await advance(frozenCadenceReads * CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)

    await advance(CLOSED_INTERVAL)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(3)
  })

  it('re-reads immediately when a new approval request is pushed', async () => {
    const { application, observers, listPendingMfaApprovals } = makeApplication({ socketOpen: true })
    await render(application)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    await act(async () => {
      observers[0]('MfaApprovalRequested', { challengeId: 'challenge-new' })
    })

    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(2)
  })
})

describe('PendingMfaApprovals row retirement without a request', () => {
  it('(d) drops the row a resolved frame names, and makes no request to do it', async () => {
    const approval = buildApproval()
    const { application, observers, listPendingMfaApprovals } = makeApplication({
      socketOpen: true,
      approvals: [approval],
    })
    await render(application)

    expect(deviceRowCount()).toBe(1)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)

    await act(async () => {
      observers[0]('MfaApprovalResolved', { challengeId: approval.challengeId, status: 'approved' })
    })

    expect(deviceRowCount()).toBe(0)
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)
  })

  it('(d) leaves other rows alone when a resolved frame names a different challenge', async () => {
    const approval = buildApproval()
    const { application, observers } = makeApplication({ socketOpen: true, approvals: [approval] })
    await render(application)

    await act(async () => {
      observers[0]('MfaApprovalResolved', { challengeId: 'someone-elses-challenge', status: 'denied' })
    })

    expect(deviceRowCount()).toBe(1)
  })

  /**
   * The id is matched only when it ARRIVES as a string. The numeric 42 below would
   * stringify straight onto this row's own '42' id, so a frame whose id is coerced
   * rather than type-checked would retire a row it does not name.
   */
  it('(d) ignores a resolved frame whose challenge id is not a string', async () => {
    const approval = buildApproval({ challengeId: '42' })
    const { application, observers } = makeApplication({ socketOpen: true, approvals: [approval] })
    await render(application)

    expect(deviceRowCount()).toBe(1)

    await act(async () => {
      observers[0]('MfaApprovalResolved', { challengeId: 42 })
    })

    expect(deviceRowCount()).toBe(1)
  })

  it('(d) retires an expired row on the local clock, with no request', async () => {
    const approval = buildApproval({ expiresAt: Date.now() + 2000 })
    const { application, listPendingMfaApprovals } = makeApplication({
      socketOpen: true,
      approvals: [approval],
    })
    await render(application)

    expect(deviceRowCount()).toBe(1)

    await advance(1000)
    expect(deviceRowCount()).toBe(1)

    await advance(1500)
    expect(deviceRowCount()).toBe(0)
    // Expiry is arithmetic on data already held: the inbox was never re-read.
    expect(listPendingMfaApprovals).toHaveBeenCalledTimes(1)
  })
})
