import { daysInRange } from '@/Timezone/wallClock'
import {
  CALENDAR_DOCUMENT_VERSION,
  CalendarDocument,
  CalendarEvent,
  CalendarSeriesTools,
  ExpandOptions,
  MAX_RECURRENCE_CELLS,
  expandEventsForWindow,
  needsSeriesTools,
  parseCalendarDocument,
  serializeCalendarDocument,
} from './CalendarDocument'

/** A timed event as calendar sync writes one: instants for version 1 readers, wall time and zone beside them. */
const zoned = (
  id: string,
  zone: string,
  localStart: string,
  localEnd: string | undefined,
  start: string,
  end: string | undefined,
  more: Partial<CalendarEvent> = {},
): CalendarEvent => {
  const event: CalendarEvent = { id, date: localStart.slice(0, 10), title: id, allDay: false, start, zone, localStart }
  if (localEnd && end) {
    event.localEnd = localEnd
    event.end = end
  }
  return { ...event, ...more }
}

/** Each occurrence as one line: `day time title`, with what is unusual about it spelled out. */
const shown = (
  events: CalendarEvent[],
  from: string,
  to: string,
  options: ExpandOptions,
  window = daysInRange(from, to, 400),
): string[] => {
  const lines: string[] = []
  const expanded = expandEventsForWindow(events, window, options)
  for (const day of [...expanded.keys()].sort()) {
    for (const occurrence of expanded.get(day) ?? []) {
      lines.push(
        [
          day,
          occurrence.allDay ? 'all-day' : (occurrence.time ?? '--:--'),
          occurrence.title,
          occurrence.continuation ? '(continues)' : '',
          occurrence.cancelled ? '(cancelled)' : '',
        ]
          .filter((part) => part.length > 0)
          .join(' '),
      )
    }
  }
  return lines
}

