import ICAL from 'ical.js'
import {
  MAX_EVENT_DAYS,
  MAX_RULE_LENGTH,
  MAX_ZONE_NAME_LENGTH,
} from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { addDays, daysBetween, isIsoDate, isWallTime, utcMsFromWall, wallFromUtcMs } from '@/Timezone/wallClock'
import {
  EventModel,
  EventStatus,
  ModelTime,
  OccurrenceModel,
  OverrideModel,
  canonicalRule,
  clipTexts,
} from '../model/eventModel'
import { resolveZoneName } from '../time/zoneNames'
import { ZoneBook } from './zoneBook'

/**
 * Standard Red Notes: one calendar object from another server, read into the
 * model the app compares and shows.
 *
 * The text was written by software nobody here controls. The parser library
 * accepts a great deal — a start of `notadate` comes out as a string of
 * punctuation rather than an error — so nothing it returns is used before it
 * has been checked here, and an object that fails a check is not repaired. It
 * is reported with a reason, and the caller quarantines it: listed for the
 * person, never changed, never deleted.
 */

export type UnreadableReason =
  /** Not iCalendar at all. */
  | 'not-calendar-data'
  /** Calendar data with no event in it. */
  | 'no-event'
  /** No UID, or events with different UIDs in one object. */
  | 'no-single-uid'
  /** The event has no start this app can place. */
  | 'no-usable-start'
  /** It uses a rule that removes occurrences (`EXRULE`), which cannot be shown truthfully. */
  | 'exclusion-rule'
  /** It changes "this and every later occurrence", which cannot be shown truthfully. */
  | 'this-and-future'
  /** Its repeat rule is longer than a calendar note keeps. */
  | 'rule-too-long'
  /** Its repeat rule goes by week number, which the iCalendar library cannot expand, so it cannot be shown truthfully. */
  | 'unsupported-rule'

export type ParsedCalendarObject =
  | {
      ok: true
      model: EventModel
      /**
       * Definitions of the zones this event uses that the platform does not
       * know, by name. Kept with the note so that the event can still be placed.
       */
      zoneDefinitions: Record<string, string>
    }
  | { ok: false; reason: UnreadableReason }

type Property = ICAL.Property

/** jCal keeps a property as `[name, parameters, type, value, ...more values]`. */
const valuesOf = (property: Property): unknown[] => (property.jCal as unknown[]).slice(3)

const textValue = (component: ICAL.Component, name: string): string => {
  const value = component.getFirstProperty(name)?.getFirstValue()
  return typeof value === 'string' ? value : ''
}

const STATUSES: Record<string, EventStatus> = {
  TENTATIVE: 'tentative',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
}

type TimeReader = {
  zones: ZoneBook
  /** Names of embedded definitions that a time actually relied on. */
  usedDefinitions: Set<string>
}

/** Read one date or date-time value, in the kind the server stated it in. */
function readTime(type: string, value: unknown, tzid: unknown, reader: TimeReader): ModelTime | null {
  if (typeof value !== 'string') {
    return null
  }
  if (type === 'date') {
    return isIsoDate(value) ? { kind: 'date', value } : null
  }
  if (type !== 'date-time') {
    return null
  }
  if (value.endsWith('Z')) {
    const wall = value.slice(0, -1)
    return isWallTime(wall) ? { kind: 'utc', value: wall } : null
  }
  if (!isWallTime(value)) {
    return null
  }
  if (typeof tzid !== 'string' || tzid.trim().length === 0) {
    return { kind: 'floating', value }
  }
  const known = resolveZoneName(tzid)
  if (known === 'UTC') {
    return { kind: 'utc', value }
  }
  if (known !== undefined) {
    return { kind: 'zoned', value, zone: known }
  }
  if (tzid.length <= MAX_ZONE_NAME_LENGTH && reader.zones.knows(tzid)) {
    reader.usedDefinitions.add(tzid)
    return { kind: 'zoned', value, zone: tzid }
  }
  // A zone name nobody can explain. The wall time is all that is known.
  return { kind: 'floating', value }
}

const readTimeProperty = (property: Property | null, reader: TimeReader): ModelTime | null => {
  return property ? readTime(property.type, valuesOf(property)[0], property.getParameter('tzid'), reader) : null
}

/** The instant a time names, or NaN for a date or a time no rule can place. */
const instantOf = (time: ModelTime, zones: ZoneBook): number => {
  switch (time.kind) {
    case 'utc':
      return utcMsFromWall(time.value)
    case 'zoned':
      return zones.toInstant(time.zone, time.value)
    default:
      return Number.NaN
  }
}

type Duration = { days: number; seconds: number }

/** An iCalendar duration such as `P1DT2H30M` or `-PT15M`. Only a positive one is of use here. */
function parseDuration(value: unknown): Duration | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value)
  if (!match || match[1] === '-') {
    return null
  }
  const [weeks, days, hours, minutes, seconds] = [2, 3, 4, 5, 6].map((index) => Number(match[index] ?? '0'))
  return { days: weeks * 7 + days, seconds: hours * 3600 + minutes * 60 + seconds }
}

