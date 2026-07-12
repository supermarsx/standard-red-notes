/**
 * Standard Red Notes: document-outline builder for the navigation sidebar.
 *
 * A single depth-first walk of the Lexical tree, in document order, collecting
 * BOTH heading nodes and bookmark anchors in ONE pass so their relative order is
 * preserved. Must run inside `editorState.read(...)` (it calls `$getRoot` and node
 * accessors). Pure — no side effects, no editor writes.
 *
 * Notes:
 *  - `$isHeadingNode` matches `StyledHeadingNode` too (it extends `HeadingNode`),
 *    so every heading instance in this editor is collected.
 *  - We descend into EVERY element (not just root children) so a heading or anchor
 *    nested inside a collapsible / table / list is still found.
 *  - Empty-text headings are kept (the sidebar renders them as a placeholder) so
 *    the outline still mirrors the document's structure.
 */
import { $getRoot, $isElementNode, ElementNode } from 'lexical'
import { $isHeadingNode } from '@lexical/rich-text'
import { $isBookmarkAnchorNode } from '../../Lexical/Nodes/BookmarkAnchorNode'

/** A heading entry in the outline. `level` is 1..6 (from the `h1`..`h6` tag). */
export type OutlineHeading = { kind: 'heading'; nodeKey: string; level: number; text: string }

/** A bookmark-anchor entry in the outline, in document order. */
export type OutlineBookmark = { kind: 'bookmark'; nodeKey: string; bookmarkId: string }

export type DocumentOutline = {
  /** Headings in document order. */
  headings: OutlineHeading[]
  /** Bookmark anchors in document order. */
  bookmarks: OutlineBookmark[]
}

/**
 * Build the document outline from the current editor state. Call inside
 * `editor.getEditorState().read($buildDocumentOutline)`.
 */
export function $buildDocumentOutline(): DocumentOutline {
  const headings: OutlineHeading[] = []
  const bookmarks: OutlineBookmark[] = []

  const visit = (node: ElementNode): void => {
    for (const child of node.getChildren()) {
      if ($isHeadingNode(child)) {
        const tag = child.getTag() // 'h1'..'h6'
        const level = Number(tag.slice(1)) || 1
        headings.push({ kind: 'heading', nodeKey: child.getKey(), level, text: child.getTextContent().trim() })
      } else if ($isBookmarkAnchorNode(child)) {
        bookmarks.push({ kind: 'bookmark', nodeKey: child.getKey(), bookmarkId: child.getBookmarkId() })
      }
      if ($isElementNode(child)) {
        visit(child)
      }
    }
  }

  visit($getRoot())
  return { headings, bookmarks }
}