describe('calendar document version 2: reading and writing', () => {
  const everything: CalendarEvent = {
    id: 'series',
    date: '2026-03-23',
    title: 'Stand-up',
    color: '#3b82f6',
    allDay: false,
    start: '2026-03-23T08:00:00.000Z',
    end: '2026-03-23T08:30:00.000Z',
    zone: 'Europe/Berlin',
    endZone: 'Europe/Lisbon',
    localStart: '2026-03-23T09:00:00',
    localEnd: '2026-03-23T08:30:00',
    description: 'Daily sync',
    location: 'Room 4',
    status: 'confirmed',
    clipped: 'digest-of-the-whole',
    localOf: [Date.UTC(2026, 2, 23, 8) / 1000, Date.UTC(2026, 2, 23, 8, 30) / 1000],
    rrule: 'FREQ=WEEKLY;UNTIL=20260430T215959Z;BYDAY=MO,WE',
    exdates: ['2026-04-01T09:00:00', '2026-04-08'],
    rdates: ['2026-05-04T09:00:00'],
    overrides: [
      {
        rid: '2026-03-30T09:00:00',
        date: '2026-03-30',
        title: 'Stand-up (moved)',
        zone: 'Europe/Berlin',
        localStart: '2026-03-30T11:00:00',
        localEnd: '2026-03-30T11:30:00',
        status: 'tentative',
      },
    ],
    guests: true,
    alarm: true,
  }
  const trip: CalendarEvent = { id: 'trip', date: '2026-06-10', title: 'Trip', days: 3 }
  const floating: CalendarEvent = {
    id: 'floating',
    date: '2026-06-10',
    title: 'Wake up',
    allDay: false,
    start: '2026-06-10T06:00:00.000Z',
    zone: 'Europe/Lisbon',
    floating: true,
    localStart: '2026-06-10T07:00:00',
    localOf: [Date.UTC(2026, 5, 10, 6) / 1000],
  }

  it('writes new calendars as version 2', () => {
    expect(CALENDAR_DOCUMENT_VERSION).toBe(2)
  })

  it('reads back every version 2 key it wrote', () => {
    const document: CalendarDocument = { version: 2, events: [everything, trip, floating] }
    expect(parseCalendarDocument(serializeCalendarDocument(document)).document).toEqual(document)
  })

  it('stores the keys of an event in one fixed order', () => {
    const scrambled = Object.fromEntries(Object.entries(everything).reverse()) as CalendarEvent
    const stored = JSON.parse(serializeCalendarDocument({ version: 2, events: [scrambled] })) as {
      events: Record<string, unknown>[]
    }
    expect(Object.keys(stored.events[0])).toEqual([
      'id',
      'date',
      'title',
      'color',
      'allDay',
      'start',
      'end',
      'zone',
      'endZone',
      'localStart',
      'localEnd',
      'description',
      'location',
      'status',
      'clipped',
      'localOf',
      'rrule',
      'exdates',
      'rdates',
      'overrides',
      'guests',
      'alarm',
    ])
    expect(serializeCalendarDocument({ version: 2, events: [scrambled] })).toBe(
      serializeCalendarDocument({ version: 2, events: [everything] }),
    )
  })

  const read = (event: Record<string, unknown>): CalendarEvent =>
    parseCalendarDocument(JSON.stringify({ version: 2, events: [event] })).document.events[0]

  it('keeps a length in days only on an all-day event, and only when it is more than one whole day', () => {
    expect(read({ id: 'a', date: '2026-06-10', days: 3 }).days).toBe(3)
    expect(read({ id: 'a', date: '2026-06-10', days: 2 }).days).toBe(2)
    for (const days of [1, 0, -3, 2.5, '3', null, 3661, Number.MAX_SAFE_INTEGER]) {
      expect(read({ id: 'a', date: '2026-06-10', days }).days).toBeUndefined()
    }
    expect(read({ ...everything, days: 3 }).days).toBeUndefined()
  })

  it('keeps a zone and wall times only on a timed event, and only together', () => {
    expect(read({ id: 'a', date: '2026-06-10', zone: 'Europe/Berlin', localStart: '2026-06-10T09:00:00' })).toEqual({
      id: 'a',
      date: '2026-06-10',
      title: '',
    })
    const timed = { id: 'a', date: '2026-06-10', allDay: false, start: '2026-06-10T07:00:00.000Z' }
    expect(read({ ...timed, zone: 'Europe/Berlin' }).zone).toBeUndefined()
    expect(read({ ...timed, localStart: '2026-06-10T09:00:00' }).localStart).toBeUndefined()
    expect(read({ ...timed, zone: 'Europe/Berlin', localStart: '2026-06-10T25:00:00' }).zone).toBeUndefined()
    expect(read({ ...timed, zone: 'Europe/Berlin', localStart: '2026-06-10T09:00:00', floating: 'yes' }).floating).toBe(
      undefined,
    )
    // An end zone says something only when it differs and there is an end to read in it.
    // 10:00 in Lisbon and 11:00 in Berlin are both 09:00 UTC that day.
    const withEnd = {
      ...timed,
      end: '2026-06-10T09:00:00.000Z',
      zone: 'Europe/Berlin',
      localStart: '2026-06-10T09:00:00',
      localOf: [Date.UTC(2026, 5, 10, 7) / 1000, Date.UTC(2026, 5, 10, 9) / 1000],
    }
    expect(read({ ...withEnd, endZone: 'Europe/Berlin', localEnd: '2026-06-10T11:00:00' }).endZone).toBeUndefined()
    const inLisbon = read({ ...withEnd, endZone: 'Europe/Lisbon', localEnd: '2026-06-10T10:00:00' })
    expect([inLisbon.endZone, inLisbon.localEnd]).toEqual(['Europe/Lisbon', '2026-06-10T10:00:00'])
    // With no wall time for the end, an end zone is not kept, and the end is read from its instant.
    const withoutLocalEnd = read({ ...withEnd, endZone: 'Europe/Lisbon' })
    expect([withoutLocalEnd.endZone, withoutLocalEnd.localEnd]).toEqual([undefined, '2026-06-10T11:00:00'])
    // And a wall time for an end the event does not have is not kept either.
    const { end: _end, ...noEnd } = withEnd
    const withoutEnd = read({ ...noEnd, endZone: 'Europe/Lisbon', localEnd: '2026-06-10T10:00:00' })
    expect([withoutEnd.endZone, withoutEnd.localEnd]).toEqual([undefined, undefined])
  })

  it('reads the simple repeat rule in preference to the long one when both are stored', () => {
    const both = read({ id: 'a', date: '2026-06-10', recurrence: { freq: 'weekly' }, rrule: 'FREQ=DAILY' })
    expect(both.recurrence).toEqual({ freq: 'weekly' })
    expect(both.rrule).toBeUndefined()
    expect(read({ id: 'a', date: '2026-06-10', rrule: 'FREQ=DAILY' }).rrule).toBe('FREQ=DAILY')
    expect(read({ id: 'a', date: '2026-06-10', rrule: '' }).rrule).toBeUndefined()
    expect(read({ id: 'a', date: '2026-06-10', rrule: 'X'.repeat(1001) }).rrule).toBeUndefined()
  })

  it('keeps only real occurrence times, each once, in order', () => {
    const event = read({
      id: 'a',
      date: '2026-06-10',
      exdates: ['2026-06-20', 'junk', '2026-06-12', 7, '2026-06-20', '2026-06-31', '2026-06-11T09:00:00'],
      rdates: 'not a list',
    })
    expect(event.exdates).toEqual(['2026-06-11T09:00:00', '2026-06-12', '2026-06-20'])
    expect(event.rdates).toBeUndefined()
    expect(read({ id: 'a', date: '2026-06-10', exdates: ['junk'] }).exdates).toBeUndefined()
  })

  it('keeps only readable changed occurrences, one per occurrence, in order', () => {
    const event = read({
      id: 'a',
      date: '2026-06-01',
      recurrence: { freq: 'daily' },
      overrides: [
        { rid: '2026-06-05', date: '2026-06-06', title: 'Later one', vendor: { kept: true } },
        { rid: '2026-06-03', date: '2026-06-03', title: 'Earlier one', days: 2, status: 'cancelled' },
        { rid: '2026-06-03', date: '2026-06-04', title: 'Same occurrence again' },
        { rid: 'junk', date: '2026-06-04', title: 'No such occurrence' },
        { rid: '2026-06-07', title: 'No day' },
        'not an object',
      ],
    })
    expect(event.overrides).toEqual([
      { rid: '2026-06-03', date: '2026-06-03', title: 'Earlier one', days: 2, status: 'cancelled' },
      { rid: '2026-06-05', date: '2026-06-06', title: 'Later one', unknownFields: { vendor: { kept: true } } },
    ])
    // The key this build did not know is written back inside the changed occurrence.
    const stored = JSON.parse(serializeCalendarDocument({ version: 2, events: [event] })) as {
      events: { overrides: Record<string, unknown>[] }[]
    }
    expect(stored.events[0].overrides[1]).toEqual({
      rid: '2026-06-05',
      date: '2026-06-06',
      title: 'Later one',
      vendor: { kept: true },
    })
  })

  it('reads guests, a reminder and a status only as what they are', () => {
    expect(read({ id: 'a', date: '2026-06-10', guests: true, alarm: true, status: 'cancelled' })).toEqual({
      id: 'a',
      date: '2026-06-10',
      title: '',
      guests: true,
      alarm: true,
      status: 'cancelled',
    })
    expect(
      read({ id: 'a', date: '2026-06-10', guests: 1, alarm: 'yes', status: 'postponed', description: '' }),
    ).toEqual({ id: 'a', date: '2026-06-10', title: '' })
  })
})

