/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FeatureStatus, NoteType, SNNote, UuidGenerator } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import TodoView from './TodoView'

/**
 * The Todos view against the note shape the EDITOR actually writes.
 *
 * `TodoView.hierarchy.spec` builds its fixtures as `listitem > [text, list]`.
 * Lexical never writes that: pressing Tab runs `$handleIndent`, which creates a
 * brand-new TEXTLESS listitem to hold the nested list and inserts it as the
 * SIBLING right after the task that was indented. Because that wrapper carries
 * no text it never becomes a row, so every nested task used to point at a parent
 * that did not exist and the whole checklist rendered flat at depth 0.
 *
 * Everything here is therefore built in the wrapper shape on purpose. A fixture
 * written the idealized way cannot fail the way the product did.
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

const textNode = (value: string) => ({ type: 'text', text: value })

/** `$handleIndent`'s output: the sublist lives in a sibling wrapper listitem. */
const wrapperList = (tasks: TaskSpec[]): unknown => {
  const children: unknown[] = []
  for (const task of tasks) {
    children.push({ type: 'listitem', checked: task.checked === true, children: [textNode(task.text)] })
    if (task.children && task.children.length > 0) {
      children.push({ type: 'listitem', checked: false, children: [wrapperList(task.children)] })
    }
  }
  return { type: 'list', listType: 'check', children }
}

const noteText = (tasks: TaskSpec[], extra: unknown[] = []): string =>
  JSON.stringify({ root: { type: 'root', children: [...extra, wrapperList(tasks)] } })

/** Four levels, mixed completion, and a leaf beside a parent at every level. */
const FOUR_DEEP: TaskSpec[] = [
  {
    text: 'Level 0 parent',
    children: [
      {
        text: 'Level 1 parent',
        checked: true,
        children: [
          {
            text: 'Level 2 parent',
            children: [{ text: 'Level 3 checked leaf', checked: true }, { text: 'Level 3 open leaf' }],
          },
          { text: 'Level 2 leaf', checked: true },
        ],
      },
      { text: 'Level 1 leaf' },
    ],
  },
  { text: 'Level 0 leaf', checked: true },
]

const superNote = (uuid: string, title: string, text: string): SNNote =>
  ({ uuid, title, trashed: false, locked: false, noteType: NoteType.Super, payload: {}, text }) as unknown as SNNote

const deepNote = superNote('deep', 'Project', noteText(FOUR_DEEP))

const sectionedNote = superNote(
  'sections',
  'Quarter plan',
  noteText(
    [{ text: 'Task A', children: [{ text: 'Sub A1' }] }],
    [{ type: 'heading', tag: 'h1', children: [textNode('Project')] }],
  ),
)

let container: HTMLElement
let root: Root
let storage: Map<string, unknown>
let originalResizeObserver: typeof ResizeObserver
let originalAnimate: typeof HTMLElement.prototype.animate

const mount = (list: SNNote[]) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const application = {
    items: {
      getItems: () => list,
      streamItems: () => () => undefined,
      findItem: (uuid: string) => list.find((note) => note.uuid === uuid),
      getSortedTagsForItem: () => [],
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

type RenderedRow = { text: string; depth: number; indent: string; cell: HTMLElement }

const renderedRows = (): RenderedRow[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"] [data-todo-depth]')).map((cell) => ({
    text: (cell.querySelector('[data-todo-label]') ?? cell).textContent?.trim() ?? '',
    depth: Number(cell.getAttribute('data-todo-depth')),
    indent: cell.style.paddingInlineStart,
    cell,
  }))

const rowFor = (text: string): RenderedRow => {
  const row = renderedRows().find((candidate) => candidate.text.startsWith(text))
  if (!row) {
    throw new Error(
      `no row rendered for ${text}; rendered: ${renderedRows()
        .map((r) => r.text)
        .join(' | ')}`,
    )
  }
  return row
}

const disclosureFor = (text: string) => rowFor(text).cell.querySelector<HTMLButtonElement>('[data-todo-disclosure]')
const slotFor = (text: string) => rowFor(text).cell.querySelector<HTMLElement>('[data-todo-disclosure-slot]')
const rendered = () => renderedRows().map((row) => row.text)

beforeEach(() => {
  UuidGenerator.SetGenerator(() => 'todo-nesting-table-test')
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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.ResizeObserver = originalResizeObserver
  HTMLElement.prototype.animate = originalAnimate
})

