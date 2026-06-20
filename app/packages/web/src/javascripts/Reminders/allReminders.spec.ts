import { SNNote } from '@standardnotes/snjs'
import {
  buildCombinedReminderDocument,
  collectAllReminders,
  groupReminders,
} from './allReminders'
import { NoteRemindersKey, Reminder } from './reminders'

/**
 * Minimal SNNote stub: reminders live in appData, read via getAppDomainValue.
 */
const makeNote = (
  reminders: Reminder[],
  overrides: Partial<Pick<SNNote, 'uuid' | 'title' | 'trashed'>> = {},
): SNNote =>
  ({
    uuid: overrides.uuid ?? 'note-1',
    title: overrides.title ?? 'A note',
    trashed: overrides.trashed ?? false,
    getAppDomainValue: (key: string) => (key === (NoteRemindersKey as unknown as string) ? reminders : undefined),
  }) as unknown as SNNote

const NOW = Date.parse('2026-06-20T12:00:00.000Z')

const reminder = (id: string, dueAt: string, extra: Partial<Reminder> = {}): Reminder => ({
  id,
  dueAt,
  ...extra,
})

describe('collectAllReminders', () => {
  it('flattens reminders across notes and sorts ascending by due time', () => {
    const notes = [
      makeNote([reminder('r2', '2026-06-21T09:00:00.000Z')], { uuid: 'n1', title: 'Later' }),
      makeNote([reminder('r1', '2026-06-19T09:00:00.000Z')], { uuid: 'n2', title: 'Earlier' }),
    ]
    const result = collectAllReminders(notes)
    expect(result.map((r) => r.reminder.id)).toEqual(['r1', 'r2'])
    expect(result[0].note.uuid).toBe('n2')
  })

  it('skips trashed notes and unparseable due times', () => {
    const notes = [
      makeNote([reminder('good', '2026-06-21T09:00:00.000Z')], { uuid: 'n1' }),
      makeNote([reminder('bad', 'not-a-date')], { uuid: 'n2' }),
      makeNote([reminder('trashed', '2026-06-21T09:00:00.000Z')], { uuid: 'n3', trashed: true }),
    ]
    const result = collectAllReminders(notes)
    expect(result.map((r) => r.reminder.id)).toEqual(['good'])
  })

  it('attaches a recurrence summary when present', () => {
    const notes = [makeNote([reminder('r', '2026-06-21T09:00:00.000Z', { recurrence: { frequency: 'weekly' } })])]
    expect(collectAllReminders(notes)[0].recurrenceSummary).toBe('Repeats weekly')
  })
})

describe('groupReminders', () => {
  it('buckets into overdue / today / upcoming relative to now', () => {
    const reminders = collectAllReminders([
      makeNote([reminder('overdue', '2026-06-18T09:00:00.000Z')], { uuid: 'a' }),
      makeNote([reminder('today', '2026-06-20T15:00:00.000Z')], { uuid: 'b' }),
      makeNote([reminder('upcoming', '2026-06-25T09:00:00.000Z')], { uuid: 'c' }),
    ])
    const groups = groupReminders(reminders, NOW)
    expect(groups.map((g) => g.key)).toEqual(['overdue', 'today', 'upcoming'])
    expect(groups[0].reminders[0].reminder.id).toBe('overdue')
    expect(groups[1].reminders[0].reminder.id).toBe('today')
    expect(groups[2].reminders[0].reminder.id).toBe('upcoming')
  })

  it('omits empty buckets', () => {
    const reminders = collectAllReminders([makeNote([reminder('today', '2026-06-20T15:00:00.000Z')])])
    const groups = groupReminders(reminders, NOW)
    expect(groups.map((g) => g.key)).toEqual(['today'])
  })
})

describe('buildCombinedReminderDocument', () => {
  const fmt = (ms: number) => new Date(ms).toISOString()

  it('synthesizes a grouped readable page', () => {
    const reminders = collectAllReminders([
      makeNote([reminder('o', '2026-06-18T09:00:00.000Z', { message: 'Pay bill' })], {
        uuid: 'a',
        title: 'Bills',
      }),
    ])
    const doc = buildCombinedReminderDocument(reminders, NOW, fmt)
    expect(doc).toContain('All reminders')
    expect(doc).toContain('# Overdue (1)')
    expect(doc).toContain('Bills')
    expect(doc).toContain('Pay bill')
  })

  it('returns an empty-state string when there are no reminders', () => {
    expect(buildCombinedReminderDocument([], NOW, fmt)).toBe('No reminders yet.')
  })
})
