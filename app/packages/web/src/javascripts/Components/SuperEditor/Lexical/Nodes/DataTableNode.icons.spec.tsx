/**
 * @jest-environment jsdom
 *
 * RENDER GUARD for the Data table block's UI glyphs (t111).
 *
 * Every piece of chrome in this widget used to be a literal character pasted
 * into JSX — a link emoji on the resolved-link chip, the toolbar's linked-tables
 * indicator and the per-column link-config button; the three sort states; the
 * primary-column star; the two delete affordances; and the pager's two
 * single-character buttons. They are all real `Icon` glyphs now, which opens two
 * failure modes that neither `tsc` nor a glyph grep can see:
 *
 *  1. THE MAPPING MISS. `Icon` falls back to rendering its `type` as literal
 *     text inside a <label> when the name is absent from
 *     IconNameToSvgMapping / LexicalIconNameToSvgMapping, and
 *     `VectorIconNameOrEmoji` admits any string, so a typo typechecks cleanly
 *     and ships as the word "star-filled" sitting in a table header.
 *     IconNameCoverage.spec.ts sweeps literal `<Icon type="…">` names across the
 *     tree and would catch a typo here, but it cannot prove these particular
 *     call sites are reached at all — so this mounts the real widget and asserts
 *     an <svg> exists and no icon name leaks into the rendered text.
 *
 *  2. A LOST ACCESSIBLE NAME. The sort indicator and the star CONVEY STATE
 *     (ascending / descending / unsorted; primary column or not) that a
 *     character at least announced as "black up-pointing triangle" / "black
 *     star". An aria-hidden <svg> announces nothing, so the state moved onto the
 *     owning button's aria-label (plus aria-pressed for the star) — where a
 *     control's name belongs — and the glyph is decorative. The pager buttons
 *     had no accessible name at all before. Those names are asserted here,
 *     including that the sort name actually TRACKS the state rather than being a
 *     constant string.
 *
 * jsdom has no layout engine, so nothing here measures geometry.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { DataTableComponent, DataTableData } from './DataTableNode'
import { IdentifiedTable } from './dataTableRelations'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The widget reads sibling tables through `editor.getEditorState().read(...)`,
 * whose callback walks the real Lexical tree ($getRoot). Returning the list
 * directly instead of invoking the callback hands the component a resolvable
 * link target without standing up a whole editor. `update` is a no-op because
 * nothing here needs a mutation to land — both star states are rendered at once
 * by giving the fixture two columns.
 */
const OTHER_TABLE: IdentifiedTable = {
  id: 'dt-other',
  columns: ['Key', 'Label'],
  rows: [['k1', 'Target row one']],
  keyColumn: 0,
}

const mockEditor = {
  update: () => undefined,
  getEditorState: () => ({ read: () => [OTHER_TABLE] }),
  registerUpdateListener: () => () => undefined,
  getElementByKey: () => null,
}

jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Two pages of rows so the pager renders; column 1 is a resolvable link column. */
const DATA: DataTableData = {
  id: 'dt-self',
  columns: ['Name', 'Owner'],
  rows: [
    ['Alpha', 'k1'],
    ['Beta', 'k1'],
    ['Gamma', 'no-such-key'],
    ['Delta', ''],
  ],
  keyColumn: 0,
  links: [null, { targetTableId: 'dt-other', targetKeyColumn: 0, displayColumn: 1 }],
  rowsPerPage: 2,
}

/** Every icon name this file is responsible for keeping out of the rendered text. */
const ICON_NAMES = [
  'link',
  'arrows-sort-up',
  'arrows-sort-down',
  'arrows-vertical',
  'star-filled',
  'star',
  'close',
  'chevron-left',
  'chevron-right',
]

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

const mount = async (data: DataTableData = DATA) => {
  await act(async () => {
    root.render(createElement(DataTableComponent, { data, nodeKey: 'dt-node' }))
    await Promise.resolve()
  })
}

const one = (selector: string): HTMLElement => {
  const found = container.querySelector(selector)
  expect(found).not.toBeNull()
  return found as HTMLElement
}

const all = (selector: string): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(selector))

/** An <svg> inside `element`, asserted to exist so later claims cannot pass over nothing. */
const glyphIn = (element: HTMLElement): SVGElement => {
  const svg = element.querySelector('svg')
  expect(svg).not.toBeNull()
  // The emoji fallback path renders a <label> with the name in it instead.
  expect(element.querySelector('label')).toBeNull()
  return svg as SVGElement
}

