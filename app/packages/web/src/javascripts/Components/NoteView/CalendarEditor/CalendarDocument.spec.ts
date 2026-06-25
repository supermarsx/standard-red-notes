import {
  CalendarEvent,
  expandEventsForWindow,
  eventTimeOfDay,
  isTimedEvent,
  localIsoDateOf,
  normalizeEventDateTime,
  parseCalendarDocument,
  sanitizeRecurrence,
  serializeCalendarDocument,
} from './CalendarDocument'

const evt = (over: Partial<CalendarEvent> & { id: string; date: string }): CalendarEvent => ({
  title: '',
  ...over,
})

describe('normalizeEventDateTime', () => {
  it('parses full ISO datetimes to a canonical ISO string', () => {
    expect(normalizeEventDateTime('2026-06-20T09:30:00.000Z')).toBe('2026-06-20T09:30:00.000Z')
  })

  it('rejects bare dates (a date is not a datetime)', () => {
    expect(normalizeEventDateTime('2026-06-20')).toBeNull()
  })

  it('rejects junk and non-strings', () => {
    expect(normalizeEventDateTime('not-a-date')).toBeNull()
    expect(normalizeEventDateTime(42)).toBeNull()
    expect(normalizeEventDateTime('')).toBeNull()
  })
})

describe('sanitizeRecurrence', () => {
  it('accepts a valid frequency and clamps interval', () => {
    expect(sanitizeRecurrence({ freq: 'weekly' })).toEqual({ freq: 'weekly' })
    expect(sanitizeRecurrence({ freq: 'daily', interval: 3 })).toEqual({ freq: 'daily', interval: 3 })
    expect(sanitizeRecurrence({ freq: 'daily', interval: 1 })).toEqual({ freq: 'daily' })
  })

  it('drops a malformed interval but keeps the frequency', () => {
    expect(sanitizeRecurrence({ freq: 'monthly', interval: 0 })).toEqual({ freq: 'monthly' })
    expect(sanitizeRecurrence({ freq: 'monthly', interval: 'x' })).toEqual({ freq: 'monthly' })
  })

  it('returns undefined for bad input', () => {
    expect(sanitizeRecurrence({ freq: 'fortnightly' })).toBeUndefined()
    expect(sanitizeRecurrence(null)).toBeUndefined()
    expect(sanitizeRecurrence('weekly')).toBeUndefined()
  })
})

describe('backward-compatible normalization (parse)', () => {
  it('keeps a legacy day-only event working and treats it as all-day', () => {
    const text = JSON.stringify({ version: 1, events: [{ id: 'a', date: '2026-06-20', title: 'Legacy' }] })
    const { document, recovered } = parseCalendarDocument(text)
    expect(recovered).toBe(true)
    expect(document.events).toHaveLength(1)
    const e = document.events[0]
    expect(e.date).toBe('2026-06-20')
    expect(isTimedEvent(e)).toBe(false)
    expect(e.start).toBeUndefined()
  })

  it('round-trips a timed recurring event through serialize/parse', () => {
    const original = evt({
      id: 'x',
      date: '2026-06-20',
      title: 'Standup',
      allDay: false,
      start: '2026-06-20T09:00:00.000Z',
      end: '2026-06-20T09:15:00.000Z',
      recurrence: { freq: 'weekly', interval: 2 },
    })
    const { document } = parseCalendarDocument(serializeCalendarDocument({ version: 1, events: [original] }))
    expect(document.events[0]).toEqual(original)
  })

  it('does not crash on malformed events and drops the bad ones', () => {
    const text = JSON.stringify({
      version: 1,
      events: [
        { id: 'ok', date: '2026-06-20', title: 'Good' },
        { id: '', date: '2026-06-20' }, // empty id -> dropped
        { id: 'baddate', date: 'nonsense' }, // unparseable date -> dropped
        { date: '2026-06-21' }, // missing id -> dropped
        { id: 'badrec', date: '2026-06-22', recurrence: { freq: 'never' } }, // bad recurrence cleared
        'totally not an object',
      ],
    })
    const { document } = parseCalendarDocument(text)
    expect(document.events.map((e) => e.id)).toEqual(['ok', 'badrec'])
    expect(document.events.find((e) => e.id === 'badrec')?.recurrence).toBeUndefined()
  })

  it('treats a start with allDay !== false as still all-day, deriving the date', () => {
    const text = JSON.stringify({
      version: 1,
      events: [{ id: 't', start: '2026-06-20T15:00:00.000Z', title: 'No allDay flag' }],
    })
    const { document } = parseCalendarDocument(text)
    expect(document.events).toHaveLength(1)
    expect(isTimedEvent(document.events[0])).toBe(false)
    expect(document.events[0].date).toBe(localIsoDateOf('2026-06-20T15:00:00.000Z'))
  })
})

