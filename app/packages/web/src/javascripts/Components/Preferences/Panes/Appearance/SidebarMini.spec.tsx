/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: the "Mini tags panel" Preferences card (t111 §3 row 3).
 *
 * The point of this spec is the MIRROR. The same switch already exists in the
 * quick settings menu, and two switches over one feature is only safe while they
 * share one stored value. So the assertions are about the store, not the pixels:
 * the key written is the key the other surface imports, the device-local store is
 * the one used, and an absent value renders OFF (because the pinned key has no
 * `LocalPrefDefaults` entry yet, so the hook's default arrives as `undefined`).
 */
import { ApplicationEvent } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { NAVIGATION_PANE_MINI_PREF_KEY } from '@/Components/Tags/navigationMini'

type Harness = {
  application: import('@/Application/WebApplication').WebApplication
  local: Map<string, unknown>
  setLocalValue: jest.Mock
}

let harness: Harness

const buildHarness = (initial: [string, unknown][] = []) => {
  const local = new Map<string, unknown>(initial)
  const observers: (() => Promise<void>)[] = []

  const setLocalValue = jest.fn((key: string, value: unknown) => {
    local.set(key, value)
    for (const observer of observers) {
      void observer()
    }
  })

  const application = {
    preferences: {
      // Mirrors the real store: an unknown key yields the supplied default, which
      // for this pinned key is `LocalPrefDefaults[key]` === undefined.
      getLocalValue: (key: string, defaultValue?: unknown) => (local.has(key) ? local.get(key) : defaultValue),
      setLocalValue,
    },
    addEventObserver: (callback: () => Promise<void>, event: ApplicationEvent) => {
      if (event === ApplicationEvent.LocalPreferencesChanged) {
        observers.push(callback)
      }
      return () => undefined
    },
  } as unknown as import('@/Application/WebApplication').WebApplication

  harness = { application, local, setLocalValue }
  return harness
}

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => harness.application,
}))

import SidebarMini from './SidebarMini'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async () => {
  await act(async () => {
    root.render(createElement(SidebarMini))
  })
  await act(async () => {})
}

const switchInput = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')

describe('the mini tags panel switch', () => {
  it('renders OFF when nothing is stored — undefined must mean off, not missing', async () => {
    buildHarness()
    await render()

    expect(container.querySelector('[data-test="sidebar-mini-setting"]')).not.toBeNull()
    expect(switchInput()?.checked).toBe(false)
  })

  it('renders ON only for a literal stored `true`', async () => {
    buildHarness([['navigationPaneMini', true]])
    await render()
    expect(switchInput()?.checked).toBe(true)
  })

  it('does not coerce a non-boolean stored value into ON', async () => {
    buildHarness([['navigationPaneMini', 'yes']])
    await render()
    expect(switchInput()?.checked).toBe(false)
  })

  it('writes to the DEVICE-LOCAL store under the key the quick settings menu imports', async () => {
    buildHarness()
    await render()

    await act(async () => {
      switchInput()?.click()
    })
    await act(async () => {})

    expect(harness.setLocalValue).toHaveBeenCalledWith(NAVIGATION_PANE_MINI_PREF_KEY, true)
    // The literal is the mirror: `QuickSettingsMenu/PanelSettingsSection.tsx`
    // imports this same constant, so there is one stored value, not two.
    expect(String(NAVIGATION_PANE_MINI_PREF_KEY)).toBe('navigationPaneMini')
    expect(harness.local.get('navigationPaneMini')).toBe(true)
    expect(switchInput()?.checked).toBe(true)
  })

  it('states that it is per-device and names the other surface', async () => {
    buildHarness()
    await render()

    const text = container.textContent ?? ''
    expect(text).toContain('not synced to your other')
    expect(text).toContain('quick settings menu')
    // The rail width comes from the shared constant, not a second literal.
    expect(text).toContain('48px rail of icons')
  })
})
