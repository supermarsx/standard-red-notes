import { EmailBackupFrequency } from '@standardnotes/settings'
import { isEmailBackupDue } from './EmailBackupDueCalculator'

describe('isEmailBackupDue', () => {
  const NOW = Date.UTC(2026, 5, 20, 12, 0, 0) // 2026-06-20T12:00:00Z
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  describe('disabled / unknown frequency', () => {
    it('is never due when disabled, even if never sent', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Disabled, null, NOW)).toBe(false)
    })

    it('is never due for an unknown frequency string', () => {
      expect(isEmailBackupDue('yearly', null, NOW)).toBe(false)
    })

    it('is never due when lastSent is a NaN-producing junk value but frequency disabled', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Disabled, Number.NaN, NOW)).toBe(false)
    })
  })

  describe('never sent before', () => {
    it('daily is due immediately when never sent', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Daily, null, NOW)).toBe(true)
    })

    it('weekly is due immediately when never sent', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Weekly, null, NOW)).toBe(true)
    })

    it('monthly is due immediately when never sent', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Monthly, null, NOW)).toBe(true)
    })

    it('treats a NaN lastSent as never-sent (due) for a recurring frequency', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Daily, Number.NaN, NOW)).toBe(true)
    })
  })

  describe('daily', () => {
    it('is NOT due 1 hour after last send', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Daily, NOW - 60 * 60 * 1000, NOW)).toBe(false)
    })

    it('is due exactly 24h after last send', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Daily, NOW - MS_PER_DAY, NOW)).toBe(true)
    })

    it('is due when overdue (catches up missed runs)', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Daily, NOW - 5 * MS_PER_DAY, NOW)).toBe(true)
    })
  })

  describe('weekly', () => {
    it('is NOT due 3 days after last send', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Weekly, NOW - 3 * MS_PER_DAY, NOW)).toBe(false)
    })

    it('is due exactly 7 days after last send', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Weekly, NOW - 7 * MS_PER_DAY, NOW)).toBe(true)
    })

    it('is due when 10 days have elapsed', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Weekly, NOW - 10 * MS_PER_DAY, NOW)).toBe(true)
    })
  })

  describe('monthly', () => {
    it('is NOT due 20 days after last send', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Monthly, NOW - 20 * MS_PER_DAY, NOW)).toBe(false)
    })

    it('is due exactly 30 days after last send', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Monthly, NOW - 30 * MS_PER_DAY, NOW)).toBe(true)
    })

    it('is due when 45 days have elapsed', () => {
      expect(isEmailBackupDue(EmailBackupFrequency.Monthly, NOW - 45 * MS_PER_DAY, NOW)).toBe(true)
    })
  })
})
