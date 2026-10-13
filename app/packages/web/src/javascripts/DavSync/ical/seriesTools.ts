import ICAL from 'ical.js'
import { CalendarSeriesTools } from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { utcMsFromWall } from '@/Timezone/wallClock'
import { parseRule } from '../model/eventModel'
import { ZoneBook } from './zoneBook'

/**
 * Standard Red Notes: expanding a repeat rule, for showing a calendar.
 *
 * A rule is expanded on the series' OWN clock: the start is handed to the
 * library as a plain wall time with no zone, and what comes back are wall times.
 * Turning those into instants is the caller's business and goes through the
 * platform's zone database. Doing it this way means the library's own
 * time-zone handling — which needs a zone definition inside every entry, and
 * reads the hour around a clock change differently from the standard — is
 * never involved in deciding when an occurrence is.
 */

/** No series is ever expanded past this many occurrences. A daily event reaches it after 54 years. */
export const MAX_SERIES_OCCURRENCES = 20_000

/** How many series are remembered. Each holds its occurrences up to the furthest date looked at. */
const MAX_REMEMBERED_SERIES = 500

type ExpandedSeries = {
  iterator: { next(): ICAL.Time | undefined } | null
  /** Every occurrence generated so far, in order. */
  occurrences: string[]
  /** Whether a generated day is one the rule can really fall on. */
  isRealDay: (occurrence: string) => boolean
}

const FREQUENCIES = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

const numbersOf = (list: string | undefined): number[] => {
  return (list ?? '')
    .split(',')
    .filter((value) => value.length > 0)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
}

/** The parts of a rule that say which day of the month or year an occurrence falls on. */
const DAY_DECIDING_PARTS = ['BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS']

const daysInMonthOf = (occurrence: string): number =>
  new Date(Date.UTC(Number(occurrence.slice(0, 4)), Number(occurrence.slice(5, 7)), 0)).getUTCDate()

/**
 * The library rolls a day that does not exist over into the next month: for
 * "30 February and 30 April" it produces 2 March, and for "every year" from a
 * 29 February it produces 1 March in the years between. The standard says such
 * a day is skipped. This recognises what the rule rules out — by the months and
 * days it names, or, when it names none, by the day the series starts on — so
 * that a date the rule cannot fall on is never shown as an occurrence of it.
 */
const realDayCheck = (parts: Record<string, string>, start: string): ((occurrence: string) => boolean) => {
  let months = numbersOf(parts.BYMONTH)
  let monthDays = numbersOf(parts.BYMONTHDAY)
  const repeatsOnTheStartDay =
    (parts.FREQ === 'MONTHLY' || parts.FREQ === 'YEARLY') &&
    !DAY_DECIDING_PARTS.some((name) => parts[name] !== undefined)
  if (repeatsOnTheStartDay) {
    monthDays = [Number(start.slice(8, 10))]
    if (parts.FREQ === 'YEARLY' && months.length === 0) {
      months = [Number(start.slice(5, 7))]
    }
  }
  if (months.length === 0 && monthDays.length === 0) {
    return () => true
  }
  return (occurrence) => {
    const month = Number(occurrence.slice(5, 7))
    const day = Number(occurrence.slice(8, 10))
    if (months.length > 0 && !months.includes(month)) {
      return false
    }
    if (monthDays.length === 0) {
      return true
    }
    const length = daysInMonthOf(occurrence)
    return monthDays.some((monthDay) => (monthDay > 0 ? monthDay === day : length + monthDay + 1 === day))
  }
}

const basicDateTime = (wall: string): string => wall.replace(/[-:]/g, '')

const wallFromBasic = (basic: string): string =>
  `${basic.slice(0, 4)}-${basic.slice(4, 6)}-${basic.slice(6, 8)}T${basic.slice(9, 11)}:${basic.slice(11, 13)}:${basic.slice(13, 15)}`

/**
 * The rule as the library should expand it on the series' own clock: with its
 * end date stated the way the start is. A rule for a zoned series gives its end
 * in UTC, and comparing that with wall times would cut the series an offset
 * early or late.
 */
