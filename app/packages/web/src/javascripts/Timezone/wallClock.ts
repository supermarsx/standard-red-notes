/**
 * Standard Red Notes: wall-clock time in a named zone, with no time-zone
 * library. Everything goes through `Intl`, which carries the platform's zone
 * database.
 *
 * A calendar entry made in another app says "09:00 in Europe/Berlin", not an
 * instant, and its repeat rule is defined on that wall clock: a weekly 09:00
 * stays at 09:00 across a daylight-saving change, which moves its instant by an
 * hour. So wall time and instant are kept apart, and these are the only two
 * functions that cross between them.
 *
 * A wall time is the string `YYYY-MM-DDTHH:MM:SS`; a date is `YYYY-MM-DD`. Both
 * sort correctly as strings.
 */

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat | null>()

/** Zone names come from other people's calendars, so the memory of them is bounded. */
const MAX_REMEMBERED_ZONES = 400

const formatterFor = (zone: string): Intl.DateTimeFormat | null => {
  const cached = formatters.get(zone)
  if (cached !== undefined) {
    return cached
  }
  if (formatters.size >= MAX_REMEMBERED_ZONES) {
    formatters.clear()
  }
  let formatter: Intl.DateTimeFormat | null
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    formatter = null
  }
  formatters.set(zone, formatter)
  return formatter
}

/** Whether the platform's zone database knows `zone` under exactly that name. */
export function isKnownZone(zone: string): boolean {
  return zone.length > 0 && zone.length <= 128 && formatterFor(zone) !== null
}

const pad = (value: number, width = 2): string => value.toString().padStart(width, '0')

/** `YYYY-MM-DDTHH:MM:SS` from a count of milliseconds read as UTC, or `''` when it is not a time. */
export function wallFromUtcMs(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  )
}

const WALL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A wall time read as if it were UTC, in milliseconds, or NaN when it is not a
 * real wall time (month 13, 30 February, hour 25).
 */
export function utcMsFromWall(wall: string): number {
  const match = WALL_PATTERN.exec(wall)
  if (!match) {
    return Number.NaN
  }
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) => Number(match[index] ?? '0'))
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  const ms = date.getTime()
  // Date rolls an impossible value over into the next unit; refuse it instead.
  return wallFromUtcMs(ms) === `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}`
    ? ms
    : Number.NaN
}

export function isWallTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(utcMsFromWall(value))
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value) && !Number.isNaN(utcMsFromWall(`${value}T00:00:00`))
}

/** The date `days` after (or before) `date`, or `''` when `date` is not a date. */
export function addDays(date: string, days: number): string {
  return wallFromUtcMs(utcMsFromWall(`${date}T00:00:00`) + days * DAY_MS).slice(0, 10)
}

/** Whole days from `from` to `to` (negative when `to` is earlier), or NaN when either is not a date. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcMsFromWall(`${to}T00:00:00`) - utcMsFromWall(`${from}T00:00:00`)) / DAY_MS)
}

/**
 * Every day from `from` to `to` inclusive, at most `limit` of them. Empty when
 * either end is not a date, so a loop over the result always ends.
 */
export function daysInRange(from: string, to: string, limit: number): string[] {
  const count = daysBetween(from, to)
  if (Number.isNaN(count) || count < 0) {
    return []
  }
  const days: string[] = []
  for (let offset = 0; offset <= count && days.length < limit; offset++) {
    days.push(addDays(from, offset))
  }
  return days
}

/** The wall time that `zone` shows at the instant `epochMs`, to the second. */
export function instantToWall(zone: string, epochMs: number): string {
  const formatter = formatterFor(zone)
  if (!formatter || !Number.isFinite(epochMs)) {
    return ''
  }
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    parts[part.type] = part.value
  }
  // Years before 1 CE are not calendar data anyone syncs; keep them from being read as CE.
  if (parts.era !== undefined && !/^A/i.test(parts.era)) {
    return ''
  }
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

/** Minutes that `zone` is ahead of UTC at the instant `epochMs`. */
export function offsetMinutesAt(zone: string, epochMs: number): number {
  const wall = instantToWall(zone, epochMs)
  if (wall === '') {
    return Number.NaN
  }
  const wholeSeconds = Math.floor(epochMs / 1000) * 1000
  return Math.round((utcMsFromWall(wall) - wholeSeconds) / MINUTE_MS)
}

/**
 * The instant at which `zone` shows the wall time `wall`, in milliseconds, or
 * NaN when the zone is unknown or `wall` is not a wall time.
 *
 * Twice a year the answer is not obvious, and RFC 5545 section 3.3.5 settles
 * both cases the way calendar servers do:
 *
 *  - a wall time that occurs twice (clocks go back) means its FIRST occurrence;
 *  - a wall time that does not occur (clocks go forward) is read with the
 *    offset in force before the gap, so 02:30 on such a night is the instant
 *    that the clocks then call 03:30.
 */
export function wallToInstant(zone: string, wall: string): number {
  const asUtc = utcMsFromWall(wall)
  if (Number.isNaN(asUtc) || !formatterFor(zone)) {
    return Number.NaN
  }
  // The real instant lies within a day of `asUtc`, so these two probes sit one
  // on each side of it and see the offset before and after any change nearby.
  const before = offsetMinutesAt(zone, asUtc - DAY_MS)
  const after = offsetMinutesAt(zone, asUtc + DAY_MS)
  if (Number.isNaN(before) || Number.isNaN(after)) {
    return Number.NaN
  }
  const candidates = [asUtc - before * MINUTE_MS]
  if (after !== before) {
    candidates.push(asUtc - after * MINUTE_MS)
  }
  const exact = candidates.filter((candidate) => instantToWall(zone, candidate) === wallFromUtcMs(asUtc))
  if (exact.length > 0) {
    return Math.min(...exact)
  }
  return asUtc - before * MINUTE_MS
}

/** The zone this device is set to, or `UTC` when the platform will not say. */
export function deviceZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isKnownZone(zone) ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}
