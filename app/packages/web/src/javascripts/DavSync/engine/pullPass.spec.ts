import {
  CalendarEvent,
  parseCalendarDocument,
  serializeCalendarDocument,
} from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { localIdForUid } from '../identity'
import { DavBinding } from '../state/bindings'
import { DAV_NOTE_BYTES_LIMIT, noteBytesOf } from '../state/noteSize'
import { DavNoteState } from '../state/noteState'
import { MemoryCalendar, refusal } from '../testing/MemoryCalendar'
import { CursorStore, NoteAccess, NoteProblem, PassOutcome, PullCursor, PullOptions, runPullPass } from './pullPass'

const COLLECTION = '/dav/calendars/bob/work/'
const NOW = Date.UTC(2026, 9, 13, 12)

const binding: DavBinding = {
  id: 'binding-1',
  accountId: 'account-1',
  accountLabel: 'bob @ cloud.example.org',
  kind: 'events',
  noteUuid: 'note-1',
  collectionPath: COLLECTION,
  collectionName: 'Work',
  direction: 'pull',
  intervalMinutes: 15,
  onConflict: 'keep-both',
  windowDaysBack: 30,
  windowMonthsAhead: 12,
  zone: 'Europe/Lisbon',
  cap: 1_000,
  enabled: true,
}

const ics = (uid: string, ...lines: string[]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SRN//spec//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T000000Z',
  ]
    .concat(lines, 'END:VEVENT', 'END:VCALENDAR', '')
    .join('\r\n')

const meeting = (uid: string, title: string, day = '20261020'): string =>
  ics(uid, `DTSTART;TZID=Europe/Berlin:${day}T090000`, `DTEND;TZID=Europe/Berlin:${day}T100000`, `SUMMARY:${title}`)

/** A linked note as a device holds it, with everything that was written to it. */
class FakeNote implements NoteAccess {
  text = serializeCalendarDocument({ version: 2, events: [] })
  state: unknown = undefined
  problem: NoteProblem | undefined
  writes = 0
  /** Called on every read, so that a test can change the note in the middle of a pass. */
  onRead: (() => void) | undefined

  read(): ReturnType<NoteAccess['read']> {
    this.onRead?.()
    return this.problem
      ? { ok: false, problem: this.problem }
      : { ok: true, note: { text: this.text, state: this.state } }
  }

  async write(text: string, state: DavNoteState): Promise<void> {
    this.text = text
    // What comes back from storage is a copy, not the object that was handed over.
    this.state = JSON.parse(JSON.stringify(state))
    this.writes += 1
  }

  get events(): CalendarEvent[] {
    return parseCalendarDocument(this.text).document.events
  }

  get titles(): string[] {
    return this.events.map((event) => event.title)
  }

  get records(): DavNoteState {
    return this.state as DavNoteState
  }
}

class FakeCursors implements CursorStore {
  readonly stored = new Map<string, PullCursor>()
  read(bindingId: string): PullCursor | undefined {
    return this.stored.get(bindingId)
  }
  write(bindingId: string, cursor: PullCursor): void {
    this.stored.set(bindingId, cursor)
  }
}

/** One device: its copy of the note and what it remembers. */
const device = (calendar: MemoryCalendar, note = new FakeNote()) => {
  const cursors = new FakeCursors()
  let now = NOW
  return {
    note,
    cursors,
    setNow: (ms: number) => {
      now = ms
    },
    pass: (options?: PullOptions, overrides: Partial<DavBinding> = {}): Promise<PassOutcome> =>
      runPullPass(
        { ...binding, ...overrides },
        { transport: calendar, note, cursor: cursors, now: () => now },
        options,
      ),
  }
}

const threeEvents = (): MemoryCalendar => {
  const calendar = new MemoryCalendar(COLLECTION)
  calendar.put('a.ics', meeting('uid-a', 'Alpha', '20261020'))
  calendar.put('b.ics', meeting('uid-b', 'Beta', '20261021'))
  calendar.put('c.ics', ics('uid-c', 'DTSTART;VALUE=DATE:20261019', 'SUMMARY:Gamma'))
  return calendar
}

