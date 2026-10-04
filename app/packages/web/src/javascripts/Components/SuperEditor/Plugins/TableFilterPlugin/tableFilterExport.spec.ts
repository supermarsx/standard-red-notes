/**
 * @jest-environment jsdom
 *
 * EXPORT AND PRINT CONTAIN EVERY ROW.
 *
 * An export that silently omits rows is a data-loss bug wearing a feature's
 * clothes, so a table with an active filter exports in full and the filter is
 * NOTED rather than applied.
 *
 * This is structural rather than a policy that has to be remembered:
 *   - Standalone HTML, Markdown, plain text and JSON go through
 *     `HeadlessSuperConverter`, which builds a HEADLESS editor from the stored
 *     JSON and runs `$generateHtmlFromNodes` over the node tree. The filter is
 *     node state that nothing in that path reads, and the row hiding is a DOM
 *     attribute that path never produces.
 *   - DOCX and ODT go through `DocModel.superStringToDocModel`, another headless
 *     editor over the same tree.
 *   - PRINT is the one surface that clones the LIVE editor DOM, so there the
 *     filtered-row attribute really is present - and the stylesheet's `@media
 *     print` rule puts every row back. That rule is pinned in
 *     `TableFilterPlugin.spec.tsx`.
 *
 * These tests fail if a future change ever teaches an export path to read the
 * filter.
 */

const mockGeneratePDF = jest.fn<Promise<Blob>, unknown[]>()

jest.mock('../../Lexical/Utils/PDFExport/PDFExport', () => ({
  $generatePDFFromNodes: (...args: unknown[]) => mockGeneratePDF(...args),
}))

import fs from 'node:fs'
import nodePath from 'node:path'
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableRowNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import { $createTextNode, $getRoot } from 'lexical'

import { PRINTING_BODY_CLASS, sanitizePrintBody } from '@/Components/NoteView/Print/PrintNote'
import { HeadlessSuperConverter } from '../../Tools/HeadlessSuperConverter'
import { superStringToDocModel } from '../../Lexical/Utils/DocExport/DocModel'
import { SuperExportNodes } from '../../Lexical/Nodes/AllNodes'
import BlocksEditorTheme from '../../Lexical/Theme/Theme'
import { $ensureColumnId, $readTableGrid, $setTableColumnFilter } from './tableFilterState'

const GRID: string[][] = [
  ['Name', 'Price'],
  ['Apple', '10'],
  ['Banana', '40'],
  ['Cherry', '5'],
]

/**
 * What every export MUST contain, spelled out literally rather than derived from
 * `GRID`. Deriving it would make the denominator flatter the moment a row went
 * missing: `GRID.flat()` shrinks with the fixture, so a document that lost a row
 * would be judged against the shortened list and pass.
 */
const EXPECTED_EXPORTED_VALUES = ['Name', 'Price', 'Apple', '10', 'Banana', '40', 'Cherry', '5']
const EXPECTED_ROW_COUNT = 4

/**
 * A super note holding one table whose Price column is filtered to `< 30`,
 * which on screen hides exactly the Banana row.
 */
const filteredTableDocument = (): string => {
  const editor = createHeadlessEditor({
    namespace: 'TableFilterExportFixture',
    theme: BlocksEditorTheme,
    nodes: [...SuperExportNodes, TableNode, TableRowNode, TableCellNode],
    onError: (error: Error) => {
      throw error
    },
  })

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

      const columnId = $ensureColumnId($readTableGrid(table), 1)
      if (columnId === null) {
        throw new Error('the fixture column was never given an id')
      }
      $setTableColumnFilter(table, columnId, {
        combinator: 'all',
        conditions: [{ operator: 'lt', value: '30', value2: '' }],
      })
    },
    { discrete: true },
  )

  return JSON.stringify(editor.getEditorState().toJSON())
}

