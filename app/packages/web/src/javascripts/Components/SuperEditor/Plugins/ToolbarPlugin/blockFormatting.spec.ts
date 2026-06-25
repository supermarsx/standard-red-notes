/**
 * @jest-environment jsdom
 *
 * Tests for the Super editor block-formatting helpers. The pure cases cover the
 * style string parse/serialise/merge round-trip (the normaliser that lets line
 * height, spacing, indent, and margins coexist on one block). The headless cases
 * verify the `$` apply path writes the expected CSS onto the leaf blocks the
 * selection spans, and that text shading lands on the inline text.
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
  ElementNode,
} from 'lexical'

import {
  $collectFormatBlocks,
  $setBlockMargins,
  $setFirstLineIndent,
  $setIndent,
  $setIndentRight,
  $setLineHeight,
  $setSpaceAfter,
  $setSpaceBefore,
  $setTextShading,
  INDENT_STEP,
  LINE_HEIGHT_PRESETS,
  mergeBlockStyle,
  parseStyleString,
  serializeStyleMap,
  SPACING_PRESETS,
  TEXT_SHADING_PRESETS,
} from './blockFormatting'

describe('presets', () => {
  it('exposes the documented preset shapes', () => {
    expect(LINE_HEIGHT_PRESETS).toEqual(['1', '1.15', '1.5', '2'])
    expect(SPACING_PRESETS[0]).toBe('0')
    expect(INDENT_STEP).toBe('40px')
    expect(TEXT_SHADING_PRESETS[0]).toBeNull()
    expect(TEXT_SHADING_PRESETS.length).toBeGreaterThan(1)
  })
})

describe('parseStyleString', () => {
  it('parses declarations into a property map, skipping garbage', () => {
    const map = parseStyleString('line-height: 1.5; margin-top: 8px; ; bogus; color:')
    expect(map.get('line-height')).toBe('1.5')
    expect(map.get('margin-top')).toBe('8px')
    expect(map.has('color')).toBe(false)
    expect(map.size).toBe(2)
  })

  it('lower-cases property names and trims whitespace', () => {
    const map = parseStyleString('  Line-Height :  2  ')
    expect(map.get('line-height')).toBe('2')
  })

  it('returns an empty map for empty input', () => {
    expect(parseStyleString('').size).toBe(0)
  })
})

describe('serializeStyleMap', () => {
  it('round-trips parse → serialise → parse', () => {
    const original = 'line-height: 1.5; margin-top: 8px; padding-left: 40px'
    const map = parseStyleString(original)
    const reparsed = parseStyleString(serializeStyleMap(map))
    expect(reparsed).toEqual(map)
  })

  it('serialises an empty map to an empty string', () => {
    expect(serializeStyleMap(new Map())).toBe('')
  })
})

describe('mergeBlockStyle', () => {
  it('adds a new property without disturbing existing ones', () => {
    const result = mergeBlockStyle('line-height: 1.5', 'margin-top', '8px')
    const map = parseStyleString(result)
    expect(map.get('line-height')).toBe('1.5')
    expect(map.get('margin-top')).toBe('8px')
  })

  it('overwrites an existing property', () => {
    const result = mergeBlockStyle('line-height: 1; margin-top: 4px', 'line-height', '2')
    expect(parseStyleString(result).get('line-height')).toBe('2')
  })

  it('removes a property when the value is empty or whitespace', () => {
    expect(parseStyleString(mergeBlockStyle('line-height: 2; margin-top: 8px', 'margin-top', '')).has('margin-top')).toBe(
      false,
    )
    expect(parseStyleString(mergeBlockStyle('margin-top: 8px', 'margin-top', '   ')).has('margin-top')).toBe(false)
  })

  it('normalises property casing and trims the value', () => {
    const result = mergeBlockStyle('', 'Margin-Top', '  8px ')
    expect(parseStyleString(result).get('margin-top')).toBe('8px')
  })
})

/* ----------------------------------------------------------------- headless */

const makeEditor = () =>
  createHeadlessEditor({
    namespace: 'BlockFormattingTest',
    nodes: [],
    onError: (error) => {
      throw error
    },
  })

