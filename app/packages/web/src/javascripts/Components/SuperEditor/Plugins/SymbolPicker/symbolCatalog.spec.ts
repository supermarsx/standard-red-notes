/**
 * Data-integrity + filter tests for the symbol catalog. Pure, dependency-free.
 */
import { SYMBOL_CATALOG, filterSymbols } from './symbolCatalog'

describe('SYMBOL_CATALOG integrity', () => {
  it('has a non-empty name for every symbol', () => {
    for (const category of SYMBOL_CATALOG) {
      expect(category.name.length).toBeGreaterThan(0)
      for (const symbol of category.symbols) {
        expect(symbol.char.length).toBeGreaterThan(0)
        expect(symbol.name.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('has no duplicate char within a single category', () => {
    for (const category of SYMBOL_CATALOG) {
      const chars = category.symbols.map((symbol) => symbol.char)
      expect(new Set(chars).size).toBe(chars.length)
    }
  })

  it('curates a substantial set (~200+ symbols)', () => {
    const total = SYMBOL_CATALOG.reduce((sum, category) => sum + category.symbols.length, 0)
    expect(total).toBeGreaterThanOrEqual(200)
  })
})

describe('filterSymbols', () => {
  it('returns every category for an empty query', () => {
    expect(filterSymbols('')).toBe(SYMBOL_CATALOG)
    expect(filterSymbols('   ')).toBe(SYMBOL_CATALOG)
  })

  it('narrows to matching entries by name/keyword and drops empty categories', () => {
    const arrowResults = filterSymbols('arrow')
    expect(arrowResults.length).toBeGreaterThan(0)
    // Every returned category retains only matching symbols.
    for (const category of arrowResults) {
      expect(category.symbols.length).toBeGreaterThan(0)
      for (const symbol of category.symbols) {
        const haystack = [symbol.name, ...(symbol.keywords ?? [])].join(' ').toLowerCase()
        expect(haystack).toContain('arrow')
      }
    }
    // The Arrows category is present.
    expect(arrowResults.some((category) => category.name === 'Arrows')).toBe(true)
  })

  it('matches a specific keyword (omega -> Greek Omega)', () => {
    const results = filterSymbols('omega')
    const allChars = results.flatMap((category) => category.symbols.map((symbol) => symbol.char))
    expect(allChars).toContain('Ω')
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterSymbols('zzzznotasymbol')).toEqual([])
  })

  it('matches by the literal char', () => {
    const results = filterSymbols('©')
    const allChars = results.flatMap((category) => category.symbols.map((symbol) => symbol.char))
    expect(allChars).toContain('©')
  })
})
