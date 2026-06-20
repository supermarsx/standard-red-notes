import { SNNote } from '@standardnotes/snjs'
import { CalendarEditorIdentifier } from '../NoteView/CalendarEditor/CalendarEditor'
import { serializeCalendarDocument } from '../NoteView/CalendarEditor/CalendarDocument'
import {
  collectAllCalendarEvents,
  indexCalendarEventsByDate,
  isCalendarNote,
} from './allCalendarEvents'

const makeCalendarNote = (
  events: { id: string; date: string; title: string; color?: string }[],
  overrides: Partial<Pick<SNNote, 'uuid' | 'title' | 'trashed' | 'editorIdentifier'>> = {},
): SNNote =>
  ({
    uuid: overrides.uuid ?? 'cal-1',
    title: overrides.title ?? 'Calendar',
    trashed: overrides.trashed ?? false,
    editorIdentifier: overrides.editorIdentifier ?? CalendarEditorIdentifier,
    text: serializeCalendarDocument({ version: 1, events }),
  }) as unknown as SNNote

const makePlainNote = (): SNNote =>
  ({ uuid: 'plain', title: 'Plain', trashed: false, editorIdentifier: undefined, text: 'hello' }) as unknown as SNNote

describe('isCalendarNote', () => {
  it('detects the calendar editor identifier', () => {
    expect(isCalendarNote(makeCalendarNote([]))).toBe(true)
    expect(isCalendarNote(makePlainNote())).toBe(false)
  })
})

describe('collectAllCalendarEvents', () => {
  it('aggregates events from every calendar note with note back-references', () => {
    const notes = [
      makeCalendarNote([{ id: 'e1', date: '2026-06-20', title: 'Standup' }], { uuid: 'c1', title: 'Work' }),
      makeCalendarNote([{ id: 'e2', date: '2026-06-21', title: 'Gym' }], { uuid: 'c2', title: 'Personal' }),
      makePlainNote(),
    ]
    const result = collectAllCalendarEvents(notes)
    expect(result).toHaveLength(2)
    expect(result.find((r) => r.event.id === 'e1')?.note.uuid).toBe('c1')
    expect(result.find((r) => r.event.id === 'e2')?.note.title).toBe('Personal')
  })

  it('ignores trashed calendar notes and non-calendar notes', () => {
    const notes = [
      makeCalendarNote([{ id: 'e1', date: '2026-06-20', title: 'A' }], { uuid: 'c1', trashed: true }),
      makePlainNote(),
    ]
    expect(collectAllCalendarEvents(notes)).toHaveLength(0)
  })
})

describe('indexCalendarEventsByDate', () => {
  it('buckets events by ISO date', () => {
    const notes = [
      makeCalendarNote([
        { id: 'e1', date: '2026-06-20', title: 'A' },
        { id: 'e2', date: '2026-06-20', title: 'B' },
        { id: 'e3', date: '2026-06-21', title: 'C' },
      ]),
    ]
    const map = indexCalendarEventsByDate(collectAllCalendarEvents(notes))
    expect(map.get('2026-06-20')).toHaveLength(2)
    expect(map.get('2026-06-21')).toHaveLength(1)
  })
})
