import {
  isCheckDue,
  updateCheckIntervalToMs,
  readLastCheckedAt,
  readLastStatusSnapshot,
  UPDATE_CHECK_EVERY_LOAD_MS,
  UPDATE_CHECK_INTERVAL_OPTIONS,
  UPDATE_CHECK_NEVER_MS,
} from './UpdateCheckService'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('updateCheckIntervalToMs', () => {
  it('maps the sentinels', () => {
    expect(updateCheckIntervalToMs('every-load')).toBe(UPDATE_CHECK_EVERY_LOAD_MS)
    expect(updateCheckIntervalToMs('never')).toBe(UPDATE_CHECK_NEVER_MS)
  })

  it('maps sub-day intervals', () => {
    expect(updateCheckIntervalToMs('every-hour')).toBe(HOUR)
    expect(updateCheckIntervalToMs('every-6-hours')).toBe(6 * HOUR)
    expect(updateCheckIntervalToMs('every-12-hours')).toBe(12 * HOUR)
  })

  it('maps day-and-above intervals', () => {
    expect(updateCheckIntervalToMs('every-day')).toBe(DAY)
    expect(updateCheckIntervalToMs('every-3-days')).toBe(3 * DAY)
    expect(updateCheckIntervalToMs('every-week')).toBe(7 * DAY)
    expect(updateCheckIntervalToMs('every-2-weeks')).toBe(14 * DAY)
    expect(updateCheckIntervalToMs('every-month')).toBe(30 * DAY)
    expect(updateCheckIntervalToMs('every-3-months')).toBe(90 * DAY)
    expect(updateCheckIntervalToMs('every-6-months')).toBe(182 * DAY)
    expect(updateCheckIntervalToMs('every-year')).toBe(365 * DAY)
  })

  it('falls back to every-week for unknown values (e.g. prefs from a newer client)', () => {
    expect(updateCheckIntervalToMs('every-decade')).toBe(7 * DAY)
    expect(updateCheckIntervalToMs('')).toBe(7 * DAY)
  })

  it('has a mapping for every dropdown option', () => {
    for (const option of UPDATE_CHECK_INTERVAL_OPTIONS) {
      expect(typeof updateCheckIntervalToMs(option.value)).toBe('number')
    }
  })

  it('offers exactly the required options in order', () => {
    expect(UPDATE_CHECK_INTERVAL_OPTIONS.map((option) => option.label)).toEqual([
      'Every load',
      'Every hour',
      'Every 6 hours',
      'Every 12 hours',
      'Every day',
      'Every 3 days',
      'Every week',
      'Every 2 weeks',
      'Every month',
      'Every 3 months',
      'Every 6 months',
      'Every year',
      'Never',
    ])
  })
})

describe('isCheckDue', () => {
  const NOW = new Date('2026-07-01T12:00:00.000Z').getTime()

  it('is never due for the never interval, even with no prior check', () => {
    expect(isCheckDue(undefined, 'never', NOW)).toBe(false)
    expect(isCheckDue(NOW - 400 * DAY, 'never', NOW)).toBe(false)
  })

  it('is always due for every-load, even immediately after a check', () => {
    expect(isCheckDue(NOW, 'every-load', NOW)).toBe(true)
    expect(isCheckDue(undefined, 'every-load', NOW)).toBe(true)
  })

  it('is due when this device has never checked', () => {
    expect(isCheckDue(undefined, 'every-week', NOW)).toBe(true)
    expect(isCheckDue(null, 'every-week', NOW)).toBe(true)
    expect(isCheckDue(Number.NaN, 'every-week', NOW)).toBe(true)
  })

  it('is due once the interval has elapsed (inclusive boundary)', () => {
    expect(isCheckDue(NOW - 7 * DAY, 'every-week', NOW)).toBe(true)
    expect(isCheckDue(NOW - 7 * DAY - 1, 'every-week', NOW)).toBe(true)
  })

  it('is not due before the interval has elapsed', () => {
    expect(isCheckDue(NOW - 6 * DAY, 'every-week', NOW)).toBe(false)
    expect(isCheckDue(NOW - 30 * 60 * 1000, 'every-hour', NOW)).toBe(false)
  })

  it('handles sub-day intervals', () => {
    expect(isCheckDue(NOW - 2 * HOUR, 'every-hour', NOW)).toBe(true)
    expect(isCheckDue(NOW - 5 * HOUR, 'every-6-hours', NOW)).toBe(false)
    expect(isCheckDue(NOW - 13 * HOUR, 'every-12-hours', NOW)).toBe(true)
  })
})

describe('device-local persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('readLastCheckedAt returns undefined when nothing is stored', () => {
    expect(readLastCheckedAt()).toBeUndefined()
  })

  it('readLastCheckedAt returns undefined for garbage values', () => {
    localStorage.setItem('srn-update-check-last-checked-at', 'not-a-number')
    expect(readLastCheckedAt()).toBeUndefined()
  })

  it('readLastCheckedAt round-trips a stored timestamp', () => {
    localStorage.setItem('srn-update-check-last-checked-at', '1234567890')
    expect(readLastCheckedAt()).toBe(1234567890)
  })

  it('readLastStatusSnapshot returns undefined when absent or malformed', () => {
    expect(readLastStatusSnapshot()).toBeUndefined()
    localStorage.setItem('srn-update-check-last-status', '{invalid json')
    expect(readLastStatusSnapshot()).toBeUndefined()
    localStorage.setItem('srn-update-check-last-status', JSON.stringify({ checkedAt: 'nope' }))
    expect(readLastStatusSnapshot()).toBeUndefined()
  })

  it('readLastStatusSnapshot round-trips a stored snapshot', () => {
    const snapshot = {
      checkedAt: 42,
      status: { configured: true, currentVersion: '1.0.0', updateAvailable: false, latestVersion: '1.0.0' },
    }
    localStorage.setItem('srn-update-check-last-status', JSON.stringify(snapshot))
    expect(readLastStatusSnapshot()).toEqual(snapshot)
  })
})
