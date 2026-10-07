import { $isListItemNode, $isListNode, type ListNode } from '@lexical/list'
import { $getRoot, $isElementNode, ElementNode, type LexicalNode } from 'lexical'

/**
 * Standard Red Notes: the Super note TXT export.
 *
 * TXT used to be `$getRoot().getTextContent()`, which throws away the two things
 * a checklist IS: whether a task is done, and what hangs under what. A four-level
 * list came out as four unindented lines separated by blank lines, so an exported
 * todo list could not tell the reader which items were finished — the format
 * people grep and diff was the one format that lost the answer.
 *
 * Both facts are perfectly expressible in plain text, so both are kept:
 *
 *  - completion as `[x] ` / `[ ] ` — the `- [x]` task-list convention minus the
 *    bullet, which is what Markdown export already emits and what every reader
 *    (and `grep '\[ \]'`) understands;
 *  - depth as {@link PLAIN_TEXT_LIST_INDENT} per level.
 *
 * Only LISTS change. Every subtree that holds no list is still serialized by
 * Lexical itself, and so are custom element nodes that define their own text
 * form — a node that overrides `getTextContent` owns its plain-text shape and
 * this walk must not second-guess it. Inside a list the item separator is a
 * single newline rather than Lexical's blank line, because a list is one block
 * and its rows are lines, not paragraphs.
 *
 * Bullet and numbered rows get the indentation but no marker: this is plain
 * text, so the ordering is the line order, and `[x]`/`[ ]` is the only syntax
 * that carries information the lines cannot.
 */

/** Two spaces per nesting level — the plain-text convention, not Markdown's four. */
export const PLAIN_TEXT_LIST_INDENT = '  '

/** Lexical's own separator between two block-level children. */
const BLOCK_SEPARATOR = '\n\n'

/**
 * Matches the walk bound used by the DOCX/ODT model so a pathologically nested
 * note truncates instead of overflowing the stack.
 */
const MAX_PLAIN_TEXT_DEPTH = 200

/** Does this subtree hold a list at all? Decides whether to walk it ourselves. */
const $containsList = (element: ElementNode, depth: number): boolean => {
  if (depth >= MAX_PLAIN_TEXT_DEPTH) {
    return false
  }
  for (const child of element.getChildren()) {
    if ($isListNode(child)) {
      return true
    }
    if ($isElementNode(child) && $containsList(child, depth + 1)) {
      return true
    }
  }
  return false
}

/**
 * One line per row of `list`, deepest-last in document order.
 *
 * Lexical represents an indented row with a text-less WRAPPER list item that
 * holds only the nested list (`$handleIndent` copies the row and moves the real
 * one inside the copy's new list). The wrapper is structure: it contributes the
 * nested rows but never a line of its own. An item with no children at all is a
 * real empty row and keeps its line, because the user can still type into it.
 */
const $appendListLines = (list: ListNode, level: number, lines: string[]): void => {
  if (level >= MAX_PLAIN_TEXT_DEPTH) {
    return
  }
  const indent = PLAIN_TEXT_LIST_INDENT.repeat(level)
  for (const child of list.getChildren()) {
    if (!$isListItemNode(child)) {
      // Lexical only ever puts list items in a list; keep anything else rather
      // than dropping text on an unexpected tree.
      const stray = child.getTextContent()
      if (stray.length > 0) {
        lines.push(`${indent}${stray}`)
      }
      continue
    }
    const branches: ListNode[] = []
    let own = ''
    const grandChildren = child.getChildren()
    for (const grandChild of grandChildren) {
      if ($isListNode(grandChild)) {
        branches.push(grandChild)
      } else {
        own += grandChild.getTextContent()
      }
    }
    const isNestingWrapper = grandChildren.length > 0 && branches.length === grandChildren.length
    if (!isNestingWrapper) {
      const checked = child.getChecked()
      const box = checked === undefined ? '' : checked ? '[x] ' : '[ ] '
      lines.push(`${indent}${box}${own}`)
    }
    for (const branch of branches) {
      $appendListLines(branch, level + 1, lines)
    }
  }
}

const $listToPlainText = (list: ListNode): string => {
  const lines: string[] = []
  $appendListLines(list, 0, lines)
  return lines.join('\n')
}

const $nodeToPlainText = (node: LexicalNode, depth: number): string => {
  if ($isListNode(node)) {
    return $listToPlainText(node)
  }
  if (
    depth < MAX_PLAIN_TEXT_DEPTH &&
    $isElementNode(node) &&
    // A node that defines its own text form keeps it, list inside or not.
    node.getTextContent === ElementNode.prototype.getTextContent &&
    $containsList(node, 0)
  ) {
    return $elementChildrenToPlainText(node, depth)
  }
  return node.getTextContent()
}

/**
 * `ElementNode.getTextContent`'s join rule, reproduced so that every subtree
 * without a list in it comes out byte-identical to what Lexical would have
 * produced, and only the list rows differ.
 */
const $elementChildrenToPlainText = (element: ElementNode, depth: number): string => {
  const children = element.getChildren()
  let text = ''
  children.forEach((child, index) => {
    text += $nodeToPlainText(child, depth + 1)
    if ($isElementNode(child) && index !== children.length - 1 && !child.isInline()) {
      text += BLOCK_SEPARATOR
    }
  })
  return text
}

/**
 * The note's plain-text export. Must run inside an `editor.update()` /
 * `editorState.read()`.
 */
export function $generatePlainTextFromRoot(): string {
  const root = $getRoot()
  if (!$containsList(root, 0)) {
    // No list, nothing to preserve that Lexical does not already: use its own
    // serialization (cache, slots and all) rather than a second implementation.
    return root.getTextContent()
  }
  return $elementChildrenToPlainText(root, 0)
}
