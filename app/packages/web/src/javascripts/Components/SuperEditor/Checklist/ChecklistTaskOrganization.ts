import { $createListNode, $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createHeadingNode, $isHeadingNode } from '@lexical/rich-text'
import { $getRoot, $isElementNode, $isRangeSelection, $createTextNode, BaseSelection, LexicalNode } from 'lexical'
import { $isChecklistPerPerson } from './checklistPersonalTicks'
import { $isChecklistItemNode, CHECKLIST_MAX_DESCENDANT_NODES } from '../Lexical/Nodes/ChecklistItemNode'

export type ChecklistOrganizationAction = 'selection' | 'section' | 'completed-section'
type TaskGroup = { task: ListItemNode; nodes: ListItemNode[] }

/** A partially selected list container must not select its untouched siblings. */
function $selectedItems(selection: BaseSelection): ListItemNode[] {
  const items = new Map<string, ListItemNode>()
  for (const selected of selection.getNodes()) {
    if ($isListNode(selected)) {
      continue
    }
    let node: LexicalNode | null = selected
    while (node) {
      if ($isChecklistItemNode(node)) {
        items.set(node.getKey(), node)
        break
      }
      node = node.getParent()
    }
  }
  return [...items.values()]
}

/** A task's sibling indentation wrapper travels with that task, preserving its subtree. */
function $groups(list: ListNode): TaskGroup[] {
  const result: TaskGroup[] = []
  for (const child of list.getChildren()) {
    if (!$isListItemNode(child)) {
      return []
    }
    if ($isChecklistItemNode(child)) {
      result.push({ task: child, nodes: [child] })
    } else if (result.length) {
      result[result.length - 1].nodes.push(child)
    } else {
      // A leading wrapper has no preceding task to own it safely.
      return []
    }
  }
  return result
}
function $completed(item: ListItemNode): boolean {
  // Personal ticks have no global all-people completion rule. Never hide them
  // merely because this user (or some peer) ticked their own box.
  return !$isChecklistPerPerson(item) && item.getChecked() === true
}
function $sectionBlocks(selection: BaseSelection | null): LexicalNode[] {
  if (!$isRangeSelection(selection)) {
    return []
  }
  const anchor = selection.anchor.getNode().getTopLevelElement()
  if (!anchor) {
    return []
  }
  const blocks = $getRoot().getChildren()
  const index = blocks.findIndex((block) => block.getKey() === anchor.getKey())
  if (index < 0) {
    return []
  }
  let start = index
  while (start >= 0 && !$isHeadingNode(blocks[start])) {
    start--
  }
  const heading = start >= 0 ? blocks[start] : null
  const level = $isHeadingNode(heading) ? Number(heading.getTag().slice(1)) : 0
  const from = Math.max(0, start)
  let end = start >= 0 ? start + 1 : 0
  for (; end < blocks.length; end++) {
    const block = blocks[end]
    if ($isHeadingNode(block) && Number(block.getTag().slice(1)) <= (level || 6)) {
      break
    }
  }
  return blocks.slice(from, end)
}
function $listsIn(blocks: LexicalNode[]): ListNode[] {
  const lists: ListNode[] = []
  const stack = [...blocks].reverse()
  let budget = CHECKLIST_MAX_DESCENDANT_NODES
  while (stack.length && budget-- > 0) {
    const node = stack.pop()!
    if ($isListNode(node) && node.getListType() === 'check') {
      lists.push(node)
    }
    if ($isElementNode(node)) {
      stack.push(...node.getChildren().reverse())
    }
  }
  return lists
}
function $sink(list: ListNode, selected?: ReadonlySet<string>): number {
  const groups = $groups(list)
  const participating = groups.filter(({ task }) => !selected || selected.has(task.getKey()))
  const desired = [
    ...participating.filter(({ task }) => !$completed(task)),
    ...participating.filter(({ task }) => $completed(task)),
  ]
  if (desired.every((group, index) => group === participating[index])) {
    return 0
  }
  let cursor = 0
  for (const group of groups) {
    const next = !selected || selected.has(group.task.getKey()) ? desired[cursor++] : group
    for (const node of next.nodes) {
      list.append(node)
    }
  }
  return participating.length
}

