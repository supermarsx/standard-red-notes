/**
 * @jest-environment jsdom
 *
 * Tests for the Super bookmark anchor node, mirroring the structure of
 * FootnoteNodeSerialization.spec.ts. We cover:
 *   1. Serialization round-trips the stable bookmarkId, with stable type/version,
 *      and old/missing data degrades gracefully (mints a fresh id).
 *   2. The node is inline (so it lives within a paragraph and moves with edits).
 *   3. The derived DOM id is stable and unique per bookmark id.
 *   4. The anchor participates in document order (so jumping finds it).
 *
 * Constructing a node assigns a key (a write requiring an active editor), so node
 * work runs inside editor.update(). No React component is imported here.
 */

import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, $createParagraphNode } from 'lexical'

import {
  $createBookmarkAnchorNode,
  $isBookmarkAnchorNode,
  BookmarkAnchorNode,
  SerializedBookmarkAnchorNode,
  bookmarkAnchorDomId,
  createBookmarkAnchorId,
} from './BookmarkAnchorNode'

const editor = createHeadlessEditor({
  namespace: 'BookmarkNodeSerializationTest',
  nodes: [BookmarkAnchorNode],
  onError: (error) => {
    throw error
  },
})

function inEditor<T>(fn: () => T): T {
  let result: T
  editor.update(
    () => {
      result = fn()
    },
    { discrete: true },
  )
  return result!
}

describe('BookmarkAnchorNode serialization round-trip', () => {
  it('round-trips the bookmarkId without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createBookmarkAnchorNode('bm-abc').exportJSON()
      const second = BookmarkAnchorNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.bookmarkId).toBe('bm-abc')
    expect(second).toEqual(first)
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createBookmarkAnchorNode('bm-1').exportJSON())
    expect(json.type).toBe('bookmark-anchor')
    expect(json.type).toBe(BookmarkAnchorNode.getType())
    expect(json.version).toBe(1)
  })

  it('is inline (moves with edits)', () => {
    const inline = inEditor(() => $createBookmarkAnchorNode('bm-1').isInline())
    expect(inline).toBe(true)
  })

  it('mints a fresh id when old data has none (degrades gracefully)', () => {
    const legacy = { type: 'bookmark-anchor', version: 1 } as unknown as SerializedBookmarkAnchorNode
    const id = inEditor(() => BookmarkAnchorNode.importJSON(legacy).getBookmarkId())
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('setBookmarkId updates the stored id', () => {
    const id = inEditor(() => {
      const node = $createBookmarkAnchorNode('original')
      node.setBookmarkId('updated')
      return node.getBookmarkId()
    })
    expect(id).toBe('updated')
  })
})

describe('BookmarkAnchorNode helpers', () => {
  it('bookmarkAnchorDomId is stable and unique per id', () => {
    expect(bookmarkAnchorDomId('abc')).toBe('bookmark-anchor-abc')
    expect(bookmarkAnchorDomId('abc')).toBe(bookmarkAnchorDomId('abc'))
    expect(bookmarkAnchorDomId('abc')).not.toBe(bookmarkAnchorDomId('def'))
  })

  it('createBookmarkAnchorId produces unique ids', () => {
    const ids = new Set([createBookmarkAnchorId(), createBookmarkAnchorId(), createBookmarkAnchorId()])
    expect(ids.size).toBe(3)
  })

  it('$isBookmarkAnchorNode narrows correctly', () => {
    const result = inEditor(() => {
      const anchor = $createBookmarkAnchorNode('bm-x')
      const paragraph = $createParagraphNode()
      return { onAnchor: $isBookmarkAnchorNode(anchor), onParagraph: $isBookmarkAnchorNode(paragraph) }
    })
    expect(result.onAnchor).toBe(true)
    expect(result.onParagraph).toBe(false)
  })

  it('participates in document order so a jump target can be found', () => {
    const ids = inEditor(() => {
      const root = $getRoot()
      root.clear()
      const p = $createParagraphNode()
      p.append($createBookmarkAnchorNode('bm-1'))
      p.append($createBookmarkAnchorNode('bm-2'))
      root.append(p)
      const found: string[] = []
      for (const child of p.getChildren()) {
        if ($isBookmarkAnchorNode(child)) {
          found.push(child.getBookmarkId())
        }
      }
      return found
    })
    expect(ids).toEqual(['bm-1', 'bm-2'])
  })
})
