import {
  TIMELINE_DOCUMENT_VERSION,
  TimelineDocument,
  TimelineItem,
  computeTimelineLayout,
  createEmptyTimelineDocument,
  normalizeTimelineDate,
  parseTimelineDocument,
  serializeTimelineDocument,
} from './TimelineDocument'

const item = (overrides: Partial<TimelineItem> & { id: string }): TimelineItem => ({
  label: '',
  start: '2026-01-01',
  end: '2026-01-01',
  ...overrides,
})

describe('TimelineDocument', () => {
  describe('createEmptyTimelineDocument', () => {
    it('creates a versioned empty document', () => {
      expect(createEmptyTimelineDocument()).toEqual({ version: TIMELINE_DOCUMENT_VERSION, title: '', items: [] })
    })
  })

  describe('serialize/parse round-trip', () => {
    it('round-trips a populated document without data loss', () => {
      const original: TimelineDocument = {
        version: TIMELINE_DOCUMENT_VERSION,
        title: 'Roadmap',
        items: [
          { id: 'a', label: 'Design', start: '2026-01-01', end: '2026-01-31', color: '#3b82f6' },
          { id: 'b', label: 'Build', start: '2026-02-01', end: '2026-03-15' },
        ],
      }
      const { document, recovered } = parseTimelineDocument(serializeTimelineDocument(original))
      expect(recovered).toBe(true)
      expect(document).toEqual(original)
    })

    it('keeps color undefined when absent', () => {
      const original = createEmptyTimelineDocument()
      original.items.push(item({ id: 'i1', label: 'x' }))
      const { document } = parseTimelineDocument(serializeTimelineDocument(original))
      expect(document.items[0].color).toBeUndefined()
    })
  })

  describe('malformed and legacy input fallback', () => {
    it('returns an empty (recoverable) document for empty string', () => {
      const { document, recovered } = parseTimelineDocument('')
      expect(document).toEqual(createEmptyTimelineDocument())
      expect(recovered).toBe(true)
    })

    it('returns an empty document and flags non-recovery for invalid JSON', () => {
      const { document, recovered } = parseTimelineDocument('{bad}')
      expect(document).toEqual(createEmptyTimelineDocument())
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for legacy plain text', () => {
      const { document, recovered } = parseTimelineDocument('a plain note')
      expect(document.items).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for a non-timeline object', () => {
      const { document, recovered } = parseTimelineDocument(JSON.stringify({ root: { children: [] } }))
      expect(document.items).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('never throws on null or undefined', () => {
      expect(() => parseTimelineDocument(null)).not.toThrow()
      expect(() => parseTimelineDocument(undefined)).not.toThrow()
    })
  })

  describe('item sanitization', () => {
    it('drops items without a valid id', () => {
      const { document } = parseTimelineDocument(
        JSON.stringify({ items: [{ start: '2026-01-01' }, { id: 'ok', start: '2026-01-01' }] }),
      )
      expect(document.items).toHaveLength(1)
      expect(document.items[0].id).toBe('ok')
    })

    it('drops items with an unparseable start', () => {
      const { document } = parseTimelineDocument(
        JSON.stringify({ items: [{ id: 'bad', start: 'nope' }, { id: 'good', start: '2026-01-01' }] }),
      )
      expect(document.items).toHaveLength(1)
      expect(document.items[0].id).toBe('good')
    })

    it('defaults a missing end to the start', () => {
      const { document } = parseTimelineDocument(JSON.stringify({ items: [{ id: 'a', start: '2026-01-05' }] }))
      expect(document.items[0].end).toBe('2026-01-05')
    })

    it('swaps reversed start/end so start <= end', () => {
      const { document } = parseTimelineDocument(
        JSON.stringify({ items: [{ id: 'a', start: '2026-03-01', end: '2026-01-01' }] }),
      )
      expect(document.items[0].start).toBe('2026-01-01')
      expect(document.items[0].end).toBe('2026-03-01')
    })

    it('de-duplicates items by id', () => {
      const { document } = parseTimelineDocument(
        JSON.stringify({
          items: [
            { id: 'dup', label: 'first', start: '2026-01-01' },
            { id: 'dup', label: 'second', start: '2026-02-01' },
          ],
        }),
      )
      expect(document.items).toHaveLength(1)
      expect(document.items[0].label).toBe('first')
    })
  })

  describe('normalizeTimelineDate', () => {
    it('passes through a plain YYYY-MM-DD', () => {
      expect(normalizeTimelineDate('2026-06-20')).toBe('2026-06-20')
    })

    it('rejects out-of-range and non-strings', () => {
      expect(normalizeTimelineDate('2026-00-10')).toBeNull()
      expect(normalizeTimelineDate(5)).toBeNull()
      expect(normalizeTimelineDate('')).toBeNull()
    })
  })

  describe('computeTimelineLayout', () => {
    it('returns an empty layout for no items', () => {
      const layout = computeTimelineLayout([])
      expect(layout).toEqual({ minDate: null, maxDate: null, spanDays: 0, bars: [] })
    })

    it('computes min/max span across items', () => {
      const layout = computeTimelineLayout([
        item({ id: 'a', start: '2026-01-01', end: '2026-01-10' }),
        item({ id: 'b', start: '2026-01-05', end: '2026-01-20' }),
      ])
      expect(layout.minDate).toBe('2026-01-01')
      expect(layout.maxDate).toBe('2026-01-20')
      expect(layout.spanDays).toBe(19)
    })

    it('positions the first item at offset 0', () => {
      const layout = computeTimelineLayout([
        item({ id: 'a', start: '2026-01-01', end: '2026-01-11' }),
        item({ id: 'b', start: '2026-01-21', end: '2026-01-21' }),
      ])
      const a = layout.bars.find((bar) => bar.id === 'a')!
      expect(a.offset).toBe(0)
      // span = 20 days; A is 10 days => width 0.5.
      expect(a.width).toBeCloseTo(0.5, 5)
    })

    it('positions a later item proportionally to its start', () => {
      const layout = computeTimelineLayout([
        item({ id: 'a', start: '2026-01-01', end: '2026-01-01' }),
        item({ id: 'b', start: '2026-01-11', end: '2026-01-21' }),
      ])
      // span = 20 days. B starts at day 10 => offset 0.5.
      const b = layout.bars.find((bar) => bar.id === 'b')!
      expect(b.offset).toBeCloseTo(0.5, 5)
      // B is 10 days => width 0.5; clamped so offset+width <= 1.
      expect(b.offset + b.width).toBeLessThanOrEqual(1.0000001)
    })

    it('gives a same-day item a minimum visible width', () => {
      const layout = computeTimelineLayout([
        item({ id: 'a', start: '2026-01-01', end: '2026-01-01' }),
        item({ id: 'b', start: '2026-01-11', end: '2026-01-11' }),
      ])
      const a = layout.bars.find((bar) => bar.id === 'a')!
      // span = 10 days; one day minimum => width 0.1.
      expect(a.width).toBeCloseTo(0.1, 5)
    })

    it('clamps span to at least 1 day for a single same-day item', () => {
      const layout = computeTimelineLayout([item({ id: 'a', start: '2026-01-01', end: '2026-01-01' })])
      expect(layout.spanDays).toBe(1)
      const a = layout.bars[0]
      expect(a.offset).toBe(0)
      expect(a.width).toBe(1)
    })

    it('never lets offset + width exceed 1', () => {
      const layout = computeTimelineLayout([
        item({ id: 'a', start: '2026-01-01', end: '2026-01-30' }),
        item({ id: 'b', start: '2026-01-29', end: '2026-01-30' }),
      ])
      for (const bar of layout.bars) {
        expect(bar.offset + bar.width).toBeLessThanOrEqual(1.0000001)
      }
    })
  })
})
