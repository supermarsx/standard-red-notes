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

// ---------------------------------------------------------------------------
// Edge-case coverage for uncommon inputs.
// ---------------------------------------------------------------------------

describe('escapeICSText edge cases', () => {
  it('escapes backslash BEFORE the other escapes so it is not double-counted', () => {
    // Order matters: a literal backslash followed by a comma must become \\ then \,
    expect(escapeICSText('a\\,b')).toBe('a\\\\\\,b')
    // A lone backslash at end of string.
    expect(escapeICSText('trailing\\')).toBe('trailing\\\\')
  })

  it('escapes multiple consecutive special characters', () => {
    expect(escapeICSText(',,;;')).toBe('\\,\\,\\;\\;')
    expect(escapeICSText('\\\\')).toBe('\\\\\\\\')
  })

  it('collapses CRLF, lone CR and lone LF each to a single literal \\n', () => {
    expect(escapeICSText('a\r\nb\rc\nd')).toBe('a\\nb\\nc\\nd')
  })

  it('leaves an empty string and plain text untouched', () => {
    expect(escapeICSText('')).toBe('')
    expect(escapeICSText('nothing special here')).toBe('nothing special here')
  })

  it('does NOT escape colon (RFC 5545 allows literal colon in TEXT values)', () => {
    expect(escapeICSText('a:b')).toBe('a:b')
  })

  it('passes unicode and emoji through unchanged', () => {
    expect(escapeICSText('café ☕ 🎉')).toBe('café ☕ 🎉')
  })
})

describe('utf8OctetLength', () => {
  it('counts ASCII as 1 octet each', () => {
    expect(utf8OctetLength('abc')).toBe(3)
    expect(utf8OctetLength('')).toBe(0)
  })

  it('counts a 2-octet code point (é)', () => {
    expect(utf8OctetLength('é')).toBe(2)
  })

  it('counts a 3-octet code point (☕ U+2615)', () => {
    expect(utf8OctetLength('☕')).toBe(3)
  })

  it('counts an astral / surrogate-pair code point (🎉 U+1F389) as 4 octets', () => {
    expect('🎉'.length).toBe(2) // two JS chars (surrogate pair)
    expect(utf8OctetLength('🎉')).toBe(4)
  })
})

describe('foldICSLine edge cases', () => {
  it('keeps a line at exactly the 75-octet boundary unfolded', () => {
    const line = 'x'.repeat(75)
    expect(utf8OctetLength(line)).toBe(75)
    expect(foldICSLine(line)).toBe(line)
  })

  it('folds a line at 76 octets (one over the limit)', () => {
    const line = 'x'.repeat(76)
    const folded = foldICSLine(line)
    expect(folded).toContain('\r\n ')
    for (const physical of folded.split('\r\n')) {
      expect(utf8OctetLength(physical)).toBeLessThanOrEqual(75)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })

  it('never splits an astral emoji across a fold boundary', () => {
    const long = 'SUMMARY:' + '🎉'.repeat(40) // each emoji is 4 octets / 2 JS chars
    const folded = foldICSLine(long)
    for (const physical of folded.split('\r\n')) {
      expect(utf8OctetLength(physical)).toBeLessThanOrEqual(75)
      // No physical line should contain a lone surrogate (a split emoji).
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(physical)).toBe(false)
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(physical)).toBe(false)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(long)
  })

  it('continuation lines carry a single leading space and respect the 74-octet budget', () => {
    const folded = foldICSLine('y'.repeat(300))
    const physical = folded.split('\r\n')
    expect(physical.length).toBeGreaterThan(1)
    for (let i = 1; i < physical.length; i++) {
      expect(physical[i].startsWith(' ')).toBe(true)
    }
  })
})

