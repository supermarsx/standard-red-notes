/** @jest-environment jsdom */

/**
 * TXT export fidelity for checklists.
 *
 * The bar here is EXACT BYTES, not "contains". TXT is the format people grep and
 * diff, so what changed is the whole point: a four-level list used to come out as
 * four unindented lines separated by blank lines, with no `[x]`/`[ ]` anywhere,
 * and the reader could not tell which tasks were done.
 *
 * The input is built through the real `ListItemNode.setIndent`, so the tree has
 * the shape Lexical actually produces: an indented row lives inside a TEXT-LESS
 * WRAPPER list item copied from it. A hand-built `listitem: [text, nestedList]`
 * is a shape Lexical never emits, and the wrapper is exactly what this walk has
 * to recognise.
 */

import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, type ListType } from '@lexical/list'
import { $createQuoteNode } from '@lexical/rich-text'
import { $createTableCellNode, $createTableNode, $createTableRowNode, TableCellHeaderStates } from '@lexical/table'
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical'
import { SuperExportNodes } from '../Nodes/AllNodes'
import BlocksEditorTheme from '../Theme/Theme'
import { $generatePlainTextFromRoot, PLAIN_TEXT_LIST_INDENT } from './PlainTextExport'

const editorWith = (build: () => void): LexicalEditor => {
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
      $getRoot().clear()
      build()
    },
    { discrete: true },
  )
  return editor
}

type Row = { depth: number; checked?: boolean; text: string }

/** Appends `rows` as one list, indented through the real editor API. */
const appendIndentedList = (listType: ListType, rows: Row[]) => {
  const list = $createListNode(listType)
  const items = rows.map((row) => {
    const item = $createListItemNode(listType === 'check' ? row.checked === true : undefined)
    if (row.text.length > 0) {
      item.append($createTextNode(row.text))
    }
    return item
  })
  list.append(...items)
  $getRoot().append(list)
  // Only once ATTACHED, shallowest first: `setIndent` rewrites the live tree.
  items.forEach((item, index) => {
    if (rows[index].depth > 0) {
      item.setIndent(rows[index].depth)
    }
  })
}

const plainText = (editor: LexicalEditor): string => editor.read(() => $generatePlainTextFromRoot())

const lexicalTextContent = (editor: LexicalEditor): string => editor.read(() => $getRoot().getTextContent())

describe('$generatePlainTextFromRoot', () => {
  it('writes the exact bytes for a four-level checklist with mixed state', () => {
    const editor = editorWith(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('Before')))
      appendIndentedList('check', [
        { depth: 0, checked: true, text: 'Pack' },
        { depth: 1, checked: false, text: 'Socks' },
        { depth: 2, checked: true, text: 'Wool' },
        { depth: 3, checked: false, text: 'Thick' },
      ])
      $getRoot().append($createParagraphNode().append($createTextNode('After')))
    })

    expect(plainText(editor)).toBe('Before\n\n[x] Pack\n  [ ] Socks\n    [x] Wool\n      [ ] Thick\n\nAfter')
  })

  it('used to lose both facts: no state and no depth, with blank lines between rows', () => {
    // The old implementation, verbatim, so the two outputs are compared rather
    // than the fix being asserted against itself.
    const editor = editorWith(() => {
      appendIndentedList('check', [
        { depth: 0, checked: true, text: 'Pack' },
        { depth: 1, checked: false, text: 'Socks' },
      ])
    })

    expect(lexicalTextContent(editor)).toBe('Pack\n\nSocks')
    expect(plainText(editor)).toBe('[x] Pack\n  [ ] Socks')
  })

  it('indents a bullet and a numbered nest without inventing markers', () => {
    const bullet = editorWith(() =>
      appendIndentedList('bullet', [
        { depth: 0, text: 'One' },
        { depth: 1, text: 'Two' },
        { depth: 2, text: 'Three' },
      ]),
    )
    expect(plainText(bullet)).toBe('One\n  Two\n    Three')

    const numbered = editorWith(() =>
      appendIndentedList('number', [
        { depth: 0, text: 'First' },
        { depth: 1, text: 'Nested' },
      ]),
    )
    // Plain text, so the ordering is the line order. `[x]`/`[ ]` is the only
    // syntax kept, because it is the only fact the lines cannot carry.
    expect(plainText(numbered)).toBe('First\n  Nested')
  })

  it('emits no line for the wrapper and no blank line inside a list', () => {
    const editor = editorWith(() =>
      appendIndentedList('check', [
        { depth: 0, checked: false, text: 'A' },
        { depth: 1, checked: false, text: 'B' },
        { depth: 0, checked: false, text: 'C' },
      ]),
    )
    const text = plainText(editor)
    expect(text.split('\n')).toEqual(['[ ] A', '  [ ] B', '[ ] C'])
    expect(text).not.toContain('\n\n')
  })

  it('keeps an empty row, which is a task the user can still tick', () => {
    const editor = editorWith(() =>
      appendIndentedList('check', [
        { depth: 0, checked: false, text: '' },
        { depth: 1, checked: true, text: 'Under it' },
      ]),
    )
    expect(plainText(editor)).toBe('[ ] \n  [x] Under it')
  })

  it('keeps the first row at its real depth when it is the one indented', () => {
    // No previous sibling for `$handleIndent` to put the wrapper after, so the
    // list's only child is the wrapper itself.
    const editor = editorWith(() => appendIndentedList('check', [{ depth: 1, checked: false, text: 'Only' }]))
    expect(plainText(editor)).toBe(`${PLAIN_TEXT_LIST_INDENT}[ ] Only`)
  })

  it('leaves a note with no list byte-identical to Lexical own serialization', () => {
    const editor = editorWith(() => {
      const root = $getRoot()
      root.append($createParagraphNode().append($createTextNode('Para one')))
      root.append($createQuoteNode().append($createTextNode('A quote')))
      root.append($createParagraphNode().append($createTextNode('Para two')))
    })
    expect(plainText(editor)).toBe(lexicalTextContent(editor))
    expect(plainText(editor)).toBe('Para one\n\nA quote\n\nPara two')
  })

  it('reaches a checklist nested inside a table cell', () => {
    const editor = editorWith(() => {
      const table = $createTableNode()
      const row = $createTableRowNode()
      const cell = $createTableCellNode(TableCellHeaderStates.NO_STATUS)
      const list = $createListNode('check')
      const done = $createListItemNode(true)
      done.append($createTextNode('In a cell'))
      list.append(done)
      cell.append(list)
      row.append(cell)
      table.append(row)
      $getRoot().append(table)
    })
    expect(plainText(editor)).toBe('[x] In a cell')
  })

  it('keeps a checklist inside a quote, with the quote block separator intact', () => {
    const editor = editorWith(() => {
      const root = $getRoot()
      root.append($createParagraphNode().append($createTextNode('Lead')))
      appendIndentedList('check', [
        { depth: 0, checked: false, text: 'Open' },
        { depth: 1, checked: true, text: 'Shut' },
      ])
      root.append($createQuoteNode().append($createTextNode('Trailing quote')))
    })
    expect(plainText(editor)).toBe('Lead\n\n[ ] Open\n  [x] Shut\n\nTrailing quote')
  })
})
