/**
 * @jest-environment node
 */
import { CalendarEvent, expandEventsForWindow } from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { daysInRange } from '@/Timezone/wallClock'
import { MAX_SERIES_OCCURRENCES, createSeriesTools } from './seriesTools'

const occurrences = (rule: string, start: string, from: string, to: string, zone?: string): string[] =>
  createSeriesTools().occurrencesOfRule({ rule, start, zone, from, to })

/**
 * The examples of RFC 5545 section 3.8.5.3, with the answers the RFC itself
 * lists. Each starts at 09:00; the dates are the RFC's.
 */
const RFC_EXAMPLES: [what: string, rule: string, start: string, to: string, days: string[]][] = [
  [
    'every other week on Tuesday and Sunday, weeks starting on Monday',
    'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO',
    '1997-08-05',
    '1998-01-01',
    ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24'],
  ],
  [
    'the same with weeks starting on Sunday, which changes the answer',
    'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU',
    '1997-08-05',
    '1998-01-01',
    ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31'],
  ],
  [
    'every other month on the first and last Sunday, ten times',
    'FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU',
    '1997-09-07',
    '1999-01-01',
    [
      '1997-09-07',
      '1997-09-28',
      '1997-11-02',
      '1997-11-30',
      '1998-01-04',
      '1998-01-25',
      '1998-03-01',
      '1998-03-29',
      '1998-05-03',
      '1998-05-31',
    ],
  ],
  [
    'the third Tuesday, Wednesday or Thursday of the month, three times',
    'FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3',
    '1997-09-04',
    '1998-01-01',
    ['1997-09-04', '1997-10-07', '1997-11-06'],
  ],
  [
    'the second-to-last weekday of the month',
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2',
    '1997-09-29',
    '1998-03-31',
    ['1997-09-29', '1997-10-30', '1997-11-27', '1997-12-30', '1998-01-29', '1998-02-26', '1998-03-30'],
  ],
  [
    'every third year on the 1st, 100th and 200th day, ten times',
    'FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200',
    '1997-01-01',
    '2007-01-01',
    [
      '1997-01-01',
      '1997-04-10',
      '1997-07-19',
      '2000-01-01',
      '2000-04-09',
      '2000-07-18',
      '2003-01-01',
      '2003-04-10',
      '2003-07-19',
      '2006-01-01',
    ],
  ],
  [
    'the first Saturday that follows the first Sunday of the month',
    'FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13',
    '1997-09-13',
    '1998-06-30',
    [
      '1997-09-13',
      '1997-10-11',
      '1997-11-08',
      '1997-12-13',
      '1998-01-10',
      '1998-02-07',
      '1998-03-07',
      '1998-04-11',
      '1998-05-09',
      '1998-06-13',
    ],
  ],
  [
    'US presidential election day: every four years, the Tuesday after the first Monday of November',
    'FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8',
    '1996-11-05',
    '2004-12-31',
    ['1996-11-05', '2000-11-07', '2004-11-02'],
  ],
]

