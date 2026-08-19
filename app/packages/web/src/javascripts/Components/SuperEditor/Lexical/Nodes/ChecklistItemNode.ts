import { $isListItemNode, $isListNode, ListItemNode } from '@lexical/list'
import { $getRoot, $getState, $isElementNode, $isTextNode, $setState, createState, LexicalNode } from 'lexical'
import { normalizeChecklistDueAt } from '../../Checklist/checklistDueDate'
import {
  checklistRecurrencesEqual,
  normalizeChecklistRecurrence,
  propagatedChecklistDescendantSchedule,
  type ChecklistRecurrence,
} from '../../Checklist/checklistRecurrence'

export const CHECKLIST_TODO_ID_STATE_KEY = 'srnChecklistTodoId'
export const CHECKLIST_SCHEDULE_STATE_KEY = 'srnChecklistSchedule'
export const CHECKLIST_DUE_AT_STATE_KEY = 'srnChecklistDueAt'
export const CHECKLIST_RECURRENCE_STATE_KEY = 'srnChecklistRecurrence'
export const CHECKLIST_SCHEDULE_VERSION = 1

export type ChecklistSchedule = {
  version: typeof CHECKLIST_SCHEDULE_VERSION
  dueAt: string
  recurrence?: ChecklistRecurrence
}

type ClearedChecklistSchedule = {
  version: typeof CHECKLIST_SCHEDULE_VERSION
  cleared: true
}

type ChecklistScheduleEnvelope = ChecklistSchedule | ClearedChecklistSchedule

const INVALID_CHECKLIST_SCHEDULE = Symbol('invalid-checklist-schedule')
type InvalidChecklistScheduleState = {
  readonly kind: typeof INVALID_CHECKLIST_SCHEDULE
  readonly raw: unknown
}
type ChecklistScheduleState = ChecklistScheduleEnvelope | InvalidChecklistScheduleState | undefined

function isInvalidChecklistScheduleState(value: ChecklistScheduleState): value is InvalidChecklistScheduleState {
  return Boolean(value && 'kind' in value && value.kind === INVALID_CHECKLIST_SCHEDULE)
}

function isClearedChecklistSchedule(value: ChecklistScheduleState): value is ClearedChecklistSchedule {
  return Boolean(value && 'cleared' in value && value.cleared === true)
}

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

function normalizeChecklistScheduleEnvelope(value: unknown): ChecklistScheduleEnvelope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const schedule = value as Record<string, unknown>
  if (schedule.version !== CHECKLIST_SCHEDULE_VERSION) {
    return undefined
  }
  if (schedule.cleared === true) {
    return { version: CHECKLIST_SCHEDULE_VERSION, cleared: true }
  }
  const dueAt = normalizeChecklistDueAt(schedule.dueAt)
  if (!dueAt) {
    return undefined
  }
  const recurrence = normalizeChecklistRecurrence(schedule.recurrence)
  if (schedule.recurrence !== undefined && !recurrence) {
    return undefined
  }
  return {
    version: CHECKLIST_SCHEDULE_VERSION,
    dueAt,
    ...(recurrence ? { recurrence } : {}),
  }
}

export function normalizeChecklistSchedule(value: unknown): ChecklistSchedule | undefined {
  const envelope = normalizeChecklistScheduleEnvelope(value)
  return envelope && !isClearedChecklistSchedule(envelope) ? envelope : undefined
}

const checklistScheduleState = createState(CHECKLIST_SCHEDULE_STATE_KEY, {
  parse: (value): ChecklistScheduleState => {
    if (value === undefined) {
      return undefined
    }
    return normalizeChecklistScheduleEnvelope(value) ?? { kind: INVALID_CHECKLIST_SCHEDULE, raw: value }
  },
  unparse: (value) => (isInvalidChecklistScheduleState(value) ? value.raw : value),
  isEqual: (first, second) =>
    first === second ||
    (!isInvalidChecklistScheduleState(first) &&
      !isInvalidChecklistScheduleState(second) &&
      isClearedChecklistSchedule(first) === isClearedChecklistSchedule(second) &&
      (isClearedChecklistSchedule(first) || isClearedChecklistSchedule(second)
        ? true
        : first?.dueAt === second?.dueAt && checklistRecurrencesEqual(first?.recurrence, second?.recurrence))),
  resetOnCopyNode: true,
})

/** Read-only fallback for notes written before the atomic schedule envelope. */
const legacyChecklistDueAtState = createState(CHECKLIST_DUE_AT_STATE_KEY, {
  parse: normalizeChecklistDueAt,
  resetOnCopyNode: true,
})

/** Read-only fallback for notes written before the atomic schedule envelope. */
const legacyChecklistRecurrenceState = createState(CHECKLIST_RECURRENCE_STATE_KEY, {
  parse: normalizeChecklistRecurrence,
  resetOnCopyNode: true,
})

