/**
 * Standard Red Notes: bulk completion actions for Super-editor checklists.
 *
 * Three user-facing actions are built on this module (see the Checklist group in
 * ToolbarPlugin):
 *   1. Mark ALL items in the checklist(s) the selection touches as completed.
 *   2. Mark the SELECTED checklist items as completed.
 *   3. Mark the SELECTED checklist items as NOT completed.
 *
 * Semantics decided here (and asserted by ChecklistBulkCompletion.spec.ts):
 *
 * - "Selected items" means every checkable checklist row the Lexical selection
 *   *touches*. A partial selection of a row's text still selects that whole row
 *   — a task cannot be half-completed. A collapsed caret selects exactly the one
 *   row it sits in, mirroring how clicking the checkbox behaves.
 * - Non-checklist content in the selection is simply ignored: paragraphs,
 *   bulleted/numbered lists, tables and so on contribute nothing and never
 *   throw. A selection with no checklist rows at all is a no-op returning 0.
 * - "Wrapper" list items (those whose only child is a nested list, which Lexical
 *   uses to represent indentation) are structure, not tasks, and are skipped.
 *   `$isChecklistItemNode` already encodes that rule; we never re-derive it.
 * - "Mark all" resolves each checklist that owns a touched row and completes
 *   every checkable row in it, INCLUDING rows in nested sub-checklists — a
 *   nested sub-task reads as part of the same list to the user, so leaving it
 *   open would make "mark all" look broken.
 *
 * Every mutation goes through `$setChecklistItemChecked`, the canonical
 * completion mutation, so a recurring row advances to its next occurrence
 * (and stays open) exactly as it does when its checkbox is clicked, rather than
 * being silently force-checked. All functions MUST be called inside an
 * `editor.update()` context; a single call therefore lands as ONE history entry,
 * i.e. one undo step for the whole bulk change.
 */
import { $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { BaseSelection, LexicalNode } from 'lexical'
import { $isChecklistItemNode } from '../Lexical/Nodes/ChecklistItemNode'
import { $setChecklistItemChecked } from './ChecklistEditorMutations'

/** Walk up from `node` (inclusive) to the nearest checkable checklist row. */
function $nearestChecklistItem(node: LexicalNode | null): ListItemNode | null {
  let current: LexicalNode | null = node
  while (current) {
    if ($isChecklistItemNode(current)) {
      return current
    }
    current = current.getParent()
  }
  return null
}

/** Every checkable row inside `listNode`, descending into nested checklists. */
function $checkableItemsInList(listNode: ListNode): ListItemNode[] {
  const items: ListItemNode[] = []
  for (const child of listNode.getChildren()) {
    if ($isChecklistItemNode(child)) {
      items.push(child)
      continue
    }
    // Otherwise this is a "wrapper" item whose only child is a nested list
    // (Lexical's representation of indentation). Recurse into it so nested
    // sub-tasks count as part of "all items in this checklist".
    if ($isListItemNode(child)) {
      const nested = child.getFirstChild()
      if ($isListNode(nested) && nested.getListType() === 'check') {
        items.push(...$checkableItemsInList(nested))
      }
    }
  }
  return items
}

/** Dedupe by node key while preserving the given (document) order. */
function dedupeByKey<T extends LexicalNode>(nodes: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const node of nodes) {
    const key = node.getKey()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(node)
    }
  }
  return result
}

/**
 * The checklist rows the selection touches, in document order. Returns [] for a
 * null selection or a selection that contains no checklist rows.
 */
export function $getSelectedChecklistItems(selection: BaseSelection | null): ListItemNode[] {
  if (!selection) {
    return []
  }
  const items: ListItemNode[] = []
  for (const node of selection.getNodes()) {
    // A whole checklist caught in the range contributes all of its own rows.
    if ($isListNode(node) && node.getListType() === 'check') {
      items.push(...$checkableItemsInList(node))
      continue
    }
    const item = $nearestChecklistItem(node)
    if (item) {
      items.push(item)
    }
  }
  return dedupeByKey(items)
}

/**
 * The distinct checklists owning the rows the selection touches, in document
 * order of their first touched row.
 */
export function $getSelectedCheckLists(selection: BaseSelection | null): ListNode[] {
  const lists: ListNode[] = []
  for (const item of $getSelectedChecklistItems(selection)) {
    const parent = item.getParent()
    if ($isListNode(parent) && parent.getListType() === 'check') {
      lists.push(parent)
    }
  }
  return dedupeByKey(lists)
}

/** True when the selection touches at least one checkable checklist row. */
export function $selectionHasChecklistItems(selection: BaseSelection | null): boolean {
  return $getSelectedChecklistItems(selection).length > 0
}

/**
 * Apply `checked` to each given row. Returns how many rows actually changed, so
 * a caller can skip follow-up work (e.g. auto-move reordering) when nothing did.
 */
export function $setCheckedForItems(items: ListItemNode[], checked: boolean, now = Date.now()): number {
  let changed = 0
  for (const item of items) {
    if ($setChecklistItemChecked(item, checked, now)) {
      changed++
    }
  }
  return changed
}

/** Action 2 & 3: complete / reopen exactly the rows the selection touches. */
export function $setCheckedForSelection(selection: BaseSelection | null, checked: boolean, now = Date.now()): number {
  return $setCheckedForItems($getSelectedChecklistItems(selection), checked, now)
}

/**
 * Action 1: complete (or reopen) EVERY row of every checklist the selection
 * touches, regardless of how much of each list was actually selected.
 */
export function $setCheckedForAllInSelectedLists(
  selection: BaseSelection | null,
  checked: boolean,
  now = Date.now(),
): number {
  const items = dedupeByKey($getSelectedCheckLists(selection).flatMap((list) => $checkableItemsInList(list)))
  return $setCheckedForItems(items, checked, now)
}
