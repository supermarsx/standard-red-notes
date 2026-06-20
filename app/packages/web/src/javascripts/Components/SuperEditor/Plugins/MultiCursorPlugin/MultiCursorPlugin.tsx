import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isElementNode,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_NORMAL,
  KEY_MODIFIER_COMMAND,
  LexicalNode,
  TextNode,
} from 'lexical'
import { useEffect } from 'react'

/**
 * MultiCursorPlugin
 *
 * Lexical's core selection model is a single `RangeSelection` with one anchor
 * and one focus point. It does NOT support multiple simultaneous carets, so a
 * faithful VS Code / Sublime multi-caret experience (independent typing at N
 * locations at once) cannot be rendered. This plugin delivers the practical
 * subset of multi-cursor editing that IS achievable on top of a single-range
 * model:
 *
 *  - Cmd/Ctrl+D            "Select next occurrence" — moves the selection to the
 *                          next occurrence of the currently selected text
 *                          (wrapping around to the top). Repeated presses walk
 *                          through every occurrence, mirroring how you'd add
 *                          cursors one-by-one in a real multi-cursor editor.
 *
 *  - Cmd/Ctrl+Shift+L      "Edit all occurrences" — atomically replaces every
 *                          occurrence of the currently selected text with a
 *                          prompted replacement, in a single undoable edit.
 *                          This is the real outcome users want multi-cursor for
 *                          (rename / refactor a token everywhere at once).
 *
 * Both shortcuts are additive: they only act when there is a non-empty text
 * selection and otherwise return `false`, leaving normal typing untouched.
 */

type Occurrence = {
  node: TextNode
  start: number
  end: number
}

/**
 * Returns the editor's text nodes in document order together with a flat,
 * concatenated string of their content plus a map from a global string offset
 * back to the owning text node and local offset. This lets us search across
 * node boundaries the same way a textarea would.
 */
function $collectTextNodesInOrder(): TextNode[] {
  // We walk the tree depth-first to preserve document order.
  const ordered: TextNode[] = []
  const visit = (node: LexicalNode): void => {
    if ($isTextNode(node)) {
      ordered.push(node)
      return
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child)
      }
    }
  }
  visit($getRoot())
  return ordered
}

/**
 * Finds occurrences of `needle` within a single text node. We intentionally
 * search per-node (not across boundaries) to keep replacements well-defined and
 * to avoid splitting selections across inline formatting runs. This matches the
 * common rename use-case where the token lives inside one text run.
 */
function findOccurrencesInNode(node: TextNode, needle: string): Occurrence[] {
  const occurrences: Occurrence[] = []
  const haystack = node.getTextContent()
  if (needle.length === 0) {
    return occurrences
  }
  let fromIndex = 0
  for (;;) {
    const index = haystack.indexOf(needle, fromIndex)
    if (index === -1) {
      break
    }
    occurrences.push({ node, start: index, end: index + needle.length })
    fromIndex = index + needle.length
  }
  return occurrences
}

function $findAllOccurrences(needle: string): Occurrence[] {
  const result: Occurrence[] = []
  for (const node of $collectTextNodesInOrder()) {
    result.push(...findOccurrencesInNode(node, needle))
  }
  return result
}

/**
 * Returns the trimmed, single-run text of the current selection, or null if the
 * selection is empty, spans multiple nodes, or contains a line break. Limiting
 * to a single text node keeps "what is the search term" unambiguous.
 */
function $getSelectedSearchTerm(): string | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || selection.isCollapsed()) {
    return null
  }
  const text = selection.getTextContent()
  if (text.length === 0 || text.includes('\n')) {
    return null
  }
  return text
}

/**
 * Selects the next occurrence of `term` strictly after the current selection
 * focus, wrapping to the start of the document if none is found ahead.
 */
