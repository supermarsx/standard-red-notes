import {
  CALENDAR_DOCUMENT_VERSION,
  CalendarDocument,
  buildMonthGrid,
  createEmptyCalendarDocument,
  daysInMonth,
  firstWeekdayOfMonth,
  normalizeEventDate,
  parseCalendarDocument,
  serializeCalendarDocument,
  toIsoDate,
} from './CalendarDocument'

describe('CalendarDocument', () => {
  describe('createEmptyCalendarDocument', () => {
    it('creates a versioned empty document', () => {
      expect(createEmptyCalendarDocument()).toEqual({ version: CALENDAR_DOCUMENT_VERSION, events: [] })
    })
  })

  describe('serialize/parse round-trip', () => {
    it('round-trips a populated document without data loss', () => {
      const original: CalendarDocument = {
        version: CALENDAR_DOCUMENT_VERSION,
        events: [
          { id: 'a', date: '2026-06-20', title: 'Launch', color: '#ef4444' },
          { id: 'b', date: '2026-07-01', title: 'Review' },
        ],
      }
      const { document, recovered } = parseCalendarDocument(serializeCalendarDocument(original))
      expect(recovered).toBe(true)
      expect(document).toEqual(original)
    })

    it('keeps color undefined when absent', () => {
      const original = createEmptyCalendarDocument()
      original.events.push({ id: 'e1', date: '2026-01-01', title: 'New Year' })
      const { document } = parseCalendarDocument(serializeCalendarDocument(original))
      expect(document.events[0].color).toBeUndefined()
    })
  })

  describe('malformed and legacy input fallback', () => {
    it('returns an empty (recoverable) document for empty string', () => {
      const { document, recovered } = parseCalendarDocument('')
      expect(document).toEqual(createEmptyCalendarDocument())
      expect(recovered).toBe(true)
    })

    it('returns an empty document and flags non-recovery for invalid JSON', () => {
      const { document, recovered } = parseCalendarDocument('{not json}')
      expect(document).toEqual(createEmptyCalendarDocument())
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for legacy plain text', () => {
      const { document, recovered } = parseCalendarDocument('just a note')
      expect(document.events).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for a non-calendar object', () => {
      const { document, recovered } = parseCalendarDocument(JSON.stringify({ root: { children: [] } }))
      expect(document.events).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('never throws on null or undefined', () => {
      expect(() => parseCalendarDocument(null)).not.toThrow()
      expect(() => parseCalendarDocument(undefined)).not.toThrow()
    })
  })

  describe('event sanitization', () => {
    it('drops events without a valid id', () => {
      const { document } = parseCalendarDocument(
        JSON.stringify({ events: [{ date: '2026-06-20' }, { id: 'ok', date: '2026-06-21' }] }),
      )
      expect(document.events).toHaveLength(1)
      expect(document.events[0].id).toBe('ok')
    })

    it('drops events with an unparseable date', () => {
      const { document } = parseCalendarDocument(
        JSON.stringify({ events: [{ id: 'bad', date: 'not-a-date' }, { id: 'good', date: '2026-06-20' }] }),
      )
      expect(document.events).toHaveLength(1)
      expect(document.events[0].id).toBe('good')
    })

    it('de-duplicates events with the same id', () => {
      const { document } = parseCalendarDocument(
        JSON.stringify({
          events: [
            { id: 'dup', date: '2026-06-20', title: 'first' },
            { id: 'dup', date: '2026-06-21', title: 'second' },
          ],
        }),
      )
      expect(document.events).toHaveLength(1)
      expect(document.events[0].title).toBe('first')
    })

    it('coerces non-string title to empty string', () => {
      const { document } = parseCalendarDocument(JSON.stringify({ events: [{ id: 'a', date: '2026-06-20', title: 5 }] }))
      expect(document.events[0].title).toBe('')
    })
  })

  describe('normalizeEventDate', () => {
    it('passes through a plain YYYY-MM-DD', () => {
      expect(normalizeEventDate('2026-06-20')).toBe('2026-06-20')
    })

    it('reduces a full ISO timestamp to a date', () => {
      expect(normalizeEventDate('2026-06-20T15:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('rejects an out-of-range month/day', () => {
      expect(normalizeEventDate('2026-13-40')).toBeNull()
    })

    it('rejects non-strings and empty', () => {
      expect(normalizeEventDate(42)).toBeNull()
      expect(normalizeEventDate('')).toBeNull()
      expect(normalizeEventDate(null)).toBeNull()
    })
  })

  describe('month-grid math', () => {
    it('computes days in month including leap February', () => {
      expect(daysInMonth(2026, 0)).toBe(31) // Jan 2026
      expect(daysInMonth(2026, 1)).toBe(28) // Feb 2026 (non-leap)
      expect(daysInMonth(2024, 1)).toBe(29) // Feb 2024 (leap)
      expect(daysInMonth(2026, 3)).toBe(30) // Apr 2026
    })

    it('computes the first weekday of a month', () => {
      // June 1, 2026 is a Monday => index 1.
      expect(firstWeekdayOfMonth(2026, 5)).toBe(1)
      // January 1, 2026 is a Thursday => index 4.
      expect(firstWeekdayOfMonth(2026, 0)).toBe(4)
    })

    it('always builds a 42-cell rectangular grid', () => {
      expect(buildMonthGrid(2026, 5)).toHaveLength(42)
      expect(buildMonthGrid(2024, 1)).toHaveLength(42)
    })

    it('places the first in-month day at the correct leading offset', () => {
      const grid = buildMonthGrid(2026, 5) // June 2026, first weekday Monday (1)
      const firstInMonthIndex = grid.findIndex((cell) => cell.inMonth)
      expect(firstInMonthIndex).toBe(1)
      expect(grid[firstInMonthIndex].date).toBe('2026-06-01')
      expect(grid[firstInMonthIndex].day).toBe(1)
    })

    it('fills leading padding from the previous month', () => {
      const grid = buildMonthGrid(2026, 5) // June 2026
      // The single leading cell should be May 31, 2026.
      expect(grid[0].inMonth).toBe(false)
      expect(grid[0].date).toBe('2026-05-31')
    })

    it('wraps January back to the previous December for leading padding', () => {
      const grid = buildMonthGrid(2026, 0) // January 2026, first weekday Thursday (4)
      expect(grid[0].inMonth).toBe(false)
      // 4 leading cells from December 2025: 28, 29, 30, 31.
      expect(grid[0].date).toBe('2025-12-28')
      expect(grid[3].date).toBe('2025-12-31')
      expect(grid[4].date).toBe('2026-01-01')
    })

    it('wraps December forward to the next January for trailing padding', () => {
      const grid = buildMonthGrid(2026, 11) // December 2026
      const last = grid[grid.length - 1]
      expect(last.inMonth).toBe(false)
      expect(last.date.startsWith('2027-01')).toBe(true)
    })

    it('produces correct ISO dates via toIsoDate', () => {
      expect(toIsoDate(2026, 5, 1)).toBe('2026-06-01')
      expect(toIsoDate(2026, 0, 9)).toBe('2026-01-09')
    })
  })
})
