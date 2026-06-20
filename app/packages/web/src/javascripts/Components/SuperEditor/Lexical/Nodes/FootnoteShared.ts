import { $dfs } from '@lexical/utils'
import { $getRoot } from 'lexical'
import { $isFootnoteReferenceNode, FootnoteReferenceNode } from './FootnoteReferenceNode'

export type FootnoteEntry = {
  footnoteId: string
  content: string
}

/**
 * Returns every FootnoteReferenceNode in document order (depth-first, which is
 * the reading order Lexical lays nodes out in). This ordered list is the single
 * source of truth for footnote numbering: a reference's number is its 1-based
 * index here. Because it is recomputed from the live tree, inserting, deleting
 * or moving a reference renumbers all footnotes consistently with no stored
 * counter to keep in sync.
 *
 * Must be called inside an editor read/update (uses $getRoot / $dfs).
 */
export function $getOrderedFootnoteReferences(): FootnoteReferenceNode[] {
  const result: FootnoteReferenceNode[] = []
  const root = $getRoot()
  for (const { node } of $dfs(root)) {
    if ($isFootnoteReferenceNode(node)) {
      result.push(node)
    }
  }
  return result
}

/**
 * Pure numbering function, factored out so it can be unit tested without an
 * editor. Given references already in document order, produce footnoteId ->
 * 1-based number. Duplicate ids (e.g. a botched paste) keep the number of their
 * first occurrence so the mapping stays stable.
 */
export function computeFootnoteNumbering(orderedFootnoteIds: string[]): Map<string, number> {
  const numbering = new Map<string, number>()
  let next = 1
  for (const id of orderedFootnoteIds) {
    if (!numbering.has(id)) {
      numbering.set(id, next)
      next += 1
    }
  }
  return numbering
}

/**
 * Order a set of footnote entries to match the document order of their
 * references. Entries whose reference no longer exists (orphans) are dropped;
 * references with no entry get an empty placeholder entry so the section stays
 * paired with the markers.
 */
export function orderEntriesByReferences(
  orderedFootnoteIds: string[],
  entries: FootnoteEntry[],
): FootnoteEntry[] {
  const byId = new Map(entries.map((entry) => [entry.footnoteId, entry]))
  const seen = new Set<string>()
  const ordered: FootnoteEntry[] = []
  for (const id of orderedFootnoteIds) {
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    ordered.push(byId.get(id) ?? { footnoteId: id, content: '' })
  }
  return ordered
}

export function footnoteReferenceDomId(footnoteId: string): string {
  return `footnote-ref-${footnoteId}`
}

export function footnoteEntryDomId(footnoteId: string): string {
  return `footnote-entry-${footnoteId}`
}