/**
 * Checklist metadata uses Lexical NodeState on the ordinary ListItemNode. The
 * serialized node therefore remains `type: "listitem"`. NodeState-capable
 * clients preserve the metadata and Yjs syncs it natively; older clients keep
 * task text/list structure but may discard optional scheduling when re-saving.
 * The due instant and recurrence rule live in one versioned state value so
 * Yjs resolves concurrent schedule writes as a whole authored pair rather
 * than independently merging fields. Split due/recurrence keys are accepted
 * only as a migration fallback. IDs and schedules reset on copied rows so a
 * copy becomes a distinct task rather than a second instance of the same
 * schedule.
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

function $getAtomicChecklistScheduleState(item: ListItemNode): ChecklistScheduleState {
  return $getState(item, checklistScheduleState)
}

export function $getChecklistSchedule(item: ListItemNode): ChecklistSchedule | undefined {
  const atomic = $getAtomicChecklistScheduleState(item)
  if (isInvalidChecklistScheduleState(atomic)) {
    // A present but malformed/unknown-version envelope must not resurrect
    // stale split fields left behind by a previous migration.
    return undefined
  }
  if (atomic) {
    if (isClearedChecklistSchedule(atomic)) {
      return undefined
    }
    return atomic
  }
  const dueAt = $getState(item, legacyChecklistDueAtState)
  if (!dueAt) {
    return undefined
  }
  const recurrence = $getState(item, legacyChecklistRecurrenceState)
  return {
    version: CHECKLIST_SCHEDULE_VERSION,
    dueAt,
    ...(recurrence ? { recurrence } : {}),
  }
}

export function $getChecklistDueAt(item: ListItemNode): string | undefined {
  return $getChecklistSchedule(item)?.dueAt
}

export function $setChecklistSchedule(
  item: ListItemNode,
  dueAtValue: unknown,
  recurrenceValue?: unknown,
): ChecklistSchedule | undefined {
  const dueAt = normalizeChecklistDueAt(dueAtValue)
  const recurrence = dueAt ? normalizeChecklistRecurrence(recurrenceValue) : undefined
  const schedule: ChecklistSchedule | undefined = dueAt
    ? {
        version: CHECKLIST_SCHEDULE_VERSION,
        dueAt,
        ...(recurrence ? { recurrence } : {}),
      }
    : undefined
  const envelope: ChecklistScheduleEnvelope = schedule ?? {
    version: CHECKLIST_SCHEDULE_VERSION,
    cleared: true,
  }
  const current = $getAtomicChecklistScheduleState(item)
  if (
    isInvalidChecklistScheduleState(current) ||
    !current ||
    isClearedChecklistSchedule(current) !== isClearedChecklistSchedule(envelope) ||
    (!isClearedChecklistSchedule(current) &&
      !isClearedChecklistSchedule(envelope) &&
      (current.dueAt !== envelope.dueAt || !checklistRecurrencesEqual(current.recurrence, envelope.recurrence)))
  ) {
    $setState(item, checklistScheduleState, envelope)
  }
  // The split keys are never mirrored. Keeping them writable would re-open
  // the field-wise Yjs merge that the envelope prevents.
  $setState(item, legacyChecklistDueAtState, undefined)
  $setState(item, legacyChecklistRecurrenceState, undefined)
  if (schedule?.recurrence) {
    $activateChecklistRecurringSchedule(item)
  }
  return schedule
}

export function $setChecklistDueAt(item: ListItemNode, value: unknown): string | undefined {
  const dueAt = normalizeChecklistDueAt(value)
  return $setChecklistSchedule(item, dueAt, dueAt ? $getChecklistRecurrence(item) : undefined)?.dueAt
}

export function $getChecklistRecurrence(item: ListItemNode): ChecklistRecurrence | undefined {
  return $getChecklistSchedule(item)?.recurrence
}

export function $setChecklistRecurrence(item: ListItemNode, value: unknown): ChecklistRecurrence | undefined {
  const dueAt = $getChecklistDueAt(item)
  return $setChecklistSchedule(item, dueAt, dueAt ? value : undefined)?.recurrence
}

/** A recurring schedule always represents its next active (unchecked) occurrence. */
export function $activateChecklistRecurringSchedule(item: ListItemNode): boolean {
  if ($getChecklistRecurrence(item) && item.getChecked()) {
    item.setChecked(false)
    return true
  }
  return false
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

/** Matches the persisted parser's bounds so live and saved traversals agree. */
export const CHECKLIST_MAX_NESTING_DEPTH = 128
export const CHECKLIST_MAX_DESCENDANT_NODES = 50_000

/**
 * Every nested task beneath `item`, in document order.
 *
 * The walk is iterative and bounded: nesting reaches 128 levels in the parser,
 * and a recursive descent over a document that deep has already been shown to
 * exhaust the stack elsewhere in this editor.
 */
export function $getChecklistDescendantItems(
  item: ListItemNode,
  maxDepth = CHECKLIST_MAX_NESTING_DEPTH,
): ListItemNode[] {
  const descendants: ListItemNode[] = []
  const visited = new Set<string>([item.getKey()])
  const stack: Array<{ node: LexicalNode; depth: number }> = []

  const pushNestedLists = (parent: ListItemNode, depth: number): void => {
    if (depth > maxDepth) {
      return
    }
    const children = parent.getChildren()
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if ($isListNode(child)) {
        stack.push({ node: child, depth })
      }
    }
  }

  pushNestedLists(item, 1)
  let budget = CHECKLIST_MAX_DESCENDANT_NODES
  while (stack.length > 0 && budget > 0) {
    budget -= 1
    const current = stack.pop()
    if (!current || current.depth > maxDepth || visited.has(current.node.getKey())) {
      continue
    }
    visited.add(current.node.getKey())
    if ($isListNode(current.node)) {
      const rows = current.node.getChildren()
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        stack.push({ node: rows[index], depth: current.depth })
      }
      continue
    }
    if (!$isListItemNode(current.node)) {
      continue
    }
    const row = current.node
    if ($isChecklistItemNode(row)) {
      descendants.push(row)
    }
    // Indentation wrappers hold no task of their own but still carry the
    // nested list underneath them, so both kinds of row are descended.
    pushNestedLists(row, current.depth + 1)
  }
  return descendants
}

