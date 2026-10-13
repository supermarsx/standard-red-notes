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
 *
 * ## A reader keeps what it does not understand
 *
 * Desktop and mobile builds lag the web build, so a calendar note is routinely
 * opened by a build older than the one that last wrote it. A reader that drops
 * the fields it does not know erases them for every device the next time it
 * saves. So reading here never discards: a key this build does not recognise is
 * carried in `unknownFields` (on the event or on the document), an entry of
 * `events` it cannot use as an event is carried in `unrecognizedEntries`, and
 * {@link serializeCalendarDocument} writes both back where they were. Known keys
 * are still validated and normalised exactly as before.
 *
 * ## Version 2: enough to hold a calendar from another app
 *
 * Version 1 has "a day" and "an instant". A calendar made elsewhere also has
 * events that last several days, times that belong to a zone, times that belong
 * to none, a description, a place, and repeat rules far beyond "every N weeks".
 * Version 2 adds those, under two rules that keep older builds harmless:
 *
 *  - Every version 1 key keeps its meaning. A timed event still has `start` and
 *    `end` as UTC instants, so an older build shows it at the right moment, and
 *    an all-day event still has its first day in `date`.
 *  - `localStart` and `zone` say how the event's own calendar reads the clock.
 *    They are what this build shows and compares; the instants beside them are
 *    the same moments for builds that know only version 1. Keeping the wall
 *    time, rather than deriving it from the instant on each device, is what
 *    stops two devices with different zone databases from disagreeing about an
 *    event neither of them changed.
 *  - When an older build changes an event, what the person did there wins. Such
 *    a build can only change version 1 keys, so `localOf` records which
 *    instants the wall times were worked out for: once `start` or `end` no
 *    longer match it, the instants are what the person set and the wall times
 *    are read afresh from them. And an all-day event's length is kept as a
 *    count of days, not as an end day, so moving its `date` moves all of it.
 *  - `recurrence` and `rrule` are never both present.
 */

import {
  addDays,
  daysBetween,
  daysInRange,
  deviceZone,
  instantToWall,
  isIsoDate,
  isKnownZone,
  isWallTime,
  utcMsFromWall,
  wallFromUtcMs,
  wallToInstant,
} from '@/Timezone/wallClock'

export const CALENDAR_DOCUMENT_VERSION = 2

/** Keys a reader did not recognise, with the values exactly as they were stored. */
export type CalendarUnknownFields = Record<string, unknown>

/**
 * An entry of the stored `events` array that this build cannot show as an event
 * (no usable id or date, or an id an earlier entry already has). It is not
 * rendered and not editable, and it is written back at `position`, its index in
 * the stored array.
 */
export type CalendarUnrecognizedEntry = {
  position: number
  raw: unknown
}

export type CalendarRecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** A simple repeat rule. `interval` defaults to 1 (every period) when omitted. */
export type CalendarRecurrence = {
  freq: CalendarRecurrenceFreq
  /** Repeat every `interval` periods of `freq` (>= 1). */
  interval?: number
}

export type CalendarEventStatus = 'tentative' | 'confirmed' | 'cancelled'

/**
 * What one occurrence of an event looks like: the version 2 keys an event and a
 * changed occurrence of a series have in common.
 */
export type CalendarOccurrenceFields = {
  /**
   * All-day events only: how many days the event lasts, when more than one. A
   * length and not an end day, so that an older build which moves `date` moves
   * the whole event.
   */
  days?: number
  /**
   * Timed events only: the zone whose clock the event is read on. `UTC`, an
   * IANA name, or the name of a zone defined by the calendar the event came
   * from. Absent on an event made by the version 1 editor, which is read on the
   * clock of whichever device shows it.
   */
  zone?: string
  /** The zone `localEnd` is read in, when it is not `zone` (a flight, say). */
  endZone?: string
  /**
   * The event is tied to no zone at all: "09:00, wherever you are". `zone` then
   * only fixes the instant stored in `start` for builds that know nothing else.
   */
  floating?: boolean
  /** The start as its own calendar's clock shows it: `YYYY-MM-DDTHH:MM:SS` in `zone`. */
  localStart?: string
  /** The end, likewise, in `endZone` or else `zone`. */
  localEnd?: string
  description?: string
  location?: string
  status?: CalendarEventStatus
  /**
   * Present when the title, description or location held here is the beginning
   * of a longer text kept on the calendar the event came from: a digest of the
   * whole. Such a text is not edited here.
   */
  clipped?: string
}

/** One occurrence of a repeating event that was changed on its own. */
export type CalendarOccurrenceOverride = CalendarOccurrenceFields & {
  /**
   * The occurrence this replaces, as the series' own clock names it: YYYY-MM-DD
   * for an all-day series, else a wall time in the series' zone.
   */
  rid: string
  /** The day this occurrence now starts on, on its own calendar's clock. */
  date: string
  title: string
  unknownFields?: CalendarUnknownFields
}