describe('a filtered table exports in full', () => {
  let superString = ''

  beforeAll(() => {
    superString = filteredTableDocument()
  })

  it('stores the filter, so these tests are not vacuous', () => {
    expect(superString).toContain('superTableColumnFilters')
    expect(superString).toContain('superTableFilterColumnId')
  })

  it.each(['html', 'md', 'txt'] as const)('keeps every row in the %s export', async (format) => {
    const exported = await new HeadlessSuperConverter().convertSuperStringToOtherFormat(superString, format)
    for (const value of EXPECTED_EXPORTED_VALUES) {
      expect(exported).toContain(value)
    }
    // The row the on-screen filter hides is the one worth naming explicitly.
    expect(exported).toContain('Banana')
    expect(exported).toContain('40')
  })

  it('keeps every row in the JSON export, filter state and all', async () => {
    const exported = await new HeadlessSuperConverter().convertSuperStringToOtherFormat(superString, 'json')
    expect(exported).toBe(superString)
  })

  it('keeps every row in the DOCX / ODT document model', async () => {
    const blocks = await superStringToDocModel(superString)
    const tables = blocks.filter((block) => block.kind === 'table')
    expect(tables).toHaveLength(1)
    const table = tables[0]
    if (table.kind !== 'table') {
      throw new Error('expected a table block')
    }
    // The row COUNT, not only the content: a document model that dropped the
    // filtered row would still contain every surviving string.
    expect(table.rows).toHaveLength(EXPECTED_ROW_COUNT)
    const flattened = JSON.stringify(tables)
    for (const value of EXPECTED_EXPORTED_VALUES) {
      expect(flattened).toContain(value)
    }
  })

  it('does not leak the on-screen hiding attribute into exported HTML', async () => {
    const exported = await new HeadlessSuperConverter().convertSuperStringToOtherFormat(superString, 'html')
    expect(exported).not.toContain('data-srn-table-filtered')
    expect(exported).not.toContain('data-srn-table-filter-caption')
    expect(exported).not.toContain('data-srn-table-filter-chip')
  })
})

/**
 * PRINT is the one surface that really does see the hidden rows, because
 * `PrintNote` prints a `cloneNode(true)` of the LIVE editor DOM. Asserted here
 * against the REAL sanitizer rather than reasoned about: it removes `button`,
 * `input` and every `[role="button"]`, and it already restores folded content,
 * so it was entirely plausible that it would also strip the row or the caption
 * and leave print with nothing to restore.
 */
describe('the print clone keeps every row and the disclosure', () => {
  const printableTable = (): HTMLElement => {
    const source = document.createElement('div')
    source.innerHTML = [
      '<table>',
      '<caption data-srn-table-filter-caption="true" class="Lexical__tableFilterCaption">',
      '<div class="Lexical__tableFilterStatus" role="status" data-srn-table-filter-status="true">',
      '<span data-srn-table-filter-status-screen="true">Filtered: showing 2 of 3 rows</span>',
      '<span data-srn-table-filter-status-print="true">All 3 rows shown.</span>',
      '<span role="button" data-srn-table-filter-clear="true">Show all rows</span>',
      '</div></caption>',
      '<tr><th>Price<span role="button" data-srn-table-filter-chip="true"></span></th></tr>',
      '<tr><td>10</td></tr>',
      '<tr data-srn-table-filtered="true"><td>40</td></tr>',
      '</table>',
    ].join('')
    document.body.appendChild(source)
    return source
  }

  it('keeps the filtered row, its text and its marker so CSS can restore it', () => {
    const source = printableTable()
    try {
      const clone = sanitizePrintBody(source.cloneNode(true) as HTMLElement, source)
      expect(clone.querySelectorAll('tr')).toHaveLength(3)
      expect(clone.textContent).toContain('40')
      expect(clone.querySelector('tr[data-srn-table-filtered="true"]')).not.toBeNull()
    } finally {
      source.remove()
    }
  })

  it('keeps the print wording and drops the interactive chrome', () => {
    const source = printableTable()
    try {
      const clone = sanitizePrintBody(source.cloneNode(true) as HTMLElement, source)
      expect(clone.querySelector('[data-srn-table-filter-caption]')).not.toBeNull()
      expect(clone.querySelector('[data-srn-table-filter-status-print]')).not.toBeNull()
      expect(clone.querySelector('[data-srn-table-filter-status-screen]')).not.toBeNull()
      // The sanitizer already strips every role=button, so the chip and the
      // Show-all-rows control need no print rule of their own.
      expect(clone.querySelector('[data-srn-table-filter-chip]')).toBeNull()
      expect(clone.querySelector('[data-srn-table-filter-clear]')).toBeNull()
    } finally {
      source.remove()
    }
  })

  it('targets the body class PrintNote actually sets', () => {
    const scss = fs.readFileSync(nodePath.resolve(__dirname, 'TableFilter.scss'), 'utf8')
    expect(PRINTING_BODY_CLASS).toBe('srn-printing')
    expect(scss).toContain(`body.${PRINTING_BODY_CLASS}`)
  })
})