const seedThreeParagraphsSelectFirstTwo = (editor: ReturnType<typeof makeEditor>): void => {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const t1 = $createTextNode('one')
      const t2 = $createTextNode('two')
      const t3 = $createTextNode('three')
      const p1 = $createParagraphNode().append(t1)
      const p2 = $createParagraphNode().append(t2)
      const p3 = $createParagraphNode().append(t3)
      root.append(p1, p2, p3)
      const selection = $createRangeSelection()
      selection.anchor.set(t1.getKey(), 0, 'text')
      selection.focus.set(t2.getKey(), 3, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

const blockStyles = (editor: ReturnType<typeof makeEditor>): string[] =>
  editor.getEditorState().read(() => $getRoot().getChildren().map((c) => (c as ElementNode).getStyle()))

const runOnSelection = (editor: ReturnType<typeof makeEditor>, fn: (sel: ReturnType<typeof $createRangeSelection>) => void): void => {
  editor.update(
    () => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        fn(selection)
      }
    },
    { discrete: true },
  )
}

describe('$collectFormatBlocks', () => {
  it('collects only the blocks the selection intersects, in order', () => {
    const editor = makeEditor()
    seedThreeParagraphsSelectFirstTwo(editor)
    let count = -1
    runOnSelection(editor, (selection) => {
      count = $collectFormatBlocks(selection).length
    })
    expect(count).toBe(2)
  })
})

describe('block-style apply helpers', () => {
  it('$setLineHeight sets line-height on each spanned block only', () => {
    const editor = makeEditor()
    seedThreeParagraphsSelectFirstTwo(editor)
    runOnSelection(editor, (selection) => {
      expect($setLineHeight(selection, '1.5')).toBe(2)
    })
    const styles = blockStyles(editor)
    expect(styles[0]).toContain('line-height: 1.5')
    expect(styles[1]).toContain('line-height: 1.5')
    expect(styles[2]).toBe('')
  })

  it('spacing / indent helpers merge independently on the same block', () => {
    const editor = makeEditor()
    seedThreeParagraphsSelectFirstTwo(editor)
    runOnSelection(editor, (selection) => {
      $setLineHeight(selection, '2')
      $setSpaceBefore(selection, '8px')
      $setSpaceAfter(selection, '12px')
      $setIndent(selection, INDENT_STEP)
      $setIndentRight(selection, '10px')
      $setFirstLineIndent(selection, '24px')
    })
    const map = parseStyleString(blockStyles(editor)[0])
    expect(map.get('line-height')).toBe('2')
    expect(map.get('margin-top')).toBe('8px')
    expect(map.get('margin-bottom')).toBe('12px')
    expect(map.get('padding-left')).toBe('40px')
    expect(map.get('padding-right')).toBe('10px')
    expect(map.get('text-indent')).toBe('24px')
  })

  it('$setBlockMargins sets left and right, and leaves omitted sides alone', () => {
    const editor = makeEditor()
    seedThreeParagraphsSelectFirstTwo(editor)
    runOnSelection(editor, (selection) => {
      $setBlockMargins(selection, { left: '16px', right: '16px' })
    })
    let map = parseStyleString(blockStyles(editor)[0])
    expect(map.get('margin-left')).toBe('16px')
    expect(map.get('margin-right')).toBe('16px')

    // Clearing only the left should leave the right intact.
    runOnSelection(editor, (selection) => {
      $setBlockMargins(selection, { left: '' })
    })
    map = parseStyleString(blockStyles(editor)[0])
    expect(map.has('margin-left')).toBe(false)
    expect(map.get('margin-right')).toBe('16px')
  })

  it('clearing line-height removes just that property', () => {
    const editor = makeEditor()
    seedThreeParagraphsSelectFirstTwo(editor)
    runOnSelection(editor, (selection) => {
      $setLineHeight(selection, '2')
      $setSpaceBefore(selection, '8px')
      $setLineHeight(selection, '')
    })
    const map = parseStyleString(blockStyles(editor)[0])
    expect(map.has('line-height')).toBe(false)
    expect(map.get('margin-top')).toBe('8px')
  })
})

describe('$setTextShading', () => {
  it('applies a background-color to the selected inline text', () => {
    const editor = makeEditor()
    seedThreeParagraphsSelectFirstTwo(editor)
    runOnSelection(editor, (selection) => {
      expect($setTextShading(selection, '#fff3a3')).toBe(true)
    })
    const style = editor.getEditorState().read(() => {
      const firstText = ($getRoot().getFirstChild() as ElementNode).getFirstChild()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (firstText as any)?.getStyle?.() ?? ''
    })
    expect(style).toContain('background-color: #fff3a3')
  })
})