describe('occurrencesOfRule', () => {
  it.each(RFC_EXAMPLES)('RFC 5545: %s', (_what, rule, start, to, days) => {
    const timed = occurrences(rule, `${start}T09:00:00`, `${start}T00:00:00`, `${to}T23:59:59`)
    expect(timed).toEqual(days.map((day) => `${day}T09:00:00`))
    // The same rule for an all-day series gives the same days.
    expect(occurrences(rule, start, start, to)).toEqual(days)
  })

  it('finds Friday the 13th, which the start itself is not', () => {
    // RFC 5545: "Every Friday the 13th, forever", starting Tuesday 2 September 1997.
    const fridays = occurrences(
      'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13',
      '1997-09-02T09:00:00',
      '1997-09-03T00:00:00',
      '2000-12-31T23:59:59',
    )
    expect(fridays).toEqual([
      '1998-02-13T09:00:00',
      '1998-03-13T09:00:00',
      '1998-11-13T09:00:00',
      '1999-08-13T09:00:00',
      '2000-10-13T09:00:00',
    ])
  })

  it('skips the months and years a day does not exist in', () => {
    expect(occurrences('FREQ=MONTHLY', '2026-01-31', '2026-01-01', '2026-12-31')).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
      '2026-10-31',
      '2026-12-31',
    ])
    // Left to itself the library answers 1 March in the years that have no 29 February.
    expect(occurrences('FREQ=YEARLY', '2024-02-29', '2024-01-01', '2033-12-31')).toEqual([
      '2024-02-29',
      '2028-02-29',
      '2032-02-29',
    ])
    expect(occurrences('FREQ=YEARLY;BYMONTH=3,6', '2026-01-31', '2026-01-01', '2027-12-31')).toEqual([
      '2026-03-31',
      '2027-03-31',
    ])
  })

  it('produces nothing for a rule that goes by week number, rather than the wrong answer the library gives', () => {
    // RFC 5545: "Monday of week number 20" is 12 May 1997, 11 May 1998, 17 May 1999. The library does
    // not implement BYWEEKNO and answers every Monday. An entry with such a rule is reported as one
    // that cannot be read; this is the same refusal one layer down.
    expect(
      occurrences(
        'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO',
        '1997-05-12T09:00:00',
        '1997-05-12T00:00:00',
        '1999-12-31T23:59:59',
      ),
    ).toEqual([])
  })

  it('never shows a day the rule cannot fall on, where the library would roll one over', () => {
    // 30 February does not exist, and the standard says such a day is skipped. Left to itself the
    // library answers 2 March for it.
    expect(occurrences('FREQ=YEARLY;BYMONTH=2,4;BYMONTHDAY=30', '2026-01-01', '2026-01-02', '2028-12-31')).toEqual([
      '2026-04-30',
      '2027-04-30',
      '2028-04-30',
    ])
    expect(occurrences('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '2026-01-01', '2026-01-02', '2030-12-31')).toEqual([])
    // The last day of the month, counted from the end, is a real day in every month.
    expect(occurrences('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31', '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  it('returns only what lies between the two ends asked for, both included', () => {
    const daily = (from: string, to: string) => occurrences('FREQ=DAILY;COUNT=10', '2026-05-04T06:30:00', from, to)
    expect(daily('2026-05-06T06:30:00', '2026-05-08T06:30:00')).toEqual([
      '2026-05-06T06:30:00',
      '2026-05-07T06:30:00',
      '2026-05-08T06:30:00',
    ])
    expect(daily('2026-05-06T06:30:01', '2026-05-08T06:29:59')).toEqual(['2026-05-07T06:30:00'])
    expect(daily('2026-05-12T00:00:00', '2026-06-30T00:00:00')).toEqual(['2026-05-12T06:30:00', '2026-05-13T06:30:00'])
    expect(daily('2027-01-01T00:00:00', '2027-12-31T00:00:00')).toEqual([])
  })

  describe('an end date the rule states in UTC, for a series on another clock', () => {
    // Mondays and Wednesdays at 09:00 in Berlin. On 29 April 2026 Berlin is two hours ahead of UTC,
    // so that day's occurrence is at 07:00 UTC.
    const mondaysAndWednesdays = (until: string): string[] =>
      occurrences(
        `FREQ=WEEKLY;UNTIL=${until};BYDAY=MO,WE`,
        '2026-03-23T09:00:00',
        '2026-04-20T00:00:00',
        '2026-05-31T23:59:59',
        'Europe/Berlin',
      )

    it('includes the occurrence that falls exactly on it', () => {
      expect(mondaysAndWednesdays('20260429T070000Z')).toEqual([
        '2026-04-20T09:00:00',
        '2026-04-22T09:00:00',
        '2026-04-27T09:00:00',
        '2026-04-29T09:00:00',
      ])
    })

    it('leaves out the occurrence one second after it', () => {
      expect(mondaysAndWednesdays('20260429T065959Z')).toEqual([
        '2026-04-20T09:00:00',
        '2026-04-22T09:00:00',
        '2026-04-27T09:00:00',
      ])
    })

    it('reads it on the right side of a clock change', () => {
      // Tuesdays at 18:00 in New York. On 3 November 2026 New York is back on winter time, five hours
      // behind UTC: 18:00 there is 23:00 UTC, an hour later than it was the week before.
      const tuesdays = (until: string): string[] =>
        occurrences(
          `FREQ=WEEKLY;UNTIL=${until}`,
          '2026-10-06T18:00:00',
          '2026-10-20T00:00:00',
          '2026-12-01T00:00:00',
          'America/New_York',
        )
      expect(tuesdays('20261103T230000Z')).toEqual([
        '2026-10-20T18:00:00',
        '2026-10-27T18:00:00',
        '2026-11-03T18:00:00',
      ])
      expect(tuesdays('20261103T220000Z')).toEqual(['2026-10-20T18:00:00', '2026-10-27T18:00:00'])
    })

    it('reads it as it stands for a series tied to no zone', () => {
      const floating = (until: string): string[] =>
        occurrences(`FREQ=DAILY;UNTIL=${until}`, '2026-06-01T09:00:00', '2026-06-01T00:00:00', '2026-06-30T00:00:00')
      expect(floating('20260603T090000Z')).toHaveLength(3)
      expect(floating('20260603T085959Z')).toHaveLength(2)
      expect(floating('20260603T090000')).toHaveLength(3)
    })

    it('reads an end given as a day as the whole of that day, and for an all-day series as that day', () => {
      expect(
        occurrences('FREQ=DAILY;UNTIL=20260603', '2026-06-01T23:30:00', '2026-06-01T00:00:00', '2026-06-30T00:00:00'),
      ).toHaveLength(3)
      expect(occurrences('FREQ=DAILY;UNTIL=20260603', '2026-06-01', '2026-06-01', '2026-06-30')).toEqual([
        '2026-06-01',
        '2026-06-02',
        '2026-06-03',
      ])
      expect(occurrences('FREQ=DAILY;UNTIL=20260603T120000Z', '2026-06-01', '2026-06-01', '2026-06-30')).toEqual([
        '2026-06-01',
        '2026-06-02',
        '2026-06-03',
      ])
    })
  })

  it('gives the same answer for a window looked at after a later one', () => {
    const tools = createSeriesTools()
    const series = { rule: 'FREQ=MONTHLY;BYDAY=-1FR', start: '2026-01-30T10:00:00', zone: 'Europe/Berlin' }
    const later = tools.occurrencesOfRule({ ...series, from: '2027-01-01T00:00:00', to: '2027-03-31T23:59:59' })
    const earlier = tools.occurrencesOfRule({ ...series, from: '2026-01-01T00:00:00', to: '2026-06-30T23:59:59' })
    expect(later).toEqual(['2027-01-29T10:00:00', '2027-02-26T10:00:00', '2027-03-26T10:00:00'])
    expect(earlier).toEqual([
      '2026-01-30T10:00:00',
      '2026-02-27T10:00:00',
      '2026-03-27T10:00:00',
      '2026-04-24T10:00:00',
      '2026-05-29T10:00:00',
      '2026-06-26T10:00:00',
    ])
    // …and again, from what it remembers.
    expect(tools.occurrencesOfRule({ ...series, from: '2027-01-01T00:00:00', to: '2027-03-31T23:59:59' })).toEqual(
      later,
    )
  })

  it('keeps two series apart that differ only in their start or their zone', () => {
    const tools = createSeriesTools()
    const ask = (start: string, zone: string): string[] =>
      tools.occurrencesOfRule({
        rule: 'FREQ=WEEKLY;UNTIL=20260615T080000Z',
        start,
        zone,
        from: '2026-06-01T00:00:00',
        to: '2026-06-30T00:00:00',
      })
    // 08:00 UTC on 15 June is 10:00 in Berlin and 04:00 in New York.
    expect(ask('2026-06-01T10:00:00', 'Europe/Berlin')).toEqual([
      '2026-06-01T10:00:00',
      '2026-06-08T10:00:00',
      '2026-06-15T10:00:00',
    ])
    expect(ask('2026-06-01T10:00:00', 'America/New_York')).toEqual(['2026-06-01T10:00:00', '2026-06-08T10:00:00'])
    expect(ask('2026-06-02T10:00:00', 'Europe/Berlin')).toEqual(['2026-06-02T10:00:00', '2026-06-09T10:00:00'])
  })

  it('stops at its cap for a series that never ends', () => {
    const everyMinute = occurrences(
      'FREQ=MINUTELY',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00',
      '2099-01-01T00:00:00',
    )
    expect(everyMinute).toHaveLength(MAX_SERIES_OCCURRENCES)
  })

  it.each(['', 'FREQ=SOMETIMES', 'garbage', 'FREQ=WEEKLY;BYDAY=XX', 'COUNT=3'])(
    'produces nothing for a rule that is not one, %j',
    (rule) => {
      expect(occurrences(rule, '2026-01-01T09:00:00', '2026-01-01T00:00:00', '2026-12-31T00:00:00')).toEqual([])
    },
  )

  it('does not forget more series than it can hold without still answering for all of them', () => {
    const tools = createSeriesTools()
    const ask = (minute: number): string[] =>
      tools.occurrencesOfRule({
        rule: 'FREQ=DAILY;COUNT=2',
        start: `2026-01-01T00:${(minute % 60).toString().padStart(2, '0')}:00`,
        zone: `Zone/${minute}`,
        from: '2026-01-01T00:00:00',
        to: '2026-01-31T00:00:00',
      })
    const first = ask(0)
    for (let series = 1; series < 700; series++) {
      expect(ask(series)).toHaveLength(2)
    }
    expect(ask(0)).toEqual(first)
  })
})

describe('with the tools, a calendar shows a full repeat rule', () => {
  const window = daysInRange('2026-03-01', '2026-05-03', 400)
  const show = (event: CalendarEvent, displayZone: string): string[] => {
    const expanded = expandEventsForWindow([event], window, { displayZone, series: createSeriesTools() })
    return [...expanded.keys()]
      .sort()
      .flatMap((day) => (expanded.get(day) ?? []).map((occurrence) => `${day} ${occurrence.time} ${occurrence.title}`))
  }
  // Mondays and Wednesdays 09:00 Berlin until the end of April, with 1 April removed and 30 March moved to 11:00.
  const standUp: CalendarEvent = {
    id: 'a',
    date: '2026-03-23',
    title: 'Stand-up',
    allDay: false,
    start: '2026-03-23T08:00:00.000Z',
    end: '2026-03-23T08:30:00.000Z',
    zone: 'Europe/Berlin',
    localStart: '2026-03-23T09:00:00',
    localEnd: '2026-03-23T09:30:00',
    rrule: 'FREQ=WEEKLY;UNTIL=20260430T215959Z;BYDAY=MO,WE',
    exdates: ['2026-04-01T09:00:00'],
    overrides: [
      {
        rid: '2026-03-30T09:00:00',
        date: '2026-03-30',
        title: 'Stand-up (moved)',
        zone: 'Europe/Berlin',
        localStart: '2026-03-30T11:00:00',
        localEnd: '2026-03-30T11:30:00',
      },
    ],
  }

  it('on the event’s own clock, where every occurrence is at the same time across the clock change', () => {
    expect(show(standUp, 'Europe/Berlin')).toEqual([
      '2026-03-23 09:00 Stand-up',
      '2026-03-25 09:00 Stand-up',
      '2026-03-30 11:00 Stand-up (moved)',
      '2026-04-06 09:00 Stand-up',
      '2026-04-08 09:00 Stand-up',
      '2026-04-13 09:00 Stand-up',
      '2026-04-15 09:00 Stand-up',
      '2026-04-20 09:00 Stand-up',
      '2026-04-22 09:00 Stand-up',
      '2026-04-27 09:00 Stand-up',
      '2026-04-29 09:00 Stand-up',
    ])
  })

  it('and for a reader in another zone, an hour earlier once Berlin has changed its clocks', () => {
    expect(show(standUp, 'UTC')).toEqual([
      '2026-03-23 08:00 Stand-up',
      '2026-03-25 08:00 Stand-up',
      '2026-03-30 09:00 Stand-up (moved)',
      '2026-04-06 07:00 Stand-up',
      '2026-04-08 07:00 Stand-up',
      '2026-04-13 07:00 Stand-up',
      '2026-04-15 07:00 Stand-up',
      '2026-04-20 07:00 Stand-up',
      '2026-04-22 07:00 Stand-up',
      '2026-04-27 07:00 Stand-up',
      '2026-04-29 07:00 Stand-up',
    ])
  })
})