const synced = (outcome: PassOutcome) => {
  if (outcome.kind !== 'synced') {
    throw new Error(`expected a synced pass, got ${JSON.stringify(outcome)}`)
  }
  return outcome
}

describe('a first import', () => {
  it('brings every entry into the note, in order of day and time, in one change', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)

    const outcome = synced(await pass())

    expect(outcome.counts).toEqual({ added: 3, changed: 0, removed: 0, unchanged: 0, unreadable: 0 })
    expect(outcome.wrote).toBe(true)
    expect(note.writes).toBe(1)
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(note.events.map((event) => event.id)).toEqual([
      localIdForUid('uid-c'),
      localIdForUid('uid-a'),
      localIdForUid('uid-b'),
    ])
    expect(note.events[1]).toMatchObject({
      date: '2026-10-20',
      allDay: false,
      zone: 'Europe/Berlin',
      localStart: '2026-10-20T09:00:00',
      // 09:00 in Berlin on 20 October is 07:00 UTC: summer time until the 25th.
      start: '2026-10-20T07:00:00.000Z',
    })
  })

  it('remembers each entry by its name on the server and by what was agreed', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    expect(note.records.binding).toBe('binding-1')
    expect(Object.keys(note.records.entries).sort()).toEqual(
      [localIdForUid('uid-a'), localIdForUid('uid-b'), localIdForUid('uid-c')].sort(),
    )
    expect(note.records.entries[localIdForUid('uid-a')].h).toBe('a.ics')
    expect(note.records.entries[localIdForUid('uid-a')].b).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('only ever reads from the server', async () => {
    const calendar = threeEvents()
    await device(calendar).pass()
    expect(new Set(calendar.sent.map((request) => request.method))).toEqual(new Set(['PROPFIND', 'REPORT']))
  })

  it('leaves alone the events the note already held that are not from the server', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    note.text = serializeCalendarDocument({
      version: 1,
      events: [{ id: 'evt-own', date: '2026-10-20', title: 'My own' }],
      unknownFields: { kept: true },
    })
    await pass()
    expect(note.titles).toEqual(['Gamma', 'My own', 'Alpha', 'Beta'])
    expect(parseCalendarDocument(note.text).document.unknownFields).toEqual({ kept: true })
    expect(note.records.entries['evt-own']).toBeUndefined()
  })
})

describe('the pass after a pass that converged', () => {
  it('asks one question, hears that nothing moved, and writes nothing', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    const requestsBefore = calendar.sent.length

    const outcome = synced(await pass())

    expect(outcome).toMatchObject({ wrote: false, skipped: true })
    expect(calendar.sent.length - requestsBefore).toBe(1)
    expect(note.writes).toBe(1)
  })

  it('writes nothing even when made to list and compare everything', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    const text = note.text

    const outcome = synced(await pass({ force: true }))

    expect(outcome).toMatchObject({ wrote: false, skipped: false })
    expect(outcome.counts).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 3, unreadable: 0 })
    expect(note.text).toBe(text)
    expect(calendar.count('REPORT calendar-multiget')).toBe(1)
  })

  it('lists again when the day has changed, because the window has moved', async () => {
    const calendar = threeEvents()
    const { pass, setNow } = device(calendar)
    await pass()
    setNow(NOW + 86_400_000)
    const outcome = synced(await pass())
    expect(outcome.skipped).toBe(false)
    expect(calendar.count('REPORT calendar-query')).toBe(2)
  })
})

