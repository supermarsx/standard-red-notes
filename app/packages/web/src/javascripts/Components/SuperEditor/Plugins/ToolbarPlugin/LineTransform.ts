/**
 * Lexical tree mutation behind the Super editor's "Sort & dedupe lines" toolbar
 * action. Extracted from the React component so it can be exercised by a headless
 * editor in tests. Functions prefixed with `$` must run inside editor.update().
 */
import {
  $createTextNode,
  $isElementNode,
  $isRootOrShadowRoot,
  $setSelection,
  ElementNode,
  LexicalNode,
  RangeSelection,
} from 'lexical'
import { $findMatchingParent } from '@lexical/utils'

import { applyLineOperation, LineOperation } from './LineOperations'

/**
 * A "line" is a leaf block element holding inline content — a paragraph, heading,
 * quote, or list item — i.e. a non-inline element that does not itself contain
 * other block elements (so a list container is excluded, but its items match).
 */
const isLineBlock = (node: LexicalNode | null): node is ElementNode =>
  node != null &&
  $isElementNode(node) &&
  !node.isInline() &&
  !$isRootOrShadowRoot(node) &&
  !node.getChildren().some((child) => $isElementNode(child) && !child.isInline())

/** Collect the distinct line blocks intersected by a selection, in document order. */
export const $collectSelectedLineBlocks = (selection: RangeSelection): ElementNode[] => {
  const blocks: ElementNode[] = []
  const seen = new Set<string>()
  for (const node of selection.getNodes()) {
    const block = isLineBlock(node) ? node : $findMatchingParent(node, isLineBlock)
    if (isLineBlock(block) && !seen.has(block.getKey())) {
      seen.add(block.getKey())
      blocks.push(block)
    }
  }
  return blocks
}

/**
 * Sort or deduplicate the line blocks spanned by `selection`. Rewrites each
 * block's text in the new order; surplus blocks (after a dedupe) are removed.
 * Returns true if the document changed.
 */
export const $transformSelectedLines = (selection: RangeSelection, operation: LineOperation): boolean => {
  const blocks = $collectSelectedLineBlocks(selection)
  if (blocks.length < 2) {
    return false
  }

  const texts = blocks.map((block) => block.getTextContent())
  const result = applyLineOperation(texts, operation)
  if (result.length === texts.length && result.every((line, index) => line === texts[index])) {
    return false
  }

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (index < result.length) {
      block.clear()
      block.append($createTextNode(result[index]))
    } else {
      block.remove()
    }
  }
  // The previous selection points into cleared/removed nodes; drop it so
  // reconciliation doesn't choke on a stale range.
  $setSelection(null)
  return true
}
