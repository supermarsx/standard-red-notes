import { escapeRegExp, getCachedRegex, IndexableNote, SearchIndex, tokenizeNormalized } from './SearchIndex'

const notes: IndexableNote[] = [
  { uuid: 'n1', title: 'Sourdough starter', text: 'Feed the starter with flour and water every day.' },
  { uuid: 'n2', title: 'Tax notes', text: 'Quarterly estimated tax is due in April. Keep receipts for deductions.' },
  { uuid: 'n3', title: 'Bread recipe', text: 'Mix flour, water, salt and the active sourdough starter.' },
  { uuid: 'n4', title: 'Empty', text: '' },
]

describe('tokenizeNormalized', () => {
  it('lowercases and keeps alphanumeric runs longer than one char', () => {
    expect(tokenizeNormalized('Hello, World! a 42')).toEqual(['hello', 'world', '42'])
  })

  it('memoizes: returns the same array reference for the same input', () => {
    const a = tokenizeNormalized('caching is nice')
    const b = tokenizeNormalized('caching is nice')
    expect(a).toBe(b)
  })

  it('returns an empty array for no tokens', () => {
    expect(tokenizeNormalized('!!! a')).toEqual([])
  })
})

describe('getCachedRegex / escapeRegExp', () => {
  it('returns the same compiled regex for the same pattern+flags', () => {
    const a = getCachedRegex('foo', 'gi')
    const b = getCachedRegex('foo', 'gi')
    expect(a).toBe(b)
  })

  it('resets lastIndex on cache hit so reuse is safe', () => {
    const re = getCachedRegex('a', 'g')
    re.exec('aaa')
    const again = getCachedRegex('a', 'g')
    expect(again.lastIndex).toBe(0)
  })

  it('escapes regex metacharacters', () => {
    const escaped = escapeRegExp('a.b*c(')
    expect(new RegExp(escaped).test('a.b*c(')).toBe(true)
    expect(new RegExp(escaped).test('axbxc(')).toBe(false)
  })
})

describe('SearchIndex', () => {
  const build = () => {
    const index = new SearchIndex()
    index.rebuild(notes)
    return index
  }

  it('returns null before it is built (substring fallback)', () => {
    const index = new SearchIndex()
    expect(index.search('flour')).toBeNull()
  })

  it('intersects posting lists: every query term must be present (AND)', () => {
    const index = build()
    // Both notes mention flour+water+starter -> n1 and n3.
    const result = index.search('flour water starter')
    expect(result).not.toBeNull()
    expect(new Set(result)).toEqual(new Set(['n1', 'n3']))
  })

  it('returns an empty array when a required term is absent', () => {
    const index = build()
    expect(index.search('flour nonexistentterm')).toEqual([])
  })

  it('returns null for a query with no indexable tokens', () => {
    const index = build()
    expect(index.search('!')).toBeNull()
  })

  it('ranks by BM25 relevance when rank is set', () => {
    const index = build()
    const ranked = index.search('sourdough starter', { rank: true })
    expect(ranked && ranked[0]).toBe('n1')
  })

  it('removes a note incrementally', () => {
    const index = build()
    index.remove('n1')
    const result = index.search('flour water starter')
    expect(new Set(result)).toEqual(new Set(['n3']))
  })

  it('adds/updates a note incrementally', () => {
    const index = build()
    index.addOrUpdate({ uuid: 'n5', title: 'New', text: 'flour water starter combined here' })
    const result = index.search('flour water starter')
    expect(new Set(result)).toEqual(new Set(['n1', 'n3', 'n5']))
  })

  it('coalesces a batch of updates via updateMany', () => {
    const index = build()
    index.updateMany([{ uuid: 'n6', title: 'Batch', text: 'flour water starter batch' }], ['n3'])
    const result = index.search('flour water starter')
    expect(new Set(result)).toEqual(new Set(['n1', 'n6']))
  })

  it('flush() drops the index so search falls back to null and rebuilds lazily', () => {
    const index = build()
    index.flush()
    expect(index.isBuilt).toBe(false)
    expect(index.search('flour')).toBeNull()
    index.ensureBuilt(() => notes)
    expect(index.isBuilt).toBe(true)
    expect(index.search('flour')).not.toBeNull()
  })

  it('invalidates cached query results across mutations (generation bump)', () => {
    const index = build()
    const first = index.search('flour water starter')
    expect(new Set(first)).toEqual(new Set(['n1', 'n3']))
    index.remove('n1')
    const second = index.search('flour water starter')
    expect(new Set(second)).toEqual(new Set(['n3']))
  })

  it('respects the limit option', () => {
    const index = build()
    const result = index.search('flour water starter', { limit: 1 })
    expect(result?.length).toBe(1)
  })
})
