/**
 * @jest-environment jsdom
 *
 * The table layout policy in the standalone-HTML export.
 *
 * `exportDOM` cannot be overridden on a stock `TableNode`, so the policy reaches
 * exported HTML through the `html.export` decorator registered on the export
 * editor. If that registration is ever dropped the attributes disappear silently —
 * the export still succeeds, just without the policy — so it is pinned here.
 *
 * The matching CSS is asserted at the source level, the same way
 * WidgetLayoutContract.spec.ts does, because NoteExportUtils inlines the whole of
 * editor.scss into the exported document: an attribute with no rule behind it would
 * also be a silent no-op.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { $createTableNodeWithDimensions, $isTableRowNode, TableCellNode, TableNode } from '@lexical/table'
import BlocksEditorTheme from '../Lexical/Theme/Theme'
import { SuperExportNodes } from '../Lexical/Nodes/AllNodes'
import {
  $setTableColumnWidthPolicy,
  $setTableHeadersDifferentiated,
  $setTableWidthMethod,
  makeColumnWidthPolicy,
} from '../Lexical/Nodes/TableLayoutPolicy'
import { HeadlessSuperConverter } from './HeadlessSuperConverter'

const buildSuperString = (apply?: (table: TableNode) => void): string => {
  const editor = createHeadlessEditor({
    namespace: 'BlocksEditor',
    theme: BlocksEditorTheme,
    editable: false,
    onError: (error: Error) => {
      throw error
    },
    nodes: SuperExportNodes,
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
  return JSON.stringify(editor.getEditorState())
}

const exportHtml = async (apply?: (table: TableNode) => void): Promise<string> =>
  new HeadlessSuperConverter().convertSuperStringToOtherFormat(buildSuperString(apply), 'html')

describe('standalone HTML export carries the table layout policy', () => {
  it('marks the width method on the exported table', async () => {
    const html = await exportHtml((table) => $setTableWidthMethod(table, 'full'))
    expect(html).toContain('data-super-table-width="full"')
  })

  it('marks undifferentiated headers, and only when they are undifferentiated', async () => {
    expect(await exportHtml()).not.toContain('data-super-table-headers')
    const plain = await exportHtml((table) => $setTableHeadersDifferentiated(table, false))
    expect(plain).toContain('data-super-table-headers="plain"')
  })

  it('keeps the header cells as th even with differentiation off', async () => {
    const html = await exportHtml((table) => $setTableHeadersDifferentiated(table, false))
    expect(html).toContain('<th')
  })

  it('carries a per-column width on the colgroup the browser sizes from', async () => {
    const html = await exportHtml((table) => {
      $setTableWidthMethod(table, 'fixed')
      $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('percent', 35))
    })
    const colgroup = html.slice(html.indexOf('<colgroup'), html.indexOf('</colgroup>'))
    expect(colgroup).toContain('35%')
  })
})

describe('the exported stylesheet actually acts on those attributes', () => {
  const editorScss = fs.readFileSync(path.resolve(__dirname, '../Lexical/Theme/editor.scss'), 'utf8')
  const noteExportUtils = fs.readFileSync(path.resolve(__dirname, '../../../Utils/NoteExportUtils.ts'), 'utf8')

  it('inlines the editor stylesheet into the exported document', () => {
    // Without this the attributes below would be inert in the exported file.
    expect(noteExportUtils).toContain('Lexical/Theme/editor.scss')
    expect(noteExportUtils).toContain('${superEditorCSS.toString()}')
  })

  it('has a rule for every width method that is not the default', () => {
    for (const method of ['full', 'fixed', 'equal']) {
      expect(editorScss).toContain(`table.Lexical__table[data-super-table-width='${method}']`)
    }
    // `content` is the default and is exactly the base rules, so it needs none —
    // and deliberately has none, so the paper-fit override still wins in print and
    // in the exported file.
    expect(editorScss).not.toContain("table.Lexical__table[data-super-table-width='content']")
  })

  it('gives fixed and equal the fixed table layout that honours column widths', () => {
    expect(editorScss).toMatch(
      /table\.Lexical__table\[data-super-table-width='fixed'\],\s*table\.Lexical__table\[data-super-table-width='equal'\]\s*\{[^}]*table-layout:\s*fixed/s,
    )
  })

  it('flattens only the header APPEARANCE for a plain-header table', () => {
    expect(editorScss).toMatch(
      /table\.Lexical__table\[data-super-table-headers='plain'\] th[^{]*\{[^}]*background-color:\s*transparent[^}]*font-weight:\s*normal/s,
    )
  })
})
