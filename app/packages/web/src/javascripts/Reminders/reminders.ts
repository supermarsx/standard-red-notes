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
