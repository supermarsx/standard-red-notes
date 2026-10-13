/**
 * @jest-environment node
 */
import {
  CalendarEvent,
  parseCalendarDocument,
  serializeCalendarDocument,
} from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { CORPUS } from '../__fixtures__/corpus'
import { parseCalendarObject } from '../ical/parseCalendarObject'
import { ZoneBook } from '../ical/zoneBook'
import { localIdForUid } from '../identity'
import { corpusText } from '../testing/corpusModel'
import { platformZoneRules } from '../time/zoneRules'
import { EventModel, ModelTime, clipTexts, fingerprintOfEvent } from './eventModel'
import { EventNoteContext, eventFromModel, modelFromEvent } from './eventNote'

const lisbon: EventNoteContext = { bindingZone: 'Europe/Lisbon', zones: platformZoneRules }

/** A model as the corpus entry of that name is read, with the zone rules its own definitions give. */
const fromCorpus = (name: string): { model: EventModel; context: EventNoteContext } => {
  const entry = CORPUS.find((candidate) => candidate.name === name)
  if (!entry) {
    throw new Error(`no corpus entry called ${name}`)
  }
  const parsed = parseCalendarObject(corpusText(entry))
  if (!parsed.ok) {
    throw new Error(`corpus entry ${name} is unreadable: ${parsed.reason}`)
  }
  const zones = new ZoneBook()
  for (const tzid of Object.keys(parsed.zoneDefinitions)) {
    zones.add(tzid, parsed.zoneDefinitions[tzid])
  }
  return { model: parsed.model, context: { bindingZone: 'Europe/Lisbon', zones } }
}

/** What a device holds after the event went into a note, the note was saved, and was read again. */
const throughANote = (event: CalendarEvent): CalendarEvent => {
  const text = serializeCalendarDocument({ version: 2, events: [event] })
  const { document } = parseCalendarDocument(text)
  expect(document.events).toHaveLength(1)
  // And reading it changed nothing that writing it again would show.
  expect(serializeCalendarDocument(document)).toBe(text)
  return document.events[0]
}

