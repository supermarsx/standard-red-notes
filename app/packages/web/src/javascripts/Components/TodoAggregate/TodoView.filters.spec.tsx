/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent, FeatureStatus, NoteType, SNNote, SNTag, UuidGenerator } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import TodoView from './TodoView'
import { CHECKLIST_TODO_ID_STATE_KEY } from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
import { DEFAULT_TODO_FILTERS, TODO_FILTERS_PREF_KEY } from './todoFilters'

/**
 * Render-path coverage for the Todos general view's array display and its
 * persistent filter bar. A green type-check and green filter-module tests do
 * not prove any of it reaches the DOM, that the controls re-render the table,
 * or that filter state actually comes back after a reload — so the real view is
 * mounted, driven, unmounted and remounted here.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ImmediateResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as never)
  }
  unobserve() {}
  disconnect() {}
}

const superChecklistJson = (items: { text: string; todoId: string; checked?: boolean; dueAt?: string }[]): string =>
  JSON.stringify({
    root: {
      type: 'root',
      children: [
        {
          type: 'list',
          listType: 'check',
          children: items.map((item) => ({
            type: 'listitem',
            checked: item.checked === true,
            $: {
              [CHECKLIST_TODO_ID_STATE_KEY]: item.todoId,
              ...(item.dueAt ? { srnChecklistDueAt: item.dueAt } : {}),
            },
            children: [{ type: 'text', text: item.text }],
          })),
        },
      ],
    },
  })

const advancedChecklistJson = (
  groups: { name: string; tasks: { id: string; description: string; completed: boolean }[] }[],
): string => JSON.stringify({ schemaVersion: '1.0.0', groups })

const makeNote = (uuid: string, title: string, text: string, noteType: NoteType): SNNote =>
  ({ uuid, title, text, trashed: false, locked: false, noteType, payload: {} }) as unknown as SNNote

/** A tag plus the ancestor path `ItemManager.getTagLongTitle` would render for it. */
const tag = (uuid: string, title: string, longTitle = title): SNTag =>
  ({ uuid, title, longTitle }) as unknown as SNTag

const OVERDUE = new Date(Date.now() - 60 * 60 * 1000).toISOString()

const defaultNotes = [
  makeNote(
    'work',
    'Sprint board',
    superChecklistJson([
      { text: 'Ship the beta', todoId: 'todo-beta', dueAt: OVERDUE },
      { text: 'Write release notes', todoId: 'todo-notes', checked: true },
    ]),
    NoteType.Super,
  ),
  makeNote(
    'home',
    'Errands',
    advancedChecklistJson([
      { name: 'Groceries', tasks: [{ id: 'milk', description: 'Buy milk', completed: false }] },
      { name: 'Chores', tasks: [{ id: 'plumber', description: 'Call the plumber', completed: true }] },
    ]),
    NoteType.Task,
  ),
]

const defaultNoteTags: Record<string, SNTag[]> = {
  work: [tag('tag-work', 'Work')],
  home: [tag('tag-home', 'Home')],
}

/**
 * Swappable so a test can prove what the bar does with a DIFFERENT shape of
 * data — notably, that the section control disappears when no Advanced
 * Checklist note supplies one.
 */
let notes = defaultNotes
let noteTags = defaultNoteTags

let container: HTMLElement
let root: Root
let storage: Map<string, unknown>
let preferenceObservers: ((event: unknown) => void)[]
let originalResizeObserver: typeof ResizeObserver
let originalAnimate: typeof HTMLElement.prototype.animate

