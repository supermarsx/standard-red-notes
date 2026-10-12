/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: the "Collapse the toolbar in Super notes" switch in
 * Preferences → General → "Notes & editor".
 *
 * The setting defaults to OFF, which makes the easy tests worthless: a switch
 * that renders unchecked and a toolbar that does not hide both look correct
 * with the preference completely unwired. So this file is about the things that
 * only hold if the wiring is real — the switch writes `true` under the exact
 * key the toolbar reads, it reflects a stored `true`, and it says so honestly
 * when it has nothing to act on.
 *
 * That last one matters. Auto-hide belongs to the always-visible toolbar; with
 * that setting off the toolbar is already a floating one that appears only on a
 * selection, and there is nothing to hide. A switch that still accepted clicks
 * there would be a control that silently does nothing, so it is disabled and
 * explains itself instead.
 *
 * Everything is asserted on ELEMENTS (the checkbox, the heading, the note), not
 * on the pane's text: the description of this setting mentions the toolbar, the
 * bar and the shortcut, and would satisfy a text search with the switch deleted.
 *
 * The last describe block is the VANISH GUARD: preferences UI has shipped here
 * that typechecked, tested clean and appeared nowhere, so the real <General>
 * pane is mounted and its "Notes & editor" subtab actually opened.
 */
import { ApplicationEvent, PrefKey } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY } from '@/Components/SuperEditor/Plugins/ToolbarPlugin/ToolbarAutoHidePreference'

type Harness = {
  application: import('@/Application/WebApplication').WebApplication
  prefs: Map<string, unknown>
  setPreference: jest.Mock
}

let harness: Harness
let mockMobileLayout = false

const AUTO_HIDE_KEY = SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY as unknown as string

const buildHarness = (initial: [string, unknown][] = []) => {
  const prefs = new Map<string, unknown>(initial)
  const observers: (() => Promise<void>)[] = []

  const setPreference = jest.fn(async (key: string, value: unknown) => {
    prefs.set(key, value)
    for (const observer of observers) {
      await observer()
    }
  })

  const application = {
    getPreference: (key: string, defaultValue?: unknown) => {
      if (prefs.has(key)) {
        return prefs.get(key)
      }
      // The always-visible toolbar defaults ON, as it does in the app.
      if (key === PrefKey.AlwaysShowSuperToolbar) {
        return true
      }
      return defaultValue
    },
    setPreference,
    addEventObserver: (callback: () => Promise<void>, event: ApplicationEvent) => {
      if (event === ApplicationEvent.PreferencesChanged) {
        observers.push(callback)
      }
      return () => undefined
    },
    platform: 99,
    getValue: () => undefined,
    setValue: () => undefined,
    preferences: { getLocalValue: (_k: unknown, d?: unknown) => d, setLocalValue: () => undefined },
    featuresController: {},
  } as unknown as import('@/Application/WebApplication').WebApplication

  harness = { application, prefs, setPreference }
  return harness
}

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => harness.application,
}))

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockMobileLayout,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
  MediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

// The image-alignment dropdown shares the card and is not the subject here.
jest.mock('@/Components/Dropdown/Dropdown', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'DROPDOWN'),
}))

// Siblings of the card in the real pane pull in unrelated service surface.
// Sentinels: the pane's COMPOSITION is what the vanish guard is about.
jest.mock('./Language', () => ({ __esModule: true, default: () => createElement('div', null, 'LANGUAGE') }))
jest.mock('./Persistence', () => ({ __esModule: true, default: () => createElement('div', null, 'PERSISTENCE') }))
jest.mock('./TimezonePreference', () => ({ __esModule: true, default: () => createElement('div', null, 'TIMEZONE') }))
jest.mock('./SyncConnection', () => ({ __esModule: true, default: () => createElement('div', null, 'SYNCCONN') }))
jest.mock('./Updates', () => ({ __esModule: true, default: () => createElement('div', null, 'UPDATES') }))
jest.mock('./ReloadApp', () => ({ __esModule: true, default: () => createElement('div', null, 'RELOADAPP') }))
jest.mock('./NewNoteDefaults', () => ({ __esModule: true, default: () => createElement('div', null, 'NEWNOTE') }))
jest.mock('./TodoHeadings', () => ({ __esModule: true, default: () => createElement('div', null, 'TODOHEADINGS') }))
jest.mock('./ChecklistRecurrence', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'RECURRENCE'),
}))
jest.mock('./MermaidSourceHighlighting', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'MERMAID'),
}))
jest.mock('./Spellcheck', () => ({ __esModule: true, default: () => createElement('div', null, 'SPELLCHECK') }))
jest.mock('./SmartViews/SmartViews', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'SMARTVIEWS'),
}))

