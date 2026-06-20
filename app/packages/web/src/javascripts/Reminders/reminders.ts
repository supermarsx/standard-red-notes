import { AppDataField, SNNote } from '@standardnotes/snjs'

/**
 * Standard Red Notes: per-note reminders.
 *
 * ## Where reminders are stored (and why)
 * A reminder lives in the note's encrypted `appData` bag — the exact mechanism
 * used for `pinned`, `archived`, `locked`, and our own per-note appearance
 * colors. We persist a single key (`reminders`, an array) under the default app
 * domain via `setAppDataItem`/`getAppDomainValue`.
 *
 * This is preferred over a separate local store because:
 *  - It syncs end-to-end with the note (so a reminder set on one device shows on
 *    every device — a true cross-device reminder).
 *  - It is tied to the note's lifecycle: delete the note, the reminder goes too.
 *  - It needs ZERO models/server changes (the key is not in the `AppDataField`
 *    enum, which lives in the models package we must not touch; we cast our
 *    string key to `AppDataField` at the storage boundary, exactly like the
 *    appearance helpers do — `setAppDataItem`/`getAppDomainValue` accept any
 *    string key).
 *
 * This is the in-app/browser reminder layer. A future email-reminder layer can
 * build on this same synced model (read `getNoteReminders` server-side / from a
 * worker) without changing the storage shape.
 *
 * The `notified` flag is what keeps the app-wide checker from re-firing a
 * notification for the same due reminder. It is part of the synced payload so a
 * reminder that already fired on one device won't re-spam on another after sync.
 */

export const NoteRemindersKey = 'reminders' as unknown as AppDataField

/**
 * Standard Red Notes: how often a reminder repeats.
 *
 *  - `none` (or a missing recurrence): one-shot — fires once and is then marked
 *    `notified`, exactly as reminders behaved before this feature.
 *  - `daily` / `weekly` / `monthly` / `yearly`: repeat at the natural interval.
 *  - `custom`: repeat every `interval` units of `unit` (e.g. every 2 weeks).
 *
 * For the fixed frequencies `interval`/`unit` are ignored. They only matter for
 * `custom`. The shape is intentionally permissive so old data (no recurrence at
 * all) and partial data never throw — see `normalizeRecurrence`.
 */
export type RecurrenceFrequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year'

export type Recurrence = {
  frequency: RecurrenceFrequency
  /** For `custom`: how many `unit`s between occurrences (>= 1). */
  interval?: number
  /** For `custom`: the unit the interval is measured in. */
  unit?: RecurrenceUnit
}

/** A single reminder attached to a note (generalizes to tasks/events). */
export type Reminder = {
  /** Stable id so a note can carry more than one reminder. */
  id: string
  /** When the reminder is due, as an ISO 8601 string. */
  dueAt: string
  /** Optional free-text message shown in the notification/toast. */
  message?: string
  /** Whether we've already fired a notification for this reminder. */
  notified?: boolean
  /**
   * Standard Red Notes: optional repeat schedule. When absent the reminder is a
   * one-shot (treated as `{ frequency: 'none' }`). Stored on the reminder so the
   * checker can advance `dueAt` to the next occurrence after firing.
   */
  recurrence?: Recurrence
  /**
   * Standard Red Notes: if the user opted THIS reminder into email delivery, the
   * uuid of the server-side email-reminder record. Stored so we can best-effort
   * cancel/replace that server record when the in-app reminder is cleared or its
   * time/message changes. Its presence means the reminder's time + message were
   * sent to the server in PLAINTEXT (out of end-to-end encryption) for emailing.
   */
  emailReminderId?: string
}

/** A reminder paired with the note it belongs to (for list views/checkers). */
export type ReminderWithNote = {
  note: SNNote
  reminder: Reminder
}

/**
 * Read the reminders stored on a note. Always returns a fresh array; tolerates
 * a missing/legacy value (undefined) and filters out malformed entries.
 */
export function getNoteReminders(note: SNNote): Reminder[] {
  const raw = note.getAppDomainValue<Reminder[] | undefined>(NoteRemindersKey)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.filter(isValidReminder).map((reminder) => ({ ...reminder }))
}

export function noteHasReminder(note: SNNote): boolean {
  return getNoteReminders(note).length > 0
}

/** True if the note has at least one reminder that is due but not yet notified. */
export function noteHasPendingReminder(note: SNNote, now: number): boolean {
  return getNoteReminders(note).some((reminder) => isReminderDue(reminder, now))
}

function isValidReminder(value: unknown): value is Reminder {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.dueAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.dueAt))
  )
}

/**
 * A reminder is "due" (and should fire) when its due time is at or before `now`
 * and it has not already been notified.
 */
export function isReminderDue(reminder: Reminder, now: number): boolean {
  if (reminder.notified) {
    return false
  }
  const due = Date.parse(reminder.dueAt)
  if (Number.isNaN(due)) {
    return false
  }
  return due <= now
}

