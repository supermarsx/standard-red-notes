import {
  escapeText,
  foldLine,
  PublishedTodo,
  serializeCalendar,
  serializeVTodo,
  toICalDateTimeUTC,
} from './ICalendarSerializer'

describe('ICalendarSerializer', () => {
  describe('escapeText', () => {
    it('escapes backslash, semicolon, comma and newlines per RFC 5545', () => {
      expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne')
    })

    it('collapses CRLF and CR to a literal \\n', () => {
      expect(escapeText('a\r\nb\rc')).toBe('a\\nb\\nc')
    })
  })

  describe('toICalDateTimeUTC', () => {
    it('formats an ISO string as a UTC iCalendar datetime', () => {
      expect(toICalDateTimeUTC('2026-06-25T09:05:07.000Z')).toBe('20260625T090507Z')
    })

    it('formats a ms-epoch number', () => {
      expect(toICalDateTimeUTC(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('20260102T030405Z')
    })

    it('returns null for empty / undefined / unparseable input', () => {
      expect(toICalDateTimeUTC(undefined)).toBeNull()
      expect(toICalDateTimeUTC('')).toBeNull()
      expect(toICalDateTimeUTC('not-a-date')).toBeNull()
    })
  })

  describe('foldLine', () => {
    it('leaves short lines untouched', () => {
      expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short')
    })

    it('folds long lines to <=75 octets with leading-space continuations', () => {
      const long = 'SUMMARY:' + 'x'.repeat(200)
      const folded = foldLine(long)
      const lines = folded.split('\r\n')
      expect(lines.length).toBeGreaterThan(1)
      // First line <=75 bytes; continuations start with a single space.
      expect(Buffer.byteLength(lines[0], 'utf8')).toBeLessThanOrEqual(75)
      for (const continuation of lines.slice(1)) {
        expect(continuation.startsWith(' ')).toBe(true)
        expect(Buffer.byteLength(continuation, 'utf8')).toBeLessThanOrEqual(75)
      }
      // Unfolding restores the original content.
      const unfolded = lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('')
      expect(unfolded).toBe(long)
    })

    it('does not split a multi-byte UTF-8 sequence', () => {
      // each é is 2 bytes in UTF-8
      const long = 'DESCRIPTION:' + 'é'.repeat(80)
      const folded = foldLine(long)
      // Re-joining must reproduce valid UTF-8 with the same code points.
      const unfolded = folded
        .split('\r\n')
        .map((l, i) => (i === 0 ? l : l.slice(1)))
        .join('')
      expect(unfolded).toBe(long)
    })
  })

  describe('serializeVTodo', () => {
    const base: PublishedTodo = {
      uid: 'todo-1',
      summary: 'Buy milk',
      updatedAt: Date.UTC(2026, 5, 25, 12, 0, 0),
    }

    it('emits a well-formed VTODO with required UID, DTSTAMP, SUMMARY, STATUS', () => {
      const out = serializeVTodo(base)
      expect(out).toContain('BEGIN:VTODO')
      expect(out).toContain('UID:todo-1')
      expect(out).toContain('DTSTAMP:20260625T120000Z')
      expect(out).toContain('SUMMARY:Buy milk')
      expect(out).toContain('STATUS:NEEDS-ACTION')
      expect(out).toContain('END:VTODO')
    })

    it('marks completed todos with STATUS, PERCENT-COMPLETE and COMPLETED', () => {
      const out = serializeVTodo({
        ...base,
        completed: true,
        completedAt: '2026-06-26T08:00:00Z',
      })
      expect(out).toContain('STATUS:COMPLETED')
      expect(out).toContain('PERCENT-COMPLETE:100')
      expect(out).toContain('COMPLETED:20260626T080000Z')
    })

    it('emits DTSTART, DUE, PRIORITY and DESCRIPTION when present', () => {
      const out = serializeVTodo({
        ...base,
        description: 'whole; milk',
        start: '2026-06-25T00:00:00Z',
        due: '2026-06-30T00:00:00Z',
        priority: 1,
      })
      expect(out).toContain('DTSTART:20260625T000000Z')
      expect(out).toContain('DUE:20260630T000000Z')
      expect(out).toContain('PRIORITY:1')
      expect(out).toContain('DESCRIPTION:whole\\; milk')
    })

    it('clamps an out-of-range priority into 0..9', () => {
      expect(serializeVTodo({ ...base, priority: 42 })).toContain('PRIORITY:9')
    })

    it('escapes special characters in the summary', () => {
      const out = serializeVTodo({ ...base, summary: 'a, b; c\\ d' })
      expect(out).toContain('SUMMARY:a\\, b\\; c\\\\ d')
    })
  })

  describe('serializeCalendar', () => {
    it('wraps todos in a VCALENDAR with VERSION, PRODID and CRLF endings', () => {
      const ics = serializeCalendar([
        { uid: 'a', summary: 'A', updatedAt: Date.UTC(2026, 0, 1) },
        { uid: 'b', summary: 'B', updatedAt: Date.UTC(2026, 0, 2) },
      ])
      expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
      expect(ics).toContain('VERSION:2.0')
      expect(ics).toContain('PRODID:-//Standard Red Notes//CalDAV Todo Feed//EN')
      expect(ics).toContain('UID:a')
      expect(ics).toContain('UID:b')
      expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
      // CRLF line endings throughout.
      expect(ics.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true)
    })

    it('produces a valid empty calendar when there are no todos', () => {
      const ics = serializeCalendar([])
      expect(ics).toContain('BEGIN:VCALENDAR')
      expect(ics).toContain('END:VCALENDAR')
      expect(ics).not.toContain('BEGIN:VTODO')
    })
  })
})
