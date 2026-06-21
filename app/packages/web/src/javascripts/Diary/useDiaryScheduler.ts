import { WebApplication } from '@/Application/WebApplication'
import { ToastType } from '@standardnotes/toast'
import { useEffect } from 'react'
import { showNotification } from '@/Reminders/notificationService'
import { dateKeyForDate, isDiaryPromptDue } from './diary'
import {
  diaryEntryExistsForDate,
  getDiarySettings,
  getLastPromptedDateKey,
  openOrCreateDiaryEntry,
  setLastPromptedDateKey,
} from './diaryService'

/**
 * Standard Red Notes: app-wide once-a-day Diary prompt scheduler.
 *
 * Mounted once in `ApplicationView` alongside `useReminderChecker`. Deliberately
 * SEPARATE from the reminder checker (different cadence, different storage, no
 * note appData) per the feature brief — it shares only the framework-agnostic
 * `notificationService`.
 *
 * Each tick (every minute) it asks the pure `isDiaryPromptDue` predicate whether,
 * for TODAY's calendar date, the prompt is due: enabled AND now ≥ configured time
 * AND not already prompted today AND no diary entry exists for today. When due it
 * fires ONE OS notification (+ in-app toast fallback) whose click opens/creates
 * today's entry, and records today's date key so it can't fire again that day.
 *
 * No-spam / correctness guarantees:
 *  - Dedupe is per calendar date via a localStorage marker; date rollover
 *    re-arms automatically (the predicate compares against today's key).
 *  - An in-memory `firedForDateThisSession` guards the gap between firing and the
 *    localStorage write (and survives a settings re-read mid-session).
 *  - Once the user writes today's entry, `entryExistsForToday` becomes true and
 *    the prompt won't re-fire.
 *  - Notification permission is never requested here; `showNotification` degrades
 *    gracefully to an in-app toast when permission is denied/unsupported.
 *
 * No tight loops, no server polling — just a 1-minute interval that reads local
 * state.
 */

/** How often to check whether today's diary prompt is due. */
export const DIARY_CHECK_INTERVAL_MS = 60_000

export const useDiaryScheduler = (application: WebApplication): void => {
  useEffect(() => {
    let firedForDateThisSession: string | null = null

    const runCheck = () => {
      // Don't touch app storage until local data has loaded: application.getValue
      // throws "before loading local storage" if called during the launch sequence
      // (this hook mounts in ApplicationView, which can render before launch finishes).
      if (!application.isLaunched()) {
        return
      }

      const settings = getDiarySettings(application)
      if (!settings.enabled) {
        return
      }

      const now = new Date()
      const todayKey = dateKeyForDate(now)

      // In-session guard: covers the window before the localStorage write lands
      // and any same-tick double-entry.
      if (firedForDateThisSession === todayKey) {
        return
      }

      const due = isDiaryPromptDue({
        settings,
        now,
        lastPromptedDateKey: getLastPromptedDateKey(),
        entryExistsForToday: diaryEntryExistsForDate(application, now),
      })

      if (!due) {
        return
      }

      firedForDateThisSession = todayKey
      setLastPromptedDateKey(todayKey)

      showNotification('Time for your diary entry', {
        body: "Take a moment to write today's diary entry.",
        tag: `diary-${todayKey}`,
        toastType: ToastType.Regular,
        onClick: () => {
          openOrCreateDiaryEntry(application).catch(console.error)
        },
        toastActions: [
          {
            label: "Write today's entry",
            handler: () => {
              openOrCreateDiaryEntry(application).catch(console.error)
            },
          },
        ],
      })
    }

    // Run shortly after mount so an already-due prompt surfaces promptly, then on
    // the interval.
    runCheck()
    const intervalId = setInterval(runCheck, DIARY_CHECK_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [application])
}
