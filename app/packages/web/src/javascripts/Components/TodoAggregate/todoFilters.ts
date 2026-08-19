import type { PrefKey, SNNote, TodoFiltersPreference } from '@standardnotes/snjs'
import type { NoteTodos, TodoItem } from './allTodos'

/**
 * Standard Red Notes: the Todos general view's filter model.
 *
 * Pure, application-free: types, normalization of the persisted value, and the
 * row projection / filtering / sorting the view renders. Nothing here throws,
 * because it runs against a synced preference that another (possibly newer or
 * older) client may have written.
 *
 * ## Which dimensions are real
 * A todo itself carries only text, checked, due date and recurrence — there is
 * no topic/category/folder field on it. The taxonomy lives on the SOURCE NOTE,
 * and in this app "topics", "categories" and "folders" are all one concept:
 * **tags**, which nest (the UI calls nested tags Folders). So the real, non-
 * invented dimensions are: the note's tags, the source note itself, the source
 * kind (Super vs Advanced Checklist), completion, and the due date.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export const MAX_TODO_FILTER_QUERY_LENGTH = 256
export const MAX_TODO_FILTER_TAGS = 64

/** Which todos a due-date filter admits. Independent of completion — the
 * hide-completed toggle composes on top rather than being folded in here. */
export type TodoDueFilter = 'all' | 'overdue' | 'due-soon' | 'scheduled' | 'unscheduled'

export type TodoSourceFilter = 'all' | 'super' | 'advanced-checklist'

export type TodoSortKey = 'due' | 'todo' | 'note' | 'status'

export const CURRENT_TODO_FILTERS_VERSION = 1

/**
 * The persisted shape is owned by `@standardnotes/models` — it is a SYNCED
 * preference value — so it is re-exported here rather than redeclared, keeping
 * one source of truth for what gets written to the account.
 */
export type TodoFilters = TodoFiltersPreference

/**
 * The synced UserPrefs key the filters persist under, so they follow the user
 * to another device — the same layer the notes list's own display filters use
 * (`NotesShowArchived`, `NotesHidePinned`, `SortNotesBy`).
 *
 * Pinned as a literal rather than read off the `PrefKey` enum object: web
 * consumes the enum's RUNTIME value from the generated `snjs` bundle, and a new
 * member is only present there after that shared artifact is rebuilt. A string
 * enum is its own string at runtime, so this is exactly `PrefKey.TodoFilters`
 * while depending on nothing generated. Swap it for the plain member once snjs
 * has been rebuilt in a normal build cycle.
 */
export const TODO_FILTERS_PREF_KEY = 'todoFilters' as PrefKey.TodoFilters

export const DEFAULT_TODO_FILTERS: TodoFilters = {
  version: CURRENT_TODO_FILTERS_VERSION,
  // Show everything, nearest deadline first, nothing hidden — a first run must
  // never open the Todos view with rows already filtered out.
  query: '',
  tagUuids: [],
  source: 'all',
  due: 'all',
  hideCompleted: false,
  sortBy: 'due',
  sortReverse: false,
}

export type TodoTag = { uuid: string; title: string }

/**
 * How many nesting levels the view indents before it stops widening rows. Real
 * depth is never clamped — only the indent is — so a level-12 task still says
 * it is level 12; see {@link todoRowIndentLevel}.
 */
export const TODO_MAX_INDENT_LEVEL = 10

/** One rendered row: a single todo, flattened out of its note grouping. */
export type TodoRow = {
  /** Stable within a render pass; unique across notes. */
  id: string
  group: NoteTodos
  item: TodoItem
  noteTitle: string
  tags: TodoTag[]
  /** Checklist nesting level of this task, uncapped. */
  depth: number
  /** Row id of the parent task, when the parent is itself a visible row. */
  parentId?: string
  /**
   * False when the row survived filtering only because a descendant matched.
   * The view shows these as muted context so a nested match is never orphaned
   * from the task it belongs to.
   */
  isMatch: boolean
}

/**
 * Indent level to actually render: real depth, clamped so ten levels fit
 * without the row running off the edge.
 */
export function todoRowIndentLevel(depth: number): number {
  return Math.min(Math.max(depth, 0), TODO_MAX_INDENT_LEVEL)
}