describe('toICS recurrence edge cases', () => {
  const timed = { uid: 'rec', start: '2026-06-20T09:00:00.000Z' }

  it('emits a bare FREQ (no INTERVAL) for each of DAILY/WEEKLY/MONTHLY/YEARLY', () => {
    expect(toICS([{ ...timed, recurrence: { frequency: 'daily' } }], FIXED_NOW)).toContain('RRULE:FREQ=DAILY')
    expect(toICS([{ ...timed, recurrence: { frequency: 'weekly' } }], FIXED_NOW)).toContain('RRULE:FREQ=WEEKLY')
    expect(toICS([{ ...timed, recurrence: { frequency: 'monthly' } }], FIXED_NOW)).toContain('RRULE:FREQ=MONTHLY')
    expect(toICS([{ ...timed, recurrence: { frequency: 'yearly' } }], FIXED_NOW)).toContain('RRULE:FREQ=YEARLY')
  })

  it('omits INTERVAL when it equals 1 (the default)', () => {
    const ics = toICS([{ ...timed, recurrence: { frequency: 'daily', interval: 1 } }], FIXED_NOW)
    expect(ics).toContain('RRULE:FREQ=DAILY')
    expect(ics).not.toContain('INTERVAL')
  })

  it('omits INTERVAL for interval <= 0 (treated as default)', () => {
    const ics = toICS([{ ...timed, recurrence: { frequency: 'daily', interval: 0 } }], FIXED_NOW)
    expect(ics).toContain('RRULE:FREQ=DAILY')
    expect(ics).not.toContain('INTERVAL')
  })

  it('floors a fractional interval to an integer', () => {
    const ics = toICS([{ ...timed, recurrence: { frequency: 'weekly', interval: 2.9 } }], FIXED_NOW)
    expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2')
  })

  it('emits an RRULE on an all-day recurring event too', () => {
    const ics = toICS([{ uid: 'ad', date: '2026-06-20', recurrence: { frequency: 'yearly' } }], FIXED_NOW)
    expect(ics).toContain('DTSTART;VALUE=DATE:20260620')
    expect(ics).toContain('RRULE:FREQ=YEARLY')
  })
})

describe('toICS date/time edge cases', () => {
  it('accepts a Date instance as start', () => {
    const ics = toICS([{ uid: 'dd', start: new Date('2026-06-20T09:00:00.000Z') }], FIXED_NOW)
    expect(lines(ics)).toContain('DTSTART:20260620T090000Z')
  })

  it('accepts an epoch-ms number as start', () => {
    const epoch = Date.UTC(2026, 5, 20, 9, 0, 0) // 2026-06-20T09:00:00Z
    const ics = toICS([{ uid: 'ee', start: epoch }], FIXED_NOW)
    expect(lines(ics)).toContain('DTSTART:20260620T090000Z')
  })

  it('converts a non-UTC ISO offset to UTC (trailing Z)', () => {
    // 2026-06-20T11:00:00+02:00 == 09:00:00Z
    const ics = toICS([{ uid: 'tz', start: '2026-06-20T11:00:00+02:00' }], FIXED_NOW)
    expect(lines(ics)).toContain('DTSTART:20260620T090000Z')
  })

  it('skips an event whose start is an unparseable string', () => {
    const ics = toICS([{ uid: 'bad', start: 'not-a-date' }], FIXED_NOW)
    expect(ics).not.toContain('BEGIN:VEVENT')
  })

  it('skips a start that is an invalid Date', () => {
    const ics = toICS([{ uid: 'bad2', start: new Date('nope') }], FIXED_NOW)
    expect(ics).not.toContain('BEGIN:VEVENT')
  })

  it('drops an unparseable DTEND but still emits the event with DTSTART', () => {
    const ics = toICS([{ uid: 'pe', start: '2026-06-20T09:00:00.000Z', end: 'garbage' }], FIXED_NOW)
    expect(lines(ics)).toContain('DTSTART:20260620T090000Z')
    expect(ics).not.toContain('DTEND')
    expect(ics).toContain('BEGIN:VEVENT')
  })

  it('prefers all-day date when both date and start are supplied', () => {
    const ics = toICS([{ uid: 'both', date: '2026-06-20', start: '2026-06-20T09:00:00.000Z' }], FIXED_NOW)
    expect(ics).toContain('DTSTART;VALUE=DATE:20260620')
    expect(ics).not.toContain('DTSTART:20260620T090000Z')
  })

  it('formats a year < 1000 with a zero-padded 4-digit DTSTART', () => {
    // setUTCFullYear avoids the JS Date.UTC two-digit-year (1900+) remapping.
    const d = new Date(Date.UTC(2000, 0, 2, 3, 4, 5))
    d.setUTCFullYear(85)
    const ics = toICS([{ uid: 'y', start: d }], FIXED_NOW)
    // Year 85 -> "0085".
    expect(lines(ics)).toContain('DTSTART:00850102T030405Z')
  })
})

