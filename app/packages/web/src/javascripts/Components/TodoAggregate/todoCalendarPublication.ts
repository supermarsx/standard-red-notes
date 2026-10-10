import type { ChecklistRecurrence } from '../SuperEditor/Checklist/checklistRecurrence'
import { normalizeChecklistDueAt } from '../SuperEditor/Checklist/checklistDueDate'
import { todoTagLabel, type TodoRow } from './todoFilters'

/**
 * Standard Red Notes: decide WHICH task deadlines leave the device, and in what
 * plaintext shape, so they can appear as events in a real calendar app.
 *
 * ## Why this is a separate, pure module
 *
 * Notes are end-to-end encrypted, so the CalDAV feed can only serve what the
 * client has deliberately published into the server's small plaintext store.
 * That makes "which tasks" a PRIVACY decision, not a rendering one, and it has
 * to be made here — on the device, under the user's own scope settings — rather
 * than server-side. The complementary half, "what the event looks like", is a
 * rendering decision and lives in the gateway's `CalendarProjection.ts`, where
 * changing it re-renders records already stored instead of republishing them.
 *
 * ## What it refuses to publish, and why
 *
 *  - **Rows with no deadline.** An event needs a date. A task without one stays
 *    a task.
 *  - **Occurrence-summary records.** These are a RECORD of occurrences a capped
 *    generation pass did not write down, deliberately carrying no deadline and
 *    no rule so that nothing can mistake them for work. `TodoItem.dueAt` is
 *    already absent on them, and the explicit check below keeps that true even
 *    if a future field changes it.
 *  - **Heading rows.** A heading is the context a user authored to organise the
 *    list; it has no deadline of its own.
 *  - **Lexical indent wrappers.** These never reach here at all: the aggregate
 *    walk in `superChecklistDocument.ts` derives rows from the real task items
 *    plus the contiguous wrapper siblings that carry their children, and the
 *    wrappers themselves are structure and never become rows. That matters
 *    because `afterCloneFrom` copies node state, so a wrapper can INHERIT the
 *    real row's `srnChecklistDueAt` — a wrapper that became a row here would
 *    publish a duplicate event with the same deadline and no text.
 */

export type TodoCalendarScopeMode = 'all' | 'tags' | 'notes'

export interface TodoCalendarPublicationSettings {
  /**
   * Which tasks are eligible. A user with hundreds of tasks does not want all of
   * them on their calendar, and `all` also means every deadline becomes server
   * plaintext — so the narrow modes are the common case, not an edge case.
   */
  scope: TodoCalendarScopeMode
  /** Tag uuids whose notes are in scope. Only read when `scope` is `tags`. */
  tagUuids: string[]
  /** Note uuids in scope. Only read when `scope` is `notes`. */
  noteUuids: string[]
  /** Publish finished tasks at all. The server then decides how to show them. */
  includeCompleted: boolean
  /**
   * Publish a DATE-ONLY `due` when the deadline is local midnight.
   *
   * The editor stores a single instant and collapses a blank time field to local
   * 00:00, so "a date, no time" is only recoverable by recognising that
   * midnight. The client is the one place that knows the user's own zone with
   * certainty, so recognising it HERE turns the server's inference into a fact.
   */
  dateOnlyAtLocalMidnight: boolean
  /** Attach the source note's tags as CATEGORIES, for colouring and filtering. */
  includeTagsAsCategories: boolean
  /** Hard ceiling on one publish pass, so a huge vault cannot flood the store. */
  maximumItems: number
}

export const TODO_CALENDAR_MAX_ITEMS = 1_000
export const TODO_CALENDAR_MAX_SCOPE_IDS = 64
export const TODO_CALENDAR_MAX_CATEGORIES = 8
export const TODO_CALENDAR_MAX_SUMMARY_LENGTH = 1_024
export const TODO_CALENDAR_UID_PREFIX = 'srn-task-'

/**
 * The synced `UserPrefs` key, as the string that is actually written.
 *
 * Pinned as a LITERAL, not as `PrefKey.TodoCalendarPublication`, for the reason
 * `checklistBackfill.ts` documents: web type-checks `@standardnotes/snjs`
 * against `packages/models/dist/**.d.ts`, a build artifact that predates a
 * brand-new enum member, so the cast does not compile yet — and web also
 * consumes `PrefKey`'s RUNTIME value from that bundle, where a new member is
 * `undefined`. A string enum member IS its own string at runtime, so the literal
 * depends on nothing generated. The value below is exactly the enum's.
 */
export const TODO_CALENDAR_PUBLICATION_PREF_KEY = 'todoCalendarPublication'

/**
 * Narrow and conservative. `all` is NOT the default: switching this feature on
 * must not be the same action as copying every deadline in the vault into
 * server-readable plaintext.
 */
