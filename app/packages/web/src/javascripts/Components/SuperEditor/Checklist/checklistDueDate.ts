const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export const CHECKLIST_DUE_TICK_MS = MINUTE_MS
export const CHECKLIST_DUE_FORMATTER_CACHE_SIZE = 16

const dueFormatterCache = new Map<string, Intl.DateTimeFormat>()

export type ChecklistDueState = 'completed' | 'overdue' | 'due-soon' | 'upcoming'

export type ChecklistDueDisplay = {
  dueAt: string
  state: ChecklistDueState
  dateLabel: string
  relativeLabel: string
  accessibleLabel: string
}

const EXPLICIT_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Accept only a real instant and always return its canonical UTC representation.
 * This keeps serialized notes timezone-independent while the UI remains local.
 */
export function normalizeChecklistDueAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return undefined
  }
  const match = EXPLICIT_DATE_TIME.exec(value)
  if (!match) {
    return undefined
  }
  const [, yearPart, monthPart, dayPart, hourPart, minutePart, secondPart] = match
  const year = Number(yearPart)
  const month = Number(monthPart)
  const day = Number(dayPart)
  const hour = Number(hourPart)
  const minute = Number(minutePart)
  const second = Number(secondPart)
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    year < 1970 ||
    year > 9999 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return undefined
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  const date = new Date(timestamp)
  const utcYear = date.getUTCFullYear()
  if (utcYear < 1970 || utcYear > 9999) {
    return undefined
  }
  return date.toISOString()
}

/**
 * Convert a browser wall-clock schedule value into a canonical UTC instant.
 *
 * Two shapes are accepted:
 *  - `YYYY-MM-DDTHH:mm` — a full `datetime-local` value.
 *  - `YYYY-MM-DD` — a DATE-ONLY value, produced when the schedule's optional
 *    time field is left blank. The time then defaults to **00:00 in the user's
 *    LOCAL time zone**, matching the rest of this module: the UI is local and
 *    only the serialized `dueAt` is UTC.
 *
 * Repeated autumn wall times use ECMAScript's earlier-fold disambiguation;
 * skipped spring wall times fail the round-trip check below. A *defaulted*
 * midnight is the one exception — see below.
 *
 * Note the data model stores a single instant, so "no time given" and "time
 * given as 00:00" deliberately converge on the same `dueAt`; there is no
 * date-only state to round-trip back to.
 */
export function checklistDueAtFromLocalInput(value: string): string | undefined {
  const dateOnly = LOCAL_DATE.exec(value)
  const match = dateOnly ?? LOCAL_DATE_TIME.exec(value)
  if (!match) {
    return undefined
  }
  const [, yearPart, monthPart, dayPart, hourPart, minutePart] = match
  const year = Number(yearPart)
  const month = Number(monthPart)
  const day = Number(dayPart)
  const hour = dateOnly ? 0 : Number(hourPart)
  const minute = dateOnly ? 0 : Number(minutePart)
  if (year < 1970 || year > 9999) {
    return undefined
  }

  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    // Calendar overflow, and days a DST jump deletes outright, must fail
    // instead of silently changing the user's requested deadline.
    return undefined
  }
  if (!dateOnly && (date.getHours() !== hour || date.getMinutes() !== minute)) {
    // An explicitly typed wall time skipped by a DST transition still fails:
    // the user asked for a time that does not exist on that day.
    return undefined
  }
  // A DEFAULTED midnight is different. Some zones spring forward at 00:00, so
  // that wall time does not exist there; the day still does, and its first real
  // instant is exactly what "this date, no time" means. `new Date` has already
  // shifted to it, and the date check above proved we stayed on the same day.
  return normalizeChecklistDueAt(date.toISOString())
}

