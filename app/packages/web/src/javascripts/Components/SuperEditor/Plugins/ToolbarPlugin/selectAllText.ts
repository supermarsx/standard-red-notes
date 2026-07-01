/**
 * "Select all text only" toolbar action for the Super editor.
 *
 * Distinct from the plain "Select all" (which selects every root child via an
 * element-span RangeSelection — anchor at root offset 0, focus at root child
 * count — and therefore wholesale-selects decorator / embed / non-text blocks),
 * this builds a RangeSelection that spans only the TEXT content of the document:
 * from the start of the first TextNode descendant to the end of the last. Blocks
 * with no text leaves that fall outside those bounds are not selected.
 *
 * Must be called inside an `editor.update(() => { ... })` (or a write context):
 * it reads/writes the active editor state.
 */
import {
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  LexicalNode,
  TextNode,
} from 'lexical'

/** First TextNode descendant (document order) of `node`, or null if none. */
export const $getFirstTextDescendant = (node: LexicalNode): TextNode | null => {
  if ($isTextNode(node)) {
    return node
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      const found = $getFirstTextDescendant(child)
      if (found) {
        return found
      }
    }
  }
  return null
}

/** Last TextNode descendant (document order) of `node`, or null if none. */
export const $getLastTextDescendant = (node: LexicalNode): TextNode | null => {
  if ($isTextNode(node)) {
    return node
  }
  if ($isElementNode(node)) {
    const children = node.getChildren()
    for (let i = children.length - 1; i >= 0; i--) {
      const found = $getLastTextDescendant(children[i])
      if (found) {
        return found
      }
    }
  }
  return null
}

/**
 * Select every TEXT node of the document (first text start → last text end).
 * Safe no-op when the document has no text (e.g. empty, or only decorator/embed
 * blocks); returns true when a text selection was set, false otherwise.
 */
export const $selectAllText = (): boolean => {
  const root = $getRoot()
  const first = $getFirstTextDescendant(root)
  const last = $getLastTextDescendant(root)
  if (!first || !last) {
    return false
  }
  const selection = $createRangeSelection()
  selection.anchor.set(first.getKey(), 0, 'text')
  selection.focus.set(last.getKey(), last.getTextContentSize(), 'text')
  $setSelection(selection)
  return true
}
