/**
 * @jest-environment jsdom
 *
 * TrustedDevices — security guarantee for "Trust this device":
 *  Trusting a device weakens the second factor for this browser, so it MUST be
 *  gated behind the user's account-password re-verification. These tests pin
 *  that gate:
 *   (a) if the account-password challenge is cancelled/failed
 *       (promptForAccountPassword → null), the device is NOT trusted
 *       (createTrustedDevice is never called);
 *   (b) only after a correct password (promptForAccountPassword → the password)
 *       does the trust request go through.
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring ComponentErrorBoundary.spec).
 */
import { createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

// isErrorResponse is the only snjs symbol TrustedDevices relies on directly;
// treat a response as an error only when it carries an explicit error field.
jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (response: unknown) => Boolean((response as { error?: unknown })?.error),
  WebSocketsServiceEvent: { MfaApprovalRequested: 'MfaApprovalRequested' },
}))

// The pending-approvals child polls + subscribes to websockets; it is unrelated
// to the trust gate, so stub it out to keep the test deterministic.
jest.mock('./PendingMfaApprovals', () => ({ __esModule: true, default: () => null }))

// Plain (non-jest.fn) functions: the repo's jest config resets mocks before
// each test, which would wipe a jest.fn implementation and make
// getTrustedDeviceToken() return undefined (→ "this device" wrongly shown as
// already trusted, hiding the button under test).
jest.mock('./trustedDeviceStorage', () => ({
  getTrustedDeviceToken: () => null,
  persistTrustedDeviceToken: () => undefined,
  clearTrustedDeviceToken: () => undefined,
}))

jest.mock('@/Achievements', () => ({
  achievements: { markEvent: () => undefined },
  METRICS: { trustedDeviceAdded: 'trustedDeviceAdded' },
}))

import TrustedDevices from './TrustedDevices'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type MockApplication = {
  legacyApi: {
    listTrustedDevices: jest.Mock
    createTrustedDevice: jest.Mock
    deleteTrustedDevice: jest.Mock
  }
  challenges: { promptForAccountPassword: jest.Mock }
  alerts: { confirm: jest.Mock }
}

const makeApplication = (promptResult: string | null): MockApplication => ({
  legacyApi: {
    listTrustedDevices: jest.fn().mockResolvedValue({ data: { trustedDevices: [] } }),
    createTrustedDevice: jest.fn().mockResolvedValue({ data: { trustedDevice: { token: 'trust-token' } } }),
    deleteTrustedDevice: jest.fn(),
  },
  challenges: { promptForAccountPassword: jest.fn().mockResolvedValue(promptResult) },
  alerts: { confirm: jest.fn() },
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const renderWith = async (application: MockApplication) => {
  await act(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.render(createElement(TrustedDevices, { application: application as any }))
  })
}

const clickTrustButton = async () => {
  const button = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('Trust this device'),
  )
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('TrustedDevices — Trust this device requires account-password verification', () => {
  it('(a) does NOT trust the device when the password challenge is cancelled/failed', async () => {
    const application = makeApplication(null)
    await renderWith(application)

    await clickTrustButton()

    expect(application.challenges.promptForAccountPassword).toHaveBeenCalledTimes(1)
    // The gate aborted: no trust request was ever sent.
    expect(application.legacyApi.createTrustedDevice).not.toHaveBeenCalled()
  })

  it('(b) trusts the device only after the account password is verified', async () => {
    const application = makeApplication('correct-account-password')
    await renderWith(application)

    await clickTrustButton()

    expect(application.challenges.promptForAccountPassword).toHaveBeenCalledTimes(1)
    // Password verified → the trust request proceeds.
    expect(application.legacyApi.createTrustedDevice).toHaveBeenCalledTimes(1)
  })
})