describe('changes made on the server', () => {
  it('takes in an edit, an addition and a deletion, fetching only what changed', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    calendar.put('a.ics', meeting('uid-a', 'Alpha, renamed', '20261020'))
    calendar.put('d.ics', meeting('uid-d', 'Delta', '20261022'))
    calendar.remove('b.ics')

    const outcome = synced(await pass())

    expect(outcome.counts).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1, unreadable: 0 })
    expect(note.titles).toEqual(['Gamma', 'Alpha, renamed', 'Delta'])
    expect(note.writes).toBe(2)
    const lastFetch = calendar.sent.filter((request) => (request.body ?? '').includes('calendar-multiget')).pop()
    expect((lastFetch?.body ?? '').match(/<d:href>/g)).toHaveLength(2)
    expect(Object.keys(note.records.entries)).not.toContain(localIdForUid('uid-b'))

    expect(synced(await pass({ force: true })).wrote).toBe(false)
  })

  it('stops showing an entry that has moved out of the window, and never asks the server to change', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    calendar.outsideWindow.add('b.ics')

    synced(await pass({ force: true }))

    expect(note.titles).toEqual(['Gamma', 'Alpha'])
    expect(calendar.entries.has('b.ics')).toBe(true)
    expect(new Set(calendar.sent.map((request) => request.method))).toEqual(new Set(['PROPFIND', 'REPORT']))
  })

  it('treats an entry deleted between the listing and the fetch as not listed', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    calendar.intercept = (request) => {
      if ((request.body ?? '').includes('calendar-multiget')) {
        calendar.entries.delete('b.ics')
      }
    }
    const outcome = synced(await pass())
    expect(note.titles).toEqual(['Gamma', 'Alpha'])
    expect(outcome.counts.added).toBe(2)
    // It was asked about by name, and the server said it was not there.
    expect(calendar.count('PROPFIND entry')).toBe(1)
  })
})

describe('a second device', () => {
  it('writes the same note, byte for byte, from the same calendar', async () => {
    const calendar = threeEvents()
    const first = device(calendar)
    const second = device(calendar)
    await first.pass()
    await second.pass()
    expect(second.note.text).toBe(first.note.text)
    expect(JSON.stringify(second.note.state)).toBe(JSON.stringify(first.note.state))
  })

  it('that remembers nothing reads everything again and finds nothing to write', async () => {
    const calendar = threeEvents()
    const first = device(calendar)
    await first.pass()
    // The same note arrives on another device, which has never synced this calendar.
    const second = device(calendar, first.note)
    const writesBefore = first.note.writes

    const outcome = synced(await second.pass())

    expect(outcome.wrote).toBe(false)
    expect(outcome.counts.unchanged).toBe(3)
    expect(first.note.writes).toBe(writesBefore)
  })

  it('in another time zone computes the same note', async () => {
    const calendar = threeEvents()
    const here = device(calendar)
    await here.pass()
    // The binding's zone travels with the binding; nothing in a pass reads the device's own.
    const there = device(calendar)
    await there.pass()
    expect(there.note.text).toBe(here.note.text)
  })
})

describe('a note that no longer holds what was agreed', () => {
  it('gets back what an older build stripped from its events, with no duplicate', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    const complete = note.text
    // A build that predates version 2 and does not keep unknown keys saves the note.
    const stripped = parseCalendarDocument(complete).document.events.map((event) => {
      const kept: Record<string, unknown> = { id: event.id, date: event.date, title: event.title }
      for (const key of ['color', 'allDay', 'start', 'end', 'recurrence'] as const) {
        if (event[key] !== undefined) {
          kept[key] = event[key]
        }
      }
      return kept
    })
    note.text = JSON.stringify({ version: 2, events: stripped })
    expect(note.events[1].zone).toBeUndefined()

    const outcome = synced(await pass())

    expect(outcome.counts).toMatchObject({ changed: 2, removed: 0, added: 0 })
    expect(note.text).toBe(complete)
  })

  it('brings an entry in again that was removed from the note without being deleted', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    const complete = note.text
    const document = parseCalendarDocument(complete).document
    note.text = serializeCalendarDocument({
      ...document,
      events: document.events.filter((event) => event.title !== 'Beta'),
    })

    synced(await pass())

    expect(note.text).toBe(complete)
    expect(calendar.entries.has('b.ics')).toBe(true)
  })

  it('matches its events up again when the records are lost, instead of doubling them', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    const { text, state } = note
    note.state = undefined

    const outcome = synced(await pass())

    expect(note.text).toBe(text)
    expect(note.state).toEqual(state)
    expect(outcome.counts).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 3, unreadable: 0 })
  })

  it('ignores records that belong to another link', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    note.state = { v: 1, binding: 'some-other-binding', entries: { 'evt-own': { h: 'x.ics', b: 'B' } } }
    synced(await pass())
    expect(note.records.binding).toBe('binding-1')
    expect(note.records.entries['evt-own']).toBeUndefined()
  })
})

