import {
  CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY,
  CHECKLIST_GENERATE_CAP_DEFAULT,
  CHECKLIST_GENERATE_CAP_MAX,
  CHECKLIST_GENERATE_CAP_MIN,
  CHECKLIST_GENERATE_CAP_PREF_KEY,
  checklistBackfillDecision,
  checklistOccurrenceSummaryText,
  normalizeChecklistAutoGenerateRecurrences,
  normalizeChecklistGenerateCap,
  resolveChecklistBackfillSettings,
} from './checklistBackfill'
import { createChecklistRecurrence } from './checklistRecurrence'

const monthly = createChecklistRecurrence('monthly', '2027-01-31T10:00:00.000Z', 'UTC')!
const daily = createChecklistRecurrence('daily', '2026-01-01T09:00:00.000Z', 'UTC')!

describe('checklist backfill preferences', () => {
  it('pins the two synced keys as the strings actually written to the account', () => {
    // The literal is the contract: web reads PrefKey's runtime value from the
    // generated snjs bundle, where a brand-new member is absent until that
    // artifact is rebuilt, and a key read as `undefined` is a preference that
    // silently never applies.
    expect(CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY).toBe('checklistAutoGenerateRecurrences')
    expect(CHECKLIST_GENERATE_CAP_PREF_KEY).toBe('checklistGenerateCap')
  })

  it('defaults generation on and turns it off only for an explicit false', () => {
    expect(normalizeChecklistAutoGenerateRecurrences(undefined)).toBe(true)
    expect(normalizeChecklistAutoGenerateRecurrences(null)).toBe(true)
    expect(normalizeChecklistAutoGenerateRecurrences('false')).toBe(true)
    expect(normalizeChecklistAutoGenerateRecurrences(0)).toBe(true)
    expect(normalizeChecklistAutoGenerateRecurrences(true)).toBe(true)
    expect(normalizeChecklistAutoGenerateRecurrences(false)).toBe(false)
  })

  it('clamps a synced cap into its bounds on read', () => {
    expect(CHECKLIST_GENERATE_CAP_DEFAULT).toBe(12)
    expect(CHECKLIST_GENERATE_CAP_MIN).toBe(1)
    expect(CHECKLIST_GENERATE_CAP_MAX).toBe(200)

    expect(normalizeChecklistGenerateCap(undefined)).toBe(12)
    expect(normalizeChecklistGenerateCap(30)).toBe(30)
    // Another client may have written any of these; none of them may reach the
    // enumerator, which refuses an out-of-range cap outright.
    expect(normalizeChecklistGenerateCap(0)).toBe(1)
    expect(normalizeChecklistGenerateCap(-5)).toBe(1)
    expect(normalizeChecklistGenerateCap(5000)).toBe(200)
    expect(normalizeChecklistGenerateCap(Number.MAX_SAFE_INTEGER)).toBe(200)
    // A bound is never raised by reading it.
    expect(normalizeChecklistGenerateCap(12.9)).toBe(12)
    expect(normalizeChecklistGenerateCap(Number.NaN)).toBe(12)
    expect(normalizeChecklistGenerateCap(Number.POSITIVE_INFINITY)).toBe(12)
    expect(normalizeChecklistGenerateCap('20')).toBe(12)
    expect(normalizeChecklistGenerateCap({ cap: 20 })).toBe(12)
  })

  it('resolves both preferences together', () => {
    expect(resolveChecklistBackfillSettings({})).toEqual({ autoGenerate: true, cap: 12 })
    expect(resolveChecklistBackfillSettings({ autoGenerate: false, cap: 999 })).toEqual({
      autoGenerate: false,
      cap: 200,
    })
  })
})

