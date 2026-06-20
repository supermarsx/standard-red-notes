/**
 * Pure fold-range computation for the Super editor.
 *
 * Folding is a VIEW concern: we never delete nodes from the Lexical model.
 * Instead, given the document structure we compute the set of node keys whose
 * DOM should be hidden, and the plugin toggles a CSS class on those elements.
 *
 * These helpers are intentionally free of any Lexical/DOM dependency so they can
 * be unit-tested in isolation.
 */

/** A top-level block, reduced to just what fold logic needs. */
export type FoldBlock = {
  key: string
  /**
   * Heading level 1-6 for HeadingNodes (h1 => 1), or `null` for any non-heading
   * block (paragraph, list, table, etc.).
   */
  headingLevel: number | null
}

/** A node in a list-item tree, reduced to what nested-fold logic needs. */
export type FoldListItem = {
  key: string
  /** Keys of nested ListItem subtree directly belonging to this item. */
  childKeys: string[]
}

/**
 * Given the ordered top-level blocks and the set of collapsed heading keys,
 * return the set of block keys that should be hidden.
 *
 * Rule: a collapsed heading hides every following sibling block until (but not
 * including) the next heading whose level is <= the collapsed heading's level,
 * or the end of the document. A non-heading or a deeper heading in that span is
 * hidden; a same/higher-level heading ends the fold.
 *
 * Nested case: if a collapsed heading is itself already inside a hidden span
 * (because a higher heading above it is collapsed), it contributes nothing new —
 * its range is already hidden. We still walk it so the math stays simple.
 */
export function computeHiddenBlockKeys(blocks: FoldBlock[], collapsedHeadingKeys: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>()

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.headingLevel === null) {
      continue
    }
    if (!collapsedHeadingKeys.has(block.key)) {
      continue
    }

    const level = block.headingLevel
    // Hide following siblings until a heading with level <= this one.
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j]
      if (next.headingLevel !== null && next.headingLevel <= level) {
        break
      }
      hidden.add(next.key)
    }
  }

  return hidden
}

/**
 * Given list items (each carrying the keys of its nested subtree) and the set of
 * collapsed list-item keys, return the set of nested keys to hide.
 *
 * A collapsed list item hides its entire nested subtree. Nested items already
 * hidden by an ancestor collapse contribute no new keys (set semantics dedupe).
 */
export function computeHiddenListItemKeys(items: FoldListItem[], collapsedItemKeys: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>()
  for (const item of items) {
    if (!collapsedItemKeys.has(item.key)) {
      continue
    }
    for (const childKey of item.childKeys) {
      hidden.add(childKey)
    }
  }
  return hidden
}
