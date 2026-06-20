import { SNNote } from '@standardnotes/snjs'
import { NoteRemindersKey, Reminder } from './reminders'
import { collectDueReminders } from './useReminderChecker'

/**
 * Standard Red Notes: tests for the pure due-reminder scan used by the checker
 * hook. Covers the trashed/archived skip, due-vs-future filtering, and the
 * notify-once exclusion (already-notified reminders are not collected).
 */

const NOW = Date.parse('2026-06-20T12:00:00.000Z')

const makeNote = (reminders: Reminder[], flags: { trashed?: boolean; archived?: boolean } = {}): SNNote =>
  ({
    uuid: 'n',
    title: 'Note',
    trashed: flags.trashed ?? false,
    archived: flags.archived ?? false,
    getAppDomainValue: (key: string) => (key === (NoteRemindersKey as unknown as string) ? reminders : undefined),
  }) as unknown as SNNote

const reminder = (overrides: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  dueAt: '2026-06-20T11:00:00.000Z', // past -> due
  ...overrides,
})

describe('collectDueReminders', () => {
  it('collects a due, un-notified reminder', () => {
    const note = makeNote([reminder()])
    const result = collectDueReminders([note], NOW)
    expect(result).toHaveLength(1)
    expect(result[0].note).toBe(note)
    expect(result[0].reminder.id).toBe('r1')
  })

  it('skips reminders whose dueAt is in the future', () => {
    const note = makeNote([reminder({ dueAt: '2026-06-20T13:00:00.000Z' })])
    expect(collectDueReminders([note], NOW)).toHaveLength(0)
  })

  it('skips already-notified reminders (notify-once)', () => {
    const note = makeNote([reminder({ notified: true })])
    expect(collectDueReminders([note], NOW)).toHaveLength(0)
  })

  it('skips notes that are trashed or archived', () => {
    const trashed = makeNote([reminder()], { trashed: true })
    const archived = makeNote([reminder()], { archived: true })
    expect(collectDueReminders([trashed, archived], NOW)).toHaveLength(0)
  })

  it('collects multiple due reminders across notes, ignoring future ones', () => {
    const noteA = makeNote([reminder({ id: 'a' }), reminder({ id: 'b', dueAt: '2026-06-20T13:00:00.000Z' })])
    const noteB = makeNote([reminder({ id: 'c' })])
    const result = collectDueReminders([noteA, noteB], NOW)
    expect(result.map((d) => d.reminder.id).sort()).toEqual(['a', 'c'])
  })

  it('returns an empty array for notes with no reminders', () => {
    expect(collectDueReminders([makeNote([])], NOW)).toEqual([])
  })
})
