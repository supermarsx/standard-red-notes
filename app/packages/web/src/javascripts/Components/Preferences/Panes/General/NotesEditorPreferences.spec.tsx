/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: the four t111 settings that live in
 * Preferences → General → "Notes & editor" (plan §3 rows 1, 2, 5, 6).
 *
 * Three of these four default to **ON**, and that is the whole reason this file
 * is careful about defaults: `PrefDefaults[PrefKey.TodoHeadingLevels]` and friends
 * are `undefined` at runtime (the generated models bundle predates the members),
 * `undefined` is falsy, and a toggle that read its default from that table would
 * render OFF while the feature was ON — a control lying about the state it
 * controls. So every "nothing stored" case below asserts the switch is ON.
 *
 * The last describe block is the VANISH GUARD: this repo has shipped preferences
 * UI that typechecked, unit-tested clean and appeared nowhere. Passing leaf tests
 * are not evidence that a control is reachable, so the real <General> pane is
 * mounted and the "Notes & editor" subtab is actually opened.
 */
import { ApplicationEvent } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import {
  TODO_HEADING_DESCRIPTIONS_PREF_KEY,
  TODO_HEADING_LEVELS_PREF_KEY,
} from '@/Components/TodoAggregate/todoHierarchy'
import {
  CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY,
  CHECKLIST_GENERATE_CAP_PREF_KEY,
} from '@/Components/SuperEditor/Checklist/checklistBackfill'

type Harness = {
  application: import('@/Application/WebApplication').WebApplication
  prefs: Map<string, unknown>
  setPreference: jest.Mock
}

let harness: Harness

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
    getPreference: (key: string, defaultValue?: unknown) => (prefs.has(key) ? prefs.get(key) : defaultValue),
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

// Siblings of the two cards under test pull in unrelated service surface. Replace
// them with sentinels: the pane's COMPOSITION is what the vanish guard is about,
// not their internals.
jest.mock('./Language', () => ({ __esModule: true, default: () => createElement('div', null, 'LANGUAGE') }))
jest.mock('./Persistence', () => ({ __esModule: true, default: () => createElement('div', null, 'PERSISTENCE') }))
jest.mock('./TimezonePreference', () => ({ __esModule: true, default: () => createElement('div', null, 'TIMEZONE') }))
jest.mock('./SyncConnection', () => ({ __esModule: true, default: () => createElement('div', null, 'SYNCCONN') }))
jest.mock('./Updates', () => ({ __esModule: true, default: () => createElement('div', null, 'UPDATES') }))
jest.mock('./ReloadApp', () => ({ __esModule: true, default: () => createElement('div', null, 'RELOADAPP') }))
jest.mock('./Defaults', () => ({ __esModule: true, default: () => createElement('div', null, 'DEFAULTS') }))
jest.mock('./NewNoteDefaults', () => ({ __esModule: true, default: () => createElement('div', null, 'NEWNOTE') }))
jest.mock('./Spellcheck', () => ({ __esModule: true, default: () => createElement('div', null, 'SPELLCHECK') }))
jest.mock('./SmartViews/SmartViews', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'SMARTVIEWS'),
}))

import ChecklistRecurrence from './ChecklistRecurrence'
import General from './General'
import TodoHeadings from './TodoHeadings'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
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

type ApplicationCardProps = { application: import('@/Application/WebApplication').WebApplication }

const renderCard = async (element: React.FunctionComponent<ApplicationCardProps>) => {
  await act(async () => {
    root.render(createElement(element, { application: harness.application }))
  })
  await act(async () => {})
}

const renderPane = async () => {
  await act(async () => {
    root.render(createElement(General))
  })
  await act(async () => {})
}

const checkboxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))

const clickCheckbox = async (index: number) => {
  await act(async () => {
    checkboxes()[index]?.click()
  })
  await act(async () => {})
}