describe('an entry that cannot be read', () => {
  const withOneBroken = (): MemoryCalendar => {
    const calendar = threeEvents()
    calendar.put('broken.ics', ics('uid-broken', 'SUMMARY:No start at all'))
    return calendar
  }

  it('is reported, and every other entry is brought in', async () => {
    const calendar = withOneBroken()
    const { note, pass } = device(calendar)
    const outcome = synced(await pass())
    expect(outcome.unreadable).toEqual({ 'broken.ics': 'no-usable-start' })
    expect(outcome.counts).toMatchObject({ added: 3, unreadable: 1 })
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(note.records.unreadable).toEqual({ 'broken.ics': 'no-usable-start' })
  })

  it('is not fetched again until it changes on the server', async () => {
    const calendar = withOneBroken()
    const { pass } = device(calendar)
    await pass()
    const fetchesBefore = calendar.count('REPORT calendar-multiget')
    const outcome = synced(await pass({ force: true }))
    // It was listed again, and nothing at all was fetched.
    expect(outcome.skipped).toBe(false)
    expect(calendar.count('REPORT calendar-multiget')).toBe(fetchesBefore)
    expect(outcome.unreadable).toEqual({ 'broken.ics': 'no-usable-start' })
    expect(outcome.wrote).toBe(false)
  })

  it('is brought in once it has been repaired there', async () => {
    const calendar = withOneBroken()
    const { note, pass } = device(calendar)
    await pass()
    calendar.put('broken.ics', meeting('uid-broken', 'Repaired', '20261023'))
    const outcome = synced(await pass())
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta', 'Repaired'])
    expect(outcome.unreadable).toEqual({})
    expect(note.records.unreadable).toBeUndefined()
  })

  it('keeps the copy the note holds when the entry becomes unreadable later', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    const alpha = note.events.find((event) => event.title === 'Alpha')
    calendar.put('a.ics', 'this is no longer calendar data')

    const outcome = synced(await pass())

    expect(outcome.unreadable).toEqual({ 'a.ics': 'not-calendar-data' })
    expect(note.events.find((event) => event.title === 'Alpha')).toEqual(alpha)
    expect(note.records.entries[localIdForUid('uid-a')]).toBeDefined()
  })

  it('that the server lists but does not return is left as it is and asked for again next time', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    calendar.put('a.ics', meeting('uid-a', 'Alpha, renamed'))
    // The multiget leaves a.ics out although it exists.
    calendar.intercept = (request) => {
      if ((request.body ?? '').includes('calendar-multiget')) {
        return {
          kind: 'remote',
          remote: {
            status: 207,
            headers: {},
            body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>',
            bodyEncoding: 'utf8',
            path: request.path,
            redirects: 0,
          },
        }
      }
      return undefined
    }

    const outcome = synced(await pass())

    expect(outcome.unreadable).toEqual({ 'a.ics': 'not-in-answer' })
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])
    // That reason is this pass's alone, so it is not written into the note for other devices to inherit.
    expect(note.records.unreadable).toBeUndefined()

    calendar.intercept = undefined
    synced(await pass({ force: true }))
    expect(note.titles).toEqual(['Gamma', 'Alpha, renamed', 'Beta'])
  })
})

