/**
 * Standard Red Notes: pure iCalendar (RFC 5545) generator.
 *
 * Turns a normalized list of {@link ICSEvent}s into a single VCALENDAR string
 * that external calendar apps (Google Calendar, Apple Calendar, Outlook, …) can
 * import. It is intentionally dependency-free and side-effect-free so it can be
 * unit-tested in isolation; the browser download wiring lives in
 * {@link ./downloadICS}.
 *
 * ## Scope / honest limitations
 *  - Timed events are emitted in **UTC** (a trailing `Z`). We do NOT emit a
 *    `VTIMEZONE` component, so there is no per-event named timezone — the time is
 *    unambiguous (UTC) but a viewer will display it converted to their local
 *    zone rather than the author's original zone. This is the simplest correct
 *    choice and round-trips cleanly.
 *  - All-day events are emitted as date-only `VALUE=DATE` values (no time, no Z),
 *    which every calendar app treats as a floating all-day entry.
 *  - Recurrence is mapped to a single `RRULE` (`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`
 *    with optional `INTERVAL`). More exotic rules are out of scope.
 */

export type ICSRecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** Normalized recurrence for ICS output. `interval` defaults to 1 when omitted. */
export type ICSRecurrence = {
  frequency: ICSRecurrenceFrequency
  /** Repeat every `interval` units of the frequency (>= 1). */
  interval?: number
}

/**
 * A single calendar entry to serialize. Either:
 *  - all-day: provide `date` (YYYY-MM-DD) and leave `start` undefined; or
 *  - timed: provide `start` (a Date / epoch ms / ISO string) and optionally `end`.
 */
export type ICSEvent = {
  /** Stable unique id; becomes the VEVENT `UID`. */
  uid: string
  /** Event title -> `SUMMARY`. */
  title?: string
  /** Optional long text -> `DESCRIPTION`. */
  description?: string
  /** All-day date as YYYY-MM-DD. Mutually exclusive with `start`. */
  date?: string
  /** Timed start instant. Mutually exclusive with `date`. */
  start?: Date | number | string
  /** Optional timed end instant. Ignored for all-day events. */
  end?: Date | number | string
  /** Optional repeat rule -> `RRULE`. */
  recurrence?: ICSRecurrence
}

const pad2 = (value: number): string => value.toString().padStart(2, '0')

/**
 * Escape a text value per RFC 5545 §3.3.11: backslash, semicolon, and comma are
 * backslash-escaped; newlines become the literal two-char sequence `\n`. CR is
 * dropped (CRLF -> single \n). The text is NOT folded here — folding happens
 * once over the assembled content line so the escape sequences are counted as
 * octets correctly.
 */
export const escapeICSText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')

/**
 * UTF-8 octet length of a single code point. Pure (no TextEncoder dependency, so
 * it works in any JS environment including the jsdom test runner): 1 byte for
 * <=0x7F, 2 for <=0x7FF, 3 for <=0xFFFF, otherwise 4 (astral / surrogate pair).
 */
