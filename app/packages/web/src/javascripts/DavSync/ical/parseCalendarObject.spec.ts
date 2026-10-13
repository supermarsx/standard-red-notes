/**
 * @jest-environment node
 */
import { CORPUS } from '../__fixtures__/corpus'
import { TEXT_LIMITS, fingerprintOfEvent } from '../model/eventModel'
import { corpusText, shortForm } from '../testing/corpusModel'
import { parseCalendarObject } from './parseCalendarObject'

const calendar = (...lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SRN//spec//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n')

const vevent = (...lines: string[]): string[] => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']

const parsed = (text: string) => {
  const result = parseCalendarObject(text)
  if (!result.ok) {
    throw new Error(`unreadable: ${result.reason}`)
  }
  return result
}

describe('the corpus', () => {
  it('is big enough, and covers every product it is meant to', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30)
    const dialects = new Set(CORPUS.map((entry) => entry.dialect.split(' (')[0]))
    for (const product of [
      'Nextcloud Calendar app',
      'Thunderbird',
      'Apple Calendar',
      'Google Calendar',
      'Microsoft Exchange',
      'Microsoft Outlook',
      'Fastmail',
      'DAVx5',
    ]) {
      expect(dialects).toContain(product)
    }
    expect(new Set(CORPUS.map((entry) => entry.name)).size).toBe(CORPUS.length)
    expect(new Set(CORPUS.map((entry) => entry.model.uid)).size).toBe(CORPUS.length)
  })

  it.each(CORPUS)('$name: contains what it is here to exercise', (entry) => {
    const text = corpusText(entry)
    expect(entry.contains.length).toBeGreaterThan(0)
    for (const fragment of entry.contains) {
      expect(text).toContain(fragment)
    }
  })

  it.each(CORPUS)('$name: is read as the model it should be', (entry) => {
    const result = parsed(corpusText(entry))
    expect(shortForm(result.model, result.zoneDefinitions)).toEqual(entry.model)
  })

  it.each(CORPUS)('$name: is read the same with bare line feeds', (entry) => {
    const crlf = parsed(corpusText(entry))
    const lf = parsed(corpusText(entry).replace(/\r\n/g, '\n'))
    expect(lf.model).toEqual(crlf.model)
    expect(fingerprintOfEvent(lf.model)).toBe(fingerprintOfEvent(crlf.model))
  })

  it('exercises, between its entries, every kind of time and every part of a series', () => {
    const models = CORPUS.map((entry) => parsed(corpusText(entry)).model)
    const kinds = new Set(models.flatMap((model) => [model.start.kind, model.end?.kind]))
    expect(kinds).toEqual(new Set(['date', 'floating', 'utc', 'zoned', undefined]))
    expect(models.filter((model) => model.rule !== '').length).toBeGreaterThanOrEqual(10)
    expect(models.filter((model) => model.exdates.length > 0).length).toBeGreaterThanOrEqual(3)
    expect(models.filter((model) => model.rdates.length > 0).length).toBeGreaterThanOrEqual(1)
    expect(models.filter((model) => model.overrides.length > 0).length).toBeGreaterThanOrEqual(3)
    expect(models.filter((model) => model.guests).length).toBeGreaterThanOrEqual(4)
    expect(models.filter((model) => model.alarm).length).toBeGreaterThanOrEqual(4)
    expect(
      models.filter(
        (model) =>
          model.end &&
          model.start.kind === 'zoned' &&
          model.end.kind === 'zoned' &&
          model.end.zone !== model.start.zone,
      ),
    ).toHaveLength(1)
  })
})

