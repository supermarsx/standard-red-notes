import { serializeCalendarDocument } from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { LargeNoteThreshold } from '@/Constants/Constants'
import { utf8Length } from '../hash/sha256'
import { EventModel, OverrideModel, clipTexts, fingerprintOfEvent } from '../model/eventModel'
import { eventFromModel } from '../model/eventNote'
import { platformZoneRules } from '../time/zoneRules'
import { DAV_DEFAULT_CAP, DAV_MAX_CAP } from './bindings'
import { DAV_NOTE_BYTES_LIMIT, DAV_NOTE_BYTES_NOTICE, noteBytesOf, noteSizeLevel } from './noteSize'
import { DavNoteState, storedNoteState } from './noteState'

/**
 * What a linked calendar costs, measured through the code that writes it.
 *
 * The calendars are generated, not real: three shapes of entry, each as the
 * real writer and the real serializer store it, with the record the note keeps
 * for it. The figures below were read off a run of this file on 2026-10-13 and
 * are held within a few per cent, so that a change which makes every stored
 * entry larger shows up here and is weighed against the bound, not found out
 * by a person whose calendar stopped fitting.
 *
 *   entries                    1,000        3,000        5,000
 *   plain (title and time)     404 KB       1.21 MB      2.02 MB
 *   ordinary mix               482 KB       1.41 MB      2.38 MB
 *   long descriptions          3.87 MB      11.9 MB      19.3 MB
 *
 * The item that is synced is larger than these by about two fifths (the text is
 * a string inside the note's JSON, then encrypted, then base64): an ordinary
 * calendar of 1,000 entries is about 680 KiB on the wire and one of 5,000 about
 * 3.3 MiB. That part is arithmetic, not a measurement of the real encryption.
 */

const context = { bindingZone: 'Europe/Lisbon', zones: platformZoneRules }

const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const WORDS =
  'review planning budget quarterly dentist school pickup flight to lisbon project sync with team lunch birthday call anniversary standup retro design workshop interview offsite deadline release training gym yoga doctor'.split(
    ' ',
  )

const sentence = (next: () => number, length: number): string => {
  let out = ''
  while (out.length < length) {
    out += (out.length > 0 ? ' ' : '') + WORDS[Math.floor(next() * WORDS.length)]
  }
  return out.slice(0, length)
}

const pad = (value: number): string => String(value).padStart(2, '0')