function ruleOnSeriesClock(
  parts: Record<string, string>,
  start: string,
  zone: string | undefined,
  zones: ZoneBook,
): string {
  const until = parts.UNTIL
  if (until !== undefined) {
    if (start.length === 10) {
      parts.UNTIL = until.slice(0, 8)
    } else if (/^\d{8}$/.test(until)) {
      parts.UNTIL = `${until}T235959`
    } else if (/^\d{8}T\d{6}Z$/.test(until)) {
      const utcWall = wallFromBasic(until)
      const onSeriesClock = zone === undefined ? utcWall : zones.toWall(zone, utcMsFromWall(utcWall))
      parts.UNTIL = basicDateTime(onSeriesClock || utcWall)
    }
  }
  return Object.keys(parts)
    .map((name) => `${name}=${parts[name]}`)
    .join(';')
}

const beginExpansion = (rule: string, start: string, zone: string | undefined, zones: ZoneBook): ExpandedSeries => {
  const parts = parseRule(rule)
  const isRealDay = realDayCheck(parts, start)
  // A rule with no frequency the standard knows is not handed to the library at all. Nor is one that
  // goes by week number: the library does not implement that part and answers every week instead.
  if (!FREQUENCIES.has(parts.FREQ ?? '') || parts.BYWEEKNO !== undefined) {
    return { iterator: null, occurrences: [], isRealDay }
  }
  try {
    const recur = ICAL.Recur.fromString(ruleOnSeriesClock(parts, start, zone, zones))
    const first = start.length === 10 ? ICAL.Time.fromDateString(start) : ICAL.Time.fromDateTimeString(start)
    return { iterator: recur.iterator(first), occurrences: [], isRealDay }
  } catch {
    // A rule the library cannot read produces no occurrences beyond the start, which the caller adds itself.
    return { iterator: null, occurrences: [], isRealDay }
  }
}

/** Generate until the series has passed `to`, has ended, or has reached the cap. */
const extendTo = (series: ExpandedSeries, to: string): void => {
  let last = series.occurrences[series.occurrences.length - 1] ?? ''
  // The cap counts what the library was asked for, not what was kept, so that a rule whose every
  // date is thrown away still comes to an end.
  for (let asked = series.occurrences.length; series.iterator && asked < MAX_SERIES_OCCURRENCES; asked++) {
    if (last > to) {
      return
    }
    let next: ICAL.Time | undefined
    try {
      next = series.iterator.next()
    } catch {
      next = undefined
    }
    if (!next) {
      series.iterator = null
      return
    }
    last = next.toString()
    if (series.isRealDay(last)) {
      series.occurrences.push(last)
    }
  }
  series.iterator = null
}

/**
 * The tools a calendar needs to show events with a full repeat rule or a zone
 * the platform has no name for. `zoneDefinitions` are the embedded definitions
 * kept with the note, by zone name.
 */
export function createSeriesTools(zoneDefinitions: Record<string, string> = {}): CalendarSeriesTools {
  const zones = new ZoneBook()
  for (const tzid of Object.keys(zoneDefinitions)) {
    zones.add(tzid, zoneDefinitions[tzid])
  }
  const remembered = new Map<string, ExpandedSeries>()

  return {
    zones,
    occurrencesOfRule({ rule, start, zone, from, to }) {
      const key = `${start}\n${zone ?? ''}\n${rule}`
      let series = remembered.get(key)
      if (!series) {
        if (remembered.size >= MAX_REMEMBERED_SERIES) {
          // Forget the series looked at longest ago; a Map keeps insertion order.
          const oldest = remembered.keys().next().value
          if (oldest !== undefined) {
            remembered.delete(oldest)
          }
        }
        series = beginExpansion(rule, start, zone, zones)
      } else {
        remembered.delete(key)
      }
      remembered.set(key, series)
      extendTo(series, to)
      return series.occurrences.filter((occurrence) => occurrence >= from && occurrence <= to)
    },
  }
}
