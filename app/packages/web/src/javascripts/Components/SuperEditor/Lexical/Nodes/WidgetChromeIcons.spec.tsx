/**
 * @jest-environment jsdom
 *
 * RENDER GUARD for the remaining character-as-UI chrome in the Super editor's
 * decorator widgets (t111, follow-up to DataTableNode.icons.spec.tsx).
 *
 * Calendar's two month steppers and its event delete, Kanban's column delete,
 * card move-left/right and card delete, and Timeline's item delete were all
 * literal characters pasted into JSX. They are real `Icon` glyphs now, which is
 * invisible to `tsc` in both directions:
 *
 *  1. THE MAPPING MISS. `Icon` renders its `type` as literal text inside a
 *     <label> when the name is absent from the mapping, and
 *     `VectorIconNameOrEmoji` admits any string, so `type="cheveron-left"`
 *     typechecks and ships as the word in a toolbar. IconNameCoverage.spec.ts
 *     sweeps literal names tree-wide but cannot prove these call sites render at
 *     all, so each one is mounted here and asserted to produce an <svg>, no
 *     <label>, and no icon name anywhere in the rendered text.
 *
 *  2. A LOST ACCESSIBLE NAME. Five of these nine buttons had NO accessible name
 *     before, because their entire content was one character; the other four had
 *     one only through `title`, a hover-only fallback. Every name is asserted
 *     here, on the button rather than on the aria-hidden <svg> — an aria-label on
 *     a role="img" child would be concatenated into the button's computed name.
 *
 * None of these nine glyphs conveys state, so unlike DataTableNode's sort
 * indicator and star they are all decorative. The one piece of state in the set
 * is "there is no column that way" on Kanban's move buttons, which the native
 * `disabled` attribute carries; that it tracks the card's column is asserted
 * below so the fixed names cannot be hiding a state the glyph used to show.
 *
 * jsdom has no layout engine, so nothing here measures geometry.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { CalendarComponent, CalendarData } from './CalendarNode'
import { KanbanComponent, KanbanData } from './KanbanNode'
import { TimelineComponent, TimelineData } from './TimelineNode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * All three widgets write through `editor.update(cb)`. A no-op is enough: every
 * state this file reads (the selected calendar day, the rendered rows) is React
 * state or fixture data, never the result of a landed mutation.
 */
const mockEditor = {
  update: () => undefined,
  getEditorState: () => ({ read: () => [] }),
  registerUpdateListener: () => () => undefined,
  getElementByKey: () => null,
}

jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Every icon name these three files are responsible for keeping out of the text. */
const ICON_NAMES = ['close', 'chevron-left', 'chevron-right']