describe('limits and brakes', () => {
  it('refuses a window that holds more entries than the note may, and says how many', async () => {
    const calendar = threeEvents()
    const { note, cursors, pass } = device(calendar)
    const text = note.text
    const outcome = await pass(undefined, { cap: 2 })
    expect(outcome).toEqual({ kind: 'too-many', count: 3, cap: 2 })
    expect(note.text).toBe(text)
    expect(note.writes).toBe(0)
    expect(cursors.stored.size).toBe(0)
    expect(calendar.count('REPORT calendar-multiget')).toBe(0)
  })

  const tenThenThree = async () => {
    const calendar = new MemoryCalendar(COLLECTION)
    for (let index = 0; index < 10; index++) {
      calendar.put(`e${index}.ics`, meeting(`uid-${index}`, `Event ${index}`))
    }
    const { note, cursors, pass } = device(calendar)
    await pass()
    for (let index = 3; index < 10; index++) {
      calendar.remove(`e${index}.ics`)
    }
    return { calendar, note, cursors, pass }
  }

  it('stops before removing a large part of the calendar, and changes nothing', async () => {
    const { note, cursors, pass } = await tenThenThree()
    const text = note.text
    const cursorBefore = JSON.stringify(cursors.stored.get('binding-1'))

    const outcome = await pass()

    expect(outcome).toEqual({ kind: 'brake', brake: { kind: 'many-removals', removals: 7, held: 10 } })
    expect(note.text).toBe(text)
    expect(note.writes).toBe(1)
    expect(JSON.stringify(cursors.stored.get('binding-1'))).toBe(cursorBefore)
  })

  it('goes ahead once the person has said so, that once', async () => {
    const { note, pass } = await tenThenThree()
    const outcome = synced(await pass({ pastBrake: true }))
    expect(outcome.counts.removed).toBe(7)
    expect([...note.titles].sort()).toEqual(['Event 0', 'Event 1', 'Event 2'])
  })

  it('stops when the listing comes back empty for a calendar that was not', async () => {
    const { calendar, note, pass } = await tenThenThree()
    for (const name of [...calendar.entries.keys()]) {
      calendar.remove(name)
    }
    const outcome = await pass()
    expect(outcome).toEqual({ kind: 'brake', brake: { kind: 'empty-listing', removals: 10, held: 10 } })
    expect(note.events).toHaveLength(10)
  })
})

describe('when the relay or the server does not answer', () => {
  const failingAt = async (
    matches: (body: string, method: string) => boolean,
    result = refusal('dav-remote-timeout', 504),
  ) => {
    const calendar = threeEvents()
    const { note, cursors, pass } = device(calendar)
    await pass()
    calendar.put('a.ics', meeting('uid-a', 'Alpha, renamed'))
    calendar.remove('b.ics')
    const text = note.text
    const cursorBefore = JSON.stringify(cursors.stored.get('binding-1'))
    calendar.intercept = (request) => (matches(request.body ?? '', request.method) ? result : undefined)
    const outcome = await pass()
    return { calendar, note, cursors, pass, outcome, text, cursorBefore }
  }

  it.each([
    ['asking whether anything changed', (_body: string, method: string) => method === 'PROPFIND'],
    ['listing', (body: string) => body.includes('calendar-query')],
    ['fetching', (body: string) => body.includes('calendar-multiget')],
  ])('fails the pass and leaves the note and what it remembers untouched, when %s fails', async (_what, matches) => {
    const { note, cursors, outcome, text, cursorBefore } = await failingAt(matches)
    expect(outcome).toEqual({
      kind: 'failed',
      failure: { kind: 'refused', tag: 'dav-remote-timeout', message: 'dav-remote-timeout', extra: {} },
    })
    expect(note.text).toBe(text)
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(JSON.stringify(cursors.stored.get('binding-1'))).toBe(cursorBefore)
  })

  it('removes nothing when it runs out of budget part-way, and finishes on the next pass', async () => {
    // S23: the relay says "over budget" for the fetch. Nothing was learnt about the entries, so
    // nothing may be concluded about them, least of all that one is gone.
    const overBudget = refusal('dav-rate-limited', 429, { retryAfterSeconds: 120, budget: 'requests' })
    const { calendar, note, pass, outcome } = await failingAt((body) => body.includes('calendar-multiget'), overBudget)
    expect(outcome).toMatchObject({
      kind: 'failed',
      failure: { tag: 'dav-rate-limited', extra: { retryAfterSeconds: 120 } },
    })
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])

    calendar.intercept = undefined
    const next = synced(await pass())
    expect(next.counts).toMatchObject({ changed: 1, removed: 1 })
    expect(note.titles).toEqual(['Gamma', 'Alpha, renamed'])
  })

  it('does not take "the server itself could not be reached" for an answer either', async () => {
    const { note, outcome } = await failingAt(() => true, { kind: 'transport', httpStatus: null })
    expect(outcome).toEqual({ kind: 'failed', failure: { kind: 'transport', httpStatus: null } })
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('does not take an error status from the server for an empty calendar', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    await pass()
    calendar.intercept = (request) =>
      (request.body ?? '').includes('calendar-query')
        ? {
            kind: 'remote',
            remote: {
              status: 503,
              headers: { 'retry-after': '30' },
              body: '',
              bodyEncoding: 'utf8',
              path: request.path,
              redirects: 0,
            },
          }
        : undefined
    calendar.put('d.ics', meeting('uid-d', 'Delta'))
    const outcome = await pass()
    expect(outcome).toEqual({
      kind: 'failed',
      failure: { kind: 'remote-status', status: 503, path: COLLECTION, retryAfter: '30' },
    })
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])
  })
})

