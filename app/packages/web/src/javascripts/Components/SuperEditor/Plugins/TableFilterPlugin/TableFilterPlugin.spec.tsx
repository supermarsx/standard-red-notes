/**
 * @jest-environment jsdom
 *
 * A control that typechecks and passes logic tests can still render nowhere, so
 * this mounts a REAL Lexical editor with a real table and asserts, in the DOM:
 *
 *   - a filter chip exists in every cell of the top row;
 *   - clicking one opens the in-place panel inside the table's caption;
 *   - choosing an operator and typing a value sets `data-srn-table-filtered` on
 *     exactly the rows that fail the filter, and on nothing else;
 *   - the caption carries the "Filtered: showing X of Y rows" disclosure and a
 *     Show-all-rows control whenever a filter is active;
 *   - the row count, the chip and the caption all disappear again when cleared.
 *
 * jsdom has no layout engine, so no assertion here reads a dimension. The two
 * geometry-adjacent guarantees - that a hidden row is hidden on screen and shown
 * in print - are pinned instead against the COMPILED stylesheet.
 */

import * as path from 'path'
import * as sass from 'sass'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableRowNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import { $createTextNode, $getRoot, isDOMUnmanaged, LexicalEditor } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import TableFilterPlugin, {
  createFilterChip,
  FILTER_CAPTION_ATTR,
  FILTER_CHIP_ATTR,
  FILTER_CLEAR_ATTR,
  FILTER_STATUS_PRINT_ATTR,
  FILTER_STATUS_SCREEN_ATTR,
  FILTERED_ROW_ATTR,
  syncFilterChip,
} from './TableFilterPlugin'

const TABLE_FILTER_SCSS = path.resolve(__dirname, 'TableFilter.scss')

let compiledCss = ''
/** The body of every `@media print { … }` block, concatenated. */
let printCss = ''
/** The body of every `@media (pointer: coarse) { … }` block. */
let coarsePointerCss = ''

/**
 * The bodies of every block introduced by `prelude`, found by brace matching.
 *
 * Scoping matters: a naive `/@media print[\s\S]*<rule>/` matches a rule that
 * lives ANYWHERE later in the stylesheet, so deleting the print override
 * entirely left the assertion green against an unrelated block. That mutation
 * survived once; it does not now.
 */
const blockBodies = (css: string, prelude: string): string[] => {
  const bodies: string[] = []
  let searchFrom = 0
  for (;;) {
    const start = css.indexOf(prelude, searchFrom)
    if (start === -1) {
      return bodies
    }
    const open = css.indexOf('{', start + prelude.length)
    if (open === -1) {
      return bodies
    }
    let depth = 0
    let position = open
    for (; position < css.length; position++) {
      if (css[position] === '{') {
        depth++
      } else if (css[position] === '}') {
        depth--
        if (depth === 0) {
          break
        }
      }
    }
    bodies.push(css.slice(open + 1, position))
    searchFrom = position + 1
  }
}

beforeAll(() => {
  compiledCss = sass.compile(TABLE_FILTER_SCSS, { style: 'expanded' }).css
  printCss = blockBodies(compiledCss, '@media print').join('\n')
  coarsePointerCss = blockBodies(compiledCss, '@media (pointer: coarse)').join('\n')
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GRID: string[][] = [
  ['Name', 'Price'],
  ['Apple', '10'],
  ['Banana', '40'],
  ['Cherry', '5'],
]

function SeedTableDocument({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const table = $createTableNodeWithDimensions(GRID.length, GRID[0].length, true)
        root.append(table)
        table.getChildren().forEach((row, rowIndex) => {
          if (!$isTableRowNode(row)) {
            return
          }
          row.getChildren().forEach((cell, columnIndex) => {
            if (!$isTableCellNode(cell)) {
              return
            }
            const paragraph = cell.getFirstChild()
            if (paragraph !== null && 'append' in paragraph) {
              ;(paragraph as unknown as { append: (child: ReturnType<typeof $createTextNode>) => void }).append(
                $createTextNode(GRID[rowIndex][columnIndex]),
              )
            }
          })
        })
      },
      { discrete: true },
    )
    onReady(editor)
  }, [editor, onReady])

  return null
}

type Harness = {
  container: HTMLElement
  editor: LexicalEditor
  unmount: () => void
}

