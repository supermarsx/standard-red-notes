import { normalizeChecklistDueAt } from '../SuperEditor/Checklist/checklistDueDate'
import { normalizeChecklistRecurrence, type ChecklistRecurrence } from '../SuperEditor/Checklist/checklistRecurrence'
import {
  CHECKLIST_DUE_AT_STATE_KEY,
  CHECKLIST_RECURRENCE_STATE_KEY,
  CHECKLIST_SCHEDULE_STATE_KEY,
  CHECKLIST_TODO_ID_STATE_KEY,
  CHECKLIST_SCHEDULE_VERSION,
  normalizeChecklistSchedule,
  normalizeChecklistTodoId,
  type ChecklistSchedule,
} from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'

const MAX_TREE_DEPTH = 128
const MAX_TREE_NODES = 50_000
const MAX_TODOS = 10_000
const MAX_LABEL_LENGTH = 16_384

export type SuperChecklistTodo = {
  id: string
  todoId?: string
  locator: string
  text: string
  checked: boolean
  dueAt?: string
  recurrence?: ChecklistRecurrence
}

export type SuperChecklistTodoTarget = Pick<
  SuperChecklistTodo,
  'todoId' | 'locator' | 'text' | 'checked' | 'dueAt' | 'recurrence'
>

export type SuperChecklistTodoPatch = {
  checked?: boolean
  dueAt?: string | null
  recurrence?: ChecklistRecurrence | null
  ensureTodoId?: string
}

type SerializedNode = {
  type?: unknown
  listType?: unknown
  checked?: unknown
  text?: unknown
  todoId?: unknown
  dueAt?: unknown
  recurrence?: unknown
  $?: unknown
  children?: unknown
}

type TodoCandidate = SuperChecklistTodo
type TraversalBudget = { remaining: number }

function nodeState(node: SerializedNode): Record<string, unknown> | undefined {
  return node.$ && typeof node.$ === 'object' && !Array.isArray(node.$)
    ? (node.$ as Record<string, unknown>)
    : undefined
}

function todoIdForNode(node: SerializedNode): string | undefined {
  return normalizeChecklistTodoId(nodeState(node)?.[CHECKLIST_TODO_ID_STATE_KEY] ?? node.todoId)
}

function scheduleForNode(node: SerializedNode): ChecklistSchedule | undefined {
  const state = nodeState(node)
  if (state && Object.prototype.hasOwnProperty.call(state, CHECKLIST_SCHEDULE_STATE_KEY)) {
    // A present atomic envelope is authoritative. Unknown/malformed versions
    // fail closed instead of resurrecting stale split-key values.
    return normalizeChecklistSchedule(state[CHECKLIST_SCHEDULE_STATE_KEY])
  }
  const dueAt = normalizeChecklistDueAt(state?.[CHECKLIST_DUE_AT_STATE_KEY] ?? node.dueAt)
  if (!dueAt) {
    return undefined
  }
  const recurrence = normalizeChecklistRecurrence(state?.[CHECKLIST_RECURRENCE_STATE_KEY] ?? node.recurrence)
  return {
    version: CHECKLIST_SCHEDULE_VERSION,
    dueAt,
    ...(recurrence ? { recurrence } : {}),
  }
}

function collectText(node: SerializedNode, budget: TraversalBudget): string {
  const pieces: string[] = []
  let length = 0
  const stack: Array<{ value: unknown; depth: number }> = []
  if (Array.isArray(node.children)) {
    for (let index = Math.min(node.children.length, budget.remaining) - 1; index >= 0; index -= 1) {
      stack.push({ value: node.children[index], depth: 0 })
    }
  }

  while (stack.length > 0 && budget.remaining > 0 && length < MAX_LABEL_LENGTH) {
    const current = stack.pop()
    if (!current || current.depth > MAX_TREE_DEPTH || !current.value || typeof current.value !== 'object') {
      continue
    }
    budget.remaining -= 1
    const record = current.value as SerializedNode
    if (record.type === 'list') {
      // Nested lists are traversed separately as their own todo rows. Including
      // them here would concatenate child labels into the parent and turn
      // Lexical's wrapper-only listitems into phantom tasks.
      continue
    }
    if (typeof record.text === 'string' && record.text.length > 0) {
      const remaining = MAX_LABEL_LENGTH - length
      const piece = record.text.slice(0, remaining)
      pieces.push(piece)
      length += piece.length
    }
    if (Array.isArray(record.children)) {
      for (let index = Math.min(record.children.length, budget.remaining) - 1; index >= 0; index -= 1) {
        stack.push({ value: record.children[index], depth: current.depth + 1 })
      }
    }
  }
  return pieces.join('').trim()
}

