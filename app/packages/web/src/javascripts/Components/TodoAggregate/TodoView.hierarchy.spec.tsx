/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FeatureStatus, NoteType, SNNote, UuidGenerator } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import TodoView from './TodoView'
import { TODO_MAX_INDENT_LEVEL } from './todoFilters'

/**
 * Render-path coverage for nested todos. The filter module proves the tree is
 * computed correctly; this proves it actually reaches the DOM — indented, depth
 * labelled past the display ceiling, and with ancestors kept as context when
 * only a descendant matches a filter.
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

type TaskSpec = { text: string; children?: TaskSpec[] }

const listItem = (task: TaskSpec): unknown => ({
  type: 'listitem',
  checked: false,
  children: [
    { type: 'text', text: task.text },
    ...(task.children && task.children.length > 0 ? [checkList(task.children)] : []),
  ],
})

const checkList = (tasks: TaskSpec[]): unknown => ({
  type: 'list',
  listType: 'check',
  children: tasks.map(listItem),
})

const noteText = (tasks: TaskSpec[]): string => JSON.stringify({ root: { type: 'root', children: [checkList(tasks)] } })

/** A single chain `Level 0` → … → `Level n-1`, one task per level. */
const chain = (levels: number): TaskSpec => {
  let deepest: TaskSpec = { text: `Level ${levels - 1}` }
  for (let level = levels - 2; level >= 0; level -= 1) {
    deepest = { text: `Level ${level}`, children: [deepest] }
  }
  return deepest
}

const notes: SNNote[] = [
  {
    uuid: 'tree',
    title: 'Project',
    trashed: false,
    locked: false,
    noteType: NoteType.Super,
    payload: {},
    text: noteText([
      {
        text: 'Parent task',
        children: [{ text: 'Child one', children: [{ text: 'Grandchild milk' }] }, { text: 'Child two' }],
      },
      { text: 'Unrelated task' },
    ]),
  } as unknown as SNNote,
  {
    uuid: 'deep',
    title: 'Deep note',
    trashed: false,
    locked: false,
    noteType: NoteType.Super,
    payload: {},
    text: noteText([chain(14)]),
  } as unknown as SNNote,
]

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

/** Each rendered row as `[text, depth attribute, left indent]`. */
const renderedRows = () =>
  Array.from(container.querySelectorAll('[role="row"]'))
    .map((row) => row.querySelector<HTMLElement>('[role="gridcell"] [data-todo-depth]'))
    .filter((cell): cell is HTMLElement => cell !== null)
    .map((cell) => ({
      text: cell.textContent?.trim() ?? '',
      depth: Number(cell.getAttribute('data-todo-depth')),
      indent: cell.style.paddingInlineStart,
    }))

const searchFor = (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search todos"]') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  UuidGenerator.SetGenerator(() => 'todo-hierarchy-table-test')
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
  act(() => root.unmount())
  container.remove()
  globalThis.ResizeObserver = originalResizeObserver
  HTMLElement.prototype.animate = originalAnimate
})

describe('Todos hierarchy display', () => {
  it('renders subtasks under their parent, indented by level', () => {
    const rows = renderedRows()
    const byText = new Map(rows.map((row) => [row.text.replace(/^•/, '').trim(), row]))

    expect(byText.get('Parent task')?.depth).toBe(0)
    expect(byText.get('Child one')?.depth).toBe(1)
    expect(byText.get('Grandchild milk')?.depth).toBe(2)

    // Indentation is what makes the level visible, so it must actually grow.
    const indentOf = (text: string) => parseFloat(byText.get(text)?.indent ?? '0')
    expect(indentOf('Parent task')).toBe(0)
    expect(indentOf('Child one')).toBeGreaterThan(indentOf('Parent task'))
    expect(indentOf('Grandchild milk')).toBeGreaterThan(indentOf('Child one'))
  })

  it('keeps each child directly after its own parent', () => {
    const order = renderedRows().map((row) => row.text.replace(/^•/, '').trim())
    expect(order.indexOf('Child one')).toBeGreaterThan(order.indexOf('Parent task'))
    expect(order.indexOf('Grandchild milk')).toBe(order.indexOf('Child one') + 1)
  })

  it('renders past the ten-level ceiling with the indent clamped and the real level stated', () => {
    const rows = renderedRows()
    const deepest = rows.find((row) => row.text.includes('Level 13'))
    expect(deepest).toBeDefined()
    expect(deepest?.depth).toBe(13)
    // Row 13 must not be indented further than the level-10 row.
    const atCeiling = rows.find((row) => row.depth === TODO_MAX_INDENT_LEVEL)
    expect(parseFloat(deepest?.indent ?? '0')).toBe(parseFloat(atCeiling?.indent ?? '0'))
    // …and it says how deep it really is, since the indent no longer can.
    expect(deepest?.text).toContain('L13')
    expect(container.textContent).toContain('Level 13')
  })

  it('shows the ancestors of a match as muted context rather than orphaning it', () => {
    searchFor('milk')
    const rows = renderedRows().map((row) => row.text.replace(/^•/, '').trim())
    expect(rows.some((text) => text.includes('Grandchild milk'))).toBe(true)
    expect(rows.some((text) => text.includes('Parent task'))).toBe(true)
    expect(rows.some((text) => text.includes('Child one'))).toBe(true)
    // The non-matching branch is gone entirely.
    expect(rows.some((text) => text.includes('Child two'))).toBe(false)
    expect(rows.some((text) => text.includes('Unrelated task'))).toBe(false)

    // Context ancestors are visually distinguished from the actual match.
    const contextCells = Array.from(container.querySelectorAll('[title$="shown as the parent of a match"]'))
    expect(contextCells.map((cell) => cell.textContent?.trim())).toEqual(['Parent task', 'Child one'])

    // …and they are not counted as results.
    expect(container.textContent).toContain('showing 1 of')
  })
})