const isSourceFilter = (value: unknown): value is TodoSourceFilter =>
  value === 'all' || value === 'super' || value === 'advanced-checklist'

const isDueFilter = (value: unknown): value is TodoDueFilter =>
  value === 'all' || value === 'overdue' || value === 'due-soon' || value === 'scheduled' || value === 'unscheduled'

const isSortKey = (value: unknown): value is TodoSortKey =>
  value === 'due' || value === 'todo' || value === 'note' || value === 'status'

/**
 * Coerce an arbitrary persisted value into valid, bounded filters. A value from
 * a future client, a corrupted value, or a partial object all degrade to the
 * defaults for the fields they get wrong rather than wedging the view.
 */
export function normalizeTodoFilters(raw: unknown): TodoFilters {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_TODO_FILTERS
  }
  const candidate = raw as Partial<TodoFilters>

  const query = typeof candidate.query === 'string' ? candidate.query.slice(0, MAX_TODO_FILTER_QUERY_LENGTH) : ''

  const tagUuids = Array.isArray(candidate.tagUuids)
    ? Array.from(
        new Set(candidate.tagUuids.filter((id): id is string => typeof id === 'string' && id.length > 0)),
      ).slice(0, MAX_TODO_FILTER_TAGS)
    : []

  return {
    version: CURRENT_TODO_FILTERS_VERSION,
    query,
    tagUuids,
    source: isSourceFilter(candidate.source) ? candidate.source : DEFAULT_TODO_FILTERS.source,
    due: isDueFilter(candidate.due) ? candidate.due : DEFAULT_TODO_FILTERS.due,
    hideCompleted: candidate.hideCompleted === true,
    sortBy: isSortKey(candidate.sortBy) ? candidate.sortBy : DEFAULT_TODO_FILTERS.sortBy,
    sortReverse: candidate.sortReverse === true,
  }
}

/** True when the value differs from the defaults in any user-visible way. */
export function todoFiltersAreDefault(filters: TodoFilters): boolean {
  return activeTodoFilterCount(filters) === 0 && filters.sortBy === DEFAULT_TODO_FILTERS.sortBy && !filters.sortReverse
}

/**
 * How many NARROWING filters are active. Sort order is deliberately excluded:
 * it reorders rows but never hides one, and the count drives the "why is this
 * list empty" banner.
 */
export function activeTodoFilterCount(filters: TodoFilters): number {
  let count = 0
  if (filters.query.trim().length > 0) {
    count += 1
  }
  if (filters.tagUuids.length > 0) {
    count += 1
  }
  if (filters.source !== 'all') {
    count += 1
  }
  if (filters.due !== 'all') {
    count += 1
  }
  if (filters.hideCompleted) {
    count += 1
  }
  return count
}

/** Flatten note-grouped todos into rows, attaching each note's tags. */
export function todoRowsFromGroups(groups: NoteTodos[], tagsForNote: (note: SNNote) => TodoTag[]): TodoRow[] {
  const rows: TodoRow[] = []
  for (const group of groups) {
    let tags: TodoTag[]
    try {
      tags = tagsForNote(group.note)
    } catch {
      // A tag lookup must never take the whole view down.
      tags = []
    }
    const noteTitle = group.note.title?.trim() || 'Untitled'
    const rowIdFor = (locator: string) => `${group.note.uuid}:${locator}`
    const present = new Set(group.items.map((item) => item.locator ?? item.id))
    // Depth is derived from the parent chain rather than read off the item, so
    // it always agrees with the links the tree is actually built from. Items
    // arrive in document order, so a parent is always seen before its children.
    const depthById = new Map<string, number>()
    for (const item of group.items) {
      // A parent whose own text was empty never became a row; such a task is
      // treated as top level rather than pointing at a row that does not exist.
      const parentLocator = item.parentLocator && present.has(item.parentLocator) ? item.parentLocator : undefined
      const parentId = parentLocator === undefined ? undefined : rowIdFor(parentLocator)
      const id = rowIdFor(item.locator ?? item.id)
      const depth = parentId === undefined ? 0 : (depthById.get(parentId) ?? 0) + 1
      depthById.set(id, depth)
      rows.push({ id, group, item, noteTitle, tags, depth, parentId, isMatch: true })
    }
  }
  return rows
}

