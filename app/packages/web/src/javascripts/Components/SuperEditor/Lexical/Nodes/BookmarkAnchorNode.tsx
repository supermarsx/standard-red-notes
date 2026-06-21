import * as React from 'react'
import {
  DecoratorNode,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'

/**
 * Standard Red Notes: inline bookmark anchor for Super (Lexical) notes.
 *
 * A bookmark anchor is a tiny zero-width inline marker inserted into the document
 * at the cursor when the user bookmarks a spot. Because it is a real node in the
 * document tree, it MOVES with edits — type above it and it shifts down with the
 * surrounding text. This makes the Super position-capture robust (unlike a plain
 * character offset, which drifts).
 *
 * The only persisted state is a stable `bookmarkId`. The bookmark record (stored
 * in the note's appData, see Bookmarks/bookmarks.ts) references this same id, and
 * "jump to bookmark" finds the rendered marker by its DOM id
 * ({@link bookmarkAnchorDomId}) and scrolls it into view.
 *
 * Mirrors FootnoteReferenceNode (inline DecoratorNode, stable id, stable DOM id).
 */

export const BOOKMARK_ANCHOR_DOM_ATTR = 'data-bookmark-anchor'

/** Stable DOM id for the rendered anchor of a given bookmark id. */
export function bookmarkAnchorDomId(bookmarkId: string): string {
  return `bookmark-anchor-${bookmarkId}`
}

function BookmarkAnchorComponent({ bookmarkId }: { bookmarkId: string }): React.JSX.Element {
  // A small, visually subtle inline marker. Kept tiny/zero-impact so it does not
  // disrupt reading; scroll-target lands here when jumping to the bookmark.
  return (
    <span
      id={bookmarkAnchorDomId(bookmarkId)}
      data-bookmark-anchor="true"
      data-bookmark-id={bookmarkId}
      aria-hidden="true"
      title="Bookmarked spot"
      className="inline-block align-middle"
      style={{ width: '0.55em', userSelect: 'none' }}
    >
      <span
        className="inline-block rounded-sm align-middle text-info"
        style={{
          width: '0.45em',
          height: '1em',
          backgroundColor: 'currentColor',
          opacity: 0.5,
          verticalAlign: '-0.15em',
        }}
      />
    </span>
  )
}

export type SerializedBookmarkAnchorNode = Spread<{ bookmarkId: string }, SerializedLexicalNode>

export class BookmarkAnchorNode extends DecoratorNode<React.JSX.Element> {
  __bookmarkId: string

  static getType(): string {
    return 'bookmark-anchor'
  }

  static clone(node: BookmarkAnchorNode): BookmarkAnchorNode {
    return new BookmarkAnchorNode(node.__bookmarkId, node.__key)
  }

  constructor(bookmarkId: string, key?: NodeKey) {
    super(key)
    this.__bookmarkId = bookmarkId
  }

  static importJSON(serializedNode: SerializedBookmarkAnchorNode): BookmarkAnchorNode {
    return $createBookmarkAnchorNode(serializedNode.bookmarkId || createBookmarkAnchorId())
  }

  exportJSON(): SerializedBookmarkAnchorNode {
    return {
      type: 'bookmark-anchor',
      version: 1,
      bookmarkId: this.__bookmarkId,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span')
    element.setAttribute(BOOKMARK_ANCHOR_DOM_ATTR, 'true')
    element.setAttribute('data-bookmark-id', this.__bookmarkId)
    return { element }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline'
    return span
  }

  updateDOM(): false {
    return false
  }

  getBookmarkId(): string {
    return this.getLatest().__bookmarkId
  }

  setBookmarkId(bookmarkId: string): void {
    this.getWritable().__bookmarkId = bookmarkId
  }

  getTextContent(): string {
    return ''
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <BookmarkAnchorComponent bookmarkId={this.__bookmarkId} />
  }
}

let bookmarkAnchorCounter = 0

/**
 * Stable, document-unique id for a bookmark anchor. Combines time, a monotonic
 * counter, and randomness so ids minted in the same millisecond never collide.
 */
export function createBookmarkAnchorId(): string {
  bookmarkAnchorCounter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `bm-${Date.now().toString(36)}-${bookmarkAnchorCounter.toString(36)}-${random}`
}

export function $createBookmarkAnchorNode(bookmarkId: string = createBookmarkAnchorId()): BookmarkAnchorNode {
  return new BookmarkAnchorNode(bookmarkId)
}

export function $isBookmarkAnchorNode(node: LexicalNode | null | undefined): node is BookmarkAnchorNode {
  return node instanceof BookmarkAnchorNode
}