/**
 * Reproduce a recurring task's subtasks for the occurrence it just rolled
 * forward to: each nested task reopens and moves onto the new cycle.
 *
 * Every descendant is resolved against the ancestor's single new occurrence
 * rather than rolled level by level, so a grandchild advances exactly once.
 * Schedules are resolved for the whole subtree before any of them is written,
 * and the caller's `editor.update` makes the result one atomic step: a subtree
 * is never left half advanced, and undo restores all of it at once.
 */
export function $propagateChecklistRecurrenceToDescendants(
  item: ListItemNode,
  nextDueAt: unknown,
  recurrence: unknown,
  completedAt = Date.now(),
  maxDepth = CHECKLIST_MAX_NESTING_DEPTH,
): number {
  const dueAt = normalizeChecklistDueAt(nextDueAt)
  const rule = normalizeChecklistRecurrence(recurrence)
  if (!dueAt || !rule) {
    return 0
  }

  const descendants = $getChecklistDescendantItems(item, maxDepth)
  const resolved = descendants.map((descendant) => ({
    descendant,
    schedule: propagatedChecklistDescendantSchedule(
      dueAt,
      rule,
      { dueAt: $getChecklistDueAt(descendant), recurrence: $getChecklistRecurrence(descendant) },
      completedAt,
    ),
  }))

  let changed = 0
  for (const { descendant, schedule } of resolved) {
    let touched = false
    if (descendant.getChecked()) {
      descendant.setChecked(false)
      touched = true
    }
    if (
      schedule &&
      ($getChecklistDueAt(descendant) !== schedule.dueAt ||
        !checklistRecurrencesEqual($getChecklistRecurrence(descendant), schedule.recurrence))
    ) {
      $setChecklistSchedule(descendant, schedule.dueAt, schedule.recurrence)
      touched = true
    }
    if (touched) {
      changed += 1
    }
  }
  return changed
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

function $normalizeChecklistScheduleMetadata(item: ListItemNode): boolean {
  const atomic = $getAtomicChecklistScheduleState(item)
  const legacyDueAt = $getState(item, legacyChecklistDueAtState)
  const legacyRecurrence = $getState(item, legacyChecklistRecurrenceState)

  if (isInvalidChecklistScheduleState(atomic)) {
    // Preserve unknown future versions byte-for-byte so merely opening a note
    // cannot destroy data written by a newer client. They still take
    // precedence (and fail closed) over any stale split-key fallback.
    if (legacyDueAt || legacyRecurrence) {
      $setState(item, legacyChecklistDueAtState, undefined)
      $setState(item, legacyChecklistRecurrenceState, undefined)
      return true
    }
    return false
  }
  if (atomic) {
    if (legacyDueAt || legacyRecurrence) {
      $setState(item, legacyChecklistDueAtState, undefined)
      $setState(item, legacyChecklistRecurrenceState, undefined)
      return true
    }
    return false
  }
  if (legacyDueAt) {
    $setChecklistSchedule(item, legacyDueAt, legacyRecurrence)
    return true
  }
  if (legacyRecurrence) {
    // A recurrence without a valid deadline can never identify an occurrence.
    $setState(item, legacyChecklistRecurrenceState, undefined)
    return true
  }
  return false
}

/** Assign missing IDs, repair duplicates, and canonicalize legacy schedules. */
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
    if ($normalizeChecklistScheduleMetadata(item)) {
      changed += 1
    }
    if ($activateChecklistRecurringSchedule(item)) {
      changed += 1
    }
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