/**
 * Pure: produce the next reminders array with `reminder` added (new id) or
 * replaced (matching id). Does NOT mutate the input array.
 */
export function upsertReminder(reminders: Reminder[], reminder: Reminder): Reminder[] {
  const next = reminders.filter((existing) => existing.id !== reminder.id)
  next.push({ ...reminder })
  return sortRemindersByDueAt(next)
}

/** Pure: produce the next reminders array with the reminder of `id` removed. */
export function removeReminder(reminders: Reminder[], id: string): Reminder[] {
  return reminders.filter((reminder) => reminder.id !== id)
}

/**
 * Pure: mark a reminder (by id) as notified so the checker won't fire it again.
 * Returns the same array reference shape (new array) for predictable writes.
 */
export function markReminderNotified(reminders: Reminder[], id: string): Reminder[] {
  return reminders.map((reminder) =>
    reminder.id === id ? { ...reminder, notified: true } : reminder,
  )
}

/** Pure: clear a reminder's `notified` flag (e.g. when its due time is edited). */
export function clearReminderNotified(reminder: Reminder): Reminder {
  const { notified: _notified, ...rest } = reminder
  return { ...rest }
}

export function sortRemindersByDueAt(reminders: Reminder[]): Reminder[] {
  return [...reminders].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
}

/**
 * Pure: from a list of (note, reminder) pairs, the ones that are due and not yet
 * notified given `now`. Used by the app-wide checker.
 */
export function selectDueReminders(
  pairs: ReminderWithNote[],
  now: number,
): ReminderWithNote[] {
  return pairs.filter(({ reminder }) => isReminderDue(reminder, now))
}

let idCounter = 0

/**
 * Generate a reasonably-unique reminder id. Uses `crypto.randomUUID` when
 * available, otherwise a time+counter fallback (keeps this pure-ish module
 * usable in tests without crypto).
 */
