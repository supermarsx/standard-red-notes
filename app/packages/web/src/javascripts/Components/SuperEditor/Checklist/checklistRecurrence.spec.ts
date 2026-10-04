import { checklistDueAtToLocalInput, resolveChecklistDueAtLocalInput } from './checklistDueDate'
import {
  CHECKLIST_GENERATE_CAP_MAX,
  CHECKLIST_RECURRENCE_MAX_CACHED_FORMATTERS,
  CHECKLIST_RECURRENCE_MAX_FALLBACK_TIME_ZONES,
  advanceChecklistDueAt,
  checklistMissedOccurrencePlan,
  checklistMissedOccurrences,
  checklistRecurrenceChoicesEqual,
  checklistRecurrenceSummary,
  createChecklistRecurrence,
  normalizeChecklistRecurrence,
  normalizeChecklistRecurrenceTimeZone,
  resolveChecklistRecurrenceForSave,
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

    // Jan 30 is where the shipped rule and "last day of the month" intent
    // diverge: both clamp February to the 28th, but only an anchored day 30
    // returns to the 30th in March. March 31 here would mean the clamp had been
    // read as a month-end request.
    const januaryThirty = createChecklistRecurrence('monthly', '2027-01-30T10:00:00.000Z', 'UTC')
    expect(januaryThirty?.anchor.day).toBe(30)
    const februaryFromThirty = advanceChecklistDueAt(
      '2027-01-30T10:00:00.000Z',
      januaryThirty!,
      Date.parse('2027-01-30T11:00Z'),
    )
    expect(februaryFromThirty).toBe('2027-02-28T10:00:00.000Z')
    expect(advanceChecklistDueAt(februaryFromThirty!, januaryThirty!, Date.parse('2027-02-28T11:00Z'))).toBe(
      '2027-03-30T10:00:00.000Z',
    )

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

describe('resolveChecklistRecurrenceForSave', () => {
  const monthlyThirtyFirst = createChecklistRecurrence('monthly', '2027-01-31T10:00:00.000Z', 'UTC')!
  const clampedFebruary = advanceChecklistDueAt(
    '2027-01-31T10:00:00.000Z',
    monthlyThirtyFirst,
    Date.parse('2027-01-31T11:00Z'),
  )!

  it('keeps the persisted anchor when Save does not move the deadline', () => {
    expect(clampedFebruary).toBe('2027-02-28T10:00:00.000Z')

    // The seam, exactly as an editor reaches it: the schedule form shows the
    // clamped Feb 28, the user presses Save without touching it, and the draft
    // resolves back to the very same instant.
    const unchangedDraft = checklistDueAtToLocalInput(clampedFebruary)
    const resolvedDueAt = resolveChecklistDueAtLocalInput(unchangedDraft, clampedFebruary)
    expect(resolvedDueAt).toBe(clampedFebruary)

    const saved = resolveChecklistRecurrenceForSave('monthly', resolvedDueAt!, {
      dueAt: clampedFebruary,
      recurrence: monthlyThirtyFirst,
    })

    expect(saved?.anchor.day).toBe(31)
    expect(saved).toEqual(monthlyThirtyFirst)
    // The whole point: month-end intent still survives the NEXT roll.
    expect(advanceChecklistDueAt(clampedFebruary, saved!, Date.parse('2027-02-28T11:00Z'))).toBe(
      '2027-03-31T10:00:00.000Z',
    )

    // What an unguarded save seam does instead, for contrast: the anchor is
    // rebuilt from the clamped date and the day ratchets down permanently.
    expect(createChecklistRecurrence('monthly', clampedFebruary, 'UTC')?.anchor.day).toBe(28)
  })

  it('re-anchors when the deadline actually moves', () => {
    const moved = resolveChecklistRecurrenceForSave('monthly', '2027-02-20T10:00:00.000Z', {
      dueAt: clampedFebruary,
      recurrence: monthlyThirtyFirst,
    })
    expect(moved?.anchor.day).toBe(20)
    expect(advanceChecklistDueAt('2027-02-20T10:00:00.000Z', moved!, Date.parse('2027-02-20T11:00Z'))).toBe(
      '2027-03-20T10:00:00.000Z',
    )

    // Sub-minute precision counts as a move: the instant is the test, not the
    // minute-resolution wall time the form can show.
    const nudged = resolveChecklistRecurrenceForSave('monthly', '2027-02-28T10:00:30.000Z', {
      dueAt: clampedFebruary,
      recurrence: monthlyThirtyFirst,
    })
    expect(nudged?.anchor).toMatchObject({ day: 28, second: 30 })
  })

  it('re-anchors when the cadence changes, even on the same instant', () => {
    const changed = resolveChecklistRecurrenceForSave('yearly', clampedFebruary, {
      dueAt: clampedFebruary,
      recurrence: monthlyThirtyFirst,
    })
    expect(changed).toMatchObject({ frequency: 'yearly' })
    expect(changed?.anchor.day).toBe(28)

    const custom = createChecklistRecurrence(
      { frequency: 'custom', interval: 3, unit: 'week' },
      '2027-01-31T10:00:00.000Z',
      'UTC',
    )!
    expect(
      resolveChecklistRecurrenceForSave({ frequency: 'custom', interval: 3, unit: 'week' }, clampedFebruary, {
        dueAt: clampedFebruary,
        recurrence: custom,
      }),
    ).toEqual(custom)
    expect(
      resolveChecklistRecurrenceForSave({ frequency: 'custom', interval: 4, unit: 'week' }, clampedFebruary, {
        dueAt: clampedFebruary,
        recurrence: custom,
      })?.anchor.day,
    ).toBe(28)
  })

  it('builds a fresh rule when there is no anchor to preserve, keeping a persisted zone', () => {
    expect(
      resolveChecklistRecurrenceForSave(undefined, clampedFebruary, { recurrence: monthlyThirtyFirst }),
    ).toBeUndefined()

    const fresh = resolveChecklistRecurrenceForSave('monthly', '2027-02-28T10:00:00.000Z', {})
    expect(fresh).toMatchObject({ frequency: 'monthly' })

    const london = createChecklistRecurrence('monthly', '2027-01-31T10:00:00.000Z', 'Europe/London')!
    // A task whose recurrence had no deadline to compare against cannot claim
    // the save was unchanged, but the persisted zone is still the right one.
    expect(
      resolveChecklistRecurrenceForSave('monthly', '2027-02-28T10:00:00.000Z', { recurrence: london })?.anchor,
    ).toMatchObject({ timeZone: 'Europe/London', day: 28 })
    expect(
      resolveChecklistRecurrenceForSave('monthly', '2027-01-31T10:00:00.000Z', {
        dueAt: '2027-01-31T10:00:00.000Z',
        recurrence: london,
      }),
    ).toEqual(london)

    // A rule that no longer normalizes has no anchor worth preserving, and must
    // not take the save down with it.
    expect(
      resolveChecklistRecurrenceForSave('monthly', '2027-02-28T10:00:00.000Z', {
        dueAt: '2027-02-28T10:00:00.000Z',
        recurrence: { ...monthlyThirtyFirst, frequency: 'fortnightly' } as unknown as typeof monthlyThirtyFirst,
      })?.anchor.day,
    ).toBe(28)
    expect(resolveChecklistRecurrenceForSave('monthly', 'not-a-date', { dueAt: clampedFebruary })).toBeUndefined()
  })

  it('compares cadences structurally', () => {
    expect(checklistRecurrenceChoicesEqual('monthly', 'monthly')).toBe(true)
    expect(checklistRecurrenceChoicesEqual('monthly', 'yearly')).toBe(false)
    expect(checklistRecurrenceChoicesEqual('monthly', { frequency: 'custom', interval: 1, unit: 'month' })).toBe(false)
    expect(
      checklistRecurrenceChoicesEqual(
        { frequency: 'custom', interval: 2, unit: 'day' },
        { frequency: 'custom', interval: 2, unit: 'day' },
      ),
    ).toBe(true)
    expect(
      checklistRecurrenceChoicesEqual(
        { frequency: 'custom', interval: 2, unit: 'day' },
        { frequency: 'custom', interval: 2, unit: 'week' },
      ),
    ).toBe(false)
    expect(checklistRecurrenceChoicesEqual(undefined, undefined)).toBe(true)
    expect(checklistRecurrenceChoicesEqual(undefined, 'monthly')).toBe(false)
  })
})

describe('checklistMissedOccurrencePlan', () => {
  const monthly = createChecklistRecurrence('monthly', '2027-01-31T10:00:00.000Z', 'UTC')!

  it('counts the stored deadline as the first owed occurrence', () => {
    // Three months overdue means three owed occurrences, which is what a user
    // means by it. An exclusive window would answer two.
    const plan = checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, Date.parse('2027-04-15T00:00Z'), 12)
    expect(plan?.total).toBe(3)
    expect(plan?.generate).toEqual(['2027-01-31T10:00:00.000Z', '2027-02-28T10:00:00.000Z', '2027-03-31T10:00:00.000Z'])
    expect(plan?.truncated).toBe(0)
    expect(plan?.oldestTruncatedAt).toBeUndefined()
    expect(plan?.newestTruncatedAt).toBeUndefined()
    expect(plan?.nextDueAt).toBe('2027-04-30T10:00:00.000Z')
    expect(
      checklistMissedOccurrences('2027-01-31T10:00:00.000Z', monthly, Date.parse('2027-04-15T00:00Z'), 12),
    ).toEqual(plan?.generate)
  })

  it('owes an occurrence landing exactly on now, and not one a millisecond later', () => {
    expect(
      checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, Date.parse('2027-03-31T10:00:00.000Z'), 12)
        ?.generate,
    ).toEqual(['2027-01-31T10:00:00.000Z', '2027-02-28T10:00:00.000Z', '2027-03-31T10:00:00.000Z'])
    expect(
      checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, Date.parse('2027-03-31T09:59:59.999Z'), 12)
        ?.generate,
    ).toEqual(['2027-01-31T10:00:00.000Z', '2027-02-28T10:00:00.000Z'])

    // The stored deadline itself is owed the instant it arrives.
    const plan = checklistMissedOccurrencePlan(
      '2027-01-31T10:00:00.000Z',
      monthly,
      Date.parse('2027-01-31T10:00:00.000Z'),
      12,
    )
    expect(plan?.generate).toEqual(['2027-01-31T10:00:00.000Z'])
    expect(plan?.nextDueAt).toBe('2027-02-28T10:00:00.000Z')
  })

  it('enumerates nothing once the live row has been advanced', () => {
    const now = Date.parse('2027-04-15T00:00Z')
    const first = checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, now, 12)!
    // This is what makes the cap safe as a per-pass bound: a second pass against
    // the advanced row finds an empty window instead of the same backlog.
    expect(checklistMissedOccurrencePlan(first.nextDueAt, monthly, now, 12)).toBeUndefined()
    expect(checklistMissedOccurrences(first.nextDueAt, monthly, now, 12)).toEqual([])
  })

  it('keeps the most recent cap and records the earlier remainder', () => {
    const daily = createChecklistRecurrence('daily', '2026-01-01T09:00:00.000Z', 'UTC')!
    const plan = checklistMissedOccurrencePlan(
      '2026-01-01T09:00:00.000Z',
      daily,
      Date.parse('2026-02-20T09:00:00.000Z'),
      12,
    )
    expect(plan?.total).toBe(51)
    expect(plan?.generate).toHaveLength(12)
    expect(plan?.generate[0]).toBe('2026-02-09T09:00:00.000Z')
    expect(plan?.generate[11]).toBe('2026-02-20T09:00:00.000Z')
    expect(plan?.truncated).toBe(39)
    expect(plan?.oldestTruncatedAt).toBe('2026-01-01T09:00:00.000Z')
    expect(plan?.newestTruncatedAt).toBe('2026-02-08T09:00:00.000Z')
    expect(plan?.nextDueAt).toBe('2026-02-21T09:00:00.000Z')

    // A cap of 1 keeps only the most recent occurrence and records the other 50.
    const single = checklistMissedOccurrencePlan(
      '2026-01-01T09:00:00.000Z',
      daily,
      Date.parse('2026-02-20T09:00:00.000Z'),
      1,
    )
    expect(single?.generate).toEqual(['2026-02-20T09:00:00.000Z'])
    expect(single?.truncated).toBe(50)
  })

  it('never materializes more than the cap however stale the task is', () => {
    const daily = createChecklistRecurrence('daily', '1990-01-01T09:00:00.000Z', 'UTC')!
    const plan = checklistMissedOccurrencePlan(
      '1990-01-01T09:00:00.000Z',
      daily,
      Date.parse('2026-01-01T09:00:00.000Z'),
      CHECKLIST_GENERATE_CAP_MAX,
    )
    expect(plan?.total).toBe(13150)
    expect(plan?.generate).toHaveLength(CHECKLIST_GENERATE_CAP_MAX)
    expect(plan?.generate[CHECKLIST_GENERATE_CAP_MAX - 1]).toBe('2026-01-01T09:00:00.000Z')
    expect(plan?.truncated).toBe(13150 - CHECKLIST_GENERATE_CAP_MAX)
    expect(plan?.oldestTruncatedAt).toBe('1990-01-01T09:00:00.000Z')
  })

  it('refuses a cap outside its bounds and anything it cannot resolve', () => {
    const now = Date.parse('2027-04-15T00:00Z')
    expect(checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, now, 0)).toBeUndefined()
    expect(checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, now, -1)).toBeUndefined()
    expect(
      checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, now, CHECKLIST_GENERATE_CAP_MAX + 1),
    ).toBeUndefined()
    expect(checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, now, 2.5)).toBeUndefined()
    expect(checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, now, Number.NaN)).toBeUndefined()
    expect(checklistMissedOccurrencePlan('not-a-date', monthly, now, 12)).toBeUndefined()
    expect(checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', monthly, Number.NaN, 12)).toBeUndefined()
    expect(
      checklistMissedOccurrencePlan(
        '2027-01-31T10:00:00.000Z',
        { ...monthly, anchor: { ...monthly.anchor, timeZone: 'Not/AZone' } },
        now,
        12,
      ),
    ).toBeUndefined()
    expect(checklistMissedOccurrences('not-a-date', monthly, now, 12)).toEqual([])
  })

  it('answers "generate nothing" rather than throwing when Intl fails during the walk', () => {
    // A supported zone normalizes without constructing a formatter, so the rule
    // below is built while Intl still works and the throw lands inside the grid
    // walk — the one place a partial Intl implementation can surface.
    const rule = normalizeChecklistRecurrence({
      version: 1,
      frequency: 'monthly',
      anchor: {
        timeZone: 'Pacific/Chatham',
        year: 2027,
        month: 1,
        day: 31,
        hour: 10,
        minute: 0,
        second: 0,
        millisecond: 0,
      },
    })
    expect(rule).toBeDefined()

    const constructor = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
      throw new RangeError('Intl unavailable')
    }) as unknown as typeof Intl.DateTimeFormat)
    try {
      const before = constructor.mock.calls.length
      expect(
        checklistMissedOccurrencePlan('2027-01-31T10:00:00.000Z', rule!, Date.parse('2027-04-15T00:00Z'), 12),
      ).toBeUndefined()
      expect(constructor.mock.calls.length).toBeGreaterThan(before)
    } finally {
      constructor.mockRestore()
    }
  })
})
