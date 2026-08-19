import type { SNNote } from '@standardnotes/snjs'
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

export type TodoFilters = {
  version: typeof CURRENT_TODO_FILTERS_VERSION
  /** Free-text query, matched against todo text, note title and tag titles. */
  query: string
  /** Tag (folder) uuids; a row matches when it carries ANY of them. */
  tagUuids: string[]
  source: TodoSourceFilter
  due: TodoDueFilter
  hideCompleted: boolean
  sortBy: TodoSortKey
  sortReverse: boolean
}

/**
 * App-storage K/V key the filters persist under. This is the device-local
 * store (the same precedent `searchIndexSettings` uses), NOT the synced
 * UserPrefs item: filters survive reload and navigation on this device, and do
 * not follow the user to another machine.
 */
export const TODO_FILTERS_STORAGE_KEY = 'TodoGeneralViewFilters'

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

/** One rendered row: a single todo, flattened out of its note grouping. */
export type TodoRow = {
  /** Stable within a render pass; unique across notes. */
  id: string
  group: NoteTodos
  item: TodoItem
  noteTitle: string
  tags: TodoTag[]
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
    for (const item of group.items) {
      rows.push({
        id: `${group.note.uuid}:${item.locator ?? item.id}`,
        group,
        item,
        noteTitle,
        tags,
      })
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

/**
 * Apply every filter together. They COMPOSE: search AND tag AND source AND due
 * AND hide-completed must all admit a row for it to survive.
 */
export function filterTodoRows(rows: TodoRow[], filters: TodoFilters, now: number): TodoRow[] {
  const query = filters.query.trim().toLowerCase()
  const tagUuids = filters.tagUuids.length > 0 ? new Set(filters.tagUuids) : undefined

  return rows.filter((row) => {
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
  })
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
 * Order rows for display. Undated rows always sink to the bottom of a due sort;
 * every other comparison is reversible. Ties fall back to note title then text
 * so the order is total and stable across renders.
 */
export function sortTodoRows(rows: TodoRow[], filters: TodoFilters): TodoRow[] {
  const direction = filters.sortReverse ? -1 : 1
  const sorted = rows.slice()
  sorted.sort((a, b) => {
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
  })
  return sorted
}

/** Filter then sort, in the order the view renders. */
export function visibleTodoRows(rows: TodoRow[], filters: TodoFilters, now: number): TodoRow[] {
  return sortTodoRows(filterTodoRows(rows, filters, now), filters)
}
