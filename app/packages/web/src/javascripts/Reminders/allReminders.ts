import { SNNote } from '@standardnotes/snjs'
import {
  Reminder,
  ReminderWithNote,
  describeRecurrence,
  getNoteReminders,
} from './reminders'

/**
 * Standard Red Notes: cross-note reminders collector for the Reminders aggregate
 * view.
 *
 * Reminders live in each note's appData (see {@link getNoteReminders}). This
 * module flattens every note's reminders into a single, sorted, grouped list,
 * each entry keeping a back-reference to its source note so the view can link to
 * it. It is a pure, in-memory derivation — no server polling — so the view can
 * recompute it on a throttle driven by `items.streamItems`, exactly like the
 * Dashboard.
 */

/** A flattened reminder paired with the minimal note context the view renders. */
export type AggregatedReminder = ReminderWithNote & {
  /** Epoch ms of the reminder's due time (parsed once for sorting/grouping). */
  dueMs: number
  /** Human recurrence summary (e.g. "Repeats weekly") or undefined for one-shot. */
  recurrenceSummary?: string
}

export type ReminderGroupKey = 'overdue' | 'today' | 'upcoming'

export type ReminderGroup = {
  key: ReminderGroupKey
  label: string
  reminders: AggregatedReminder[]
}

const GROUP_LABELS: Record<ReminderGroupKey, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
}

/**
 * Flatten every (non-trashed) note's reminders into a single list, sorted by due
 * time ascending. Notes without reminders cost a cheap array read and contribute
 * nothing.
 */
export function collectAllReminders(notes: SNNote[]): AggregatedReminder[] {
  const all: AggregatedReminder[] = []
  for (const note of notes) {
    if (note.trashed) {
      continue
    }
    for (const reminder of getNoteReminders(note)) {
      const dueMs = Date.parse(reminder.dueAt)
      if (Number.isNaN(dueMs)) {
        continue
      }
      all.push({
        note,
        reminder,
        dueMs,
        recurrenceSummary: describeRecurrence(reminder.recurrence),
      })
    }
  }
  return all.sort((a, b) => a.dueMs - b.dueMs)
}

/** Local start-of-day epoch ms for the day containing `now`. */
function startOfDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Local start-of-NEXT-day epoch ms for the day containing `now`. */
function startOfNextDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

/**
 * Bucket reminders into Overdue / Today / Upcoming relative to `now`:
 *  - overdue: due strictly before the start of today
 *  - today: due at any point during today
 *  - upcoming: due tomorrow or later
 *
 * Each bucket keeps the ascending-by-due-time order of the input. Empty buckets
 * are omitted so the view never renders a header with no rows.
 */
export function groupReminders(reminders: AggregatedReminder[], now: number): ReminderGroup[] {
  const dayStart = startOfDay(now)
  const nextDay = startOfNextDay(now)

  const overdue: AggregatedReminder[] = []
  const today: AggregatedReminder[] = []
  const upcoming: AggregatedReminder[] = []

  for (const reminder of reminders) {
    if (reminder.dueMs < dayStart) {
      overdue.push(reminder)
    } else if (reminder.dueMs < nextDay) {
      today.push(reminder)
    } else {
      upcoming.push(reminder)
    }
  }

  const groups: ReminderGroup[] = []
  if (overdue.length > 0) {
    groups.push({ key: 'overdue', label: GROUP_LABELS.overdue, reminders: overdue })
  }
  if (today.length > 0) {
    groups.push({ key: 'today', label: GROUP_LABELS.today, reminders: today })
  }
  if (upcoming.length > 0) {
    groups.push({ key: 'upcoming', label: GROUP_LABELS.upcoming, reminders: upcoming })
  }
  return groups
}

/** Convenience: collect + group in one call. */
export function collectAndGroupReminders(notes: SNNote[], now: number): ReminderGroup[] {
  return groupReminders(collectAllReminders(notes), now)
}

/**
 * Synthesize a single read-only plaintext document that virtually concatenates
 * every reminder into one readable page. This is NOT a saved note — it is built
 * on the fly from the aggregated reminders so the Reminders view can offer a
 * "combined" reading mode. Mirrors the grouping of the list.
 */
export function buildCombinedReminderDocument(
  reminders: AggregatedReminder[],
  now: number,
  formatDateTime: (ms: number) => string,
): string {
  if (reminders.length === 0) {
    return 'No reminders yet.'
  }
  const groups = groupReminders(reminders, now)
  const lines: string[] = ['All reminders', '']
  for (const group of groups) {
    lines.push(`# ${group.label} (${group.reminders.length})`)
    lines.push('')
    for (const { note, reminder, dueMs, recurrenceSummary } of group.reminders) {
      const title = note.title?.trim() || 'Untitled'
      lines.push(`• ${formatDateTime(dueMs)} — ${title}`)
      if (reminder.message?.trim()) {
        lines.push(`    ${reminder.message.trim()}`)
      }
      if (recurrenceSummary) {
        lines.push(`    ${recurrenceSummary}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

export type { Reminder }
