import {
  CalendarDocument,
  CalendarEvent,
  mergeCalendarDocuments,
  parseCalendarDocument,
  serializeCalendarDocument,
} from './CalendarDocument'

/**
 * A calendar note as a build newer than this one might have written it: keys
 * this build has never heard of at both levels, and entries of `events` it
 * cannot use (no id, not an object, an id that is already taken).
 */
const storedByANewerBuild = {
  version: 7,
  calendarColor: '#123456',
  linked: { account: 'a1', nested: [1, { deep: null }] },
  events: [
    {
      id: 'a',
      date: '2026-06-20',
      title: 'Known',
      geo: [38.72, -9.14],
      attachments: ['agenda.pdf'],
      history: [{ at: '2026-06-22', title: 'Moved' }],
    },
    { kind: 'a shape this build cannot read', when: 12 },
    {
      id: 'b',
      date: '2026-06-21',
      title: 'Second',
      color: '#ef4444',
      allDay: false,
      start: '2026-06-21T09:00:00.000Z',
      end: '2026-06-21T10:00:00.000Z',
      recurrence: { freq: 'weekly', interval: 2 },
      transparency: 'opaque',
    },
    'not an object at all',
    { id: 'a', date: '2026-06-25', title: 'An id that is already taken' },
    null,
  ],
}

const reparse = (document: CalendarDocument): unknown => JSON.parse(serializeCalendarDocument(document))

describe('a reader keeps what it does not understand', () => {
  const text = JSON.stringify(storedByANewerBuild)

  it('reads a note that really has unknown keys and unusable entries', () => {
    const { document, recovered } = parseCalendarDocument(text)
    expect(recovered).toBe(true)
    expect(document.events.map((event) => event.id)).toEqual(['a', 'b'])
    expect(Object.keys(document.unknownFields ?? {})).toEqual(['calendarColor', 'linked'])
    expect(Object.keys(document.events[0].unknownFields ?? {})).toEqual(['geo', 'attachments', 'history'])
    expect(Object.keys(document.events[1].unknownFields ?? {})).toEqual(['transparency'])
    expect(document.unrecognizedEntries?.map((entry) => entry.position)).toEqual([1, 3, 4, 5])
  })

  it('writes back everything that was stored when nothing was edited', () => {
    expect(reparse(parseCalendarDocument(text).document)).toStrictEqual(storedByANewerBuild)
  })

  it('serializes the same document to the same text every time', () => {
    const once = serializeCalendarDocument(parseCalendarDocument(text).document)
    expect(serializeCalendarDocument(parseCalendarDocument(once).document)).toBe(once)
  })

  it('keeps every unknown key and unusable entry through an edit of one event', () => {
    const { document } = parseCalendarDocument(text)
    const edited: CalendarDocument = {
      ...document,
      events: document.events.map((event) => (event.id === 'a' ? { ...event, title: 'Renamed' } : event)),
    }
    const expected = JSON.parse(text) as typeof storedByANewerBuild
    ;(expected.events[0] as { title: string }).title = 'Renamed'
    expect(reparse(edited)).toStrictEqual(expected)
  })

  it('keeps unknown keys and unusable entries when an event is added and another removed', () => {
    const { document } = parseCalendarDocument(text)
    const edited: CalendarDocument = {
      ...document,
      events: [...document.events.filter((event) => event.id !== 'b'), { id: 'c', date: '2026-07-01', title: 'New' }],
    }
    const stored = reparse(edited) as { events: unknown[]; calendarColor: string; linked: unknown }
    expect(stored.calendarColor).toBe('#123456')
    expect(stored.linked).toStrictEqual(storedByANewerBuild.linked)
    // Nothing unusable was dropped, and the event that was not touched kept its unknown keys.
    for (const position of [1, 3, 4, 5]) {
      expect(stored.events).toContainEqual(storedByANewerBuild.events[position])
    }
    expect(stored.events).toContainEqual(storedByANewerBuild.events[0])
    expect(stored.events).toContainEqual({ id: 'c', date: '2026-07-01', title: 'New' })
    expect(stored.events).toHaveLength(storedByANewerBuild.events.length)
  })

  it('keeps a stored key that is named __proto__', () => {
    const tricky =
      '{"version":1,"events":[{"id":"a","date":"2026-06-20","title":"t","__proto__":{"x":1}}],"__proto__":{"y":2}}'
    const { document } = parseCalendarDocument(tricky)
    expect(serializeCalendarDocument(document)).toBe(tricky)
    // And it stayed an ordinary own key: nothing inherited an `x` or a `y`.
    expect(({} as { x?: number }).x).toBeUndefined()
    expect((document.events[0] as unknown as { x?: number }).x).toBeUndefined()
    expect((document as unknown as { y?: number }).y).toBeUndefined()
  })

  it('never lets a carried key replace one this build owns', () => {
    const event: CalendarEvent = {
      id: 'a',
      date: '2026-06-20',
      title: 'Real',
      unknownFields: { title: 'Carried', id: 'other', extra: true },
    }
    const document: CalendarDocument = { version: 1, events: [event], unknownFields: { version: 99, events: [] } }
    expect(reparse(document)).toStrictEqual({
      version: 1,
      events: [{ id: 'a', date: '2026-06-20', title: 'Real', extra: true }],
    })
  })

  it('still validates the keys it does know', () => {
    const { document } = parseCalendarDocument(
      JSON.stringify({ version: 1, events: [{ id: 'a', date: '2026-06-20', title: 5, color: 7, unknown: 'kept' }] }),
    )
    expect(document.events[0]).toEqual({ id: 'a', date: '2026-06-20', title: '', unknownFields: { unknown: 'kept' } })
  })
})

