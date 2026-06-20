import { Reminder } from '@/Reminders/reminders'
import { CalendarEvent } from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { calendarEventToICS, reminderRecurrenceToICS, reminderToICS } from './icsAdapters'

describe('calendarEventToICS', () => {
  it('maps a calendar event to an all-day ICS event with a namespaced UID', () => {
    const event: CalendarEvent = { id: 'evt1', date: '2026-07-04', title: 'Party' }
    const ics = calendarEventToICS(event, 'note-uuid', 'My Calendar')
    expect(ics.date).toBe('2026-07-04')
    expect(ics.title).toBe('Party')
    expect(ics.uid).toBe('note-uuid-evt1@standard-red-notes')
    expect(ics.description).toBe('From: My Calendar')
    expect(ics.start).toBeUndefined()
  })

  it('falls back to Untitled for an empty title', () => {
    const event: CalendarEvent = { id: 'evt2', date: '2026-07-04', title: '' }
    expect(calendarEventToICS(event, 'n', undefined).title).toBe('Untitled')
  })
})

describe('reminderRecurrenceToICS', () => {
  const make = (recurrence: Reminder['recurrence']): Reminder => ({
    id: 'r',
    dueAt: '2026-06-20T09:00:00.000Z',
    recurrence,
  })

  it('returns undefined for one-shot reminders', () => {
    expect(reminderRecurrenceToICS(make(undefined))).toBeUndefined()
    expect(reminderRecurrenceToICS(make({ frequency: 'none' }))).toBeUndefined()
  })

  it('maps fixed frequencies', () => {
    expect(reminderRecurrenceToICS(make({ frequency: 'daily' }))).toEqual({ frequency: 'daily' })
    expect(reminderRecurrenceToICS(make({ frequency: 'weekly' }))).toEqual({ frequency: 'weekly' })
    expect(reminderRecurrenceToICS(make({ frequency: 'monthly' }))).toEqual({ frequency: 'monthly' })
    expect(reminderRecurrenceToICS(make({ frequency: 'yearly' }))).toEqual({ frequency: 'yearly' })
  })

  it('maps custom interval/unit onto FREQ + INTERVAL', () => {
    expect(reminderRecurrenceToICS(make({ frequency: 'custom', interval: 2, unit: 'week' }))).toEqual({
      frequency: 'weekly',
      interval: 2,
    })
  })
})

describe('reminderToICS', () => {
  it('maps a timed reminder with message and recurrence', () => {
    const reminder: Reminder = {
      id: 'rem1',
      dueAt: '2026-06-20T09:00:00.000Z',
      message: 'Call the dentist',
      recurrence: { frequency: 'monthly' },
    }
    const ics = reminderToICS(reminder, 'note-2', 'Health')
    expect(ics.uid).toBe('note-2-rem1@standard-red-notes')
    expect(ics.title).toBe('Health')
    expect(ics.description).toBe('Call the dentist')
    expect(ics.start).toBe('2026-06-20T09:00:00.000Z')
    expect(ics.recurrence).toEqual({ frequency: 'monthly' })
  })
})
