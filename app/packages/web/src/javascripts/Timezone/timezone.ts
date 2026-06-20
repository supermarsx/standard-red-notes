/**
 * Standard Red Notes: Timezone awareness — pure, dependency-free core.
 *
 * This module holds ONLY the pure logic so it can be unit-tested without a
 * running application:
 *
 *  - the persisted setting shape + default (the empty string "" meaning
 *    "follow the system/local zone"),
 *  - `getSystemTimeZone()` / `getConfiguredTimeZone()` helpers,
 *  - the list of selectable zones (from `Intl.supportedValuesOf('timeZone')`,
 *    with a curated fallback when the runtime doesn't support it), and
 *  - `formatInstantInZone`, the `Intl.DateTimeFormat`-based formatter the clock
 *    widget uses to render a fixed instant in a given zone.
 *
 * Where the setting lives (web-only, no `@standardnotes/models` changes): the
 * preferred timezone is stored via the app's storage K/V
 * (`application.getValue`/`setValue`) under {@link TimeZoneSettingKey} — the same
 * local-store precedent used by Diary mode / email-backup, which deliberately
 * avoided adding keys to the published `PrefKey` enum. See timezoneService.ts.
 *
 * IMPORTANT (no new dependencies): all formatting goes through the platform
 * `Intl` API; we never pull in a timezone library.
 */

/**
 * The persisted setting. An empty `timeZone` ("") is the sentinel for "follow
 * the system/local zone" — this stays correct even if the OS zone changes,
 * rather than baking in the zone at the time the setting was saved.
 */
export type TimeZoneSettings = {
  /** IANA zone id (e.g. "America/New_York"), or "" to follow the system zone. */
  timeZone: string
}

/** Default: follow the system/local zone. */
export const DEFAULT_TIMEZONE_SETTINGS: TimeZoneSettings = {
  timeZone: '',
}

/**
 * Curated fallback used only when the runtime lacks
 * `Intl.supportedValuesOf('timeZone')`. Covers a broad spread of UTC offsets so
 * the dropdown is still useful on older engines.
 */
export const FALLBACK_TIME_ZONES: string[] = [
  'UTC',
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Atlantic/Azores',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Athens',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

type IntlWithSupportedValues = typeof Intl & {
  supportedValuesOf?: (key: string) => string[]
}

/**
 * The list of selectable IANA zones. Prefers the live
 * `Intl.supportedValuesOf('timeZone')` set; falls back to a curated list on
 * runtimes that don't support it (or if it throws). Never throws.
 */
export function getSupportedTimeZones(): string[] {
  try {
    const intl = Intl as IntlWithSupportedValues
    if (typeof intl.supportedValuesOf === 'function') {
      const values = intl.supportedValuesOf('timeZone')
      if (Array.isArray(values) && values.length > 0) {
        return values
      }
    }
  } catch {
    // fall through to the curated list
  }
  return [...FALLBACK_TIME_ZONES]
}

/**
 * The system/local IANA zone id (e.g. "Europe/London"), or "UTC" if the runtime
 * can't resolve one. Never throws.
 */
export function getSystemTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** True if `zone` is a valid IANA zone the runtime can format with. */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0) {
    return false
  }
  try {
    // Throws a RangeError for unknown zones.
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0)
    return true
  } catch {
    return false
  }
}

/**
 * Coerce any stored/partial value into valid settings. Never throws: missing or
 * malformed data falls back to the default ("follow system"), and an
 * unrecognized zone id is dropped back to the default rather than being kept.
 */
export function normalizeTimeZoneSettings(value: Partial<TimeZoneSettings> | undefined | null): TimeZoneSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_TIMEZONE_SETTINGS }
  }
  const raw = value.timeZone
  if (raw === '' || raw === undefined || raw === null) {
    return { timeZone: '' }
  }
  if (isValidTimeZone(raw)) {
    return { timeZone: raw }
  }
  return { ...DEFAULT_TIMEZONE_SETTINGS }
}

/**
 * Resolve the configured zone to a concrete IANA id. An empty/"follow system"
 * setting resolves to the live system zone (so it tracks OS changes). An invalid
 * stored zone also resolves to the system zone. Never throws.
 *
 * Pass the already-read settings (keeps this pure/testable); the app-bound
 * wrapper in timezoneService.ts reads them from storage first.
 */
export function getConfiguredTimeZone(settings: TimeZoneSettings = DEFAULT_TIMEZONE_SETTINGS): string {
  const normalized = normalizeTimeZoneSettings(settings)
  if (normalized.timeZone === '') {
    return getSystemTimeZone()
  }
  return normalized.timeZone
}

/** Options controlling how the clock widget renders an instant. */
export type ClockFormatOptions = {
  /** Use 24-hour time (true) vs 12-hour with AM/PM (false). */
  hour24: boolean
  /** Include seconds in the time. */
  showSeconds: boolean
}

export const DEFAULT_CLOCK_FORMAT_OPTIONS: ClockFormatOptions = {
  hour24: true,
  showSeconds: true,
}

/**
 * Format the time portion of `instant` in `timeZone` via `Intl.DateTimeFormat`.
 * Falls back to the system zone if `timeZone` is invalid. Never throws.
 *
 * Deterministic given a fixed `instant` + `timeZone` (unit-tested that way).
 */
export function formatTimeInZone(
  instant: Date,
  timeZone: string,
  options: ClockFormatOptions = DEFAULT_CLOCK_FORMAT_OPTIONS,
): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : getSystemTimeZone()
  const formatOptions: Intl.DateTimeFormatOptions = {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: !options.hour24,
  }
  if (options.showSeconds) {
    formatOptions.second = '2-digit'
  }
  try {
    return new Intl.DateTimeFormat(undefined, formatOptions).format(instant)
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...formatOptions, timeZone: undefined }).format(instant)
  }
}

/**
 * Format the date portion of `instant` in `timeZone` (e.g. "Mon, Jun 21, 2026").
 * Falls back to the system zone if `timeZone` is invalid. Never throws.
 */
export function formatDateInZone(instant: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : getSystemTimeZone()
  const formatOptions: Intl.DateTimeFormatOptions = {
    timeZone: zone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }
  try {
    return new Intl.DateTimeFormat(undefined, formatOptions).format(instant)
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...formatOptions, timeZone: undefined }).format(instant)
  }
}

/**
 * A short UTC-offset label for a zone at a given instant (e.g. "GMT+9"), used in
 * the world-clock list. Returns "" if it can't be computed. Never throws.
 */
export function formatZoneOffsetLabel(instant: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : getSystemTimeZone()
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
    }).formatToParts(instant)
    const tzPart = parts.find((p) => p.type === 'timeZoneName')
    return tzPart ? tzPart.value : ''
  } catch {
    return ''
  }
}

/** A friendlier label for a zone id in the dropdown (e.g. "America/New York"). */
export function timeZoneDisplayLabel(zone: string): string {
  return zone.replace(/_/g, ' ')
}
