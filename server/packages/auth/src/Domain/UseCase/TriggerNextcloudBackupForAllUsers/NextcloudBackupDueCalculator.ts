import { NextcloudBackupFrequency } from '@standardnotes/settings'

/**
 * Standard Red Notes: pure due-calculation for scheduled Nextcloud backups.
 *
 * Mirrors EmailBackupDueCalculator. Given a user's chosen frequency, the ms-epoch
 * timestamp of their last Nextcloud backup run (or null if never), and "now"
 * (ms epoch), decide whether a backup is due. A single, more-frequent cron can
 * therefore serve daily / weekly / monthly cadences and naturally catch up missed
 * runs (every overdue user is flagged due on the next pass).
 *
 * Intervals are minimum elapsed wall-clock since the last run:
 *  - daily   -> 24h
 *  - weekly  -> 7 days
 *  - monthly -> 30 days
 *  - disabled / unknown -> never due
 *
 * Pure and side-effect-free so it is trivially unit-testable.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

export const NEXTCLOUD_FREQUENCY_INTERVAL_MS: Partial<Record<NextcloudBackupFrequency, number>> = {
  [NextcloudBackupFrequency.Daily]: MS_PER_DAY,
  [NextcloudBackupFrequency.Weekly]: 7 * MS_PER_DAY,
  [NextcloudBackupFrequency.Monthly]: 30 * MS_PER_DAY,
}

export function isNextcloudBackupDue(
  frequency: NextcloudBackupFrequency | string,
  lastRunAtMs: number | null,
  nowMs: number,
): boolean {
  const intervalMs = NEXTCLOUD_FREQUENCY_INTERVAL_MS[frequency as NextcloudBackupFrequency]

  // Disabled, unknown, or otherwise non-recurring frequency: never due.
  if (intervalMs === undefined) {
    return false
  }

  // Never run before: due immediately.
  if (lastRunAtMs === null || Number.isNaN(lastRunAtMs)) {
    return true
  }

  return nowMs - lastRunAtMs >= intervalMs
}
