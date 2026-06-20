import { SNNote } from '@standardnotes/snjs'
import {
  NoteRemindersKey,
  Reminder,
  advanceRecurringReminder,
  clearReminderNotified,
  computeNextOccurrence,
  describeRecurrence,
  formatReminderRelative,
  getNoteReminders,
  isRecurring,
  isReminderDue,
  markReminderNotified,
  normalizeRecurrence,
  noteHasPendingReminder,
  noteHasReminder,
  removeReminder,
  selectDueReminders,
  sortRemindersByDueAt,
  upsertReminder,
} from './reminders'

/**
 * Minimal SNNote stub exposing only `getAppDomainValue`, mirroring the
 * NoteAppearance spec approach. Backed by a plain record of app-domain values.
 */
const makeNote = (values: Record<string, unknown>): SNNote =>
  ({
    getAppDomainValue: (key: string) => values[key],
  }) as unknown as SNNote

const NOW = Date.parse('2026-06-20T12:00:00.000Z')
const reminder = (overrides: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  dueAt: '2026-06-20T13:00:00.000Z',
  ...overrides,
})

describe('reminders appData read', () => {
  it('returns an empty array when nothing is stored', () => {
    expect(getNoteReminders(makeNote({}))).toEqual([])
  })

  it('reads reminders from the note app-domain bag', () => {
    const stored = [reminder()]
    const note = makeNote({ [NoteRemindersKey as unknown as string]: stored })
    expect(getNoteReminders(note)).toEqual(stored)
  })

  it('returns copies, not the stored references', () => {
    const stored = [reminder()]
    const note = makeNote({ [NoteRemindersKey as unknown as string]: stored })
    const read = getNoteReminders(note)
    read[0].message = 'mutated'
    expect(stored[0].message).toBeUndefined()
  })

  it('filters out malformed entries (missing/invalid fields)', () => {
    const note = makeNote({
      [NoteRemindersKey as unknown as string]: [
        reminder(),
        { id: 'bad' }, // missing dueAt
        { id: 'bad2', dueAt: 'not-a-date' },
        null,
        'nope',
      ],
    })
    expect(getNoteReminders(note).map((r) => r.id)).toEqual(['r1'])
  })

  it('tolerates a non-array stored value', () => {
    const note = makeNote({ [NoteRemindersKey as unknown as string]: { not: 'an array' } })
    expect(getNoteReminders(note)).toEqual([])
  })

  it('noteHasReminder reflects presence', () => {
    expect(noteHasReminder(makeNote({}))).toBe(false)
    expect(noteHasReminder(makeNote({ [NoteRemindersKey as unknown as string]: [reminder()] }))).toBe(true)
  })

  it('noteHasPendingReminder is true only when a due, un-notified reminder exists', () => {
    const dueNote = makeNote({
      [NoteRemindersKey as unknown as string]: [reminder({ dueAt: '2026-06-20T11:00:00.000Z' })],
    })
    const futureNote = makeNote({
      [NoteRemindersKey as unknown as string]: [reminder({ dueAt: '2026-06-20T13:00:00.000Z' })],
    })
    expect(noteHasPendingReminder(dueNote, NOW)).toBe(true)
    expect(noteHasPendingReminder(futureNote, NOW)).toBe(false)
  })
})

describe('isReminderDue', () => {
  it('is true when dueAt is at or before now and not notified', () => {
    expect(isReminderDue(reminder({ dueAt: '2026-06-20T12:00:00.000Z' }), NOW)).toBe(true)
    expect(isReminderDue(reminder({ dueAt: '2026-06-20T11:59:59.000Z' }), NOW)).toBe(true)
  })

  it('is false when dueAt is in the future', () => {
    expect(isReminderDue(reminder({ dueAt: '2026-06-20T12:00:01.000Z' }), NOW)).toBe(false)
  })

  it('is false once notified (notify-once)', () => {
    expect(isReminderDue(reminder({ dueAt: '2026-06-20T11:00:00.000Z', notified: true }), NOW)).toBe(false)
  })

  it('is false for an unparseable dueAt', () => {
    expect(isReminderDue(reminder({ dueAt: 'garbage' }), NOW)).toBe(false)
  })
})