export const DEFAULT_TODO_CALENDAR_PUBLICATION: TodoCalendarPublicationSettings = {
  scope: 'tags',
  tagUuids: [],
  noteUuids: [],
  includeCompleted: false,
  dateOnlyAtLocalMidnight: true,
  includeTagsAsCategories: true,
  maximumItems: 200,
}

function boundedIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const unique: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256 || unique.includes(entry)) {
      continue
    }
    unique.push(entry)
    if (unique.length >= TODO_CALENDAR_MAX_SCOPE_IDS) {
      break
    }
  }
  return unique
}

export function normalizeTodoCalendarPublication(raw: unknown): TodoCalendarPublicationSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_TODO_CALENDAR_PUBLICATION, tagUuids: [], noteUuids: [] }
  }
  const value = raw as Record<string, unknown>
  const scope: TodoCalendarScopeMode =
    value.scope === 'all' || value.scope === 'tags' || value.scope === 'notes'
      ? value.scope
      : DEFAULT_TODO_CALENDAR_PUBLICATION.scope
  const maximum =
    typeof value.maximumItems === 'number' && Number.isSafeInteger(value.maximumItems)
      ? Math.min(TODO_CALENDAR_MAX_ITEMS, Math.max(1, value.maximumItems))
      : DEFAULT_TODO_CALENDAR_PUBLICATION.maximumItems
  return {
    scope,
    tagUuids: boundedIds(value.tagUuids),
    noteUuids: boundedIds(value.noteUuids),
    includeCompleted: value.includeCompleted === true,
    // Both default to ON, so an absent field keeps the helpful behaviour rather
    // than silently degrading to UTC-midnight guessing and no categories.
    dateOnlyAtLocalMidnight: value.dateOnlyAtLocalMidnight !== false,
    includeTagsAsCategories: value.includeTagsAsCategories !== false,
    maximumItems: maximum,
  }
}

/** The reduced repeat rule the gateway's published-todo schema accepts. */
export interface PublishableRecurrence {
  frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
  interval?: number
  monthDay?: number
  month?: number
  timeZone?: string
}

/** One record ready for `POST /v1/caldav/todos`. */
export interface PublishableTodo {
  uid: string
  summary: string
  description?: string
  /** `YYYY-MM-DD` for an all-day deadline, else a canonical UTC instant. */
  due: string
  completed?: boolean
  categories?: string[]
  recurrence?: PublishableRecurrence
}

/**
 * Fold the editor's six-frequency rule (five fixed plus `custom` interval+unit)
 * into the five the server validates, keeping the WALL-CLOCK ANCHOR fields the
 * monthly and yearly rules are actually computed from.
 *
 * `anchor.day` rather than the deadline's own day-of-month is deliberate: the
 * editor clamps an occurrence into a short month (`Math.min(anchor.day,
 * lastDay)`), so a 31st-of-the-month task whose current occurrence landed on 28
 * February still repeats on the 31st. Publishing 28 would permanently move the
 * rule.
 */
export function publishableRecurrence(recurrence: ChecklistRecurrence): PublishableRecurrence {
  const anchor = recurrence.anchor
  const timeZone = anchor.timeZone.length > 0 ? { timeZone: anchor.timeZone } : {}
  if (recurrence.frequency === 'custom') {
    const interval = recurrence.interval > 1 ? { interval: recurrence.interval } : {}
    switch (recurrence.unit) {
      case 'day':
        return { frequency: 'daily', ...interval, ...timeZone }
      case 'week':
        return { frequency: 'weekly', ...interval, ...timeZone }
      case 'month':
        return { frequency: 'monthly', ...interval, monthDay: anchor.day, ...timeZone }
      case 'year':
        return { frequency: 'yearly', ...interval, monthDay: anchor.day, month: anchor.month, ...timeZone }
    }
  }
  switch (recurrence.frequency) {
    case 'daily':
      return { frequency: 'daily', ...timeZone }
    case 'weekdays':
      return { frequency: 'weekdays', ...timeZone }
    case 'weekly':
      return { frequency: 'weekly', ...timeZone }
    case 'monthly':
      return { frequency: 'monthly', monthDay: anchor.day, ...timeZone }
    case 'yearly':
      return { frequency: 'yearly', monthDay: anchor.day, month: anchor.month, ...timeZone }
  }
}

/**
 * FNV-1a over a legacy locator, so a row with no persisted identity still gets a
 * STABLE, bounded uid.
 *
 * A locator can be long enough to blow the store's 256-character key bound, and
 * truncating it would merge two different rows. A hash is bounded and stable for
 * as long as the locator is, which is exactly the lifetime of a legacy row's
 * identity anyway — once the row gains a `todoId` the branch below stops being
 * taken and the identity becomes permanent.
 */