describe('a model written into a note and read back', () => {
  it.each(CORPUS.map((entry) => entry.name))('%s: is the same model, with the same fingerprint', (name) => {
    const { model, context } = fromCorpus(name)
    const event = eventFromModel(model, context)
    expect(modelFromEvent(event, model.uid)).toEqual(model)
    const reread = modelFromEvent(throughANote(event), model.uid)
    expect(reread).toEqual(model)
    expect(fingerprintOfEvent(reread)).toBe(fingerprintOfEvent(model))
  })

  it('is the same text every time, whatever order the parts of a series were listed in', () => {
    const { model, context } = fromCorpus(
      'nextcloud: a series with one occurrence moved, one cancelled and one removed',
    )
    const withMore: EventModel = {
      ...model,
      exdates: ['2026-04-27T14:00:00', '2026-04-20T14:00:00'],
      rdates: ['2026-06-02T14:00:00', '2026-06-01T14:00:00'],
    }
    const reversed: EventModel = {
      ...withMore,
      exdates: [...withMore.exdates].reverse(),
      rdates: [...withMore.rdates].reverse(),
      overrides: [...withMore.overrides].reverse(),
    }
    expect(withMore.overrides.length).toBeGreaterThan(1)
    const textOf = (given: EventModel): string =>
      serializeCalendarDocument({ version: 2, events: [eventFromModel(given, context)] })
    expect(textOf(reversed)).toBe(textOf(withMore))
  })

  /** Models nobody wrote by hand: every kind of time, with and without each optional part. */
  it('holds for generated models too', () => {
    let state = 0x2545f491
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
    const pad = (value: number): string => value.toString().padStart(2, '0')
    const day = (): string =>
      `20${pad(20 + Math.floor(next() * 12))}-${pad(1 + Math.floor(next() * 12))}-${pad(1 + Math.floor(next() * 28))}`
    const clock = (): string => `${pad(Math.floor(next() * 24))}:${pad(pick([0, 15, 30, 45]))}:00`
    const zones = ['Europe/Berlin', 'America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Pacific/Kiritimati']
    const times = (): { start: ModelTime; end?: ModelTime } => {
      const date = day()
      const kind = pick(['date', 'floating', 'utc', 'zoned'] as const)
      if (kind === 'date') {
        const days = Math.floor(next() * 5)
        const start: ModelTime = { kind, value: date }
        return days >= 2 ? { start, end: { kind, value: addDays(date, days) } } : { start }
      }
      const startClock = clock()
      const start: ModelTime =
        kind === 'zoned'
          ? { kind, value: `${date}T${startClock}`, zone: pick(zones) }
          : { kind, value: `${date}T${startClock}` }
      if (next() < 0.3) {
        return { start }
      }
      // An end on a later day is after the start in any zone.
      const endValue = `${addDays(date, 1 + Math.floor(next() * 3))}T${clock()}`
      if (kind === 'zoned' && next() < 0.3) {
        return {
          start,
          end: next() < 0.5 ? { kind: 'utc', value: endValue } : { kind: 'zoned', value: endValue, zone: pick(zones) },
        }
      }
      return { start, end: { ...start, value: endValue } }
    }
    const texts = (): Pick<EventModel, 'title' | 'description' | 'location' | 'clipped'> =>
      clipTexts({
        title: pick(['', 'Lunch', 'Ünïcödé 😀', 'x'.repeat(600)]),
        description: pick(['', 'Notes', 'y'.repeat(2500)]),
        location: pick(['', 'Room 4']),
      })

    let checked = 0
    const kindsSeen = new Set<string>()
    for (let round = 0; round < 400; round++) {
      const base = times()
      const series = next() < 0.5
      const inSeriesTerms = (): string => (base.start.kind === 'date' ? day() : `${day()}T${clock()}`)
      const model: EventModel = {
        uid: `generated-${round}`,
        ...texts(),
        status: pick(['', 'tentative', 'confirmed', 'cancelled'] as const),
        ...base,
        rule: series
          ? pick(['FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=MONTHLY;BYDAY=-1FR', 'FREQ=YEARLY;COUNT=3'])
          : '',
        exdates: series && next() < 0.5 ? [inSeriesTerms(), inSeriesTerms()].sort() : [],
        rdates: series && next() < 0.3 ? [inSeriesTerms()] : [],
        overrides: [],
        guests: next() < 0.3,
        alarm: next() < 0.3,
      }
      if (series && next() < 0.4) {
        const [first, second] = [inSeriesTerms(), inSeriesTerms()].sort()
        model.overrides = (first === second ? [first] : [first, second]).map((recurrenceId) => ({
          recurrenceId,
          ...texts(),
          status: pick(['', 'cancelled'] as const),
          ...times(),
        }))
      }
      model.exdates = [...new Set(model.exdates)]

      const reread = modelFromEvent(throughANote(eventFromModel(model, lisbon)), model.uid)
      expect(reread).toEqual(model)
      expect(fingerprintOfEvent(reread)).toBe(fingerprintOfEvent(model))
      kindsSeen.add(`${model.start.kind}/${model.end?.kind ?? 'none'}`)
      checked += 1
    }
    expect(checked).toBe(400)
    // The generator really did cover the ground: every kind of start, with and without an end, and a second zone.
    expect([...kindsSeen].sort()).toEqual([
      'date/date',
      'date/none',
      'floating/floating',
      'floating/none',
      'utc/none',
      'utc/utc',
      'zoned/none',
      'zoned/utc',
      'zoned/zoned',
    ])
  })
})