/** A day in the month the calendar opens on, so clicking it reveals its events. */
const NOW = new Date()
const DAY = 15
const DAY_KEY = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(DAY).padStart(2, '0')}`

const CALENDAR_DATA: CalendarData = { events: { [DAY_KEY]: ['Standup', 'Design review'] } }

const KANBAN_DATA: KanbanData = {
  title: 'Board',
  columns: [
    { id: 'c1', title: 'To do', cards: [{ id: 'k1', text: 'First card' }] },
    { id: 'c2', title: 'Done', cards: [{ id: 'k2', text: 'Second card' }] },
  ],
}

const TIMELINE_DATA: TimelineData = {
  version: 1,
  title: 'Roadmap',
  items: [{ id: 't1', label: 'Phase one', start: '2024-01-01', end: '2024-03-01' }],
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const all = (selector: string): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(selector))

const one = (selector: string): HTMLElement => {
  const found = container.querySelector(selector)
  expect(found).not.toBeNull()
  return found as HTMLElement
}

/** An <svg> inside `element`, asserted to exist so later claims cannot pass over nothing. */
const glyphIn = (element: HTMLElement): SVGElement => {
  const svg = element.querySelector('svg')
  expect(svg).not.toBeNull()
  // The emoji fallback path renders a <label> holding the name instead.
  expect(element.querySelector('label')).toBeNull()
  return svg as SVGElement
}

/** Asserts a button is a glyph-only control with a decorative icon and empty text. */
const expectDecorativeGlyphButton = (button: HTMLElement) => {
  expect(glyphIn(button).getAttribute('aria-hidden')).toBe('true')
  expect(button.textContent).toBe('')
}

const expectNoIconNameInText = () => {
  const text = container.textContent ?? ''
  expect(text.length).toBeGreaterThan(0)
  for (const name of ICON_NAMES) {
    expect(text).not.toContain(name)
  }
}

// ===================== Calendar =====================

describe('Calendar block renders icons, not characters', () => {
  const mountCalendar = async () => {
    await act(async () => {
      root.render(createElement(CalendarComponent, { data: CALENDAR_DATA, nodeKey: 'cal-node' }))
      await Promise.resolve()
    })
  }

  /** The day cells are the only buttons inside the seven-column grid. */
  const dayButton = (day: number): HTMLButtonElement => {
    const cells = all('[class*="grid-cols-7"] button')
    expect(cells.length).toBeGreaterThan(20)
    const match = cells.find((cell) => cell.textContent?.trim() === String(day))
    expect(match).toBeDefined()
    return match as HTMLButtonElement
  }

  it('mounts the real widget, so every assertion below has something to read', async () => {
    await mountCalendar()
    expect(one('[data-calendar-block="true"]')).not.toBeNull()
  })

  it('draws glyphs on both month steppers and gives them the names they never had', async () => {
    await mountCalendar()
    const previous = one('button[aria-label="Previous month"]')
    const next = one('button[aria-label="Next month"]')
    expectDecorativeGlyphButton(previous)
    expectDecorativeGlyphButton(next)
    // Two different directions must not be the same drawing.
    expect(glyphIn(previous).innerHTML).not.toBe(glyphIn(next).innerHTML)
  })

  it('still steps the month when the glyph buttons are clicked, so they are wired', async () => {
    await mountCalendar()
    const shown = () => one('[data-calendar-block="true"] .font-semibold').textContent
    const start = shown()

    await act(async () => {
      ;(one('button[aria-label="Next month"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const forward = shown()

    await act(async () => {
      ;(one('button[aria-label="Previous month"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(forward).not.toBe(start)
    expect(shown()).toBe(start)
  })

  it('draws a glyph on each event delete and names it after the event it deletes', async () => {
    await mountCalendar()
    await act(async () => {
      dayButton(DAY).click()
      await Promise.resolve()
    })

    const deletes = all('button[aria-label^="Delete event"]')
    expect(deletes).toHaveLength(2)
    for (const button of deletes) {
      expectDecorativeGlyphButton(button)
    }
    // Two events in one day previously produced two identically-nameless
    // buttons; the names must distinguish them.
    expect(deletes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Delete event: Standup',
      'Delete event: Design review',
    ])
  })

  it('never leaks an icon name into the rendered text', async () => {
    await mountCalendar()
    await act(async () => {
      dayButton(DAY).click()
      await Promise.resolve()
    })
    expectNoIconNameInText()
  })
})

// ===================== Kanban =====================

describe('Kanban block renders icons, not characters', () => {
  const mountKanban = async () => {
    await act(async () => {
      root.render(createElement(KanbanComponent, { data: KANBAN_DATA, nodeKey: 'kanban-node' }))
      await Promise.resolve()
    })
  }

  it('mounts the real widget, so every assertion below has something to read', async () => {
    await mountKanban()
    expect(one('[data-kanban-block="true"]')).not.toBeNull()
  })

  it('draws a glyph on each column delete, promoted from a hover-only title to a real name', async () => {
    await mountKanban()
    const deletes = all('button[aria-label="Delete column"]')
    expect(deletes).toHaveLength(KANBAN_DATA.columns.length)
    for (const button of deletes) {
      expectDecorativeGlyphButton(button)
      // The title stays as the hover tooltip; the name is what changed.
      expect(button.getAttribute('title')).toBe('Delete column')
    }
  })

  it('draws a glyph on each card delete, with a real name', async () => {
    await mountKanban()
    const deletes = all('button[aria-label="Delete card"]')
    expect(deletes).toHaveLength(2)
    for (const button of deletes) {
      expectDecorativeGlyphButton(button)
    }
  })

  it('draws two different glyphs on the card move buttons', async () => {
    await mountKanban()
    const left = all('button[aria-label="Move left"]')
    const right = all('button[aria-label="Move right"]')
    expect(left).toHaveLength(2)
    expect(right).toHaveLength(2)
    for (const button of [...left, ...right]) {
      expectDecorativeGlyphButton(button)
    }
    expect(glyphIn(left[0]).innerHTML).not.toBe(glyphIn(right[0]).innerHTML)
  })

  it('leaves the only state in the set on the native disabled attribute, tracking the column', async () => {
    await mountKanban()
    const left = all('button[aria-label="Move left"]') as HTMLButtonElement[]
    const right = all('button[aria-label="Move right"]') as HTMLButtonElement[]
    // First column: cannot go left. Last column: cannot go right.
    expect(left.map((b) => b.disabled)).toEqual([true, false])
    expect(right.map((b) => b.disabled)).toEqual([false, true])
  })

  it('never leaks an icon name into the rendered text', async () => {
    await mountKanban()
    expectNoIconNameInText()
  })
})

// ===================== Timeline =====================

describe('Timeline block renders icons, not characters', () => {
  const mountTimeline = async () => {
    await act(async () => {
      root.render(createElement(TimelineComponent, { data: TIMELINE_DATA, nodeKey: 'timeline-node' }))
      await Promise.resolve()
    })
  }

  it('mounts the real widget, so every assertion below has something to read', async () => {
    await mountTimeline()
    expect(all('button').length).toBeGreaterThan(0)
  })

  it('draws a glyph on the item delete, promoted from a hover-only title to a real name', async () => {
    await mountTimeline()
    const deletes = all('button[aria-label="Delete item"]')
    expect(deletes).toHaveLength(TIMELINE_DATA.items.length)
    expectDecorativeGlyphButton(deletes[0])
    expect(deletes[0].getAttribute('title')).toBe('Delete item')
  })

  it('never leaks an icon name into the rendered text', async () => {
    await mountTimeline()
    expectNoIconNameInText()
  })
})
