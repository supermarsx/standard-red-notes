/**
 * @jest-environment jsdom
 *
 * Tests for the configurable list-marker helpers. The headless editor has no
 * rendered DOM, so `applyListStyleToDOM` is an intentional no-op here — these
 * specs pin down the persisted-state path: locating the nearest ListNode for a
 * selection, writing `list-style-type` onto the node's inline style while
 * preserving any other declarations, and reading it back.
 */
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
} from 'lexical'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'

import {
  $getListStyle,
  $getListNodeFromSelection,
  $setListStyle,
  BULLET_STYLES,
  NUMBER_STYLES,
} from './listStyle'

const makeEditor = () =>
  createHeadlessEditor({
    namespace: 'ListStyleTest',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })

/** Seed a single-item list and select its text. Returns the list node key. */
const seedListAndSelect = (editor: ReturnType<typeof makeEditor>, listType: 'bullet' | 'number' = 'bullet'): string => {
  let listKey = ''
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const list = $createListNode(listType)
      const item = $createListItemNode()
      const text = $createTextNode('hello')
      item.append(text)
      list.append(item)
      root.append(list)
      listKey = list.getKey()
      const selection = $createRangeSelection()
      selection.anchor.set(text.getKey(), 0, 'text')
      selection.focus.set(text.getKey(), 5, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
  return listKey
}

describe('presets', () => {
  it('expose bullet and number marker values', () => {
    // Native + custom-glyph bullet markers.
    expect(BULLET_STYLES.map((s) => s.value)).toEqual([
      'disc',
      'circle',
      'square',
      'dash',
      'arrow',
      'arrow-alt',
      'triangle',
      'diamond',
      'star',
      'chevron',
      'tickbox',
      'cross',
      'none',
    ])
    expect(NUMBER_STYLES.map((s) => s.value)).toEqual([
      'decimal',
      'lower-alpha',
      'upper-alpha',
      'lower-roman',
      'upper-roman',
      'lower-alpha-paren',
      'decimal-paren',
      'legal',
    ])
  })

  it('give every preset a human label', () => {
    for (const preset of [...BULLET_STYLES, ...NUMBER_STYLES]) {
      expect(preset.label.length).toBeGreaterThan(0)
    }
  })
})

describe('$getListNodeFromSelection', () => {
  it('finds the nearest ListNode ancestor of a selection inside a list', () => {
    const editor = makeEditor()
    const listKey = seedListAndSelect(editor)
    editor.getEditorState().read(() => {
      const node = $getListNodeFromSelection($getSelection())
      expect(node).not.toBeNull()
      expect(node?.getKey()).toBe(listKey)
    })
  })

  it('returns null when the selection is not in a list', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const paragraph = $createParagraphNode()
        const text = $createTextNode('plain')
        paragraph.append(text)
        root.append(paragraph)
        const selection = $createRangeSelection()
        selection.anchor.set(text.getKey(), 0, 'text')
        selection.focus.set(text.getKey(), 5, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    editor.getEditorState().read(() => {
      expect($getListNodeFromSelection($getSelection())).toBeNull()
    })
  })

  it('returns null for a null selection', () => {
    const editor = makeEditor()
    seedListAndSelect(editor)
    editor.getEditorState().read(() => {
      expect($getListNodeFromSelection(null)).toBeNull()
    })
  })
})

describe('$setListStyle', () => {
  it('persists list-style-type onto the nearest list node', () => {
    const editor = makeEditor()
    seedListAndSelect(editor)
    let returnedKey: string | undefined
    editor.update(
      () => {
        const node = $setListStyle($getSelection(), 'square')
        returnedKey = node?.getKey()
      },
      { discrete: true },
    )
    expect(returnedKey).toBeDefined()
    editor.getEditorState().read(() => {
      const node = $getListNodeFromSelection($getSelection())
      expect(node).not.toBeNull()
      expect($getListStyle(node as ListNode)).toBe('square')
      expect((node as ListNode).getStyle()).toContain('list-style-type: square')
    })
  })

  it('round-trips a custom-glyph marker through --sn-list-marker', () => {
    // The actual bug: custom glyphs have listStyleType: null and persist as
    // `list-style-type: none`, so without the --sn-list-marker prop their glyph
    // identity (e.g. 'arrow') would be lost on read-back/reload.
    const editor = makeEditor()
    seedListAndSelect(editor)
    editor.update(() => $setListStyle($getSelection(), 'arrow'), { discrete: true })
    editor.getEditorState().read(() => {
      const node = $getListNodeFromSelection($getSelection()) as ListNode
      // $getListStyle returns the stable preset value, not the raw `none`.
      expect($getListStyle(node)).toBe('arrow')
      const style = node.getStyle()
      // Persisted as `none` natively PLUS the marker value under the custom prop.
      expect(style).toContain('list-style-type: none')
      expect(style).toContain('--sn-list-marker: arrow')
    })
  })

  it('clears the marker to none', () => {
    const editor = makeEditor()
    seedListAndSelect(editor)
    editor.update(() => $setListStyle($getSelection(), 'square'), { discrete: true })
    editor.update(() => $setListStyle($getSelection(), 'none'), { discrete: true })
    editor.getEditorState().read(() => {
      const node = $getListNodeFromSelection($getSelection()) as ListNode
      expect($getListStyle(node)).toBe('none')
      expect(node.getStyle()).toContain('list-style-type: none')
    })
  })

  it('overwrites a previously set marker without duplicating the property', () => {
    const editor = makeEditor()
    seedListAndSelect(editor, 'number')
    editor.update(() => $setListStyle($getSelection(), 'lower-roman'), { discrete: true })
    editor.update(() => $setListStyle($getSelection(), 'upper-alpha'), { discrete: true })
    editor.getEditorState().read(() => {
      const node = $getListNodeFromSelection($getSelection()) as ListNode
      expect($getListStyle(node)).toBe('upper-alpha')
      // exactly one list-style-type declaration
      expect(node.getStyle().match(/list-style-type/g)?.length).toBe(1)
    })
  })

  it('preserves other inline style declarations on the list node', () => {
    const editor = makeEditor()
    const listKey = seedListAndSelect(editor)
    editor.update(
      () => {
        const root = $getRoot()
        const list = root.getFirstChild() as ListNode
        list.setStyle('color: red')
      },
      { discrete: true },
    )
    editor.update(() => $setListStyle($getSelection(), 'circle'), { discrete: true })
    editor.getEditorState().read(() => {
      const node = $getListNodeFromSelection($getSelection()) as ListNode
      expect(node.getKey()).toBe(listKey)
      const style = node.getStyle()
      expect(style).toContain('color: red')
      expect(style).toContain('list-style-type: circle')
    })
  })

  it('returns null and writes nothing when the selection is not in a list', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const paragraph = $createParagraphNode()
        const text = $createTextNode('plain')
        paragraph.append(text)
        root.append(paragraph)
        const selection = $createRangeSelection()
        selection.anchor.set(text.getKey(), 0, 'text')
        selection.focus.set(text.getKey(), 5, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    let result: ListNode | null = {} as ListNode
    editor.update(
      () => {
        result = $setListStyle($getSelection(), 'square')
      },
      { discrete: true },
    )
    expect(result).toBeNull()
  })
})

describe('$getListStyle', () => {
  it('returns null when no list style was set', () => {
    const editor = makeEditor()
    seedListAndSelect(editor)
    editor.getEditorState().read(() => {
      const node = $getListNodeFromSelection($getSelection()) as ListNode
      expect($getListStyle(node)).toBeNull()
    })
  })
})
