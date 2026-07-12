/**
 * @jest-environment jsdom
 *
 * Sharing pane — RENDER guard for the unification into subtabs (t52).
 *
 * The standalone "Share Links" pane was folded into Sharing as a second subtab,
 * so Sharing is now a two-subtab shell (Shared vaults / Share links) built with
 * PreferencesSubtabs. tsc staying green does NOT prove the shell renders both
 * tabs and mounts a panel. This spec drives the REAL <Sharing> in jsdom and
 * pins:
 *   (a) both subtab titles appear in the tab bar;
 *   (b) the default (Shared vaults) panel mounts non-empty — here the signed-out
 *       gate message, proving the Shared-vaults content renders;
 *   (c) clicking "Share links" swaps to the reused Shares panel.
 *
 * Rendering with hasAccount()=false takes the Shared-vaults subtab's built-in
 * signed-out gate, which needs no live vault data — the goal is the tab-bar +
 * panel path, not re-testing the collaboration overview. The Shares child is
 * stubbed with a sentinel (its own render is covered elsewhere).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: () => undefined,
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

// The Share links subtab reuses the standalone Shares pane as-is; stub it with a
// sentinel so we can assert the tab swap without its legacyApi surface.
jest.mock('../Shares/Shares', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'SHARE_LINKS_PANEL_SENTINEL'),
}))

import Sharing from './Sharing'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// hasAccount:false → the Shared-vaults subtab renders its signed-out gate and
// needs no live vault data. The remaining stubs only keep the (still-mounted)
// effects from throwing; they resolve to empty.
const makeApplication = () =>
  ({
    hasAccount: () => false,
    getUserVersion: () => undefined,
    featuresController: { isEntitledToSharedVaults: () => false },
    sessions: { getUser: () => ({ uuid: 'self' }) },
    contacts: { getAllContacts: () => [] },
    vaultInvites: {
      getCachedPendingInviteRecords: () => [],
      downloadInboundInvites: async () => undefined,
      addEventObserver: () => () => undefined,
    },
    vaultUsers: { addEventObserver: () => () => undefined },
    vaults: { getVaults: () => [] },
    items: { items: [], streamItems: () => () => undefined },
    preferencesController: { openPreferences: () => undefined },
  }) as unknown as import('@/Application/WebApplication').WebApplication

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

const render = async () => {
  await act(async () => {
    root.render(createElement(Sharing, { application: makeApplication() }))
  })
}

const tabButtons = () => Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[]

const clickTab = async (title: string) => {
  const tab = tabButtons().find((b) => (b.textContent ?? '').includes(title))
  expect(tab).toBeDefined()
  await act(async () => {
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('Sharing pane renders its two subtabs', () => {
  it('(a) shows both subtab titles in the tab bar', async () => {
    await render()
    const titles = tabButtons().map((b) => (b.textContent ?? '').trim())
    expect(titles).toEqual(expect.arrayContaining(['Shared vaults', 'Share links']))
    expect(tabButtons()).toHaveLength(2)
  })

  it('(b) mounts the default Shared-vaults panel non-empty', async () => {
    await render()
    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel).not.toBeNull()
    // The signed-out gate content proves the Shared-vaults subtab body rendered.
    expect(panel?.textContent).toContain('Sign in to an account')
  })

  it('(c) clicking Share links swaps to the reused Shares panel', async () => {
    await render()
    expect(container.textContent).not.toContain('SHARE_LINKS_PANEL_SENTINEL')

    await clickTab('Share links')

    expect(container.textContent).toContain('SHARE_LINKS_PANEL_SENTINEL')
  })
})