const buildApplication = (): WebApplication =>
  ({
    items: {
      getItems: () => notes,
      streamItems: () => () => undefined,
      findItem: (uuid: string) => notes.find((note) => note.uuid === uuid),
      getSortedTagsForItem: (note: SNNote) => noteTags[note.uuid] ?? [],
      // The real ItemManager walks the tag's parent chain; the fixtures carry
      // the resulting path directly so the view's use of it is what is tested.
      getTagLongTitle: (each: SNTag) => (each as unknown as { longTitle: string }).longTitle,
    },
    addEventObserver: (observer: (event: unknown) => Promise<void> | void) => {
      preferenceObservers.push(observer)
      return () => undefined
    },
    isAuthorizedToRenderItem: () => true,
    vaults: { getItemVault: () => undefined },
    sessions: { isCurrentSessionReadOnly: () => false },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
    features: { getFeatureStatus: () => FeatureStatus.Entitled },
    paneController: { closeViewTab: () => undefined, setActiveViewTab: () => undefined, presentPane: () => undefined },
    itemControllerGroup: { itemControllers: [] },
    keyboardService: { isMac: false },
    // The SYNCED UserPrefs item the filters persist through.
    getPreference: (key: string, defaultValue?: unknown) => storage.get(key) ?? defaultValue,
    setPreference: (key: string, value: unknown) => {
      storage.set(key, value)
      return Promise.resolve()
    },
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
  }) as unknown as WebApplication

const mount = () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const application = buildApplication()
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application,
        children: createElement(AndroidBackHandlerProvider, {
          application,
          children: createElement(TodoView, { application, id: 'todos' }),
        }),
      }),
    )
  })
}

const unmount = () => {
  act(() => root.unmount())
  container.remove()
}

/**
 * The rendered todo rows, read from each data row's first cell. Read-only rows
 * (Advanced Checklist notes) have no selection checkbox, so the cell text — not
 * the checkbox label — is what every row is guaranteed to have.
 */
const visibleTodoText = () =>
  Array.from(container.querySelectorAll('[role="row"]'))
    .map((row) => row.querySelector('[role="gridcell"]'))
    .filter((cell): cell is Element => cell !== null)
    .map((cell) => cell.textContent?.trim() ?? '')

