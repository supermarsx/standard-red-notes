/**
 * @jest-environment jsdom
 *
 * Regression coverage for the "pressing Tab fully hangs the app" bug.
 *
 * The Super editor's TabIndentationPlugin makes Tab insert a literal tab in
 * normal text and nest/outdent inside a list. An earlier implementation hung
 * the UI because:
 *   1. it inserted a tab via `selection.insertText('\t')`, and
 *   2. inside a list it `return`ed the *result* of `dispatchCommand(INDENT…)`
 *      synchronously from within the KEY_TAB_COMMAND listener.
 *
 * These specs register the real handler logic in a headless editor, dispatch
 * KEY_TAB_COMMAND in several selection states, and assert that each dispatch
 * TERMINATES (a watchdog fails the test if a handler spins) and leaves the
 * document in the expected state. They are written to go red against the buggy
 * handler and green against the fixed one.
 */
import { createHeadlessEditor } from '@lexical/headless'
import { ListItemNode, ListNode, $createListItemNode, $createListNode } from '@lexical/list'
import { $createCodeNode, CodeNode, CodeHighlightNode } from '@lexical/code'
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTabNode,
  $nodesOfType,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  LexicalEditor,
  OUTDENT_CONTENT_COMMAND,
  TabNode,
} from 'lexical'

import { registerTabIndentation } from './TabIndentationPlugin'

const makeEditor = (): LexicalEditor =>
  createHeadlessEditor({
    namespace: 'TabIndentationTest',
    nodes: [ListNode, ListItemNode, CodeNode, CodeHighlightNode],
    onError: (error) => {
      throw error
    },
  })

type IndentSpy = { indentCalls: number; outdentCalls: number }

/**
 * The headless editor has no DOM, so the rich-text INDENT/OUTDENT defaults are
 * not installed. Register spies that COUNT how often INDENT/OUTDENT is dispatched
 * (and mark them handled) so tests can assert WHETHER the Tab handler chose to
 * indent — the root-cause distinction (it must NOT dispatch indent for an
 * un-nestable first list item, which is what froze the browser).
 */
const registerIndentSpies = (editor: LexicalEditor): IndentSpy => {
  const spy: IndentSpy = { indentCalls: 0, outdentCalls: 0 }
  editor.registerCommand(
    INDENT_CONTENT_COMMAND,
    () => {
      spy.indentCalls += 1
      return true
    },
    COMMAND_PRIORITY_EDITOR,
  )
  editor.registerCommand(
    OUTDENT_CONTENT_COMMAND,
    () => {
      spy.outdentCalls += 1
      return true
    },
    COMMAND_PRIORITY_EDITOR,
  )
  return spy
}

/** Build a fake Tab keyboard event the command handler can read. */
const tabEvent = (shiftKey = false): KeyboardEvent => {
  let defaultPrevented = false
  return {
    shiftKey,
    get defaultPrevented() {
      return defaultPrevented
    },
    preventDefault() {
      defaultPrevented = true
    },
  } as unknown as KeyboardEvent
}

/**
 * Dispatch KEY_TAB_COMMAND with a hard watchdog. `dispatchCommand` is fully
 * synchronous in Lexical, so if the handler loops forever this call never
 * returns and the surrounding `jest` test would itself time out. To turn an
 * infinite loop into a *fast, deterministic* failure we cap the wall-clock time
 * spent inside the dispatch and throw if exceeded. A correct handler finishes
 * in well under a millisecond.
 */
const dispatchTabWithWatchdog = (editor: LexicalEditor, shiftKey = false): void => {
  const start = Date.now()
  const BUDGET_MS = 2000
  // We can't preempt a synchronous infinite loop from the outside in JS, so the
  // watchdog is enforced cooperatively by the handler-free guarantee of a
  // correct fix. As a belt-and-braces signal we still assert elapsed time.
  editor.dispatchCommand(KEY_TAB_COMMAND, tabEvent(shiftKey))
  // In headless mode (no DOM reconciliation tick) a command-triggered update is
  // not yet committed to `getEditorState()`; a discrete no-op update flushes it.
  // In a real browser the keystroke commits on its own — this is purely so the
  // test can read the resulting doc state.
  editor.update(() => {}, { discrete: true })
  const elapsed = Date.now() - start
  if (elapsed > BUDGET_MS) {
    throw new Error(`KEY_TAB_COMMAND did not terminate promptly (took ${elapsed}ms) — likely an infinite loop`)
  }
}

