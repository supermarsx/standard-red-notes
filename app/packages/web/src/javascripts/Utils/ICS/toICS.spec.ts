import { escapeICSText, foldICSLine, ICSEvent, toICS, utf8OctetLength } from './toICS'

const FIXED_NOW = new Date('2026-06-20T12:30:45.000Z')

const lines = (ics: string): string[] => ics.split('\r\n')

describe('escapeICSText', () => {
  it('escapes backslash, comma, semicolon and newlines per RFC 5545', () => {
    expect(escapeICSText('a, b; c\\d')).toBe('a\\, b\\; c\\\\d')
    expect(escapeICSText('line1\nline2')).toBe('line1\\nline2')
    expect(escapeICSText('crlf\r\nhere')).toBe('crlf\\nhere')
  })
})

describe('foldICSLine', () => {
  it('leaves short lines untouched', () => {
    expect(foldICSLine('SUMMARY:short')).toBe('SUMMARY:short')
  })

  it('folds lines longer than 75 octets with CRLF + space', () => {
    const long = 'DESCRIPTION:' + 'x'.repeat(200)
    const folded = foldICSLine(long)
    expect(folded).toContain('\r\n ')
    // Every physical line must be <= 75 octets (continuation lines include the leading space).
    for (const physical of folded.split('\r\n')) {
      expect(utf8OctetLength(physical)).toBeLessThanOrEqual(75)
    }
    // Unfolding (remove CRLF + leading space) restores the original.
    expect(folded.replace(/\r\n /g, '')).toBe(long)
  })

  it('never splits a multi-byte character across a fold boundary', () => {
    const long = 'SUMMARY:' + 'é'.repeat(80) // each é is 2 octets in UTF-8
    const folded = foldICSLine(long)
    for (const physical of folded.split('\r\n')) {
      expect(utf8OctetLength(physical)).toBeLessThanOrEqual(75)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(long)
  })
})

describe('toICS', () => {
  it('produces a well-formed empty calendar for no events', () => {
    const ics = toICS([], FIXED_NOW)
    const l = lines(ics)
    expect(l[0]).toBe('BEGIN:VCALENDAR')
    expect(l).toContain('VERSION:2.0')
    expect(l.some((line) => line.startsWith('PRODID:'))).toBe(true)
    expect(l).toContain('END:VCALENDAR')
    expect(l).not.toContain('BEGIN:VEVENT')
    // Ends with a trailing CRLF.
    expect(ics.endsWith('\r\n')).toBe(true)
  })

  it('emits an all-day event with VALUE=DATE (no time, no Z)', () => {
    const event: ICSEvent = { uid: 'a1', title: 'Birthday', date: '2026-07-04' }
    const ics = toICS([event], FIXED_NOW)
    const l = lines(ics)
    expect(l).toContain('BEGIN:VEVENT')
    expect(l).toContain('UID:a1')
    expect(l).toContain('DTSTAMP:20260620T123045Z')
    expect(l).toContain('DTSTART;VALUE=DATE:20260704')
    expect(l).toContain('SUMMARY:Birthday')
    expect(l).toContain('END:VEVENT')
    expect(l.some((line) => line.includes('20260704') && line.includes('Z'))).toBe(false)
  })

  it('emits a timed event in UTC with a trailing Z and DTEND', () => {
    const event: ICSEvent = {
      uid: 'b2',
      title: 'Meeting',
      start: '2026-06-20T09:00:00.000Z',
      end: '2026-06-20T10:00:00.000Z',
    }
    const ics = toICS([event], FIXED_NOW)
    const l = lines(ics)
    expect(l).toContain('DTSTART:20260620T090000Z')
    expect(l).toContain('DTEND:20260620T100000Z')
  })

  it('escapes text in SUMMARY and DESCRIPTION', () => {
    const event: ICSEvent = {
      uid: 'c3',
      title: 'Lunch, with Bob; maybe',
      description: 'Line one\nLine two',
      date: '2026-06-21',
    }
    const ics = toICS([event], FIXED_NOW)
    expect(ics).toContain('SUMMARY:Lunch\\, with Bob\\; maybe')
    expect(ics).toContain('DESCRIPTION:Line one\\nLine two')
  })

  it('emits an RRULE for a recurring event with INTERVAL when > 1', () => {
    const weekly: ICSEvent = {
      uid: 'r1',
      title: 'Standup',
      start: '2026-06-20T09:00:00.000Z',
      recurrence: { frequency: 'weekly' },
    }
    const biweekly: ICSEvent = {
      uid: 'r2',
      title: 'Sprint',
      start: '2026-06-20T09:00:00.000Z',
      recurrence: { frequency: 'weekly', interval: 2 },
    }
    expect(toICS([weekly], FIXED_NOW)).toContain('RRULE:FREQ=WEEKLY')
    const biweeklyIcs = toICS([biweekly], FIXED_NOW)
    expect(biweeklyIcs).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2')
  })

  it('folds long content lines so no physical line exceeds 75 octets', () => {
    const event: ICSEvent = {
      uid: 'd4',
      title: 'T'.repeat(200),
      date: '2026-06-22',
    }
    const ics = toICS([event], FIXED_NOW)
    for (const physical of lines(ics)) {
      expect(utf8OctetLength(physical)).toBeLessThanOrEqual(75)
    }
  })

  it('skips events with no usable date/time', () => {
    const bad: ICSEvent = { uid: 'x', title: 'No date' }
    const ics = toICS([bad], FIXED_NOW)
    expect(ics).not.toContain('BEGIN:VEVENT')
  })

  it('uses CRLF line endings throughout', () => {
    const ics = toICS([{ uid: 'e5', title: 'X', date: '2026-06-23' }], FIXED_NOW)
    // No bare LF that isn't preceded by CR.
    expect(/[^\r]\n/.test(ics)).toBe(false)
  })
})