export type CalendarEvent = CalendarOccurrenceFields & {
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
  /**
   * The instants `localStart` and `localEnd` were worked out for, in whole
   * seconds since the epoch: `[start]` or `[start, end]`. While `start` and
   * `end` still match it, the wall times stand, whatever this device's zone
   * database would make of them. Once they do not, a build that knows only
   * version 1 has changed the event, and the instants are what the person set.
   */
  localOf?: number[]
  /**
   * A repeat rule the simple form above cannot express, as an iCalendar RRULE
   * value (`FREQ=MONTHLY;BYDAY=-1FR`). Never present together with `recurrence`.
   */
  rrule?: string
  /** Occurrences taken out of the series, named as `rid` is. A bare date takes out that whole day. */
  exdates?: string[]
  /** Occurrences added to the series, named as `rid` is. */
  rdates?: string[]
  /** Occurrences that were changed on their own. */
  overrides?: CalendarOccurrenceOverride[]
  /** Other people are invited to this event on the calendar it came from. */
  guests?: boolean
  /** The event has a reminder on the calendar it came from. */
  alarm?: boolean
  /** Stored keys this build does not know. Never read, always written back. */
  unknownFields?: CalendarUnknownFields
}

export type CalendarDocument = {
  version: number
  events: CalendarEvent[]
  /** Stored top-level keys this build does not know. Never read, always written back. */
  unknownFields?: CalendarUnknownFields
  /** Stored entries of `events` this build cannot show. Never read, always written back. */
  unrecognizedEntries?: CalendarUnrecognizedEntry[]
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

/** The version 2 keys an event and a changed occurrence share, in the order they are stored. */
const OCCURRENCE_KEYS = [
  'days',
  'zone',
  'endZone',
  'floating',
  'localStart',
  'localEnd',
  'description',
  'location',
  'status',
  'clipped',
] as const

const SERIES_KEYS = ['rrule', 'exdates', 'rdates', 'overrides', 'guests', 'alarm'] as const

const EVENT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'date',
  'title',
  'color',
  'allDay',
  'start',
  'end',
  'recurrence',
  ...OCCURRENCE_KEYS,
  'localOf',
  ...SERIES_KEYS,
])

const OVERRIDE_KEYS: ReadonlySet<string> = new Set(['rid', 'date', 'title', ...OCCURRENCE_KEYS])

const DOCUMENT_KEYS: ReadonlySet<string> = new Set(['version', 'events'])

/**
 * Assign an OWN property. A plain assignment of the key `__proto__` sets the
 * object's prototype instead, so a stored key of that name would vanish on the
 * way through; JSON.parse produces it as an own key and so must this.
 */
const setOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