describe('upsert / remove / sort', () => {
  it('adds a new reminder', () => {
    const result = upsertReminder([], reminder())
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('r1')
  })

  it('replaces a reminder with a matching id (no duplicates)', () => {
    const initial = [reminder()]
    const result = upsertReminder(initial, reminder({ message: 'updated' }))
    expect(result).toHaveLength(1)
    expect(result[0].message).toBe('updated')
  })

  it('does not mutate the input array', () => {
    const initial = [reminder()]
    upsertReminder(initial, reminder({ id: 'r2', dueAt: '2026-06-20T14:00:00.000Z' }))
    expect(initial).toHaveLength(1)
  })

  it('keeps results sorted by dueAt ascending', () => {
    const a = reminder({ id: 'a', dueAt: '2026-06-20T15:00:00.000Z' })
    const b = reminder({ id: 'b', dueAt: '2026-06-20T13:00:00.000Z' })
    const result = upsertReminder([a], b)
    expect(result.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('removes a reminder by id', () => {
    const initial = [reminder({ id: 'a' }), reminder({ id: 'b' })]
    expect(removeReminder(initial, 'a').map((r) => r.id)).toEqual(['b'])
  })

  it('sortRemindersByDueAt does not mutate input', () => {
    const initial = [
      reminder({ id: 'a', dueAt: '2026-06-20T15:00:00.000Z' }),
      reminder({ id: 'b', dueAt: '2026-06-20T13:00:00.000Z' }),
    ]
    const sorted = sortRemindersByDueAt(initial)
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a'])
    expect(initial.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('notified flag (notify-once)', () => {
  it('marks the matching reminder notified, leaving others untouched', () => {
    const initial = [reminder({ id: 'a' }), reminder({ id: 'b' })]
    const result = markReminderNotified(initial, 'a')
    expect(result.find((r) => r.id === 'a')?.notified).toBe(true)
    expect(result.find((r) => r.id === 'b')?.notified).toBeUndefined()
  })

  it('does not mutate the input reminders', () => {
    const initial = [reminder({ id: 'a' })]
    markReminderNotified(initial, 'a')
    expect(initial[0].notified).toBeUndefined()
  })

  it('a notified reminder no longer counts as due', () => {
    const r = reminder({ dueAt: '2026-06-20T11:00:00.000Z' })
    expect(isReminderDue(r, NOW)).toBe(true)
    const [marked] = markReminderNotified([r], r.id)
    expect(isReminderDue(marked, NOW)).toBe(false)
  })

  it('clearReminderNotified resets the flag (e.g. on time edit)', () => {
    const r = reminder({ notified: true })
    expect(clearReminderNotified(r).notified).toBeUndefined()
  })
})

describe('selectDueReminders', () => {
  it('returns only due, un-notified pairs given now', () => {
    const note = makeNote({})
    const pairs = [
      { note, reminder: reminder({ id: 'due', dueAt: '2026-06-20T11:00:00.000Z' }) },
      { note, reminder: reminder({ id: 'future', dueAt: '2026-06-20T13:00:00.000Z' }) },
      { note, reminder: reminder({ id: 'notified', dueAt: '2026-06-20T11:00:00.000Z', notified: true }) },
    ]
    expect(selectDueReminders(pairs, NOW).map((p) => p.reminder.id)).toEqual(['due'])
  })
})

describe('normalizeRecurrence (backward-compat)', () => {
  it('treats missing recurrence as one-shot none', () => {
    expect(normalizeRecurrence(undefined)).toEqual({ frequency: 'none' })
  })

  it('a legacy reminder with no recurrence is not recurring', () => {
    expect(isRecurring(reminder())).toBe(false)
  })

  it('passes through fixed frequencies, dropping irrelevant interval/unit', () => {
    expect(normalizeRecurrence({ frequency: 'daily' })).toEqual({ frequency: 'daily' })
    expect(normalizeRecurrence({ frequency: 'monthly', interval: 5 } as never)).toEqual({
      frequency: 'monthly',
    })
  })

  it('normalizes custom interval/unit and defaults bad values', () => {
    expect(normalizeRecurrence({ frequency: 'custom', interval: 2, unit: 'week' })).toEqual({
      frequency: 'custom',
      interval: 2,
      unit: 'week',
    })
    expect(normalizeRecurrence({ frequency: 'custom', interval: 0, unit: 'week' })).toEqual({
      frequency: 'custom',
      interval: 1,
      unit: 'week',
    })
    expect(normalizeRecurrence({ frequency: 'custom' } as never)).toEqual({
      frequency: 'custom',
      interval: 1,
      unit: 'day',
    })
  })

  it('never throws on malformed data, falling back to none', () => {
    expect(normalizeRecurrence({ frequency: 'bogus' } as never)).toEqual({ frequency: 'none' })
    expect(normalizeRecurrence('nope' as never)).toEqual({ frequency: 'none' })
  })
})

describe('computeNextOccurrence', () => {
  const iso = (s: string) => Date.parse(s)

  it('returns undefined for one-shot / missing recurrence', () => {
    expect(computeNextOccurrence('2026-06-20T13:00:00.000Z', undefined)).toBeUndefined()
    expect(computeNextOccurrence('2026-06-20T13:00:00.000Z', { frequency: 'none' })).toBeUndefined()
  })

  it('advances daily by one day', () => {
    expect(computeNextOccurrence('2026-06-20T13:00:00.000Z', { frequency: 'daily' })).toBe(
      iso('2026-06-21T13:00:00.000Z'),
    )
  })

  it('advances weekly by seven days', () => {
    expect(computeNextOccurrence('2026-06-20T13:00:00.000Z', { frequency: 'weekly' })).toBe(
      iso('2026-06-27T13:00:00.000Z'),
    )
  })

  it('advances monthly by one calendar month', () => {
    expect(computeNextOccurrence('2026-06-20T13:00:00.000Z', { frequency: 'monthly' })).toBe(
      iso('2026-07-20T13:00:00.000Z'),
    )
  })

  it('advances yearly by one calendar year', () => {
    expect(computeNextOccurrence('2026-06-20T13:00:00.000Z', { frequency: 'yearly' })).toBe(
      iso('2027-06-20T13:00:00.000Z'),
    )
  })

  it('advances custom every-N-units', () => {
    expect(
      computeNextOccurrence('2026-06-20T13:00:00.000Z', {
        frequency: 'custom',
        interval: 2,
        unit: 'week',
      }),
    ).toBe(iso('2026-07-04T13:00:00.000Z'))
    expect(
      computeNextOccurrence('2026-06-20T13:00:00.000Z', {
        frequency: 'custom',
        interval: 3,
        unit: 'day',
      }),
    ).toBe(iso('2026-06-23T13:00:00.000Z'))
  })

  it('clamps Jan 31 + 1 month to the last day of February (non-leap)', () => {
    // 2027 is not a leap year -> Feb 28. Use noon UTC to avoid local TZ wrap.
    const next = computeNextOccurrence('2027-01-31T12:00:00.000Z', { frequency: 'monthly' })
    const d = new Date(next!)
    expect(d.getMonth()).toBe(1) // February
    expect(d.getDate()).toBe(28)
  })

  it('clamps Jan 31 + 1 month to Feb 29 in a leap year', () => {
    const next = computeNextOccurrence('2028-01-31T12:00:00.000Z', { frequency: 'monthly' })
    const d = new Date(next!)
    expect(d.getMonth()).toBe(1) // February
    expect(d.getDate()).toBe(29) // 2028 is a leap year
  })

  it('clamps Mar 31 + 1 month to Apr 30', () => {
    const next = computeNextOccurrence('2026-03-31T12:00:00.000Z', { frequency: 'monthly' })
    const d = new Date(next!)
    expect(d.getMonth()).toBe(3) // April
    expect(d.getDate()).toBe(30)
  })

  it('clamps Feb 29 + 1 year to Feb 28 in the following (non-leap) year', () => {
    const next = computeNextOccurrence('2028-02-29T12:00:00.000Z', { frequency: 'yearly' })
    const d = new Date(next!)
    expect(d.getFullYear()).toBe(2029)
    expect(d.getMonth()).toBe(1)
    expect(d.getDate()).toBe(28)
  })

  it('returns undefined for an unparseable dueAt', () => {
    expect(computeNextOccurrence('garbage', { frequency: 'daily' })).toBeUndefined()
  })

  it('accepts an epoch-ms number as the base', () => {
    const base = iso('2026-06-20T13:00:00.000Z')
    expect(computeNextOccurrence(base, { frequency: 'daily' })).toBe(iso('2026-06-21T13:00:00.000Z'))
  })
})

describe('advanceRecurringReminder', () => {
  it('leaves a one-shot reminder unchanged', () => {
    const r = reminder({ dueAt: '2026-06-20T11:00:00.000Z' })
    expect(advanceRecurringReminder(r, NOW)).toBe(r)
  })

  it('advances a daily reminder to the next future occurrence and clears notified', () => {
    const r = reminder({
      dueAt: '2026-06-20T11:00:00.000Z',
      notified: true,
      recurrence: { frequency: 'daily' },
    })
    const advanced = advanceRecurringReminder(r, NOW)
    expect(advanced.dueAt).toBe('2026-06-21T11:00:00.000Z')
    expect(advanced.notified).toBe(false)
  })

  it('catches up past multiple missed intervals in one pass', () => {
    // dueAt 5 days ago at 11:00, daily, now = 2026-06-20T12:00. The Jun 20 11:00
    // occurrence is still <= now (11:00 < 12:00), so the first FUTURE occurrence
    // is Jun 21 11:00 — proving the loop skips every missed interval at once.
    const r = reminder({
      dueAt: '2026-06-15T11:00:00.000Z',
      notified: true,
      recurrence: { frequency: 'daily' },
    })
    const advanced = advanceRecurringReminder(r, NOW)
    expect(advanced.dueAt).toBe('2026-06-21T11:00:00.000Z')
    expect(Date.parse(advanced.dueAt)).toBeGreaterThan(NOW)
    expect(Date.parse(advanced.dueAt)).toBeLessThanOrEqual(NOW + 24 * 3600 * 1000)
  })

  it('advances exactly one step when the single next occurrence is already future', () => {
    const r = reminder({
      dueAt: '2026-06-20T11:30:00.000Z',
      recurrence: { frequency: 'custom', interval: 2, unit: 'week' },
    })
    const advanced = advanceRecurringReminder(r, NOW)
    expect(advanced.dueAt).toBe('2026-07-04T11:30:00.000Z')
  })
})

describe('describeRecurrence', () => {
  it('summarizes fixed frequencies', () => {
    expect(describeRecurrence(undefined)).toBeUndefined()
    expect(describeRecurrence({ frequency: 'none' })).toBeUndefined()
    expect(describeRecurrence({ frequency: 'daily' })).toBe('Repeats daily')
    expect(describeRecurrence({ frequency: 'weekly' })).toBe('Repeats weekly')
    expect(describeRecurrence({ frequency: 'monthly' })).toBe('Repeats monthly')
    expect(describeRecurrence({ frequency: 'yearly' })).toBe('Repeats yearly')
  })

  it('summarizes custom intervals with pluralization', () => {
    expect(describeRecurrence({ frequency: 'custom', interval: 1, unit: 'week' })).toBe(
      'Repeats every week',
    )
    expect(describeRecurrence({ frequency: 'custom', interval: 2, unit: 'week' })).toBe(
      'Repeats every 2 weeks',
    )
    expect(describeRecurrence({ frequency: 'custom', interval: 3, unit: 'month' })).toBe(
      'Repeats every 3 months',
    )
  })
})

describe('formatReminderRelative', () => {
  it('formats future minutes/hours/days', () => {
    expect(formatReminderRelative(reminder({ dueAt: '2026-06-20T12:30:00.000Z' }), NOW)).toBe('in 30 minutes')
    expect(formatReminderRelative(reminder({ dueAt: '2026-06-20T14:00:00.000Z' }), NOW)).toBe('in 2 hours')
    expect(formatReminderRelative(reminder({ dueAt: '2026-06-22T12:00:00.000Z' }), NOW)).toBe('in 2 days')
  })

  it('formats overdue times', () => {
    expect(formatReminderRelative(reminder({ dueAt: '2026-06-20T11:30:00.000Z' }), NOW)).toBe('30 minutes overdue')
  })

  it('handles singular minute', () => {
    expect(formatReminderRelative(reminder({ dueAt: '2026-06-20T12:01:00.000Z' }), NOW)).toBe('in 1 minute')
  })

  it('reports invalid dates', () => {
    expect(formatReminderRelative(reminder({ dueAt: 'garbage' }), NOW)).toBe('Invalid date')
  })
})