describe('calendar document version 2: after a build that knows only version 1 has changed an event', () => {
  const read = (event: Record<string, unknown>): CalendarEvent =>
    parseCalendarDocument(JSON.stringify({ version: 2, events: [event] })).document.events[0]
  const seconds = (instant: string): number => Date.parse(instant) / 1000

  /** 09:00 to 09:30 in Berlin on 23 March 2026, as calendar sync stores it. */
  const asSynced = {
    id: 'a',
    date: '2026-03-23',
    title: 'Stand-up',
    allDay: false,
    start: '2026-03-23T08:00:00.000Z',
    end: '2026-03-23T08:30:00.000Z',
    zone: 'Europe/Berlin',
    localStart: '2026-03-23T09:00:00',
    localEnd: '2026-03-23T09:30:00',
    localOf: [seconds('2026-03-23T08:00:00.000Z'), seconds('2026-03-23T08:30:00.000Z')],
  }

  it('leaves an event nobody changed exactly as it was stored', () => {
    const text = JSON.stringify({ version: 2, events: [asSynced] })
    expect(serializeCalendarDocument(parseCalendarDocument(text).document)).toBe(text)
  })

  it('takes the time the person set there, not the wall time left over from before', () => {
    // A version 1 editor moves the event to 14:00 local time. It rewrites `start`, `end` and `date`,
    // and carries the keys it does not know (zone, wall times, localOf) through untouched.
    const editedByVersion1 = {
      ...asSynced,
      date: '2026-03-24',
      start: '2026-03-24T13:00:00.000Z',
      end: '2026-03-24T13:45:00.000Z',
    }
    const event = read(editedByVersion1)
    expect(event.localStart).toBe('2026-03-24T14:00:00')
    expect(event.localEnd).toBe('2026-03-24T14:45:00')
    expect(event.zone).toBe('Europe/Berlin')
    expect(event.start).toBe('2026-03-24T13:00:00.000Z')
    // …and from then on the wall times are vouched for again.
    expect(event.localOf).toEqual([seconds('2026-03-24T13:00:00.000Z'), seconds('2026-03-24T13:45:00.000Z')])
    expect(shown([event], '2026-03-23', '2026-03-25', { displayZone: 'Europe/Berlin' })).toEqual([
      '2026-03-24 14:00 Stand-up',
    ])
  })

  it('takes the instant as what the person set when only the start or only the end was moved, or the end removed', () => {
    const startMoved = read({ ...asSynced, start: '2026-03-23T08:15:00.000Z' })
    expect([startMoved.localStart, startMoved.localEnd]).toEqual(['2026-03-23T09:15:00', '2026-03-23T09:30:00'])
    const endMoved = read({ ...asSynced, end: '2026-03-23T10:00:00.000Z' })
    expect([endMoved.localStart, endMoved.localEnd]).toEqual(['2026-03-23T09:00:00', '2026-03-23T11:00:00'])
    expect(endMoved.localOf).toEqual([seconds('2026-03-23T08:00:00.000Z'), seconds('2026-03-23T10:00:00.000Z')])
    const { end: _end, ...withoutEnd } = asSynced
    const endRemoved = read(withoutEnd)
    expect(endRemoved.localStart).toBe('2026-03-23T09:00:00')
    expect(endRemoved.localEnd).toBeUndefined()
    expect(endRemoved.localOf).toEqual([seconds('2026-03-23T08:00:00.000Z')])
  })

  it('reads a changed end on the clock of the zone the end has, when that is not the start’s', () => {
    // A flight: leaves Berlin at 09:00 and lands in Lisbon at 10:30 Lisbon time. A version 1 editor delays it an hour.
    const flight = {
      ...asSynced,
      end: '2026-03-23T10:30:00.000Z',
      endZone: 'Europe/Lisbon',
      localEnd: '2026-03-23T10:30:00',
      localOf: [seconds('2026-03-23T08:00:00.000Z'), seconds('2026-03-23T10:30:00.000Z')],
    }
    expect(read(flight)).toMatchObject({ localEnd: '2026-03-23T10:30:00', endZone: 'Europe/Lisbon' })
    const delayed = read({ ...flight, start: '2026-03-23T09:00:00.000Z', end: '2026-03-23T11:30:00.000Z' })
    expect([delayed.localStart, delayed.localEnd, delayed.endZone]).toEqual([
      '2026-03-23T10:00:00',
      '2026-03-23T11:30:00',
      'Europe/Lisbon',
    ])
  })

  it('reads a wall time nobody vouched for from the instant', () => {
    const { localOf: _localOf, ...unvouched } = asSynced
    expect(read({ ...unvouched, localStart: '2026-03-23T11:11:11' }).localStart).toBe('2026-03-23T09:00:00')
    expect(read({ ...asSynced, localOf: 'yes' }).localOf).toEqual(asSynced.localOf)
    expect(read({ ...asSynced, localStart: '2026-03-23T11:11:11', localOf: [1, 2] }).localStart).toBe(
      '2026-03-23T09:00:00',
    )
  })

  it('reads a floating time afresh on the clock its instant was worked out on', () => {
    const floating = { ...asSynced, floating: true, start: '2026-03-23T10:00:00.000Z', end: '2026-03-23T10:30:00.000Z' }
    const event = read(floating)
    expect(event.floating).toBe(true)
    expect([event.localStart, event.localEnd]).toEqual(['2026-03-23T11:00:00', '2026-03-23T11:30:00'])
  })

  describe('and when two devices disagree about a zone', () => {
    // Stored by a device whose zone data says Berlin is three hours ahead that day: 09:00 there is 06:00 UTC.
    const fromAnotherZoneDatabase = {
      ...asSynced,
      start: '2026-03-23T06:00:00.000Z',
      end: '2026-03-23T06:30:00.000Z',
      localOf: [seconds('2026-03-23T06:00:00.000Z'), seconds('2026-03-23T06:30:00.000Z')],
    }

    it('keeps the wall time, and does not rewrite an event neither device changed', () => {
      const text = JSON.stringify({ version: 2, events: [fromAnotherZoneDatabase] })
      const { document } = parseCalendarDocument(text)
      expect(document.events[0].localStart).toBe('2026-03-23T09:00:00')
      expect(serializeCalendarDocument(document)).toBe(text)
    })

    it('shows the event at its wall time by this device’s own rules', () => {
      expect(
        shown([read(fromAnotherZoneDatabase)], '2026-03-23', '2026-03-23', { displayZone: 'Europe/Berlin' }),
      ).toEqual(['2026-03-23 09:00 Stand-up'])
      expect(shown([read(fromAnotherZoneDatabase)], '2026-03-23', '2026-03-23', { displayZone: 'UTC' })).toEqual([
        '2026-03-23 08:00 Stand-up',
      ])
    })
  })

  describe('and the zone is one the platform has no name for', () => {
    const foreign = { ...asSynced, zone: 'Customized Time Zone' }

    it('keeps wall times that are vouched for', () => {
      expect(read(foreign)).toMatchObject({ zone: 'Customized Time Zone', localStart: '2026-03-23T09:00:00' })
    })

    it('falls back to the instants alone once they have been changed', () => {
      const event = read({ ...foreign, start: '2026-03-23T12:00:00.000Z', end: '2026-03-23T12:30:00.000Z' })
      expect(event).toEqual({
        id: 'a',
        date: '2026-03-23',
        title: 'Stand-up',
        allDay: false,
        start: '2026-03-23T12:00:00.000Z',
        end: '2026-03-23T12:30:00.000Z',
      })
    })
  })

  it('moves the whole of an all-day event when its first day is moved', () => {
    const trip = { id: 'trip', date: '2026-06-10', title: 'Trip', days: 3 }
    // A version 1 editor can only change `date`.
    const moved = read({ ...trip, date: '2026-06-17' })
    expect(shown([moved], '2026-06-08', '2026-06-21', { displayZone: 'UTC' })).toEqual([
      '2026-06-17 all-day Trip',
      '2026-06-18 all-day Trip (continues)',
      '2026-06-19 all-day Trip (continues)',
    ])
  })
})

