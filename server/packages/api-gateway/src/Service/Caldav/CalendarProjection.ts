/**
 * Standard Red Notes: project a published TASK (VTODO) onto a calendar EVENT
 * (VEVENT), under per-user settings.
 *
 * WHY THIS EXISTS: the CalDAV feed has always served VTODO, which is the
 * correct component for a task but is *not* what a calendar grid draws. Google
 * Calendar ignores VTODO outright and Apple routes it to Reminders, so a user
 * who asked to "see my due dates in my calendar" sees nothing. This module
 * derives a second, EVENT-shaped view of the same stored records so the dates
 * land on the grid, while the VTODO collection stays exactly as it was for task
 * clients.
 *
 * It is PURE: no clock, no I/O. The projection of a stored record is a function
 * of that record and the user's settings and nothing else — which is what keeps
 * the strong ETags the DAV router computes over the serialization truthful. A
 * time-dependent axis (for example "only project the next 30 days") was
 * deliberately NOT added for exactly this reason: it would make the feed body,
 * and therefore its ETag, change with no data change, and every polling client
 * would re-download on every poll. Limiting WHICH tasks are exposed is the
 * publishing client's job, where it also keeps plaintext off the server.
 */

/** How a deadline with no obvious time-of-day becomes an all-day event. */
export type CalendarProjectionAllDayMode = 'auto' | 'always' | 'never'

/** Whether the deadline instant is the event's start or its end. */
export type CalendarProjectionAnchor = 'start' | 'end'

/** What a completed task's event looks like, if it exists at all. */
export type CalendarProjectionCompletedMode = 'hide' | 'show' | 'mark'

/** Whether an event carries a VALARM, and relative to what. */
export type CalendarProjectionAlarmMode = 'none' | 'at-time' | 'lead'

/** How a repeating task becomes one or more events. */
export type CalendarProjectionRecurrenceMode = 'ignore' | 'rrule' | 'first-only'

export interface CalendarProjectionSettings {
  /** Master per-user switch. OFF by default: see `DEFAULT_CALENDAR_PROJECTION`. */
  enabled: boolean
  allDay: CalendarProjectionAllDayMode
  /** Length of a TIMED event, in minutes. Ignored for all-day events. */
  durationMinutes: number
  anchor: CalendarProjectionAnchor
  /**
   * IANA zone used to decide which local DATE an instant falls on, and whether
   * it is local midnight. Empty string means UTC.
   */
  timeZone: string
  completed: CalendarProjectionCompletedMode
  alarm: CalendarProjectionAlarmMode
  alarmLeadMinutes: number
  recurrence: CalendarProjectionRecurrenceMode
  /** Literal text prefixed to every projected SUMMARY. */
  summaryPrefix: string
}

export const CALENDAR_PROJECTION_MIN_DURATION_MINUTES = 5
export const CALENDAR_PROJECTION_MAX_DURATION_MINUTES = 1_440
export const CALENDAR_PROJECTION_MAX_LEAD_MINUTES = 10_080
export const CALENDAR_PROJECTION_MAX_SUMMARY_PREFIX_LENGTH = 32

/**
 * OFF, and conservative in every axis.
 *
 * Turning this on changes what every already-subscribed calendar client draws,
 * and it adds a second component for each published task. Neither is a change a
 * server may make on a user's behalf, so the default is "no events at all".
 * Once on: `hide` completed (a finished task on next week's grid is noise),
 * no alarm (an alarm rings a phone — never opt a user into that), and `rrule`
 * (one repeating event rather than a wall of copies).
 */
export const DEFAULT_CALENDAR_PROJECTION: CalendarProjectionSettings = {
  enabled: false,
  allDay: 'auto',
  durationMinutes: 60,
  anchor: 'end',
  timeZone: '',
  completed: 'hide',
  alarm: 'none',
  alarmLeadMinutes: 15,
  recurrence: 'rrule',
  summaryPrefix: '',
}

/**
 * The repeat rule carried by a published task.
 *
 * This is a reduced form of the editor's `ChecklistRecurrence`: the publishing
 * client folds its `custom` interval+unit pair into `frequency` + `interval`, so
 * the server validates five frequencies rather than six plus a unit. `monthDay`
 * and `month` are the editor's wall-clock ANCHOR fields, which is what the
 * monthly/yearly rules are computed from — not the day the deadline happens to
 * land on after clamping.
 */