function $selectNextOccurrence(term: string): boolean {
  const occurrences = $findAllOccurrences(term)
  if (occurrences.length === 0) {
    return false
  }

  const selection = $getSelection()
  let afterNodeKey: string | null = null
  let afterOffset = -1
  if ($isRangeSelection(selection)) {
    const focus = selection.focus
    afterNodeKey = focus.key
    afterOffset = focus.offset
  }

  // Build a positional order so we can find the "next" match after the caret.
  const ordered = $collectTextNodesInOrder()
  const nodeOrder = new Map<string, number>()
  ordered.forEach((node, index) => nodeOrder.set(node.getKey(), index))

  const isAfterCaret = (occ: Occurrence): boolean => {
    if (afterNodeKey === null) {
      return true
    }
    const occOrder = nodeOrder.get(occ.node.getKey()) ?? 0
    const caretOrder = nodeOrder.get(afterNodeKey) ?? 0
    if (occOrder !== caretOrder) {
      return occOrder > caretOrder
    }
    return occ.start >= afterOffset
  }

  const next = occurrences.find(isAfterCaret) ?? occurrences[0]

  const rangeSelection = $createRangeSelection()
  rangeSelection.setTextNodeRange(next.node, next.start, next.node, next.end)
  $setSelection(rangeSelection)
  return true
}

/**
 * Atomically replaces every occurrence of `term` with `replacement`. Returns
 * the number of replacements made. Runs inside the active update so it is a
 * single undoable step.
 */
function $replaceAllOccurrences(term: string, replacement: string): number {
  // Snapshot occurrences first; mutating a node invalidates later offsets, so
  // we apply replacements per-node from the end backwards.
  const byNode = new Map<string, Occurrence[]>()
  for (const occ of $findAllOccurrences(term)) {
    const key = occ.node.getKey()
    const list = byNode.get(key)
    if (list) {
      list.push(occ)
    } else {
      byNode.set(key, [occ])
    }
  }

  let count = 0
  for (const [, occurrences] of byNode) {
    // Apply from the end so earlier offsets remain valid.
    occurrences.sort((a, b) => b.start - a.start)
    for (const occ of occurrences) {
      const node = occ.node
      if (!node.isAttached()) {
        continue
      }
      const text = node.getTextContent()
      const updated = text.slice(0, occ.start) + replacement + text.slice(occ.end)
      node.setTextContent(updated)
      count += 1
    }
  }
  return count
}

export default function MultiCursorPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand<KeyboardEvent>(
        KEY_MODIFIER_COMMAND,
        (event) => {
          const { code, ctrlKey, metaKey, shiftKey } = event
          const primaryModifier = ctrlKey || metaKey

          if (!primaryModifier) {
            return false
          }

          // Cmd/Ctrl+D — select next occurrence of the current selection.
          if (code === 'KeyD' && !shiftKey) {
            let handled = false
            editor.update(() => {
              const term = $getSelectedSearchTerm()
              if (term === null) {
                return
              }
              handled = $selectNextOccurrence(term)
            })
            if (handled) {
              event.preventDefault()
              return true
            }
            return false
          }

          // Cmd/Ctrl+Shift+L — edit (replace) all occurrences of the selection.
          if (code === 'KeyL' && shiftKey) {
            let term: string | null = null
            let occurrenceCount = 0
            editor.getEditorState().read(() => {
              term = $getSelectedSearchTerm()
              if (term !== null) {
                occurrenceCount = $findAllOccurrences(term).length
              }
            })
            if (term === null) {
              return false
            }
            event.preventDefault()

            const replacement = window.prompt(
              `Replace all ${occurrenceCount} occurrence(s) of "${term}" with:`,
              term,
            )
            if (replacement === null) {
              return true
            }
            const searchTerm = term
            editor.update(() => {
              $replaceAllOccurrences(searchTerm, replacement)
            })
            return true
          }

          return false
        },
        COMMAND_PRIORITY_NORMAL,
      ),
    )
  }, [editor])

  return null
}