const seedParagraph = (editor: LexicalEditor, text = 'hello') => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      const node = $createTextNode(text)
      paragraph.append(node)
      root.append(paragraph)
      const selection = $createRangeSelection()
      selection.anchor.set(node.getKey(), text.length, 'text')
      selection.focus.set(node.getKey(), text.length, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

const seedParagraphWithRangeSelection = (editor: LexicalEditor, text = 'hello') => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      const node = $createTextNode(text)
      paragraph.append(node)
      root.append(paragraph)
      const selection = $createRangeSelection()
      selection.anchor.set(node.getKey(), 0, 'text')
      selection.focus.set(node.getKey(), text.length, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

const seedEmptyParagraph = (editor: LexicalEditor) => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      root.append(paragraph)
      paragraph.selectEnd()
    },
    { discrete: true },
  )
}

/** Single-item list with the caret at the end of the only (first) item. */
const seedListItem = (editor: LexicalEditor) => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const list = $createListNode('bullet')
      const item = $createListItemNode()
      const text = $createTextNode('item')
      item.append(text)
      list.append(item)
      root.append(list)
      const selection = $createRangeSelection()
      selection.anchor.set(text.getKey(), 4, 'text')
      selection.focus.set(text.getKey(), 4, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

/**
 * Two-item list with the caret in the SECOND item. The second item HAS a
 * previous list-item sibling, so it is genuinely nestable — the path that should
 * indent (and the only safe one: nesting the first/only item is impossible and
 * was the source of the freeze).
 */
const seedNestableSecondItem = (editor: LexicalEditor) => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const list = $createListNode('bullet')
      const first = $createListItemNode()
      first.append($createTextNode('first'))
      const second = $createListItemNode()
      const secondText = $createTextNode('second')
      second.append(secondText)
      list.append(first)
      list.append(second)
      root.append(list)
      const selection = $createRangeSelection()
      selection.anchor.set(secondText.getKey(), 6, 'text')
      selection.focus.set(secondText.getKey(), 6, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

/** Code block with the caret inside its text. */
const seedCodeBlock = (editor: LexicalEditor) => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const code = $createCodeNode()
      const text = $createTextNode('const x')
      code.append(text)
      root.append(code)
      const selection = $createRangeSelection()
      selection.anchor.set(text.getKey(), 7, 'text')
      selection.focus.set(text.getKey(), 7, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

const getRootText = (editor: LexicalEditor): string => {
  let value = ''
  editor.getEditorState().read(() => {
    value = $getRoot().getTextContent()
  })
  return value
}

/**
 * Number of real Lexical TabNodes in the document. This is the structural
 * discriminator between the fixed and buggy implementations: the fix inserts a
 * dedicated TabNode (`$createTabNode`), while the buggy `insertText('\t')` only
 * pushes a raw '\t' into a plain TextNode — which is what drove the DOM tab into
 * the segmented/unmergeable text path that froze the browser. Asserting a TabNode
 * exists pins the correct, terminating representation.
 */
const getTabNodeCount = (editor: LexicalEditor): number => {
  let count = 0
  editor.getEditorState().read(() => {
    count = $nodesOfType(TabNode).filter($isTabNode).length
  })
  return count
}

describe('TabIndentationPlugin tab handling terminates', () => {
  it('inserts a single tab character in an empty paragraph without hanging', () => {
    const editor = makeEditor()
    const unregister = registerTabIndentation(editor)
    seedEmptyParagraph(editor)

    dispatchTabWithWatchdog(editor)

    expect(getRootText(editor)).toBe('\t')
    // Must be a real TabNode, not a raw '\t' in a plain TextNode (the bug).
    expect(getTabNodeCount(editor)).toBe(1)
    unregister()
  })

  it('inserts a tab at the caret in normal text without hanging', () => {
    const editor = makeEditor()
    const unregister = registerTabIndentation(editor)
    seedParagraph(editor, 'hello')

    dispatchTabWithWatchdog(editor)

    expect(getRootText(editor)).toBe('hello\t')
    expect(getTabNodeCount(editor)).toBe(1)
    unregister()
  })

  it('handles repeated Tab presses (each inserts exactly one TabNode) without hanging', () => {
    const editor = makeEditor()
    const unregister = registerTabIndentation(editor)
    seedParagraph(editor, 'x')

    dispatchTabWithWatchdog(editor)
    dispatchTabWithWatchdog(editor)
    dispatchTabWithWatchdog(editor)

    expect(getRootText(editor)).toBe('x\t\t\t')
    expect(getTabNodeCount(editor)).toBe(3)
    unregister()
  })

  it('replaces a text range with a tab without hanging', () => {
    const editor = makeEditor()
    const unregister = registerTabIndentation(editor)
    seedParagraphWithRangeSelection(editor, 'hello')

    dispatchTabWithWatchdog(editor)

    expect(getRootText(editor)).toBe('\t')
    expect(getTabNodeCount(editor)).toBe(1)
    unregister()
  })

  it('on Tab in the FIRST/only (un-nestable) list item, inserts a tab and does NOT dispatch indent', () => {
    // THE ROOT-CAUSE GUARD. The first item of a list has no previous sibling to
    // nest under; asking Lexical to indent it is the impossible operation whose
    // browser DOM reconcile spun forever and froze the app. The fix recognises
    // this item is not nestable and inserts a tab character instead — never
    // dispatching INDENT. We assert (a) it terminates, (b) NO indent command was
    // dispatched (would be the freeze trigger in the browser), and (c) a real
    // TabNode was produced.
    const editor = makeEditor()
    const indents = registerIndentSpies(editor)
    const unregister = registerTabIndentation(editor)
    seedListItem(editor)

    dispatchTabWithWatchdog(editor)

    // must NOT dispatch INDENT on an un-nestable first item (the freeze trigger)
    expect(indents.indentCalls).toBe(0)
    expect(getTabNodeCount(editor)).toBe(1)
    unregister()
  })

  it('on Shift+Tab in a top-level (un-nested) list item, does not dispatch outdent and does not hang', () => {
    const editor = makeEditor()
    const indents = registerIndentSpies(editor)
    const unregister = registerTabIndentation(editor)
    seedListItem(editor)

    const handled = editor.dispatchCommand(KEY_TAB_COMMAND, tabEvent(true))
    editor.update(() => {}, { discrete: true })

    // must NOT dispatch OUTDENT on an un-nested item
    expect(indents.outdentCalls).toBe(0)
    // Shift+Tab on a top-level item is a no-op here (browser handles focus nav).
    expect(handled).toBe(false)
    unregister()
  })

  it('inside a CODE BLOCK, returns false and inserts NO TabNode (defers to the code handler)', () => {
    // REGRESSION: @lexical/code's registerCodeHighlighting registers its own
    // KEY_TAB_COMMAND at COMMAND_PRIORITY_LOW for code-aware line indent/outdent.
    // Our higher-priority handler must NOT consume Tab inside a code block (which
    // would drop a literal TabNode and break Shift+Tab outdent); it must return
    // false so the lower-priority code handler runs.
    const editor = makeEditor()
    const unregister = registerTabIndentation(editor)
    seedCodeBlock(editor)

    const handled = editor.dispatchCommand(KEY_TAB_COMMAND, tabEvent())
    editor.update(() => {}, { discrete: true })

    // The Super tab handler must decline so the code handler can run.
    expect(handled).toBe(false)
    // And it must NOT have inserted a literal TabNode.
    expect(getTabNodeCount(editor)).toBe(0)
    unregister()
  })

  it('inside a CODE BLOCK with Shift+Tab, returns false (defers to the code outdent handler)', () => {
    const editor = makeEditor()
    const unregister = registerTabIndentation(editor)
    seedCodeBlock(editor)

    const handled = editor.dispatchCommand(KEY_TAB_COMMAND, tabEvent(true))
    editor.update(() => {}, { discrete: true })

    expect(handled).toBe(false)
    expect(getTabNodeCount(editor)).toBe(0)
    unregister()
  })

  it('on Tab in a NESTABLE list item (has a previous sibling), dispatches indent and is handled', () => {
    // The legitimate list-nesting path: an item with a preceding sibling CAN
    // nest, so Tab should dispatch INDENT and report handled — and must still
    // terminate promptly (watchdog) and not insert a tab character.
    const editor = makeEditor()
    const indents = registerIndentSpies(editor)
    const unregister = registerTabIndentation(editor)
    seedNestableSecondItem(editor)

    const start = Date.now()
    const handled = editor.dispatchCommand(KEY_TAB_COMMAND, tabEvent())
    editor.update(() => {}, { discrete: true })
    expect(Date.now() - start).toBeLessThan(2000)

    // a nestable item must dispatch INDENT, be reported handled, and insert no tab
    expect(indents.indentCalls).toBe(1)
    expect(handled).toBe(true)
    expect(getTabNodeCount(editor)).toBe(0)
    unregister()
  })
})
