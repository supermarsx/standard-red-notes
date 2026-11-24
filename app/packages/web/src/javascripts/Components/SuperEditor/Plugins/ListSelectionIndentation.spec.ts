/** @jest-environment jsdom */
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  ListItemNode,
  ListNode,
  registerList,
  type ListType,
} from '@lexical/list'
import { registerRichText } from '@lexical/rich-text'
import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $nodesOfType,
  $setSelection,
  createEditor,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
} from 'lexical'
import { registerTabIndentation } from './TabIndentationPlugin'

function fixture(type: ListType, backward = false, dom = false) {
  const create = dom ? createEditor : createHeadlessEditor
  const editor = create({
    namespace: 'SelectedListIndentation',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  const element = dom ? document.createElement('div') : undefined
  if (element) {
    element.contentEditable = 'true'
    element.tabIndex = 0
    document.body.append(element)
    editor.setRootElement(element)
    element.focus()
  }
  const cleanup = [registerRichText(editor), registerList(editor), registerTabIndentation(editor)]
  editor.update(
    () => {
      const list = $createListNode(type)
      const texts = ['one', 'two', 'three'].map((text) => $createTextNode(text))
      list.append(
        ...texts.map((text, index) => $createListItemNode(type === 'check' ? index === 1 : undefined).append(text)),
      )
      $getRoot().append(list)
      const selection = $createRangeSelection()
      selection.setTextNodeRange(
        backward ? texts[2] : texts[0],
        backward ? 5 : 0,
        backward ? texts[0] : texts[2],
        backward ? 0 : 5,
      )
      $setSelection(selection)
    },
    { discrete: true },
  )
  const snapshot = () =>
    editor.getEditorState().read(() => ({
      rows: $getRoot()
        .getAllTextNodes()
        .map((node) => node.getParentOrThrow())
        .filter($isListItemNode)
        .map((item) => ({
          text: item.getTextContent(),
          indent: item.getIndent(),
          checked: item.getChecked(),
        })),
      selected: $getSelection()?.getTextContent(),
      backward: $isRangeSelection($getSelection()) && $getSelection()!.isBackward(),
    }))
  const tab = (shiftKey = false) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      keyCode: 9,
      shiftKey,
      bubbles: true,
      cancelable: true,
    })
    if (element) {
      element.dispatchEvent(event)
    } else {
      editor.dispatchCommand(KEY_TAB_COMMAND, event)
    }
    editor.update(() => {}, { discrete: true })
    return event
  }
  return {
    editor,
    element,
    snapshot,
    tab,
    dispose: () => {
      cleanup.reverse().forEach((stop) => stop())
      if (element) {
        editor.setRootElement(null)
        element.remove()
      }
    },
  }
}

