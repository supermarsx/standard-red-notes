/**
 * @jest-environment jsdom
 *
 * Unit tests for the navigation-sidebar outline builder. A headless Lexical editor
 * is seeded with a document and `$buildDocumentOutline` is run inside a read; we
 * assert headings + bookmark anchors are collected in document order, with the
 * correct level/text, including a heading nested inside a collapsible (DFS), and
 * that an empty document yields an empty outline.
 *
 * Headings are created via `$createHeadingNode`; the registered StyledHeadingNode
 * replacement means every heading is actually a StyledHeadingNode, exactly as in
 * the real editor — this proves `$isHeadingNode` still matches it.
 */
import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical'
import { $createHeadingNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import { STYLED_BLOCK_NODE_OVERRIDES } from '../../Lexical/Nodes/StyledBlockNodes'
import { BookmarkAnchorNode, $createBookmarkAnchorNode } from '../../Lexical/Nodes/BookmarkAnchorNode'
import { CollapsibleContainerNode } from '../CollapsiblePlugin/CollapsibleContainerNode'
import { CollapsibleContentNode, $createCollapsibleContentNode } from '../CollapsiblePlugin/CollapsibleContentNode'
import { $buildDocumentOutline } from './outline'

const editor = createHeadlessEditor({
  namespace: 'OutlineSpec',
  nodes: [
    HeadingNode,
    QuoteNode,
    ...STYLED_BLOCK_NODE_OVERRIDES,
    BookmarkAnchorNode,
    CollapsibleContainerNode,
    CollapsibleContentNode,
  ],
  onError: (error) => {
    throw error
  },
})

/** Seed the document via a discrete update, then read the outline. */
function outlineAfter(seed: () => void) {
  editor.update(seed, { discrete: true })
  return editor.getEditorState().read($buildDocumentOutline)
}

function heading(tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', text: string) {
  const node = $createHeadingNode(tag)
  node.append($createTextNode(text))
  return node
}

describe('$buildDocumentOutline', () => {
  it('collects h1..h6 in document order with correct level and text', () => {
    const outline = outlineAfter(() => {
      const root = $getRoot()
      root.clear()
      root.append(heading('h1', 'Title'))
      root.append(heading('h2', 'Section A'))
      root.append(heading('h3', 'Subsection'))
      root.append(heading('h6', 'Deep'))
    })

    expect(outline.headings).toEqual([
      { kind: 'heading', nodeKey: expect.any(String), level: 1, text: 'Title' },
      { kind: 'heading', nodeKey: expect.any(String), level: 2, text: 'Section A' },
      { kind: 'heading', nodeKey: expect.any(String), level: 3, text: 'Subsection' },
      { kind: 'heading', nodeKey: expect.any(String), level: 6, text: 'Deep' },
    ])
    expect(outline.bookmarks).toEqual([])
  })

  it('finds a heading nested inside a collapsible (depth-first descent)', () => {
    const outline = outlineAfter(() => {
      const root = $getRoot()
      root.clear()
      root.append(heading('h1', 'Top'))
      const container = new CollapsibleContainerNode(true)
      const content: CollapsibleContentNode = $createCollapsibleContentNode()
      content.append(heading('h2', 'Nested heading'))
      container.append(content)
      root.append(container)
    })

    expect(outline.headings.map((h) => h.text)).toEqual(['Top', 'Nested heading'])
    expect(outline.headings.map((h) => h.level)).toEqual([1, 2])
  })

  it('collects bookmark anchors (inline) in document order, interleaved with headings', () => {
    const outline = outlineAfter(() => {
      const root = $getRoot()
      root.clear()
      root.append(heading('h1', 'One'))
      const p = $createParagraphNode()
      p.append($createTextNode('before '))
      p.append($createBookmarkAnchorNode('bm-1'))
      p.append($createTextNode(' after'))
      root.append(p)
      root.append(heading('h2', 'Two'))
      const p2 = $createParagraphNode()
      p2.append($createBookmarkAnchorNode('bm-2'))
      root.append(p2)
    })

    expect(outline.headings.map((h) => h.text)).toEqual(['One', 'Two'])
    expect(outline.bookmarks.map((b) => b.bookmarkId)).toEqual(['bm-1', 'bm-2'])
    expect(outline.bookmarks.every((b) => typeof b.nodeKey === 'string' && b.nodeKey.length > 0)).toBe(true)
  })

  it('keeps empty-text headings (structure preserved)', () => {
    const outline = outlineAfter(() => {
      const root = $getRoot()
      root.clear()
      root.append($createHeadingNode('h2')) // no text child
    })
    expect(outline.headings).toEqual([{ kind: 'heading', nodeKey: expect.any(String), level: 2, text: '' }])
  })

  it('returns an empty outline for an empty document', () => {
    const outline = outlineAfter(() => {
      $getRoot().clear()
    })
    expect(outline).toEqual({ headings: [], bookmarks: [] })
  })
})
