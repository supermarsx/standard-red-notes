import { $isListItemNode, $isListNode, ListItemNode } from '@lexical/list'
import { $getRoot, $getState, $isElementNode, $isTextNode, $setState, createState, LexicalNode } from 'lexical'
import { normalizeChecklistDueAt } from '../../Checklist/checklistDueDate'

export const CHECKLIST_TODO_ID_STATE_KEY = 'srnChecklistTodoId'
export const CHECKLIST_DUE_AT_STATE_KEY = 'srnChecklistDueAt'

export function createChecklistTodoId(cryptoObject: Crypto | undefined = globalThis.crypto): string {
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `todo-${cryptoObject.randomUUID()}`
  }
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
    return `todo-${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
      .slice(8, 10)
      .join('')}-${hex.slice(10).join('')}`
  }
  throw new Error('Secure random values are required to create a checklist identity.')
}

export function normalizeChecklistTodoId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 8 || value.length > 96) {
    return undefined
  }
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined
}

const checklistTodoIdState = createState(CHECKLIST_TODO_ID_STATE_KEY, {
  parse: normalizeChecklistTodoId,
  resetOnCopyNode: true,
})

const checklistDueAtState = createState(CHECKLIST_DUE_AT_STATE_KEY, {
  parse: normalizeChecklistDueAt,
  resetOnCopyNode: true,
})

/**
 * Checklist metadata uses Lexical NodeState on the ordinary ListItemNode. The
 * serialized node therefore remains `type: "listitem"`. NodeState-capable
 * clients preserve the metadata and Yjs syncs it natively; older clients keep
 * task text/list structure but may discard optional deadlines when re-saving.
 * IDs/deadlines reset on copied rows so a copy becomes a distinct task.
 */
export function $getChecklistTodoId(item: ListItemNode): string | undefined {
  return $getState(item, checklistTodoIdState)
}

export function $setChecklistTodoId(item: ListItemNode, value: unknown): string {
  const todoId = normalizeChecklistTodoId(value) ?? createChecklistTodoId()
  $setState(item, checklistTodoIdState, todoId)
  return todoId
}

export function $ensureChecklistTodoId(item: ListItemNode): string {
  return $getChecklistTodoId(item) ?? $setChecklistTodoId(item, createChecklistTodoId())
}

export function $getChecklistDueAt(item: ListItemNode): string | undefined {
  return $getState(item, checklistDueAtState)
}

export function $setChecklistDueAt(item: ListItemNode, value: unknown): string | undefined {
  const dueAt = normalizeChecklistDueAt(value)
  $setState(item, checklistDueAtState, dueAt)
  return dueAt
}

export function $isChecklistItemNode(node: LexicalNode | null | undefined): node is ListItemNode {
  if (!$isListItemNode(node)) {
    return false
  }
  const parent = node.getParent()
  if (!$isListNode(parent) || parent.getListType() !== 'check') {
    return false
  }
  const children = node.getChildren()
  // Lexical represents indentation with wrapper listitems whose only child is
  // another ListNode. They are structure, not checkable tasks, and must never
  // receive aggregate identity or deadline controls. Empty leaf rows remain
  // task items so metadata can be assigned as soon as the user types.
  return children.length === 0 || children.some((child) => !$isListNode(child))
}

/** Label projection shared with the persisted parser: nested lists are tasks of their own. */
export function $getChecklistItemText(item: ListItemNode): string {
  const pieces: string[] = []
  const stack = [...item.getChildren()].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || $isListNode(node)) {
      continue
    }
    if ($isTextNode(node)) {
      pieces.push(node.getTextContent())
      continue
    }
    if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
  }
  return pieces.join('').trim()
}

/** Assign missing IDs and repair duplicates without changing node types. */
export function $normalizeChecklistItemMetadata(): number {
  const checklistItems: ListItemNode[] = []
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
      checklistItems.push(node)
    }
  }

  let changed = 0
  const seen = new Set<string>()
  for (const item of checklistItems) {
    const existing = $getChecklistTodoId(item)
    if (!existing || seen.has(existing)) {
      const todoId = $setChecklistTodoId(item, createChecklistTodoId())
      seen.add(todoId)
      changed += 1
    } else {
      seen.add(existing)
    }
  }
  return changed
}
