import { WebApplication } from '@/Application/WebApplication'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { dismissToast, ToastType } from '@standardnotes/toast'
import { useEffect } from 'react'
import { getNoteReminders, isReminderDue, Reminder } from './reminders'
import { showNotification } from './notificationService'

/**
 * Standard Red Notes: app-wide due-reminder checker.
 *
 * Mounted once in `ApplicationView` (alongside `useConflictWarnings` /
 * `usePreferenceSyncToast`). On a fixed interval it scans every note's appData
 * reminders for ones that are due and not yet notified, then:
 *  - fires an OS notification (when permitted) + an in-app toast, and
 *  - marks that reminder `notified` (persisted to the note's appData, which
 *    syncs) so it never fires again — including on other devices after sync.
 *
 * No-spam guarantees:
 *  - `isReminderDue` excludes already-notified reminders, so each reminder
 *    fires at most once.
 *  - We also keep an in-memory `firedThisSession` set keyed by reminder id, so a
 *    reminder can't double-fire in the window between firing and the async
 *    appData write landing (e.g. two ticks close together).
 *  - The interval is opt-in by data: notes with no reminders cost a cheap array
 *    read and nothing fires until the user actually sets one.
 *
 * The timer is cleaned up on unmount.
 */

/** How often to scan for due reminders. */
export const REMINDER_CHECK_INTERVAL_MS = 30_000

/** Pure scan used by both the hook and tests: which reminders are due now. */
export function collectDueReminders(
  notes: SNNote[],
  now: number,
): { note: SNNote; reminder: Reminder }[] {
  const due: { note: SNNote; reminder: Reminder }[] = []
  for (const note of notes) {
    if (note.trashed || note.archived) {
      continue
    }
    for (const reminder of getNoteReminders(note)) {
      if (isReminderDue(reminder, now)) {
        due.push({ note, reminder })
      }
    }
  }
  return due
}

export const useReminderChecker = (application: WebApplication): void => {
  useEffect(() => {
    const firedThisSession = new Set<string>()

    const runCheck = () => {
      const now = Date.now()
      const notes = application.items.getItems<SNNote>(ContentType.TYPES.Note)
      const due = collectDueReminders(notes, now)

      for (const { note, reminder } of due) {
        if (firedThisSession.has(reminder.id)) {
          continue
        }
        firedThisSession.add(reminder.id)

        const title = note.title?.trim() || 'Reminder'
        const body = reminder.message?.trim() || 'A reminder you set is now due.'

        showNotification(title, {
          body,
          tag: `reminder-${reminder.id}`,
          toastType: ToastType.Regular,
          onClick: () => {
            application.itemListController.openNote(note.uuid).catch(console.error)
          },
          toastActions: [
            {
              label: 'Open note',
              handler: (toastId) => {
                application.itemListController.openNote(note.uuid).catch(console.error)
                dismissToast(toastId)
              },
            },
          ],
        })

        // Persist notified so it doesn't re-fire after a reload / on other
        // devices. Fire-and-forget; the in-memory set covers the interim.
        application.notesController.markNoteReminderNotified(note, reminder.id).catch(console.error)
      }
    }

    // Run once shortly after mount so an already-due reminder surfaces promptly,
    // then on the interval.
    runCheck()
    const intervalId = setInterval(runCheck, REMINDER_CHECK_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [application])
}