describe('a note that cannot be synced as it is', () => {
  it.each(['missing', 'trashed', 'protected', 'conflicted-copy'] as const)(
    'pauses without sending anything when the note is %s',
    async (problem) => {
      const calendar = threeEvents()
      const { note, pass } = device(calendar)
      note.problem = problem
      expect(await pass()).toEqual({ kind: 'paused', problem })
      expect(calendar.sent).toHaveLength(0)
    },
  )

  it('pauses when the note’s text is not a calendar, and does not overwrite it', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)
    note.text = 'Shopping list: eggs, flour'
    expect(await pass()).toEqual({ kind: 'paused', problem: 'not-a-calendar' })
    expect(note.text).toBe('Shopping list: eggs, flour')
    expect(calendar.sent).toHaveLength(0)
  })

  it('writes nothing when the note changed while the pass was working, and says to run again', async () => {
    const calendar = threeEvents()
    const { note, cursors, pass } = device(calendar)
    let reads = 0
    note.onRead = () => {
      reads += 1
      if (reads === 2) {
        // Someone else saves the note between the pass reading it and writing it.
        note.text = serializeCalendarDocument({
          version: 2,
          events: [{ id: 'evt-new', date: '2026-10-20', title: 'Typed meanwhile' }],
        })
      }
    }
    const outcome = await pass()
    expect(outcome).toEqual({ kind: 'interrupted' })
    expect(note.titles).toEqual(['Typed meanwhile'])
    expect(note.writes).toBe(0)
    expect(cursors.stored.size).toBe(0)

    note.onRead = undefined
    synced(await pass())
    expect(note.titles).toEqual(['Gamma', 'Typed meanwhile', 'Alpha', 'Beta'])
  })
})

describe('zones the platform has no name for', () => {
  const customized = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
    'BEGIN:VTIMEZONE',
    'TZID:Customized Time Zone',
    'BEGIN:STANDARD',
    'DTSTART:16010101T030000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010101T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:uid-foreign',
    'DTSTAMP:20261001T000000Z',
    'DTSTART;TZID=Customized Time Zone:20261110T090000',
    'DTEND;TZID=Customized Time Zone:20261110T100000',
    'SUMMARY:Site visit',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')

  it('keeps the definition with the note while an event uses it, and drops it when none does', async () => {
    const calendar = threeEvents()
    calendar.put('foreign.ics', customized)
    const { note, pass } = device(calendar)
    await pass()
    expect(Object.keys(note.records.zones ?? {})).toEqual(['Customized Time Zone'])
    const visit = note.events.find((event) => event.title === 'Site visit')
    // By the definition, one hour ahead of UTC in November.
    expect(visit).toMatchObject({ zone: 'Customized Time Zone', start: '2026-11-10T08:00:00.000Z' })

    calendar.remove('foreign.ics')
    await pass()
    expect(note.records.zones).toBeUndefined()
  })
})