/** Every tag present on at least one row, de-duplicated and title-sorted. */
export function collectTodoTagOptions(rows: TodoRow[]): TodoTag[] {
  const byUuid = new Map<string, TodoTag>()
  for (const row of rows) {
    for (const tag of row.tags) {
      if (!byUuid.has(tag.uuid)) {
        byUuid.set(tag.uuid, tag)
      }
    }
  }
  return Array.from(byUuid.values()).sort((a, b) => a.title.localeCompare(b.title))
}

export type TodoDueBucket = 'overdue' | 'due-soon' | 'later' | 'unscheduled'

/**
 * Classify a todo by its deadline alone. Completion is NOT folded in: a done
 * item whose deadline has passed is still "overdue" here, so that hiding
 * completed todos and filtering by deadline compose instead of interfering.
 */
export function todoDueBucket(item: TodoItem, now: number): TodoDueBucket {
  if (!item.dueAt) {
    return 'unscheduled'
  }
  const due = Date.parse(item.dueAt)
  if (!Number.isFinite(due)) {
    return 'unscheduled'
  }
  const delta = due - now
  if (delta <= 0) {
    return 'overdue'
  }
  return delta <= DAY_MS ? 'due-soon' : 'later'
}

function matchesQuery(row: TodoRow, trimmedLowerQuery: string): boolean {
  if (trimmedLowerQuery.length === 0) {
    return true
  }
  return (
    row.item.text.toLowerCase().includes(trimmedLowerQuery) ||
    row.noteTitle.toLowerCase().includes(trimmedLowerQuery) ||
    row.tags.some((tag) => tag.title.toLowerCase().includes(trimmedLowerQuery))
  )
}

function matchesDue(row: TodoRow, filter: TodoDueFilter, now: number): boolean {
  if (filter === 'all') {
    return true
  }
  const bucket = todoDueBucket(row.item, now)
  switch (filter) {
    case 'overdue':
      return bucket === 'overdue'
    case 'due-soon':
      return bucket === 'due-soon'
    case 'scheduled':
      return bucket !== 'unscheduled'
    case 'unscheduled':
      return bucket === 'unscheduled'
  }
}

/** Does a row satisfy every filter in its own right? */
function rowMatchesFilters(
  row: TodoRow,
  filters: TodoFilters,
  query: string,
  tagUuids: Set<string> | undefined,
  now: number,
): boolean {
  if (filters.hideCompleted && row.item.checked) {
    return false
  }
  if (filters.source !== 'all' && row.group.source !== filters.source) {
    return false
  }
  if (tagUuids && !row.tags.some((tag) => tagUuids.has(tag.uuid))) {
    return false
  }
  if (!matchesDue(row, filters.due, now)) {
    return false
  }
  return matchesQuery(row, query)
}

/**
 * Apply every filter together. They COMPOSE: search AND tag AND source AND due
 * AND hide-completed must all admit a row for it to count as a match.
 *
 * Hierarchy rule: a matching row DRAGS ITS ANCESTORS IN as context, flagged
 * `isMatch: false` so the view can mute them. A deep subtask shown with no
 * parent is unreadable — the user cannot tell which task it belongs to — and a
 * silently truncated chain is worse. Ancestors kept this way are not counted as
 * matches anywhere.
 */
export function filterTodoRows(rows: TodoRow[], filters: TodoFilters, now: number): TodoRow[] {
  const query = filters.query.trim().toLowerCase()
  const tagUuids = filters.tagUuids.length > 0 ? new Set(filters.tagUuids) : undefined

  const matched = new Set<string>()
  for (const row of rows) {
    if (rowMatchesFilters(row, filters, query, tagUuids, now)) {
      matched.add(row.id)
    }
  }
  if (matched.size === rows.length) {
    // Nothing was excluded, so no ancestor pass is needed and every row is a
    // match in its own right.
    return rows
  }

  const byId = new Map(rows.map((row) => [row.id, row]))
  const visible = new Set(matched)
  for (const id of matched) {
    let parentId = byId.get(id)?.parentId
    // Bounded by the row count: a cycle cannot outlast visiting every row once.
    let guard = rows.length
    while (parentId && !visible.has(parentId) && guard > 0) {
      visible.add(parentId)
      parentId = byId.get(parentId)?.parentId
      guard -= 1
    }
  }

  return rows
    .filter((row) => visible.has(row.id))
    .map((row) => (matched.has(row.id) ? row : { ...row, isMatch: false }))
}