import Defaults from './Defaults'
import General from './General'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  mockMobileLayout = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.matchMedia =
    window.matchMedia ??
    (((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const renderCard = async () => {
  await act(async () => {
    root.render(createElement(Defaults, { application: harness.application }))
  })
  await act(async () => {})
}

const ALWAYS_VISIBLE_HEADING = 'Use always-visible toolbar in Super notes'
const AUTO_HIDE_HEADING = 'Collapse the toolbar in Super notes'

/** The row a switch lives in, found by its HEADING ELEMENT's exact text. */
const rowByHeading = (scope: ParentNode, heading: string) => {
  const element = Array.from(scope.querySelectorAll('h4')).find((candidate) => candidate.textContent === heading)
  return element?.parentElement?.parentElement ?? null
}
const autoHideRow = (scope: ParentNode = container) =>
  scope.querySelector<HTMLElement>('[data-test="super-toolbar-auto-hide-setting"]')
const autoHideSwitch = (scope: ParentNode = container) =>
  autoHideRow(scope)?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
const unavailableNote = (scope: ParentNode = container) =>
  autoHideRow(scope)?.querySelector('[data-test="super-toolbar-auto-hide-unavailable"]') ?? null

const click = async (element: HTMLElement | null) => {
  await act(async () => {
    element?.click()
  })
  await act(async () => {})
}

describe('the auto-hide switch', () => {
  it('is a real switch, in the row with its own heading', async () => {
    buildHarness()
    await renderCard()

    const row = autoHideRow()
    expect(row).not.toBeNull()
    expect(rowByHeading(container, AUTO_HIDE_HEADING)).toBe(row)
    expect(autoHideSwitch()).not.toBeNull()
    expect(autoHideSwitch()?.type).toBe('checkbox')
    // Exactly one control in the row: the description must not grow a second.
    expect(row?.querySelectorAll('input, button, select')).toHaveLength(1)
  })

  it('sits directly after the always-visible toolbar switch, so the two settings read together', async () => {
    buildHarness()
    await renderCard()

    const switches = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const alwaysVisible = rowByHeading(container, ALWAYS_VISIBLE_HEADING)?.querySelector('input[type="checkbox"]')
    expect(alwaysVisible).toBeDefined()
    expect(alwaysVisible).not.toBeNull()
    const index = switches.indexOf(alwaysVisible as HTMLInputElement)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(switches[index + 1]).toBe(autoHideSwitch())
  })

  it('is off when nothing is stored', async () => {
    buildHarness()
    await renderCard()
    expect(autoHideSwitch()?.checked).toBe(false)
  })

  it('is off for every stored value except an explicit true', async () => {
    // A synced value: another client may have written anything.
    for (const stored of [false, null, 'true', 1, {}, []]) {
      buildHarness([[AUTO_HIDE_KEY, stored]])
      await renderCard()
      expect(autoHideSwitch()?.checked).toBe(false)
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('is on when true is stored under the key the toolbar reads', async () => {
    buildHarness([[AUTO_HIDE_KEY, true]])
    await renderCard()
    expect(autoHideSwitch()?.checked).toBe(true)
    // Not just any key: the same value one character off must not turn it on.
    act(() => root.unmount())
    root = createRoot(container)
    buildHarness([['superToolbarAutohide', true]])
    await renderCard()
    expect(autoHideSwitch()?.checked).toBe(false)
  })

  it('writes true under that key when switched on, and false when switched off again', async () => {
    buildHarness()
    await renderCard()

    await click(autoHideSwitch())
    expect(harness.setPreference).toHaveBeenCalledTimes(1)
    expect(harness.setPreference).toHaveBeenLastCalledWith('superToolbarAutoHide', true)
    // The write is announced and the switch re-reads it: this is the live path.
    expect(autoHideSwitch()?.checked).toBe(true)

    await click(autoHideSwitch())
    expect(harness.setPreference).toHaveBeenCalledTimes(2)
    expect(harness.setPreference).toHaveBeenLastCalledWith('superToolbarAutoHide', false)
    expect(autoHideSwitch()?.checked).toBe(false)
  })

  it('does not touch the always-visible toolbar setting', async () => {
    buildHarness()
    await renderCard()
    await click(autoHideSwitch())
    expect(harness.setPreference.mock.calls.map(([key]) => key)).toEqual(['superToolbarAutoHide'])
    expect(
      rowByHeading(container, ALWAYS_VISIBLE_HEADING)?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.checked,
    ).toBe(true)
  })
})

describe('when the always-visible toolbar is off, so there is nothing to auto-hide', () => {
  it('disables the switch and says why', async () => {
    buildHarness([[PrefKey.AlwaysShowSuperToolbar, false]])
    await renderCard()

    expect(autoHideSwitch()?.disabled).toBe(true)
    expect(unavailableNote()).not.toBeNull()
    expect(unavailableNote()?.textContent).toContain('Turn on the always-visible toolbar above')
  })

  it('does not write anything when the disabled switch is clicked', async () => {
    buildHarness([[PrefKey.AlwaysShowSuperToolbar, false]])
    await renderCard()
    await click(autoHideSwitch())
    expect(harness.setPreference).not.toHaveBeenCalled()
  })

  it('still shows the choice that was made, so it comes back with the toolbar', async () => {
    buildHarness([
      [PrefKey.AlwaysShowSuperToolbar, false],
      [AUTO_HIDE_KEY, true],
    ])
    await renderCard()
    expect(autoHideSwitch()?.checked).toBe(true)
    expect(autoHideSwitch()?.disabled).toBe(true)
  })

  it('is enabled, with no such note, whenever the always-visible toolbar is on', async () => {
    buildHarness()
    await renderCard()
    expect(autoHideSwitch()?.disabled).toBe(false)
    expect(unavailableNote()).toBeNull()
  })

  it('follows the always-visible switch live', async () => {
    buildHarness()
    await renderCard()
    expect(autoHideSwitch()?.disabled).toBe(false)

    await click(
      rowByHeading(container, ALWAYS_VISIBLE_HEADING)?.querySelector<HTMLInputElement>('input[type="checkbox"]') ??
        null,
    )
    expect(harness.setPreference).toHaveBeenLastCalledWith(PrefKey.AlwaysShowSuperToolbar, false)
    expect(autoHideSwitch()?.disabled).toBe(true)
    expect(unavailableNote()).not.toBeNull()
  })
})

describe('on mobile', () => {
  it('is not offered, like the always-visible toolbar switch beside it', async () => {
    mockMobileLayout = true
    buildHarness()
    await renderCard()
    expect(autoHideRow()).toBeNull()
    expect(rowByHeading(container, AUTO_HIDE_HEADING)).toBeNull()
    expect(rowByHeading(container, ALWAYS_VISIBLE_HEADING)).toBeNull()
  })
})

describe('vanish guard: the switch is reachable in the REAL General pane', () => {
  it('is inside the "Notes & editor" subtab, not merely renderable on its own', async () => {
    buildHarness()
    await act(async () => {
      root.render(createElement(General))
    })
    await act(async () => {})

    // The default subtab is "General": the switch must NOT be mounted there,
    // which is also what proves the click below is doing the work.
    expect(autoHideRow()).toBeNull()

    const editorTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find((tab) =>
      (tab.textContent ?? '').includes('Notes & editor'),
    )
    expect(editorTab).toBeDefined()
    await act(async () => {
      editorTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel).not.toBeNull()
    // A sentinel proves this is the editor subtab and not somewhere else.
    expect(panel?.textContent).toContain('SPELLCHECK')
    expect(autoHideRow(panel as ParentNode)).not.toBeNull()
    expect(autoHideSwitch(panel as ParentNode)).not.toBeNull()

    // And it works from there, not just exists.
    await click(autoHideSwitch(panel as ParentNode))
    expect(harness.setPreference).toHaveBeenLastCalledWith('superToolbarAutoHide', true)
  })
})