describe('how large the note may get', () => {
  /** A note that holds `extra` bytes more than an empty one, in a field no build reads and every build keeps. */
  const paddedNote = (extra: number): FakeNote => {
    const note = new FakeNote()
    note.text = note.text.replace('{', `{"keptForAnotherBuild":"${'x'.repeat(extra)}",`)
    return note
  }

  /** The size the note has once the three entries are in it and it carried `extra` bytes before. */
  const sizeAfterImport = async (extra: number): Promise<number> => {
    const { pass } = device(threeEvents(), paddedNote(extra))
    return synced(await pass()).note.bytes
  }

  it('keeps the padding these cases are built on', async () => {
    const note = paddedNote(1_000)
    const { pass } = device(threeEvents(), note)
    const before = noteBytesOf(note.text, undefined)

    await pass()

    expect(note.text).toContain(`"keptForAnotherBuild":"${'x'.repeat(1_000)}"`)
    expect(before).toBeGreaterThan(1_000)
  })

  it('reports the size of the note a pass leaves, whether or not it wrote', async () => {
    const calendar = threeEvents()
    const { note, pass } = device(calendar)

    const first = synced(await pass())
    const again = synced(await pass({ force: true }))
    const skipped = synced(await pass())

    const size = { bytes: noteBytesOf(note.text, note.state), events: 3 }
    expect(first.note).toEqual(size)
    expect(again).toMatchObject({ wrote: false, skipped: false, note: size })
    expect(skipped).toMatchObject({ wrote: false, skipped: true, note: size })
    expect(size.bytes).toBeGreaterThan(noteBytesOf(note.text, undefined))
  })

  it('counts the events a person added themselves, which are part of the note too', async () => {
    const note = new FakeNote()
    note.text = serializeCalendarDocument({
      version: 2,
      events: [{ id: 'mine-1', date: '2026-10-22', title: 'My own' }],
    })
    const { pass } = device(threeEvents(), note)

    const outcome = synced(await pass())

    expect(outcome.note).toEqual({ bytes: noteBytesOf(note.text, note.state), events: 4 })
  })

  it('fills a note exactly to its bound', async () => {
    const room = DAV_NOTE_BYTES_LIMIT - (await sizeAfterImport(0))
    const note = paddedNote(room)
    const { pass } = device(threeEvents(), note)

    const outcome = synced(await pass())

    expect(outcome.note).toEqual({ bytes: DAV_NOTE_BYTES_LIMIT, events: 3 })
    expect(outcome.wrote).toBe(true)
    expect(note.titles).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('brings nothing in when the note would pass its bound by one byte, and says how large it would be', async () => {
    const room = DAV_NOTE_BYTES_LIMIT - (await sizeAfterImport(0))
    const note = paddedNote(room + 1)
    const textBefore = note.text
    const { cursors, pass } = device(threeEvents(), note)

    const outcome = await pass()

    expect(outcome).toEqual({
      kind: 'too-large',
      bytes: DAV_NOTE_BYTES_LIMIT + 1,
      limit: DAV_NOTE_BYTES_LIMIT,
      events: 3,
    })
    expect(note.writes).toBe(0)
    expect(note.text).toBe(textBefore)
    expect(note.state).toBeUndefined()
    // Nothing is remembered as seen, so the entries are asked for again once there is room.
    expect(cursors.stored.size).toBe(0)
  })

  it('brings the entries in once a shorter period leaves room', async () => {
    const room = DAV_NOTE_BYTES_LIMIT - (await sizeAfterImport(0))
    const calendar = threeEvents()
    const note = paddedNote(room + 1)
    const { pass } = device(calendar, note)
    expect((await pass()).kind).toBe('too-large')

    calendar.outsideWindow.add('b.ics')
    const outcome = synced(await pass())

    expect(note.titles).toEqual(['Gamma', 'Alpha'])
    expect(outcome.counts).toMatchObject({ added: 2 })
    expect(outcome.note.bytes).toBeLessThan(DAV_NOTE_BYTES_LIMIT)
  })

  describe('a note that is already past its bound', () => {
    /** Three entries imported, then the note grown past the bound by something that is not an entry. */
    const overfull = async () => {
      const calendar = threeEvents()
      const note = new FakeNote()
      const linked = device(calendar, note)
      synced(await linked.pass())
      note.text = note.text.replace('{', `{"keptForAnotherBuild":"${'x'.repeat(DAV_NOTE_BYTES_LIMIT)}",`)
      note.writes = 0
      return { calendar, ...linked }
    }

    it('says how large it is, and writes nothing when nothing changed', async () => {
      const { note, pass } = await overfull()

      const outcome = synced(await pass({ force: true }))

      expect(outcome.wrote).toBe(false)
      expect(note.writes).toBe(0)
      expect(outcome.note.bytes).toBe(noteBytesOf(note.text, note.state))
      expect(outcome.note.bytes).toBeGreaterThan(DAV_NOTE_BYTES_LIMIT)
    })

    it('may still get smaller: an entry deleted on the server leaves the note', async () => {
      const { calendar, note, pass } = await overfull()
      const before = noteBytesOf(note.text, note.state)
      calendar.remove('b.ics')

      const outcome = synced(await pass())

      expect(outcome.counts).toMatchObject({ removed: 1 })
      expect(note.titles).toEqual(['Gamma', 'Alpha'])
      expect(outcome.note.bytes).toBeLessThan(before)
      expect(outcome.note.bytes).toBeGreaterThan(DAV_NOTE_BYTES_LIMIT)
    })

    it('may still get smaller: an entry shortened on the server is shortened in the note', async () => {
      const { calendar, note, pass } = await overfull()
      calendar.put('b.ics', meeting('uid-b', 'B', '20261021'))

      const outcome = synced(await pass())

      expect(outcome.counts).toMatchObject({ changed: 1 })
      expect(note.titles).toEqual(['Gamma', 'Alpha', 'B'])
    })

    it('takes nothing that makes it larger, not even a longer title', async () => {
      const { calendar, note, pass } = await overfull()
      const textBefore = note.text
      const before = noteBytesOf(note.text, note.state)
      calendar.put('b.ics', meeting('uid-b', 'Beta!', '20261021'))

      const outcome = await pass()

      expect(outcome).toEqual({ kind: 'too-large', bytes: before + 1, limit: DAV_NOTE_BYTES_LIMIT, events: 3 })
      expect(note.writes).toBe(0)
      expect(note.text).toBe(textBefore)
    })

    it('takes a change that leaves it exactly as large', async () => {
      const { calendar, note, pass } = await overfull()
      const before = noteBytesOf(note.text, note.state)
      calendar.put('b.ics', meeting('uid-b', 'Bet4', '20261021'))

      const outcome = synced(await pass())

      expect(outcome.wrote).toBe(true)
      expect(outcome.note.bytes).toBe(before)
      expect(note.titles).toEqual(['Gamma', 'Alpha', 'Bet4'])
    })
  })
})

describe('a note another build wrote in its own way', () => {
  /** The same document with its keys in another order and spaced out, as a build is free to write it. */
  const respelled = (text: string): string => {
    const { version, events, ...rest } = JSON.parse(text) as Record<string, unknown>
    return JSON.stringify({ events, ...rest, version }, null, 2)
  }

  const imported = async () => {
    const calendar = threeEvents()
    const linked = device(calendar)
    synced(await linked.pass())
    linked.note.text = respelled(linked.note.text)
    linked.note.writes = 0
    return { calendar, ...linked }
  }

  it('is left byte for byte as it is by a pass that has nothing to bring', async () => {
    const { note, pass } = await imported()
    const textBefore = note.text

    const outcome = synced(await pass({ force: true }))

    expect(outcome.wrote).toBe(false)
    expect(note.writes).toBe(0)
    expect(note.text).toBe(textBefore)
    expect(outcome.note).toEqual({ bytes: noteBytesOf(textBefore, note.state), events: 3 })
  })

  it('keeps its text byte for byte when only what the note remembers changes', async () => {
    const { calendar, note, pass } = await imported()
    const textBefore = note.text
    // The entry becomes one that cannot be read: its copy stays, and the note records why.
    calendar.put('b.ics', ics('uid-b', 'SUMMARY:No start'))

    const outcome = synced(await pass())

    expect(outcome.wrote).toBe(true)
    expect(note.writes).toBe(1)
    expect(note.records.unreadable).toEqual({ 'b.ics': 'no-usable-start' })
    expect(note.text).toBe(textBefore)
  })

  it('is written in the one fixed way as soon as an entry goes in or out', async () => {
    const { calendar, note, pass } = await imported()
    calendar.remove('b.ics')

    synced(await pass())

    expect(note.text).toBe(serializeCalendarDocument(parseCalendarDocument(note.text).document))
    expect(note.titles).toEqual(['Gamma', 'Alpha'])
  })
})