describe('selected list keyboard indentation', () => {
  it.each(['bullet', 'number', 'check'] as const)(
    'indents every selected %s row without replacing its text',
    (type) => {
      const test = fixture(type)
      try {
        const before = test.snapshot()
        expect(test.tab().defaultPrevented).toBe(true)
        expect(test.snapshot().rows).toEqual(before.rows.map((row) => ({ ...row, indent: 1 })))
        expect(test.snapshot().selected).toBe(before.selected)
        test.tab(true)
        expect(test.snapshot().rows).toEqual(before.rows)
        expect(test.snapshot().selected).toBe(before.selected)
      } finally {
        test.dispose()
      }
    },
  )

  it('keeps a backward list selection intact through indent and outdent', () => {
    const test = fixture('bullet', true)
    try {
      const before = test.snapshot()
      test.tab()
      expect(test.snapshot().rows).toEqual(before.rows.map((row) => ({ ...row, indent: 1 })))
      expect(test.snapshot().backward).toBe(true)
      test.tab(true)
      expect(test.snapshot()).toEqual(before)
    } finally {
      test.dispose()
    }
  })

  it.each(['bullet', 'number', 'check'] as const)(
    'carries selected %s parents and their nested rows exactly one level',
    (type) => {
      const test = fixture(type)
      try {
        test.editor.update(
          () => {
            const rows = $nodesOfType(ListItemNode)
            const child = $createListItemNode(type === 'check' ? true : undefined).append($createTextNode('child'))
            rows[1].insertAfter($createListItemNode().append($createListNode(type).append(child)))
            const first = rows[1].getFirstChildOrThrow()
            const last = rows[2].getFirstChildOrThrow()
            const selection = $createRangeSelection()
            selection.anchor.set(first.getKey(), 0, 'text')
            selection.focus.set(last.getKey(), 5, 'text')
            $setSelection(selection)
          },
          { discrete: true },
        )
        const before = test.snapshot()
        test.tab()
        expect(test.snapshot().rows.map((row) => [row.text, row.indent])).toEqual([
          ['one', 0],
          ['two', 1],
          ['child', 2],
          ['three', 1],
        ])
        test.tab(true)
        expect(test.snapshot()).toEqual(before)
      } finally {
        test.dispose()
      }
    },
  )

  it('leaves an unselected following row at its original depth', () => {
    const test = fixture('bullet')
    try {
      test.editor.update(
        () => {
          const rows = $nodesOfType(ListItemNode)
          const selection = $createRangeSelection()
          selection.anchor.set(rows[1].getFirstChildOrThrow().getKey(), 0, 'text')
          selection.focus.set(rows[2].getFirstChildOrThrow().getKey(), 0, 'text')
          $setSelection(selection)
        },
        { discrete: true },
      )
      test.tab()
      expect(test.snapshot().rows.map((row) => row.indent)).toEqual([0, 1, 0])
    } finally {
      test.dispose()
    }
  })

  it('uses the same selected-row behavior for toolbar indent commands', () => {
    const test = fixture('number')
    try {
      test.editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)
      test.editor.update(() => {}, { discrete: true })
      expect(test.snapshot().rows.map((row) => row.indent)).toEqual([1, 1, 1])
    } finally {
      test.dispose()
    }
  })

  it('preserves custom list marker styling through indentation', () => {
    const test = fixture('number')
    try {
      const style = 'list-style-type: lower-alpha; --sn-list-marker: lower-alpha;'
      test.editor.update(
        () => {
          $nodesOfType(ListNode)[0].setStyle(style)
        },
        { discrete: true },
      )
      test.tab()
      expect(test.editor.getEditorState().read(() => $nodesOfType(ListNode).map((list) => list.getStyle()))).toEqual([
        style,
        style,
      ])
      test.tab(true)
      expect(test.editor.getEditorState().read(() => $nodesOfType(ListNode).map((list) => list.getStyle()))).toEqual([
        style,
      ])
    } finally {
      test.dispose()
    }
  })

  it('normalizes element-based selections before moving rows', () => {
    const test = fixture('bullet')
    try {
      test.editor.update(
        () => {
          $nodesOfType(ListNode)[0].select(0, 3)
        },
        { discrete: true },
      )
      const selected = test.snapshot().selected
      test.tab()
      expect(test.snapshot().rows.map((row) => row.indent)).toEqual([1, 1, 1])
      expect(test.snapshot().selected).toBe(selected)
      test.tab(true)
      expect(test.snapshot().rows.map((row) => row.indent)).toEqual([0, 0, 0])
    } finally {
      test.dispose()
    }
  })

  it('keeps selected text intact at the maximum list depth', () => {
    const test = fixture('bullet')
    try {
      for (let level = 0; level < 6; level++) {
        test.tab()
      }
      const before = test.snapshot()
      expect(before.rows.map((row) => row.indent)).toEqual([6, 6, 6])
      test.tab()
      expect(test.snapshot()).toEqual(before)
    } finally {
      test.dispose()
    }
  })

  it('handles repeated DOM Tab and Shift+Tab without losing selected rows or freezing reconciliation', () => {
    const test = fixture('bullet', false, true)
    try {
      const before = test.snapshot()
      test.tab()
      test.tab()
      expect(test.snapshot().rows.map((row) => row.indent)).toEqual([2, 2, 2])
      expect(test.element?.textContent).toBe('onetwothree')
      test.tab(true)
      test.tab(true)
      expect(test.snapshot()).toEqual(before)
      expect(test.element?.querySelector('ul ul')).toBeNull()
    } finally {
      test.dispose()
    }
  })
})
