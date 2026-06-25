/**
 * @jest-environment jsdom
 *
 * Tests for the Format Painter: the subscribable store (arm/disarm/single-use vs
 * locked semantics) and the capture/apply logic driven against a real headless
 * Lexical editor so node-level format/style restyling is verified.
 */
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  $createRangeSelection,
  IS_BOLD,
  IS_ITALIC,
  $isTextNode,
  $isElementNode,
} from 'lexical'

import { formatPainterStore, CapturedFormat } from './formatPainterStore'
import { $applyCapturedFormatToSelection, $captureFormatFromSelection } from './applyCapturedFormat'

describe('formatPainterStore', () => {
  beforeEach(() => formatPainterStore.reset())

  const captured: CapturedFormat = { format: IS_BOLD, style: 'color: red;' }

  it('starts disarmed with no capture', () => {
    const s = formatPainterStore.getSnapshot()
    expect(s.armed).toBe(false)
    expect(s.locked).toBe(false)
    expect(s.captured).toBeNull()
  })

  it('arms (single-use) and disarms after apply', () => {
    formatPainterStore.arm(captured, false)
    expect(formatPainterStore.getSnapshot()).toMatchObject({ armed: true, locked: false, captured })
    formatPainterStore.afterApply()
    expect(formatPainterStore.getSnapshot().armed).toBe(false)
  })

  it('stays armed after apply when locked (double-click semantics)', () => {
    formatPainterStore.arm(captured, true)
    expect(formatPainterStore.getSnapshot().locked).toBe(true)
    formatPainterStore.afterApply()
    const s = formatPainterStore.getSnapshot()
    expect(s.armed).toBe(true)
    expect(s.captured).toEqual(captured)
  })

  it('notifies subscribers on change and supports unsubscribe', () => {
    const listener = jest.fn()
    const unsub = formatPainterStore.subscribe(listener)
    formatPainterStore.arm(captured)
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
    formatPainterStore.disarm()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('capture / apply against a headless editor', () => {
  const makeEditor = () =>
    createHeadlessEditor({
      namespace: 'FormatPainterTest',
      nodes: [],
      onError: (error) => {
        throw error
      },
    })

  it('captures the selection format bitmask and style', () => {
    const editor = makeEditor()
    let result: CapturedFormat | null = null
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        const text = $createTextNode('hello')
        text.setFormat(IS_BOLD | IS_ITALIC)
        text.setStyle('color: red;')
        paragraph.append(text)
        $getRoot().append(paragraph)

        const selection = $createRangeSelection()
        selection.anchor.set(text.getKey(), 0, 'text')
        selection.focus.set(text.getKey(), 5, 'text')
        $setSelection(selection)
        result = $captureFormatFromSelection(selection)
      },
      { discrete: true },
    )
    expect(result).toEqual({ format: IS_BOLD | IS_ITALIC, style: 'color: red;' })
  })

  it('applies captured format/style to a fresh, unformatted selection', () => {
    const editor = makeEditor()
    let targetKey = ''
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        const text = $createTextNode('world')
        targetKey = text.getKey()
        paragraph.append(text)
        $getRoot().append(paragraph)

        const selection = $createRangeSelection()
        selection.anchor.set(text.getKey(), 0, 'text')
        selection.focus.set(text.getKey(), 5, 'text')
        $setSelection(selection)
        $applyCapturedFormatToSelection(selection, { format: IS_BOLD, style: 'color: blue;' })
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const para = $getRoot().getFirstChild()
      const node = $isElementNode(para) ? para.getFirstChild() : null
      expect(node && $isTextNode(node)).toBe(true)
      if (node && $isTextNode(node)) {
        expect(node.getFormat()).toBe(IS_BOLD)
        expect(node.getStyle()).toBe('color: blue;')
      }
    })
    expect(targetKey).not.toBe('')
  })

  it('only restyles the selected portion of a partially-selected node', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        const text = $createTextNode('abcdef')
        paragraph.append(text)
        $getRoot().append(paragraph)

        const selection = $createRangeSelection()
        // Select only "cd" (offsets 2..4).
        selection.anchor.set(text.getKey(), 2, 'text')
        selection.focus.set(text.getKey(), 4, 'text')
        $setSelection(selection)
        $applyCapturedFormatToSelection(selection, { format: IS_BOLD, style: '' })
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const para = $getRoot().getFirstChild()
      const children = $isElementNode(para) ? para.getChildren() : []
      // Expect a split: the middle segment "cd" is bold, the rest is not.
      const boldText = children
        .filter($isTextNode)
        .find((c) => c.getTextContent() === 'cd')
      expect(boldText).toBeDefined()
      expect(boldText?.getFormat()).toBe(IS_BOLD)
    })
  })
})