const unknownFieldsOf = (
  candidate: Record<string, unknown>,
  known: ReadonlySet<string>,
): CalendarUnknownFields | undefined => {
  let unknown: CalendarUnknownFields | undefined
  for (const key of Object.keys(candidate)) {
    if (known.has(key)) {
      continue
    }
    unknown = unknown ?? {}
    setOwn(unknown, key, candidate[key])
  }
  return unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const EVENT_STATUSES: ReadonlySet<string> = new Set(['tentative', 'confirmed', 'cancelled'])

export const MAX_ZONE_NAME_LENGTH = 128
export const MAX_RULE_LENGTH = 1_000
/** Ten years. Longer than any event, short enough that a wrong number cannot stall a loop. */
export const MAX_EVENT_DAYS = 3_660

const zoneNameOf = (value: unknown): string | undefined => {
  return isString(value) && value.length > 0 && value.length <= MAX_ZONE_NAME_LENGTH ? value : undefined
}

const textOf = (value: unknown): string | undefined => (isString(value) && value.length > 0 ? value : undefined)

/**
 * The version 2 keys of an event or of a changed occurrence. `timed` says
 * whether the thing has a time of day, which decides which keys can apply: an
 * end day belongs to an all-day event, a zone and wall times to a timed one.
 */
const readOccurrenceFields = (candidate: Record<string, unknown>, timed: boolean): CalendarOccurrenceFields => {
  const fields: CalendarOccurrenceFields = {}
  if (!timed) {
    const days = candidate.days
    if (typeof days === 'number' && Number.isInteger(days) && days >= 2 && days <= MAX_EVENT_DAYS) {
      fields.days = days
    }
  } else {
    const zone = zoneNameOf(candidate.zone)
    if (zone && isWallTime(candidate.localStart)) {
      fields.zone = zone
      const endZone = zoneNameOf(candidate.endZone)
      if (endZone && endZone !== zone && isWallTime(candidate.localEnd)) {
        fields.endZone = endZone
      }
      if (candidate.floating === true) {
        fields.floating = true
      }
      fields.localStart = candidate.localStart
      if (isWallTime(candidate.localEnd)) {
        fields.localEnd = candidate.localEnd
      }
    }
  }
  const description = textOf(candidate.description)
  if (description !== undefined) {
    fields.description = description
  }
  const location = textOf(candidate.location)
  if (location !== undefined) {
    fields.location = location
  }
  if (isString(candidate.status) && EVENT_STATUSES.has(candidate.status)) {
    fields.status = candidate.status as CalendarEventStatus
  }
  const clipped = textOf(candidate.clipped)
  if (clipped !== undefined) {
    fields.clipped = clipped
  }
  return fields
}

const wholeSeconds = (instant: string): number => Math.floor(Date.parse(instant) / 1000)

/**
 * Decide between an event's wall times and its instants, and leave the event
 * holding both in agreement.
 *
 * The wall times stand while `localOf` still names the instants the event has:
 * nobody has touched `start` or `end` since the wall times were written, so a
 * difference between them can only be this device's zone database, and the
 * event must not move for that. Otherwise a build that knows only version 1
 * changed the instants, the person's change wins, and the wall times are read
 * afresh from them in the event's zone.
 */
const settleWallTimes = (event: CalendarEvent, storedLocalOf: unknown): void => {
  if (!event.zone || !event.localStart || !event.start) {
    return
  }
  const instants = event.end ? [wholeSeconds(event.start), wholeSeconds(event.end)] : [wholeSeconds(event.start)]
  const vouchedFor =
    Array.isArray(storedLocalOf) &&
    instants.every((seconds, index) => storedLocalOf[index] === seconds) &&
    (event.localEnd !== undefined) === (event.end !== undefined)
  if (!vouchedFor) {
    const localStart = instantToWall(event.zone, instants[0] * 1000)
    const localEnd = event.end ? instantToWall(event.endZone ?? event.zone, instants[1] * 1000) : undefined
    if (localStart === '' || localEnd === '') {
      // The zone is one this platform cannot read an instant in. Only the instants are left to go by,
      // which is what an event with no zone of its own has always been.
      delete event.zone
      delete event.endZone
      delete event.floating
      delete event.localStart
      delete event.localEnd
      return
    }
    event.localStart = localStart
    if (localEnd === undefined) {
      delete event.localEnd
      delete event.endZone
    } else {
      event.localEnd = localEnd
    }
  }
  event.localOf = instants
}

const isSeriesTime = (value: unknown): value is string => isIsoDate(value) || isWallTime(value)

/** A list of occurrences named by date or wall time: only real ones, each once, in order. */
const sanitizeSeriesTimes = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const times = [...new Set(raw.filter(isSeriesTime))].sort()
  return times.length > 0 ? times : undefined
}

const sanitizeOverride = (raw: unknown): CalendarOccurrenceOverride | null => {
  if (!isRecord(raw) || !isSeriesTime(raw.rid) || !isIsoDate(raw.date)) {
    return null
  }
  const timed = isWallTime(raw.localStart) && zoneNameOf(raw.zone) !== undefined
  const override: CalendarOccurrenceOverride = {
    rid: raw.rid,
    date: raw.date,
    title: isString(raw.title) ? raw.title : '',
    ...readOccurrenceFields(raw, timed),
  }
  const unknownFields = unknownFieldsOf(raw, OVERRIDE_KEYS)
  if (unknownFields) {
    override.unknownFields = unknownFields
  }
  return override
}

/** Changed occurrences: only readable ones, one per occurrence, in order. */
const sanitizeOverrides = (raw: unknown): CalendarOccurrenceOverride[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const byRid = new Map<string, CalendarOccurrenceOverride>()
  for (const entry of raw) {
    const override = sanitizeOverride(entry)
    if (override && !byRid.has(override.rid)) {
      byRid.set(override.rid, override)
    }
  }
  const overrides = [...byRid.values()].sort((a, b) => (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0))
  return overrides.length > 0 ? overrides : undefined
}

