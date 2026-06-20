import { $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { $getNodeByKey, LexicalNode } from 'lexical'

/**
 * "Completed tasks move out of the way" reordering for Super-Notes checklists
 * (GitHub forum issue 3928).
 *
 * When enabled, checking an item relocates it to the bottom of its checklist so
 * the remaining active (unchecked) tasks bubble up and keep their relative
 * order. Unchecking returns the item to the bottom of the active group. The
 * checked items collect, in toggle-stable order, beneath the active items —
 * effectively a "Completed" area at the end of the same list.
 *
 * We only reorder the list's OWN top-level item nodes (those whose direct
 * parent is this ListNode). We deliberately do NOT touch:
 *   - nested checklists (a list item that contains a child list): moving those
 *     around would fight Lexical's list/indent invariants, and a parent item's
 *     "checked" state is not meaningful when it only holds a nested list.
 *   - items at a deeper indent: indentation in Lexical lists is represented by
 *     nested ListNodes, so a deeper item is simply not a direct child here.
 *
 * The function is pure with respect to ordering: it computes the desired order
 * and only emits the minimal set of moves needed. It MUST be called inside an
 * `editor.update()` context (it mutates the tree).
 */

/** A direct child list item that participates in reordering (a real task row). */
function isReorderableTaskItem(node: LexicalNode): node is ListItemNode {
  if (!$isListItemNode(node)) {
    return false
  }
  // Skip "wrapper" items that only hold a nested list (these have no own check
  // state worth moving and moving them would relocate whole sub-trees).
  const firstChild = node.getFirstChild()
  if (firstChild && $isListNode(firstChild)) {
    return false
  }
  return true
}

/**
 * Given the current ordered list of task items, returns the desired order:
 * unchecked items first (stable), then checked items (stable). Exported for
 * unit testing the ordering decision independently of Lexical mutation.
 */
export function computeReorderedKeys(
  items: ReadonlyArray<{ key: string; checked: boolean }>,
): string[] {
  const unchecked: string[] = []
  const checked: string[] = []
  for (const item of items) {
    if (item.checked) {
      checked.push(item.key)
    } else {
      unchecked.push(item.key)
    }
  }
  return [...unchecked, ...checked]
}

/**
 * Reorder a single checklist ListNode in place so completed items sink to the
 * bottom. Returns true if any move was performed. No-op for non-check lists.
 */
export function $reorderCheckList(listNode: ListNode): boolean {
  if (!$isListNode(listNode) || listNode.getListType() !== 'check') {
    return false
  }

  const children = listNode.getChildren()
  const taskItems = children.filter(isReorderableTaskItem)

  // If the list mixes task items with nested-list wrapper items, reordering only
  // the task items could interleave them confusingly. Keep it simple & safe:
  // only auto-move when every child is a plain task item.
  if (taskItems.length !== children.length) {
    return false
  }
  if (taskItems.length < 2) {
    return false
  }

  const current = taskItems.map((item) => ({ key: item.getKey(), checked: item.getChecked() === true }))
  const desiredOrder = computeReorderedKeys(current)
  const currentOrder = current.map((c) => c.key)

  // Already in the desired order — nothing to do (avoids needless mutations,
  // history churn, and caret fighting).
  let alreadyOrdered = true
  for (let i = 0; i < desiredOrder.length; i++) {
    if (desiredOrder[i] !== currentOrder[i]) {
      alreadyOrdered = false
      break
    }
  }
  if (alreadyOrdered) {
    return false
  }

  // Re-append items in the desired order. Appending an already-attached child to
  // its parent moves it to the end, so appending each in target order yields the
  // final sequence while preserving each node (and its text/selection) intact.
  for (const key of desiredOrder) {
    const node = $getNodeByKey(key)
    if ($isListItemNode(node)) {
      listNode.append(node)
    }
  }

  return true
}

/**
 * Find the checklist ListNode that owns the given list item and reorder it.
 * Returns true if a reorder happened.
 */
export function $reorderCheckListForItem(item: ListItemNode): boolean {
  const parent = item.getParent()
  if (!$isListNode(parent)) {
    return false
  }
  return $reorderCheckList(parent)
}
