import { BaseSort, ColumnDef, Filter } from './BaseDocument'
import {
  applyFilters,
  applySort,
  BaseRow,
  computeVisibleRows,
  evaluateFilter,
  parseFrontmatterProperties,
} from './BaseRows'

const makeRow = (overrides: Partial<BaseRow> & { uuid: string }): BaseRow => ({
  uuid: overrides.uuid,
  title: overrides.title ?? '',
  createdAt: overrides.createdAt ?? new Date('2020-01-01T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2020-01-01T00:00:00Z'),
  tags: overrides.tags ?? [],
  folder: overrides.folder ?? '',
  wordCount: overrides.wordCount ?? 0,
  pinned: overrides.pinned ?? false,
  archived: overrides.archived ?? false,
  protected: overrides.protected ?? false,
  starred: overrides.starred ?? false,
  parsed: overrides.parsed ?? {},
})

describe('BaseRows', () => {
  describe('evaluateFilter / applyFilters', () => {
    const rows: BaseRow[] = [
      makeRow({ uuid: 'a', title: 'Todo: groceries', tags: ['errand'], pinned: true, wordCount: 12 }),
      makeRow({ uuid: 'b', title: 'Meeting notes', tags: ['work'], pinned: false, wordCount: 250 }),
      makeRow({ uuid: 'c', title: 'Todo: taxes', tags: ['finance'], pinned: false, wordCount: 0 }),
    ]

    it('filters by text contains (case-insensitive)', () => {
      const filter: Filter = { id: 'f', target: 'title', operator: 'contains', value: 'todo' }
      const result = applyFilters(rows, [filter]).map((r) => r.uuid)
      expect(result).toEqual(['a', 'c'])
    })

    it('filters by notContains', () => {
      const filter: Filter = { id: 'f', target: 'title', operator: 'notContains', value: 'todo' }
      expect(applyFilters(rows, [filter]).map((r) => r.uuid)).toEqual(['b'])
    })

    it('filters by equals against a list (tag membership)', () => {
      const filter: Filter = { id: 'f', target: 'tags', operator: 'contains', value: 'work' }
      expect(applyFilters(rows, [filter]).map((r) => r.uuid)).toEqual(['b'])
    })

    it('filters by boolean isTrue / isFalse', () => {
      expect(applyFilters(rows, [{ id: 'f', target: 'pinned', operator: 'isTrue' }]).map((r) => r.uuid)).toEqual(['a'])
      expect(applyFilters(rows, [{ id: 'f', target: 'pinned', operator: 'isFalse' }]).map((r) => r.uuid)).toEqual([
        'b',
        'c',
      ])
    })

    it('filters by isEmpty / isNotEmpty on a number-ish value', () => {
      expect(applyFilters(rows, [{ id: 'f', target: 'tags', operator: 'isEmpty' }]).map((r) => r.uuid)).toEqual([])
      const richTags = [makeRow({ uuid: 'x', tags: [] }), makeRow({ uuid: 'y', tags: ['z'] })]
      expect(applyFilters(richTags, [{ id: 'f', target: 'tags', operator: 'isEmpty' }]).map((r) => r.uuid)).toEqual([
        'x',
      ])
    })

    it('filters dates by before / after', () => {
      const dated: BaseRow[] = [
        makeRow({ uuid: 'old', updatedAt: new Date('2020-01-01T00:00:00Z') }),
        makeRow({ uuid: 'new', updatedAt: new Date('2022-06-15T00:00:00Z') }),
      ]
      const after: Filter = { id: 'f', target: 'updatedAt', operator: 'after', value: '2021-01-01' }
      expect(applyFilters(dated, [after]).map((r) => r.uuid)).toEqual(['new'])
      const before: Filter = { id: 'f', target: 'updatedAt', operator: 'before', value: '2021-01-01' }
      expect(applyFilters(dated, [before]).map((r) => r.uuid)).toEqual(['old'])
    })

    it('combines multiple filters with AND semantics', () => {
      const filters: Filter[] = [
        { id: 'f1', target: 'title', operator: 'contains', value: 'todo' },
        { id: 'f2', target: 'pinned', operator: 'isTrue' },
      ]
      expect(applyFilters(rows, filters).map((r) => r.uuid)).toEqual(['a'])
    })

    it('filters by a parsed property target', () => {
      const parsedRows: BaseRow[] = [
        makeRow({ uuid: 'a', parsed: { status: 'open' } }),
        makeRow({ uuid: 'b', parsed: { status: 'done' } }),
      ]
      const filter: Filter = { id: 'f', target: 'parsed:status', operator: 'equals', value: 'open' }
      expect(applyFilters(parsedRows, [filter]).map((r) => r.uuid)).toEqual(['a'])
    })

    it('evaluates a single filter directly', () => {
      const row = makeRow({ uuid: 'a', wordCount: 5 })
      expect(evaluateFilter(row, { id: 'f', target: 'wordCount', operator: 'equals', value: '5' })).toBe(true)
      expect(evaluateFilter(row, { id: 'f', target: 'wordCount', operator: 'equals', value: '6' })).toBe(false)
    })
  })

  describe('applySort', () => {
    const columns: ColumnDef[] = [
      { id: 'title', kind: 'builtin', property: 'title' },
      { id: 'wc', kind: 'builtin', property: 'wordCount' },
      { id: 'updated', kind: 'builtin', property: 'updatedAt' },
    ]
    const rows: BaseRow[] = [
      makeRow({ uuid: 'a', title: 'Banana', wordCount: 30, updatedAt: new Date('2021-03-01T00:00:00Z') }),
      makeRow({ uuid: 'b', title: 'apple', wordCount: 10, updatedAt: new Date('2022-01-01T00:00:00Z') }),
      makeRow({ uuid: 'c', title: 'Cherry', wordCount: 20, updatedAt: new Date('2020-12-31T00:00:00Z') }),
    ]

    it('sorts text ascending (case-insensitive)', () => {
      const sort: BaseSort = { columnId: 'title', dir: 'asc' }
      expect(applySort(rows, sort, columns).map((r) => r.uuid)).toEqual(['b', 'a', 'c'])
    })

    it('sorts numbers descending', () => {
      const sort: BaseSort = { columnId: 'wc', dir: 'desc' }
      expect(applySort(rows, sort, columns).map((r) => r.uuid)).toEqual(['a', 'c', 'b'])
    })

    it('sorts dates ascending', () => {
      const sort: BaseSort = { columnId: 'updated', dir: 'asc' }
      expect(applySort(rows, sort, columns).map((r) => r.uuid)).toEqual(['c', 'a', 'b'])
    })

    it('returns source order when columnId is unknown or undefined', () => {
      expect(applySort(rows, { columnId: 'gone', dir: 'asc' }, columns).map((r) => r.uuid)).toEqual(['a', 'b', 'c'])
      expect(applySort(rows, { dir: 'asc' }, columns).map((r) => r.uuid)).toEqual(['a', 'b', 'c'])
    })

    it('keeps empty values last regardless of direction', () => {
      const withEmpty: BaseRow[] = [
        makeRow({ uuid: 'empty', title: '' }),
        makeRow({ uuid: 'b', title: 'Beta' }),
        makeRow({ uuid: 'a', title: 'Alpha' }),
      ]
      const asc = applySort(withEmpty, { columnId: 'title', dir: 'asc' }, columns).map((r) => r.uuid)
      const desc = applySort(withEmpty, { columnId: 'title', dir: 'desc' }, columns).map((r) => r.uuid)
      expect(asc).toEqual(['a', 'b', 'empty'])
      expect(desc).toEqual(['b', 'a', 'empty'])
    })

    it('is stable for equal values', () => {
      const equalRows: BaseRow[] = [
        makeRow({ uuid: 'a', wordCount: 5 }),
        makeRow({ uuid: 'b', wordCount: 5 }),
        makeRow({ uuid: 'c', wordCount: 5 }),
      ]
      expect(applySort(equalRows, { columnId: 'wc', dir: 'asc' }, columns).map((r) => r.uuid)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('computeVisibleRows', () => {
    it('filters then sorts', () => {
      const columns: ColumnDef[] = [{ id: 'wc', kind: 'builtin', property: 'wordCount' }]
      const rows: BaseRow[] = [
        makeRow({ uuid: 'a', title: 'keep', wordCount: 30 }),
        makeRow({ uuid: 'b', title: 'drop', wordCount: 5 }),
        makeRow({ uuid: 'c', title: 'keep', wordCount: 10 }),
      ]
      const filters: Filter[] = [{ id: 'f', target: 'title', operator: 'equals', value: 'keep' }]
      const result = computeVisibleRows(rows, filters, { columnId: 'wc', dir: 'asc' }, columns)
      expect(result.map((r) => r.uuid)).toEqual(['c', 'a'])
    })
  })

  describe('parseFrontmatterProperties', () => {
    it('parses a YAML front-matter block', () => {
      const text = ['---', 'status: open', 'priority: high', '---', 'Body text here'].join('\n')
      expect(parseFrontmatterProperties(text)).toEqual({ status: 'open', priority: 'high' })
    })

    it('parses inline key:: value pairs anywhere', () => {
      const text = 'Some intro\nstatus:: done\nrating:: 5'
      expect(parseFrontmatterProperties(text)).toEqual({ status: 'done', rating: '5' })
    })

    it('lower-cases keys and keeps the first occurrence', () => {
      const text = 'Status:: open\nstatus:: closed'
      expect(parseFrontmatterProperties(text)).toEqual({ status: 'open' })
    })

    it('does not parse ordinary prose colons outside a front-matter block', () => {
      const text = 'This note is about: many things and ideas.'
      expect(parseFrontmatterProperties(text)).toEqual({})
    })

    it('returns an empty object for empty input and never throws', () => {
      expect(parseFrontmatterProperties('')).toEqual({})
      expect(() => parseFrontmatterProperties('')).not.toThrow()
    })
  })
})