const sanitizeEvent = (raw: unknown): CalendarEvent | null => {
  if (!isRecord(raw)) {
    return null
  }
  const candidate = raw
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

  Object.assign(event, readOccurrenceFields(candidate, event.allDay === false))
  settleWallTimes(event, candidate.localOf)

  const recurrence = sanitizeRecurrence(candidate.recurrence)
  if (recurrence) {
    event.recurrence = recurrence
  } else if (isString(candidate.rrule) && candidate.rrule.length > 0 && candidate.rrule.length <= MAX_RULE_LENGTH) {
    // The simple rule is the one an older build can set, so where both are
    // stored it is the newer statement and the long rule is not read.
    event.rrule = candidate.rrule
  }
  const exdates = sanitizeSeriesTimes(candidate.exdates)
  if (exdates) {
    event.exdates = exdates
  }
  const rdates = sanitizeSeriesTimes(candidate.rdates)
  if (rdates) {
    event.rdates = rdates
  }
  const overrides = sanitizeOverrides(candidate.overrides)
  if (overrides) {
    event.overrides = overrides
  }
  if (candidate.guests === true) {
    event.guests = true
  }
  if (candidate.alarm === true) {
    event.alarm = true
  }

  const unknownFields = unknownFieldsOf(candidate, EVENT_KEYS)
  if (unknownFields) {
    event.unknownFields = unknownFields
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

  if (!isRecord(parsed)) {
    return { document: createEmptyCalendarDocument(), recovered: false }
  }

  const candidate = parsed

  // A calendar document must at least expose an events array; otherwise it is
  // probably some other note format being switched into Calendar, so treat it as
  // a fresh calendar but flag it as not-recovered.
  const storedEvents = candidate.events
  if (!Array.isArray(storedEvents)) {
    return { document: createEmptyCalendarDocument(), recovered: false }
  }

  const events: CalendarEvent[] = []
  const unrecognizedEntries: CalendarUnrecognizedEntry[] = []
  const seenIds = new Set<string>()
  storedEvents.forEach((rawEvent: unknown, position: number) => {
    const event = sanitizeEvent(rawEvent)
    if (event && !seenIds.has(event.id)) {
      seenIds.add(event.id)
      events.push(event)
    } else {
      unrecognizedEntries.push({ position, raw: rawEvent })
    }
  })

  const document: CalendarDocument = {
    version: isFiniteNumber(candidate.version) ? candidate.version : CALENDAR_DOCUMENT_VERSION,
    events,
  }
  const unknownFields = unknownFieldsOf(candidate, DOCUMENT_KEYS)
  if (unknownFields) {
    document.unknownFields = unknownFields
  }
  if (unrecognizedEntries.length > 0) {
    document.unrecognizedEntries = unrecognizedEntries
  }

  return { document, recovered: true }
}

/**
 * The stored form of one event: known keys in a fixed order, then the keys this
 * build did not recognise. The order is fixed so that the same document always
 * serializes to the same text, whichever sequence of edits produced it.
 */
const storeOccurrenceFields = (stored: Record<string, unknown>, fields: CalendarOccurrenceFields): void => {
  for (const key of OCCURRENCE_KEYS) {
    if (fields[key] !== undefined) {
      stored[key] = fields[key]
    }
  }
}

const storeUnknownFields = (
  stored: Record<string, unknown>,
  unknownFields: CalendarUnknownFields | undefined,
  known: ReadonlySet<string>,
): void => {
  if (!unknownFields) {
    return
  }
  for (const key of Object.keys(unknownFields)) {
    if (!known.has(key)) {
      setOwn(stored, key, unknownFields[key])
    }
  }
}

const overrideToStored = (override: CalendarOccurrenceOverride): Record<string, unknown> => {
  const stored: Record<string, unknown> = { rid: override.rid, date: override.date, title: override.title }
  storeOccurrenceFields(stored, override)
  storeUnknownFields(stored, override.unknownFields, OVERRIDE_KEYS)
  return stored
}

const eventToStored = (event: CalendarEvent): Record<string, unknown> => {
  const stored: Record<string, unknown> = { id: event.id, date: event.date, title: event.title }
  if (event.color !== undefined) {
    stored.color = event.color
  }
  if (event.allDay !== undefined) {
    stored.allDay = event.allDay
  }
  if (event.start !== undefined) {
    stored.start = event.start
  }
  if (event.end !== undefined) {
    stored.end = event.end
  }
  if (event.recurrence !== undefined) {
    stored.recurrence = event.recurrence
  }
  storeOccurrenceFields(stored, event)
  if (event.localOf !== undefined) {
    stored.localOf = event.localOf
  }
  if (event.rrule !== undefined) {
    stored.rrule = event.rrule
  }
  if (event.exdates !== undefined) {
    stored.exdates = event.exdates
  }
  if (event.rdates !== undefined) {
    stored.rdates = event.rdates
  }
  if (event.overrides !== undefined) {
    stored.overrides = event.overrides.map(overrideToStored)
  }
  if (event.guests !== undefined) {
    stored.guests = event.guests
  }
  if (event.alarm !== undefined) {
    stored.alarm = event.alarm
  }
  storeUnknownFields(stored, event.unknownFields, EVENT_KEYS)
  return stored
}

/** Serialize a CalendarDocument to the string stored in `note.text`. */
export const serializeCalendarDocument = (document: CalendarDocument): string => {
  const entries: unknown[] = document.events.map(eventToStored)
  // Ascending by stored position, so each entry lands at the index it was read from.
  const unrecognized = [...(document.unrecognizedEntries ?? [])].sort((a, b) => a.position - b.position)
  for (const entry of unrecognized) {
    entries.splice(Math.min(Math.max(entry.position, 0), entries.length), 0, entry.raw)
  }

  const stored: Record<string, unknown> = {
    version: document.version ?? CALENDAR_DOCUMENT_VERSION,
    events: entries,
  }
  storeUnknownFields(stored, document.unknownFields, DOCUMENT_KEYS)
  return JSON.stringify(stored)
}

const sameStoredValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Merge one event that both sides may have changed since `base`, key by key: a
 * key `mine` changed keeps mine, any other key takes theirs. `base` is absent
 * when both sides added the event.
 */
const mergeStoredEvent = (
  base: Record<string, unknown> | undefined,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    const mineChanged = !sameStoredValue(mine[key], base?.[key])
    const value = mineChanged ? mine[key] : theirs[key]
    if (value !== undefined) {
      setOwn(merged, key, value)
    }
  }
  return merged
}