export interface PublishedTodoRecurrence {
  frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
  /** Repeat every `interval` units. 1..999. Not applicable to `weekdays`. */
  interval?: number
  /** Anchor day-of-month, 1..31. Drives the monthly/yearly rule. */
  monthDay?: number
  /** Anchor month, 1..12. Drives the yearly rule. */
  month?: number
  /**
   * The IANA zone the anchor wall time was authored in. Diagnostics only — it is
   * emitted as `X-SRN-TZID` so the DST caveat documented on
   * {@link checklistRecurrenceToRRule} is visible in the feed itself.
   */
  timeZone?: string
}

export const PUBLISHED_TODO_RECURRENCE_KEYS = ['frequency', 'interval', 'monthDay', 'month', 'timeZone'] as const

const RECURRENCE_FREQUENCIES: readonly PublishedTodoRecurrence['frequency'][] = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'yearly',
]

export const PUBLISHED_TODO_RECURRENCE_MAX_INTERVAL = 999

/** An event ready for serialization. All instants are canonical UTC ISO strings. */
export interface ProjectedEvent {
  /**
   * Distinct from the task's own UID on purpose. The event and the task are two
   * calendar objects describing the same work; a client that merges collections
   * by UID must not conflate them.
   */
  uid: string
  summary: string
  description?: string
  categories?: string[]
  allDay: boolean
  /** All-day only: inclusive start date and EXCLUSIVE end date (RFC 5545 §3.8.2.2). */
  startDate?: string
  endDate?: string
  /** Timed only. */
  startAt?: string
  endAt?: string
  /** True when the task is complete and `completed` is `mark`. */
  cancelled: boolean
  /** RRULE value (without the property name), when one was derivable. */
  rrule?: string
  /** Minutes BEFORE the deadline an alarm fires; absent when there is no alarm. */
  alarmLeadMinutes?: number
  /** Anchored to the deadline end rather than the start. */
  alarmRelatedToEnd?: boolean
  /** Echoed from the recurrence anchor for diagnosability. */
  recurrenceTimeZone?: string
  priority?: number
  createdAt?: number
  updatedAt?: number
}

/** The shape {@link projectTodoToEvent} reads. A structural subset of `PublishedTodo`. */
export interface ProjectableTodo {
  uid: string
  summary: string
  description?: string
  due?: string
  completed?: boolean
  priority?: number
  categories?: string[]
  recurrence?: PublishedTodoRecurrence
  createdAt?: number
  updatedAt?: number
}

export const PROJECTED_EVENT_UID_PREFIX = 'srn-due-'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const MINUTE_MS = 60_000

function clampedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  const rounded = Math.round(value)
  if (!Number.isSafeInteger(rounded)) {
    return fallback
  }
  return Math.min(maximum, Math.max(minimum, rounded))
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * True for a zone name this runtime can actually resolve.
 *
 * A stored zone that the runtime cannot resolve must not be kept: every later
 * read would throw inside the formatter, and a projection that throws takes the
 * whole feed down rather than one event.
 */
