/**
 * @jest-environment jsdom
 *
 * Headless-editor tests for the Super editor's "Select all text only" toolbar
 * action ($selectAllText). These exercise the REAL Lexical tree (paragraphs +
 * a decorator/embed node) and assert that the resulting selection:
 *   - is a RangeSelection,
 *   - spans every TEXT character of the document (first text start → last end),
 *   - and, unlike the plain element-span "Select all", is anchored/focused on
 *     TEXT points (not the root element), so an interleaved decorator node is
 *     not wholesale-selected as a root child.
 */
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
} from 'lexical'
import { $createHorizontalRuleNode, HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'

import { $selectAllText } from './selectAllText'

const editor = createHeadlessEditor({
  namespace: 'SelectAllTextTest',
  nodes: [HorizontalRuleNode],
  onError: (error) => {
    throw error
  },
})

/** Build: paragraph("Hello") / <hr decorator> / paragraph("World"). */
const setDocWithDecorator = (): void => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const p1 = $createParagraphNode()
      p1.append($createTextNode('Hello'))
      root.append(p1)
      root.append($createHorizontalRuleNode())
      const p2 = $createParagraphNode()
      p2.append($createTextNode('World'))
      root.append(p2)
    },
    { discrete: true },
  )
}

describe('$selectAllText', () => {
  it('selects all TEXT as a RangeSelection spanning first text start → last text end', () => {
    setDocWithDecorator()

    let result = false
    editor.update(
      () => {
        result = $selectAllText()
      },
      { discrete: true },
    )
    expect(result).toBe(true)

    editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection)).toBe(true)
      if (!$isRangeSelection(selection)) {
        return
      }
      // The selection spans from the first text leaf to the last, covering every
      // visible text character (block boundaries surface as separators in the
      // joined content, but no text is left out).
      const text = selection.getTextContent()
      expect(text.startsWith('Hello')).toBe(true)
      expect(text.endsWith('World')).toBe(true)
      expect(text.replace(/\s/g, '')).toBe('HelloWorld')
      // Anchored/focused on TEXT points, not the root element span: the action
      // bounds the selection to actual text, not whole root children.
      expect(selection.anchor.type).toBe('text')
      expect(selection.focus.type).toBe('text')
      expect(selection.anchor.offset).toBe(0)
      expect(selection.focus.offset).toBe('World'.length)
    })
  })

  it('differs from the plain element-span "Select all": text endpoints skip a leading decorator block', () => {
    // Doc: <hr decorator> / paragraph("Body"). The first root child is the hr.
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        root.append($createHorizontalRuleNode())
        const p = $createParagraphNode()
        p.append($createTextNode('Body'))
        root.append(p)
      },
      { discrete: true },
    )

    // Plain "Select all": element-span over the root — its anchor is the root
    // ELEMENT at offset 0, i.e. the leading hr decorator is included as a child.
    editor.update(
      () => {
        const root = $getRoot()
        const selection = $createRangeSelection()
        selection.anchor.set(root.getKey(), 0, 'element')
        selection.focus.set(root.getKey(), root.getChildrenSize(), 'element')
        $setSelection(selection)
      },
      { discrete: true },
    )

    let plainAnchorIsRootElement = false
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        throw new Error('expected RangeSelection')
      }
      plainAnchorIsRootElement = selection.anchor.type === 'element' && selection.anchor.getNode().getKey() === 'root'
      expect(selection.getNodes().some((n) => n.getType() === 'horizontalrule')).toBe(true)
    })
    expect(plainAnchorIsRootElement).toBe(true)

    // Text-only variant: same doc, but the anchor is the first TEXT node (the
    // paragraph's text), so the leading decorator is NOT the selection origin.
    editor.update(
      () => {
        $selectAllText()
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        throw new Error('expected RangeSelection')
      }
      expect(selection.anchor.type).toBe('text')
      expect(selection.anchor.getNode().getTextContent()).toBe('Body')
      // The selection no longer originates at the root element / leading hr.
      expect(selection.anchor.getNode().getKey()).not.toBe('root')
    })
  })

  it('is a safe no-op on a document with no text (returns false, leaves selection null)', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        root.append($createHorizontalRuleNode())
        $setSelection(null)
      },
      { discrete: true },
    )

    let result = true
    editor.update(
      () => {
        result = $selectAllText()
      },
      { discrete: true },
    )
    expect(result).toBe(false)

    editor.getEditorState().read(() => {
      expect($getSelection()).toBeNull()
    })
  })
})