describe('checklistBackfillDecision', () => {
  const settings = { autoGenerate: true, cap: 12 }
  const now = Date.parse('2027-04-15T00:00Z')

  it('generates every occurrence owed, the stored deadline included', () => {
    const decision = checklistBackfillDecision(
      { dueAt: '2027-01-31T10:00:00.000Z', recurrence: monthly },
      settings,
      now,
    )
    expect(decision).toEqual({
      generate: true,
      occurrences: ['2027-01-31T10:00:00.000Z', '2027-02-28T10:00:00.000Z', '2027-03-31T10:00:00.000Z'],
      nextDueAt: '2027-04-30T10:00:00.000Z',
    })
  })

  it('reports nothing to do once the live row has been advanced', () => {
    const first = checklistBackfillDecision({ dueAt: '2027-01-31T10:00:00.000Z', recurrence: monthly }, settings, now)
    expect(first.generate).toBe(true)
    const advanced = first.generate ? first.nextDueAt : ''
    // The cap is a per-pass bound only because of this: the second pass stops at
    // 'not-due' before the occurrence grid is walked at all.
    expect(checklistBackfillDecision({ dueAt: advanced, recurrence: monthly }, settings, now)).toEqual({
      generate: false,
      reason: 'not-due',
    })
  })

  it('records the earlier remainder when the cap truncates', () => {
    const decision = checklistBackfillDecision(
      { dueAt: '2026-01-01T09:00:00.000Z', recurrence: daily },
      settings,
      Date.parse('2026-02-20T09:00:00.000Z'),
    )
    expect(decision.generate && decision.occurrences).toHaveLength(12)
    expect(decision.generate && decision.summary).toEqual({
      missedCount: 39,
      oldestMissedAt: '2026-01-01T09:00:00.000Z',
      newestMissedAt: '2026-02-08T09:00:00.000Z',
    })
  })

  it('names each reason it generates nothing', () => {
    const overdue = { dueAt: '2027-01-31T10:00:00.000Z', recurrence: monthly }
    expect(checklistBackfillDecision(overdue, { autoGenerate: false, cap: 12 }, now)).toEqual({
      generate: false,
      reason: 'disabled',
    })
    expect(checklistBackfillDecision({ ...overdue, checked: true }, settings, now)).toEqual({
      generate: false,
      reason: 'completed',
    })
    // The summary row itself: no deadline, no rule, so it can never be a source.
    expect(checklistBackfillDecision({}, settings, now)).toEqual({ generate: false, reason: 'no-schedule' })
    expect(checklistBackfillDecision({ dueAt: '2027-01-31T10:00:00.000Z' }, settings, now)).toEqual({
      generate: false,
      reason: 'no-schedule',
    })
    expect(checklistBackfillDecision({ recurrence: monthly }, settings, now)).toEqual({
      generate: false,
      reason: 'no-schedule',
    })
    expect(checklistBackfillDecision({ dueAt: 'not-a-date', recurrence: monthly }, settings, now)).toEqual({
      generate: false,
      reason: 'unresolvable',
    })
    expect(
      checklistBackfillDecision(
        {
          dueAt: '2027-01-31T10:00:00.000Z',
          recurrence: { ...monthly, anchor: { ...monthly.anchor, timeZone: 'Not/AZone' } },
        },
        settings,
        now,
      ),
    ).toEqual({ generate: false, reason: 'unresolvable' })
    expect(checklistBackfillDecision(overdue, settings, Number.NaN)).toEqual({
      generate: false,
      reason: 'unresolvable',
    })
  })

  it('corrects a stray cap on the way into the enumerator', () => {
    // An out-of-range cap reaches the enumerator corrected, not refused: the
    // decision is the layer that owns the preference read.
    const decision = checklistBackfillDecision(
      { dueAt: '2027-01-31T10:00:00.000Z', recurrence: monthly },
      { autoGenerate: true, cap: 0 },
      now,
    )
    expect(decision.generate && decision.occurrences).toEqual(['2027-03-31T10:00:00.000Z'])
    expect(decision.generate && decision.summary?.missedCount).toBe(2)
  })
})

describe('checklistOccurrenceSummaryText', () => {
  it('states only the two bounds it knows, and never a due date', () => {
    expect(
      checklistOccurrenceSummaryText(
        { missedCount: 34, oldestMissedAt: '2025-02-16T09:00:00.000Z', newestMissedAt: '2025-11-14T09:00:00.000Z' },
        'en-GB',
        'UTC',
      ),
    ).toBe('34 earlier occurrences were not generated — oldest 16 Feb 2025, newest 14 Nov 2025.')
  })

  it('reads naturally at one, where both bounds are the same occurrence', () => {
    expect(
      checklistOccurrenceSummaryText(
        { missedCount: 1, oldestMissedAt: '2025-02-16T09:00:00.000Z', newestMissedAt: '2025-02-16T09:00:00.000Z' },
        'en-GB',
        'UTC',
      ),
    ).toBe('1 earlier occurrence was not generated — 16 Feb 2025.')
  })

  it('declines to write half a sentence', () => {
    const valid = {
      missedCount: 2,
      oldestMissedAt: '2025-02-16T09:00:00.000Z',
      newestMissedAt: '2025-11-14T09:00:00.000Z',
    }
    expect(checklistOccurrenceSummaryText({ ...valid, missedCount: 0 })).toBeUndefined()
    expect(checklistOccurrenceSummaryText({ ...valid, missedCount: 1.5 })).toBeUndefined()
    expect(checklistOccurrenceSummaryText({ ...valid, oldestMissedAt: 'not-a-date' })).toBeUndefined()
    expect(checklistOccurrenceSummaryText({ ...valid, newestMissedAt: '' })).toBeUndefined()
    expect(checklistOccurrenceSummaryText(valid, 'not a locale!!')).toBeUndefined()
  })
})