function parseDocument(noteText: string): unknown | undefined {
  if (!noteText) {
    return undefined
  }
  try {
    return JSON.parse(noteText) as unknown
  } catch {
    return undefined
  }
}

function collectCandidates(parsed: unknown): TodoCandidate[] {
  const root = (parsed as { root?: unknown })?.root ?? parsed
  const stack: Array<{ value: unknown; path: number[]; depth: number }> = [{ value: root, path: [], depth: 0 }]
  const candidates: TodoCandidate[] = []
  const budget: TraversalBudget = { remaining: MAX_TREE_NODES }

  while (stack.length > 0 && budget.remaining > 0 && candidates.length < MAX_TODOS) {
    const current = stack.pop()
    if (!current || current.depth > MAX_TREE_DEPTH || !current.value || typeof current.value !== 'object') {
      continue
    }
    budget.remaining -= 1
    const record = current.value as SerializedNode
    const children = Array.isArray(record.children) ? record.children : []

    if (record.type === 'list' && record.listType === 'check') {
      for (
        let index = 0;
        index < children.length && candidates.length < MAX_TODOS && budget.remaining > 0;
        index += 1
      ) {
        budget.remaining -= 1
        const child = children[index]
        if (
          !child ||
          typeof child !== 'object' ||
          ((child as SerializedNode).type !== 'listitem' && (child as SerializedNode).type !== 'checklist-item')
        ) {
          continue
        }
        const item = child as SerializedNode
        const text = collectText(item, budget)
        const itemPath = [...current.path, index]
        const todoId = todoIdForNode(item)
        const locator = itemPath.join('.')
        const schedule = scheduleForNode(item)
        candidates.push({
          id: todoId ?? `legacy-${locator}`,
          todoId,
          locator,
          text,
          checked: item.checked === true,
          dueAt: schedule?.dueAt,
          recurrence: schedule?.recurrence,
        })

        // A task can own nested checklists. Traverse only nested list children,
        // not ordinary text descendants already consumed as its label.
        const itemChildren = Array.isArray(item.children) ? item.children : []
        for (let childIndex = itemChildren.length - 1; childIndex >= 0; childIndex -= 1) {
          const nested = itemChildren[childIndex]
          if (nested && typeof nested === 'object' && (nested as SerializedNode).type === 'list') {
            stack.push({
              value: nested,
              path: [...itemPath, childIndex],
              depth: current.depth + 1,
            })
          }
        }
      }
      continue
    }

    for (let index = Math.min(children.length, budget.remaining) - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], path: [...current.path, index], depth: current.depth + 1 })
    }
  }
  return candidates
}

function compareDocumentLocators(first: TodoCandidate, second: TodoCandidate): number {
  const firstPath = first.locator.split('.').map(Number)
  const secondPath = second.locator.split('.').map(Number)
  for (let index = 0; index < Math.min(firstPath.length, secondPath.length); index += 1) {
    if (firstPath[index] !== secondPath[index]) {
      return firstPath[index] - secondPath[index]
    }
  }
  return firstPath.length - secondPath.length
}

/** Pure, bounded extraction from persisted Lexical JSON. */
export function parseSuperChecklistDocument(noteText: string): SuperChecklistTodo[] {
  const parsed = parseDocument(noteText)
  if (!parsed) {
    return []
  }
  const candidates = collectCandidates(parsed)
    .filter((candidate) => candidate.text.length > 0)
    .sort(compareDocumentLocators)
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    if (candidate.todoId) {
      counts.set(candidate.todoId, (counts.get(candidate.todoId) ?? 0) + 1)
    }
  }
  return candidates.map((candidate) => {
    if (candidate.todoId && counts.get(candidate.todoId) !== 1) {
      return {
        ...candidate,
        id: `legacy-${candidate.locator}`,
        todoId: undefined,
      }
    }
    return candidate
  })
}
