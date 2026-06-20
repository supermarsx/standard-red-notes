import {
  DEFAULT_DIARY_SETTINGS,
  DiarySettings,
  dateKeyForDate,
  diaryTitleForDate,
  dueTimeForDay,
  formatPromptTime,
  isDiaryPromptDue,
  normalizeDiarySettings,
  parsePromptTime,
} from './diary'

const settings = (overrides: Partial<DiarySettings> = {}): DiarySettings => ({
  ...DEFAULT_DIARY_SETTINGS,
  enabled: true,
  hour: 20,
  minute: 0,
  ...overrides,
})

// A fixed local calendar day used across the due tests.
const dayKey = (d: Date) => dateKeyForDate(d)
const at = (h: number, m: number) => new Date(2026, 5, 20, h, m, 0, 0) // 2026-06-20 local

describe('normalizeDiarySettings', () => {
  it('falls back to defaults for missing/garbage input', () => {
    expect(normalizeDiarySettings(undefined)).toEqual(DEFAULT_DIARY_SETTINGS)
    expect(normalizeDiarySettings(null)).toEqual(DEFAULT_DIARY_SETTINGS)
    expect(normalizeDiarySettings({} as DiarySettings)).toEqual(DEFAULT_DIARY_SETTINGS)
  })

  it('coerces enabled and clamps time into range', () => {
    expect(normalizeDiarySettings({ enabled: true, hour: 30, minute: -5 })).toEqual({
      enabled: true,
      hour: 23,
      minute: 0,
    })
    expect(normalizeDiarySettings({ enabled: 'yes' as unknown as boolean, hour: 9, minute: 15 })).toEqual({
      enabled: false,
      hour: 9,
      minute: 15,
    })
  })
})

describe('dateKeyForDate / diaryTitleForDate', () => {
  it('produces a zero-padded YYYY-MM-DD local date key', () => {
    expect(dateKeyForDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(diaryTitleForDate(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31')
  })
})

describe('formatPromptTime / parsePromptTime', () => {
  it('round-trips a valid time', () => {
    expect(formatPromptTime(8, 5)).toBe('08:05')
    expect(parsePromptTime('08:05')).toEqual({ hour: 8, minute: 5 })
  })

  it('rejects malformed/out-of-range times', () => {
    expect(parsePromptTime('25:00')).toBeNull()
    expect(parsePromptTime('10:99')).toBeNull()
    expect(parsePromptTime('nonsense')).toBeNull()
  })
})

describe('dueTimeForDay', () => {
  it('is the configured local time on the same calendar day as now', () => {
    const now = at(21, 30)
    expect(dueTimeForDay(now, 20, 0)).toBe(at(20, 0).getTime())
  })
})

describe('isDiaryPromptDue', () => {
  const base = {
    settings: settings(),
    lastPromptedDateKey: null,
    entryExistsForToday: false,
  }

  it('is NOT due before the configured time', () => {
    const now = at(19, 59)
    expect(isDiaryPromptDue({ ...base, now })).toBe(false)
  })

  it('IS due at/after the configured time (enabled, not yet prompted, no entry)', () => {
    expect(isDiaryPromptDue({ ...base, now: at(20, 0) })).toBe(true)
    expect(isDiaryPromptDue({ ...base, now: at(22, 0) })).toBe(true)
  })

  it('is NOT due when Diary mode is disabled', () => {
    const now = at(21, 0)
    expect(isDiaryPromptDue({ ...base, settings: settings({ enabled: false }), now })).toBe(false)
  })

  it('is NOT due when already prompted today (dedupe)', () => {
    const now = at(21, 0)
    expect(isDiaryPromptDue({ ...base, now, lastPromptedDateKey: dayKey(now) })).toBe(false)
  })

  it('is NOT due when an entry already exists for today', () => {
    const now = at(21, 0)
    expect(isDiaryPromptDue({ ...base, now, entryExistsForToday: true })).toBe(false)
  })

  it('re-arms after date rollover (yesterday\'s prompt does not suppress today)', () => {
    const now = at(21, 0)
    const yesterday = dateKeyForDate(new Date(2026, 5, 19, 20, 0))
    expect(dayKey(now)).not.toBe(yesterday)
    expect(isDiaryPromptDue({ ...base, now, lastPromptedDateKey: yesterday })).toBe(true)
  })
})