/** The date `days` after `date`, by UTC arithmetic kept apart from the code under test. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

describe('what a build that only knows version 1 is given', () => {
  it('gets the event under the id every device computes for it', () => {
    const { model, context } = fromCorpus('nextcloud: a weekly meeting with a reminder')
    expect(eventFromModel(model, context).id).toBe(localIdForUid('6f6f0c56-0b0e-4b3c-9a52-0f6a3f6d3f11'))
  })

  it('gets a timed event as instants, and its day on the event’s own calendar', () => {
    const { model, context } = fromCorpus('nextcloud: a weekly meeting with a reminder')
    // 09:00 in Berlin on 23 March 2026 is 08:00 UTC: winter time until the 29th.
    expect(eventFromModel(model, context)).toMatchObject({
      date: '2026-03-23',
      title: 'Stand-up',
      allDay: false,
      start: '2026-03-23T08:00:00.000Z',
      end: '2026-03-23T08:30:00.000Z',
      zone: 'Europe/Berlin',
      localStart: '2026-03-23T09:00:00',
      localEnd: '2026-03-23T09:30:00',
      localOf: [Date.UTC(2026, 2, 23, 8) / 1000, Date.UTC(2026, 2, 23, 8, 30) / 1000],
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      alarm: true,
    })
  })

  it('gets an all-day event as its first day, with its length beside it', () => {
    const { model, context } = fromCorpus('nextcloud: an all-day event of three days')
    const event = eventFromModel(model, context)
    expect(event).toEqual({
      id: localIdForUid(model.uid),
      date: '2026-06-10',
      title: 'Conference',
      days: 3,
      location: 'Porto',
      status: 'confirmed',
    })
  })

  it('gets "every N weeks" as the rule its own editor understands, and anything more as the long rule', () => {
    const plain = eventFromModel(fromCorpus('apple: a birthday, every year').model, lisbon)
    expect([plain.recurrence, plain.rrule]).toEqual([{ freq: 'yearly' }, undefined])
    const lastFriday = eventFromModel(fromCorpus('thunderbird: the last Friday of every month').model, lisbon)
    expect([lastFriday.recurrence, lastFriday.rrule]).toEqual([undefined, 'FREQ=MONTHLY;BYDAY=-1FR'])
    // A plain weekly rule with an occurrence changed is not a series that editor can hold.
    const changed = eventFromModel(fromCorpus('google: a series with one occurrence given another time').model, lisbon)
    expect([changed.recurrence, changed.rrule]).toEqual([undefined, 'FREQ=WEEKLY'])
    expect(changed.overrides).toHaveLength(1)
  })

  it('gives a time tied to no zone an instant in the zone fixed for the linked calendar, not the device’s', () => {
    const { model } = fromCorpus('thunderbird: a time tied to no zone')
    const inLisbon = eventFromModel(model, lisbon)
    const inTokyo = eventFromModel(model, { bindingZone: 'Asia/Tokyo', zones: platformZoneRules })
    // 10:00 in Lisbon in July is 09:00 UTC; 10:00 in Tokyo is 01:00 UTC.
    expect([inLisbon.start, inLisbon.zone, inLisbon.floating]).toEqual([
      '2026-07-04T09:00:00.000Z',
      'Europe/Lisbon',
      true,
    ])
    expect([inTokyo.start, inTokyo.zone, inTokyo.floating]).toEqual(['2026-07-04T01:00:00.000Z', 'Asia/Tokyo', true])
    // Which zone that is changes nothing about what the event says.
    expect(fingerprintOfEvent(modelFromEvent(inTokyo))).toBe(fingerprintOfEvent(modelFromEvent(inLisbon)))
  })

  it('gives a time in a zone only the entry defines the instant that definition gives', () => {
    const { model, context } = fromCorpus('outlook: a zone with a made-up name, known only by its embedded definition')
    // The definition says one hour ahead of UTC until the last Sunday of March.
    expect(eventFromModel(model, context)).toMatchObject({
      zone: 'Customized Time Zone',
      localStart: '2026-03-23T09:00:00',
      start: '2026-03-23T08:00:00.000Z',
      end: '2026-03-23T09:00:00.000Z',
    })
    // Without the definition the same wall time is still stored, and the model is still the same.
    const withoutRules = eventFromModel(model, lisbon)
    expect(withoutRules.start).toBe('2026-03-23T09:00:00.000Z')
    expect(modelFromEvent(throughANote(withoutRules), model.uid)).toEqual(model)
  })

  it('keeps an end for an event that starts at a wall time the clocks skip', () => {
    // 02:30 does not exist in Berlin on 29 March 2026 and is read as 03:30, which is after 03:00.
    const model: EventModel = {
      uid: 'gap',
      title: 'Night shift handover',
      description: '',
      location: '',
      clipped: '',
      status: '',
      start: { kind: 'zoned', value: '2026-03-29T02:30:00', zone: 'Europe/Berlin' },
      end: { kind: 'zoned', value: '2026-03-29T03:00:00', zone: 'Europe/Berlin' },
      rule: '',
      exdates: [],
      rdates: [],
      overrides: [],
      guests: false,
      alarm: false,
    }
    const event = eventFromModel(model, lisbon)
    expect(Date.parse(event.end ?? '')).toBeGreaterThan(Date.parse(event.start ?? ''))
    expect(modelFromEvent(throughANote(event), 'gap')).toEqual(model)
  })
})

describe('an event the version 1 editor made', () => {
  it('is modelled as its instants in UTC, on any device', () => {
    const legacy: CalendarEvent = {
      id: 'evt-1',
      date: '2026-06-10',
      title: 'Legacy',
      allDay: false,
      start: '2026-06-10T20:00:00.000Z',
      end: '2026-06-10T21:00:00.000Z',
      recurrence: { freq: 'weekly', interval: 2 },
    }
    expect(modelFromEvent(legacy, 'srn-evt-1')).toEqual({
      uid: 'srn-evt-1',
      title: 'Legacy',
      description: '',
      location: '',
      clipped: '',
      status: '',
      start: { kind: 'utc', value: '2026-06-10T20:00:00' },
      end: { kind: 'utc', value: '2026-06-10T21:00:00' },
      rule: 'FREQ=WEEKLY;INTERVAL=2',
      exdates: [],
      rdates: [],
      overrides: [],
      guests: false,
      alarm: false,
    })
  })

  it('is modelled as a day when it has no time', () => {
    expect(modelFromEvent({ id: 'evt-2', date: '2026-06-10', title: 'Day' }).start).toEqual({
      kind: 'date',
      value: '2026-06-10',
    })
  })
})
