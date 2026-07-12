/**
 * @jest-environment jsdom
 *
 * Tests for the Insert -> Symbol picker's insertion + recents core.
 *   1. $insertSymbol inserts the char at a collapsed caret, and chained inserts
 *      accumulate (multi-insert), and a non-collapsed selection is REPLACED.
 *   2. addRecentSymbol reducer: move-to-front, dedupe, cap.
 *   3. load/save recents round-trip through localStorage and never throw.
 *
 * A node write requires an active editor, so all node work runs inside
 * editor.update({ discrete: true }) on a headless editor (mirrors the
 * serialization specs' harness).
 */
import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical'

import {
  $insertSymbol,
  addRecentSymbol,
  loadRecentSymbols,
  saveRecentSymbols,
  RECENT_SYMBOLS_LIMIT,
} from './insertSymbol'

const makeEditor = () =>
  createHeadlessEditor({
    namespace: 'InsertSymbolTest',
    nodes: [],
    onError: (error) => {
      throw error
    },
  })

function inEditor(editor: ReturnType<typeof makeEditor>, fn: () => void): void {
  editor.update(fn, { discrete: true })
}

describe('$insertSymbol', () => {
  it('inserts the character at a collapsed caret', () => {
    const editor = makeEditor()
    inEditor(editor, () => {
      const paragraph = $createParagraphNode()
      const text = $createTextNode('')
      paragraph.append(text)
      $getRoot().append(paragraph)
      text.select(0, 0)
    })
    inEditor(editor, () => $insertSymbol('Ω'))

    let content = ''
    editor.getEditorState().read(() => {
      content = $getRoot().getTextContent()
    })
    expect(content).toContain('Ω')
  })

  it('chains multiple inserts (keep-open multi-insert advances the caret)', () => {
    const editor = makeEditor()
    inEditor(editor, () => {
      const paragraph = $createParagraphNode()
      const text = $createTextNode('')
      paragraph.append(text)
      $getRoot().append(paragraph)
      text.select(0, 0)
    })
    inEditor(editor, () => $insertSymbol('Ω'))
    inEditor(editor, () => $insertSymbol('→'))

    let content = ''
    editor.getEditorState().read(() => {
      content = $getRoot().getTextContent()
    })
    expect(content).toBe('Ω→')
  })

  it('replaces a non-collapsed selection (Word-like)', () => {
    const editor = makeEditor()
    inEditor(editor, () => {
      const paragraph = $createParagraphNode()
      const text = $createTextNode('ab')
      paragraph.append(text)
      $getRoot().append(paragraph)
      text.select(0, 2)
    })
    inEditor(editor, () => $insertSymbol('X'))

    let content = ''
    editor.getEditorState().read(() => {
      content = $getRoot().getTextContent()
    })
    expect(content).toBe('X')
  })
})

describe('addRecentSymbol', () => {
  it('moves an existing char to the front (dedupe)', () => {
    expect(addRecentSymbol(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('prepends a new char', () => {
    expect(addRecentSymbol(['a', 'b'], 'z')).toEqual(['z', 'a', 'b'])
  })

  it('caps the list at the limit', () => {
    const seed = Array.from({ length: RECENT_SYMBOLS_LIMIT }, (_unused, index) => `${index}`)
    const result = addRecentSymbol(seed, 'new')
    expect(result.length).toBe(RECENT_SYMBOLS_LIMIT)
    expect(result[0]).toBe('new')
    // The formerly-last element was pushed off the end.
    expect(result).not.toContain(`${RECENT_SYMBOLS_LIMIT - 1}`)
  })

  it('ignores an empty char', () => {
    expect(addRecentSymbol(['a'], '')).toEqual(['a'])
  })
})

describe('recents persistence', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips through localStorage', () => {
    saveRecentSymbols(['Ω', '→'])
    expect(loadRecentSymbols()).toEqual(['Ω', '→'])
  })

  it('returns [] when nothing is stored', () => {
    expect(loadRecentSymbols()).toEqual([])
  })

  it('returns [] for corrupt stored data (never throws)', () => {
    localStorage.setItem('super-editor:recent-symbols', '{ not json')
    expect(loadRecentSymbols()).toEqual([])
  })
})
