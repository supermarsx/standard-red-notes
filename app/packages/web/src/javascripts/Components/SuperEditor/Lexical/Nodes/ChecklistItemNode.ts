import { $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
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
export const CHECKLIST_OCCURRENCE_SUMMARY_STATE_KEY = 'srnChecklistOccurrenceSummary'
export const CHECKLIST_SCHEDULE_VERSION = 1
export const CHECKLIST_OCCURRENCE_SUMMARY_VERSION = 1

export type ChecklistSchedule = {
  version: typeof CHECKLIST_SCHEDULE_VERSION
  dueAt: string
  recurrence?: ChecklistRecurrence
}

/**
 * Standard Red Notes: the record a generation pass leaves behind for the
 * occurrences its cap could NOT write down.
 *
 * It is a checklist row so the user sees it where the work is, but it is a
 * RECORD, not work: it carries no `dueAt` and no recurrence, which is what makes
 * it structurally incapable of being mistaken for an occurrence —
 * `todoDueBucket` reads `'unscheduled'`, `formatChecklistDue` returns nothing,
 * and `$applyChecklistItemChecked` cannot advance it because advancing requires
 * both a deadline and a rule.
 *
 * The row is identified by THIS STATE KEY and never by its wording: a pass must
 * be able to find and update its own summary rather than appending a second one,
 * and matching on text would break the moment the copy or the locale changes.
 * `sourceTodoId` ties the record to the recurring row it describes, so a document
 * with several recurring tasks gets one summary each rather than one shared.
 */
export type ChecklistOccurrenceSummaryState = {
  version: typeof CHECKLIST_OCCURRENCE_SUMMARY_VERSION
  /** How many occurrences were NOT generated. Always at least 1. */
  missedCount: number
  oldestMissedAt: string
  newestMissedAt: string
  sourceTodoId?: string
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
 * Coerce a stored occurrence-summary record. Every field must be present and
 * resolvable: a half-readable record would claim a count or a date range it
 * cannot support, so anything unresolvable reads as "this row is not a summary"
 * rather than as a summary with holes in it.
 */
export function normalizeChecklistOccurrenceSummary(value: unknown): ChecklistOccurrenceSummaryState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const summary = value as Record<string, unknown>
  if (summary.version !== CHECKLIST_OCCURRENCE_SUMMARY_VERSION) {
    return undefined
  }
  const missedCount = summary.missedCount
  if (typeof missedCount !== 'number' || !Number.isSafeInteger(missedCount) || missedCount < 1) {
    return undefined
  }
  const oldestMissedAt = normalizeChecklistDueAt(summary.oldestMissedAt)
  const newestMissedAt = normalizeChecklistDueAt(summary.newestMissedAt)
  if (!oldestMissedAt || !newestMissedAt || Date.parse(oldestMissedAt) > Date.parse(newestMissedAt)) {
    return undefined
  }
  const sourceTodoId = normalizeChecklistTodoId(summary.sourceTodoId)
  if (summary.sourceTodoId !== undefined && !sourceTodoId) {
    return undefined
  }
  return {
    version: CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
    missedCount,
    oldestMissedAt,
    newestMissedAt,
    ...(sourceTodoId ? { sourceTodoId } : {}),
  }
}

/**
 * Deliberately NOT `resetOnCopyNode`, unlike the identity and schedule states.
 * Those reset so a copied row becomes a distinct TASK; a copied record is not a
 * new task to be done, and dropping the marker would turn the copy into a
 * plain-looking row that then counts towards the progress bar and is swept up by
 * bulk completion. A duplicated record is the safer of the two failures.
 */
const checklistOccurrenceSummaryState = createState(CHECKLIST_OCCURRENCE_SUMMARY_STATE_KEY, {
  parse: normalizeChecklistOccurrenceSummary,
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

export function $getChecklistOccurrenceSummary(item: ListItemNode): ChecklistOccurrenceSummaryState | undefined {
  return $getState(item, checklistOccurrenceSummaryState)
}

/**
 * Mark (or re-mark) a row as the occurrence-summary record for a recurring task.
 *
 * Writing the marker CLEARS any schedule the row carries, because "no `dueAt`,
 * no recurrence" is the property that stops a record from reading as an
 * occurrence. Enforcing it here rather than at each call site means no caller can
 * produce a summary row that looks due.
 *
 * Returns the record actually stored, or `undefined` when the value could not be
 * resolved — in which case nothing is written and the row is left alone, so a
 * failed update can never silently blank an existing record.
 */
export function $setChecklistOccurrenceSummary(
  item: ListItemNode,
  value: unknown,
): ChecklistOccurrenceSummaryState | undefined {
  const summary = normalizeChecklistOccurrenceSummary(value)
  if (!summary) {
    return undefined
  }
  $setState(item, checklistOccurrenceSummaryState, summary)
  if ($getChecklistSchedule(item)) {
    $setChecklistSchedule(item, undefined, undefined)
  }
  return summary
}

/** Stop a row being a summary record, leaving it an ordinary task. */
export function $clearChecklistOccurrenceSummary(item: ListItemNode): boolean {
  if (!$getChecklistOccurrenceSummary(item)) {
    return false
  }
  $setState(item, checklistOccurrenceSummaryState, undefined)
  return true
}

/**
 * True for a row that is an occurrence-summary record.
 *
 * The state key is the ONLY test. Nothing may identify a summary row by its
 * wording: the copy is user-visible prose that changes with locale and with
 * editing, and a text match would start failing silently the first time either
 * moves.
 *
 * Deliberately a plain boolean rather than a `node is ListItemNode` predicate:
 * being a summary is a PROPERTY of a row, not a kind of node, and a type
 * predicate here would narrow a `ListItemNode` to `never` in the negative branch
 * — which is where every caller does its real work.
 */
export function $isChecklistOccurrenceSummaryItem(node: LexicalNode | null | undefined): boolean {
  return $isListItemNode(node) && $getChecklistOccurrenceSummary(node) !== undefined
}

/**
 * The summary record describing `sourceTodoId`, in document order, so a pass
 * updates the row it already wrote instead of appending a second one.
 *
 * Several matches mean the user duplicated the row; the first is updated and the
 * rest are left exactly as they are. Deleting a row the user created is not this
 * function's call to make.
 */
export function $findChecklistOccurrenceSummaryItem(sourceTodoId: string): ListItemNode | undefined {
  const stack = [...$getRoot().getChildren()].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) {
      continue
    }
    if ($isListItemNode(node) && $getChecklistOccurrenceSummary(node)?.sourceTodoId === sourceTodoId) {
      return node
    }
    if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
  }
  return undefined
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
 * True for an INDENT WRAPPER: the text-less `listitem` Lexical creates to carry
 * an indented sub-list.
 *
 * This is the exact structural complement of the wrapper rule inside
 * {@link $isChecklistItemNode} — a `listitem` with children, all of which are
 * `ListNode`s. The two are written against the same condition on purpose: a row
 * is either a task or structure, never both and never neither, so the descendant
 * walk below and the task predicate cannot drift apart.
 *
 * A wrapper is NEVER a task: it is descended through, it is never collected by
 * {@link $getChecklistDescendantItems}, and it never receives identity,
 * deadlines or completion.
 *
 * Deliberately a plain boolean rather than a `node is ListItemNode` predicate,
 * for the same reason as {@link $isChecklistOccurrenceSummaryItem}: being a
 * wrapper is a PROPERTY of a row, so a type predicate would narrow an already
 * known `ListItemNode` to `never` in the negative branch — which is where every
 * caller below does its real work. Callers that start from a `LexicalNode` pair
 * it with `$isListItemNode`.
 */
export function $isChecklistIndentWrapper(node: LexicalNode | null | undefined): boolean {
  if (!$isListItemNode(node)) {
    return false
  }
  const children = node.getChildren()
  return children.length > 0 && children.every((child) => $isListNode(child))
}

/** The sub-lists a row carries directly, in document order. */
function $nestedListsOfRow(row: ListItemNode): ListNode[] {
  const lists: ListNode[] = []
  for (const child of row.getChildren()) {
    if ($isListNode(child)) {
      lists.push(child)
    }
  }
  return lists
}

/**
 * The indent wrappers that belong to `row`: the contiguous run of wrapper
 * siblings immediately following it.
 *
 * THIS IS THE SHAPE LEXICAL ACTUALLY BUILDS. `ListItemNode.setIndent` →
 * `$handleIndent` wraps an indented row in a new `ListNode` inside a new
 * text-less `listitem`, and inserts that wrapper as a SIBLING of the row being
 * indented under — never as its child (verified against @lexical/list 0.47's
 * `formatList.ts` and by rendering a real tree). Markdown import calls the same
 * `setIndent`, and HTML paste's `$normalizeChildren` moves a nested list out of
 * its `<li>` into a wrapper sibling too.
 *
 * The run is contiguous and stops at the first non-wrapper row, because that row
 * is the next task at this level and owns whatever follows it. A wrapper carries
 * only its own sub-lists and claims no run of its own, which is what keeps a
 * sub-list from being reached twice.
 */
function $indentWrappersOwnedBy(row: ListItemNode): ListItemNode[] {
  if ($isChecklistIndentWrapper(row)) {
    return []
  }
  const wrappers: ListItemNode[] = []
  let sibling = row.getNextSibling()
  while ($isListItemNode(sibling) && $isChecklistIndentWrapper(sibling)) {
    wrappers.push(sibling)
    sibling = sibling.getNextSibling()
  }
  return wrappers
}

/**
 * The rows of `list` that hang off whatever owns `list`, in document order.
 *
 * Every non-wrapper row qualifies. A wrapper qualifies only while no non-wrapper
 * row has been seen yet: a LEADING wrapper is indented under nothing inside
 * `list` (pressing Tab twice on a row leaves exactly that), so it belongs to
 * `list`'s owner, whereas a wrapper after a row is that row's own and is reached
 * through {@link $indentWrappersOwnedBy} instead.
 */
function $rowsOwningList(list: ListNode): ListItemNode[] {
  const rows: ListItemNode[] = []
  let sawTaskRow = false
  for (const child of list.getChildren()) {
    if (!$isListItemNode(child)) {
      continue
    }
    if ($isChecklistIndentWrapper(child)) {
      if (!sawTaskRow) {
        rows.push(child)
      }
      continue
    }
    rows.push(child)
    sawTaskRow = true
  }
  return rows
}

/** The rows exactly one indent level below `row`, in document order. */
function $childRowsOf(row: ListItemNode): ListItemNode[] {
  const rows: ListItemNode[] = []
  for (const list of $nestedListsOfRow(row)) {
    rows.push(...$rowsOwningList(list))
  }
  for (const wrapper of $indentWrappersOwnedBy(row)) {
    for (const list of $nestedListsOfRow(wrapper)) {
      rows.push(...$rowsOwningList(list))
    }
  }
  return rows
}

/**
 * Every nested task beneath `item`, in document order.
 *
 * DESCENDANT means: a row the user sees indented under `item`, at any depth.
 * Concretely, a row reached by repeatedly taking the sub-lists a row carries —
 * both the wrapper siblings that own them (what Lexical builds) and a sub-list
 * that is a direct child of the row (what an `<li>` holding nothing but a nested
 * list imports as) — and reading those lists' rows. `maxDepth` counts levels
 * below `item`, so `1` is the immediate children.
 *
 * Indent wrappers are STRUCTURE: they are walked through to reach the rows they
 * carry and are never returned. Only rows that satisfy
 * {@link $isChecklistItemNode} come back, so a caller can treat every element as
 * a real task.
 *
 * The walk is iterative and bounded on BOTH axes — depth and node count:
 * nesting reaches 128 levels in the parser, and a recursive descent over a
 * document that deep has already been shown to exhaust the stack elsewhere in
 * this editor.
 */
export function $getChecklistDescendantItems(
  item: ListItemNode,
  maxDepth = CHECKLIST_MAX_NESTING_DEPTH,
): ListItemNode[] {
  const descendants: ListItemNode[] = []
  if (maxDepth < 1) {
    return descendants
  }
  const visited = new Set<string>([item.getKey()])
  // Pre-order, LIFO: a level's rows are pushed in reverse so they pop back in
  // document order, and a row's own children are expanded before its next
  // sibling — which is exactly the order the rows appear on screen.
  const stack: Array<{ row: ListItemNode; depth: number }> = []
  const pushLevel = (rows: ListItemNode[], depth: number): void => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      stack.push({ row: rows[index], depth })
    }
  }

  pushLevel($childRowsOf(item), 1)
  let budget = CHECKLIST_MAX_DESCENDANT_NODES
  while (stack.length > 0 && budget > 0) {
    budget -= 1
    const current = stack.pop()
    if (!current || current.depth > maxDepth || visited.has(current.row.getKey())) {
      continue
    }
    visited.add(current.row.getKey())
    if ($isChecklistItemNode(current.row)) {
      descendants.push(current.row)
    }
    pushLevel($childRowsOf(current.row), current.depth + 1)
  }
  return descendants
}