export function isSupportedTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64 || !/^[A-Za-z0-9+_./-]+$/.test(value)) {
    return false
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Coerce stored/submitted settings into a complete, usable set.
 *
 * Every field falls back INDEPENDENTLY to its default rather than the whole
 * object being rejected: a settings file that gained one unreadable field must
 * not silently revert the other eight to defaults, which would look exactly
 * like the user's choices never being saved.
 */
export function normalizeCalendarProjectionSettings(value: unknown): CalendarProjectionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_CALENDAR_PROJECTION }
  }
  const raw = value as Record<string, unknown>
  const timeZone = typeof raw.timeZone === 'string' && isSupportedTimeZone(raw.timeZone) ? raw.timeZone : ''
  const prefix = typeof raw.summaryPrefix === 'string' ? raw.summaryPrefix : ''
  return {
    enabled: raw.enabled === true,
    allDay: oneOf(raw.allDay, ['auto', 'always', 'never'], DEFAULT_CALENDAR_PROJECTION.allDay),
    durationMinutes: clampedInteger(
      raw.durationMinutes,
      CALENDAR_PROJECTION_MIN_DURATION_MINUTES,
      CALENDAR_PROJECTION_MAX_DURATION_MINUTES,
      DEFAULT_CALENDAR_PROJECTION.durationMinutes,
    ),
    anchor: oneOf(raw.anchor, ['start', 'end'], DEFAULT_CALENDAR_PROJECTION.anchor),
    timeZone,
    completed: oneOf(raw.completed, ['hide', 'show', 'mark'], DEFAULT_CALENDAR_PROJECTION.completed),
    alarm: oneOf(raw.alarm, ['none', 'at-time', 'lead'], DEFAULT_CALENDAR_PROJECTION.alarm),
    alarmLeadMinutes: clampedInteger(
      raw.alarmLeadMinutes,
      0,
      CALENDAR_PROJECTION_MAX_LEAD_MINUTES,
      DEFAULT_CALENDAR_PROJECTION.alarmLeadMinutes,
    ),
    recurrence: oneOf(raw.recurrence, ['ignore', 'rrule', 'first-only'], DEFAULT_CALENDAR_PROJECTION.recurrence),
    // Control characters would break content-line folding, and a runaway prefix
    // would push the real title out of a client's row.
    summaryPrefix: prefix.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, CALENDAR_PROJECTION_MAX_SUMMARY_PREFIX_LENGTH),
  }
}

export function normalizePublishedTodoRecurrence(value: unknown): PublishedTodoRecurrence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!(PUBLISHED_TODO_RECURRENCE_KEYS as readonly string[]).includes(key)) {
      return undefined
    }
  }
  const frequency = raw.frequency
  if (typeof frequency !== 'string' || !(RECURRENCE_FREQUENCIES as readonly string[]).includes(frequency)) {
    return undefined
  }
  const interval = raw.interval
  if (
    interval !== undefined &&
    (typeof interval !== 'number' ||
      !Number.isSafeInteger(interval) ||
      interval < 1 ||
      interval > PUBLISHED_TODO_RECURRENCE_MAX_INTERVAL)
  ) {
    return undefined
  }
  const monthDay = raw.monthDay
  if (
    monthDay !== undefined &&
    (typeof monthDay !== 'number' || !Number.isSafeInteger(monthDay) || monthDay < 1 || monthDay > 31)
  ) {
    return undefined
  }
  const month = raw.month
  if (month !== undefined && (typeof month !== 'number' || !Number.isSafeInteger(month) || month < 1 || month > 12)) {
    return undefined
  }
  const timeZone = raw.timeZone
  if (timeZone !== undefined && (typeof timeZone !== 'string' || !isSupportedTimeZone(timeZone))) {
    return undefined
  }
  return {
    frequency: frequency as PublishedTodoRecurrence['frequency'],
    ...(interval !== undefined && interval !== 1 ? { interval: interval as number } : {}),
    ...(monthDay !== undefined ? { monthDay: monthDay as number } : {}),
    ...(month !== undefined ? { month: month as number } : {}),
    ...(timeZone !== undefined ? { timeZone: timeZone as string } : {}),
  }
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>()

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const key = timeZone
  const cached = zonedFormatters.get(key)
  if (cached) {
    return cached
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone.length > 0 ? timeZone : 'UTC',
    hour12: false,
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  // Bounded: a zone name only reaches here after isSupportedTimeZone, and the
  // settings store holds one zone per user.
  if (zonedFormatters.size >= 64) {
    const oldest = zonedFormatters.keys().next()
    if (!oldest.done) {
      zonedFormatters.delete(oldest.value)
    }
  }
  zonedFormatters.set(key, formatter)
  return formatter
}

/**
 * The wall-clock parts of an instant in `timeZone` (UTC when blank).
 *
 * `hour` is normalized out of the `24` some ICU builds report for midnight, and
 * a BC era yields `undefined` rather than a positive year that would silently
 * move the date by thousands of years.
 */