/** `start` plus a duration. Whole days are nominal (same wall time, N days on); the rest is exact time. */
function addDuration(start: ModelTime, duration: Duration, zones: ZoneBook): ModelTime | undefined {
  if (start.kind === 'date') {
    // A date has no time of day, so any remainder rounds up to the next day.
    const days = duration.days + (duration.seconds > 0 ? Math.ceil(duration.seconds / 86_400) : 0)
    return days > 0 ? { kind: 'date', value: addDays(start.value, days) } : undefined
  }
  const nominal = `${addDays(start.value.slice(0, 10), duration.days)}${start.value.slice(10)}`
  if (start.kind === 'zoned') {
    const instant = zones.toInstant(start.zone, nominal)
    const wall = Number.isNaN(instant) ? '' : zones.toWall(start.zone, instant + duration.seconds * 1000)
    return wall === '' ? undefined : { kind: 'zoned', value: wall, zone: start.zone }
  }
  return { kind: start.kind, value: wallFromUtcMs(utcMsFromWall(nominal) + duration.seconds * 1000) }
}

/** Whether `end` really is after `start`. Times in different zones are compared as instants. */
function endsAfter(start: ModelTime, end: ModelTime, zones: ZoneBook): boolean {
  if ((start.kind === 'date') !== (end.kind === 'date')) {
    return false
  }
  if (start.kind === end.kind && (start.kind !== 'zoned' || (end.kind === 'zoned' && start.zone === end.zone))) {
    return end.value > start.value
  }
  const [from, to] = [instantOf(start, zones), instantOf(end, zones)]
  return !Number.isNaN(from) && !Number.isNaN(to) && to > from
}

/**
 * An end in the same terms as its start. A floating time beside a zoned one has
 * no meaning the two can share, and servers do send it; the start decides.
 */
const inTermsOfStart = (start: ModelTime, end: ModelTime): ModelTime => {
  if (start.kind === 'date' || end.kind === 'date' || (start.kind === 'floating') === (end.kind === 'floating')) {
    return end
  }
  if (start.kind === 'floating') {
    return { kind: 'floating', value: end.value }
  }
  return start.kind === 'utc'
    ? { kind: 'utc', value: end.value }
    : { kind: 'zoned', value: end.value, zone: start.zone }
}

function readOccurrence(vevent: ICAL.Component, reader: TimeReader): OccurrenceModel | null {
  const start = readTimeProperty(vevent.getFirstProperty('dtstart'), reader)
  if (!start) {
    return null
  }
  let end: ModelTime | undefined
  const stated = readTimeProperty(vevent.getFirstProperty('dtend'), reader)
  if (stated) {
    end = inTermsOfStart(start, stated)
  } else {
    const duration = parseDuration(
      vevent.getFirstProperty('duration') && valuesOf(vevent.getFirstProperty('duration') as Property)[0],
    )
    end = duration ? addDuration(start, duration, reader.zones) : undefined
  }
  if (end && !endsAfter(start, end, reader.zones)) {
    end = undefined
  }
  if (end && start.kind === 'date') {
    const days = daysBetween(start.value, end.value)
    if (days <= 1) {
      // One whole day is what a date with no end already means.
      end = undefined
    } else if (days > MAX_EVENT_DAYS) {
      end = { kind: 'date', value: addDays(start.value, MAX_EVENT_DAYS) }
    }
  }

  const occurrence: OccurrenceModel = {
    ...clipTexts({
      title: textValue(vevent, 'summary'),
      description: textValue(vevent, 'description'),
      location: textValue(vevent, 'location'),
    }),
    status: STATUSES[textValue(vevent, 'status').toUpperCase()] ?? '',
    start,
  }
  if (end) {
    occurrence.end = end
  }
  return occurrence
}

/**
 * A time belonging to a series (an excluded or added occurrence, or the one an
 * override replaces), in the terms of the series' own start: a date for an
 * all-day series, otherwise a wall time in the series' zone. A bare date
 * against a timed series is kept as a date and means that whole day.
 */
function inSeriesTerms(time: ModelTime, seriesStart: ModelTime, zones: ZoneBook): string {
  if (seriesStart.kind === 'date' || time.kind === 'date') {
    return time.value.slice(0, 10)
  }
  if (seriesStart.kind === 'floating' || time.kind === 'floating') {
    return time.value
  }
  const instant = instantOf(time, zones)
  if (Number.isNaN(instant)) {
    return time.value
  }
  return seriesStart.kind === 'utc' ? wallFromUtcMs(instant) : zones.toWall(seriesStart.zone, instant) || time.value
}