/**
 * The tasks `item` is indented under, NEAREST FIRST.
 *
 * The exact inverse of {@link $getChecklistDescendantItems}: for the same
 * `maxDepth`, `t` appears here for `r` if and only if `r` appears in the
 * descendants of `t`. Both are needed because a parent task is not an ANCESTOR
 * NODE of its subtasks on the real shape — the sub-list hangs off a wrapper
 * SIBLING, so walking `getParent()` finds the wrapper and the lists, never the
 * parent task.
 *
 * `maxDepth` counts INDENT LEVELS above `item`, exactly as the descendant walk
 * counts levels below, so the cap means the same thing on both sides. That
 * matters for real behaviour: a subtask too deep for the propagation's cap was
 * never carried forward, so it must not be reported as sitting beneath
 * something that was. A level that holds only an indent wrapper (an orphan
 * indent, from pressing Tab twice) consumes a level and contributes no ancestor,
 * which is also what the descendant walk does with it.
 *
 * Climbing is strictly upward (each step leaves the list it entered through), so
 * the loop terminates on structure; the budget is belt-and-braces for a
 * malformed tree.
 */
export function $getChecklistAncestorItems(item: ListItemNode, maxDepth = CHECKLIST_MAX_NESTING_DEPTH): ListItemNode[] {
  const ancestors: ListItemNode[] = []
  let row: ListItemNode = item
  let level = 0
  let budget = CHECKLIST_MAX_DESCENDANT_NODES

  while (budget > 0) {
    budget -= 1
    level += 1
    if (level > maxDepth) {
      return ancestors
    }
    const list = row.getParent()
    if (!$isListNode(list)) {
      return ancestors
    }
    const carrier = list.getParent()
    if (!$isListItemNode(carrier)) {
      // A top-level list: nothing above this row.
      return ancestors
    }
    if (!$isChecklistIndentWrapper(carrier)) {
      // A sub-list that is a direct child of its own task.
      if ($isChecklistItemNode(carrier)) {
        ancestors.push(carrier)
      }
      row = carrier
      continue
    }
    // A wrapper: its owner is the nearest preceding non-wrapper sibling. None
    // means this subtree is indented under nothing at that level, so the climb
    // continues from the wrapper itself.
    let sibling = carrier.getPreviousSibling()
    while ($isListItemNode(sibling) && $isChecklistIndentWrapper(sibling)) {
      sibling = sibling.getPreviousSibling()
    }
    if ($isListItemNode(sibling)) {
      if ($isChecklistItemNode(sibling)) {
        ancestors.push(sibling)
      }
      row = sibling
      continue
    }
    row = carrier
  }
  return ancestors
}

/**
 * The last row of `item` together with everything indented under it — the node a
 * new SIBLING row of `item` must be inserted after.
 *
 * Inserting straight after `item` would land BETWEEN the row and the wrapper
 * holding its subtree, and a task row between a row and its wrapper STEALS that
 * wrapper: the subtree would silently re-parent onto the inserted row.
 */
export function $getChecklistRowSubtreeEnd(item: ListItemNode): ListItemNode {
  const wrappers = $indentWrappersOwnedBy(item)
  return wrappers.length > 0 ? wrappers[wrappers.length - 1] : item
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

  // An occurrence-summary row is a RECORD of occurrences that were never
  // written, not work to be carried forward. It owes its "structurally
  // incapable of being mistaken for an occurrence" property to having neither a
  // deadline nor a rule, so giving it this occurrence's schedule — and
  // reopening it — would turn the record into a task. A user can indent one
  // under a recurring row, so this is reachable; `$applyChecklistItemChecked`
  // refuses summary rows for the same reason.
  const descendants = $getChecklistDescendantItems(item, maxDepth).filter(
    (descendant) => !$isChecklistOccurrenceSummaryItem(descendant),
  )
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
