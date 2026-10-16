/** @jest-environment jsdom */
import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createTextNode, $getRoot, ElementNode } from 'lexical'
import { $readFoldableListItems } from './FoldablePlugin'
import { computeHiddenListItemKeys } from './foldRange'

function measure(depth: number, collapsed: 'none' | 'all') {
  const editor = createHeadlessEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  const keys: string[] = []
  editor.update(
    () => {
      const list = $createListNode('check')
      let item = $createListItemNode(false).append($createTextNode('Parent'))
      list.append(item)
      $getRoot().append(list)
      keys.push(item.getKey())
      for (let index = 1; index < depth; index++) {
        const nested = $createListNode('check')
        const child = $createListItemNode(false).append($createTextNode(`Task ${index}`))
        nested.append(child)
        item.append(nested)
        item = child
        keys.push(item.getKey())
      }
    },
    { discrete: true },
  )
  const spy = jest.spyOn(ElementNode.prototype, 'getChildren')
  try {
    let descriptors: ReturnType<typeof $readFoldableListItems> = []
    const collapsedKeys = new Set(collapsed === 'all' ? keys : [])
    editor.getEditorState().read(() => {
      descriptors = $readFoldableListItems(collapsedKeys)
    })
    const calls = spy.mock.calls.length
    expect(descriptors).toHaveLength(depth - 1)
    if (collapsed === 'none') {
      expect(descriptors.every((item) => item.childKeys.length === 0)).toBe(true)
    } else {
      // Descendant controls stay present while only the outermost collapsed
      // branch owns its hidden-key array; no nested array copies that subtree.
      expect(descriptors.filter((item) => item.childKeys.length > 0)).toHaveLength(1)
      expect(computeHiddenListItemKeys(descriptors, collapsedKeys).has(keys.at(-1)!)).toBe(true)
    }
    return calls
  } finally {
    spy.mockRestore()
  }
}

it.each(['none', 'all'] as const)('visits nested-list children linearly when %s rows are collapsed', (collapsed) => {
  const shallow = measure(40, collapsed)
  const deep = measure(80, collapsed)
  expect(shallow).toBeLessThanOrEqual(2 * 40 + 1)
  expect(deep).toBeLessThanOrEqual(2 * 80 + 1)
  expect(deep).toBeLessThanOrEqual(shallow * 2)
})
