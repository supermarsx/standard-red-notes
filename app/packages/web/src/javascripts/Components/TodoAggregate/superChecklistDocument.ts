import { normalizeChecklistDueAt } from '../SuperEditor/Checklist/checklistDueDate'
import { normalizeChecklistRecurrence, type ChecklistRecurrence } from '../SuperEditor/Checklist/checklistRecurrence'
import {
  CHECKLIST_DUE_AT_STATE_KEY,
  CHECKLIST_OCCURRENCE_SUMMARY_STATE_KEY,
  CHECKLIST_RECURRENCE_STATE_KEY,
  CHECKLIST_SCHEDULE_STATE_KEY,
  CHECKLIST_TODO_ID_STATE_KEY,
  CHECKLIST_SCHEDULE_VERSION,
  normalizeChecklistOccurrenceSummary,
  normalizeChecklistSchedule,
  normalizeChecklistTodoId,
  type ChecklistOccurrenceSummaryState,
  type ChecklistSchedule,
} from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
import { DEFAULT_TODO_HIERARCHY_OPTIONS, scanTodoHeadingSections, type TodoHierarchyOptions } from './todoHierarchy'

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
  /**
   * Where this row sits in the document's structure: the depth contributed by
   * the enclosing heading sections plus its own checklist nesting. 0 for a
   * top-level task outside every section, 1 for a task under an `h1` or a
   * subtask of a top-level task, and so on. A checklist can nest as deep as
   * {@link MAX_TREE_DEPTH}; this reports the real depth and leaves any display
   * ceiling to the view.
   */
  depth: number
  /**
   * The depth contributed by the enclosing heading sections ALONE — the floor a
   * row keeps even when its own parent row is absent. See {@link todoRowDepth}.
   */
  sectionDepth?: number
  /** Locator of the task or heading section this one sits under, absent at the top. */
  parentLocator?: string
  /**
   * 1..6 on a heading section row and absent on every task. A heading section is
   * context, not work: it is never counted, never selectable, and never a match in
   * its own right.
   */
  headingLevel?: number
  /**
   * The first run of paragraphs immediately after a heading. Present only on a
   * heading section row, and only while the description setting is on. ABSENT, not
   * empty, when the section has no text under it — a row renders no description
   * line at all rather than a placeholder.
   */
  description?: string
  /**
   * The occurrence-summary record a capped generation pass left behind, read
   * straight out of the serialized node state. Present only on that record row.
   */
  occurrenceSummary?: ChecklistOccurrenceSummaryState
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
  tag?: unknown
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

