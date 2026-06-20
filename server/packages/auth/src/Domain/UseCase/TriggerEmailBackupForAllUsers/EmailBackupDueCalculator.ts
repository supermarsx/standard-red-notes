import { EmailBackupFrequency } from '@standardnotes/settings'

/**
 * Standard Red Notes: pure due-calculation for scheduled email backups.
 *
 * Given a user's chosen frequency, the timestamp (ms epoch) of the last backup
 * that was sent for them (or null if never), and "now" (ms epoch), decide whether
 * a backup is due. This lets a single, more-frequent cron serve daily / weekly /
 * monthly cadences and naturally catch up missed runs (if the job didn't run for
 * a while, every overdue user is still flagged due on the next run).
 *
 * Intervals are interpreted as minimum elapsed wall-clock since the last send:
 *  - daily   -> 24h
 *  - weekly  -> 7 days
 *  - monthly -> 30 days (calendar-month drift is acceptable for a backup cadence)
 *  - disabled / unknown -> never due
 *
 * Pure and side-effect-free so it is trivially unit-testable.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

export const FREQUENCY_INTERVAL_MS: Partial<Record<EmailBackupFrequency, number>> = {
  [EmailBackupFrequency.Daily]: MS_PER_DAY,
  [EmailBackupFrequency.Weekly]: 7 * MS_PER_DAY,
  [EmailBackupFrequency.Monthly]: 30 * MS_PER_DAY,
}

export function isEmailBackupDue(
  frequency: EmailBackupFrequency | string,
  lastSentAtMs: number | null,
  nowMs: number,
): boolean {
  const intervalMs = FREQUENCY_INTERVAL_MS[frequency as EmailBackupFrequency]

  // Disabled, unknown, or otherwise non-recurring frequency: never due.
  if (intervalMs === undefined) {
    return false
  }

  // Never sent before: due immediately.
  if (lastSentAtMs === null || Number.isNaN(lastSentAtMs)) {
    return true
  }

  return nowMs - lastSentAtMs >= intervalMs
}
