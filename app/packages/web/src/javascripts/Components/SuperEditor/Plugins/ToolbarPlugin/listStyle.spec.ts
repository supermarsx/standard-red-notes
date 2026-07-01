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
import { $createListItemNode, $createListNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'

import {
  $getListStyle,
  $getListNodeFromSelection,
  $getMultilevelListStyle,
  $getTopListNodeFromSelection,
  applyListStyleToDOM,
  $setListStyle,
  $setMultilevelListStyle,
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

/** Seed a 3-level nested list (top > nested > deepest) and select the deepest item. */
const seedNestedListAndSelect = (editor: ReturnType<typeof makeEditor>): string => {
  let topKey = ''
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const top = $createListNode('bullet')
      const topItem = $createListItemNode()
      topItem.append($createTextNode('one'))
      top.append(topItem)

      // A nested list is appended as a child of a ListItemNode of the parent list.
      const l2 = $createListNode('bullet')
      const l2Item = $createListItemNode()
      l2Item.append($createTextNode('two'))
      l2.append(l2Item)
      const l2Holder = $createListItemNode()
      l2Holder.append(l2)
      top.append(l2Holder)

      const l3 = $createListNode('bullet')
      const l3Item = $createListItemNode()
      const deepText = $createTextNode('three')
      l3Item.append(deepText)
      l3.append(l3Item)
      const l3Holder = $createListItemNode()
      l3Holder.append(l3)
      l2.append(l3Holder)

      root.append(top)
      topKey = top.getKey()

      const selection = $createRangeSelection()
      selection.anchor.set(deepText.getKey(), 0, 'text')
      selection.focus.set(deepText.getKey(), 5, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
  return topKey
}

describe('$setMultilevelListStyle', () => {
  it('persists a per-level map on the OUTERMOST list, even when selecting a deep item', () => {
    const editor = makeEditor()
    const topKey = seedNestedListAndSelect(editor)
    // Simulate the configurator applying a per-level draft (level 1 + level 2 markers).
    let returnedKey: string | undefined
    editor.update(
      () => {
        const node = $setMultilevelListStyle($getSelection(), { 1: 'disc', 2: 'square' })
        returnedKey = node?.getKey()
      },
      { discrete: true },
    )
    // The map is written to the top list, not the deep one the caret was in.
    expect(returnedKey).toBe(topKey)
    editor.getEditorState().read(() => {
      const top = $getTopListNodeFromSelection($getSelection()) as ListNode
      expect(top.getKey()).toBe(topKey)
      const map = $getMultilevelListStyle(top)
      expect(map).toEqual({ 1: 'disc', 2: 'square' })
      expect(top.getStyle()).toContain('--sn-list-levels: 1=disc,2=square')
    })
  })

  it('updates an individual level marker and round-trips it (select level 3 changes only level 3)', () => {
    const editor = makeEditor()
    const topKey = seedNestedListAndSelect(editor)
    editor.update(() => $setMultilevelListStyle($getSelection(), { 1: 'disc', 2: 'circle', 3: 'dash' }), {
      discrete: true,
    })
    // The user re-opens and picks a different marker for level 3 only.
    editor.update(() => $setMultilevelListStyle($getSelection(), { 1: 'disc', 2: 'circle', 3: 'arrow' }), {
      discrete: true,
    })
    editor.getEditorState().read(() => {
      const top = $getTopListNodeFromSelection($getSelection()) as ListNode
      expect(top.getKey()).toBe(topKey)
      expect($getMultilevelListStyle(top)).toEqual({ 1: 'disc', 2: 'circle', 3: 'arrow' })
      // Exactly one levels declaration — no duplication on re-apply.
      expect(top.getStyle().match(/--sn-list-levels/g)?.length).toBe(1)
    })
  })

  it('clears the per-level map when applied empty', () => {
    const editor = makeEditor()
    seedNestedListAndSelect(editor)
    editor.update(() => $setMultilevelListStyle($getSelection(), { 1: 'disc', 2: 'square' }), { discrete: true })
    editor.update(() => $setMultilevelListStyle($getSelection(), {}), { discrete: true })
    editor.getEditorState().read(() => {
      const top = $getTopListNodeFromSelection($getSelection()) as ListNode
      expect($getMultilevelListStyle(top)).toEqual({})
      expect(top.getStyle()).not.toContain('--sn-list-levels')
    })
  })

  it('ignores empty/falsy level entries when serializing', () => {
    const editor = makeEditor()
    seedNestedListAndSelect(editor)
    editor.update(() => $setMultilevelListStyle($getSelection(), { 1: 'disc', 2: '', 3: 'square' }), {
      discrete: true,
    })
    editor.getEditorState().read(() => {
      const top = $getTopListNodeFromSelection($getSelection()) as ListNode
      expect($getMultilevelListStyle(top)).toEqual({ 1: 'disc', 3: 'square' })
    })
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

describe('applyListStyleToDOM multilevel stale-marker clearing (BUG 3)', () => {
  /**
   * Headless Lexical has no rendered DOM, so `getElementByKey` returns null and
   * `applyListStyleToDOM` is normally a no-op. To exercise the DOM stamping path
   * we back every list node with a real `<ul>` element via a spy, then assert
   * that re-applying a multilevel map which DROPS a level clears the stale marker
   * class on the affected descendant list (the previous bug: the level was
   * skipped, so the old `Lexical__listStyle--*` class lingered until reload).
   */
  const stubListElements = (editor: ReturnType<typeof makeEditor>): Map<string, HTMLElement> => {
    const elements = new Map<string, HTMLElement>()
    editor.getEditorState().read(() => {
      const visit = (node: import('lexical').LexicalNode): void => {
        if ($isListNode(node)) {
          elements.set(node.getKey(), document.createElement('ul'))
        }
        if ('getChildren' in node && typeof (node as { getChildren?: unknown }).getChildren === 'function') {
          for (const child of (node as unknown as { getChildren: () => import('lexical').LexicalNode[] }).getChildren()) {
            visit(child)
          }
        }
      }
      visit($getRoot())
    })
    jest.spyOn(editor, 'getElementByKey').mockImplementation((key: string) => elements.get(key) ?? null)
    return elements
  }

  const reapplyTop = (editor: ReturnType<typeof makeEditor>): void => {
    editor.update(
      () => {
        const top = $getTopListNodeFromSelection($getSelection()) as ListNode
        applyListStyleToDOM(top)
      },
      { discrete: true },
    )
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('clears the stale marker class on a level whose glyph was dropped from the map', () => {
    const editor = makeEditor()
    seedNestedListAndSelect(editor)
    const elements = stubListElements(editor)

    // First definition: stamp level 2 with `square`.
    editor.update(() => $setMultilevelListStyle($getSelection(), { 1: 'disc', 2: 'square', 3: 'arrow' }), {
      discrete: true,
    })
    reapplyTop(editor)

    // Find the level-2 list element (the nested list one level under the top).
    // Mirror production's `stampDepth`: a node's level is `parentLevel + 1` only
    // when the node ITSELF is a list, so the top list's descendant lists land at
    // level 2, 3, ...
    let level2Key = ''
    editor.getEditorState().read(() => {
      const top = $getTopListNodeFromSelection($getSelection()) as ListNode
      const walk = (node: import('lexical').LexicalNode, parentLevel: number) => {
        let levelHere = parentLevel
        if ($isListNode(node)) {
          levelHere = parentLevel + 1
          if (levelHere === 2) {
            level2Key = node.getKey()
          }
        }
        if ('getChildren' in node && typeof (node as { getChildren?: unknown }).getChildren === 'function') {
          for (const child of (node as unknown as { getChildren: () => import('lexical').LexicalNode[] }).getChildren()) {
            walk(child, levelHere)
          }
        }
      }
      for (const child of top.getChildren()) {
        walk(child, 1)
      }
    })
    const level2El = elements.get(level2Key) as HTMLElement
    expect(level2El.classList.contains('Lexical__listStyle--square')).toBe(true)

    // Redefine the multilevel map DROPPING level 2's glyph.
    editor.update(() => $setMultilevelListStyle($getSelection(), { 1: 'disc', 3: 'arrow' }), { discrete: true })
    reapplyTop(editor)

    // The stale `square` marker class must have been cleared (BUG 3 fix).
    expect(level2El.classList.contains('Lexical__listStyle--square')).toBe(false)
  })
})