function occurrenceSummaryForNode(node: SerializedNode): ChecklistOccurrenceSummaryState | undefined {
  return normalizeChecklistOccurrenceSummary(nodeState(node)?.[CHECKLIST_OCCURRENCE_SUMMARY_STATE_KEY])
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

/**
 * One frame of the traversal.
 *
 * `depth` bounds traversal of the whole tree; `level` counts only CHECKLIST
 * nesting, which is what a task's own indentation means. A checklist wrapped in a
 * quote or a table is deeper in the tree without being a deeper task.
 *
 * `sectionLocator`/`sectionDepth` carry the enclosing HEADING section: its row's
 * locator, and the base depth every task inside it starts from. The base is the
 * heading's level, so a task under `## Phase 1` starts at 2 and its own subtask
 * lands at 3 — section base plus checklist nesting.
 */
type TraversalFrame = {
  value: unknown
  path: number[]
  depth: number
  level: number
  parentLocator?: string
  sectionLocator?: string
  sectionDepth: number
}

function collectCandidates(parsed: unknown, options: TodoHierarchyOptions): TodoCandidate[] {
  const root = (parsed as { root?: unknown })?.root ?? parsed
  const stack: TraversalFrame[] = [{ value: root, path: [], depth: 0, level: 0, sectionDepth: 0 }]
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
        const occurrenceSummary = occurrenceSummaryForNode(item)
        candidates.push({
          id: todoId ?? `legacy-${locator}`,
          todoId,
          locator,
          text,
          checked: item.checked === true,
          dueAt: schedule?.dueAt,
          recurrence: schedule?.recurrence,
          // Section base plus checklist nesting: the two sources of structure
          // compose rather than one overriding the other.
          depth: current.sectionDepth + current.level,
          sectionDepth: current.sectionDepth,
          // A nested task belongs to its parent TASK; a top-level task in a
          // section belongs to the heading that opened it.
          parentLocator: current.parentLocator ?? current.sectionLocator,
          ...(occurrenceSummary ? { occurrenceSummary } : {}),
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
              level: current.level + 1,
              parentLocator: locator,
              sectionLocator: current.sectionLocator,
              sectionDepth: current.sectionDepth,
            })
          }
        }
      }
      continue
    }

    // Headings in THIS container open sections over the siblings that follow
    // them. Resolved in one forward pass before the children are pushed, so a
    // section's own row exists before anything can point at it.
    const scan = scanTodoHeadingSections(children, (node) => collectText(node as SerializedNode, budget), options)
    const sections = new Map<number, { locator: string; depth: number; level: number }>()
    for (const section of scan.headings.values()) {
      if (candidates.length >= MAX_TODOS || budget.remaining <= 0) {
        break
      }
      const locator = [...current.path, section.index].join('.')
      const enclosingIndex = scan.enclosing.get(section.index)
      const enclosing = enclosingIndex === undefined ? undefined : sections.get(enclosingIndex)
      // A heading renders one level ABOVE the tasks it owns, so `# Project` sits
      // at the top and the tasks under it are the first indent.
      const depth = section.level - 1
      candidates.push({
        id: `heading-${locator}`,
        locator,
        text: section.text,
        checked: false,
        depth,
        sectionDepth: depth,
        parentLocator: enclosing?.locator ?? current.sectionLocator,
        headingLevel: section.level,
        ...(section.description ? { description: section.description } : {}),
      })
      sections.set(section.index, { locator, depth, level: section.level })
    }

    for (let index = Math.min(children.length, budget.remaining) - 1; index >= 0; index -= 1) {
      // Non-checklist containers do not add a task level, so the level and the
      // nearest enclosing task carry through unchanged. The SECTION, however, is
      // whichever heading of this container encloses the child, falling back to
      // the one enclosing the container itself.
      const enclosingIndex = scan.enclosing.get(index)
      // A section whose own row could not be emitted (the todo cap, the traversal
      // budget) falls back to the inherited one rather than claiming a depth for a
      // heading that will not be on screen.
      const section = enclosingIndex === undefined ? undefined : sections.get(enclosingIndex)
      stack.push({
        value: children[index],
        path: [...current.path, index],
        depth: current.depth + 1,
        level: current.level,
        parentLocator: current.parentLocator,
        sectionLocator: section?.locator ?? current.sectionLocator,
        sectionDepth: section ? section.level : current.sectionDepth,
      })
    }
  }
  return candidates
}

/**
 * Drop heading sections that own no row.
 *
 * Without this, every Super note holding a heading and no checklist would appear
 * in the Todos view as a page of section headers with nothing under them, and the
 * aggregate would stop being a list of work. A section is kept only when some
 * row actually sits inside it; pruning is closed under nesting, because the
 * ancestors of a kept section are ancestors of its rows too.
 */
function pruneEmptyHeadingSections(candidates: TodoCandidate[]): TodoCandidate[] {
  if (!candidates.some((candidate) => candidate.headingLevel !== undefined)) {
    return candidates
  }
  const byLocator = new Map(candidates.map((candidate) => [candidate.locator, candidate]))
  const owning = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.headingLevel !== undefined) {
      continue
    }
    let parentLocator = candidate.parentLocator
    // Bounded by the candidate count: a cycle cannot outlast visiting each once.
    let guard = candidates.length
    while (parentLocator !== undefined && !owning.has(parentLocator) && guard > 0) {
      const parent = byLocator.get(parentLocator)
      if (!parent) {
        break
      }
      if (parent.headingLevel !== undefined) {
        owning.add(parentLocator)
      }
      parentLocator = parent.parentLocator
      guard -= 1
    }
  }
  return candidates.filter((candidate) => candidate.headingLevel === undefined || owning.has(candidate.locator))
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
export function parseSuperChecklistDocument(
  noteText: string,
  options: TodoHierarchyOptions = DEFAULT_TODO_HIERARCHY_OPTIONS,
): SuperChecklistTodo[] {
  const parsed = parseDocument(noteText)
  if (!parsed) {
    return []
  }
  const candidates = pruneEmptyHeadingSections(
    collectCandidates(parsed, options)
      // An occurrence-summary record survives an empty label: its words are
      // rendered from the record itself, so dropping the row for having no text
      // would hide a fact the document is holding.
      .filter((candidate) => candidate.text.length > 0 || candidate.occurrenceSummary !== undefined),
  ).sort(compareDocumentLocators)
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
