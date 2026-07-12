/**
 * @jest-environment jsdom
 *
 * Sync pane — RENDER guard for the subtab restructure (t52).
 *
 * The Sync pane was split from one long stacked column into three subtabs
 * (Overview / Selective sync / Conflicts) built with PreferencesSubtabs. tsc +
 * the pure syncSummary/syncStatus unit tests staying green does NOT prove the
 * pane actually renders its tab bar and mounts a panel — a mis-wired tab array
 * or a subtab whose content throws would compile fine yet render blank. This
 * spec drives the REAL <Sync> in jsdom and pins:
 *   (a) all three subtab titles appear in the tab bar;
 *   (b) the default (Overview) panel mounts non-empty — the primary "Sync now"
 *       action is present;
 *   (c) clicking a second tab (Conflicts) swaps the mounted panel content.
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring TrustedDevices.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: () => undefined,
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

jest.mock('@/Achievements', () => ({
  achievements: { increment: () => undefined },
  METRICS: { manualSyncTotal: 'manualSyncTotal' },
}))

// Deterministic connectivity: a signed-in, connected account so the Overview
// card resolves to "Connected" and the "Sync now" action is enabled.
jest.mock('@/Hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({ kind: 'online', signedOut: false, lastSyncDate: undefined }),
}))

jest.mock('@/Utils/ManualSyncSetting', () => ({
  getManualSyncModeEnabled: () => false,
  setManualSyncModeEnabled: () => undefined,
  subscribeManualSyncMode: () => () => undefined,
}))

// The Conflicts child owns the third subtab; it pulls in the whole sync-conflict
// service surface, unrelated to proving the tab swaps. Stub it with a sentinel.
jest.mock('@/Components/Preferences/Panes/Conflicts/Conflicts', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'CONFLICTS_PANEL_SENTINEL'),
}))

import Sync from './Sync'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeApplication = () =>
  ({
    items: {
      getItems: () => [],
      streamItems: () => () => undefined,
      findItem: () => undefined,
    },
    addEventObserver: () => () => undefined,
    navigationController: {
      tagOrFolderHasAnyLocalOnlyNotes: () => false,
    },
    sync: {
      setManualSyncMode: () => undefined,
      sync: async () => undefined,
    },
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
    root.render(createElement(Sync, { application: makeApplication() }))
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

describe('Sync pane renders its three subtabs', () => {
  it('(a) shows all three subtab titles in the tab bar', async () => {
    await render()
    const titles = tabButtons().map((b) => (b.textContent ?? '').trim())
    expect(titles).toEqual(expect.arrayContaining(['Overview', 'Selective sync', 'Conflicts']))
    expect(tabButtons()).toHaveLength(3)
  })

  it('(b) mounts the default Overview panel with the primary Sync-now action', async () => {
    await render()
    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('Sync now')
  })

  it('(c) clicking Conflicts swaps the mounted panel content', async () => {
    await render()
    expect(container.textContent).toContain('Sync now')
    expect(container.textContent).not.toContain('CONFLICTS_PANEL_SENTINEL')

    await clickTab('Conflicts')

    // Only the active subtab's content is mounted, so Overview's action is gone
    // and the Conflicts panel is now present.
    expect(container.textContent).toContain('CONFLICTS_PANEL_SENTINEL')
    expect(container.textContent).not.toContain('Sync now')
  })
})