describe('eventTimeOfDay', () => {
  it('returns null for all-day events', () => {
    expect(eventTimeOfDay(evt({ id: 'a', date: '2026-06-20' }))).toBeNull()
  })

  it('returns local HH:MM for timed events', () => {
    const local = new Date(2026, 5, 20, 14, 5).toISOString()
    const e = evt({ id: 'a', date: '2026-06-20', allDay: false, start: local })
    expect(eventTimeOfDay(e)).toBe('14:05')
  })
})

describe('expandEventsForWindow', () => {
  // A simple two-week window so recurrence math is easy to reason about.
  const window: string[] = []
  for (let d = 1; d <= 14; d++) {
    window.push(`2026-06-${d.toString().padStart(2, '0')}`)
  }

  it('emits a single occurrence for a non-recurring event in the window', () => {
    const map = expandEventsForWindow([evt({ id: 'a', date: '2026-06-05', title: 'One' })], window)
    expect(map.get('2026-06-05')).toHaveLength(1)
    expect(map.get('2026-06-05')?.[0].allDay).toBe(true)
    expect(map.size).toBe(1)
  })

  it('omits a non-recurring event outside the window', () => {
    const map = expandEventsForWindow([evt({ id: 'a', date: '2026-07-01' })], window)
    expect(map.size).toBe(0)
  })

  it('expands a daily recurrence across every window day on/after the anchor', () => {
    const map = expandEventsForWindow([evt({ id: 'a', date: '2026-06-10', recurrence: { freq: 'daily' } })], window)
    // Days 10..14 inclusive => 5 occurrences; nothing before the anchor.
    expect(map.has('2026-06-09')).toBe(false)
    expect([...map.keys()].sort()).toEqual(['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'])
  })

  it('honors a daily interval', () => {
    const map = expandEventsForWindow(
      [evt({ id: 'a', date: '2026-06-02', recurrence: { freq: 'daily', interval: 3 } })],
      window,
    )
    // 2, 5, 8, 11, 14
    expect([...map.keys()].sort()).toEqual(['2026-06-02', '2026-06-05', '2026-06-08', '2026-06-11', '2026-06-14'])
  })

  it('expands a weekly recurrence only on the matching weekday', () => {
    const map = expandEventsForWindow([evt({ id: 'a', date: '2026-06-01', recurrence: { freq: 'weekly' } })], window)
    // 2026-06-01 and 2026-06-08 are the same weekday (Mon).
    expect([...map.keys()].sort()).toEqual(['2026-06-01', '2026-06-08'])
  })

  it('carries the time onto recurring occurrences', () => {
    const local = new Date(2026, 5, 1, 8, 30).toISOString()
    const map = expandEventsForWindow(
      [evt({ id: 'a', date: '2026-06-01', allDay: false, start: local, recurrence: { freq: 'weekly' } })],
      window,
    )
    expect(map.get('2026-06-08')?.[0].time).toBe('08:30')
    expect(map.get('2026-06-08')?.[0].allDay).toBe(false)
  })
})
