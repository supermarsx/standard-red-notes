import { base64Url, sha256, utf8Bytes } from '../hash/sha256'

/**
 * Standard Red Notes: what calendar sync understands about one event.
 *
 * An event on another server carries far more than this app shows: guests,
 * alarms, vendor properties, a time-zone definition. The MODEL is the part the
 * app understands, in one canonical form, and it is the only thing two versions
 * of an entry are ever compared by. A sync pass asks three questions per entry
 * (has the copy in the note changed, has the copy on the server changed, are
 * the two the same) and answers each by comparing fingerprints of models.
 *
 * Two properties make that safe:
 *
 *  - It does not depend on the device. Times are wall-clock values plus their
 *    kind, never instants converted through the device's zone, so two devices
 *    in different zones compute the same fingerprint for the same entry.
 *  - It ignores what the app does not model. A guest added on the server, a
 *    changed timestamp or a different line folding is not a change.
 */

/**
 * The four kinds of time a calendar entry can have. They stay distinct from end
 * to end, because converting one into another is how an event ends up an hour
 * out after a daylight-saving change.
 */
export type ModelTime =
  /** A day, with no time. `value` is `YYYY-MM-DD`. */
  | { kind: 'date'; value: string }
  /** A wall-clock time tied to no zone: 09:00 wherever the reader is. */
  | { kind: 'floating'; value: string }
  /** A wall-clock time in UTC. */
  | { kind: 'utc'; value: string }
  /** A wall-clock time in a named zone. */
  | { kind: 'zoned'; value: string; zone: string }

export type EventStatus = '' | 'tentative' | 'confirmed' | 'cancelled'

/** The modelled fields that one occurrence of a series can have changed. */
export type OccurrenceModel = {
  /** Title, description and location are held cut to {@link TEXT_LIMITS}; see `clipped`. */
  title: string
  description: string
  location: string
  /**
   * `''`, or, when any of the three texts was longer than the note keeps, a
   * digest of all three in full. It stands in for the part that was cut, so
   * that two descriptions which agree on their first two thousand characters
   * and differ after them are still two different entries.
   */
  clipped: string
  status: EventStatus
  start: ModelTime
  /** Exclusive end. Absent for a single day, or a moment with no length. */
  end?: ModelTime
}

export type OverrideModel = OccurrenceModel & {
  /** The occurrence this replaces, in the terms of the series' own start. */
  recurrenceId: string
}

export type EventModel = OccurrenceModel & {
  uid: string
  /** The repeat rule in canonical form ({@link canonicalRule}), or `''`. */
  rule: string
  /** Occurrences removed from the series, in the terms of its start, sorted. */
  exdates: string[]
  /** Occurrences added to the series, in the terms of its start, sorted. */
  rdates: string[]
  /** Occurrences that were changed, sorted by the occurrence they replace. */
  overrides: OverrideModel[]
  /** Other people are invited. Changing such an entry sends them an update, so the app never does. */
  guests: boolean
  /** The entry has a reminder on the other server. */
  alarm: boolean
}

// ---------------------------------------------------------------------------
// Text limits
// ---------------------------------------------------------------------------

/**
 * The longest text the note keeps per field, in code points. A calendar note is
 * one encrypted item that is uploaded whole on every change, and a description
 * pasted from an e-mail invitation can run to tens of kilobytes; multiplied by
 * a thousand entries that is a note nobody can sync.
 */
export const TEXT_LIMITS = { title: 500, location: 500, description: 2_000 } as const

/** The first `limit` code points of `text`, never splitting a surrogate pair. */
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/**
 * The three texts of an entry as the model holds them: each cut to its limit,
 * with a digest of all three in full when anything was cut.
 */
export function clipTexts(full: {
  title: string
  description: string
  location: string
}): Pick<OccurrenceModel, 'title' | 'description' | 'location' | 'clipped'> {
  const title = clipText(full.title, TEXT_LIMITS.title)
  const description = clipText(full.description, TEXT_LIMITS.description)
  const location = clipText(full.location, TEXT_LIMITS.location)
  const cut = title !== full.title || description !== full.description || location !== full.location
  return {
    title,
    description,
    location,
    clipped: cut ? shortDigest(JSON.stringify([full.title, full.location, full.description])) : '',
  }
}

