import {
  alarmTriggerDuration,
  PublishedTodo,
  serializeEventCalendar,
  serializeProjectedEventCalendar,
  serializeVEvent,
  serializeVTodo,
} from './ICalendarSerializer'
import { CalendarProjectionSettings, DEFAULT_CALENDAR_PROJECTION, ProjectedEvent } from './CalendarProjection'

const CRLF = '\r\n'

describe('ICalendarSerializer (due-date events)', () => {
  describe('CATEGORIES', () => {
    const base: PublishedTodo = { uid: 'u', summary: 's', updatedAt: 1_000 }

    it('escapes each value individually so a comma inside one does not split the list', () => {
      expect(serializeVTodo({ ...base, categories: ['Work, urgent', 'Q1'] })).toContain('CATEGORIES:Work\\, urgent,Q1')
    })

    it('omits the property entirely for an empty or all-blank list', () => {
      expect(serializeVTodo({ ...base, categories: [] })).not.toContain('CATEGORIES')
      expect(serializeVTodo({ ...base, categories: ['  '] })).not.toContain('CATEGORIES')
    })
  })

  describe('alarmTriggerDuration', () => {
    it('is an UNSIGNED PT0S at the deadline, never a signed zero', () => {
      // Several clients read the sign before the magnitude and schedule `-PT0S`
      // a whole period out.
      expect(alarmTriggerDuration(0)).toBe('PT0S')
      expect(alarmTriggerDuration(-5)).toBe('PT0S')
      expect(alarmTriggerDuration(Number.NaN)).toBe('PT0S')
    })

    it('renders minutes, hours and days', () => {
      expect(alarmTriggerDuration(15)).toBe('-PT15M')
      expect(alarmTriggerDuration(90)).toBe('-PT1H30M')
      expect(alarmTriggerDuration(120)).toBe('-PT2H')
      expect(alarmTriggerDuration(1_440)).toBe('-P1D')
      expect(alarmTriggerDuration(1_500)).toBe('-P1DT1H')
    })
  })

  describe('serializeVEvent', () => {
    const event: ProjectedEvent = {
      uid: 'srn-due-t1',
      summary: 'File taxes',
      allDay: false,
      startAt: '2026-03-14T16:00:00.000Z',
      endAt: '2026-03-14T17:00:00.000Z',
      cancelled: false,
      updatedAt: 1_700_000_000_000,
    }

    it('emits a timed VEVENT with DTSTART and DTEND in UTC', () => {
      const lines = serializeVEvent(event).split(CRLF)
      expect(lines[0]).toBe('BEGIN:VEVENT')
      expect(lines).toContain('UID:srn-due-t1')
      expect(lines).toContain('SUMMARY:File taxes')
      expect(lines).toContain('DTSTART:20260314T160000Z')
      expect(lines).toContain('DTEND:20260314T170000Z')
      expect(lines).toContain('STATUS:CONFIRMED')
      expect(lines[lines.length - 1]).toBe('END:VEVENT')
    })

    it('emits an all-day VEVENT as DATE values only', () => {
      const lines = serializeVEvent({
        ...event,
        allDay: true,
        startAt: undefined,
        endAt: undefined,
        startDate: '2026-03-14',
        endDate: '2026-03-15',
      }).split(CRLF)
      expect(lines).toContain('DTSTART;VALUE=DATE:20260314')
      expect(lines).toContain('DTEND;VALUE=DATE:20260315')
      expect(lines.join(CRLF)).not.toContain('DTSTART:')
    })

    it('marks a cancelled event TRANSPARENT so a finished task cannot make the user look busy', () => {
      const lines = serializeVEvent({ ...event, cancelled: true }).split(CRLF)
      expect(lines).toContain('STATUS:CANCELLED')
      expect(lines).toContain('TRANSP:TRANSPARENT')
      expect(lines).not.toContain('STATUS:CONFIRMED')
    })

    it('emits RRULE and the diagnostic anchor zone', () => {
      const lines = serializeVEvent({
        ...event,
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        recurrenceTimeZone: 'Europe/Berlin',
      }).split(CRLF)
      expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
      expect(lines).toContain('X-SRN-TZID:Europe/Berlin')
    })

    it('hangs a VALARM off the END edge when the deadline is the end', () => {
      const lines = serializeVEvent({ ...event, alarmLeadMinutes: 30, alarmRelatedToEnd: true }).split(CRLF)
      expect(lines).toContain('BEGIN:VALARM')
      expect(lines).toContain('ACTION:DISPLAY')
      expect(lines).toContain('DESCRIPTION:File taxes')
      expect(lines).toContain('TRIGGER;RELATED=END:-PT30M')
      expect(lines).toContain('END:VALARM')
    })

    it('hangs it off the start otherwise', () => {
      expect(serializeVEvent({ ...event, alarmLeadMinutes: 30, alarmRelatedToEnd: false })).toContain(
        'TRIGGER;VALUE=DURATION:-PT30M',
      )
    })

    it('emits no VALARM when none was asked for', () => {
      expect(serializeVEvent(event)).not.toContain('VALARM')
    })

    it('emits PRIORITY clamped into 0..9', () => {
      expect(serializeVEvent({ ...event, priority: 1 })).toContain('PRIORITY:1')
      expect(serializeVEvent({ ...event, priority: 50 })).toContain('PRIORITY:9')
    })

    it('returns an empty component rather than a VEVENT with no start', () => {
      expect(serializeVEvent({ ...event, startAt: undefined })).toBe('')
      expect(serializeVEvent({ ...event, allDay: true, startDate: undefined, endDate: undefined })).toBe('')
    })
  })

  describe('serializeEventCalendar', () => {
    const event: ProjectedEvent = {
      uid: 'srn-due-b',
      summary: 'B',
      allDay: true,
      startDate: '2026-03-14',
      endDate: '2026-03-15',
      cancelled: false,
      updatedAt: 2_000,
    }

    it('wraps events in a VCALENDAR with its own PRODID and CRLF endings', () => {
      const ics = serializeEventCalendar([event])
      expect(ics.startsWith(`BEGIN:VCALENDAR${CRLF}`)).toBe(true)
      expect(ics).toContain('PRODID:-//Standard Red Notes//CalDAV Due Date Feed//EN')
      expect(ics.endsWith(`END:VCALENDAR${CRLF}`)).toBe(true)
    })

    it('produces a valid EMPTY calendar rather than nothing', () => {
      const ics = serializeEventCalendar([])
      expect(ics).toContain('BEGIN:VCALENDAR')
      expect(ics).not.toContain('BEGIN:VEVENT')
    })

    it('is stable and uid-ordered, so a strong ETag over it stays truthful', () => {
      const other: ProjectedEvent = { ...event, uid: 'srn-due-a', summary: 'A' }
      const first = serializeEventCalendar([event, other])
      expect(first).toBe(serializeEventCalendar([other, event]))
      expect(first.indexOf('UID:srn-due-a')).toBeLessThan(first.indexOf('UID:srn-due-b'))
    })

    it('skips an unserializable event instead of emitting a broken component', () => {
      const ics = serializeEventCalendar([event, { ...event, uid: 'srn-due-c', startDate: undefined }])
      expect(ics).toContain('UID:srn-due-b')
      expect(ics).not.toContain('UID:srn-due-c')
    })
  })

  describe('serializeProjectedEventCalendar', () => {
    const todos: PublishedTodo[] = [
      { uid: 't1', summary: 'Timed', due: '2026-03-14T17:00:00.000Z', updatedAt: 5_000 },
      { uid: 't2', summary: 'No deadline', updatedAt: 5_000 },
    ]
    const on = (overrides: Partial<CalendarProjectionSettings> = {}): CalendarProjectionSettings => ({
      ...DEFAULT_CALENDAR_PROJECTION,
      enabled: true,
      ...overrides,
    })

    it('emits nothing at all while the projection is off', () => {
      expect(serializeProjectedEventCalendar(todos, DEFAULT_CALENDAR_PROJECTION)).not.toContain('BEGIN:VEVENT')
    })

    it('emits only the dated task once on', () => {
      const ics = serializeProjectedEventCalendar(todos, on())
      expect(ics).toContain('UID:srn-due-t1')
      expect(ics).not.toContain('UID:srn-due-t2')
    })

    it('changes BYTE FOR BYTE when a shape axis changes, which is what moves the ETag', () => {
      const ends = serializeProjectedEventCalendar(todos, on())
      const starts = serializeProjectedEventCalendar(todos, on({ anchor: 'start' }))
      expect(starts).not.toBe(ends)
      expect(ends).toContain('DTEND:20260314T170000Z')
      expect(starts).toContain('DTSTART:20260314T170000Z')
    })
  })
})
