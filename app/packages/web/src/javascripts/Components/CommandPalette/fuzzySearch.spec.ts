import { fuzzyMatch, fuzzyRank, RankableItem } from './fuzzySearch'

describe('fuzzyMatch', () => {
  it('matches a contiguous substring', () => {
    const result = fuzzyMatch('note', 'New note')
    expect(result.matched).toBe(true)
    expect(result.ranges).toEqual([[4, 8]])
  })

  it('matches a case-insensitive subsequence', () => {
    const result = fuzzyMatch('np', 'New Pinned note')
    expect(result.matched).toBe(true)
    // first char of each of "New" and "Pinned"
    expect(result.ranges).toEqual([
      [0, 1],
      [4, 5],
    ])
  })

  it('merges adjacent matched characters into a single range', () => {
    const result = fuzzyMatch('arch', 'Archive note')
    expect(result.matched).toBe(true)
    expect(result.ranges).toEqual([[0, 4]])
  })

  it('returns no match when query characters are out of order', () => {
    expect(fuzzyMatch('ten', 'note').matched).toBe(false)
  })

  it('returns no match when query is longer than target', () => {
    expect(fuzzyMatch('archive', 'arc').matched).toBe(false)
  })

  it('treats an empty query as a neutral match', () => {
    const result = fuzzyMatch('', 'anything')
    expect(result.matched).toBe(true)
    expect(result.score).toBe(0)
    expect(result.ranges).toEqual([])
  })

  it('scores a prefix match higher than a mid-word match', () => {
    const prefix = fuzzyMatch('pre', 'Preferences')
    const midword = fuzzyMatch('pre', 'Open Spreadsheet')
    expect(prefix.matched).toBe(true)
    expect(midword.matched).toBe(true)
    expect(prefix.score).toBeGreaterThan(midword.score)
  })

  it('scores a word-boundary match higher than a scattered subsequence', () => {
    const boundary = fuzzyMatch('nn', 'New Note')
    const scattered = fuzzyMatch('nn', 'Antenna')
    expect(boundary.matched).toBe(true)
    expect(scattered.matched).toBe(true)
    expect(boundary.score).toBeGreaterThan(scattered.score)
  })

  it('scores a contiguous match higher than a scattered one for the same query', () => {
    const contiguous = fuzzyMatch('abc', 'abcdef')
    const scattered = fuzzyMatch('abc', 'axbxcx')
    expect(contiguous.score).toBeGreaterThan(scattered.score)
  })
})

describe('fuzzyRank', () => {
  const items: RankableItem[] = [
    { text: 'New note' },
    { text: 'New folder' },
    { text: 'Archive current note' },
    { text: 'Empty trash' },
    { text: 'Toggle dark mode', keywords: ['theme', 'appearance'] },
  ]

  it('returns only matching items, best first', () => {
    const ranked = fuzzyRank('new', items)
    expect(ranked.map((r) => r.item.text)).toEqual(['New note', 'New folder'])
  })

  it('ranks the closest match first', () => {
    const ranked = fuzzyRank('note', items)
    // "New note" ends in the query as a contiguous word; it should outrank the
    // longer "Archive current note".
    expect(ranked[0].item.text).toBe('New note')
    expect(ranked.map((r) => r.item.text)).toContain('Archive current note')
  })

  it('matches via keywords without producing highlight ranges', () => {
    const ranked = fuzzyRank('theme', items)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].item.text).toBe('Toggle dark mode')
    expect(ranked[0].ranges).toBeUndefined()
  })

  it('prefers a title match over a keyword match', () => {
    const withTitle: RankableItem[] = [
      { text: 'Appearance settings' },
      { text: 'Toggle dark mode', keywords: ['appearance'] },
    ]
    const ranked = fuzzyRank('appearance', withTitle)
    expect(ranked[0].item.text).toBe('Appearance settings')
    expect(ranked[0].ranges).toBeDefined()
  })

  it('returns every item with score 0 for an empty query', () => {
    const ranked = fuzzyRank('   ', items)
    expect(ranked).toHaveLength(items.length)
    expect(ranked.every((r) => r.score === 0)).toBe(true)
  })

  it('breaks score ties by length then alphabetically', () => {
    // Identical match position/quality (prefix match of the same length) so the
    // only differences are the tie-breakers: length, then alphabetical order.
    const tied: RankableItem[] = [{ text: 'abcd' }, { text: 'ab' }, { text: 'ac' }]
    const ranked = fuzzyRank('a', tied)
    expect(ranked.map((r) => r.item.text)).toEqual(['ab', 'ac', 'abcd'])
  })
})
