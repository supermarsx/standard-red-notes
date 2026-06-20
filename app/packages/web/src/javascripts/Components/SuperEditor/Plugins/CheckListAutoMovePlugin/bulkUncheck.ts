import { $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { LexicalNode } from 'lexical'

/**
 * Bulk restore / uncheck for checklists (the bonus the user asked for in issue
 * 3928): unchecks every completed item in the checklist that owns `item`, so a
 * "Completed" section can be restored in one action. Returns the number of items
 * that were unchecked. MUST be called inside an `editor.update()` context.
 */
export function $uncheckAllInList(listNode: ListNode): number {
  if (!$isListNode(listNode) || listNode.getListType() !== 'check') {
    return 0
  }
  let count = 0
  for (const child of listNode.getChildren()) {
    if ($isListItemNode(child) && child.getChecked() === true) {
      // Skip wrapper items that only hold a nested list.
      const firstChild = (child as ListItemNode).getFirstChild()
      if (firstChild && $isListNode(firstChild)) {
        continue
      }
      child.setChecked(false)
      count++
    }
  }
  return count
}

/** Resolve the checklist ListNode that owns a given list item, if any. */
export function $getOwningCheckList(node: LexicalNode | null): ListNode | null {
  if (!node) {
    return null
  }
  const candidate = $isListItemNode(node) ? node.getParent() : node
  if ($isListNode(candidate) && candidate.getListType() === 'check') {
    return candidate
  }
  return null
}