/** 96 bits of SHA-256 as 16 characters. For telling texts apart, not for secrecy. */
export function shortDigest(text: string): string {
  return base64Url(sha256(utf8Bytes(text)).subarray(0, 12))
}

// ---------------------------------------------------------------------------
// Repeat rules
// ---------------------------------------------------------------------------

/** An RRULE as its parts, upper-case names to upper-case values. */
export type RuleParts = Record<string, string>

const RULE_PART_ORDER = [
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYMONTH',
  'BYWEEKNO',
  'BYYEARDAY',
  'BYMONTHDAY',
  'BYDAY',
  'BYHOUR',
  'BYMINUTE',
  'BYSECOND',
  'BYSETPOS',
  'WKST',
]

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

/** Split `FREQ=WEEKLY;BYDAY=MO,WE` into its parts. Unparseable pieces are dropped. */
export function parseRule(rule: string): RuleParts {
  const parts: RuleParts = {}
  for (const piece of rule.split(';')) {
    const at = piece.indexOf('=')
    if (at <= 0) {
      continue
    }
    const name = piece.slice(0, at).trim().toUpperCase()
    const value = piece
      .slice(at + 1)
      .trim()
      .toUpperCase()
    if (name.length > 0 && value.length > 0) {
      parts[name] = value
    }
  }
  return parts
}

const sortedNumbers = (value: string): string =>
  value
    .split(',')
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry))
    .sort((a, b) => a - b)
    .join(',')

const sortedWeekdays = (value: string): string => {
  const entries = value
    .split(',')
    .map((entry) => /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(entry.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ ordinal: match[1] ? Number(match[1]) : 0, day: match[2] }))
  entries.sort((a, b) => a.ordinal - b.ordinal || WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day))
  return entries.map((entry) => `${entry.ordinal === 0 ? '' : entry.ordinal}${entry.day}`).join(',')
}

/** 0 = Monday … 6 = Sunday, for a `YYYY-MM-DD…` value. */
export function weekdayIndex(dateOrWall: string): number {
  const [year, month, day] = [dateOrWall.slice(0, 4), dateOrWall.slice(5, 7), dateOrWall.slice(8, 10)].map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return (date.getUTCDay() + 6) % 7
}

export type SimpleRecurrence = { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number }

const SIMPLE_FREQUENCIES: Record<string, SimpleRecurrence['freq']> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}

/**
 * The parts of a rule with everything that says nothing removed: an interval of
 * one, a week start of Monday, and the "by" parts that only repeat what the
 * start already fixes (a weekly rule "on Tuesdays" for an event that starts on
 * a Tuesday). Other apps write those out; the app's own editor does not, and
 * the two must come out the same or every such series would look edited.
 */
function meaningfulParts(rule: string, start: ModelTime): RuleParts {
  const parts = parseRule(rule)
  const kept: RuleParts = {}
  for (const name of Object.keys(parts)) {
    let value = parts[name]
    if (name === 'INTERVAL' && Number(value) === 1) {
      continue
    }
    if (name === 'WKST' && value === 'MO') {
      continue
    }
    if (name === 'BYDAY') {
      value = sortedWeekdays(value)
    } else if (name.startsWith('BY')) {
      value = sortedNumbers(value)
    }
    if (value.length > 0) {
      kept[name] = value
    }
  }

  const day = Number(start.value.slice(8, 10))
  const month = Number(start.value.slice(5, 7))
  const freq = kept.FREQ
  const redundant: string[] = []
  if (freq === 'WEEKLY' && kept.BYDAY === WEEKDAYS[weekdayIndex(start.value)]) {
    redundant.push('BYDAY')
  }
  if (freq === 'MONTHLY' && kept.BYMONTHDAY === String(day)) {
    redundant.push('BYMONTHDAY')
  }
  if (freq === 'YEARLY') {
    const monthFixed = kept.BYMONTH === undefined || kept.BYMONTH === String(month)
    const dayFixed = kept.BYMONTHDAY === undefined || kept.BYMONTHDAY === String(day)
    if (monthFixed && dayFixed) {
      redundant.push('BYMONTH', 'BYMONTHDAY')
    }
  }
  if (redundant.length > 0) {
    const without: RuleParts = {}
    for (const name of Object.keys(kept)) {
      if (!redundant.includes(name)) {
        without[name] = kept[name]
      }
    }
    // Only drop them when what is left is a rule the simple form can hold. With
    // a week start or a count in play the same "by" part is no longer idle.
    if (Object.keys(without).every((name) => name === 'FREQ' || name === 'INTERVAL')) {
      return without
    }
  }
  return kept
}

