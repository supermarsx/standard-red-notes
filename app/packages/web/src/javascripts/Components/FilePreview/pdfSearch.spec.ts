import {
  findMatchesAcrossPages,
  findMatchOffsetsInText,
  joinTextItems,
  PdfPageText,
  wrapMatchIndex,
} from './pdfSearch'

describe('pdfSearch', () => {
  describe('findMatchOffsetsInText', () => {
    it('returns empty for empty query', () => {
      expect(findMatchOffsetsInText('hello world', '')).toEqual([])
    })

    it('finds a single match offset', () => {
      expect(findMatchOffsetsInText('the quick brown fox', 'quick')).toEqual([4])
    })

    it('finds multiple non-overlapping matches', () => {
      // "ana" appears at 1 and (non-overlapping) 3 in "banana"
      expect(findMatchOffsetsInText('banana', 'ana')).toEqual([1])
      expect(findMatchOffsetsInText('aaaa', 'aa')).toEqual([0, 2])
    })

    it('is case-insensitive by default', () => {
      expect(findMatchOffsetsInText('Hello HELLO hello', 'hello')).toEqual([0, 6, 12])
    })

    it('respects match-case when requested', () => {
      expect(findMatchOffsetsInText('Hello HELLO hello', 'hello', true)).toEqual([12])
      expect(findMatchOffsetsInText('Hello HELLO hello', 'HELLO', true)).toEqual([6])
    })
  })

  describe('findMatchesAcrossPages', () => {
    const pages: PdfPageText[] = [
      { pageNumber: 1, text: 'alpha beta alpha' },
      { pageNumber: 2, text: 'gamma' },
      { pageNumber: 3, text: 'Alpha delta' },
    ]

    it('returns matches in document order across pages', () => {
      const matches = findMatchesAcrossPages(pages, 'alpha')
      expect(matches).toEqual([
        { pageNumber: 1, index: 0 },
        { pageNumber: 1, index: 11 },
        { pageNumber: 3, index: 0 },
      ])
    })

    it('respects match-case across pages', () => {
      const matches = findMatchesAcrossPages(pages, 'Alpha', true)
      expect(matches).toEqual([{ pageNumber: 3, index: 0 }])
    })

    it('trims whitespace-only queries to no matches', () => {
      expect(findMatchesAcrossPages(pages, '   ')).toEqual([])
    })

    it('returns empty when nothing matches', () => {
      expect(findMatchesAcrossPages(pages, 'zzz')).toEqual([])
    })
  })

  describe('wrapMatchIndex', () => {
    it('returns 0 when there are no matches', () => {
      expect(wrapMatchIndex(0, 1, 0)).toBe(0)
      expect(wrapMatchIndex(5, -1, 0)).toBe(0)
    })

    it('advances forward and wraps past the end', () => {
      expect(wrapMatchIndex(0, 1, 3)).toBe(1)
      expect(wrapMatchIndex(2, 1, 3)).toBe(0)
    })

    it('moves backward and wraps before the start', () => {
      expect(wrapMatchIndex(2, -1, 3)).toBe(1)
      expect(wrapMatchIndex(0, -1, 3)).toBe(2)
    })
  })

  describe('joinTextItems', () => {
    it('joins string items with spaces and ignores non-text markers', () => {
      const items = [{ str: 'foo' }, { type: 'beginMarkedContent' }, { str: 'bar' }]
      expect(joinTextItems(items)).toBe('foo  bar')
    })

    it('handles missing str gracefully', () => {
      expect(joinTextItems([{ str: undefined }, { str: 'x' }])).toBe(' x')
    })
  })
})
