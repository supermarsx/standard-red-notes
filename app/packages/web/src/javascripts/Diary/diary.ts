/**
 * Standard Red Notes: Diary mode — pure, dependency-free core.
 *
 * Diary mode notifies the user once per calendar day (at a configured time of
 * day) to write that day's diary entry, and opens/creates today's entry on
 * demand. This module holds ONLY the pure logic so it can be unit-tested without
 * a running application:
 *
 *  - the settings shape + defaults,
 *  - a stable per-calendar-date key (used both for the dedupe "last prompted
 *    date" and for the diary note title), and
 *  - `isDiaryPromptDue`, the single predicate the scheduler asks every tick.
 *
 * Where things live (web-only, no models changes):
 *  - The enable flag + prompt time are stored via the app's storage K/V
 *    (`application.getValue`/`setValue`) — the same local-store precedent used by
 *    the email-backup/large-file features, which deliberately avoided adding keys
 *    to the published `@standardnotes/models` `PrefKey` enum. See diarySettings.ts.
 *  - The dedupe "last prompted date" is persisted in `window.localStorage`
 *    (per-device, not synced) so the prompt fires at most once per day per
 *    device. See diarySettings.ts.
 */

/** Persisted Diary settings (enable flag + daily prompt time-of-day). */
export type DiarySettings = {
  /** Whether Diary mode (the daily prompt) is enabled. */
  enabled: boolean
  /** Hour of day (0–23, local time) the prompt becomes due. */
  hour: number
  /** Minute of the hour (0–59, local time) the prompt becomes due. */
  minute: number
}

/** Default: disabled, prompting at 20:00 local time when enabled. */
export const DEFAULT_DIARY_SETTINGS: DiarySettings = {
  enabled: false,
  hour: 20,
  minute: 0,
}

/**
 * Coerce any stored/partial value into valid settings. Never throws: missing or
 * malformed data falls back to the defaults, and the time is clamped into range.
 */
export function normalizeDiarySettings(value: Partial<DiarySettings> | undefined | null): DiarySettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DIARY_SETTINGS }
  }
  const enabled = value.enabled === true
  const hour = clampInt(value.hour, 0, 23, DEFAULT_DIARY_SETTINGS.hour)
  const minute = clampInt(value.minute, 0, 59, DEFAULT_DIARY_SETTINGS.minute)
  return { enabled, hour, minute }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * Stable identifier for the calendar date of `date` in LOCAL time, as
 * `YYYY-MM-DD`. Used for (a) the per-day dedupe key and (b) the diary note's
 * title, so "today's entry" is deterministically findable. Local-time based so a
 * user's diary day matches their wall clock, not UTC.
 */
export function dateKeyForDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The diary note title for a given date (the date key). */
export function diaryTitleForDate(date: Date): string {
  return dateKeyForDate(date)
}

/**
 * The local-time timestamp (epoch ms) at which the prompt becomes due on the
 * calendar date of `now`.
 */
export function dueTimeForDay(now: Date, hour: number, minute: number): number {
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
  return due.getTime()
}

/** Inputs to the due check — all plain data so the predicate stays pure/testable. */
export type DiaryPromptDueInput = {
  settings: DiarySettings
  /** Current wall-clock time. */
  now: Date
  /** The date key we last prompted on (from localStorage), or null if never. */
  lastPromptedDateKey: string | null
  /** Whether a diary entry already exists for today's date. */
  entryExistsForToday: boolean
}

/**
 * THE core predicate. The diary prompt is due now iff ALL hold:
 *  - Diary mode is enabled,
 *  - the current local time is at/after today's configured prompt time,
 *  - we have NOT already prompted for today's calendar date (dedupe), and
 *  - no diary entry exists for today yet (so it never re-fires once written).
 *
 * Date rollover re-arms automatically: `lastPromptedDateKey` is compared against
 * TODAY's key, so yesterday's value no longer suppresses today's prompt.
 */
export function isDiaryPromptDue(input: DiaryPromptDueInput): boolean {
  const { settings, now, lastPromptedDateKey, entryExistsForToday } = input
  if (!settings.enabled) {
    return false
  }
  if (entryExistsForToday) {
    return false
  }
  const todayKey = dateKeyForDate(now)
  if (lastPromptedDateKey === todayKey) {
    return false
  }
  return now.getTime() >= dueTimeForDay(now, settings.hour, settings.minute)
}

/** Format an hour/minute as a zero-padded `HH:MM` for the time `<input>`. */
export function formatPromptTime(hour: number, minute: number): string {
  return `${`${hour}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`
}

/** Parse an `HH:MM` time string into { hour, minute }, or null if invalid. */
export function parsePromptTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) {
    return null
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  return { hour, minute }
}
