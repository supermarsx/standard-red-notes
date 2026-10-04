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

const textNode = (value: string) => ({ type: 'text', text: value })
const headingNode = (tag: string, label: string, type = 'heading') => ({ type, tag, children: [textNode(label)] })
const paragraphNode = (label: string, type = 'paragraph') => ({ type, children: [textNode(label)] })

/**
 * `# Project` (with prose under it) → `Task A` → `Sub A1`, then `## Phase 1`
 * (no prose) → `Task B`. The styled spelling is used for the second heading
 * because that is what most real headings in this editor serialize as.
 */
const sectionedNoteText = JSON.stringify({
  root: {
    type: 'root',
    children: [
      headingNode('h1', 'Project'),
      paragraphNode('Everything the quarter needs.'),
      checkList([{ text: 'Task A', children: [{ text: 'Sub A1' }] }]),
      headingNode('h2', 'Phase 1', 'heading-styled'),
      checkList([{ text: 'Task B' }]),
    ],
  },
})

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

/**
 * Mounted ALONE by the heading-section tests. `useTable` materializes only the
 * first `MinRowsToDisplay` (20) rows, and in jsdom that is the whole window
 * because `document.documentElement.clientHeight` is 0 — so a note added to the
 * list above would have its rows silently windowed out rather than asserted.
 */
const sectionsNote = {
  uuid: 'sections',
  title: 'Quarter plan',
  trashed: false,
  locked: false,
  noteType: NoteType.Super,
  payload: {},
  text: sectionedNoteText,
} as unknown as SNNote

let container: HTMLElement
let root: Root
let storage: Map<string, unknown>
let originalResizeObserver: typeof ResizeObserver
let originalAnimate: typeof HTMLElement.prototype.animate

const mount = (list: SNNote[] = notes) => {
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

/** Only the heading-section cells, as `[text, level, depth]`. */
const renderedSections = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"] [data-todo-heading-level]')).map((cell) => ({
    text: cell.querySelector('span > span')?.textContent?.trim() ?? '',
    level: Number(cell.getAttribute('data-todo-heading-level')),
    depth: Number(cell.getAttribute('data-todo-depth')),
    cell,
  }))

const remount = (list: SNNote[] = notes) => {
  act(() => root.unmount())
  container.remove()
  mount(list)
}

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

describe('Todos heading sections', () => {
  const sectionRow = (text: string) => renderedSections().find((section) => section.text === text)

  beforeEach(() => {
    remount([sectionsNote])
  })

  it('renders a heading as a section row and puts its tasks one level inside it', () => {
    expect(renderedSections().map((section) => [section.text, section.level, section.depth])).toEqual([
      ['Project', 1, 0],
      // The STYLED heading is found too; matching only `'heading'` would lose it.
      ['Phase 1', 2, 1],
    ])

    const byText = new Map(renderedRows().map((row) => [row.text.replace(/^•/, '').trim(), row]))
    expect(byText.get('Task A')?.depth).toBe(1)
    // Section base plus checklist nesting.
    expect(byText.get('Sub A1')?.depth).toBe(2)
    expect(byText.get('Task B')?.depth).toBe(2)
  })

  it('indents a section’s tasks further than the section itself', () => {
    const rows = renderedRows()
    const indentOf = (text: string) =>
      parseFloat(rows.find((row) => row.text.replace(/^•/, '').trim().startsWith(text))?.indent ?? '0')
    expect(indentOf('Project')).toBe(0)
    expect(indentOf('Task A')).toBeGreaterThan(indentOf('Project'))
    expect(indentOf('Sub A1')).toBeGreaterThan(indentOf('Task A'))
  })

  it('renders the text under a heading as that section’s description, and nothing when there is none', () => {
    expect(sectionRow('Project')?.cell.textContent).toContain('Everything the quarter needs.')
    // No em dash, no placeholder, no empty line: `Phase 1` has no prose under it.
    const phase = sectionRow('Phase 1')?.cell
    expect(phase?.textContent?.trim()).toBe('Phase 1')
    expect(phase?.textContent).not.toContain('—')
  })

  it('offers no checkbox, no completion toggle and no schedule on a section', () => {
    // A section is a title. Every control here would offer to do something to it,
    // and the selection checkbox would write a todo identity into the document.
    const project = sectionRow('Project')?.cell
    expect(project?.querySelectorAll('input, button')).toHaveLength(0)
    expect(container.querySelector('[aria-label="Select Project"]')).toBeNull()
    expect(container.querySelector('[aria-label="Mark Project complete"]')).toBeNull()

    const projectRow = project?.closest('[role="row"]')
    expect(projectRow?.textContent).not.toContain('No due date')
    expect(projectRow?.textContent).not.toContain('Add schedule')
    // …while a real task in the same note still has all three.
    expect(container.querySelector('[aria-label="Select Task A"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Mark Task A complete"]')).not.toBeNull()
  })

  it('shows sections muted, as the context they are, and counts only the todos', () => {
    searchFor('Task B')
    expect(renderedSections().map((section) => section.text)).toEqual(['Project', 'Phase 1'])
    // Four rows on screen, one result: a section is never counted.
    expect(container.textContent).toContain('showing 1 of')
    expect(container.querySelectorAll('[title$="shown as the parent of a match"]')).toHaveLength(0)
  })

  it('falls back to flat rows when the sublevels setting is off', () => {
    storage.set('todoHeadingLevels', false)
    remount([sectionsNote])
    expect(renderedSections()).toHaveLength(0)
    const byText = new Map(renderedRows().map((row) => [row.text.replace(/^•/, '').trim(), row]))
    expect(byText.get('Task A')?.depth).toBe(0)
    expect(byText.get('Sub A1')?.depth).toBe(1)
    expect(byText.get('Task B')?.depth).toBe(0)
    expect(container.textContent).not.toContain('Everything the quarter needs.')
  })

  it('keeps the sections and drops only the description when that setting is off', () => {
    storage.set('todoHeadingDescriptions', false)
    remount([sectionsNote])
    expect(renderedSections().map((section) => section.text)).toEqual(['Project', 'Phase 1'])
    expect(container.textContent).not.toContain('Everything the quarter needs.')
  })

  it('does both by default, because an absent preference must not read as off', () => {
    // `PrefDefaults` has no runtime entry for either key yet, and `undefined` is
    // falsy — reading the default from there would ship both features off.
    expect(storage.has('todoHeadingLevels')).toBe(false)
    expect(storage.has('todoHeadingDescriptions')).toBe(false)
    expect(renderedSections()).toHaveLength(2)
    expect(container.textContent).toContain('Everything the quarter needs.')
  })

  it('offers both settings in the bar, with the description one gated on sublevels', () => {
    const levels = container.querySelector<HTMLInputElement>('[aria-label="Headings create todo sublevels"]')
    const descriptions = container.querySelector<HTMLInputElement>(
      '[aria-label="Text after a heading is its description"]',
    )
    expect(levels?.checked).toBe(true)
    expect(descriptions?.checked).toBe(true)
    expect(descriptions?.disabled).toBe(false)

    act(() => {
      levels?.click()
    })
    expect(storage.get('todoHeadingLevels')).toBe(false)
    expect(renderedSections()).toHaveLength(0)
    // A description belongs to a section, so with sections off the switch is
    // disabled rather than silently doing nothing.
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Text after a heading is its description"]')?.disabled,
    ).toBe(true)
  })
})