const mount = (): Harness => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const reactRoot = createRoot(container)
  let editor: LexicalEditor | undefined
  const onReady = (next: LexicalEditor) => {
    editor = next
  }

  act(() => {
    reactRoot.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: 'TableFilterPluginSpec',
            nodes: [TableNode, TableRowNode, TableCellNode],
            onError: (error: Error) => {
              throw error
            },
            theme: {
              table: 'Lexical__table',
              tableCell: 'Lexical__tableCell',
              tableCellHeader: 'Lexical__tableCellHeader',
            },
          },
        },
        createElement(RichTextPlugin, {
          contentEditable: createElement(ContentEditable, {}),
          placeholder: null,
          ErrorBoundary: LexicalErrorBoundary,
        }),
        createElement(SeedTableDocument, { onReady }),
        createElement(TableFilterPlugin),
      ),
    )
  })

  if (!editor) {
    throw new Error('The editor never became ready')
  }

  return {
    container,
    editor,
    unmount: () => {
      act(() => reactRoot.unmount())
      container.remove()
    },
  }
}

const bodyRows = (container: HTMLElement): HTMLTableRowElement[] =>
  Array.from(container.querySelectorAll('tr')).slice(1)

const filteredFlags = (container: HTMLElement): string[] =>
  bodyRows(container).map((row) => row.getAttribute(FILTERED_ROW_ATTR) ?? 'shown')

const setInputValue = (input: HTMLInputElement, value: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the injected filter chip', () => {
  it('is marked Lexical-unmanaged so the MutationObserver cannot evict it', () => {
    expect(isDOMUnmanaged(createFilterChip())).toBe(true)
  })

  it('is a non-editable, named, role=button chip that carries its own glyph', () => {
    const chip = createFilterChip()
    expect(chip.tagName).toBe('SPAN')
    expect(chip.getAttribute(FILTER_CHIP_ATTR)).toBe('true')
    expect(chip.getAttribute('role')).toBe('button')
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.getAttribute('tabindex')).toBe('-1')
    expect(chip.className).toContain('Lexical__tableFilterButton')
    expect(chip.querySelector('svg')).not.toBeNull()
  })

  it('names the column, and the active filter, in its accessible name and tooltip', () => {
    const cell = document.createElement('th')
    const chip = syncFilterChip(cell, 1, 'Price', null, false)
    expect(chip.getAttribute('aria-label')).toBe('Filter Price')
    expect(chip.getAttribute('title')).toBe('Filter Price')
    expect(chip.getAttribute('data-srn-table-filter-active')).toBe('false')

    const again = syncFilterChip(cell, 1, 'Price', 'is less than 30', true)
    expect(again).toBe(chip)
    expect(chip.getAttribute('aria-label')).toBe('Filter Price: is less than 30')
    expect(chip.getAttribute('data-srn-table-filter-active')).toBe('true')
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(cell.querySelectorAll(`[${FILTER_CHIP_ATTR}]`)).toHaveLength(1)
  })

  it('is appended after the cell’s Lexical-managed children, never before them', () => {
    const cell = document.createElement('th')
    const managed = document.createElement('p')
    cell.appendChild(managed)
    const chip = syncFilterChip(cell, 0, 'Name', null, false)
    expect(cell.children[0]).toBe(managed)
    expect(cell.lastElementChild).toBe(chip)
  })
})