const dayOf = (ms: number): string => {
  const day = new Date(ms)
  return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`
}

/**
 * - `plain`: a title and an hour in a named zone. The least an entry can be.
 * - `ordinary`: a mix as a personal calendar has it. One in seven lasts all day, a quarter have a
 *   place, a fifth a description of a few lines, a tenth repeat weekly with a few occurrences
 *   moved or removed.
 * - `wordy`: a calendar of meeting invitations. Nine in ten carry a description longer than the
 *   note keeps, and three in ten repeat with three occurrences changed, each with its own copy.
 */
type Shape = 'plain' | 'ordinary' | 'wordy'

const WEEK = 7 * 86_400_000

const entry = (index: number, shape: Shape, next: () => number): EventModel => {
  const dayMs = Date.UTC(2026, 0, 1) + Math.floor(next() * 720) * 86_400_000
  const date = dayOf(dayMs)
  const hour = 7 + Math.floor(next() * 12)
  const allDay = shape !== 'plain' && next() < 0.15
  const title = sentence(next, 12 + Math.floor(next() * 28))
  const described = shape === 'wordy' ? next() < 0.9 : shape === 'ordinary' ? next() < 0.2 : false
  const placed = shape === 'wordy' ? next() < 0.7 : shape === 'ordinary' ? next() < 0.25 : false
  const texts = clipTexts({
    title,
    description: described ? sentence(next, shape === 'wordy' ? 2_600 : 80 + Math.floor(next() * 320)) : '',
    location: placed ? sentence(next, 20 + Math.floor(next() * 40)) : '',
  })
  const repeats = !allDay && (shape === 'wordy' ? next() < 0.3 : shape === 'ordinary' ? next() < 0.1 : false)
  const overrides: OverrideModel[] = []
  const exdates: string[] = []
  if (repeats) {
    const changed = shape === 'wordy' ? 3 : Math.floor(next() * 3)
    const removed = shape === 'wordy' ? 5 : Math.floor(next() * 4)
    for (let week = 1; week <= changed; week++) {
      const day = dayOf(dayMs + week * WEEK)
      overrides.push({
        ...texts,
        status: '',
        recurrenceId: `${day}T${pad(hour)}:00:00`,
        start: { kind: 'zoned', value: `${day}T${pad(hour + 1)}:00:00`, zone: 'Europe/Lisbon' },
        end: { kind: 'zoned', value: `${day}T${pad(hour + 2)}:00:00`, zone: 'Europe/Lisbon' },
      })
    }
    for (let week = 10; week < 10 + removed; week++) {
      exdates.push(`${dayOf(dayMs + week * WEEK)}T${pad(hour)}:00:00`)
    }
  }
  const model: EventModel = {
    uid: `${index.toString(16).padStart(8, '0')}-6a53-4f0e-9d0e-3b1a2c4d5e6f`,
    ...texts,
    status: '',
    start: allDay
      ? { kind: 'date', value: date }
      : { kind: 'zoned', value: `${date}T${pad(hour)}:00:00`, zone: 'Europe/Lisbon' },
    rule: repeats ? 'FREQ=WEEKLY' : '',
    exdates,
    rdates: [],
    overrides,
    guests: shape !== 'plain' && next() < 0.2,
    alarm: shape !== 'plain' && next() < 0.3,
  }
  if (!allDay) {
    model.end = { kind: 'zoned', value: `${date}T${pad(hour + 1)}:00:00`, zone: 'Europe/Lisbon' }
  }
  return model
}

/** A linked note that holds `count` entries of a shape: its text and the records beside it. */
const calendarOf = (count: number, shape: Shape): { text: string; state: DavNoteState } => {
  const next = random(count * 31 + shape.length)
  const state: DavNoteState = { v: 1, binding: 'b-0f8b2c1e6a53', entries: {} }
  const events = []
  for (let index = 0; index < count; index++) {
    const model = entry(index, shape, next)
    const event = eventFromModel(model, context)
    events.push(event)
    // The name Nextcloud's own calendar app gives an entry: its UID in upper case, and `.ics`.
    state.entries[event.id] = { h: `${model.uid.toUpperCase()}.ics`, b: fingerprintOfEvent(model) }
  }
  return { text: serializeCalendarDocument({ version: 2, events }), state: storedNoteState(state) }
}

/** Each calendar is generated once, however many cases ask how large it is. */
const measuredAlready = new Map<string, number>()

const bytesOf = (count: number, shape: Shape): number => {
  const key = `${shape}:${count}`
  let bytes = measuredAlready.get(key)
  if (bytes === undefined) {
    const { text, state } = calendarOf(count, shape)
    bytes = noteBytesOf(text, state)
    measuredAlready.set(key, bytes)
  }
  return bytes
}

/** Within `percent` of a figure read off a run. */
const near = (measured: number, percent = 4) => ({
  low: Math.floor(measured * (1 - percent / 100)),
  high: Math.ceil(measured * (1 + percent / 100)),
})

const expectNear = (bytes: number, measured: number) => {
  const { low, high } = near(measured)
  expect(bytes).toBeGreaterThanOrEqual(low)
  expect(bytes).toBeLessThanOrEqual(high)
}

describe('the measure', () => {
  it('counts the text and the records in UTF-8 bytes', () => {
    expect(noteBytesOf('', undefined)).toBe(0)
    expect(noteBytesOf('abc', undefined)).toBe(3)
    expect(noteBytesOf('é€😀', undefined)).toBe(2 + 3 + 4)
    expect(noteBytesOf('abc', { v: 1 })).toBe(3 + '{"v":1}'.length)
    expect(noteBytesOf('', { title: 'é' })).toBe('{"title":""}'.length + 2)
  })

  it('counts what the generated calendars are made of', () => {
    const { text, state } = calendarOf(10, 'ordinary')

    expect(noteBytesOf(text, state)).toBe(utf8Length(text) + utf8Length(JSON.stringify(state)))
    expect(Object.keys(state.entries)).toHaveLength(10)
  })
})

describe('the bound', () => {
  it('is not past the line where the app itself calls a note large', () => {
    expect(DAV_NOTE_BYTES_LIMIT).toBeLessThanOrEqual(LargeNoteThreshold)
  })

  it('gives notice with a third of the room still left', () => {
    expect(DAV_NOTE_BYTES_NOTICE).toBeLessThanOrEqual((DAV_NOTE_BYTES_LIMIT * 2) / 3)
    expect(DAV_NOTE_BYTES_NOTICE).toBeGreaterThan(DAV_NOTE_BYTES_LIMIT / 2)
  })

  it('names three levels, and each line belongs to the level below it', () => {
    expect(noteSizeLevel(0)).toBe('fine')
    expect(noteSizeLevel(DAV_NOTE_BYTES_NOTICE)).toBe('fine')
    expect(noteSizeLevel(DAV_NOTE_BYTES_NOTICE + 1)).toBe('large')
    expect(noteSizeLevel(DAV_NOTE_BYTES_LIMIT)).toBe('large')
    expect(noteSizeLevel(DAV_NOTE_BYTES_LIMIT + 1)).toBe('full')
  })
})

describe('what a linked calendar costs', () => {
  it.each<[Shape, number, number]>([
    ['plain', 1_000, 403_732],
    ['plain', 3_000, 1_210_974],
    ['plain', 5_000, 2_017_588],
    ['ordinary', 1_000, 481_878],
    ['ordinary', 3_000, 1_410_707],
    ['ordinary', 5_000, 2_381_132],
    ['wordy', 1_000, 3_872_094],
    ['wordy', 3_000, 11_904_909],
    ['wordy', 5_000, 19_263_296],
  ])('a calendar of %s entries, %i of them, is within a few per cent of %i bytes', (shape, count, measured) => {
    expectNear(bytesOf(count, shape), measured)
  })

  it('grows in step with the number of entries', () => {
    const [one, three] = [bytesOf(1_000, 'ordinary'), bytesOf(3_000, 'ordinary')]

    expect(three / one).toBeGreaterThan(2.8)
    expect(three / one).toBeLessThan(3.2)
  })

  it('is a quarter of that again for the records the note keeps', () => {
    const { text, state } = calendarOf(1_000, 'ordinary')

    expectNear(utf8Length(JSON.stringify(state)), 105_046)
    expectNear(utf8Length(text), 376_832)
  })
})

describe('the bound against the count of entries', () => {
  it('leaves an ordinary calendar at the default count with more than half the room', () => {
    const bytes = bytesOf(DAV_DEFAULT_CAP, 'ordinary')

    expect(bytes).toBeLessThan(DAV_NOTE_BYTES_LIMIT / 2)
    expect(noteSizeLevel(bytes)).toBe('fine')
  })

  it('still holds an ordinary calendar at the highest count, with notice given', () => {
    const bytes = bytesOf(DAV_MAX_CAP, 'ordinary')

    expect(bytes).toBeLessThanOrEqual(DAV_NOTE_BYTES_LIMIT)
    expect(noteSizeLevel(bytes)).toBe('large')
  })

  it('does not hold an ordinary calendar of 5,000 entries, nor a plain one', () => {
    expect(noteSizeLevel(bytesOf(5_000, 'ordinary'))).toBe('full')
    expect(noteSizeLevel(bytesOf(5_000, 'plain'))).toBe('full')
  })

  it('is what stops a calendar of long descriptions, which the count would have let through', () => {
    expect(bytesOf(DAV_DEFAULT_CAP, 'wordy')).toBeGreaterThan(2 * DAV_NOTE_BYTES_LIMIT)
    expect(noteSizeLevel(bytesOf(200, 'wordy'))).toBe('fine')
    expect(noteSizeLevel(bytesOf(500, 'wordy'))).toBe('full')
  })
})