const readSeriesTimes = (
  vevent: ICAL.Component,
  name: 'exdate' | 'rdate',
  seriesStart: ModelTime,
  reader: TimeReader,
): string[] => {
  const times = new Set<string>()
  for (const property of vevent.getAllProperties(name)) {
    for (const raw of valuesOf(property)) {
      // An added occurrence may be given as a period; its start is the occurrence.
      const [type, value] =
        property.type === 'period' && Array.isArray(raw) ? ['date-time', raw[0]] : [property.type, raw]
      const time = readTime(type, value, property.getParameter('tzid'), reader)
      if (time) {
        times.add(inSeriesTerms(time, seriesStart, reader.zones))
      }
    }
  }
  return [...times].sort()
}

/**
 * Whether an event has a reminder that does something. Apple writes "no alert" as an alarm whose
 * action is NONE, so the mere presence of an alarm component does not mean there is one.
 */
const hasRealAlarm = (vevent: ICAL.Component): boolean =>
  vevent.getAllSubcomponents('valarm').some((alarm) => textValue(alarm, 'action').toUpperCase() !== 'NONE')

export function parseCalendarObject(text: string): ParsedCalendarObject {
  let vcalendar: ICAL.Component
  try {
    const parsed: unknown = ICAL.parse(text)
    if (!Array.isArray(parsed) || parsed[0] !== 'vcalendar') {
      return { ok: false, reason: 'not-calendar-data' }
    }
    vcalendar = new ICAL.Component(parsed as unknown[])
  } catch {
    return { ok: false, reason: 'not-calendar-data' }
  }

  const vevents = vcalendar.getAllSubcomponents('vevent')
  if (vevents.length === 0) {
    return { ok: false, reason: 'no-event' }
  }
  const uids = new Set(vevents.map((vevent) => textValue(vevent, 'uid')))
  const [uid] = [...uids]
  if (uids.size !== 1 || uid.length === 0) {
    return { ok: false, reason: 'no-single-uid' }
  }
  if (vevents.some((vevent) => vevent.hasProperty('exrule'))) {
    return { ok: false, reason: 'exclusion-rule' }
  }

  const zones = new ZoneBook()
  zones.addAllFrom(vcalendar)
  const reader: TimeReader = { zones, usedDefinitions: new Set() }

  // The series itself is the event with no RECURRENCE-ID. When there is none
  // (an invitation to single occurrences of someone else's series), the
  // earliest occurrence stands in for it and the others hang off it.
  const changed = vevents.filter((vevent) => vevent.hasProperty('recurrence-id'))
  const changedInOrder = [...changed].sort((a, b) =>
    String(valuesOf(a.getFirstProperty('recurrence-id') as Property)[0]).localeCompare(
      String(valuesOf(b.getFirstProperty('recurrence-id') as Property)[0]),
    ),
  )
  const master = vevents.find((vevent) => !vevent.hasProperty('recurrence-id')) ?? changedInOrder[0]
  const base = readOccurrence(master, reader)
  if (!base) {
    return { ok: false, reason: 'no-usable-start' }
  }

  const overrides: OverrideModel[] = []
  for (const vevent of changedInOrder) {
    if (vevent === master) {
      continue
    }
    const recurrenceIdProperty = vevent.getFirstProperty('recurrence-id') as Property
    if (String(recurrenceIdProperty.getParameter('range') ?? '').toUpperCase() === 'THISANDFUTURE') {
      return { ok: false, reason: 'this-and-future' }
    }
    const recurrenceId = readTimeProperty(recurrenceIdProperty, reader)
    const occurrence = readOccurrence(vevent, reader)
    if (!recurrenceId || !occurrence) {
      // One unreadable occurrence must not hide the rest of the series.
      continue
    }
    overrides.push({ ...occurrence, recurrenceId: inSeriesTerms(recurrenceId, base.start, zones) })
  }
  overrides.sort((a, b) => (a.recurrenceId < b.recurrenceId ? -1 : a.recurrenceId > b.recurrenceId ? 1 : 0))

  const ruleValue = master.getFirstProperty('rrule')?.getFirstValue()
  const rule = ruleValue ? canonicalRule(String(ruleValue), base.start) : ''
  if (rule.length > MAX_RULE_LENGTH) {
    return { ok: false, reason: 'rule-too-long' }
  }
  if (/(^|;)BYWEEKNO=/.test(rule)) {
    return { ok: false, reason: 'unsupported-rule' }
  }

  const model: EventModel = {
    ...base,
    uid,
    rule,
    exdates: readSeriesTimes(master, 'exdate', base.start, reader),
    rdates: readSeriesTimes(master, 'rdate', base.start, reader),
    overrides,
    guests: vevents.some((vevent) => vevent.hasProperty('attendee')),
    alarm: vevents.some(hasRealAlarm),
  }

  const zoneDefinitions: Record<string, string> = {}
  for (const tzid of [...reader.usedDefinitions].sort()) {
    const definition = zones.definitionOf(tzid)
    if (definition !== undefined) {
      zoneDefinitions[tzid] = definition
    }
  }
  return { ok: true, model, zoneDefinitions }
}