const control = <T extends HTMLElement>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`) as T

const setInput = (input: HTMLInputElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const setSelect = (select: HTMLSelectElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const clickButtonLabelled = (text: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((each) => each.textContent?.trim() === text)
  expect(button).toBeDefined()
  act(() => (button as HTMLButtonElement).click())
}

// --- multi-select filter controls -----------------------------------------
// These are checkbox lists behind a trigger, and the list renders through a
// Popover PORTAL onto document.body — so it is found there, not in `container`.

const TAG_FILTER_LABEL = 'Filter by folder or tag'
const SECTION_FILTER_LABEL = 'Filter by checklist section'

/** The trigger's own text, i.e. what the collapsed control says it is doing. */
const multiSelectSummary = (label: string) => control<HTMLButtonElement>(label)?.textContent?.trim()

const openMultiSelect = (label: string) => {
  const trigger = control<HTMLButtonElement>(label)
  expect(trigger).toBeTruthy()
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    act(() => trigger.click())
  }
  return trigger
}

const multiSelectPanel = (kind: string) => document.body.querySelector<HTMLElement>(`[data-todo-filter="${kind}"]`)

/** Every option the open panel offers, in the order it offers them. */
const multiSelectOptions = (kind: string) =>
  Array.from(multiSelectPanel(kind)?.querySelectorAll('input[type="checkbox"]') ?? []).map((box) =>
    box.getAttribute('aria-label'),
  )

const toggleMultiSelectOption = (kind: string, optionLabel: string) => {
  const panel = multiSelectPanel(kind)
  expect(panel).toBeTruthy()
  const box = panel?.querySelector<HTMLInputElement>(`input[aria-label="${optionLabel}"]`)
  expect(box).toBeTruthy()
  act(() => (box as HTMLInputElement).click())
}

/** Open the control, tick each option by its rendered label, and leave it open. */
const selectTags = (...optionLabels: string[]) => {
  openMultiSelect(TAG_FILTER_LABEL)
  for (const optionLabel of optionLabels) {
    toggleMultiSelectOption('tags', optionLabel)
  }
}

const selectSections = (...optionLabels: string[]) => {
  openMultiSelect(SECTION_FILTER_LABEL)
  for (const optionLabel of optionLabels) {
    toggleMultiSelectOption('groups', optionLabel)
  }
}

beforeEach(() => {
  // The shared Table asks for a uuid; app boot normally registers the generator.
  UuidGenerator.SetGenerator(() => 'todo-filters-table-test')
  storage = new Map()
  preferenceObservers = []
  originalResizeObserver = globalThis.ResizeObserver
  originalAnimate = HTMLElement.prototype.animate
  window.matchMedia = ((query: string) => ({
    matches: query === '(min-width: 768px)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = ImmediateResizeObserver as unknown as typeof ResizeObserver
  HTMLElement.prototype.animate = (() =>
    ({
      currentTime: 0,
      finished: Promise.resolve(),
      cancel: () => undefined,
    }) as unknown as Animation) as typeof HTMLElement.prototype.animate
  mount()
})

afterEach(() => {
  unmount()
  // A test that swapped the fixtures must not leak them into the next one.
  notes = defaultNotes
  noteTags = defaultNoteTags
  globalThis.ResizeObserver = originalResizeObserver
  HTMLElement.prototype.animate = originalAnimate
})

describe('Todos array display', () => {
  it('renders every todo as one row of a labelled table', () => {
    const headers = Array.from(container.querySelectorAll('[role="columnheader"]')).map((cell) =>
      cell.textContent?.trim(),
    )
    expect(headers).toEqual(['Todo', 'Due', 'Note', 'Folders & tags'])
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Buy milk', 'Call the plumber', 'Write release notes'])
  })

  it('shows each row its source note and folder/tag', () => {
    expect(container.textContent).toContain('Sprint board')
    expect(container.textContent).toContain('Errands')
    expect(container.textContent).toContain('Work')
    expect(container.textContent).toContain('Home')
  })
})

describe('Todos filter bar', () => {
  it('filters as the user types, with no commit step', () => {
    // "m" reaches both Errands rows (milk, plumber); one more character drops
    // to one, with no submit or blur in between.
    setInput(control<HTMLInputElement>('Search todos'), 'm')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber'])
    setInput(control<HTMLInputElement>('Search todos'), 'mi')
    expect(visibleTodoText()).toEqual(['Buy milk'])
    setInput(control<HTMLInputElement>('Search todos'), 'mizzz')
    expect(visibleTodoText()).toEqual([])
  })

  it('searches the source note title and the folder/tag title too', () => {
    setInput(control<HTMLInputElement>('Search todos'), 'sprint')
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Write release notes'])
    setInput(control<HTMLInputElement>('Search todos'), 'home')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber'])
  })

  it('filters by folder/tag', () => {
    selectTags('Work')
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Write release notes'])
  })

  it('admits every selected folder at once, rather than intersecting them', () => {
    // The trap an intersection would spring: a note sits in ONE folder, so
    // requiring both would empty the list the moment a second box is ticked.
    selectTags('Work')
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Write release notes'])
    toggleMultiSelectOption('tags', 'Home')
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Buy milk', 'Call the plumber', 'Write release notes'])
    expect(multiSelectSummary(TAG_FILTER_LABEL)).toContain('2 folders & tags selected')

    // Unticking is symmetrical — the control only ever widens or narrows by one.
    toggleMultiSelectOption('tags', 'Work')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber'])
    expect(multiSelectSummary(TAG_FILTER_LABEL)).toContain('Home')
  })

  it('identifies each folder by its full path, not its own title', () => {
    unmount()
    // Two folders genuinely named the same, under different parents: the exact
    // case a bare title cannot express.
    noteTags = {
      work: [tag('tag-work', 'Personal', 'Work/Personal')],
      home: [tag('tag-home', 'Personal', 'Home/Personal')],
    }
    mount()

    openMultiSelect(TAG_FILTER_LABEL)
    // Sorted by path, so each nested folder lands under its own parent.
    expect(multiSelectOptions('tags')).toEqual(['Home/Personal', 'Work/Personal'])
    toggleMultiSelectOption('tags', 'Work/Personal')
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Write release notes'])

    // And the search box reaches the parent's name through the same path.
    setInput(control<HTMLInputElement>('Search todos'), 'home/')
    expect(visibleTodoText()).toEqual([])
  })

  it('filters by Advanced Checklist section, and unions the selected ones', () => {
    selectSections('Groceries')
    expect(visibleTodoText()).toEqual(['Buy milk'])
    toggleMultiSelectOption('groups', 'Chores')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber'])
    // Super rows have no sections at all, so a section filter excludes them.
    expect(visibleTodoText()).not.toContain('Ship the beta')
  })

  it('offers no section control at all when nothing in the data has sections', () => {
    unmount()
    // A user with only Super checklists — the common case — must not be shown a
    // control that can never do anything.
    notes = [defaultNotes[0]]
    mount()

    expect(container.querySelector(`[aria-label="${SECTION_FILTER_LABEL}"]`)).toBeNull()
    expect(control<HTMLButtonElement>(TAG_FILTER_LABEL)).toBeTruthy()
  })

  it('filters by source kind', () => {
    setSelect(control<HTMLSelectElement>('Filter by source'), 'advanced-checklist')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber'])
  })

  it('filters by due date', () => {
    setSelect(control<HTMLSelectElement>('Filter by due date'), 'overdue')
    expect(visibleTodoText()).toEqual(['Ship the beta'])
    setSelect(control<HTMLSelectElement>('Filter by due date'), 'unscheduled')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber', 'Write release notes'])
  })

  it('visibly hides completed todos when the toggle is on', () => {
    expect(visibleTodoText()).toContain('Call the plumber')
    const toggle = Array.from(container.querySelectorAll('label'))
      .find((each) => each.textContent?.includes('Hide completed'))
      ?.querySelector('input') as HTMLInputElement
    act(() => toggle.click())
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Buy milk'])
    act(() => toggle.click())
    expect(visibleTodoText()).toHaveLength(4)
  })

  it('composes filters instead of letting the last one win', () => {
    selectTags('Work')
    setInput(control<HTMLInputElement>('Search todos'), 'e')
    expect(visibleTodoText()).toEqual(['Ship the beta', 'Write release notes'])
    const toggle = Array.from(container.querySelectorAll('label'))
      .find((each) => each.textContent?.includes('Hide completed'))
      ?.querySelector('input') as HTMLInputElement
    act(() => toggle.click())
    expect(visibleTodoText()).toEqual(['Ship the beta'])
  })

  it('reorders without hiding when the sort changes', () => {
    setSelect(control<HTMLSelectElement>('Sort by'), 'todo')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber', 'Ship the beta', 'Write release notes'])
    expect(container.textContent).not.toContain('filters active')
  })
})

describe('Todos empty states', () => {
  it('distinguishes "no todos match" from "no todos yet", and offers a way out', () => {
    setInput(control<HTMLInputElement>('Search todos'), 'nothing matches this')
    expect(visibleTodoText()).toEqual([])
    expect(container.textContent).toContain('No todos match your filters.')
    expect(container.textContent).not.toContain('No todos yet.')
    expect(container.textContent).toContain('4 todos are hidden by the filter bar above.')

    clickButtonLabelled('Clear filters')
    expect(visibleTodoText()).toHaveLength(4)
  })

  it('says how many filters are active and how many rows they admit', () => {
    setSelect(control<HTMLSelectElement>('Filter by source'), 'super')
    expect(container.textContent).toContain('1 filter active · showing 2 of 4 todos')
    setInput(control<HTMLInputElement>('Search todos'), 'ship')
    expect(container.textContent).toContain('2 filters active · showing 1 of 4 todos')
  })
})

describe('Todos filter persistence', () => {
  it('writes the filters to the synced preference as they change', () => {
    setSelect(control<HTMLSelectElement>('Filter by source'), 'super')
    expect(storage.get(TODO_FILTERS_PREF_KEY)).toMatchObject({ source: 'super' })
  })

  it('restores every filter on a fresh mount, as a reload would', () => {
    setInput(control<HTMLInputElement>('Search todos'), 'ship')
    selectTags('Work')
    setSelect(control<HTMLSelectElement>('Sort by'), 'todo')
    const toggle = Array.from(container.querySelectorAll('label'))
      .find((each) => each.textContent?.includes('Hide completed'))
      ?.querySelector('input') as HTMLInputElement
    act(() => toggle.click())
    expect(visibleTodoText()).toEqual(['Ship the beta'])

    // Tear the whole tree down and build a new one against the same device
    // storage — the state a reload would come back to.
    unmount()
    mount()

    expect(control<HTMLInputElement>('Search todos').value).toBe('ship')
    expect(multiSelectSummary(TAG_FILTER_LABEL)).toContain('Work')
    expect(control<HTMLSelectElement>('Sort by').value).toBe('todo')
    expect(visibleTodoText()).toEqual(['Ship the beta'])
    // The trap this guards: a restored filter set that quietly hides rows.
    expect(container.textContent).toContain('3 filters active · showing 1 of 4 todos')
  })

  it('ignores a corrupted stored value instead of breaking the view', () => {
    unmount()
    storage.set(TODO_FILTERS_PREF_KEY, { query: 42, source: 'nonsense', tagUuids: 'not-an-array' })
    mount()

    expect(control<HTMLInputElement>('Search todos').value).toBe('')
    expect(visibleTodoText()).toHaveLength(4)
    expect(container.textContent).not.toContain('filters active')
  })

  it('adopts a filter change that arrives from another device', async () => {
    // Nothing has been edited in this view, so a synced write wins.
    storage.set(TODO_FILTERS_PREF_KEY, { ...DEFAULT_TODO_FILTERS, source: 'advanced-checklist' })
    await act(async () => {
      await Promise.all(preferenceObservers.map((observer) => observer(ApplicationEvent.PreferencesChanged)))
    })
    expect(control<HTMLSelectElement>('Filter by source').value).toBe('advanced-checklist')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber'])
  })

  it('does not let a remote change yank the query out from under active typing', async () => {
    setInput(control<HTMLInputElement>('Search todos'), 'ship')
    storage.set(TODO_FILTERS_PREF_KEY, { ...DEFAULT_TODO_FILTERS, query: 'something else' })
    await act(async () => {
      await Promise.all(preferenceObservers.map((observer) => observer(ApplicationEvent.PreferencesChanged)))
    })
    expect(control<HTMLInputElement>('Search todos').value).toBe('ship')
  })

  it('degrades an unknown newer-client shape to the defaults instead of breaking', () => {
    unmount()
    // What an older client sees after a newer one writes fields it has never
    // heard of, and enum values outside its own union.
    storage.set(TODO_FILTERS_PREF_KEY, {
      version: 99,
      query: 'ship',
      tagUuids: ['tag-work'],
      source: 'future-source-kind',
      due: 'sometime-next-decade',
      hideCompleted: true,
      sortBy: 'priority',
      sortReverse: true,
      groupBy: 'assignee',
    })
    mount()

    // Fields it understands survive; the ones it does not fall back, and the
    // view still renders rather than showing an empty or broken list.
    expect(control<HTMLInputElement>('Search todos').value).toBe('ship')
    expect(multiSelectSummary(TAG_FILTER_LABEL)).toContain('Work')
    expect(control<HTMLSelectElement>('Filter by source').value).toBe('all')
    expect(control<HTMLSelectElement>('Filter by due date').value).toBe('all')
    expect(control<HTMLSelectElement>('Sort by').value).toBe('due')
    expect(visibleTodoText()).toEqual(['Ship the beta'])
  })
})
