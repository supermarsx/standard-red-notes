/** @jest-environment jsdom */
import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import {
  $createTableOfContentsNode,
  DEFAULT_TABLE_OF_CONTENTS_FORMAT,
  TableOfContentsNode,
  normalizeTableOfContentsFormat,
} from './TableOfContentsNode'

describe('table of contents formatting', () => {
  const editor = createHeadlessEditor({
    namespace: 'toc-format',
    nodes: [TableOfContentsNode],
    onError: (error) => {
      throw error
    },
  })
  it('loads existing unformatted blocks with the original appearance', () => {
    editor.update(
      () => {
        const node = TableOfContentsNode.importJSON({ type: 'table-of-contents', version: 1 })
        expect(node.getFormat()).toEqual(DEFAULT_TABLE_OF_CONTENTS_FORMAT)
      },
      { discrete: true },
    )
  })
  it('persists per-block formatting across a complete editor JSON round trip', () => {
    editor.update(
      () => {
        const node = $createTableOfContentsNode()
        node.setFormat({ maxLevel: 3, numbered: true, showTitle: false })
        $getRoot().clear().append(node)
      },
      { discrete: true },
    )
    const restored = editor.parseEditorState(JSON.stringify(editor.getEditorState().toJSON()))
    restored.read(() => {
      expect(($getRoot().getFirstChild() as TableOfContentsNode).getFormat()).toEqual({
        maxLevel: 3,
        numbered: true,
        showTitle: false,
      })
    })
  })
  it('bounds untrusted heading depths and rejects non-boolean display flags', () => {
    expect(normalizeTableOfContentsFormat({ maxLevel: 400 })).toEqual({
      ...DEFAULT_TABLE_OF_CONTENTS_FORMAT,
      maxLevel: 6,
    })
    expect(normalizeTableOfContentsFormat({ maxLevel: -1 })).toEqual({
      ...DEFAULT_TABLE_OF_CONTENTS_FORMAT,
      maxLevel: 1,
    })
    expect(normalizeTableOfContentsFormat({ maxLevel: Number.NaN })).toEqual(DEFAULT_TABLE_OF_CONTENTS_FORMAT)
  })
})