describe('mergeCalendarDocuments', () => {
  const doc = (events: CalendarEvent[], rest: Partial<CalendarDocument> = {}): CalendarDocument => ({
    version: 1,
    events,
    ...rest,
  })
  const a: CalendarEvent = { id: 'a', date: '2026-06-20', title: 'A' }
  const b: CalendarEvent = { id: 'b', date: '2026-06-21', title: 'B', recurrence: { freq: 'weekly' } }
  const base = doc([a, b])

  it('takes their version when this side changed nothing', () => {
    const theirs = doc([{ ...a, title: 'A2' }, b, { id: 'c', date: '2026-06-22', title: 'C' }])
    expect(mergeCalendarDocuments(base, base, theirs)).toEqual(theirs)
  })

  it('keeps this side when they changed nothing', () => {
    const mine = doc([{ ...a, title: 'Mine' }, b])
    expect(mergeCalendarDocuments(base, mine, base)).toEqual(mine)
  })

  it('merges two changes to different keys of one event', () => {
    const mine = doc([{ ...a, title: 'Mine' }, b])
    const theirs = doc([{ ...a, date: '2026-07-01', color: '#10b981' }, b])
    expect(mergeCalendarDocuments(base, mine, theirs).events[0]).toEqual({
      id: 'a',
      date: '2026-07-01',
      title: 'Mine',
      color: '#10b981',
    })
  })

  it('lets this side win where both changed the same key', () => {
    const mine = doc([{ ...a, title: 'Mine' }, b])
    const theirs = doc([{ ...a, title: 'Theirs' }, b])
    expect(mergeCalendarDocuments(base, mine, theirs).events[0].title).toBe('Mine')
  })

  it('removes a key this side removed and they left alone', () => {
    const { recurrence: _removed, ...withoutRecurrence } = b
    const merged = mergeCalendarDocuments(base, doc([a, withoutRecurrence]), doc([a, { ...b, title: 'B2' }]))
    expect(merged.events[1]).toEqual({ id: 'b', date: '2026-06-21', title: 'B2' })
  })

  it('removes a key they removed and this side left alone', () => {
    const { recurrence: _removed, ...withoutRecurrence } = b
    const merged = mergeCalendarDocuments(base, doc([a, { ...b, title: 'Mine' }]), doc([a, withoutRecurrence]))
    expect(merged.events[1]).toEqual({ id: 'b', date: '2026-06-21', title: 'Mine' })
  })

  it('lets a deletion made here stand when they left the event as it was', () => {
    expect(mergeCalendarDocuments(base, doc([b]), base).events.map((event) => event.id)).toEqual(['b'])
  })

  it('keeps an event deleted here that they edited', () => {
    const theirs = doc([{ ...a, title: 'Edited there' }, b])
    expect(mergeCalendarDocuments(base, doc([b]), theirs).events).toEqual(theirs.events)
  })

  it('lets their deletion stand when this side left the event as it was', () => {
    expect(mergeCalendarDocuments(base, base, doc([b])).events.map((event) => event.id)).toEqual(['b'])
  })

  it('keeps an event they deleted that was edited here', () => {
    const edited = { ...a, title: 'Edited here' }
    expect(mergeCalendarDocuments(base, doc([edited, b]), doc([b])).events).toEqual([b, edited])
  })

  it('keeps additions from both sides, theirs first', () => {
    const mineOnly: CalendarEvent = { id: 'm', date: '2026-06-23', title: 'Mine' }
    const theirsOnly: CalendarEvent = { id: 't', date: '2026-06-24', title: 'Theirs' }
    const merged = mergeCalendarDocuments(base, doc([a, mineOnly, b]), doc([theirsOnly, a, b]))
    expect(merged.events.map((event) => event.id)).toEqual(['t', 'a', 'b', 'm'])
  })

  it('carries their unknown keys through an edit made here to the same event', () => {
    const theirs = doc([{ ...a, unknownFields: { geo: [35.68, 139.69] } }, b], {
      version: 3,
      unknownFields: { calendarColor: '#fff' },
      unrecognizedEntries: [{ position: 0, raw: { odd: true } }],
    })
    const merged = mergeCalendarDocuments(base, doc([{ ...a, title: 'Mine' }, b]), theirs)
    expect(merged.events[0]).toEqual({
      id: 'a',
      date: '2026-06-20',
      title: 'Mine',
      unknownFields: { geo: [35.68, 139.69] },
    })
    expect(merged.version).toBe(3)
    expect(merged.unknownFields).toEqual({ calendarColor: '#fff' })
    expect(merged.unrecognizedEntries).toEqual([{ position: 0, raw: { odd: true } }])
  })
})