describe('calendar document version 2: showing events', () => {
  const berlin: ExpandOptions = { displayZone: 'Europe/Berlin' }

  it('shows an all-day event on each of its days, and not on its end day', () => {
    const trip: CalendarEvent = { id: 'trip', date: '2026-06-10', title: 'Trip', days: 3 }
    expect(shown([trip], '2026-06-08', '2026-06-14', berlin)).toEqual([
      '2026-06-10 all-day Trip',
      '2026-06-11 all-day Trip (continues)',
      '2026-06-12 all-day Trip (continues)',
    ])
  })

  it('shows the days of an all-day event that began before the first day shown', () => {
    const trip: CalendarEvent = { id: 'trip', date: '2026-05-30', title: 'Trip', days: 4 }
    expect(shown([trip], '2026-06-01', '2026-06-14', berlin)).toEqual([
      '2026-06-01 all-day Trip (continues)',
      '2026-06-02 all-day Trip (continues)',
    ])
  })

  it('repeats an all-day event of several days as a whole', () => {
    const weekend: CalendarEvent = {
      id: 'w',
      date: '2026-06-06',
      title: 'Weekend',
      days: 2,
      recurrence: { freq: 'weekly', interval: 2 },
    }
    expect(shown([weekend], '2026-06-01', '2026-06-22', berlin)).toEqual([
      '2026-06-06 all-day Weekend',
      '2026-06-07 all-day Weekend (continues)',
      '2026-06-20 all-day Weekend',
      '2026-06-21 all-day Weekend (continues)',
    ])
  })

  // 23:30 in New York on 10 June is 03:30 UTC on the 11th.
  const lateInNewYork = zoned(
    'Late',
    'America/New_York',
    '2026-06-10T23:30:00',
    '2026-06-11T00:30:00',
    '2026-06-11T03:30:00.000Z',
    '2026-06-11T04:30:00.000Z',
  )

  it.each([
    ['America/New_York', ['2026-06-10 23:30 Late', '2026-06-11 --:-- Late (continues)']],
    ['Europe/Berlin', ['2026-06-11 05:30 Late']],
    ['America/Los_Angeles', ['2026-06-10 20:30 Late']],
    ['Pacific/Kiritimati', ['2026-06-11 17:30 Late']],
    ['Asia/Kathmandu', ['2026-06-11 09:15 Late']],
  ])('shows an event from another zone on the day and at the time it has in %s', (displayZone, expected) => {
    expect(shown([lateInNewYork], '2026-06-08', '2026-06-14', { displayZone })).toEqual(expected)
  })

  // Clocks in Berlin go forward on 29 March 2026; New York's went forward on the 8th.
  const weeklyInBerlin = zoned(
    'Weekly',
    'Europe/Berlin',
    '2026-03-02T09:00:00',
    '2026-03-02T09:30:00',
    '2026-03-02T08:00:00.000Z',
    '2026-03-02T08:30:00.000Z',
    { recurrence: { freq: 'weekly' } },
  )

  it('keeps a weekly event at the same time on its own clock across a clock change', () => {
    expect(shown([weeklyInBerlin], '2026-03-02', '2026-04-06', berlin)).toEqual([
      '2026-03-02 09:00 Weekly',
      '2026-03-09 09:00 Weekly',
      '2026-03-16 09:00 Weekly',
      '2026-03-23 09:00 Weekly',
      '2026-03-30 09:00 Weekly',
      '2026-04-06 09:00 Weekly',
    ])
  })

  it('moves it by an hour for a reader whose clock did not change, or changed on another day', () => {
    expect(shown([weeklyInBerlin], '2026-03-02', '2026-04-06', { displayZone: 'UTC' })).toEqual([
      '2026-03-02 08:00 Weekly',
      '2026-03-09 08:00 Weekly',
      '2026-03-16 08:00 Weekly',
      '2026-03-23 08:00 Weekly',
      '2026-03-30 07:00 Weekly',
      '2026-04-06 07:00 Weekly',
    ])
    expect(shown([weeklyInBerlin], '2026-03-02', '2026-04-06', { displayZone: 'America/New_York' })).toEqual([
      '2026-03-02 03:00 Weekly',
      '2026-03-09 04:00 Weekly',
      '2026-03-16 04:00 Weekly',
      '2026-03-23 04:00 Weekly',
      '2026-03-30 03:00 Weekly',
      '2026-04-06 03:00 Weekly',
    ])
  })

  it('shows an occurrence that the clocks skip at the time they then show', () => {
    // 02:30 does not exist in Berlin on 29 March 2026.
    const nightly = zoned(
      'Nightly',
      'Europe/Berlin',
      '2026-03-28T02:30:00',
      undefined,
      '2026-03-28T01:30:00.000Z',
      undefined,
      { recurrence: { freq: 'daily' } },
    )
    expect(shown([nightly], '2026-03-28', '2026-03-30', berlin)).toEqual([
      '2026-03-28 02:30 Nightly',
      '2026-03-29 03:30 Nightly',
      '2026-03-30 02:30 Nightly',
    ])
  })

  it('shows a time tied to no zone at that time everywhere', () => {
    const wakeUp: CalendarEvent = {
      id: 'Wake up',
      date: '2026-06-10',
      title: 'Wake up',
      allDay: false,
      start: '2026-06-10T06:00:00.000Z',
      zone: 'Europe/Lisbon',
      floating: true,
      localStart: '2026-06-10T07:00:00',
      recurrence: { freq: 'daily' },
    }
    for (const displayZone of ['Europe/Lisbon', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      expect(shown([wakeUp], '2026-06-10', '2026-06-11', { displayZone })).toEqual([
        '2026-06-10 07:00 Wake up',
        '2026-06-11 07:00 Wake up',
      ])
    }
  })

  it('shows an event that runs past midnight on both days, and one that ends at midnight on one', () => {
    const overnight = zoned(
      'Overnight',
      'Europe/Berlin',
      '2026-06-10T22:00:00',
      '2026-06-11T02:00:00',
      '2026-06-10T20:00:00.000Z',
      '2026-06-11T00:00:00.000Z',
    )
    const untilMidnight = zoned(
      'Evening',
      'Europe/Berlin',
      '2026-06-10T22:00:00',
      '2026-06-11T00:00:00',
      '2026-06-10T20:00:00.000Z',
      '2026-06-10T22:00:00.000Z',
    )
    expect(shown([overnight, untilMidnight], '2026-06-09', '2026-06-12', berlin)).toEqual([
      '2026-06-10 22:00 Overnight',
      '2026-06-10 22:00 Evening',
      '2026-06-11 --:-- Overnight (continues)',
    ])
  })

  describe('a series with occurrences changed, removed and added', () => {
    const series = zoned(
      'Series',
      'Europe/Berlin',
      '2026-06-01T09:00:00',
      '2026-06-01T10:00:00',
      '2026-06-01T07:00:00.000Z',
      '2026-06-01T08:00:00.000Z',
      {
        recurrence: { freq: 'daily' },
        exdates: ['2026-06-03T09:00:00', '2026-06-05'],
        rdates: ['2026-06-02T15:00:00'],
        overrides: [
          {
            rid: '2026-06-04T09:00:00',
            date: '2026-06-04',
            title: 'Series (moved)',
            zone: 'Europe/Berlin',
            localStart: '2026-06-04T14:00:00',
            localEnd: '2026-06-04T15:00:00',
          },
          {
            rid: '2026-06-06T09:00:00',
            date: '2026-06-06',
            title: 'Series',
            status: 'cancelled',
          },
          {
            rid: '2026-06-07T09:00:00',
            date: '2026-07-20',
            title: 'Series (moved to July)',
            zone: 'Europe/Berlin',
            localStart: '2026-07-20T09:00:00',
          },
        ],
      },
    )

    it('shows each occurrence as it now is', () => {
      expect(shown([series], '2026-06-01', '2026-06-08', berlin)).toEqual([
        '2026-06-01 09:00 Series',
        '2026-06-02 09:00 Series',
        '2026-06-02 15:00 Series',
        // 3 June was removed by its exact time, 5 June by its day.
        '2026-06-04 14:00 Series (moved)',
        '2026-06-06 all-day Series (cancelled)',
        // 7 June was moved to July.
        '2026-06-08 09:00 Series',
      ])
    })

    it('shows a moved occurrence where it was moved to, far from the day it left', () => {
      expect(shown([series], '2026-07-20', '2026-07-20', berlin)).toEqual([
        '2026-07-20 09:00 Series',
        '2026-07-20 09:00 Series (moved to July)',
      ])
    })
  })

  it('gives an occurrence added by its day alone the time of day the series has', () => {
    const weekly = zoned(
      'Weekly',
      'Europe/Berlin',
      '2026-06-01T09:00:00',
      undefined,
      '2026-06-01T07:00:00.000Z',
      undefined,
      { recurrence: { freq: 'weekly' }, rdates: ['2026-06-03'] },
    )
    expect(shown([weekly], '2026-06-01', '2026-06-08', berlin)).toEqual([
      '2026-06-01 09:00 Weekly',
      '2026-06-03 09:00 Weekly',
      '2026-06-08 09:00 Weekly',
    ])
  })

  describe('a repeat rule the simple form cannot express', () => {
    const lastFriday = zoned(
      'Review',
      'Europe/Berlin',
      '2026-01-30T10:00:00',
      '2026-01-30T11:00:00',
      '2026-01-30T09:00:00.000Z',
      '2026-01-30T10:00:00.000Z',
      { rrule: 'FREQ=MONTHLY;BYDAY=-1FR' },
    )

    it('asks the series tools for the occurrences, on the series own clock', () => {
      const asked: Parameters<CalendarSeriesTools['occurrencesOfRule']>[0][] = []
      const series: CalendarSeriesTools = {
        zones: { knows: () => false, toInstant: () => Number.NaN, toWall: () => '' },
        occurrencesOfRule: (input) => {
          asked.push(input)
          return ['2026-02-27T10:00:00', '2026-03-27T10:00:00']
        },
      }
      expect(shown([lastFriday], '2026-02-01', '2026-03-31', { displayZone: 'Europe/Berlin', series })).toEqual([
        '2026-02-27 10:00 Review',
        '2026-03-27 10:00 Review',
      ])
      expect(asked).toEqual([
        {
          rule: 'FREQ=MONTHLY;BYDAY=-1FR',
          start: '2026-01-30T10:00:00',
          zone: 'Europe/Berlin',
          from: '2026-01-29T00:00:00',
          to: '2026-04-02T23:59:59',
        },
      ])
    })

    it('shows only the first occurrence until the tools are there, and says they are needed', () => {
      expect(shown([lastFriday], '2026-01-01', '2026-03-31', berlin)).toEqual(['2026-01-30 10:00 Review'])
      expect(needsSeriesTools([lastFriday])).toBe(true)
      expect(needsSeriesTools([{ id: 'a', date: '2026-06-10', title: 'Plain', recurrence: { freq: 'daily' } }])).toBe(
        false,
      )
    })

    it('does not hand a zone to the tools for an all-day or a floating series', () => {
      const zonesAsked: (string | undefined)[] = []
      const series: CalendarSeriesTools = {
        zones: { knows: () => false, toInstant: () => Number.NaN, toWall: () => '' },
        occurrencesOfRule: (input) => {
          zonesAsked.push(input.zone)
          return []
        },
      }
      const allDay: CalendarEvent = { id: 'a', date: '2026-06-01', title: 'A', rrule: 'FREQ=YEARLY;BYMONTH=6,7' }
      const floating: CalendarEvent = { ...lastFriday, id: 'f', floating: true }
      expandEventsForWindow([allDay, floating], daysInRange('2026-06-01', '2026-06-30', 400), { ...berlin, series })
      expect(zonesAsked).toEqual([undefined, undefined])
    })
  })

  describe('a zone the platform has no name for', () => {
    const foreign = zoned(
      'Foreign',
      'Customized Time Zone',
      '2026-03-23T09:00:00',
      '2026-03-23T10:00:00',
      '2026-03-23T08:00:00.000Z',
      '2026-03-23T09:00:00.000Z',
    )

    it('places a single event by the instant stored with it', () => {
      expect(shown([foreign], '2026-03-22', '2026-03-24', { displayZone: 'UTC' })).toEqual(['2026-03-23 08:00 Foreign'])
      expect(needsSeriesTools([foreign])).toBe(false)
    })

    it('needs the tools for a repeating one, and uses their rules for the zone', () => {
      const weekly = { ...foreign, recurrence: { freq: 'weekly' as const } }
      expect(needsSeriesTools([weekly])).toBe(true)
      const series: CalendarSeriesTools = {
        occurrencesOfRule: () => [],
        zones: {
          knows: (zone) => zone === 'Customized Time Zone',
          // A made-up zone: one hour ahead until 29 March, two from then on.
          toInstant: (_zone, wall) => Date.parse(`${wall}Z`) - (wall < '2026-03-29' ? 1 : 2) * 3_600_000,
          toWall: () => '',
        },
      }
      expect(shown([weekly], '2026-03-23', '2026-03-30', { displayZone: 'UTC', series })).toEqual([
        '2026-03-23 08:00 Foreign',
        '2026-03-30 07:00 Foreign',
      ])
      // Without them the offset of the first occurrence is held: right until the clocks change.
      expect(shown([weekly], '2026-03-23', '2026-03-30', { displayZone: 'UTC' })).toEqual([
        '2026-03-23 08:00 Foreign',
        '2026-03-30 08:00 Foreign',
      ])
    })
  })

  it('shows an event the version 1 editor made as that editor did: on its day, at the local time', () => {
    const legacy: CalendarEvent = {
      id: 'Legacy',
      date: '2026-06-10',
      title: 'Legacy',
      allDay: false,
      start: '2026-06-10T20:00:00.000Z',
      end: '2026-06-11T20:00:00.000Z',
      recurrence: { freq: 'weekly' },
    }
    // In Tokyo that instant is 05:00 on the 11th. Version 1 never moved an event off its `date`, nor
    // showed it on a second day, and an event it made still has neither done to it.
    expect(shown([legacy], '2026-06-08', '2026-06-18', { displayZone: 'Asia/Tokyo' })).toEqual([
      '2026-06-10 05:00 Legacy',
      '2026-06-17 05:00 Legacy',
    ])
  })

  it('puts all-day entries first, then timed ones in order of time', () => {
    const at = (title: string, hour: string): CalendarEvent =>
      zoned(title, 'UTC', `2026-06-10T${hour}:00:00`, undefined, `2026-06-10T${hour}:00:00.000Z`, undefined)
    const events = [
      at('Late', '18'),
      at('Early', '07'),
      { id: 'd', date: '2026-06-10', title: 'Day' },
      at('Noon', '12'),
    ]
    expect(shown(events, '2026-06-10', '2026-06-10', { displayZone: 'UTC' })).toEqual([
      '2026-06-10 all-day Day',
      '2026-06-10 07:00 Early',
      '2026-06-10 12:00 Noon',
      '2026-06-10 18:00 Late',
    ])
  })

  it('stops at the cap for one event in one window', () => {
    const daily: CalendarEvent = { id: 'd', date: '2026-01-01', title: 'Daily', recurrence: { freq: 'daily' } }
    expect(shown([daily], '2026-01-01', '2026-03-31', berlin)).toHaveLength(MAX_RECURRENCE_CELLS)
  })

  it('shows only the days asked for, in any order, and nothing for an empty or unreadable window', () => {
    const daily: CalendarEvent = { id: 'd', date: '2026-06-01', title: 'Daily', recurrence: { freq: 'daily' } }
    expect(shown([daily], '', '', berlin, ['2026-06-20', '2026-06-03', 'junk'])).toEqual([
      '2026-06-03 all-day Daily',
      '2026-06-20 all-day Daily',
    ])
    expect(shown([daily], '', '', berlin, [])).toEqual([])
    expect(shown([daily], '', '', berlin, ['junk'])).toEqual([])
  })

  it('leaves out an event whose time cannot be worked out, without failing', () => {
    const broken: CalendarEvent = {
      id: 'b',
      date: '2026-06-10',
      title: 'Broken',
      allDay: false,
      start: '2026-06-10T07:00:00.000Z',
      zone: 'Nowhere/At_All',
      localStart: '2026-06-10T09:00:00',
      overrides: [
        { rid: '2026-06-10T09:00:00', date: '2026-06-10', title: 'x', zone: 'Also/Nowhere', localStart: 'x' },
      ],
    }
    const withoutInstant = { ...broken, id: 'c', start: 'not a time' }
    expect(() => shown([broken, withoutInstant], '2026-06-09', '2026-06-11', berlin)).not.toThrow()
  })
})
