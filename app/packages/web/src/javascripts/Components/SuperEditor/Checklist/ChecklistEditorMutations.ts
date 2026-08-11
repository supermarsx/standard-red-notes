import { ListItemNode } from '@lexical/list'
import { $getRoot, $isElementNode, LexicalNode } from 'lexical'
import type { SuperChecklistTodoPatch, SuperChecklistTodoTarget } from '../../TodoAggregate/superChecklistDocument'
import {
  $isChecklistItemNode,
  $getChecklistItemText,
  $getChecklistDueAt,
  $getChecklistTodoId,
  $normalizeChecklistItemMetadata,
  $setChecklistDueAt,
  $setChecklistTodoId,
  normalizeChecklistTodoId,
} from '../Lexical/Nodes/ChecklistItemNode'
import { normalizeChecklistDueAt } from './checklistDueDate'

export type ChecklistEditorMutationResult = {
  matched: boolean
  changed: boolean
  todoId?: string
}

function $nodeLocator(node: LexicalNode): string {
  const path: number[] = []
  let current: LexicalNode | null = node
  while (current && current.getParent()) {
    path.push(current.getIndexWithinParent())
    current = current.getParent()
  }
  return path.reverse().join('.')
}

export function $getChecklistItems(): ListItemNode[] {
  const items: ListItemNode[] = []
  const stack = [...$getRoot().getChildren()].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) {
      continue
    }
    if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
    if ($isChecklistItemNode(node)) {
      items.push(node)
    }
  }
  return items
}

/** Apply a mutation inside the active Lexical/Yjs owner, failing closed on ambiguity. */
export function $applyChecklistEditorMutation(
  target: SuperChecklistTodoTarget,
  patch: SuperChecklistTodoPatch,
): ChecklistEditorMutationResult {
  const ensuredTodoId = patch.ensureTodoId === undefined ? undefined : normalizeChecklistTodoId(patch.ensureTodoId)
  if (patch.ensureTodoId !== undefined && !ensuredTodoId) {
    return { matched: false, changed: false }
  }
  const normalizedDueAt = typeof patch.dueAt === 'string' ? normalizeChecklistDueAt(patch.dueAt) : undefined
  if (typeof patch.dueAt === 'string' && !normalizedDueAt) {
    return { matched: false, changed: false }
  }

  const items = $getChecklistItems()
  const matches = target.todoId
    ? items.filter((item) => $getChecklistTodoId(item) === target.todoId)
    : items.filter(
        (item) =>
          $nodeLocator(item) === target.locator &&
          $getChecklistItemText(item) === target.text &&
          Boolean(item.getChecked()) === target.checked,
      )
  if (matches.length !== 1) {
    return { matched: false, changed: false }
  }

  const item = matches[0]
  const liveTodoId = $getChecklistTodoId(item)
  if (liveTodoId && items.some((candidate) => candidate !== item && $getChecklistTodoId(candidate) === liveTodoId)) {
    // A normalized identity must itself be unique before a stale legacy row can
    // adopt it. Duplicate third-party IDs are never resolved by document order.
    return { matched: false, changed: false }
  }
  if (target.todoId && ensuredTodoId && liveTodoId !== ensuredTodoId) {
    // An ensure operation may fill a genuinely missing legacy identity, but it
    // must never replace a durable identity selected by an ID-bearing target.
    return { matched: false, changed: false }
  }
  const shouldAssignEnsuredId = !liveTodoId && Boolean(ensuredTodoId)
  if (
    shouldAssignEnsuredId &&
    items.some((candidate) => candidate !== item && $getChecklistTodoId(candidate) === ensuredTodoId)
  ) {
    return { matched: false, changed: false }
  }

  let changed = false
  if (shouldAssignEnsuredId && ensuredTodoId) {
    $setChecklistTodoId(item, ensuredTodoId)
    changed = true
  }
  changed = $normalizeChecklistItemMetadata() > 0 || changed

  if (patch.checked !== undefined && Boolean(item.getChecked()) !== patch.checked) {
    item.setChecked(patch.checked)
    changed = true
  }

  if (patch.dueAt !== undefined) {
    const dueAt = patch.dueAt === null ? undefined : normalizedDueAt
    if ($getChecklistDueAt(item) !== dueAt) {
      $setChecklistDueAt(item, dueAt)
      changed = true
    }
  }

  return { matched: true, changed, todoId: $getChecklistTodoId(item) }
}
