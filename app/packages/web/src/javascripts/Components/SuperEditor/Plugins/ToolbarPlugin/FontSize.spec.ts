/**
 * @jest-environment jsdom
 *
 * Tests for the Super editor font-size helpers. The headless cases verify the
 * apply path actually writes a font-size style onto the selected text — and,
 * crucially, that it still works via a *stashed* selection after the live editor
 * selection has been cleared (the bug where the size field "did nothing" because
 * focusing it dropped the selection).
 */
import { createHeadlessEditor } from '@lexical/headless'
import { $getSelectionStyleValueForProperty } from '@lexical/selection'
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  BaseSelection,
} from 'lexical'

import { $applyFontSizeToSelection, clampFontSize, parseFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE } from './FontSize'

describe('clampFontSize', () => {
  it('rounds and clamps to the allowed range', () => {
    expect(clampFontSize(11.6)).toBe(12)
    expect(clampFontSize(-5)).toBe(MIN_FONT_SIZE)
    expect(clampFontSize(9999)).toBe(MAX_FONT_SIZE)
  })

  it('is identity at the exact boundaries and clamps just outside them', () => {
    expect(clampFontSize(MIN_FONT_SIZE)).toBe(MIN_FONT_SIZE)
    expect(clampFontSize(MAX_FONT_SIZE)).toBe(MAX_FONT_SIZE)
    expect(clampFontSize(MIN_FONT_SIZE - 1)).toBe(MIN_FONT_SIZE)
    expect(clampFontSize(MAX_FONT_SIZE + 1)).toBe(MAX_FONT_SIZE)
  })

  it('rounds half-up before clamping and floors absurd values into range', () => {
    expect(clampFontSize(8.5)).toBe(9)
    expect(clampFontSize(8.4)).toBe(8)
    expect(clampFontSize(0)).toBe(MIN_FONT_SIZE)
    expect(clampFontSize(-1000)).toBe(MIN_FONT_SIZE)
    expect(clampFontSize(1e6)).toBe(MAX_FONT_SIZE)
  })
})

describe('parseFontSize', () => {
  it('parses a px string and defaults to 16 on garbage', () => {
    expect(parseFontSize('24px')).toBe(24)
    expect(parseFontSize('')).toBe(16)
    expect(parseFontSize('not-a-number')).toBe(16)
  })

  it('handles uncommon numeric strings the way parseInt does', () => {
    expect(parseFontSize('  24  ')).toBe(24) // surrounding whitespace
    expect(parseFontSize('16.9')).toBe(16) // truncates the fraction
    expect(parseFontSize('12.3px')).toBe(12)
    expect(parseFontSize('0')).toBe(0)
    expect(parseFontSize('-5')).toBe(-5)
    expect(parseFontSize('1e3')).toBe(1) // parseInt stops at 'e'
  })
})

const makeEditor = () =>
  createHeadlessEditor({
    namespace: 'FontSizeTest',
    nodes: [],
    onError: (error) => {
      throw error
    },
  })

const seedAndSelectWord = (editor: ReturnType<typeof makeEditor>): void => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      const text = $createTextNode('hello')
      paragraph.append(text)
      root.append(paragraph)
      const selection = $createRangeSelection()
      selection.anchor.set(text.getKey(), 0, 'text')
      selection.focus.set(text.getKey(), 5, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

const readFontSize = (editor: ReturnType<typeof makeEditor>): string =>
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection)) {
      return $getSelectionStyleValueForProperty(selection, 'font-size', '')
    }
    // No live selection; read the style value off the text node directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paragraph = $getRoot().getFirstChild() as any
    const style: string = paragraph?.getFirstChild?.()?.getStyle?.() ?? ''
    return (style.match(/font-size:\s*([^;]+)/)?.[1] ?? '').trim()
  })

describe('$applyFontSizeToSelection', () => {
  it('applies the size to the live range selection', () => {
    const editor = makeEditor()
    seedAndSelectWord(editor)
    let applied = false
    editor.update(
      () => {
        applied = $applyFontSizeToSelection(28, null)
      },
      { discrete: true },
    )
    expect(applied).toBe(true)
    expect(readFontSize(editor)).toBe('28px')
  })

  it('restores a stashed selection and applies when the live selection was cleared', () => {
    const editor = makeEditor()
    seedAndSelectWord(editor)

    // Capture, then clear the live selection — simulating focus moving to the
    // toolbar font-size field.
    let saved: BaseSelection | null = null
    editor.update(
      () => {
        const selection = $getSelection()
        saved = $isRangeSelection(selection) ? selection.clone() : null
        $setSelection(null)
      },
      { discrete: true },
    )
    expect(saved).not.toBeNull()

    let applied = false
    editor.update(
      () => {
        expect($isRangeSelection($getSelection())).toBe(false) // live selection is gone
        applied = $applyFontSizeToSelection(40, saved)
      },
      { discrete: true },
    )
    expect(applied).toBe(true)
    expect(readFontSize(editor)).toBe('40px')
  })

  it('does nothing (returns false) with neither a live nor a saved selection', () => {
    const editor = makeEditor()
    seedAndSelectWord(editor)
    editor.update(() => $setSelection(null), { discrete: true })
    let applied = true
    editor.update(
      () => {
        applied = $applyFontSizeToSelection(22, null)
      },
      { discrete: true },
    )
    expect(applied).toBe(false)
  })
})
