/**
 * @jest-environment jsdom
 *
 * Invite pane — RENDER + wiring guard (t69 §7.5). tsc + the pure inviteLinks unit
 * tests staying green does NOT prove the pane mounts (memory: web tsc-green ≠
 * renders — a special-cased group has vanished before). This spec drives the REAL
 * <Invite> in jsdom against a mocked legacyApi and pins:
 *   (a) the create form mounts with ONLY max-uses / expiry / label — NEVER a role
 *       or domain field (the self-serve privilege guard, surfaced in the UI);
 *   (b) the quota ("Using X of Y") and the user's own links table render;
 *   (c) creating fires createMyInviteLink and reveals the one-time absolute URL;
 *   (d) revoking (after confirm) fires revokeMyInviteLink;
 *   (e) list is fetched on mount.
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring TrustedDevices.spec). Only
 * @standardnotes/toast is mocked; the real snjs (isErrorResponse, classNames) is
 * used so the response gating matches production.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

import Invite from './Invite'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TOKEN = 'a'.repeat(64)

const listResponse = () => ({
  status: 200,
  data: {
    invitesPerUser: 3,
    invitedCount: 4,
    inviteLinks: [
      {
        uuid: 'link-1',
        label: 'Study group',
        maxUses: 3,
        usedCount: 1,
        remainingUses: 2,
        expiresAt: null,
        revoked: false,
        status: 'active',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  },
})

const createResponse = () => ({
  status: 200,
  data: {
    inviteLink: {
      uuid: 'link-2',
      label: null,
      maxUses: 1,
      usedCount: 0,
      remainingUses: 1,
      expiresAt: null,
      revoked: false,
      status: 'active',
      createdAt: '2026-07-11T00:00:00.000Z',
      token: TOKEN,
      path: `/?invite=${TOKEN}`,
    },
  },
})

type MockApplication = {
  legacyApi: {
    listMyInviteLinks: jest.Mock
    createMyInviteLink: jest.Mock
    revokeMyInviteLink: jest.Mock
  }
  alerts: { confirm: jest.Mock }
}

const makeApplication = (overrides: Partial<MockApplication['legacyApi']> = {}): MockApplication => ({
  legacyApi: {
    listMyInviteLinks: jest.fn().mockResolvedValue(listResponse()),
    createMyInviteLink: jest.fn().mockResolvedValue(createResponse()),
    revokeMyInviteLink: jest.fn().mockResolvedValue({ status: 200, data: { success: true } }),
    ...overrides,
  },
  alerts: { confirm: jest.fn().mockResolvedValue(true) },
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
    root.render(createElement(Invite, { application: application as any }))
  })
  // Flush the list fetch's state updates.
  await act(async () => {})
}

const findButton = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text))

const clickButton = async (text: string) => {
  const button = findButton(text)
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('Invite pane renders + wires the self-serve flow', () => {
  it("(e) fetches the caller's links on mount", async () => {
    const application = makeApplication()
    await renderWith(application)
    expect(application.legacyApi.listMyInviteLinks).toHaveBeenCalledTimes(1)
  })

  it('(a) mounts the create form with ONLY max-uses / expiry / label — no role or domain field', async () => {
    await renderWith(makeApplication())

    const ariaLabels = Array.from(container.querySelectorAll('input')).map((i) => i.getAttribute('aria-label') ?? '')
    expect(ariaLabels.join(' | ').toLowerCase()).toContain('maximum number of signups')
    expect(ariaLabels.join(' | ').toLowerCase()).toContain('hours until this link expires')
    expect(ariaLabels.join(' | ').toLowerCase()).toContain('optional label')

    // Privilege guard: a user link can never set a role or domain, so the UI
    // must not offer those inputs.
    const haystack = (container.textContent ?? '').toLowerCase() + ' ' + ariaLabels.join(' ').toLowerCase()
    expect(haystack).not.toContain('role')
    expect(haystack).not.toContain('domain')
  })

  it("(b) renders the quota and the user's own links table", async () => {
    await renderWith(makeApplication())
    const text = container.textContent ?? ''
    expect(text).toContain('Using')
    expect(text).toContain('of')
    expect(text).toContain('Study group')
    expect(text).toContain('1/3')
    expect(text).toContain('Active')
    // Attribution
    expect(text).toContain('invited')
  })

  it('(c) creating fires createMyInviteLink and reveals the one-time absolute URL', async () => {
    const application = makeApplication()
    await renderWith(application)

    await clickButton('Create invite link')

    expect(application.legacyApi.createMyInviteLink).toHaveBeenCalledTimes(1)
    expect(application.legacyApi.createMyInviteLink).toHaveBeenCalledWith({
      maxUses: 1,
      expiresInHours: null,
      label: null,
    })
    // The one-time URL is composed from window.location.origin + the returned path.
    expect(container.textContent ?? '').toContain(`/?invite=${TOKEN}`)
    // And the list is refreshed after a successful create.
    expect(application.legacyApi.listMyInviteLinks).toHaveBeenCalledTimes(2)
  })

  it('(d) revoking (after confirm) fires revokeMyInviteLink', async () => {
    const application = makeApplication()
    await renderWith(application)

    await clickButton('Revoke')

    expect(application.alerts.confirm).toHaveBeenCalledTimes(1)
    expect(application.legacyApi.revokeMyInviteLink).toHaveBeenCalledWith('link-1')
  })
})

describe('Invite pane — disabled fallback', () => {
  it('shows an "unavailable" message when the server reports self-serve off', async () => {
    const application = makeApplication({
      listMyInviteLinks: jest.fn().mockResolvedValue({ status: 200, data: { invitesPerUser: 0, inviteLinks: [] } }),
    })
    await renderWith(application)
    expect(container.textContent ?? '').toContain('not currently available')
  })
})