describe('Todos view on the shape Lexical really writes', () => {
  beforeEach(() => mount([deepNote]))

  it('indents four levels of Tab-indented subtasks instead of flattening them', () => {
    expect(rowFor('Level 0 parent').depth).toBe(0)
    expect(rowFor('Level 1 parent').depth).toBe(1)
    expect(rowFor('Level 2 parent').depth).toBe(2)
    expect(rowFor('Level 3 checked leaf').depth).toBe(3)

    const indent = (text: string) => parseFloat(rowFor(text).indent || '0')
    expect(indent('Level 0 parent')).toBe(0)
    expect(indent('Level 1 parent')).toBeGreaterThan(indent('Level 0 parent'))
    expect(indent('Level 2 parent')).toBeGreaterThan(indent('Level 1 parent'))
    expect(indent('Level 3 checked leaf')).toBeGreaterThan(indent('Level 2 parent'))
    // One constant step per level, not a collapsing or doubling one. Rounded
    // because the inset is a rem sum and 0.85 * 3 is not exactly 2.55.
    const step = (from: string, to: string) => Math.round((indent(to) - indent(from)) * 1000)
    expect(step('Level 0 parent', 'Level 1 parent')).toBe(step('Level 1 parent', 'Level 2 parent'))
    expect(step('Level 2 parent', 'Level 3 checked leaf')).toBe(step('Level 1 parent', 'Level 2 parent'))
    expect(step('Level 0 parent', 'Level 1 parent')).toBeGreaterThan(0)
  })

  it('renders the whole tree in order, each branch under the row that owns it', () => {
    // Siblings are ordered by the active sort (here: text, since nothing is
    // scheduled); children always follow their own parent.
    expect(renderedRows().map((row) => [row.text, row.depth])).toEqual([
      ['Level 0 leaf', 0],
      ['Level 0 parent', 0],
      ['Level 1 leaf', 1],
      ['Level 1 parent', 1],
      ['Level 2 leaf', 2],
      ['Level 2 parent', 2],
      ['Level 3 checked leaf', 3],
      ['Level 3 open leaf', 3],
    ])
  })

  it('renders completion at depth, not only at the top', () => {
    // A deep item whose state renders as unchecked is data-looking corruption
    // even when the data is fine, so the deepest rows are checked here.
    expect(container.querySelector('[aria-label="Reopen Level 3 checked leaf"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Mark Level 3 open leaf complete"]')).not.toBeNull()
    expect(rowFor('Level 1 parent').cell.querySelector('[data-todo-label]')?.className).toContain('line-through')
    expect(rowFor('Level 2 parent').cell.querySelector('[data-todo-label]')?.className).not.toContain('line-through')
  })

  it('puts the disclosure first in the row, before the checkbox and the text', () => {
    const cell = rowFor('Level 1 parent').cell
    const control = disclosureFor('Level 1 parent')
    expect(control).not.toBeNull()
    expect(cell.firstElementChild).toBe(control)
    // …and the order after it is checkbox, completion toggle, label.
    const roleOf = (child: Element): string => {
      if (child.hasAttribute('data-todo-disclosure')) {
        return 'disclosure'
      }
      if (child.querySelector('input[type="checkbox"]')) {
        return 'select'
      }
      const label = child.getAttribute('aria-label') ?? ''
      if (label.startsWith('Reopen') || label.startsWith('Mark ')) {
        return 'complete'
      }
      return child.hasAttribute('data-todo-label') ? 'label' : 'other'
    }
    const order = Array.from(cell.children).map(roleOf)
    expect(order).toEqual(['disclosure', 'select', 'complete', 'label'])
  })

  it('reserves the same slot on a leaf so one level’s checkboxes stay in line', () => {
    // Without the reserved slot a leaf's checkbox would sit where an expandable
    // sibling's chevron sits, and the column would zig-zag per row.
    const parent = disclosureFor('Level 1 parent')
    const leaf = slotFor('Level 1 leaf')
    expect(parent).not.toBeNull()
    expect(disclosureFor('Level 1 leaf')).toBeNull()
    expect(leaf).not.toBeNull()
    // Same box: identical sizing classes, so the two reserve identical width.
    const sizing = (element: Element) =>
      element.className
        .split(/\s+/)
        .filter((name) => /^(h-|w-|\[@media)/.test(name))
        .sort()
    expect(sizing(leaf as Element)).toEqual(sizing(parent as Element))
    expect(sizing(leaf as Element).length).toBeGreaterThan(0)
    // Both rows are at the same level, so they carry the same inset too.
    expect(rowFor('Level 1 leaf').indent).toBe(rowFor('Level 1 parent').indent)
  })

  it('renders its rows compact, with the controls still finger-sized', () => {
    // The row is tight because the CELL padding shrank, not because the
    // controls did: a 14px tap target is not a target. Measured in headless
    // Chrome at 39px per row (76px before) with 24px controls.
    const cell = container.querySelector('[role="gridcell"]') as HTMLElement
    expect(cell.className).toContain('py-1.5')
    expect(cell.className).not.toContain('py-4')

    for (const control of [
      disclosureFor('Level 0 parent') as HTMLElement,
      rowFor('Level 0 parent').cell.querySelector('label') as HTMLElement,
      container.querySelector('[aria-label="Mark Level 0 parent complete"]') as HTMLElement,
    ]) {
      expect(control).not.toBeNull()
      // 24px on a mouse, 32px on a coarse pointer — inside the tight row.
      expect(control.className).toContain('h-6')
      expect(control.className).toContain('w-6')
      expect(control.className).toContain('[@media(pointer:coarse)]:h-8')
    }
  })

  it('is a real control, not a decorative glyph', () => {
    const control = disclosureFor('Level 0 parent') as HTMLButtonElement
    expect(control.tagName).toBe('BUTTON')
    expect(control.getAttribute('aria-expanded')).toBe('true')
    expect(control.getAttribute('aria-label')).toBe('Collapse Level 0 parent')
    // Focusable: a <button> with no tabindex="-1" on it.
    expect(control.getAttribute('tabindex')).toBeNull()
  })

  it('keeps every subtree together under a non-default sort', () => {
    // The consequence that indentation alone would hide. With the parent links
    // broken, `sortTodoRows` saw only roots and any sort other than the default
    // scattered children away from the task they belong to.
    const defaultOrder = rendered()
    act(() => {
      const select = container.querySelector('select[aria-label="Sort by"]') as HTMLSelectElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'todo')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => {
      ;(container.querySelector('[aria-label="Sort descending"]') as HTMLButtonElement).click()
    })

    const sorted = renderedRows().map((row) => ({ text: row.text, depth: row.depth }))
    // The sort really ran — otherwise the property below would be proved on the
    // default order and this test would be worth nothing.
    expect(sorted.map((row) => row.text)).not.toEqual(defaultOrder)
    expect(sorted).toHaveLength(defaultOrder.length)

    // Tree property: a row is only ever one level deeper than the row above it,
    // which holds exactly when each subtree is emitted as one contiguous block
    // under its own parent.
    const parents: string[] = []
    for (const row of sorted) {
      expect(row.depth).toBeLessThanOrEqual(parents.length)
      parents.length = row.depth
      parents.push(row.text)
    }
    // …and the deepest rows really are under the branch that owns them.
    const indexOf = (text: string) => sorted.findIndex((row) => row.text === text)
    expect(indexOf('Level 3 open leaf')).toBeGreaterThan(indexOf('Level 2 parent'))
    expect(indexOf('Level 2 parent')).toBeGreaterThan(indexOf('Level 1 parent'))
    expect(indexOf('Level 1 parent')).toBeGreaterThan(indexOf('Level 0 parent'))
  })

  it('folds a whole subtree shut and opens it again', () => {
    expect(rendered()).toContain('Level 3 checked leaf')
    act(() => {
      ;(disclosureFor('Level 1 parent') as HTMLButtonElement).click()
    })
    const collapsed = rendered()
    expect(collapsed).toContain('Level 1 parent')
    expect(collapsed).not.toContain('Level 2 parent')
    // The whole subtree, not just the immediate children.
    expect(collapsed).not.toContain('Level 3 checked leaf')
    // …and a sibling branch is untouched.
    expect(collapsed).toContain('Level 1 leaf')
    expect(disclosureFor('Level 1 parent')?.getAttribute('aria-expanded')).toBe('false')
    expect(disclosureFor('Level 1 parent')?.getAttribute('aria-label')).toBe('Expand Level 1 parent')

    act(() => {
      ;(disclosureFor('Level 1 parent') as HTMLButtonElement).click()
    })
    expect(rendered()).toContain('Level 3 checked leaf')
    expect(disclosureFor('Level 1 parent')?.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('Todos view section disclosure', () => {
  beforeEach(() => mount([sectionedNote]))

  it('folds a heading section without offering any action on the section itself', () => {
    const section = container.querySelector<HTMLElement>('[data-todo-heading-level]') as HTMLElement
    const control = section.querySelector<HTMLButtonElement>('[data-todo-disclosure]') as HTMLButtonElement
    expect(control).not.toBeNull()
    // The disclosure is the FIRST thing in the section row, beside the title.
    expect(section.firstElementChild).toBe(control)
    expect(section.querySelectorAll('input')).toHaveLength(0)
    expect(container.querySelector('[aria-label="Select Project"]')).toBeNull()

    expect(rendered()).toContain('Task A')
    act(() => control.click())
    expect(rendered()).not.toContain('Task A')
    expect(rendered()).not.toContain('Sub A1')
    act(() => (section.querySelector<HTMLButtonElement>('[data-todo-disclosure]') as HTMLButtonElement).click())
    expect(rendered()).toContain('Sub A1')
  })
})