describe('toICS field-handling edge cases', () => {
  it('omits SUMMARY for an empty-string title and DESCRIPTION for an empty-string description', () => {
    const ics = toICS([{ uid: 'no', title: '', description: '', date: '2026-06-20' }], FIXED_NOW)
    expect(ics).not.toContain('SUMMARY:')
    expect(ics).not.toContain('DESCRIPTION:')
  })

  it('escapes special characters inside the UID', () => {
    const ics = toICS([{ uid: 'a,b;c\\d', date: '2026-06-20' }], FIXED_NOW)
    expect(ics).toContain('UID:a\\,b\\;c\\\\d')
  })

  it('preserves unicode and emoji in SUMMARY and DESCRIPTION', () => {
    const ics = toICS(
      [{ uid: 'u', title: 'Café meeting ☕', description: 'Party 🎉 time', date: '2026-06-20' }],
      FIXED_NOW,
    )
    expect(ics).toContain('SUMMARY:Café meeting ☕')
    expect(ics).toContain('DESCRIPTION:Party 🎉 time')
  })

  it('escapes a literal newline in DESCRIPTION to \\n and keeps the property on one logical line', () => {
    const ics = toICS([{ uid: 'nl', description: 'a\nb\nc', date: '2026-06-20' }], FIXED_NOW)
    expect(ics).toContain('DESCRIPTION:a\\nb\\nc')
    // The escaped \n must NOT introduce a real CRLF break (other than folding).
    const descLine = lines(ics).find((l) => l.startsWith('DESCRIPTION:'))
    expect(descLine).toBe('DESCRIPTION:a\\nb\\nc')
  })

  it('serializes multiple events into separate VEVENT blocks, skipping invalid ones', () => {
    const ics = toICS(
      [
        { uid: '1', date: '2026-06-20', title: 'One' },
        { uid: '2', title: 'No date' }, // skipped
        { uid: '3', start: '2026-06-21T09:00:00.000Z', title: 'Three' },
      ],
      FIXED_NOW,
    )
    const beginCount = lines(ics).filter((l) => l === 'BEGIN:VEVENT').length
    const endCount = lines(ics).filter((l) => l === 'END:VEVENT').length
    expect(beginCount).toBe(2)
    expect(endCount).toBe(2)
    expect(ics).toContain('UID:1')
    expect(ics).not.toContain('UID:2')
    expect(ics).toContain('UID:3')
  })

  it('emits required calendar headers in order and a single trailing CRLF', () => {
    const ics = toICS([], FIXED_NOW)
    const l = lines(ics)
    expect(l.slice(0, 4)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Standard Red Notes//Calendar Export//EN', 'CALSCALE:GREGORIAN'])
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.endsWith('\r\n\r\n')).toBe(false)
  })

  // NOTE (possible RFC concern, NOT a bug in this generator): an all-day event
  // emits only DTSTART;VALUE=DATE with no DTEND. RFC 5545 §3.6.1 permits a lone
  // DTSTART (duration defaults to one day for DATE values), so this is valid; the
  // file header documents this as an intentional single-day choice. Asserting the
  // documented behavior rather than treating it as a defect.
  it('emits all-day events with no DTEND (documented single-day behavior)', () => {
    const ics = toICS([{ uid: 'ad', date: '2026-06-20' }], FIXED_NOW)
    expect(ics).toContain('DTSTART;VALUE=DATE:20260620')
    expect(ics).not.toContain('DTEND')
  })
})