// React installs its own `value` setter on HTMLInputElement to remember the last
// value it saw, and SUPPRESSES the change event when an `input` event arrives
// carrying a value its tracker already holds. A plain `input.value = x` goes
// through that setter, so React's onChange never fires and the component's draft
// state stays untouched while the DOM shows the new text — a test that then reads
// the DOM proves nothing. Writing through the prototype's original setter is what
// makes React see a real edit.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

const capField = () => container.querySelector<HTMLInputElement>('[data-test="checklist-generate-cap"]')

const typeCap = async (value: string) => {
  const input = capField()
  expect(input).not.toBeNull()
  await act(async () => {
    nativeInputValueSetter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {})
}

// React delegates onBlur from the BUBBLING `focusout` event, not the
// non-bubbling `blur` one, so a bare `blur` dispatch would reach no handler.
const blurCap = async () => {
  await act(async () => {
    capField()?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await act(async () => {})
}

describe('Todos from headings', () => {
  it('renders BOTH switches ON when nothing is stored', async () => {
    buildHarness()
    await renderCard(TodoHeadings)

    expect(container.querySelector('[data-test="todo-heading-settings"]')).not.toBeNull()
    expect(checkboxes()).toHaveLength(2)
    expect(checkboxes()[0].checked).toBe(true)
    expect(checkboxes()[1].checked).toBe(true)
  })

  it('honours a stored `false` in both directions', async () => {
    buildHarness([
      ['todoHeadingLevels', false],
      ['todoHeadingDescriptions', false],
    ])
    await renderCard(TodoHeadings)

    expect(checkboxes()[0].checked).toBe(false)
    expect(checkboxes()[1].checked).toBe(false)
  })

  it('falls back to ON for a corrupted non-boolean value rather than to off', async () => {
    buildHarness([['todoHeadingLevels', 'nope']])
    await renderCard(TodoHeadings)
    expect(checkboxes()[0].checked).toBe(true)
  })

  it('writes to the SAME two pinned keys the Todos filter bar uses', async () => {
    buildHarness()
    await renderCard(TodoHeadings)

    await clickCheckbox(0)

    expect(harness.setPreference).toHaveBeenCalledWith(TODO_HEADING_LEVELS_PREF_KEY, false)
    expect(harness.setPreference).toHaveBeenCalledWith(TODO_HEADING_DESCRIPTIONS_PREF_KEY, true)
    // The literals are the mirror: TodoView writes these exact strings.
    expect(harness.prefs.get('todoHeadingLevels')).toBe(false)
    expect(checkboxes()[0].checked).toBe(false)
  })

  it('disables the description switch, and SAYS WHY, while sublevels are off', async () => {
    buildHarness([['todoHeadingLevels', false]])
    await renderCard(TodoHeadings)

    expect(checkboxes()[1].disabled).toBe(true)
    const explanation = container.querySelector('[data-test="todo-heading-descriptions-dependency"]')
    expect(explanation).not.toBeNull()
    expect(explanation?.textContent).toContain('a description belongs to a heading section')
  })

  it('enables the description switch again once sublevels are on', async () => {
    buildHarness([['todoHeadingLevels', true]])
    await renderCard(TodoHeadings)

    expect(checkboxes()[1].disabled).toBe(false)
    expect(container.querySelector('[data-test="todo-heading-descriptions-dependency"]')).toBeNull()
  })
})

describe('Recurring checklist tasks', () => {
  it('renders auto-generate ON and the cap at 12 when nothing is stored', async () => {
    buildHarness()
    await renderCard(ChecklistRecurrence)

    expect(container.querySelector('[data-test="checklist-recurrence-settings"]')).not.toBeNull()
    expect(checkboxes()[0].checked).toBe(true)
    expect(capField()?.value).toBe('12')
  })

  it('honours a stored `false` for auto-generate', async () => {
    buildHarness([['checklistAutoGenerateRecurrences', false]])
    await renderCard(ChecklistRecurrence)
    expect(checkboxes()[0].checked).toBe(false)
  })

  it('writes auto-generate to the SAME pinned key the editor subsection uses', async () => {
    buildHarness()
    await renderCard(ChecklistRecurrence)

    await clickCheckbox(0)

    expect(harness.setPreference).toHaveBeenCalledWith(CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY, false)
    expect(harness.prefs.get('checklistAutoGenerateRecurrences')).toBe(false)
    expect(checkboxes()[0].checked).toBe(false)
  })

  it('CLAMPS a stored cap written by another client, on read', async () => {
    buildHarness([['checklistGenerateCap', 9000]])
    await renderCard(ChecklistRecurrence)
    expect(capField()?.value).toBe('200')
  })

  it('clamps a stored cap below the floor too, and shows the clamped value', async () => {
    buildHarness([['checklistGenerateCap', 0]])
    await renderCard(ChecklistRecurrence)
    expect(capField()?.value).toBe('1')
  })

  it('keeps the draft while typing and commits the clamped value on blur', async () => {
    buildHarness()
    await renderCard(ChecklistRecurrence)

    await typeCap('150')
    // Not clamped per keystroke: the number must not be rewritten under the cursor.
    expect(capField()?.value).toBe('150')
    expect(harness.setPreference).not.toHaveBeenCalled()

    await blurCap()

    expect(harness.setPreference).toHaveBeenCalledWith(CHECKLIST_GENERATE_CAP_PREF_KEY, 150)
    expect(harness.prefs.get('checklistGenerateCap')).toBe(150)
    expect(capField()?.value).toBe('150')
  })

  it('clamps an out-of-range typed value on commit instead of storing it', async () => {
    buildHarness()
    await renderCard(ChecklistRecurrence)

    await typeCap('900')
    await blurCap()

    expect(harness.setPreference).toHaveBeenCalledWith(CHECKLIST_GENERATE_CAP_PREF_KEY, 200)
    expect(capField()?.value).toBe('200')
  })

  it('restores the default rather than storing nothing when the field is emptied', async () => {
    buildHarness([['checklistGenerateCap', 30]])
    await renderCard(ChecklistRecurrence)
    expect(capField()?.value).toBe('30')

    await typeCap('')
    await blurCap()

    expect(harness.setPreference).toHaveBeenCalledWith(CHECKLIST_GENERATE_CAP_PREF_KEY, 12)
    expect(capField()?.value).toBe('12')
  })

  it('does not write when the committed value is the one already stored', async () => {
    buildHarness([['checklistGenerateCap', 12]])
    await renderCard(ChecklistRecurrence)

    await blurCap()

    expect(harness.setPreference).not.toHaveBeenCalled()
  })

  it('states the two facts the editor subsection also states, so the surfaces agree', async () => {
    buildHarness()
    await renderCard(ChecklistRecurrence)

    const text = container.textContent ?? ''
    expect(text).toContain('summary task')
    expect(text).toContain('not')
    expect(text).toContain('reproduced')
    expect(text).toContain('Jan 31 becomes Feb 28, then Mar 31')
    expect(text).toContain('Checklists panel')
  })
})

describe('vanish guard: both cards are reachable in the REAL General pane', () => {
  it('renders them inside the "Notes & editor" subtab, not merely standalone', async () => {
    buildHarness()
    await renderPane()

    // Default subtab is "General": the editor cards must NOT be mounted there,
    // which is also what proves the click below is doing the work.
    expect(container.querySelector('[data-test="todo-heading-settings"]')).toBeNull()
    expect(container.querySelector('[data-test="checklist-recurrence-settings"]')).toBeNull()

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
    // Sentinels prove we are looking at the editor subtab and not somewhere else.
    expect(panel?.textContent).toContain('SPELLCHECK')
    expect(panel?.querySelector('[data-test="todo-heading-settings"]')).not.toBeNull()
    expect(panel?.querySelector('[data-test="checklist-recurrence-settings"]')).not.toBeNull()
    expect(panel?.textContent).toContain('Headings create todo sublevels')
    expect(panel?.textContent).toContain('Auto-generate missed recurrences')
    expect(panel?.querySelector('[data-test="checklist-generate-cap"]')).not.toBeNull()
  })
})