export function legacyTodoUidSuffix(locator: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < locator.length; index += 1) {
    hash ^= locator.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The stable CalDAV uid for a row. Prefixed so it cannot collide with a hand-published item. */
export function todoCalendarUid(row: TodoRow): string {
  const todoId = row.item.todoId
  if (todoId !== undefined && todoId.length > 0) {
    return `${TODO_CALENDAR_UID_PREFIX}${todoId}`
  }
  return `${TODO_CALENDAR_UID_PREFIX}${row.group.note.uuid}-${legacyTodoUidSuffix(row.item.locator ?? row.item.id)}`
}

/** True when `instant` falls exactly on midnight in the runtime's local zone. */
export function isLocalMidnight(instant: string): boolean {
  const timestamp = Date.parse(instant)
  if (!Number.isFinite(timestamp)) {
    return false
  }
  const date = new Date(timestamp)
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0
}

/** The local calendar date of an instant, as `YYYY-MM-DD`. */
export function localCalendarDate(instant: string): string | undefined {
  const timestamp = Date.parse(instant)
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  const date = new Date(timestamp)
  const pad = (value: number, width = 2) => `${value}`.padStart(width, '0')
  const year = date.getFullYear()
  if (year < 1 || year > 9999) {
    return undefined
  }
  return `${pad(year, 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** True when this row's note is inside the configured scope. */
export function rowIsInScope(row: TodoRow, settings: TodoCalendarPublicationSettings): boolean {
  if (settings.scope === 'all') {
    return true
  }
  if (settings.scope === 'notes') {
    return settings.noteUuids.includes(row.group.note.uuid)
  }
  return row.tags.some((tag) => settings.tagUuids.includes(tag.uuid))
}

/**
 * Turn the rows the Todos aggregate already built into publishable records.
 *
 * Takes `TodoRow[]` rather than notes on purpose: `todoRowsFromGroups` has
 * already done the bounded, iterative, wrapper-aware tree walk and attached each
 * note's tags, so nothing here re-derives Lexical structure. The pass is a flat
 * loop over an already-flat list; there is no recursion to overflow.
 *
 * Rows are de-duplicated by uid, keeping the FIRST occurrence, because two rows
 * can share a legacy locator hash only if they are the same row seen twice, and
 * publishing the same uid twice in one pass would make the second write look
 * like an edit of the first.
 */
export function todoCalendarPublications(
  rows: readonly TodoRow[],
  settings: TodoCalendarPublicationSettings,
): PublishableTodo[] {
  const published: PublishableTodo[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (published.length >= settings.maximumItems) {
      break
    }
    const item = row.item
    if (item.occurrenceSummary !== undefined || item.headingLevel !== undefined) {
      continue
    }
    if (item.checked && !settings.includeCompleted) {
      continue
    }
    const dueAt = item.dueAt === undefined ? undefined : normalizeChecklistDueAt(item.dueAt)
    if (!dueAt) {
      continue
    }
    if (!rowIsInScope(row, settings)) {
      continue
    }
    const summary = item.text.trim().slice(0, TODO_CALENDAR_MAX_SUMMARY_LENGTH)
    if (summary.length === 0) {
      // The store requires a non-blank summary, and an untitled block on a
      // calendar tells the user nothing anyway.
      continue
    }
    const uid = todoCalendarUid(row)
    if (seen.has(uid)) {
      continue
    }
    seen.add(uid)

    const localDate = settings.dateOnlyAtLocalMidnight && isLocalMidnight(dueAt) ? localCalendarDate(dueAt) : undefined
    const categories = settings.includeTagsAsCategories
      ? row.tags
          .map((tag) => todoTagLabel(tag).trim())
          .filter((label) => label.length > 0)
          .slice(0, TODO_CALENDAR_MAX_CATEGORIES)
      : []

    published.push({
      uid,
      summary,
      due: localDate ?? dueAt,
      ...(item.checked ? { completed: true } : {}),
      ...(categories.length > 0 ? { categories } : {}),
      ...(item.recurrence !== undefined ? { recurrence: publishableRecurrence(item.recurrence) } : {}),
      description: `Task from "${row.noteTitle}" in Standard Red Notes.`,
    })
  }
  return published
}

/**
 * The uids a previous pass published that this pass no longer owns, so the caller
 * can unpublish them.
 *
 * Without this, narrowing the scope or completing a task would LEAVE the event
 * behind: the record stays in the server store and the calendar keeps drawing
 * it. Only `srn-task-` uids are considered, so an item the user published by
 * hand through the preferences pane is never swept away by an automatic pass.
 */
export function staleTodoCalendarUids(
  publishedUids: readonly string[],
  publications: readonly PublishableTodo[],
): string[] {
  const keep = new Set(publications.map((publication) => publication.uid))
  return publishedUids.filter((uid) => uid.startsWith(TODO_CALENDAR_UID_PREFIX) && !keep.has(uid))
}
