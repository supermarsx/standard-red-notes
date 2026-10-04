/**
 * @jest-environment jsdom
 *
 * The table layout policy in the PDF projection.
 *
 * Before this, every PDF table cell was `flex: 1` (equal columns, always) and every
 * header cell was shaded and bolded unconditionally — so a per-column width was
 * silently dropped and "undifferentiated headers" was silently ignored. These pin
 * both directions, including that a header cell with differentiation OFF is still a
 * header cell.
 */
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, LexicalEditor } from 'lexical'
import { $createTableNodeWithDimensions, $isTableNode, $isTableRowNode, TableCellNode, TableNode } from '@lexical/table'
import {
  $setTableColumnWidthPolicy,
  $setTableHeadersDifferentiated,
  $setTableWidthMethod,
  makeColumnWidthPolicy,
} from '../../Nodes/TableLayoutPolicy'

jest.mock('@react-pdf/renderer', () => ({
  Font: { register: jest.fn() },
  StyleSheet: { create: (styles: unknown) => styles },
}))
jest.mock('./PDFWorker.worker', () => ({ __esModule: true, default: class PDFWorker {} }))
jest.mock('comlink', () => ({ wrap: jest.fn(() => ({ renderPDF: jest.fn() })) }))
jest.mock('unicode-script', () => ({ unicodeScripts: () => [] }))

import { getPDFDataNodeFromLexicalNode } from './PDFExport'

type Style = Record<string, unknown>

const styleOf = (node: ReturnType<typeof getPDFDataNodeFromLexicalNode>): Style =>
  (node && !Array.isArray(node.style) ? ((node.style ?? {}) as Style) : {}) as Style

/** A 2x3 table with a header row, built in a real editor with the real node set. */
const buildEditor = (apply?: (table: TableNode) => void): LexicalEditor => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlockEditorNodes } = require('../../Nodes/AllNodes') as typeof import('../../Nodes/AllNodes')
  const editor = createEditor({
    namespace: 'table-layout-pdf',
    nodes: BlockEditorNodes,
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const table = $createTableNodeWithDimensions(2, 3, true)
      root.append(table)
      let counter = 0
      for (const row of table.getChildren()) {
        if (!$isTableRowNode(row)) {
          continue
        }
        for (const cell of row.getChildren()) {
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode(`Cell${++counter}`))
          ;(cell as TableCellNode).append(paragraph)
        }
      }
      apply?.(table)
    },
    { discrete: true },
  )
  return editor
}

const cellStyles = (editor: LexicalEditor): Style[] => {
  let styles: Style[] = []
  editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find($isTableNode)
    if (table === undefined) {
      throw new Error('expected a table')
    }
    const firstRow = table.getChildren()[0]
    if (!$isTableRowNode(firstRow)) {
      throw new Error('expected a row')
    }
    styles = firstRow.getChildren().map((cell) => styleOf(getPDFDataNodeFromLexicalNode(cell, [])))
  })
  return styles
}

describe('PDF table cells honour the per-column width policy', () => {
  it('shares the width equally when every column is automatic', () => {
    const styles = cellStyles(buildEditor())
    for (const style of styles) {
      expect(style.flex).toBe(1)
      expect(style.width).toBeUndefined()
    }
  })

  it('gives a fixed-width column its width in points, not pixels', () => {
    const styles = cellStyles(
      buildEditor((table) => {
        $setTableWidthMethod(table, 'fixed')
        $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 96))
      }),
    )
    // 96 CSS px at 96dpi is one inch, which is 72 PDF points.
    expect(styles[1].width).toBe(72)
    expect(styles[1].flex).toBeUndefined()
    // The other columns still share what is left.
    expect(styles[0].flex).toBe(1)
  })

  it('passes a percentage column width straight through', () => {
    const styles = cellStyles(
      buildEditor((table) => {
        $setTableWidthMethod(table, 'fixed')
        $setTableColumnWidthPolicy(table, 2, makeColumnWidthPolicy('percent', 40))
      }),
    )
    expect(styles[2].width).toBe('40%')
  })

  it('falls back to equal shares while the equal method suspends the widths', () => {
    const styles = cellStyles(
      buildEditor((table) => {
        $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('fixed', 300))
        $setTableWidthMethod(table, 'equal')
      }),
    )
    expect(styles[0].flex).toBe(1)
    expect(styles[0].width).toBeUndefined()
  })
})

describe('PDF header cells honour the differentiation setting', () => {
  it('shades a header cell by default', () => {
    expect(cellStyles(buildEditor())[0].backgroundColor).toBe('#f4f5f7')
  })

  it('does not shade it when differentiation is off, but it is still a header cell', () => {
    const editor = buildEditor((table) => $setTableHeadersDifferentiated(table, false))
    expect(cellStyles(editor)[0].backgroundColor).toBeUndefined()
    editor.getEditorState().read(() => {
      const table = $getRoot().getChildren().find($isTableNode)
      const firstRow = table?.getChildren()[0]
      if (!$isTableRowNode(firstRow)) {
        throw new Error('expected a row')
      }
      for (const cell of firstRow.getChildren()) {
        expect((cell as TableCellNode).hasHeader()).toBe(true)
      }
    })
  })

  it('stops bolding header text when differentiation is off', () => {
    const boldnessOfFirstHeaderText = (editor: LexicalEditor): unknown => {
      let weight: unknown
      editor.getEditorState().read(() => {
        const table = $getRoot().getChildren().find($isTableNode)
        const firstRow = table?.getChildren()[0]
        if (!$isTableRowNode(firstRow)) {
          throw new Error('expected a row')
        }
        const cell = firstRow.getChildren()[0] as TableCellNode
        const paragraph = cell.getChildren()[cell.getChildrenSize() - 1]
        const text = (paragraph as unknown as { getChildren: () => unknown[] }).getChildren()[0]
        weight = styleOf(getPDFDataNodeFromLexicalNode(text as never, [])).fontWeight
      })
      return weight
    }
    expect(boldnessOfFirstHeaderText(buildEditor())).toBe('bold')
    expect(boldnessOfFirstHeaderText(buildEditor((table) => $setTableHeadersDifferentiated(table, false)))).toBe(
      'normal',
    )
  })
})