describe('Data table block renders icons, not characters', () => {
  it('mounts the real widget at all, so every assertion below has something to read', async () => {
    await mount()
    expect(one('[data-datatable-block="true"]')).not.toBeNull()
    expect(all('button').length).toBeGreaterThan(5)
  })

  it('never leaks an icon name into the rendered text (the Icon mapping-miss trap)', async () => {
    await mount()
    const text = container.textContent ?? ''
    expect(text.length).toBeGreaterThan(0)
    for (const name of ICON_NAMES) {
      expect(text).not.toContain(name)
    }
    // A mapping miss is a <label>; the widget renders none anywhere.
    expect(all('label').filter((node) => ICON_NAMES.includes(node.textContent ?? ''))).toEqual([])
  })

  // ----- the resolved-link chip (was an emoji span inside the cell) -----

  it('draws a glyph beside the resolved row label on a matched link cell', async () => {
    await mount()
    const chips = all('[title^="Linked row"]')
    expect(chips.length).toBeGreaterThan(0)
    const chip = chips[0]
    expect(glyphIn(chip)).not.toBeNull()
    expect(chip.textContent).toContain('Target row one')
    expect(chip.textContent).not.toContain('link')
  })

  it('keeps that chip glyph decorative, because the row label right next to it already names it', async () => {
    await mount()
    const svg = glyphIn(all('[title^="Linked row"]')[0])
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('aria-label')).toBeNull()
  })

  // ----- the toolbar's "tables this base links to" indicator (was an emoji span) -----

  it('draws a glyph on the linked-tables indicator and leaves it decorative', async () => {
    await mount()
    const indicator = one('[title="Tables this base links to"]')
    const svg = glyphIn(indicator)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    // The target table's own label is the adjacent text that names the group.
    expect(indicator.textContent).toContain('Key')
  })

  // ----- the per-column sort affordance (was the three triangle characters) -----

  it('draws a glyph on every column sort button', async () => {
    await mount()
    const buttons = all('button[aria-label^="Sort by this column"]')
    expect(buttons).toHaveLength(DATA.columns.length)
    for (const button of buttons) {
      expect(glyphIn(button)).not.toBeNull()
      expect(button.textContent).toBe('')
    }
  })

  it('names the unsorted state on the sort button, since an aria-hidden glyph announces nothing', async () => {
    await mount()
    const button = all('button[aria-label^="Sort by this column"]')[0]
    expect(button.getAttribute('aria-label')).toBe('Sort by this column (not sorted)')
    expect(glyphIn(button).getAttribute('aria-hidden')).toBe('true')
  })

  it('changes BOTH the accessible name and the glyph through unsorted -> ascending -> descending', async () => {
    await mount()
    const button = all('button[aria-label^="Sort by this column"]')[0] as HTMLButtonElement

    const unsortedName = button.getAttribute('aria-label')
    const unsortedGlyph = glyphIn(button).innerHTML
    expect(unsortedGlyph.length).toBeGreaterThan(0)

    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    const ascendingName = button.getAttribute('aria-label')
    const ascendingGlyph = glyphIn(button).innerHTML

    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    const descendingName = button.getAttribute('aria-label')
    const descendingGlyph = glyphIn(button).innerHTML

    expect(unsortedName).toBe('Sort by this column (not sorted)')
    expect(ascendingName).toBe('Sort by this column (sorted ascending)')
    expect(descendingName).toBe('Sort by this column (sorted descending)')

    // Three distinct drawings, not one glyph with three names.
    expect(ascendingGlyph).not.toBe(unsortedGlyph)
    expect(descendingGlyph).not.toBe(unsortedGlyph)
    expect(descendingGlyph).not.toBe(ascendingGlyph)
  })

  // ----- the primary-column star (was the filled/outlined star characters) -----

  it('draws a different glyph for the primary column than for a non-primary one', async () => {
    await mount()
    const primary = one('button[aria-label="Primary/label column"]')
    const other = one('button[aria-label="Set as primary/label column"]')
    const primaryGlyph = glyphIn(primary).innerHTML
    const otherGlyph = glyphIn(other).innerHTML
    expect(primaryGlyph.length).toBeGreaterThan(0)
    expect(primaryGlyph).not.toBe(otherGlyph)
    expect(primary.textContent).toBe('')
    expect(other.textContent).toBe('')
  })

  it('exposes primary-column state as a pressed toggle, not as colour alone', async () => {
    await mount()
    expect(one('button[aria-label="Primary/label column"]').getAttribute('aria-pressed')).toBe('true')
    expect(one('button[aria-label="Set as primary/label column"]').getAttribute('aria-pressed')).toBe('false')
  })

  // ----- the per-column link-config button (was a bare emoji, icon-only) -----

  it('draws a glyph on the icon-only link-config button and gives the button the name', async () => {
    await mount()
    const buttons = all('button[aria-label="Configure link to another table"]')
    expect(buttons).toHaveLength(DATA.columns.length)
    for (const button of buttons) {
      expect(glyphIn(button).getAttribute('aria-hidden')).toBe('true')
      expect(button.textContent).toBe('')
      expect(button.getAttribute('aria-expanded')).toBe('false')
    }
  })

  // ----- the two delete affordances (were multiplication-sign characters) -----

  it('draws a glyph on the delete-column and delete-row buttons', async () => {
    await mount()
    const columns = all('button[aria-label="Delete column"]')
    const rows = all('button[aria-label="Delete row"]')
    expect(columns).toHaveLength(DATA.columns.length)
    // Two rows per page, per the fixture.
    expect(rows).toHaveLength(2)
    for (const button of [...columns, ...rows]) {
      expect(glyphIn(button)).not.toBeNull()
      expect(button.textContent).toBe('')
    }
  })

  // ----- the pager (was two single-character buttons with no accessible name) -----

  it('gives the pager buttons glyphs and the accessible names they never had', async () => {
    await mount()
    const previous = one('button[aria-label="Previous page"]')
    const next = one('button[aria-label="Next page"]')
    expect(glyphIn(previous).innerHTML).not.toBe(glyphIn(next).innerHTML)
    expect(previous.textContent).toBe('')
    expect(next.textContent).toBe('')
    // Still the real pager: disabled on the first page, enabled forwards.
    expect((previous as HTMLButtonElement).disabled).toBe(true)
    expect((next as HTMLButtonElement).disabled).toBe(false)
  })

  it('still pages when the glyph buttons are clicked, so they are wired and not decoration', async () => {
    await mount()
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).not.toContain('Gamma')

    await act(async () => {
      ;(one('button[aria-label="Next page"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Gamma')
    expect(container.textContent).not.toContain('Alpha')
  })
})
