import {
  CHECKLIST_RECURRENCE_MAX_CACHED_FORMATTERS,
  CHECKLIST_RECURRENCE_MAX_FALLBACK_TIME_ZONES,
  advanceChecklistDueAt,
  checklistRecurrenceSummary,
  createChecklistRecurrence,
  normalizeChecklistRecurrence,
  normalizeChecklistRecurrenceTimeZone,
} from './checklistRecurrence'

describe('checklist recurrence', () => {
  it('normalizes supported presets/custom intervals and rejects malformed rules', () => {
    const daily = createChecklistRecurrence('daily', '2026-08-16T09:30:00.000Z', 'UTC')
    const custom = createChecklistRecurrence(
      { frequency: 'custom', interval: 3, unit: 'week' },
      '2026-08-16T09:30:00.000Z',
      'UTC',
    )

    expect(normalizeChecklistRecurrence(daily)).toEqual(daily)
    expect(daily?.version).toBe(1)
    expect(custom).toMatchObject({ frequency: 'custom', interval: 3, unit: 'week' })
    expect(checklistRecurrenceSummary(custom!)).toBe('Repeats every 3 weeks')
    expect(normalizeChecklistRecurrence({ frequency: 'daily' })).toBeUndefined()
    expect(normalizeChecklistRecurrence({ ...custom, interval: 0 })).toBeUndefined()
    expect(normalizeChecklistRecurrence({ ...custom, unit: 'hour' })).toBeUndefined()
    expect(normalizeChecklistRecurrence({ ...daily, version: 2 })).toBeUndefined()
    expect(createChecklistRecurrence('daily', 'not-a-date', 'UTC')).toBeUndefined()
    expect(createChecklistRecurrence('daily', '2026-08-16T09:30:00', 'UTC')).toBeUndefined()
    expect(createChecklistRecurrence('daily', '2026-08-16T09:30:00.000Z', 'Not/AZone')).toBeUndefined()
  })

  it('validates a supported persisted zone without constructing formatters and preserves its spelling', () => {
    const constructor = jest.spyOn(Intl, 'DateTimeFormat')
    const before = constructor.mock.calls.length
    try {
      expect(normalizeChecklistRecurrenceTimeZone('utc')).toBe('utc')
      expect(normalizeChecklistRecurrenceTimeZone('utc')).toBe('utc')
      expect(constructor.mock.calls.length - before).toBe(0)
    } finally {
      constructor.mockRestore()
    }
  })

  it('bounds formatter memory with least-recently-used eviction', () => {
    const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] })
      .supportedValuesOf
    expect(supportedValuesOf).toBeDefined()
    const timeZones = supportedValuesOf!.call(Intl, 'timeZone').slice(0, CHECKLIST_RECURRENCE_MAX_CACHED_FORMATTERS + 1)
    expect(timeZones).toHaveLength(CHECKLIST_RECURRENCE_MAX_CACHED_FORMATTERS + 1)

    const constructor = jest.spyOn(Intl, 'DateTimeFormat')
    try {
      for (const timeZone of timeZones) {
        expect(createChecklistRecurrence('daily', '2026-08-16T09:30:00.000Z', timeZone)).toBeDefined()
      }
      const afterFill = constructor.mock.calls.length
      expect(createChecklistRecurrence('daily', '2026-08-16T09:30:00.000Z', timeZones[0])).toBeDefined()
      expect(constructor.mock.calls.length - afterFill).toBe(1)
    } finally {
      constructor.mockRestore()
    }
  })

  it('preserves local wall time across daylight-saving changes using the persisted IANA zone', () => {
    const rule = createChecklistRecurrence('daily', '2026-03-28T09:00:00.000Z', 'Europe/London')
    expect(rule?.anchor).toMatchObject({ timeZone: 'Europe/London', hour: 9, minute: 0 })

    expect(advanceChecklistDueAt('2026-03-28T09:00:00.000Z', rule!, Date.parse('2026-03-28T10:00:00Z'))).toBe(
      '2026-03-29T08:00:00.000Z',
    )

    const newYorkGap = createChecklistRecurrence('daily', '2026-03-07T07:30:00.000Z', 'America/New_York')
    expect(advanceChecklistDueAt('2026-03-07T07:30:00.000Z', newYorkGap!, Date.parse('2026-03-07T08:00:00Z'))).toBe(
      '2026-03-08T07:30:00.000Z',
    )

    const londonFold = createChecklistRecurrence('daily', '2026-10-24T00:30:00.000Z', 'Europe/London')
    expect(advanceChecklistDueAt('2026-10-24T00:30:00.000Z', londonFold!, Date.parse('2026-10-24T02:00:00Z'))).toBe(
      '2026-10-25T00:30:00.000Z',
    )

    const lordHoweGap = createChecklistRecurrence('daily', '2026-10-02T15:45:00.000Z', 'Australia/Lord_Howe')
    expect(advanceChecklistDueAt('2026-10-02T15:45:00.000Z', lordHoweGap!, Date.parse('2026-10-02T16:00:00Z'))).toBe(
      '2026-10-03T15:45:00.000Z',
    )

    const lordHoweFold = createChecklistRecurrence('daily', '2026-04-03T14:45:00.000Z', 'Australia/Lord_Howe')
    expect(advanceChecklistDueAt('2026-04-03T14:45:00.000Z', lordHoweFold!, Date.parse('2026-04-03T16:00:00Z'))).toBe(
      '2026-04-04T14:45:00.000Z',
    )
  })

  it('retains month-end intent after February and leap-year clamps', () => {
    const monthly = createChecklistRecurrence('monthly', '2027-01-31T10:00:00.000Z', 'UTC')
    expect(monthly?.anchor.day).toBe(31)
    const february = advanceChecklistDueAt('2027-01-31T10:00:00.000Z', monthly!, Date.parse('2027-01-31T11:00Z'))
    expect(february).toBe('2027-02-28T10:00:00.000Z')
    expect(advanceChecklistDueAt(february!, monthly!, Date.parse('2027-02-28T11:00Z'))).toBe('2027-03-31T10:00:00.000Z')

    const aprilThirty = createChecklistRecurrence('monthly', '2027-04-30T10:00:00.000Z', 'UTC')
    expect(advanceChecklistDueAt('2027-04-30T10:00:00.000Z', aprilThirty!, Date.parse('2027-05-01T00:00Z'))).toBe(
      '2027-05-30T10:00:00.000Z',
    )

    const yearly = createChecklistRecurrence('yearly', '2024-02-29T08:00:00.000Z', 'UTC')
    expect(advanceChecklistDueAt('2024-02-29T08:00:00.000Z', yearly!, Date.parse('2024-03-01T00:00Z'))).toBe(
      '2025-02-28T08:00:00.000Z',
    )
    expect(advanceChecklistDueAt('2027-02-28T08:00:00.000Z', yearly!, Date.parse('2027-03-01T00:00Z'))).toBe(
      '2028-02-29T08:00:00.000Z',
    )

    const februaryTwentyEight = createChecklistRecurrence('yearly', '2025-02-28T08:00:00.000Z', 'UTC')
    expect(
      advanceChecklistDueAt('2027-02-28T08:00:00.000Z', februaryTwentyEight!, Date.parse('2027-03-01T00:00Z')),
    ).toBe('2028-02-28T08:00:00.000Z')
  })

  it('advances overdue schedules to the first occurrence strictly after completion', () => {
    const daily = createChecklistRecurrence('daily', '2026-08-01T09:00:00.000Z', 'UTC')
    expect(advanceChecklistDueAt('2026-08-01T09:00:00.000Z', daily!, Date.parse('2026-08-05T12:00Z'))).toBe(
      '2026-08-06T09:00:00.000Z',
    )

    const weekdays = createChecklistRecurrence('weekdays', '2026-08-14T16:00:00.000Z', 'UTC')
    expect(advanceChecklistDueAt('2026-08-14T16:00:00.000Z', weekdays!, Date.parse('2026-08-14T17:00Z'))).toBe(
      '2026-08-17T16:00:00.000Z',
    )
    const weekendWeekdays = createChecklistRecurrence('weekdays', '2026-08-16T16:00:00.000Z', 'UTC')
    expect(
      advanceChecklistDueAt('2026-08-16T16:00:00.000Z', weekendWeekdays!, Date.parse('2027-08-16T16:00:00Z')),
    ).toBe('2027-08-17T16:00:00.000Z')

    const custom = createChecklistRecurrence(
      { frequency: 'custom', interval: 3, unit: 'week' },
      '2026-08-16T10:00:00.000Z',
      'UTC',
    )
    expect(advanceChecklistDueAt('2026-08-16T10:00:00.000Z', custom!, Date.parse('2026-08-17T00:00Z'))).toBe(
      '2026-09-06T10:00:00.000Z',
    )
  })

  it('caps fallback validation and exception churn for crafted invalid time zones', () => {
    const constructor = jest.spyOn(Intl, 'DateTimeFormat')
    const invalidZones = Array.from(
      { length: CHECKLIST_RECURRENCE_MAX_FALLBACK_TIME_ZONES + 32 },
      (_, index) => `Invalid/Zone_${index}`,
    )
    try {
      const before = constructor.mock.calls.length
      for (const timeZone of invalidZones) {
        expect(normalizeChecklistRecurrenceTimeZone(timeZone)).toBeUndefined()
      }
      const attempts = constructor.mock.calls.length - before
      expect(attempts).toBeGreaterThan(0)
      expect(attempts).toBeLessThanOrEqual(CHECKLIST_RECURRENCE_MAX_FALLBACK_TIME_ZONES)

      const afterCap = constructor.mock.calls.length
      for (const timeZone of invalidZones) {
        expect(normalizeChecklistRecurrenceTimeZone(timeZone)).toBeUndefined()
      }
      expect(normalizeChecklistRecurrenceTimeZone('Still/InvalidAfterCap')).toBeUndefined()
      expect(constructor.mock.calls.length).toBe(afterCap)
    } finally {
      constructor.mockRestore()
    }
  })
})