const codePointOctets = (codePoint: number): number => {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

/** UTF-8 octet length of a string, iterating by code point (surrogate-safe). */
export const utf8OctetLength = (value: string): number => {
  let total = 0
  for (const char of value) {
    total += codePointOctets(char.codePointAt(0) as number)
  }
  return total
}

/**
 * Fold a single content line to <=75 octets per RFC 5545 §3.1 by inserting
 * CRLF + a single space. We count UTF-8 octets (not JS chars) and never split a
 * multi-byte character across a fold boundary.
 */
export const foldICSLine = (line: string): string => {
  // Fast path: already short enough.
  if (utf8OctetLength(line) <= 75) {
    return line
  }
  const out: string[] = []
  let current = ''
  let currentOctets = 0
  let firstSegment = true
  // Continuation lines start with a space, so their octet budget is 74.
  for (const char of line) {
    const charOctets = codePointOctets(char.codePointAt(0) as number)
    const limit = firstSegment ? 75 : 74
    if (currentOctets + charOctets > limit) {
      out.push(current)
      current = char
      currentOctets = charOctets
      firstSegment = false
    } else {
      current += char
      currentOctets += charOctets
    }
  }
  out.push(current)
  return out.join('\r\n ')
}

/** Format a Date as a UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ. */
const formatUtcStamp = (date: Date): string =>
  `${date.getUTCFullYear().toString().padStart(4, '0')}${pad2(date.getUTCMonth() + 1)}${pad2(
    date.getUTCDate(),
  )}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`

/** Format an all-day date (YYYY-MM-DD) as a DATE value: YYYYMMDD. */
const formatDateValue = (isoDate: string): string => isoDate.replace(/-/g, '')

const toDate = (value: Date | number | string): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const buildRRule = (recurrence: ICSRecurrence): string | null => {
  const freqMap: Record<ICSRecurrenceFrequency, string> = {
    daily: 'DAILY',
    weekly: 'WEEKLY',
    monthly: 'MONTHLY',
    yearly: 'YEARLY',
  }
  const freq = freqMap[recurrence.frequency]
  if (!freq) {
    return null
  }
  const interval = recurrence.interval && recurrence.interval > 1 ? Math.floor(recurrence.interval) : undefined
  return interval ? `RRULE:FREQ=${freq};INTERVAL=${interval}` : `RRULE:FREQ=${freq}`
}

/**
 * Build the property lines for one VEVENT (without BEGIN/END). Returns null for
 * an event with no usable date/time so callers can skip it.
 */
const buildVEvent = (event: ICSEvent, dtstamp: string): string[] | null => {
  const lines: string[] = []
  lines.push(`UID:${escapeICSText(event.uid)}`)
  lines.push(`DTSTAMP:${dtstamp}`)

  if (event.date) {
    // All-day. DTEND for a DATE value is the day AFTER (exclusive) per RFC 5545,
    // but most apps render a single day fine from DTSTART alone, so we emit just
    // DTSTART;VALUE=DATE to keep it a one-day all-day entry.
    lines.push(`DTSTART;VALUE=DATE:${formatDateValue(event.date)}`)
  } else if (event.start !== undefined) {
    const start = toDate(event.start)
    if (!start) {
      return null
    }
    lines.push(`DTSTART:${formatUtcStamp(start)}`)
    if (event.end !== undefined) {
      const end = toDate(event.end)
      if (end) {
        lines.push(`DTEND:${formatUtcStamp(end)}`)
      }
    }
  } else {
    return null
  }

  if (event.recurrence) {
    const rrule = buildRRule(event.recurrence)
    if (rrule) {
      lines.push(rrule)
    }
  }

  if (event.title !== undefined && event.title !== '') {
    lines.push(`SUMMARY:${escapeICSText(event.title)}`)
  }
  if (event.description !== undefined && event.description !== '') {
    lines.push(`DESCRIPTION:${escapeICSText(event.description)}`)
  }
  return lines
}

const PRODID = '-//Standard Red Notes//Calendar Export//EN'

/**
 * Pure: serialize events into a complete, valid VCALENDAR string. Lines are CRLF
 * separated and folded to 75 octets. An empty event list still yields a
 * well-formed (empty) calendar so importers don't choke.
 *
 * @param now Injectable clock for the shared DTSTAMP (defaults to current time);
 *            exposed for deterministic tests.
 */
export const toICS = (events: ICSEvent[], now: Date = new Date()): string => {
  const dtstamp = formatUtcStamp(now)
  const rawLines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN']

  for (const event of events) {
    const veventLines = buildVEvent(event, dtstamp)
    if (!veventLines) {
      continue
    }
    rawLines.push('BEGIN:VEVENT', ...veventLines, 'END:VEVENT')
  }

  rawLines.push('END:VCALENDAR')

  return rawLines.map(foldICSLine).join('\r\n') + '\r\n'
}
