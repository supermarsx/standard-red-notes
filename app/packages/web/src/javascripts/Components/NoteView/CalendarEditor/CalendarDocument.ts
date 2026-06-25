/**
 * Calendar note document model.
 *
 * A Calendar note stores a flat list of dated events. Each event always carries
 * a `date` (YYYY-MM-DD) anchor day plus a title and optional color. Events may
 * additionally be timed (carrying `start`/`end` ISO datetimes with `allDay:false`)
 * and/or recurring (a simple `recurrence` rule). Day-only events created by older
 * versions of the editor keep working unchanged — they are treated as all-day on
 * their `date`.
 *
 * Exactly like the Canvas, Base, and Sandbox note types, the serialized document
 * is stored verbatim in `note.text` (the same slot Super stores its Lexical JSON
 * in). This keeps a Calendar note round-tripping and syncing like any other note
 * with no models/snjs changes — the note is marked as a calendar purely via
 * `note.editorIdentifier`.
 */

export const CALENDAR_DOCUMENT_VERSION = 1

export type CalendarRecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** A simple repeat rule. `interval` defaults to 1 (every period) when omitted. */
export type CalendarRecurrence = {
  freq: CalendarRecurrenceFreq
  /** Repeat every `interval` periods of `freq` (>= 1). */
  interval?: number
}

export type CalendarEvent = {
  id: string
  /**
   * ISO date string, normalized to YYYY-MM-DD (day granularity). This is the
   * canonical anchor day for the event and is always present, even for timed
   * events (where it equals the local calendar day of `start`).
   */
  date: string
  title: string
  /** Optional CSS color string for the event chip. */
  color?: string
  /**
   * Whether this event occupies the whole day. Defaults to true when absent so
   * legacy day-only events normalize to all-day. When false, `start` should be
   * a full ISO datetime carrying the time-of-day.
   */
  allDay?: boolean
  /** Timed start instant as a full ISO datetime. Present for non-all-day events. */
  start?: string
  /** Optional timed end instant as a full ISO datetime. Ignored when all-day. */
  end?: string
  /** Optional repeat rule. Absent means a one-shot event. */
  recurrence?: CalendarRecurrence
}

export type CalendarDocument = {
  version: number
  events: CalendarEvent[]
}

