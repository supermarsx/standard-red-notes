import { SNNote } from '@standardnotes/snjs'
import {
  NoteRemindersKey,
  Reminder,
  clearReminderNotified,
  formatReminderRelative,
  getNoteReminders,
  isReminderDue,
  markReminderNotified,
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
