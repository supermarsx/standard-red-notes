/**
 * Calendar note document model.
 *
 * A Calendar note stores a flat list of dated events. Each event has an ISO
 * date (YYYY-MM-DD), a title, and an optional color. The editor renders a month
 * grid and lets you add/edit/delete events on a given day.
 *
 * Exactly like the Canvas, Base, and Sandbox note types, the serialized document
 * is stored verbatim in `note.text` (the same slot Super stores its Lexical JSON
 * in). This keeps a Calendar note round-tripping and syncing like any other note
 * with no models/snjs changes — the note is marked as a calendar purely via
 * `note.editorIdentifier`.
 */

export const CALENDAR_DOCUMENT_VERSION = 1

export type CalendarEvent = {
  id: string
  /** ISO date string, normalized to YYYY-MM-DD (day granularity). */
  date: string
  title: string
  /** Optional CSS color string for the event chip. */
  color?: string
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

const sanitizeEvent = (raw: unknown): CalendarEvent | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }
  const date = normalizeEventDate(candidate.date)
  if (!date) {
    return null
  }
  return {
    id: candidate.id,
    date,
    title: isString(candidate.title) ? candidate.title : '',
    color: isString(candidate.color) ? candidate.color : undefined,
  }
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