/** How many rows match in their own right, ignoring ancestors kept as context. */
export function countTodoMatches(rows: TodoRow[]): number {
  return rows.reduce((count, row) => count + (row.isMatch ? 1 : 0), 0)
}

function compareDue(a: TodoRow, b: TodoRow): number {
  const aDue = a.item.dueAt ? Date.parse(a.item.dueAt) : Number.NaN
  const bDue = b.item.dueAt ? Date.parse(b.item.dueAt) : Number.NaN
  const aHas = Number.isFinite(aDue)
  const bHas = Number.isFinite(bDue)
  if (aHas && bHas) {
    return aDue - bDue
  }
  // Undated todos sort last under "Due", in both directions, so reversing the
  // order never buries every scheduled item under a wall of undated ones.
  if (aHas !== bHas) {
    return aHas ? -1 : 1
  }
  return 0
}

/**
 * Order rows for display as a TREE: the chosen sort orders SIBLINGS within each
 * parent, and children always follow their parent. Sorting therefore never
 * flattens the hierarchy — the alternative, letting a sort scatter subtasks away
 * from their parents, destroys the structure the user asked to see.
 *
 * Rows whose parent is not in `rows` are treated as roots, so this is safe on a
 * filtered subset.
 */
export function sortTodoRows(rows: TodoRow[], filters: TodoFilters): TodoRow[] {
  const compare = todoRowComparator(filters)
  const present = new Set(rows.map((row) => row.id))
  const childrenByParent = new Map<string | undefined, TodoRow[]>()
  for (const row of rows) {
    const key = row.parentId && present.has(row.parentId) ? row.parentId : undefined
    const siblings = childrenByParent.get(key)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByParent.set(key, [row])
    }
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compare)
  }

  const ordered: TodoRow[] = []
  const emit = (parentId: string | undefined, guard: number) => {
    if (guard < 0) {
      return
    }
    for (const row of childrenByParent.get(parentId) ?? []) {
      ordered.push(row)
      emit(row.id, guard - 1)
    }
  }
  // Depth guard bounds a malformed cycle; a real chain cannot exceed the count.
  emit(undefined, rows.length)
  // A cycle would strand its rows; append them so filtering never loses a row.
  if (ordered.length !== rows.length) {
    const emitted = new Set(ordered.map((row) => row.id))
    for (const row of rows) {
      if (!emitted.has(row.id)) {
        ordered.push(row)
      }
    }
  }
  return ordered
}

/**
 * Sibling comparator. Undated rows always sink below dated ones in a due sort;
 * every other comparison is reversible. Ties fall back to note title then text
 * so the order is total and stable across renders.
 */
function todoRowComparator(filters: TodoFilters): (a: TodoRow, b: TodoRow) => number {
  const direction = filters.sortReverse ? -1 : 1
  return (a, b) => {
    let primary = 0
    switch (filters.sortBy) {
      case 'due':
        primary = compareDue(a, b)
        // Undated placement is a display invariant, not part of the ordering.
        if (Boolean(a.item.dueAt) !== Boolean(b.item.dueAt)) {
          return primary
        }
        break
      case 'todo':
        primary = a.item.text.localeCompare(b.item.text)
        break
      case 'note':
        primary = a.noteTitle.localeCompare(b.noteTitle)
        break
      case 'status':
        primary = Number(a.item.checked) - Number(b.item.checked)
        if (primary === 0) {
          primary = compareDue(a, b)
        }
        break
    }
    if (primary !== 0) {
      return primary * direction
    }
    const byNote = a.noteTitle.localeCompare(b.noteTitle)
    if (byNote !== 0) {
      return byNote * direction
    }
    return a.item.text.localeCompare(b.item.text) * direction
  }
}

/** Filter then sort, in the order the view renders. */
export function visibleTodoRows(rows: TodoRow[], filters: TodoFilters, now: number): TodoRow[] {
  return sortTodoRows(filterTodoRows(rows, filters, now), filters)
}
