/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FeatureStatus, NoteType, SNNote, SNTag, UuidGenerator } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import TodoView from './TodoView'
import { CHECKLIST_TODO_ID_STATE_KEY } from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
import {
  createPrintSnapshot,
  getActiveNotePrintSupport,
  installNativeNotePrinting,
  PRINT_EMPTY_ATTRIBUTE,
  PRINT_ROOT_ID,
  PRINT_TITLE_ID,
  removePrintSnapshot,
} from '../NoteView/Print/PrintNote'
import { TODO_MAX_INDENT_LEVEL } from './todoFilters'

/**
 * Render-path coverage for printing the Todos view.
 *
 * The reported bug was that printing from Todos errored with "you're not on a
 * note": the print path resolves its target from the note editor's DOM, and a
 * view tab replaces that editor. So this mounts the REAL view under its real
 * providers, drives its real filter controls, and then goes through the REAL
 * print entry points — the same `beforeprint` handler the browser fires and the
 * same snapshot builder the Print action uses. Nothing here stubs the print
 * module; if the wiring is wrong these fail.
 *
 * What jsdom cannot show is the printed *appearance*: `@media print` rules are
 * never applied and no layout is computed. Everything asserted below is
 * therefore structural (which rows, which markers, which indent values), with
 * the stylesheet checked separately as text in `todoPrintProjection.spec.ts`.
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

type TaskSpec = { text: string; checked?: boolean; children?: TaskSpec[] }

let todoId = 0

const listItem = (task: TaskSpec): unknown => {
  todoId += 1
  return {
    type: 'listitem',
    checked: task.checked === true,
    $: { [CHECKLIST_TODO_ID_STATE_KEY]: `todo-${todoId}` },
    children: [
      { type: 'text', text: task.text },
      ...(task.children && task.children.length > 0 ? [checkList(task.children)] : []),
    ],
  }
}

const checkList = (tasks: TaskSpec[]): unknown => ({
  type: 'list',
  listType: 'check',
  children: tasks.map(listItem),
})

const superNoteText = (tasks: TaskSpec[]): string =>
  JSON.stringify({ root: { type: 'root', children: [checkList(tasks)] } })

/** A single chain `Level 0` → … → `Level n-1`, one task per level. */
const chain = (levels: number): TaskSpec => {
  let deepest: TaskSpec = { text: `Level ${levels - 1}` }
  for (let level = levels - 2; level >= 0; level -= 1) {
    deepest = { text: `Level ${level}`, children: [deepest] }
  }
  return deepest
}

const makeNote = (uuid: string, title: string, text: string, noteType: NoteType): SNNote =>
  ({ uuid, title, text, trashed: false, locked: false, noteType, payload: {} }) as unknown as SNNote

const notes: SNNote[] = [
  makeNote(
    'work',
    'Sprint board',
    superNoteText([
      {
        text: 'Ship the beta',
        children: [{ text: 'Write release notes', checked: true }, { text: 'Tag the build' }],
      },
      { text: 'Unrelated chore' },
    ]),
    NoteType.Super,
  ),
  makeNote(
    'home',
    'Errands',
    JSON.stringify({
      schemaVersion: '1.0.0',
      groups: [{ name: 'Groceries', tasks: [{ id: 'milk', description: 'Buy milk', completed: false }] }],
    }),
    NoteType.Task,
  ),
  makeNote('deep', 'Deep note', superNoteText([chain(14)]), NoteType.Super),
]

const noteTags: Record<string, SNTag[]> = {
  work: [{ uuid: 'tag-work', title: 'Work' } as unknown as SNTag],
}

let container: HTMLElement
let root: Root
let storage: Map<string, unknown>
let originalResizeObserver: typeof ResizeObserver
let originalAnimate: typeof HTMLElement.prototype.animate

const mount = () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const application = {
    items: {
      getItems: () => notes,
      streamItems: () => () => undefined,
      findItem: (uuid: string) => notes.find((note) => note.uuid === uuid),
      getSortedTagsForItem: (note: SNNote) => noteTags[note.uuid] ?? [],
      getTagLongTitle: (tag: SNTag) => tag.title,
    },
    addEventObserver: () => () => undefined,
    isAuthorizedToRenderItem: () => true,
    vaults: { getItemVault: () => undefined },
    sessions: { isCurrentSessionReadOnly: () => false },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
    features: { getFeatureStatus: () => FeatureStatus.Entitled },
    paneController: { closeViewTab: () => undefined, setActiveViewTab: () => undefined, presentPane: () => undefined },
    itemControllerGroup: { itemControllers: [] },
    keyboardService: { isMac: false },
    getPreference: (key: string, defaultValue?: unknown) => storage.get(key) ?? defaultValue,
    setPreference: (key: string, value: unknown) => {
      storage.set(key, value)
      return Promise.resolve()
    },
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
  } as unknown as WebApplication

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