describe('what cannot be read is reported, not repaired', () => {
  it.each([
    ['text that is not calendar data', 'Hello, world', 'not-calendar-data'],
    ['nothing', '', 'not-calendar-data'],
    ['a calendar that does not end', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n', 'not-calendar-data'],
    ['an event outside any calendar', vevent('UID:x', 'DTSTART:20260101T000000Z').join('\r\n'), 'not-calendar-data'],
    ['a calendar with no event', calendar('BEGIN:VTODO', 'UID:t', 'END:VTODO'), 'no-event'],
    ['an event with no UID', calendar(...vevent('DTSTART:20260101T000000Z')), 'no-single-uid'],
    [
      'two events with different UIDs',
      calendar(...vevent('UID:x', 'DTSTART:20260101T000000Z'), ...vevent('UID:y', 'DTSTART:20260101T000000Z')),
      'no-single-uid',
    ],
    ['an event with no start', calendar(...vevent('UID:x', 'SUMMARY:When?')), 'no-usable-start'],
    ['a start that is not a time', calendar(...vevent('UID:x', 'DTSTART:notadate')), 'no-usable-start'],
    [
      'a start on a day that does not exist',
      calendar(...vevent('UID:x', 'DTSTART;VALUE=DATE:20260230')),
      'no-usable-start',
    ],
    [
      'a start at an hour that does not exist',
      calendar(...vevent('UID:x', 'DTSTART:20260101T250000Z')),
      'no-usable-start',
    ],
    [
      'a rule that removes occurrences',
      calendar(...vevent('UID:x', 'DTSTART:20260101T000000Z', 'RRULE:FREQ=DAILY', 'EXRULE:FREQ=WEEKLY;BYDAY=SA,SU')),
      'exclusion-rule',
    ],
    [
      'a change to "this and every later occurrence"',
      calendar(
        ...vevent('UID:x', 'DTSTART:20260101T000000Z', 'RRULE:FREQ=DAILY'),
        ...vevent('UID:x', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260105T000000Z', 'DTSTART:20260105T010000Z'),
      ),
      'this-and-future',
    ],
    [
      'a rule longer than a note keeps',
      calendar(
        ...vevent(
          'UID:x',
          'DTSTART:20260101T000000Z',
          `RRULE:FREQ=YEARLY;BYYEARDAY=${Array.from({ length: 366 }, (_unused, index) => index + 1).join(',')}`,
        ),
      ),
      'rule-too-long',
    ],
    [
      'a rule that goes by week number',
      calendar(...vevent('UID:x', 'DTSTART:19970512T090000Z', 'RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO')),
      'unsupported-rule',
    ],
  ])('%s', (_what, text, reason) => {
    expect(parseCalendarObject(text)).toEqual({ ok: false, reason })
  })

  it('keeps the rest of a series when one changed occurrence cannot be read', () => {
    const { model } = parsed(
      calendar(
        ...vevent('UID:x', 'DTSTART:20260105T100000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Series'),
        ...vevent('UID:x', 'RECURRENCE-ID:20260112T100000Z', 'DTSTART:garbage', 'SUMMARY:Broken'),
        ...vevent('UID:x', 'RECURRENCE-ID:20260119T100000Z', 'DTSTART:20260119T120000Z', 'SUMMARY:Moved'),
      ),
    )
    expect(model.overrides.map((override) => override.title)).toEqual(['Moved'])
  })
})

describe('times', () => {
  const start = (...lines: string[]) => parsed(calendar(...vevent('UID:x', ...lines))).model

  it.each([
    ['one week', 'P1W', 'utc 2026-03-30T09:00:00'],
    ['days and hours', 'P1DT2H30M', 'utc 2026-03-24T11:30:00'],
    ['seconds', 'PT90S', 'utc 2026-03-23T09:01:30'],
  ])('adds a duration of %s to the start', (_what, duration, end) => {
    const model = start('DTSTART:20260323T090000Z', `DURATION:${duration}`)
    expect(shortForm(model).end).toBe(end)
  })

  it.each(['PT0S', '-PT15M', 'P', 'soon'])('reads a duration of %j as no end', (duration) => {
    expect(start('DTSTART:20260323T090000Z', `DURATION:${duration}`).end).toBeUndefined()
  })

  it('counts the days of a duration on the wall clock and the rest in real time, across a clock change', () => {
    // Berlin goes forward on 29 March 2026. One day on from 09:00 on the 28th is 09:00 on the 29th,
    // though only 23 hours have passed; 24 hours on is 10:00.
    const nominal = start('DTSTART;TZID=Europe/Berlin:20260328T090000', 'DURATION:P1D')
    const exact = start('DTSTART;TZID=Europe/Berlin:20260328T090000', 'DURATION:PT24H')
    expect(shortForm(nominal).end).toBe('zoned 2026-03-29T09:00:00 Europe/Berlin')
    expect(shortForm(exact).end).toBe('zoned 2026-03-29T10:00:00 Europe/Berlin')
  })

  it('states an end in the terms of its start when the two were written in different ones', () => {
    const floatingStart = start('DTSTART:20260323T090000', 'DTEND;TZID=Europe/Berlin:20260323T100000')
    expect(shortForm(floatingStart)).toMatchObject({
      start: 'floating 2026-03-23T09:00:00',
      end: 'floating 2026-03-23T10:00:00',
    })
    const zonedStart = start('DTSTART;TZID=Europe/Berlin:20260323T090000', 'DTEND:20260323T100000')
    expect(shortForm(zonedStart).end).toBe('zoned 2026-03-23T10:00:00 Europe/Berlin')
    const utcStart = start('DTSTART:20260323T090000Z', 'DTEND:20260323T100000')
    expect(shortForm(utcStart).end).toBe('utc 2026-03-23T10:00:00')
  })

  it('drops an end that is a day when the start is a time, and the reverse', () => {
    expect(start('DTSTART:20260323T090000Z', 'DTEND;VALUE=DATE:20260324').end).toBeUndefined()
    expect(start('DTSTART;VALUE=DATE:20260323', 'DTEND:20260324T090000Z').end).toBeUndefined()
  })

  it('compares an end in another zone with its start as moments, not as clock readings', () => {
    // 10:30 in Lisbon is 11:30 in Berlin: after a start at 11:00 Berlin although "10:30" reads earlier.
    const after = start('DTSTART;TZID=Europe/Berlin:20260323T110000', 'DTEND;TZID=Europe/Lisbon:20260323T103000')
    expect(shortForm(after).end).toBe('zoned 2026-03-23T10:30:00 Europe/Lisbon')
    // 11:30 in Lisbon is 12:30 in Berlin; a start at 13:00 Berlin is after it, so that is no end.
    const before = start('DTSTART;TZID=Europe/Berlin:20260323T130000', 'DTEND;TZID=Europe/Lisbon:20260323T113000')
    expect(before.end).toBeUndefined()
  })

  it('keeps an all-day event to the longest a note holds', () => {
    const model = start('DTSTART;VALUE=DATE:20200101', 'DTEND;VALUE=DATE:20991231')
    expect(shortForm(model).end).toBe('date 2030-01-08')
  })

  it('reads a zone name that is too long to keep as no zone', () => {
    const tzid = `Zone/${'x'.repeat(200)}`
    const model = parsed(
      calendar(
        'BEGIN:VTIMEZONE',
        `TZID:${tzid}`,
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0100',
        'END:STANDARD',
        'END:VTIMEZONE',
        ...vevent('UID:x', `DTSTART;TZID=${tzid}:20260323T090000`),
      ),
    ).model
    expect(model.start).toEqual({ kind: 'floating', value: '2026-03-23T09:00:00' })
  })
})

describe('occurrences added to and removed from a series', () => {
  it('reads an added occurrence given as a period by where the period starts', () => {
    const { model } = parsed(
      calendar(
        ...vevent(
          'UID:x',
          'DTSTART:20260105T100000Z',
          'RRULE:FREQ=WEEKLY;COUNT=2',
          'RDATE;VALUE=PERIOD:20260107T140000Z/PT1H,20260109T150000Z/20260109T160000Z',
        ),
      ),
    )
    expect(model.rdates).toEqual(['2026-01-07T14:00:00', '2026-01-09T15:00:00'])
  })

  it('names each one once, in order, on the series’ own clock', () => {
    const { model } = parsed(
      calendar(
        ...vevent(
          'UID:x',
          'DTSTART;TZID=America/New_York:20260105T180000',
          'RRULE:FREQ=WEEKLY',
          // The same occurrence three ways: in the series' zone, in UTC, and in another zone.
          'EXDATE;TZID=America/New_York:20260119T180000',
          'EXDATE:20260119T230000Z',
          'EXDATE;TZID=Europe/Berlin:20260120T000000',
          'EXDATE;TZID=America/New_York:20260112T180000',
        ),
      ),
    )
    expect(model.exdates).toEqual(['2026-01-12T18:00:00', '2026-01-19T18:00:00'])
  })
})

describe('texts', () => {
  it('cuts a description longer than the note keeps, and remembers that it did', () => {
    const long = 'x'.repeat(TEXT_LIMITS.description + 500)
    const { model } = parsed(
      calendar(...vevent('UID:x', 'DTSTART:20260101T000000Z', `DESCRIPTION:${long}`, 'SUMMARY:Long')),
    )
    expect(model.description).toHaveLength(TEXT_LIMITS.description)
    expect(model.clipped).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(model.title).toBe('Long')
  })

  it('takes a summary, description and location that are not text as empty', () => {
    const { model } = parsed(calendar(...vevent('UID:x', 'DTSTART:20260101T000000Z')))
    expect([model.title, model.description, model.location, model.clipped, model.status]).toEqual(['', '', '', '', ''])
  })

  it('reads a status it does not know as none', () => {
    expect(parsed(calendar(...vevent('UID:x', 'DTSTART:20260101T000000Z', 'STATUS:POSTPONED'))).model.status).toBe('')
    expect(parsed(calendar(...vevent('UID:x', 'DTSTART:20260101T000000Z', 'STATUS:cancelled'))).model.status).toBe(
      'cancelled',
    )
  })
})