/** Nested groups already travelling inside an ancestor are never moved twice. */
function $outerGroups(groups: TaskGroup[]): TaskGroup[] {
  const keys = new Set(groups.flatMap((group) => group.nodes.map((node) => node.getKey())))
  return groups.filter(({ task }) => {
    let parent: LexicalNode | null = task.getParent()
    while (parent) {
      if (keys.has(parent.getKey())) {
        return false
      }
      parent = parent.getParent()
    }
    return true
  })
}
function $moveGroups(groups: TaskGroup[], target: ListNode, before: LexicalNode | null = null): number {
  const nodes = groups.flatMap((group) => group.nodes)
  if (!nodes.length) {
    return 0
  }
  const existing = target.getChildren()
  const position = before ? existing.findIndex((node) => node.getKey() === before.getKey()) : existing.length
  if (nodes.every((node, index) => existing[position - nodes.length + index]?.getKey() === node.getKey())) {
    return 0
  }
  const sources = new Set(groups.map(({ task }) => task.getParent()).filter($isListNode))
  for (const node of nodes) {
    if (before) {
      before.insertBefore(node)
    } else {
      target.append(node)
    }
  }
  for (const source of sources) {
    if (source !== target && source.isAttached() && source.getChildrenSize() === 0) {
      source.remove()
    }
  }
  return groups.length
}

/** One normal Lexical update: move existing nodes, never recreate task metadata. */
export function $organizeCompletedTasks(selection: BaseSelection | null, action: ChecklistOrganizationAction): number {
  if (!selection) {
    return 0
  }
  if (action === 'selection') {
    const selected = $selectedItems(selection)
    const keys = new Set(selected.map((item) => item.getKey()))
    const lists = new Map<string, ListNode>()
    for (const item of selected) {
      const parent = item.getParent()
      if ($isListNode(parent)) {
        lists.set(parent.getKey(), parent)
      }
    }
    if (lists.size === 1) {
      return $sink([...lists.values()][0], keys)
    }
    const nestedChanges = [...lists.values()]
      .filter((list) => list.getParent()?.getType() !== 'root')
      .reduce((count, list) => count + $sink(list, keys), 0)
    const groups = $outerGroups(
      [...lists.values()]
        .filter((list) => list.getParent()?.getType() === 'root')
        .flatMap((list) => $groups(list).filter(({ task }) => keys.has(task.getKey()))),
    )
    const last = groups[groups.length - 1]
    const target = last?.task.getParent()
    if (!$isListNode(target)) {
      return nestedChanges
    }
    return (
      nestedChanges +
      $moveGroups(
        groups.filter(({ task }) => $completed(task)),
        target,
        last.nodes[last.nodes.length - 1].getNextSibling(),
      )
    )
  }
  const blocks = $sectionBlocks(selection)
  const lists = $listsIn(blocks)
  // Nested tasks retain their parent. A checked parent carries its complete subtree.
  const nestedChanges =
    action === 'section'
      ? lists.filter((list) => list.getParent()?.getType() !== 'root').reduce((count, list) => count + $sink(list), 0)
      : 0
  const moves = $outerGroups(
    lists
      .filter((list) => list.getParent()?.getType() === 'root')
      .flatMap((list) => $groups(list).filter(({ task }) => $completed(task))),
  )
  if (!moves.length) {
    return nestedChanges
  }
  if (action === 'section') {
    const last = blocks[blocks.length - 1]
    if (!last) {
      return 0
    }
    const target = $isListNode(last) && last.getListType() === 'check' ? last : $createListNode('check')
    if (!target.isAttached()) {
      last.insertAfter(target)
    }
    return nestedChanges + $moveGroups(moves, target)
  }
  const root = $getRoot()
  let heading = root
    .getChildren()
    .find((node) => $isHeadingNode(node) && node.getTextContent().trim() === 'Completed tasks')
  if (!heading) {
    heading = $createHeadingNode('h2').append($createTextNode('Completed tasks'))
    root.append(heading)
  }
  const sibling = heading.getNextSibling()
  const target = $isListNode(sibling) && sibling.getListType() === 'check' ? sibling : $createListNode('check')
  const actual = moves.filter(({ task }) => task.getParent()?.getKey() !== target.getKey())
  if (!actual.length) {
    return 0
  }
  if (!target.isAttached()) {
    heading.insertAfter(target)
  }
  return $moveGroups(actual, target)
}
