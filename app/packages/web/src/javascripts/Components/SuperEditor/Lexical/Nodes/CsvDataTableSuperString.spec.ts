/**
 * @jest-environment jsdom
 *
 * Validates that the hand-built Super editor-state JSON produced by the CSV ->
 * spreadsheet importer (`csvToDataTableSuperString`) parses cleanly with the
 * real Lexical editor configured with the same nodes the Super editor uses, and
 * that the DataTableNode it contains round-trips with the expected data.
 *
 * This is the cross-package guarantee that the importer's serialized string is
 * a valid Super note (i.e. would pass `isValidSuperString`).
 */

import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import { csvToDataTableSuperString, parseCsv } from '@standardnotes/ui-services'
import { DataTableNode, $isDataTableNode } from './DataTableNode'

const editor = createHeadlessEditor({
  namespace: 'CsvDataTableSuperStringTest',
  nodes: [DataTableNode],
  onError: (error) => {
    throw error
  },
})

describe('csvToDataTableSuperString -> Lexical', () => {
  it('parses as a valid editor state (would pass isValidSuperString)', () => {
    const rows = parseCsv('Name,Status\nAda,Done\nLinus,"In, progress"')
    const superString = csvToDataTableSuperString(rows)

    expect(() => {
      const state = editor.parseEditorState(superString)
      editor.setEditorState(state)
    }).not.toThrow()
  })

  it('round-trips columns and rows into a DataTableNode', () => {
    const rows = parseCsv('Name,Status\nAda,Done\nLinus,"In, progress"')
    const superString = csvToDataTableSuperString(rows)

    editor.setEditorState(editor.parseEditorState(superString))

    let data: { columns: string[]; rows: string[][] } | undefined
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren()
      const node = children[0]
      if ($isDataTableNode(node)) {
        data = node.getData()
      }
    })

    expect(data).toEqual({
      columns: ['Name', 'Status'],
      rows: [
        ['Ada', 'Done'],
        ['Linus', 'In, progress'],
      ],
    })
  })
})