export function generateReminderId(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  idCounter += 1
  return `reminder-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/**
 * Standard Red Notes: coerce any stored/partial recurrence into a sane value.
 * Never throws — old reminders (no recurrence) and malformed data normalize to
 * one-shot `{ frequency: 'none' }`.
 */
export function normalizeRecurrence(recurrence: Recurrence | undefined): Recurrence {
  if (!recurrence || typeof recurrence !== 'object') {
    return { frequency: 'none' }
  }
  const frequency = recurrence.frequency
  switch (frequency) {
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'yearly':
      return { frequency }
    case 'custom': {
      const rawInterval = Number(recurrence.interval)
      const interval = Number.isFinite(rawInterval) && rawInterval >= 1 ? Math.floor(rawInterval) : 1
      const unit: RecurrenceUnit =
        recurrence.unit === 'day' ||
        recurrence.unit === 'week' ||
        recurrence.unit === 'month' ||
        recurrence.unit === 'year'
          ? recurrence.unit
          : 'day'
      return { frequency: 'custom', interval, unit }
    }
    default:
      return { frequency: 'none' }
  }
}

/** True if the reminder repeats (its normalized frequency is not 'none'). */
export function isRecurring(reminder: Reminder): boolean {
  return normalizeRecurrence(reminder.recurrence).frequency !== 'none'
}

/** Reduce a recurrence to a plain (interval, unit) step. Not called for 'none'. */
function recurrenceStep(recurrence: Recurrence): { interval: number; unit: RecurrenceUnit } {
  const normalized = normalizeRecurrence(recurrence)
  switch (normalized.frequency) {
    case 'daily':
      return { interval: 1, unit: 'day' }
    case 'weekly':
      return { interval: 1, unit: 'week' }
    case 'monthly':
      return { interval: 1, unit: 'month' }
    case 'yearly':
      return { interval: 1, unit: 'year' }
    case 'custom':
      return { interval: normalized.interval ?? 1, unit: normalized.unit ?? 'day' }
    default:
      // 'none' — caller guards against this; default to a day to avoid an infinite loop.
      return { interval: 1, unit: 'day' }
  }
}

/**
 * Advance a timestamp by one recurrence step.
 *
 * Day/week steps are pure millisecond arithmetic (so a "weekly" reminder lands
 * at the same wall-clock time even across a DST boundary the Date object will
 * normalize; using local-date setters keeps the local hour stable). Month/year
 * steps use local-date setters and CLAMP overflow: e.g. Jan 31 + 1 month is
 * Feb 28 (or Feb 29 in a leap year), not the JS default of rolling into March.
 */
function addStep(ms: number, interval: number, unit: RecurrenceUnit): number {
  const date = new Date(ms)
  switch (unit) {
    case 'day':
      date.setDate(date.getDate() + interval)
      return date.getTime()
    case 'week':
      date.setDate(date.getDate() + interval * 7)
      return date.getTime()
    case 'month':
      return addMonths(date, interval).getTime()
    case 'year':
      return addMonths(date, interval * 12).getTime()
    default:
      return ms
  }
}

/**
 * Add `count` whole months to a local date, clamping the day-of-month so we never
 * spill into the following month. Jan 31 + 1 month => Feb 28/29; Mar 31 + 1 =>
 * Apr 30. The time-of-day is preserved.
 */
function addMonths(date: Date, count: number): Date {
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  const targetMonthIndex = month + count
  const targetYear = year + Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12
  // Last day of the target month (day 0 of the next month).
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate()
  const clampedDay = Math.min(day, daysInTargetMonth)
  return new Date(
    targetYear,
    targetMonth,
    clampedDay,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  )
}

/**
 * Standard Red Notes: compute the next occurrence after `dueAt` for a recurring
 * reminder.
 *
 * Returns `undefined` for a one-shot (`none`/missing) recurrence. Otherwise
 * returns the timestamp exactly one recurrence step after `dueAt`. This is the
 * single-step primitive; the checker loops it (`advanceRecurringReminder`) to
 * catch up when several intervals elapsed while the app was closed.
 *
 * `dueAt` may be an ISO string or an epoch-ms number. An unparseable value
 * yields `undefined` (we never throw on bad data).
 */
export function computeNextOccurrence(
  dueAt: string | number,
  recurrence: Recurrence | undefined,
): number | undefined {
  const normalized = normalizeRecurrence(recurrence)
  if (normalized.frequency === 'none') {
    return undefined
  }
  const baseMs = typeof dueAt === 'number' ? dueAt : Date.parse(dueAt)
  if (Number.isNaN(baseMs)) {
    return undefined
  }
  const { interval, unit } = recurrenceStep(normalized)
  return addStep(baseMs, interval, unit)
}

/**
 * Standard Red Notes: advance a recurring reminder past `now`.
 *
 * Loops `computeNextOccurrence` forward until the new `dueAt` is strictly in the
 * future (so multiple missed intervals while offline are skipped in one pass),
 * and clears `notified` so the advanced reminder can fire again at its next time.
 *
 * Returns the same reminder unchanged for a one-shot recurrence (caller should
 * fall back to marking it notified), or if the dueAt can't be parsed/advanced.
 * A safety cap prevents pathological loops on tiny intervals + huge gaps.
 */
export function advanceRecurringReminder(reminder: Reminder, now: number): Reminder {
  const normalized = normalizeRecurrence(reminder.recurrence)
  if (normalized.frequency === 'none') {
    return reminder
  }
  let nextMs = computeNextOccurrence(reminder.dueAt, normalized)
  if (nextMs === undefined) {
    return reminder
  }
  // Skip any occurrences already in the past (missed while offline). Cap the
  // iterations defensively so a misconfigured tiny interval can't spin forever.
  let guard = 0
  const MAX_CATCHUP_STEPS = 100_000
  while (nextMs <= now && guard < MAX_CATCHUP_STEPS) {
    const advanced = computeNextOccurrence(nextMs, normalized)
    if (advanced === undefined || advanced <= nextMs) {
      break
    }
    nextMs = advanced
    guard += 1
  }
  return {
    ...reminder,
    dueAt: new Date(nextMs).toISOString(),
    notified: false,
  }
}

/**
 * Standard Red Notes: a concise human summary of a recurrence, e.g.
 * "Repeats daily", "Repeats every 2 weeks". Returns undefined for one-shot.
 */
export function describeRecurrence(recurrence: Recurrence | undefined): string | undefined {
  const normalized = normalizeRecurrence(recurrence)
  switch (normalized.frequency) {
    case 'none':
      return undefined
    case 'daily':
      return 'Repeats daily'
    case 'weekly':
      return 'Repeats weekly'
    case 'monthly':
      return 'Repeats monthly'
    case 'yearly':
      return 'Repeats yearly'
    case 'custom': {
      const interval = normalized.interval ?? 1
      const unit = normalized.unit ?? 'day'
      const plural = interval === 1 ? unit : `${unit}s`
      return interval === 1 ? `Repeats every ${unit}` : `Repeats every ${interval} ${plural}`
    }
    default:
      return undefined
  }
}

/** Format a reminder's due time relative to `now` for compact display. */
export function formatReminderRelative(reminder: Reminder, now: number): string {
  const due = Date.parse(reminder.dueAt)
  if (Number.isNaN(due)) {
    return 'Invalid date'
  }
  const diffMs = due - now
  const overdue = diffMs < 0
  const absMinutes = Math.round(Math.abs(diffMs) / 60000)

  let magnitude: string
  if (absMinutes < 1) {
    magnitude = 'less than a minute'
  } else if (absMinutes < 60) {
    magnitude = `${absMinutes} minute${absMinutes === 1 ? '' : 's'}`
  } else if (absMinutes < 60 * 24) {
    const hours = Math.round(absMinutes / 60)
    magnitude = `${hours} hour${hours === 1 ? '' : 's'}`
  } else {
    const days = Math.round(absMinutes / (60 * 24))
    magnitude = `${days} day${days === 1 ? '' : 's'}`
  }

  return overdue ? `${magnitude} overdue` : `in ${magnitude}`
}
