import { $createListItemNode, $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { $getNearestNodeOfType, mergeRegister } from '@lexical/utils'
import {
  $copyNode,
  $getSelection,
  $isRangeSelection,
  $normalizeSelection__EXPERIMENTAL,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from 'lexical'

const MAX_LIST_DEPTH = 7

function $isWrapper(node: LexicalNode | null): boolean {
  return $isListItemNode(node) && $isListNode(node.getFirstChild())
}

/** List containers in a partial selection must not select their untouched siblings. */
export function $selectedListItems(selection: RangeSelection): ListItemNode[] {
  const range = $normalizeSelection__EXPERIMENTAL(selection.clone())
  const end = range.isBackward() ? range.anchor : range.focus
  let leading: LexicalNode | null = end.offset === 0 ? end.getNode() : null
  while (leading && !$isListItemNode(leading)) {
    leading = leading.getPreviousSibling() ? null : leading.getParent()
  }
  const untouchedEnd = $isListItemNode(leading) ? leading : undefined
  const selected = new Map<string, ListItemNode>()
  for (const node of range.getNodes()) {
    if ($isListNode(node)) {
      continue
    }
    const item = $getNearestNodeOfType(node, ListItemNode)
    if (item && !$isWrapper(item) && !item.is(untouchedEnd)) {
      selected.set(item.getKey(), item)
    }
  }
  // A selected parent carries its descendants. Moving them again would add a second level.
  return [...selected.values()].filter((item) => {
    let wrapper = item.getParent()?.getParent()
    while ($isListItemNode(wrapper)) {
      const owner = wrapper.getPreviousSibling()
      if (owner && selected.has(owner.getKey())) {
        return false
      }
      wrapper = wrapper.getParent()?.getParent()
    }
    return true
  })
}

/** Lexical stores a row's subtree in following sibling wrappers; move it with its row. */
function $rowGroup(item: ListItemNode): ListItemNode[] {
  const nodes = [item]
  let sibling = item.getNextSibling()
  while ($isListItemNode(sibling) && $isWrapper(sibling)) {
    nodes.push(sibling)
    sibling = sibling.getNextSibling()
  }
  return nodes
}

function $canIndentGroup(group: ListItemNode[]): boolean {
  const pending: LexicalNode[] = [...group]
  while (pending.length) {
    const node = pending.pop()!
    if ($isListItemNode(node)) {
      if (!$isWrapper(node) && node.getIndent() + 1 >= MAX_LIST_DEPTH) {
        return false
      }
      pending.push(...node.getChildren())
    } else if ($isListNode(node)) {
      pending.push(...node.getChildren())
    }
  }
  return true
}

function $indentGroup(item: ListItemNode): void {
  const list = item.getParent()
  const group = $rowGroup(item)
  if (!$isListNode(list) || !$canIndentGroup(group)) {
    return
  }
  const previous = item.getPreviousSibling()
  const existing = $isListItemNode(previous) && $isWrapper(previous) ? previous.getFirstChild() : null
  let target: ListNode
  if ($isListNode(existing) && existing.getListType() === list.getListType()) {
    target = existing
  } else {
    target = $copyNode(list)
    // A structural wrapper can safely indent a whole selection, including its first row.
    // Never try to nest a parent into the subtree it already owns.
    item.insertBefore($createListItemNode().append(target))
  }
  target.append(...group)
}

function $outdentGroup(item: ListItemNode): void {
  const list = item.getParent()
  const wrapper = list?.getParent()
  if (!$isListNode(list) || !$isListItemNode(wrapper) || !$isListNode(wrapper.getParent())) {
    return
  }
  const group = $rowGroup(item)
  const after = group[group.length - 1].getNextSiblings()
  let trailing: ListItemNode | undefined
  if (after.length) {
    trailing = $createListItemNode().append($copyNode(list).append(...after))
  }
  let cursor = wrapper
  for (const node of group) {
    cursor.insertAfter(node)
    cursor = node
  }
  if (trailing) {
    cursor.insertAfter(trailing)
  }
  if (list.isEmpty()) {
    wrapper.remove()
  }
}

/** Shared by selected bullet, numbered and checklist rows, including toolbar commands. */
export function registerListSelectionIndentation(editor: LexicalEditor): () => void {
  const change = (outdent: boolean): boolean => {
    if (!editor.isEditable()) {
      return false
    }
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.isCollapsed()) {
      return false
    }
    const items = $selectedListItems(selection)
    if (!items.length) {
      return false
    }
    const retainedSelection = $normalizeSelection__EXPERIMENTAL(selection.clone())
    for (const item of items) {
      if (outdent) {
        $outdentGroup(item)
      } else {
        $indentGroup(item)
      }
    }
    $setSelection(retainedSelection)
    return true
  }
  return mergeRegister(
    editor.registerCommand(INDENT_CONTENT_COMMAND, () => change(false), COMMAND_PRIORITY_HIGH),
    editor.registerCommand(OUTDENT_CONTENT_COMMAND, () => change(true), COMMAND_PRIORITY_HIGH),
  )
}