const searchFor = (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search todos"]') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const setSelect = (label: string, value: string) => {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) as HTMLSelectElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Every todo the built snapshot would put on paper, in printed order. */
const printedTodos = (snapshot: HTMLElement) =>
  Array.from(snapshot.querySelectorAll<HTMLElement>('.srn-print-todo')).map((entry) => ({
    marker: entry.querySelector('.srn-print-checkbox')?.textContent ?? '',
    text: entry.querySelector('.srn-print-todo-text')?.textContent ?? '',
    meta: entry.querySelector('.srn-print-todo-meta')?.textContent ?? '',
    depth: Number(entry.getAttribute('data-todo-depth')),
    checked: entry.getAttribute('data-todo-checked'),
    indent: parseFloat(entry.style.marginInlineStart || '0'),
  }))

const buildSnapshot = () => {
  const snapshot = createPrintSnapshot({})
  expect(snapshot).toBeDefined()
  return snapshot as HTMLElement
}

beforeEach(() => {
  todoId = 0
  UuidGenerator.SetGenerator(() => 'todo-print-table-test')
  storage = new Map()
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
  removePrintSnapshot()
  unmount()
  globalThis.ResizeObserver = originalResizeObserver
  HTMLElement.prototype.animate = originalAnimate
})

describe('Printing the Todos view', () => {
  it('prints the todo list instead of refusing because no note is open', () => {
    // The reported bug, at its source: there is no note editor on this view.
    expect(document.getElementById('note-title-editor')).toBeNull()

    const support = getActiveNotePrintSupport({})
    expect(support).toEqual({ supported: true, source: 'view' })

    const snapshot = buildSnapshot()
    expect(snapshot.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Todos')
    expect(printedTodos(snapshot).map((todo) => todo.text)).toContain('Ship the beta')
  })

  it('fails the same way as before once the view is gone, so nothing leaks past it', () => {
    unmount()
    expect(getActiveNotePrintSupport({})).toEqual({
      supported: false,
      reason: 'Open a note or a printable view before printing.',
    })
    expect(createPrintSnapshot({})).toBeUndefined()
    // afterEach unmounts; give it a live tree to unmount.
    mount()
  })

  it('prints the filtered subset that is on screen, not the whole list', () => {
    searchFor('milk')
    const visible = Array.from(container.querySelectorAll('[role="row"] [role="gridcell"] [data-todo-depth]')).map(
      (cell) => cell.textContent?.replace(/^•/, '').trim() ?? '',
    )
    expect(visible.some((text) => text.includes('Buy milk'))).toBe(true)

    const printed = printedTodos(buildSnapshot()).map((todo) => todo.text)
    expect(printed).toEqual(['Buy milk'])
    // The rows the filter removed must be absent from paper, not merely hidden.
    expect(printed).not.toContain('Ship the beta')
    expect(printed).not.toContain('Unrelated chore')
  })

  it('follows a filter change, so paper never shows a previous selection', () => {
    setSelect('Filter by source', 'advanced-checklist')
    expect(printedTodos(buildSnapshot()).map((todo) => todo.text)).toEqual(['Buy milk'])

    setSelect('Filter by source', 'super')
    const printed = printedTodos(buildSnapshot()).map((todo) => todo.text)
    expect(printed).not.toContain('Buy milk')
    expect(printed).toContain('Ship the beta')
  })

  it('states what it is showing and what filtered the rest out', () => {
    const unfiltered = buildSnapshot().querySelector('.srn-print-todo-summary')?.textContent ?? ''
    expect(unfiltered).not.toContain('filtered by')

    searchFor('release')
    const summary = buildSnapshot().querySelector('.srn-print-todo-summary')?.textContent ?? ''
    // A printed list that silently omits rows is a misleading document, so the
    // omission and its cause are both on the page.
    expect(summary).toContain('Showing 1 of')
    expect(summary).toContain('filtered by search “release”')

    setSelect('Filter by due date', 'unscheduled')
    expect(buildSnapshot().querySelector('.srn-print-todo-summary')?.textContent).toContain('due: No due date')
  })

  it('keeps completion state readable, rather than printing identical empty boxes', () => {
    const printed = printedTodos(buildSnapshot())
    const done = printed.find((todo) => todo.text === 'Write release notes')
    const open = printed.find((todo) => todo.text === 'Tag the build')

    expect(done?.marker).toBe('☒')
    expect(done?.checked).toBe('true')
    expect(open?.marker).toBe('☐')
    expect(open?.checked).toBe('false')
    expect(done?.marker).not.toBe(open?.marker)
  })

  it('keeps the nesting legible, clamping the indent and stating the real level past the ceiling', () => {
    const printed = printedTodos(buildSnapshot())
    const byText = new Map(printed.map((todo) => [todo.text, todo]))

    expect(byText.get('Ship the beta')?.depth).toBe(0)
    expect(byText.get('Write release notes')?.depth).toBe(1)
    expect(byText.get('Write release notes')?.indent).toBeGreaterThan(byText.get('Ship the beta')?.indent ?? 0)

    // Children stay immediately under their own parent on paper too. Their
    // order among themselves is the active sort's business, not this test's.
    const order = printed.map((todo) => todo.text)
    const parentIndex = order.indexOf('Ship the beta')
    expect(order.slice(parentIndex + 1, parentIndex + 3).sort()).toEqual(['Tag the build', 'Write release notes'])

    const deepest = byText.get('Level 13')
    const atCeiling = printed.find((todo) => todo.depth === TODO_MAX_INDENT_LEVEL)
    expect(deepest?.depth).toBe(13)
    expect(deepest?.indent).toBe(atCeiling?.indent)
    // The indent can no longer say how deep it is, so the row says it.
    expect(
      buildSnapshot().querySelector<HTMLElement>('.srn-print-todo-level')?.textContent?.trim(),
    ).toBe('L11')
  })

  it('marks an ancestor kept only as context, in words rather than by colour alone', () => {
    searchFor('release')
    const printed = printedTodos(buildSnapshot())
    expect(printed.map((todo) => todo.text)).toEqual(['Ship the beta', 'Write release notes'])
    expect(printed[0].meta).toContain('shown as the parent of a match')
    expect(printed[1].meta).not.toContain('shown as the parent of a match')
  })

  it('excludes every interactive control, including the per-row schedule action', () => {
    // The live view is full of them; the snapshot must contain none.
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0)

    const snapshot = buildSnapshot()
    expect(snapshot.querySelectorAll('button, input, select, textarea, [role="button"]')).toHaveLength(0)
    expect(snapshot.textContent).not.toContain('All folders')
    expect(snapshot.textContent).not.toContain('Hide completed')
    expect(snapshot.textContent).not.toContain('Clear filters')
  })

  it('names each row its source note and kind, so a printed page stands alone', () => {
    const printed = printedTodos(buildSnapshot())
    expect(printed.find((todo) => todo.text === 'Ship the beta')?.meta).toContain('Sprint board')
    expect(printed.find((todo) => todo.text === 'Buy milk')?.meta).toContain('Advanced Checklist')
    // The Advanced Checklist section the task was authored under rides along.
    expect(printed.find((todo) => todo.text === 'Buy milk')?.meta).toContain('Groceries')
  })
})

describe('The browser print event on the Todos view', () => {
  it('installs the todo list rather than the blank fail-closed page', () => {
    const reasons: string[] = []
    const uninstall = installNativeNotePrinting(undefined, (reason) => reasons.push(reason))

    try {
      act(() => {
        window.dispatchEvent(new Event('beforeprint'))
      })

      const printRoot = document.getElementById(PRINT_ROOT_ID)
      expect(printRoot).not.toBeNull()
      // The old behaviour: an error toast plus a deliberately blank snapshot.
      expect(reasons).toEqual([])
      expect(printRoot?.hasAttribute(PRINT_EMPTY_ATTRIBUTE)).toBe(false)
      expect(printRoot?.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Todos')
      expect(printRoot?.textContent).toContain('Ship the beta')
    } finally {
      uninstall()
    }
  })

  it('still prints a specifically requested note, which the notes list can ask for from here', () => {
    // A view tab being active must not hijack "print THIS note" from the list.
    const support = getActiveNotePrintSupport({
      noteUuid: 'home',
      fallbackTitle: 'Errands',
      fallbackBody: 'Buy milk',
      fallbackNoteType: NoteType.Plain,
      fallbackSource: 'verified-native-plaintext',
    })
    expect(support).toEqual({ supported: true, source: 'fallback' })

    const snapshot = createPrintSnapshot({
      noteUuid: 'home',
      fallbackTitle: 'Errands',
      fallbackBody: 'Buy milk',
      fallbackNoteType: NoteType.Plain,
      fallbackSource: 'verified-native-plaintext',
    })
    expect(snapshot?.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Errands')
    expect(snapshot?.querySelectorAll('.srn-print-todo')).toHaveLength(0)
  })
})
