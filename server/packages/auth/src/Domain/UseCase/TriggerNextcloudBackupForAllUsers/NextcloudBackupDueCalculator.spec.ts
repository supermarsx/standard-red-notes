import { NextcloudBackupFrequency } from '@standardnotes/settings'
import { isNextcloudBackupDue } from './NextcloudBackupDueCalculator'

describe('isNextcloudBackupDue', () => {
  const NOW = Date.UTC(2026, 5, 21, 12, 0, 0) // 2026-06-21T12:00:00Z
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  describe('disabled / unknown frequency', () => {
    it('is never due when disabled, even if never run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Disabled, null, NOW)).toBe(false)
    })

    it('is never due for an unknown frequency string', () => {
      expect(isNextcloudBackupDue('yearly', null, NOW)).toBe(false)
    })

    it('is never due when lastRun is NaN but frequency disabled', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Disabled, Number.NaN, NOW)).toBe(false)
    })
  })

  describe('never run before', () => {
    it('daily is due immediately when never run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Daily, null, NOW)).toBe(true)
    })

    it('weekly is due immediately when never run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Weekly, null, NOW)).toBe(true)
    })

    it('monthly is due immediately when never run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Monthly, null, NOW)).toBe(true)
    })

    it('treats a NaN lastRun as never-run (due) for a recurring frequency', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Daily, Number.NaN, NOW)).toBe(true)
    })
  })

  describe('daily', () => {
    it('is NOT due 1 hour after last run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Daily, NOW - 60 * 60 * 1000, NOW)).toBe(false)
    })

    it('is due exactly 24h after last run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Daily, NOW - MS_PER_DAY, NOW)).toBe(true)
    })

    it('is due when overdue (catches up missed runs)', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Daily, NOW - 5 * MS_PER_DAY, NOW)).toBe(true)
    })
  })

  describe('weekly', () => {
    it('is NOT due 3 days after last run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Weekly, NOW - 3 * MS_PER_DAY, NOW)).toBe(false)
    })

    it('is due exactly 7 days after last run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Weekly, NOW - 7 * MS_PER_DAY, NOW)).toBe(true)
    })

    it('is due when 10 days have elapsed', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Weekly, NOW - 10 * MS_PER_DAY, NOW)).toBe(true)
    })
  })

  describe('monthly', () => {
    it('is NOT due 20 days after last run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Monthly, NOW - 20 * MS_PER_DAY, NOW)).toBe(false)
    })

    it('is due exactly 30 days after last run', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Monthly, NOW - 30 * MS_PER_DAY, NOW)).toBe(true)
    })

    it('is due when 45 days have elapsed', () => {
      expect(isNextcloudBackupDue(NextcloudBackupFrequency.Monthly, NOW - 45 * MS_PER_DAY, NOW)).toBe(true)
    })
  })
})