export const createEmptyCalendarDocument = (): CalendarDocument => ({
  version: CALENDAR_DOCUMENT_VERSION,
  events: [],
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/**
 * Normalize a candidate date string to YYYY-MM-DD. Accepts full ISO strings
 * (e.g. 2026-06-20T10:00:00Z) and date-only strings. Returns null for anything
 * unparseable so malformed events are dropped rather than rendered on a bogus day.
 */
export const normalizeEventDate = (value: unknown): string | null => {
  if (!isString(value) || value.trim().length === 0) {
    return null
  }
  // Fast path: already a plain YYYY-MM-DD.
  const trimmed = value.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`
    }
    return null
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear().toString().padStart(4, '0')
  const month = (parsed.getMonth() + 1).toString().padStart(2, '0')
  const day = parsed.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

const pad2Early = (value: number): string => value.toString().padStart(2, '0')

/** Local-calendar YYYY-MM-DD of an ISO datetime string. */
export const localIsoDateOf = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    return ''
  }
  return `${d.getFullYear().toString().padStart(4, '0')}-${pad2Early(d.getMonth() + 1)}-${pad2Early(d.getDate())}`
}

const RECURRENCE_FREQS: ReadonlySet<string> = new Set(['daily', 'weekly', 'monthly', 'yearly'])

/**
 * Normalize a candidate ISO datetime to a canonical ISO string, or null if it is
 * not a parseable datetime. Accepts anything `Date` accepts (full ISO, with or
 * without zone). A bare YYYY-MM-DD is rejected here (that is a date, not a
 * datetime) so timed fields never silently collapse to midnight UTC.
 */
export const normalizeEventDateTime = (value: unknown): string | null => {
  if (!isString(value) || value.trim().length === 0) {
    return null
  }
  const trimmed = value.trim()
  // A bare date is not a datetime.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed.toISOString()
}

/**
 * Sanitize a candidate recurrence object. Returns undefined for anything that is
 * not a recognizable rule so malformed stored JSON can never crash expansion.
 */
export const sanitizeRecurrence = (raw: unknown): CalendarRecurrence | undefined => {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const candidate = raw as Record<string, unknown>
  if (!isString(candidate.freq) || !RECURRENCE_FREQS.has(candidate.freq)) {
    return undefined
  }
  const freq = candidate.freq as CalendarRecurrenceFreq
  let interval: number | undefined
  if (isFiniteNumber(candidate.interval) && candidate.interval >= 1) {
    interval = Math.floor(candidate.interval)
  }
  return interval && interval > 1 ? { freq, interval } : { freq }
}

const sanitizeEvent = (raw: unknown): CalendarEvent | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }

  const start = normalizeEventDateTime(candidate.start)
  // The anchor date: prefer an explicit date, else derive from a timed start.
  const date = normalizeEventDate(candidate.date) ?? (start ? localIsoDateOf(start) : null)
  if (!date) {
    return null
  }

  const event: CalendarEvent = {
    id: candidate.id,
    date,
    title: isString(candidate.title) ? candidate.title : '',
    color: isString(candidate.color) ? candidate.color : undefined,
  }

  // Timed only when start parses and the event is not flagged all-day. An event
  // with allDay !== false but a start is still treated as all-day on its date.
  const explicitAllDay = candidate.allDay
  if (start && explicitAllDay === false) {
    event.allDay = false
    event.start = start
    const end = normalizeEventDateTime(candidate.end)
    if (end && new Date(end).getTime() > new Date(start).getTime()) {
      event.end = end
    }
  }

  const recurrence = sanitizeRecurrence(candidate.recurrence)
  if (recurrence) {
    event.recurrence = recurrence
  }

  return event
}

/**
 * Parse note text into a CalendarDocument. Never throws: empty, legacy plain
 * text, or otherwise malformed JSON all fall back to an empty calendar. The
 * second return value reports whether the input was recoverable calendar JSON so
 * the editor can surface a non-destructive notice when content was discarded.
 */
export const parseCalendarDocument = (
  text: string | undefined | null,
): { document: CalendarDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptyCalendarDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptyCalendarDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptyCalendarDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>

  // A calendar document must at least expose an events array; otherwise it is
  // probably some other note format being switched into Calendar, so treat it as
  // a fresh calendar but flag it as not-recovered.
  const looksLikeCalendar = Array.isArray(candidate.events)
  if (!looksLikeCalendar) {
    return { document: createEmptyCalendarDocument(), recovered: false }
  }

  const events: CalendarEvent[] = []
  const seenIds = new Set<string>()
  for (const rawEvent of candidate.events as unknown[]) {
    const event = sanitizeEvent(rawEvent)
    if (event && !seenIds.has(event.id)) {
      seenIds.add(event.id)
      events.push(event)
    }
  }

  return {
    document: {
      version: isFiniteNumber(candidate.version) ? candidate.version : CALENDAR_DOCUMENT_VERSION,
      events,
    },
    recovered: true,
  }
}

/** Serialize a CalendarDocument to the string stored in `note.text`. */
export const serializeCalendarDocument = (document: CalendarDocument): string => {
  return JSON.stringify({
    version: document.version ?? CALENDAR_DOCUMENT_VERSION,
    events: document.events,
  })
}

// ---------------------------------------------------------------------------
// Pure month-grid math (no date library).
// ---------------------------------------------------------------------------

export type CalendarCell = {
  /** ISO YYYY-MM-DD for this cell. */
  date: string
  /** Day-of-month number (1-31). */
  day: number
  /** Whether the cell belongs to the displayed month (vs. leading/trailing pad). */
  inMonth: boolean
}

/** Days in a given month, accounting for leap years. month is 0-based. */
export const daysInMonth = (year: number, month: number): number => {
  // Day 0 of the next month is the last day of this month.
  return new Date(year, month + 1, 0).getDate()
}

/** Weekday index (0=Sunday) of the first day of the given month. month is 0-based. */
export const firstWeekdayOfMonth = (year: number, month: number): number => {
  return new Date(year, month, 1).getDay()
}

const pad2 = (value: number): string => value.toString().padStart(2, '0')

/** Build the ISO YYYY-MM-DD for a y/m(0-based)/d triple. */
export const toIsoDate = (year: number, month: number, day: number): string =>
  `${year.toString().padStart(4, '0')}-${pad2(month + 1)}-${pad2(day)}`

/** ISO YYYY-MM-DD for "today" (local time). */
export const todayIso = (now: Date = new Date()): string =>
  toIsoDate(now.getFullYear(), now.getMonth(), now.getDate())

/**
 * Build a 6-row x 7-col (42 cell) month grid for the given year/month (0-based).
 * Leading cells are filled from the previous month, trailing from the next, so
 * the grid is always rectangular. Each cell carries its ISO date and inMonth flag.
 */
export const buildMonthGrid = (year: number, month: number): CalendarCell[] => {
  const cells: CalendarCell[] = []
  const leadingPad = firstWeekdayOfMonth(year, month)
  const totalDays = daysInMonth(year, month)

  // Previous month (handle January wrap to December of prior year).
  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const prevDays = daysInMonth(prevYear, prevMonth)

  // Leading padding from the previous month.
  for (let i = leadingPad - 1; i >= 0; i--) {
    const day = prevDays - i
    cells.push({ date: toIsoDate(prevYear, prevMonth, day), day, inMonth: false })
  }

  // The displayed month.
  for (let day = 1; day <= totalDays; day++) {
    cells.push({ date: toIsoDate(year, month, day), day, inMonth: true })
  }

  // Trailing padding from the next month to fill out 6 rows of 7.
  const nextMonth = month === 11 ? 0 : month + 1
  const nextYear = month === 11 ? year + 1 : year
  let nextDay = 1
  while (cells.length < 42) {
    cells.push({ date: toIsoDate(nextYear, nextMonth, nextDay), day: nextDay, inMonth: false })
    nextDay++
  }

  return cells
}

let idCounter = 0
/** Lightweight unique id generator for events (no crypto dependency). */
export const createCalendarId = (prefix: string): string => {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Event normalization & recurrence expansion (pure logic).
// ---------------------------------------------------------------------------

/** A normalized, fully-resolved view of an event for a single occurrence day. */
export type CalendarOccurrence = {
  /** The originating event (shared across all occurrences of a recurring event). */
  event: CalendarEvent
  /** YYYY-MM-DD of this occurrence. */
  date: string
  /** Whether this occurrence is all-day. */
  allDay: boolean
  /** Local "HH:MM" time-of-day for a timed occurrence, else null. */
  time: string | null
}

/**
 * Normalize an event to a consistent shape: every event is either all-day (the
 * default, including legacy day-only events) or timed with a parseable `start`.
 * A timed event whose start fails to parse is treated as all-day so it still
 * renders on its anchor day rather than vanishing.
 */
export const isTimedEvent = (event: CalendarEvent): boolean => {
  return event.allDay === false && typeof event.start === 'string' && !Number.isNaN(new Date(event.start).getTime())
}

/** Local "HH:MM" for a timed event's start, or null when all-day/unparseable. */
export const eventTimeOfDay = (event: CalendarEvent): string | null => {
  if (!isTimedEvent(event) || !event.start) {
    return null
  }
  const d = new Date(event.start)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Parse "YYYY-MM-DD" into a local Date at midnight, or null. */
const parseIsoDateLocal = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) {
    return null
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Whether a recurring event with given anchor falls on `target` (both local dates). */
const recurrenceHitsDate = (anchor: Date, target: Date, recurrence: CalendarRecurrence): boolean => {
  if (target.getTime() < anchor.getTime()) {
    return false
  }
  const interval = recurrence.interval && recurrence.interval >= 1 ? Math.floor(recurrence.interval) : 1
  const dayMs = 24 * 60 * 60 * 1000
  switch (recurrence.freq) {
    case 'daily': {
      const diffDays = Math.round((target.getTime() - anchor.getTime()) / dayMs)
      return diffDays % interval === 0
    }
    case 'weekly': {
      if (target.getDay() !== anchor.getDay()) {
        return false
      }
      const diffWeeks = Math.round((target.getTime() - anchor.getTime()) / (dayMs * 7))
      return diffWeeks % interval === 0
    }
    case 'monthly': {
      if (target.getDate() !== anchor.getDate()) {
        return false
      }
      const diffMonths = (target.getFullYear() - anchor.getFullYear()) * 12 + (target.getMonth() - anchor.getMonth())
      return diffMonths >= 0 && diffMonths % interval === 0
    }
    case 'yearly': {
      if (target.getDate() !== anchor.getDate() || target.getMonth() !== anchor.getMonth()) {
        return false
      }
      const diffYears = target.getFullYear() - anchor.getFullYear()
      return diffYears >= 0 && diffYears % interval === 0
    }
    default:
      return false
  }
}

/** Safety cap on how many cells one recurring event may be tested against. */
export const MAX_RECURRENCE_CELLS = 42

/**
 * Expand a list of events into per-day occurrences across the given window of
 * ISO dates (typically the 42 cells of a month grid). Non-recurring events emit
 * a single occurrence on their anchor day (only if that day is in the window).
 * Recurring events emit one occurrence per window day they fall on, capped at
 * {@link MAX_RECURRENCE_CELLS} per event so a pathological rule can't blow up.
 *
 * Pure: returns a Map keyed by ISO date -> occurrences (input order preserved
 * within a day). The window order does not affect membership.
 */
export const expandEventsForWindow = (
  events: CalendarEvent[],
  windowDates: string[],
): Map<string, CalendarOccurrence[]> => {
  const result = new Map<string, CalendarOccurrence[]>()
  const windowSet = new Set(windowDates)
  const windowParsed = windowDates
    .map((iso) => ({ iso, date: parseIsoDateLocal(iso) }))
    .filter((w): w is { iso: string; date: Date } => w.date !== null)

  const push = (date: string, occ: CalendarOccurrence): void => {
    const existing = result.get(date)
    if (existing) {
      existing.push(occ)
    } else {
      result.set(date, [occ])
    }
  }

  for (const event of events) {
    const allDay = !isTimedEvent(event)
    const time = eventTimeOfDay(event)

    if (!event.recurrence) {
      if (windowSet.has(event.date)) {
        push(event.date, { event, date: event.date, allDay, time })
      }
      continue
    }

    const anchor = parseIsoDateLocal(event.date)
    if (!anchor) {
      continue
    }
    let emitted = 0
    for (const { iso, date } of windowParsed) {
      if (emitted >= MAX_RECURRENCE_CELLS) {
        break
      }
      if (recurrenceHitsDate(anchor, date, event.recurrence)) {
        push(iso, { event, date: iso, allDay, time })
        emitted += 1
      }
    }
  }

  return result
}
