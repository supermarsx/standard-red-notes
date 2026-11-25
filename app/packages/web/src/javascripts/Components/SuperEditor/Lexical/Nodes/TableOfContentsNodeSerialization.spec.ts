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
        ...DEFAULT_TABLE_OF_CONTENTS_FORMAT,
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

  it('round-trips custom titles, subtitle, and appearance through a fresh editor', () => {
    const format = {
      ...DEFAULT_TABLE_OF_CONTENTS_FORMAT,
      title: 'Project guide',
      subtitle: 'A quick route through the research',
      font: 'serif' as const,
      alignment: 'center' as const,
      titleSize: 28,
      subtitleSize: 16,
      entrySize: 18,
      titleWeight: 'bold' as const,
      titleItalic: true,
      uppercaseTitle: false,
      titleColor: '#123456',
      subtitleColor: '#456789',
      entryColor: '#789abc',
      indentation: 24,
      entrySpacing: 8,
      wrapEntries: true,
      appearance: 'plain' as const,
    }
    editor.update(
      () => {
        const node = $createTableOfContentsNode()
        node.setFormat(format)
        $getRoot().clear().append(node)
      },
      { discrete: true },
    )
    const reopened = createHeadlessEditor({
      nodes: [TableOfContentsNode],
      onError: (error) => {
        throw error
      },
    })
    reopened.setEditorState(reopened.parseEditorState(JSON.stringify(editor.getEditorState().toJSON())))
    reopened
      .getEditorState()
      .read(() => expect(($getRoot().getFirstChild() as TableOfContentsNode).getFormat()).toEqual(format))
  })

  it('bounds imported appearance settings and accepts only plain text and valid colors', () => {
    expect(
      normalizeTableOfContentsFormat({
        titleSize: 999,
        subtitleSize: -5,
        entrySize: Number.NaN,
        indentation: -50,
        entrySpacing: Infinity,
        titleColor: 'url(https://example.test)',
        subtitleColor: '#123456',
        entryColor: '<style>',
      }),
    ).toMatchObject({
      titleSize: 48,
      subtitleSize: 8,
      entrySize: 14,
      indentation: 0,
      entrySpacing: 2,
      titleColor: '',
      subtitleColor: '#123456',
      entryColor: '',
    })
  })
})
