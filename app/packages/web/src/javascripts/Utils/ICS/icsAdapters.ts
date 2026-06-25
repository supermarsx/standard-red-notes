import { CalendarEvent, CalendarRecurrence, isTimedEvent } from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { Reminder, normalizeRecurrence } from '@/Reminders/reminders'
import { ICSEvent, ICSRecurrence, ICSRecurrenceFrequency } from './toICS'

/**
 * Standard Red Notes: adapters from our in-app domain types (Calendar note
 * events, per-note reminders) to the neutral {@link ICSEvent} shape consumed by
 * {@link toICS}. Kept separate from the generator so the generator stays a pure,
 * domain-agnostic RFC 5545 encoder and these adapters carry the
 * Standard-Red-Notes-specific mapping decisions.
 */

/**
 * Map a Calendar note event's recurrence to an ICS RRULE recurrence, or
 * undefined for a one-shot. The Calendar model's freq values line up 1:1 with
 * the ICS frequencies, so this is a thin pass-through that also carries a >1
 * interval.
 */
export const calendarRecurrenceToICS = (recurrence: CalendarRecurrence | undefined): ICSRecurrence | undefined => {
  if (!recurrence) {
    return undefined
  }
  const frequency: ICSRecurrenceFrequency = recurrence.freq
  const interval = recurrence.interval && recurrence.interval > 1 ? Math.floor(recurrence.interval) : undefined
  return interval ? { frequency, interval } : { frequency }
}

/**
 * Map a Calendar note event to an {@link ICSEvent}. A timed event (allDay:false
 * with a parseable `start`) emits a timed VEVENT carrying its start/end; every
 * other event (including legacy day-only events) emits an all-day VEVENT on its
 * anchor `date`. Recurrence, when present, becomes an RRULE so the whole series
 * exports. The UID namespaces the source note so the same event id across two
 * notes never collides in the exported file.
 */
export const calendarEventToICS = (event: CalendarEvent, noteUuid: string, noteTitle?: string): ICSEvent => {
  const base: ICSEvent = {
    uid: `${noteUuid}-${event.id}@standard-red-notes`,
    title: event.title || 'Untitled',
    description: noteTitle?.trim() ? `From: ${noteTitle.trim()}` : undefined,
    recurrence: calendarRecurrenceToICS(event.recurrence),
  }

  if (isTimedEvent(event) && event.start) {
    return { ...base, start: event.start, end: event.end }
  }

  return { ...base, date: event.date }
}

/**
 * Map our reminder recurrence to an ICS RRULE recurrence, or undefined for a
 * one-shot. `custom` with a unit maps onto the matching FREQ + INTERVAL; a
 * `week` unit becomes WEEKLY, `month` -> MONTHLY, etc. Anything unmappable
 * (shouldn't happen after normalization) yields undefined so we fall back to a
 * single (next-occurrence) VEVENT rather than emitting a bogus rule.
 */
export const reminderRecurrenceToICS = (reminder: Reminder): ICSRecurrence | undefined => {
  const normalized = normalizeRecurrence(reminder.recurrence)
  switch (normalized.frequency) {
    case 'none':
      return undefined
    case 'daily':
      return { frequency: 'daily' }
    case 'weekly':
      return { frequency: 'weekly' }
    case 'monthly':
      return { frequency: 'monthly' }
    case 'yearly':
      return { frequency: 'yearly' }
    case 'custom': {
      const unitToFreq: Record<string, ICSRecurrenceFrequency> = {
        day: 'daily',
        week: 'weekly',
        month: 'monthly',
        year: 'yearly',
      }
      const frequency = unitToFreq[normalized.unit ?? 'day']
      if (!frequency) {
        return undefined
      }
      return { frequency, interval: normalized.interval ?? 1 }
    }
    default:
      return undefined
  }
}

/**
 * A reminder is a timed instant (`dueAt` ISO). We emit a timed VEVENT in UTC
 * (no DTEND -> a zero-duration / point-in-time entry, which calendar apps render
 * as an event at that minute). Recurring reminders carry an RRULE so the whole
 * series exports rather than just the next occurrence.
 */
export const reminderToICS = (reminder: Reminder, noteUuid: string, noteTitle?: string): ICSEvent => ({
  uid: `${noteUuid}-${reminder.id}@standard-red-notes`,
  title: noteTitle?.trim() || 'Reminder',
  description: reminder.message?.trim() || undefined,
  start: reminder.dueAt,
  recurrence: reminderRecurrenceToICS(reminder),
})