/**
 * Three-way merge of a calendar this editor holds (`mine`) with a version of the
 * note that someone else wrote (`theirs`), given the last version both agreed on
 * (`base`). Used when the note changes underneath an open editor: another
 * device, or other code on this device such as a background sync.
 *
 *  - An event only one side touched takes that side's version.
 *  - An event both touched is merged key by key; where both changed the same
 *    key, `mine` wins, because it is what the person at this editor just did.
 *  - An edit beats a deletion, whichever side made which.
 *  - Their order is kept; events only `mine` has follow, in mine's order.
 *
 * Everything outside the events (version, unknown keys, unrecognised entries)
 * is theirs: this editor cannot change any of it.
 */
export const mergeCalendarDocuments = (
  base: CalendarDocument,
  mine: CalendarDocument,
  theirs: CalendarDocument,
): CalendarDocument => {
  const baseById = new Map(base.events.map((event) => [event.id, event]))
  const mineById = new Map(mine.events.map((event) => [event.id, event]))
  const theirIds = new Set(theirs.events.map((event) => event.id))

  const events: CalendarEvent[] = []
  for (const theirEvent of theirs.events) {
    const baseEvent = baseById.get(theirEvent.id)
    const myEvent = mineById.get(theirEvent.id)
    if (!myEvent) {
      // Deleted here. That stands only if they left the event as it was.
      const theyChanged = !baseEvent || !sameStoredValue(eventToStored(theirEvent), eventToStored(baseEvent))
      if (theyChanged) {
        events.push(theirEvent)
      }
      continue
    }
    const merged = sanitizeEvent(
      mergeStoredEvent(
        baseEvent ? eventToStored(baseEvent) : undefined,
        eventToStored(myEvent),
        eventToStored(theirEvent),
      ),
    )
    events.push(merged ?? myEvent)
  }
  for (const myEvent of mine.events) {
    if (theirIds.has(myEvent.id)) {
      continue
    }
    const baseEvent = baseById.get(myEvent.id)
    // Absent from theirs. Added here, or deleted there: the deletion stands only
    // if this side left the event as it was.
    const iChanged = !baseEvent || !sameStoredValue(eventToStored(myEvent), eventToStored(baseEvent))
    if (iChanged) {
      events.push(myEvent)
    }
  }

  const merged: CalendarDocument = { version: Math.max(theirs.version, mine.version), events }
  if (theirs.unknownFields) {
    merged.unknownFields = theirs.unknownFields
  }
  if (theirs.unrecognizedEntries) {
    merged.unrecognizedEntries = theirs.unrecognizedEntries
  }
  return merged
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
export const todayIso = (now: Date = new Date()): string => toIsoDate(now.getFullYear(), now.getMonth(), now.getDate())

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

/** One day of one occurrence of an event, as a month grid shows it. */
export type CalendarOccurrence = {
  /** The originating event (shared across all occurrences of a recurring event). */
  event: CalendarEvent
  /** YYYY-MM-DD of the day this sits on. */
  date: string
  /** Whether this occurrence is all-day. */
  allDay: boolean
  /** "HH:MM" on the day a timed occurrence starts, else null. */
  time: string | null
  /** What this occurrence is called. A changed occurrence may have its own title. */
  title: string
  /** Which occurrence of its series this is: its original start, as the series' own clock names it. */
  occurrence: string
  /** False on the day an occurrence starts, true on each later day it runs into. */
  continuation: boolean
  cancelled: boolean
  /** The changed occurrence this is, when it is one. */
  override?: CalendarOccurrenceOverride
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

/** Whether a repeating event anchored on `anchor` falls on `target` (both YYYY-MM-DD). */
const simpleRecurrenceHits = (anchor: string, target: string, recurrence: CalendarRecurrence): boolean => {
  if (target < anchor) {
    return false
  }
  const interval = recurrence.interval && recurrence.interval >= 1 ? Math.floor(recurrence.interval) : 1
  const [anchorYear, anchorMonth, anchorDay] = anchor.split('-').map(Number)
  const [year, month, day] = target.split('-').map(Number)
  switch (recurrence.freq) {
    case 'daily':
      return daysBetween(anchor, target) % interval === 0
    case 'weekly': {
      const days = daysBetween(anchor, target)
      return days % 7 === 0 && (days / 7) % interval === 0
    }
    case 'monthly':
      return day === anchorDay && ((year - anchorYear) * 12 + (month - anchorMonth)) % interval === 0
    case 'yearly':
      return day === anchorDay && month === anchorMonth && (year - anchorYear) % interval === 0
    default:
      return false
  }
}

/** Safety cap on how many occurrences one event may contribute to one window. */
export const MAX_RECURRENCE_CELLS = 42

/** The longest run of days any one loop here walks. A month grid is 42; a year view would be 371. */
const MAX_WINDOW_DAYS = 400

/** Converts between a wall time in a zone and an instant. */
export type CalendarZoneRules = {
  knows(zone: string): boolean
  /** Milliseconds since the epoch, or NaN. */
  toInstant(zone: string, wall: string): number
  /** `YYYY-MM-DDTHH:MM:SS`, or `''`. */
  toWall(zone: string, epochMs: number): string
}

/**
 * What showing an event needs beyond this file: expanding a repeat rule that is
 * more than "every N weeks", and reading a zone the platform has no name for.
 * Both need the iCalendar library, which is loaded only when a calendar holds
 * such an event ({@link needsSeriesTools}).
 */
export type CalendarSeriesTools = {
  /**
   * The starts of the occurrences `rule` produces for a series starting at
   * `start`, from `from` to `to` inclusive. All three are dates for an all-day
   * series and wall times otherwise. `zone` is the series' zone, used only to
   * read an end date the rule states in UTC.
   */
  occurrencesOfRule(series: { rule: string; start: string; zone?: string; from: string; to: string }): string[]
  zones: CalendarZoneRules
}

export type ExpandOptions = {
  /** The zone whose days and clock the grid shows. The device's own when absent. */
  displayZone?: string
  series?: CalendarSeriesTools
}

const platformZones: CalendarZoneRules = { knows: isKnownZone, toInstant: wallToInstant, toWall: instantToWall }

const isRepeating = (event: CalendarEvent): boolean =>
  event.recurrence !== undefined || event.rrule !== undefined || (event.rdates?.length ?? 0) > 0

/** Whether showing these events correctly needs {@link CalendarSeriesTools}. */
export const needsSeriesTools = (events: CalendarEvent[]): boolean =>
  events.some(
    (event) =>
      event.rrule !== undefined ||
      (isRepeating(event) && event.zone !== undefined && event.floating !== true && !isKnownZone(event.zone)),
  )

type SeriesOccurrence = { occurrence: string; override?: CalendarOccurrenceOverride }

const overrideFor = (
  overrides: Map<string, CalendarOccurrenceOverride>,
  occurrence: string,
): CalendarOccurrenceOverride | undefined => overrides.get(occurrence) ?? overrides.get(occurrence.slice(0, 10))

/**
 * The occurrences of one event whose ORIGINAL start lies between `from` and
 * `to`, plus every changed occurrence (which may have been moved anywhere).
 * `start`, `from` and `to` are all dates, or all wall times on the series' clock.
 */
const occurrencesOfSeries = (
  event: CalendarEvent,
  start: string,
  from: string,
  to: string,
  zone: string | undefined,
  options: ExpandOptions,
): SeriesOccurrence[] => {
  const starts = new Set<string>()
  // The first occurrence is the start itself, whatever the rule says.
  if (start >= from && start <= to) {
    starts.add(start)
  }
  if (event.recurrence) {
    const [startDay, timeOfDay] = [start.slice(0, 10), start.slice(10)]
    const firstDay = from.slice(0, 10) > startDay ? from.slice(0, 10) : startDay
    for (const day of daysInRange(firstDay, to.slice(0, 10), MAX_WINDOW_DAYS)) {
      if (simpleRecurrenceHits(startDay, day, event.recurrence)) {
        starts.add(`${day}${timeOfDay}`)
      }
    }
  } else if (event.rrule && options.series) {
    for (const occurrence of options.series.occurrencesOfRule({ rule: event.rrule, start, zone, from, to })) {
      starts.add(occurrence)
    }
  }
  for (const added of event.rdates ?? []) {
    // An added occurrence given as a bare date takes the series' time of day.
    const occurrence = added.length === 10 && start.length > 10 ? `${added}${start.slice(10)}` : added
    if (occurrence >= from && occurrence <= to) {
      starts.add(occurrence)
    }
  }
  for (const removed of event.exdates ?? []) {
    for (const occurrence of [...starts]) {
      if (occurrence === removed || (removed.length === 10 && occurrence.slice(0, 10) === removed)) {
        starts.delete(occurrence)
      }
    }
  }

  const overrides = new Map((event.overrides ?? []).map((override) => [override.rid, override]))
  const matched = new Set<CalendarOccurrenceOverride>()
  const occurrences: SeriesOccurrence[] = []
  for (const occurrence of [...starts].sort()) {
    const override = overrideFor(overrides, occurrence)
    if (override) {
      matched.add(override)
      occurrences.push({ occurrence, override })
    } else {
      occurrences.push({ occurrence })
    }
  }
  // A changed occurrence is shown where it was moved to, even when the day it
  // was moved from is nowhere near the days being shown.
  for (const override of overrides.values()) {
    if (!matched.has(override)) {
      occurrences.push({ occurrence: override.rid, override })
    }
  }
  return occurrences
}

type PlacedOccurrence = {
  /** The first and last day it is shown on. */
  firstDay: string
  lastDay: string
  allDay: boolean
  time: string | null
}

const placeAllDay = (date: string, days: number | undefined): PlacedOccurrence => ({
  firstDay: date,
  lastDay: days && days > 1 ? addDays(date, days - 1) : date,
  allDay: true,
  time: null,
})

/**
 * Where a timed occurrence falls on the grid: its start and end instants, read
 * on the clock of the zone being shown. A floating time is not converted at
 * all; it is the same wall time everywhere.
 */
const placeTimed = (
  startMs: number,
  endMs: number,
  floating: boolean,
  displayZone: string,
): PlacedOccurrence | null => {
  const read = (ms: number): string => (floating ? wallFromUtcMs(ms) : instantToWall(displayZone, ms))
  const startWall = read(startMs)
  if (startWall === '') {
    return null
  }
  // An event that ends at midnight does not run into the day that starts then.
  const endWall = endMs > startMs ? read(endMs - 1000) : startWall
  return {
    firstDay: startWall.slice(0, 10),
    lastDay: (endWall || startWall).slice(0, 10),
    allDay: false,
    time: startWall.slice(11, 16),
  }
}

/** The instant of a wall time on an event's own clock, by whichever rules know its zone. */
const instantOn = (zone: string, wall: string, event: CalendarEvent, options: ExpandOptions): number => {
  if (event.floating) {
    return utcMsFromWall(wall)
  }
  const rules = isKnownZone(zone) ? platformZones : options.series?.zones.knows(zone) ? options.series.zones : null
  if (rules) {
    return rules.toInstant(zone, wall)
  }
  // No rules for this zone yet. The stored instant fixes its offset at the
  // series' start; holding that offset is right except across a clock change.
  if (event.start && event.localStart) {
    return utcMsFromWall(wall) + (Date.parse(event.start) - utcMsFromWall(event.localStart))
  }
  return Number.NaN
}

/**
 * Expand a list of events into per-day occurrences across the given window of
 * ISO dates (typically the 42 cells of a month grid).
 *
 *  - An event with no repeat rule appears once; one that lasts several days
 *    appears on each of them.
 *  - A repeating event appears on every day of the window an occurrence falls
 *    on, capped at {@link MAX_RECURRENCE_CELLS} occurrences per event so a
 *    pathological rule can't blow up. Occurrences are worked out on the event's
 *    own clock and only then read on the clock being shown, which is what keeps
 *    a weekly 09:00 at 09:00 across a daylight-saving change.
 *  - An event the version 1 editor made has no zone of its own and is shown as
 *    that editor always showed it: on its `date`, at the device's local time.
 *
 * Pure: returns a Map keyed by ISO date -> occurrences, all-day first, then by
 * time, input order otherwise. The window order does not affect membership.
 */
export const expandEventsForWindow = (
  events: CalendarEvent[],
  windowDates: string[],
  options: ExpandOptions = {},
): Map<string, CalendarOccurrence[]> => {
  const result = new Map<string, CalendarOccurrence[]>()
  const windowSet = new Set(windowDates.filter((date) => isIsoDate(date)))
  if (windowSet.size === 0) {
    return result
  }
  const sortedWindow = [...windowSet].sort()
  const [firstDay, lastDay] = [sortedWindow[0], sortedWindow[sortedWindow.length - 1]]
  const displayZone = options.displayZone ?? deviceZone()

  const emit = (event: CalendarEvent, series: SeriesOccurrence, placed: PlacedOccurrence): void => {
    const source = series.override ?? event
    const from = placed.firstDay > firstDay ? placed.firstDay : firstDay
    const to = placed.lastDay < lastDay ? placed.lastDay : lastDay
    for (const day of daysInRange(from, to, MAX_WINDOW_DAYS)) {
      if (!windowSet.has(day)) {
        continue
      }
      const occurrence: CalendarOccurrence = {
        event,
        date: day,
        allDay: placed.allDay,
        time: day === placed.firstDay ? placed.time : null,
        title: source.title,
        occurrence: series.occurrence,
        continuation: day !== placed.firstDay,
        cancelled: source.status === 'cancelled',
      }
      if (series.override) {
        occurrence.override = series.override
      }
      const existing = result.get(day)
      if (existing) {
        existing.push(occurrence)
      } else {
        result.set(day, [occurrence])
      }
    }
  }

  /** A changed occurrence has its own time and place, whatever the series has. */
  const placeOverride = (event: CalendarEvent, override: CalendarOccurrenceOverride): PlacedOccurrence | null => {
    if (!override.localStart || !override.zone) {
      return placeAllDay(override.date, override.days)
    }
    const asEvent: CalendarEvent = { ...event, floating: override.floating }
    const startMs = instantOn(override.zone, override.localStart, asEvent, options)
    const endMs = override.localEnd
      ? instantOn(override.endZone ?? override.zone, override.localEnd, asEvent, options)
      : startMs
    return Number.isNaN(startMs)
      ? null
      : placeTimed(startMs, Number.isNaN(endMs) ? startMs : endMs, override.floating === true, displayZone)
  }

  for (const event of events) {
    const timed = isTimedEvent(event)

    if (timed && !(event.zone && event.localStart)) {
      // A version 1 timed event: anchored on its `date`, at the local time of its start.
      const time = instantToWall(displayZone, Date.parse(event.start as string)).slice(11, 16) || null
      const from = event.date > firstDay ? event.date : firstDay
      let emitted = 0
      for (const series of occurrencesOfSeries(event, event.date, from, lastDay, undefined, options)) {
        if (emitted >= MAX_RECURRENCE_CELLS) {
          break
        }
        const day = series.override ? series.override.date : series.occurrence
        emit(event, series, { firstDay: day, lastDay: day, allDay: false, time })
        emitted += 1
      }
      continue
    }

    if (!timed) {
      const lengthInDays = event.days && event.days > 1 ? event.days : 1
      const from = addDays(firstDay, 1 - lengthInDays)
      if (!isRepeating(event) && !event.overrides && (event.date > lastDay || event.date < from)) {
        continue
      }
      let emitted = 0
      for (const series of occurrencesOfSeries(event, event.date, from, lastDay, undefined, options)) {
        if (emitted >= MAX_RECURRENCE_CELLS) {
          break
        }
        const placed = series.override
          ? placeOverride(event, series.override)
          : placeAllDay(series.occurrence, lengthInDays)
        if (placed && placed.lastDay >= firstDay && placed.firstDay <= lastDay) {
          emit(event, series, placed)
          emitted += 1
        }
      }
      continue
    }

    // A timed event with a clock of its own.
    const zone = event.zone as string
    const localStart = event.localStart as string
    const lengthMs = event.end && event.start ? Math.max(0, Date.parse(event.end) - Date.parse(event.start)) : 0
    // Two days of slack either side cover any difference between its zone and the one shown.
    const slackDays = 2 + Math.ceil(lengthMs / 86_400_000)
    const from = `${addDays(firstDay, -slackDays)}T00:00:00`
    const to = `${addDays(lastDay, 2)}T23:59:59`
    if (!isRepeating(event) && !event.overrides && (localStart > to || localStart < from)) {
      continue
    }
    let emitted = 0
    for (const series of occurrencesOfSeries(event, localStart, from, to, event.floating ? undefined : zone, options)) {
      if (emitted >= MAX_RECURRENCE_CELLS) {
        break
      }
      let placed: PlacedOccurrence | null
      if (series.override) {
        placed = placeOverride(event, series.override)
      } else {
        const startMs = instantOn(zone, series.occurrence, event, options)
        placed = Number.isNaN(startMs)
          ? null
          : placeTimed(startMs, startMs + lengthMs, event.floating === true, displayZone)
      }
      if (placed && placed.lastDay >= firstDay && placed.firstDay <= lastDay) {
        emit(event, series, placed)
        emitted += 1
      }
    }
  }

  for (const occurrences of result.values()) {
    // Array.prototype.sort is stable, so equal entries keep their input order.
    occurrences.sort((a, b) => {
      const [aTime, bTime] = [a.time ?? '', b.time ?? '']
      return aTime < bTime ? -1 : aTime > bTime ? 1 : 0
    })
  }
  return result
}
