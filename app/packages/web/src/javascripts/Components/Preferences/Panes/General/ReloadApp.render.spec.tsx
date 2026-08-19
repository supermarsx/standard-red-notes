/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: RENDER + wiring guard for the "Reload app and clear
 * cached files" control (t97).
 *
 * This repo has twice shipped preferences UI that typechecked, unit-tested
 * clean, and never actually appeared. So this spec does not stop at the leaf
 * component: it also mounts the REAL <General> pane and proves the control is
 * reachable in its default subtab, which is the thing a user has to be able to
 * find. It further pins that the confirmation copy tells the truth about the
 * safety boundary (notes/account unaffected) and that the offline consequence
 * is surfaced.
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring Sync.render.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

const alerts = { confirm: jest.fn(), alert: jest.fn() }

const application = {
  alerts,
  version: '3.201.28',
} as unknown as import('@/Application/WebApplication').WebApplication

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => application,
}))

const clearCalls: unknown[] = []
jest.mock('@/Utils/AppCacheReset', () => ({
  SHELL_CACHE_PREFIX: 'srn-shell-',
  reloadApplicationClearingCaches: (...args: unknown[]) => {
    clearCalls.push(args)
    return Promise.resolve({ deletedCaches: [], preservedCaches: [], unregisteredWorkers: 0 })
  },
}))

// The other children of the General subtab pull in unrelated service surface.
// Stub them with sentinels; the pane's own composition is what is under test.
jest.mock('./Language', () => ({ __esModule: true, default: () => createElement('div', null, 'LANGUAGE') }))
jest.mock('./Persistence', () => ({ __esModule: true, default: () => createElement('div', null, 'PERSISTENCE') }))
jest.mock('./TimezonePreference', () => ({ __esModule: true, default: () => createElement('div', null, 'TIMEZONE') }))
jest.mock('./Updates', () => ({ __esModule: true, default: () => createElement('div', null, 'UPDATES') }))

import ReloadApp from './ReloadApp'
import General from './General'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BUTTON_LABEL = 'Reload app and clear cached files'

let container: HTMLElement
let root: Root

const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online })
}

beforeEach(() => {
  clearCalls.length = 0
  alerts.confirm.mockReset().mockResolvedValue(true)
  alerts.alert.mockReset().mockResolvedValue(undefined)
  setOnline(true)
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

const render = async (element: Parameters<typeof createElement>[0]) => {
  await act(async () => {
    root.render(createElement(element))
  })
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

describe('ReloadApp control renders and is reachable', () => {
  it('mounts with an actionable button and honest copy about what is NOT cleared', async () => {
    await render(ReloadApp)

    expect(findButton(BUTTON_LABEL)).toBeDefined()
    expect(findButton(BUTTON_LABEL)?.hasAttribute('disabled')).toBe(false)

    const text = container.textContent ?? ''
    expect(text).toContain('Your notes and account are not affected.')
    expect(text).toContain('haven')
    expect(text).toContain('You will not be signed out.')
  })

  it('is reachable in the REAL General pane default subtab, not just standalone', async () => {
    await render(General)

    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel).not.toBeNull()
    // The sibling sentinels prove we are looking at the General subtab.
    expect(panel?.textContent).toContain('UPDATES')
    expect(panel?.textContent).toContain(BUTTON_LABEL)
    expect(findButton(BUTTON_LABEL)).toBeDefined()
  })

  it('confirms before clearing, and the confirmation states the safety boundary', async () => {
    await render(ReloadApp)
    await clickButton(BUTTON_LABEL)

    expect(alerts.confirm).toHaveBeenCalledTimes(1)
    const [body, title, confirmLabel] = alerts.confirm.mock.calls[0]
    expect(title).toBe('Reload app and clear cached files?')
    expect(confirmLabel).toBe('Reload app')
    expect(body).toContain('cached program files')
    expect(body).toContain('are NOT affected')
    expect(body).not.toContain('offline')

    expect(clearCalls).toHaveLength(1)
  })

  it('does nothing at all when the confirmation is declined', async () => {
    alerts.confirm.mockResolvedValue(false)
    await render(ReloadApp)
    await clickButton(BUTTON_LABEL)

    expect(clearCalls).toHaveLength(0)
  })

  it('warns inline and in the confirmation when offline', async () => {
    setOnline(false)
    await render(ReloadApp)

    const warning = container.querySelector('[data-test="reload-app-offline-warning"]')
    expect(warning).not.toBeNull()
    expect(warning?.textContent).toContain('may not load again until you reconnect')

    await clickButton(BUTTON_LABEL)

    const [body] = alerts.confirm.mock.calls[0]
    expect(body).toContain('You appear to be offline.')
    // Still offered — a user whose app is broken by a bad cache must not be
    // locked out of the only fix.
    expect(clearCalls).toHaveLength(1)
  })

  it('reacts to going offline while the pane is open', async () => {
    await render(ReloadApp)
    expect(container.querySelector('[data-test="reload-app-offline-warning"]')).toBeNull()

    setOnline(false)
    await act(async () => {
      window.dispatchEvent(new Event('offline'))
    })

    expect(container.querySelector('[data-test="reload-app-offline-warning"]')).not.toBeNull()
  })
})