describe('the chip is discoverable without any header styling', () => {
  it('paints its own background, border and glyph colour', () => {
    expect(compiledCss).toMatch(/\.Lexical__tableFilterButton\s*\{[^}]*background-color:\s*var\(/s)
    expect(compiledCss).toMatch(/\.Lexical__tableFilterButton\s*\{[^}]*border:\s*1px solid var\(/s)
    expect(compiledCss).toMatch(/\.Lexical__tableFilterButton\s*\{[^}]*color:\s*var\(/s)
  })

  it('never rests at zero opacity and is never gated behind :hover', () => {
    const restingOpacity = /\.Lexical__tableFilterButton\s*\{[^}]*opacity:\s*([\d.]+)/s.exec(compiledCss)
    expect(restingOpacity).not.toBeNull()
    expect(Number(restingOpacity?.[1])).toBeGreaterThan(0)
    expect(compiledCss).not.toMatch(/\.Lexical__tableFilterButton\s*\{[^}]*(display:\s*none|visibility:\s*hidden)/s)
    expect(coarsePointerCss).toMatch(/\.Lexical__tableFilterButton\s*\{[^}]*opacity:\s*1/)
  })
})

describe('hiding is presentation, and print restores every row', () => {
  // Sass emits attribute selectors unquoted, so every pattern here accepts both.
  it('hides a filtered row on screen with exactly one display rule', () => {
    expect(compiledCss).toMatch(/tr\[data-srn-table-filtered=['"]?true['"]?\]\s*\{\s*display:\s*none;\s*\}/)
  })

  it('shows every row again in print, and in the detached print snapshot', () => {
    // Asserted INSIDE the @media print block, not merely somewhere after it.
    expect(printCss).toMatch(
      /(^|\})\s*tr\[data-srn-table-filtered=['"]?true['"]?\]\s*\{[^}]*display:\s*table-row !important/,
    )
    expect(compiledCss).toMatch(
      /body\.srn-printing\s+tr\[data-srn-table-filtered=['"]?true['"]?\]\s*\{[^}]*display:\s*table-row !important/,
    )
  })

  it('swaps the on-screen row count for the not-applied notice in print', () => {
    expect(compiledCss).toMatch(/\[data-srn-table-filter-status-print\]\s*\{\s*display:\s*none;\s*\}/)
    expect(printCss).toMatch(/\[data-srn-table-filter-status-screen\]\s*\{[^}]*display:\s*none !important/)
    expect(printCss).toMatch(/\[data-srn-table-filter-status-print\]\s*\{[^}]*display:\s*inline !important/)
    expect(compiledCss).toMatch(
      /body\.srn-printing\s+\[data-srn-table-filter-status-print\]\s*\{[^}]*display:\s*inline !important/,
    )
  })
})

describe('the mounted editor', () => {
  it('renders a chip in every cell of the top row and nowhere else', () => {
    const harness = mount()
    try {
      const chips = harness.container.querySelectorAll(`[${FILTER_CHIP_ATTR}]`)
      expect(chips).toHaveLength(GRID[0].length)
      chips.forEach((chip) => {
        expect(chip.parentElement?.closest('tr')).toBe(harness.container.querySelector('tr'))
      })
      expect(harness.container.querySelector(`[${FILTER_CAPTION_ATTR}]`)).toBeNull()
      expect(filteredFlags(harness.container)).toEqual(['shown', 'shown', 'shown'])
    } finally {
      harness.unmount()
    }
  })

  it('opens the in-place panel in the table caption when a chip is clicked', async () => {
    const harness = mount()
    try {
      const chip = harness.container.querySelectorAll<HTMLElement>(`[${FILTER_CHIP_ATTR}]`)[1]
      await act(async () => {
        chip.click()
      })

      const caption = harness.container.querySelector<HTMLElement>(`caption[${FILTER_CAPTION_ATTR}]`)
      expect(caption).not.toBeNull()
      expect(caption?.parentElement?.tagName).toBe('TABLE')
      expect(caption?.getAttribute('contenteditable')).toBe('false')
      expect(isDOMUnmanaged(caption as HTMLElement)).toBe(true)

      const panel = caption?.querySelector('[data-srn-table-filter-panel="true"]')
      expect(panel).not.toBeNull()
      expect(panel?.getAttribute('aria-label')).toBe('Filter Price')
      // A number column must be offered arithmetic, not substring matching.
      expect(panel?.querySelector('[data-srn-table-filter-operator="lt"]')).not.toBeNull()
      expect(panel?.querySelector('[data-srn-table-filter-operator="between"]')).not.toBeNull()
      expect(panel?.querySelector('[data-srn-table-filter-operator="contains"]')).toBeNull()
      expect(panel?.querySelector('[data-srn-table-filter-column-type="number"]')).not.toBeNull()
    } finally {
      harness.unmount()
    }
  })

  it('hides exactly the failing rows, discloses the count, and clears again', async () => {
    const harness = mount()
    try {
      const chip = harness.container.querySelectorAll<HTMLElement>(`[${FILTER_CHIP_ATTR}]`)[1]
      await act(async () => {
        chip.click()
      })

      await act(async () => {
        harness.container.querySelector<HTMLElement>('[data-srn-table-filter-operator="lt"]')?.click()
      })
      const input = harness.container.querySelector<HTMLInputElement>('[data-srn-table-filter-value="0"]')
      expect(input).not.toBeNull()
      await act(async () => {
        setInputValue(input as HTMLInputElement, '30')
      })

      // Apple 10 and Cherry 5 stay; Banana 40 is hidden. The row is still there.
      expect(filteredFlags(harness.container)).toEqual(['shown', 'true', 'shown'])
      expect(bodyRows(harness.container)).toHaveLength(3)
      expect(bodyRows(harness.container)[1].textContent).toContain('Banana')

      const screenStatus = harness.container.querySelector<HTMLElement>(`[${FILTER_STATUS_SCREEN_ATTR}]`)
      expect(screenStatus?.textContent).toBe('Filtered: showing 2 of 3 rows — 1 hidden by 1 column filter')
      const printStatus = harness.container.querySelector<HTMLElement>(`[${FILTER_STATUS_PRINT_ATTR}]`)
      expect(printStatus?.textContent).toBe('All 3 rows shown. 1 column filter active on screen was not applied here.')
      expect(harness.container.querySelector<HTMLElement>('[data-srn-table-filter-status]')?.getAttribute('role')).toBe(
        'status',
      )

      // The chip for that column now announces the filter itself.
      expect(
        harness.container.querySelectorAll<HTMLElement>(`[${FILTER_CHIP_ATTR}]`)[1].getAttribute('aria-label'),
      ).toBe('Filter Price: is less than 30')

      const clear = harness.container.querySelector<HTMLElement>(`[${FILTER_CLEAR_ATTR}]`)
      expect(clear?.textContent).toBe('Show all rows')
      await act(async () => {
        clear?.click()
      })

      expect(filteredFlags(harness.container)).toEqual(['shown', 'shown', 'shown'])
      expect(harness.container.querySelector(`[${FILTER_STATUS_SCREEN_ATTR}]`)).toBeNull()
    } finally {
      harness.unmount()
    }
  })

  it('offers an edit route from the always-visible caption, not only from the chip', async () => {
    const harness = mount()
    try {
      const chip = harness.container.querySelectorAll<HTMLElement>(`[${FILTER_CHIP_ATTR}]`)[1]
      await act(async () => {
        chip.click()
      })
      await act(async () => {
        harness.container.querySelector<HTMLElement>('[data-srn-table-filter-operator="lt"]')?.click()
      })
      await act(async () => {
        setInputValue(harness.container.querySelector<HTMLInputElement>('[data-srn-table-filter-value="0"]')!, '30')
      })
      // Close the panel; the caption must still offer a way back in.
      await act(async () => {
        harness.container.querySelector<HTMLElement>('[data-srn-table-filter-close="true"]')?.click()
      })

      expect(harness.container.querySelector('[data-srn-table-filter-panel="true"]')).toBeNull()
      const edit = harness.container.querySelector<HTMLElement>('[data-srn-table-filter-edit]')
      expect(edit?.textContent).toBe('Edit Price')

      await act(async () => {
        edit?.click()
      })
      expect(harness.container.querySelector('[data-srn-table-filter-panel="true"]')).not.toBeNull()
    } finally {
      harness.unmount()
    }
  })

  it('combines two conditions in one column, and says so', async () => {
    const harness = mount()
    try {
      const chip = harness.container.querySelectorAll<HTMLElement>(`[${FILTER_CHIP_ATTR}]`)[1]
      await act(async () => {
        chip.click()
      })
      await act(async () => {
        harness.container.querySelector<HTMLElement>('[data-srn-table-filter-operator="lt"]')?.click()
      })
      await act(async () => {
        setInputValue(harness.container.querySelector<HTMLInputElement>('[data-srn-table-filter-value="0"]')!, '8')
      })
      await act(async () => {
        harness.container.querySelector<HTMLElement>('[data-srn-table-filter-add="true"]')?.click()
      })
      const secondRow = harness.container.querySelector<HTMLElement>('[data-srn-table-filter-condition="1"]')
      expect(secondRow).not.toBeNull()
      await act(async () => {
        secondRow?.querySelector<HTMLElement>('[data-srn-table-filter-operator="gt"]')?.click()
      })
      await act(async () => {
        setInputValue(harness.container.querySelector<HTMLInputElement>('[data-srn-table-filter-value="1"]')!, '30')
      })

      // Price < 8 AND Price > 30 is satisfied by nothing. Every row is hidden -
      // and the caption says so rather than letting the table read as empty.
      expect(filteredFlags(harness.container)).toEqual(['true', 'true', 'true'])
      expect(harness.container.querySelector(`[${FILTER_STATUS_SCREEN_ATTR}]`)?.textContent).toBe(
        'Filtered: showing 0 of 3 rows — 3 hidden by 1 column filter',
      )

      // The same two conditions under "any" keep Banana (40) and Cherry (5).
      await act(async () => {
        harness.container.querySelector<HTMLElement>('[data-srn-table-filter-combinator="any"]')?.click()
      })
      expect(filteredFlags(harness.container)).toEqual(['true', 'shown', 'shown'])
      expect(harness.container.querySelector(`[${FILTER_STATUS_SCREEN_ATTR}]`)?.textContent).toBe(
        'Filtered: showing 2 of 3 rows — 1 hidden by 1 column filter',
      )
    } finally {
      harness.unmount()
    }
  })
})
