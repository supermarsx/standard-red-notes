/**
 * @jest-environment jsdom
 *
 * Tests for the "completed checklist tasks move out of the way" reordering
 * (issue 3928). We exercise both the pure ordering decision and the real
 * Lexical tree mutation via a headless editor (no React/DOM mount).
 */
import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, $isListItemNode, ListItemNode, ListNode } from '@lexical/list'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'

import { computeReorderedKeys, $reorderCheckList } from './reorderCheckList'
import { $uncheckAllInList } from './bulkUncheck'

const editor = createHeadlessEditor({
  namespace: 'CheckListReorderTest',
  nodes: [ListNode, ListItemNode],
  onError: (error) => {
    throw error
  },
})

/** Build a check list with the given (label, checked) rows; returns the ListNode. */
function buildCheckList(rows: Array<[string, boolean]>): ListNode {
  const list = $createListNode('check')
  for (const [label, checked] of rows) {
    const item = $createListItemNode(checked)
    item.append($createTextNode(label))
    list.append(item)
  }
  return list
}

/** Read back the current (label, checked) order of a check list's items. */
function readList(list: ListNode): Array<[string, boolean]> {
  return list
    .getChildren()
    .filter($isListItemNode)
    .map((item) => [item.getTextContent(), item.getChecked() === true] as [string, boolean])
}

describe('computeReorderedKeys', () => {
  it('keeps unchecked items first in stable order, checked items last in stable order', () => {
    const result = computeReorderedKeys([
      { key: 'a', checked: false },
      { key: 'b', checked: true },
      { key: 'c', checked: false },
      { key: 'd', checked: true },
    ])
    expect(result).toEqual(['a', 'c', 'b', 'd'])
  })

  it('is a no-op order when nothing is checked', () => {
    const result = computeReorderedKeys([
      { key: 'a', checked: false },
      { key: 'b', checked: false },
    ])
    expect(result).toEqual(['a', 'b'])
  })

  it('moves all to bottom preserving order when all checked', () => {
    const result = computeReorderedKeys([
      { key: 'a', checked: true },
      { key: 'b', checked: true },
    ])
    expect(result).toEqual(['a', 'b'])
  })
})

describe('$reorderCheckList', () => {
  it('moves a checked item to the bottom while keeping the others in order', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        // Task 1 checked, Task 2 & 3 unchecked -> Task 1 should sink to bottom.
        const list = buildCheckList([
          ['Task 1', true],
          ['Task 2', false],
          ['Task 3', false],
        ])
        root.append(list)

        const moved = $reorderCheckList(list)
        expect(moved).toBe(true)
        expect(readList(list)).toEqual([
          ['Task 2', false],
          ['Task 3', false],
          ['Task 1', true],
        ])
      },
      { discrete: true },
    )
  })

  it('groups multiple checked items at the bottom in their original relative order', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const list = buildCheckList([
          ['A', true],
          ['B', false],
          ['C', true],
          ['D', false],
        ])
        root.append(list)

        $reorderCheckList(list)
        expect(readList(list)).toEqual([
          ['B', false],
          ['D', false],
          ['A', true],
          ['C', true],
        ])
      },
      { discrete: true },
    )
  })

  it('returns false (no mutation) when already in desired order', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const list = buildCheckList([
          ['B', false],
          ['D', false],
          ['A', true],
          ['C', true],
        ])
        root.append(list)

        expect($reorderCheckList(list)).toBe(false)
      },
      { discrete: true },
    )
  })

  it('does not reorder a non-check list', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const list = $createListNode('bullet')
        const a = $createListItemNode()
        a.append($createTextNode('a'))
        const b = $createListItemNode()
        b.append($createTextNode('b'))
        list.append(a, b)
        root.append(list)

        expect($reorderCheckList(list)).toBe(false)
      },
      { discrete: true },
    )
  })

  it('skips lists that contain nested-list wrapper items (preserves invariants)', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const list = $createListNode('check')
        const checked = $createListItemNode(true)
        checked.append($createTextNode('done'))
        // A wrapper item that holds a nested list (no own check state).
        const wrapper = $createListItemNode()
        const nested = $createListNode('check')
        const nestedItem = $createListItemNode(false)
        nestedItem.append($createTextNode('nested'))
        nested.append(nestedItem)
        wrapper.append(nested)
        list.append(checked, wrapper)
        root.append(list)

        // Because not every child is a plain task item, we bail out safely.
        expect($reorderCheckList(list)).toBe(false)
      },
      { discrete: true },
    )
  })
})

describe('$uncheckAllInList (bulk restore)', () => {
  it('unchecks every completed item and reports the count', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const list = buildCheckList([
          ['A', true],
          ['B', false],
          ['C', true],
        ])
        root.append(list)

        const count = $uncheckAllInList(list)
        expect(count).toBe(2)
        expect(readList(list)).toEqual([
          ['A', false],
          ['B', false],
          ['C', false],
        ])
      },
      { discrete: true },
    )
  })

  it('does nothing for a non-check list', () => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const para = $createParagraphNode()
        para.append($createTextNode('x'))
        root.append(para)
        const list = $createListNode('bullet')
        root.append(list)
        expect($uncheckAllInList(list)).toBe(0)
      },
      { discrete: true },
    )
  })
})