export function zonedPartsOf(timestamp: number, timeZone: string): ZonedParts | undefined {
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  const parts = zonedFormatter(timeZone).formatToParts(new Date(timestamp))
  const read = (type: string): string | undefined => parts.find((part) => part.type === type)?.value
  const era = read('era')
  if (era !== undefined && !/^A/i.test(era)) {
    return undefined
  }
  const numbers = (['year', 'month', 'day', 'hour', 'minute', 'second'] as const).map((type) => {
    const text = read(type)
    return text === undefined ? Number.NaN : Number(text)
  })
  if (numbers.some((number) => !Number.isFinite(number))) {
    return undefined
  }
  const [year, month, day, hour, minute, second] = numbers
  return { year, month, day, hour: hour === 24 ? 0 : hour, minute, second }
}

function pad(value: number, width = 2): string {
  return `${value}`.padStart(width, '0')
}

function isoDate(parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): string {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`
}

/** Add `days` to a YYYY-MM-DD value, returning YYYY-MM-DD. */
export function addCalendarDays(date: string, days: number): string | undefined {
  const match = DATE_ONLY.exec(date)
  if (!match) {
    return undefined
  }
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  if (!Number.isFinite(shifted.getTime())) {
    return undefined
  }
  const year = shifted.getUTCFullYear()
  if (year < 1 || year > 9999) {
    return undefined
  }
  return isoDate({ year, month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() })
}

/**
 * The first instant of a local calendar date in `timeZone` (UTC when blank).
 *
 * Needed because a record published as a DATE needs a real instant before it can
 * become a TIMED event under `allDay: 'never'`. The search is over the smallest
 * `t` whose local date is not before the target, which is the definition that
 * stays correct through a DST transition: in a zone that springs forward AT
 * midnight that wall time does not exist, but the DAY does, and its first real
 * instant is exactly what "this date, no time" means. A two-pass offset estimate
 * would land an hour out in that case.
 *
 * Bounded: a ±2 day window at minute granularity is ~12 bisection steps.
 */
export function firstInstantOfZonedDate(date: string, timeZone: string): number | undefined {
  const match = DATE_ONLY.exec(date)
  if (!match) {
    return undefined
  }
  const target = `${match[1]}-${match[2]}-${match[3]}`
  const midnightUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (!Number.isFinite(midnightUtc)) {
    return undefined
  }
  const notBefore = (timestamp: number): boolean | undefined => {
    const parts = zonedPartsOf(timestamp, timeZone)
    return parts === undefined ? undefined : isoDate(parts) >= target
  }
  const DAY_MS = 86_400_000
  let low = midnightUtc - 2 * DAY_MS
  let high = midnightUtc + 2 * DAY_MS
  if (notBefore(low) !== false || notBefore(high) !== true) {
    // The target day is not inside the window at all, which can only happen for
    // an out-of-range date; refuse rather than return a plausible wrong instant.
    return undefined
  }
  while (high - low > 60_000) {
    const middle = low + Math.floor((high - low) / 2 / 60_000) * 60_000
    if (middle <= low || middle >= high) {
      break
    }
    const answer = notBefore(middle)
    if (answer === undefined) {
      return undefined
    }
    if (answer) {
      high = middle
    } else {
      low = middle
    }
  }
  return high
}

const WEEKDAY_BYDAY = 'MO,TU,WE,TH,FR'

/**
 * Translate a published repeat rule into an RFC 5545 RRULE value, or return
 * `undefined` when no faithful rule exists.
 *
 * ## Where this is EXACT and where it is not
 *
 * `daily`, `weekly` and the day/week intervals the editor folds into them are a
 * plain `FREQ` + `INTERVAL`; `weekdays` is `FREQ=WEEKLY;BYDAY=MO..FR`, and the
 * editor's own `addWeekdays` already lands the first occurrence on a weekday, so
 * DTSTART is a legal first instance.
 *
 * `monthly` and `yearly` need care. The editor computes
 * `day: Math.min(anchor.day, lastDayOfMonth)`, i.e. it CLAMPS into short months.
 * A plain `FREQ=MONTHLY` anchored on the 31st does the opposite — RFC 5545 SKIPS
 * months that have no 31st — so a task due on the 31st would lose February
 * entirely in a client and gain a 28 February here. `BYMONTHDAY=<d>,-1` with
 * `BYSETPOS=1` reproduces the clamp exactly: in a long enough month the
 * candidate set is {d, lastDay} and the first is `d`; in a short month `d` is
 * not a valid day, the set collapses to {lastDay}, and the first is `lastDay`.
 * That extra machinery is only emitted when it can matter (`anchor.day >= 29`),
 * so the common case stays a rule every client renders.
 *
 * ## The one documented inaccuracy: DST
 *
 * The editor anchors a repeat to a WALL TIME in `anchor.timeZone` and recomputes
 * the instant for each occurrence, so 09:00 stays 09:00 across a DST change. An
 * RRULE's instances inherit DTSTART's time-of-day, and this serializer emits a
 * UTC DTSTART, so in a DST zone a TIMED repeating event drifts by the offset for
 * half the year. It is exact for all-day repeats (floating dates) and in zones
 * without DST. The anchor zone is emitted as `X-SRN-TZID` so the drift is
 * diagnosable, and `recurrence: 'first-only'` exists for a user who will not
 * accept it. Emitting `DTSTART;TZID=` instead would require a `VTIMEZONE`
 * component, and a VTIMEZONE with guessed transition rules is worse than an
 * honest UTC instant.
 */
export function recurrenceToRRule(recurrence: PublishedTodoRecurrence): string | undefined {
  const interval = recurrence.interval ?? 1
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > PUBLISHED_TODO_RECURRENCE_MAX_INTERVAL) {
    return undefined
  }
  const intervalPart = interval > 1 ? `;INTERVAL=${interval}` : ''
  switch (recurrence.frequency) {
    case 'daily':
      return `FREQ=DAILY${intervalPart}`
    case 'weekly':
      return `FREQ=WEEKLY${intervalPart}`
    case 'weekdays':
      // An interval on a weekday rule has no meaning in the editor's model
      // (`addWeekdays` steps one weekday at a time), so none is emitted.
      return `FREQ=WEEKLY;BYDAY=${WEEKDAY_BYDAY}`
    case 'monthly': {
      const day = recurrence.monthDay
      if (day === undefined) {
        return `FREQ=MONTHLY${intervalPart}`
      }
      return day <= 28 ? `FREQ=MONTHLY${intervalPart}` : `FREQ=MONTHLY${intervalPart};BYMONTHDAY=${day},-1;BYSETPOS=1`
    }
    case 'yearly': {
      const day = recurrence.monthDay
      const month = recurrence.month
      if (day === undefined || month === undefined || day <= 28) {
        return `FREQ=YEARLY${intervalPart}`
      }
      return `FREQ=YEARLY${intervalPart};BYMONTH=${month};BYMONTHDAY=${day},-1;BYSETPOS=1`
    }
  }
}

function utcIso(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  const date = new Date(timestamp)
  const year = date.getUTCFullYear()
  return year >= 1 && year <= 9999 ? date.toISOString() : undefined
}

/**
 * Decide whether a deadline is an all-day one.
 *
 * `always` / `never` are literal. `auto` is the interesting case, and it has to
 * INFER, because the editor does not record the distinction: `srnChecklistDueAt`
 * is always a full instant and a blank time field is deliberately collapsed to
 * local 00:00 (see `checklistDueAtFromLocalInput`). Local midnight in the
 * projection zone is therefore exactly the fingerprint of "a date, no time", and
 * it is the only signal available. A record published as a DATE-ONLY string
 * needs no inference at all and is always all-day.
 */
export function isAllDayDeadline(due: string, settings: CalendarProjectionSettings): boolean | undefined {
  if (DATE_ONLY.test(due)) {
    // `never` means never, including for a record that was published as a plain
    // date: it becomes a block starting at the first instant of that day. An
    // axis that silently did nothing for half the records would be exactly the
    // "setting that compiles and has no effect" this projection must not have.
    return settings.allDay !== 'never'
  }
  const timestamp = Date.parse(due)
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  if (settings.allDay === 'always') {
    return true
  }
  if (settings.allDay === 'never') {
    return false
  }
  const parts = zonedPartsOf(timestamp, settings.timeZone)
  if (!parts) {
    return undefined
  }
  return parts.hour === 0 && parts.minute === 0 && parts.second === 0 && timestamp % 1_000 === 0
}

/**
 * Project one published task onto an event, or `null` when the settings say it
 * should not become one.
 *
 * Returning `null` rather than throwing keeps one unprojectable record from
 * emptying the whole feed.
 */
export function projectTodoToEvent(todo: ProjectableTodo, settings: CalendarProjectionSettings): ProjectedEvent | null {
  if (!settings.enabled) {
    return null
  }
  // An event without a date is not an event. A task with no deadline stays a
  // VTODO only, which is the component that can represent it.
  if (todo.due === undefined || todo.due.length === 0) {
    return null
  }
  const isCompleted = todo.completed === true
  if (isCompleted && settings.completed === 'hide') {
    return null
  }
  if (todo.recurrence !== undefined && settings.recurrence === 'ignore') {
    return null
  }
  const summary = todo.summary.trim()
  if (summary.length === 0) {
    return null
  }

  const allDay = isAllDayDeadline(todo.due, settings)
  if (allDay === undefined) {
    return null
  }

  const rrule =
    todo.recurrence !== undefined && settings.recurrence === 'rrule' ? recurrenceToRRule(todo.recurrence) : undefined

  const base: ProjectedEvent = {
    uid: `${PROJECTED_EVENT_UID_PREFIX}${todo.uid}`,
    summary: `${settings.summaryPrefix}${summary}`,
    ...(todo.description !== undefined ? { description: todo.description } : {}),
    ...(todo.categories !== undefined && todo.categories.length > 0 ? { categories: [...todo.categories] } : {}),
    allDay,
    cancelled: isCompleted && settings.completed === 'mark',
    ...(rrule !== undefined ? { rrule } : {}),
    ...(todo.recurrence?.timeZone !== undefined ? { recurrenceTimeZone: todo.recurrence.timeZone } : {}),
    ...(todo.priority !== undefined ? { priority: todo.priority } : {}),
    ...(todo.createdAt !== undefined ? { createdAt: todo.createdAt } : {}),
    ...(todo.updatedAt !== undefined ? { updatedAt: todo.updatedAt } : {}),
  }

  if (settings.alarm !== 'none') {
    base.alarmLeadMinutes = settings.alarm === 'at-time' ? 0 : settings.alarmLeadMinutes
    // The alarm is relative to the DEADLINE, which is whichever edge the anchor
    // put it on. An alarm hung off the other edge would fire a duration early or
    // late without anything in the UI saying so.
    base.alarmRelatedToEnd = !allDay && settings.anchor === 'end'
  }

  if (allDay) {
    const startDate = DATE_ONLY.test(todo.due)
      ? todo.due
      : (() => {
          const parts = zonedPartsOf(Date.parse(todo.due), settings.timeZone)
          return parts ? isoDate(parts) : undefined
        })()
    if (startDate === undefined) {
      return null
    }
    // RFC 5545 §3.8.2.2: an all-day DTEND is EXCLUSIVE, so a single-day event
    // ends on the following date. Clients that read DTEND inclusively would
    // otherwise draw nothing.
    const endDate = addCalendarDays(startDate, 1)
    if (endDate === undefined) {
      return null
    }
    return { ...base, startDate, endDate }
  }

  // A DATE-ONLY record reaching here means `allDay: 'never'`. Its deadline is
  // the first instant of that day in the projection zone.
  const deadline = DATE_ONLY.test(todo.due)
    ? firstInstantOfZonedDate(todo.due, settings.timeZone)
    : Date.parse(todo.due)
  if (deadline === undefined || !Number.isFinite(deadline)) {
    return null
  }
  const durationMs = settings.durationMinutes * MINUTE_MS
  const startAt = utcIso(settings.anchor === 'end' ? deadline - durationMs : deadline)
  const endAt = utcIso(settings.anchor === 'end' ? deadline : deadline + durationMs)
  if (startAt === undefined || endAt === undefined) {
    return null
  }
  return { ...base, startAt, endAt }
}

/** Project a whole collection, dropping the records the settings exclude. */
export function projectTodosToEvents(
  todos: readonly ProjectableTodo[],
  settings: CalendarProjectionSettings,
): ProjectedEvent[] {
  const events: ProjectedEvent[] = []
  for (const todo of todos) {
    const event = projectTodoToEvent(todo, settings)
    if (event) {
      events.push(event)
    }
  }
  return events
}