/** Convert a UTC instant to the wall-clock value expected by `datetime-local`. */
export function checklistDueAtToLocalInput(value: string): string {
  const normalized = normalizeChecklistDueAt(value)
  if (!normalized) {
    return ''
  }
  const date = new Date(normalized)
  const part = (number: number) => number.toString().padStart(2, '0')
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`
}

/**
 * Split a wall-clock `YYYY-MM-DDTHH:mm` value into the halves shown by the
 * schedule form's separate date and time fields. An empty value yields two
 * empty halves, so a cleared schedule clears both fields.
 */
export function splitChecklistDueLocalInput(value: string): { date: string; time: string } {
  const separator = value.indexOf('T')
  return separator === -1
    ? { date: value, time: '' }
    : { date: value.slice(0, separator), time: value.slice(separator + 1) }
}

/**
 * Recombine the schedule form's date field with its OPTIONAL time field. A
 * blank time yields a date-only value, which
 * {@link checklistDueAtFromLocalInput} resolves to local 00:00.
 */
export function composeChecklistDueLocalInput(date: string, time: string): string {
  const trimmedDate = date.trim()
  const trimmedTime = time.trim()
  if (trimmedDate.length === 0) {
    return ''
  }
  return trimmedTime.length === 0 ? trimmedDate : `${trimmedDate}T${trimmedTime}`
}

/** Preserve the exact instant (including fold offset and sub-minute precision) when an editor draft is unchanged. */
export function resolveChecklistDueAtLocalInput(
  value: string,
  expectedValue?: string,
  expectedLocalValue?: string,
): string | undefined {
  const expected = normalizeChecklistDueAt(expectedValue)
  if (expected && (expectedLocalValue ?? checklistDueAtToLocalInput(expected)) === value) {
    return expected
  }
  return checklistDueAtFromLocalInput(value)
}

function compactDuration(milliseconds: number): string {
  const absolute = Math.max(0, milliseconds)
  const totalMinutes = Math.ceil(absolute / MINUTE_MS)
  if (totalMinutes === 0) {
    return '0m'
  }
  const days = Math.floor(totalMinutes / (DAY_MS / MINUTE_MS))
  const afterDays = totalMinutes % (DAY_MS / MINUTE_MS)
  const hours = Math.floor(afterDays / (HOUR_MS / MINUTE_MS))
  const minutes = afterDays % (HOUR_MS / MINUTE_MS)

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (hours > 0) {
    return minutes > 0 && minutes < 60 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return `${minutes}m`
}

function checklistDueFormatter(locale?: string): Intl.DateTimeFormat {
  const key = locale ?? ''
  const cached = dueFormatterCache.get(key)
  if (cached) {
    dueFormatterCache.delete(key)
    dueFormatterCache.set(key, cached)
    return cached
  }
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  if (dueFormatterCache.size >= CHECKLIST_DUE_FORMATTER_CACHE_SIZE) {
    const oldest = dueFormatterCache.keys().next()
    if (!oldest.done) {
      dueFormatterCache.delete(oldest.value)
    }
  }
  dueFormatterCache.set(key, formatter)
  return formatter
}

export function formatChecklistDue(
  value: string,
  checked: boolean,
  now = Date.now(),
  locale?: string,
): ChecklistDueDisplay | undefined {
  const dueAt = normalizeChecklistDueAt(value)
  if (!dueAt) {
    return undefined
  }

  const dueTimestamp = Date.parse(dueAt)
  const delta = dueTimestamp - now
  const dateLabel = checklistDueFormatter(locale).format(new Date(dueTimestamp))

  let state: ChecklistDueState
  let relativeLabel: string
  if (checked) {
    state = 'completed'
    relativeLabel = 'Completed'
  } else if (delta <= 0) {
    state = 'overdue'
    relativeLabel = `Overdue by ${compactDuration(Math.abs(delta))}`
  } else if (delta <= DAY_MS) {
    state = 'due-soon'
    relativeLabel = `${compactDuration(delta)} left`
  } else {
    state = 'upcoming'
    relativeLabel = `${compactDuration(delta)} left`
  }

  return {
    dueAt,
    state,
    dateLabel,
    relativeLabel,
    accessibleLabel: `Due ${dateLabel}; ${relativeLabel}`,
  }
}

/** Static semantic export text shared by print, PDF, DOCX and ODT. */
export function checklistDueExportText(value: string, checked: boolean, now = Date.now()): string | undefined {
  const display = formatChecklistDue(value, checked, now)
  // The localized label is friendly but does not identify a timezone. Preserve
  // it for readability and include the canonical UTC instant so portable files
  // remain unambiguous when opened on another device or in another locale.
  return display ? `Due ${display.dateLabel} [${display.dueAt}] (${display.relativeLabel})` : undefined
}