/**
 * A repeat rule in one spelling: parts in a fixed order, lists sorted, and
 * nothing that says nothing. Two rules that mean the same thing for an event
 * starting at `start` have the same canonical form; that is what makes "the
 * rule did not change" decidable.
 */
export function canonicalRule(rule: string, start: ModelTime): string {
  const parts = meaningfulParts(rule, start)
  if (parts.FREQ === undefined) {
    return ''
  }
  const names = Object.keys(parts).sort((a, b) => {
    const [ia, ib] = [RULE_PART_ORDER.indexOf(a), RULE_PART_ORDER.indexOf(b)]
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  return names.map((name) => `${name}=${parts[name]}`).join(';')
}

/**
 * The app editor's "every N days, weeks, months or years", when a canonical
 * rule is exactly that and nothing more; otherwise undefined.
 */
export function simpleRecurrenceOf(canonical: string): SimpleRecurrence | undefined {
  const parts = parseRule(canonical)
  const names = Object.keys(parts)
  const freq = SIMPLE_FREQUENCIES[parts.FREQ ?? '']
  if (!freq || names.some((name) => name !== 'FREQ' && name !== 'INTERVAL')) {
    return undefined
  }
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL)
  if (!Number.isInteger(interval) || interval < 1) {
    return undefined
  }
  return interval > 1 ? { freq, interval } : { freq }
}

/** The canonical rule for the app editor's own repeat setting. */
export function ruleOfSimpleRecurrence(recurrence: SimpleRecurrence): string {
  const freq = Object.keys(SIMPLE_FREQUENCIES).find((name) => SIMPLE_FREQUENCIES[name] === recurrence.freq) ?? ''
  const interval = recurrence.interval && recurrence.interval > 1 ? Math.floor(recurrence.interval) : 1
  return interval > 1 ? `FREQ=${freq};INTERVAL=${interval}` : `FREQ=${freq}`
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Changing what a fingerprint covers changes every fingerprint. That is safe by
 * construction — both sides of every entry move together, which the planner
 * reads as "the same change on both sides" — but the number is here so that the
 * change is a decision.
 */
export const EVENT_MODEL_VERSION = 1

const timeFields = (time: ModelTime | undefined): [string, string, string] => {
  return time === undefined ? ['', '', ''] : [time.kind, time.value, time.kind === 'zoned' ? time.zone : '']
}

const occurrenceFields = (model: OccurrenceModel): unknown[] => [
  model.title,
  model.description,
  model.location,
  model.clipped,
  model.status,
  ...timeFields(model.start),
  ...timeFields(model.end),
]

/** The canonical value a fingerprint is taken of. Exposed so that a test can show what differs. */
export function canonicalEvent(model: EventModel): unknown[] {
  return [
    EVENT_MODEL_VERSION,
    ...occurrenceFields(model),
    model.rule,
    [...model.exdates].sort(),
    [...model.rdates].sort(),
    [...model.overrides]
      .sort((a, b) => (a.recurrenceId < b.recurrenceId ? -1 : a.recurrenceId > b.recurrenceId ? 1 : 0))
      .map((override) => [override.recurrenceId, ...occurrenceFields(override)]),
    model.guests,
    model.alarm,
  ]
}

/** 128 bits of SHA-256 over the canonical form, as 22 characters. */
export function fingerprintOfEvent(model: EventModel): string {
  return base64Url(sha256(utf8Bytes(JSON.stringify(canonicalEvent(model)))).subarray(0, 16))
}
