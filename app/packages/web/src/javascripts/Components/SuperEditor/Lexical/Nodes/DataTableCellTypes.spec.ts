import {
  compareCellValues,
  detectColumnType,
  formatCellValue,
  numericValue,
  parseBooleanValue,
  parseCurrencyValue,
  parseDateValue,
  parseNumberValue,
} from './DataTableCellTypes'

describe('parseNumberValue', () => {
  it('parses plain, signed, decimal, grouped and scientific numbers', () => {
    expect(parseNumberValue('42')).toBe(42)
    expect(parseNumberValue('-3.5')).toBe(-3.5)
    expect(parseNumberValue('1,234.56')).toBeCloseTo(1234.56)
    expect(parseNumberValue('.5')).toBe(0.5)
    expect(parseNumberValue('1e3')).toBe(1000)
  })

  it('rejects empty, currency, and non-numeric strings', () => {
    expect(parseNumberValue('')).toBeNull()
    expect(parseNumberValue('   ')).toBeNull()
    expect(parseNumberValue('$5')).toBeNull()
    expect(parseNumberValue('abc')).toBeNull()
    expect(parseNumberValue('5px')).toBeNull()
  })
})

describe('parseCurrencyValue', () => {
  it('parses prefix and suffix symbols, grouping, and parenthesized negatives', () => {
    expect(parseCurrencyValue('$1,234.50')).toEqual({ value: 1234.5, symbol: '$' })
    expect(parseCurrencyValue('1.234,00 €'.replace('.', '').replace(',', '.'))).toEqual({ value: 1234, symbol: '€' })
    expect(parseCurrencyValue('£10')).toEqual({ value: 10, symbol: '£' })
    expect(parseCurrencyValue('($5.00)')).toEqual({ value: -5, symbol: '$' })
    expect(parseCurrencyValue('R$50')).toEqual({ value: 50, symbol: 'R$' })
  })

  it('returns null without a currency symbol or number', () => {
    expect(parseCurrencyValue('100')).toBeNull()
    expect(parseCurrencyValue('$')).toBeNull()
    expect(parseCurrencyValue('')).toBeNull()
  })
})

describe('parseDateValue', () => {
  it('parses ISO, slash, and month-name dates', () => {
    expect(parseDateValue('2024-02-29')).toBeInstanceOf(Date)
    expect(parseDateValue('3/15/2024')).toBeInstanceOf(Date)
    expect(parseDateValue('Jan 5, 2023')).toBeInstanceOf(Date)
  })

  it('does NOT treat bare numbers as dates', () => {
    expect(parseDateValue('2024')).toBeNull()
    expect(parseDateValue('42')).toBeNull()
    expect(parseDateValue('3.14')).toBeNull()
  })

  it('returns null for unparseable or empty input', () => {
    expect(parseDateValue('')).toBeNull()
    expect(parseDateValue('not a date')).toBeNull()
    expect(parseDateValue('2024-99-99')).toBeNull()
  })
})

describe('parseBooleanValue', () => {
  it('parses true/false/yes/no case-insensitively', () => {
    expect(parseBooleanValue('TRUE')).toBe(true)
    expect(parseBooleanValue('No')).toBe(false)
    expect(parseBooleanValue('yes')).toBe(true)
  })

  it('does not treat 1/0 or other strings as boolean', () => {
    expect(parseBooleanValue('1')).toBeNull()
    expect(parseBooleanValue('0')).toBeNull()
    expect(parseBooleanValue('maybe')).toBeNull()
    expect(parseBooleanValue('')).toBeNull()
  })
})

describe('detectColumnType', () => {
  it('detects each type from clean columns', () => {
    expect(detectColumnType(['1', '2', '3'])).toBe('number')
    expect(detectColumnType(['$1', '$2.50', '$3'])).toBe('currency')
    expect(detectColumnType(['2024-01-01', '2024-02-02'])).toBe('date')
    expect(detectColumnType(['yes', 'no', 'true'])).toBe('boolean')
    expect(detectColumnType(['apple', 'banana'])).toBe('text')
  })

  it('treats an empty or all-blank column as text', () => {
    expect(detectColumnType([])).toBe('text')
    expect(detectColumnType(['', '   ', ''])).toBe('text')
  })

  it('ignores blank cells and tolerates up to 20% mismatches', () => {
    expect(detectColumnType(['1', '', '2', '3', '4'])).toBe('number') // blanks ignored
    expect(detectColumnType(['1', '2', '3', '4', 'oops'])).toBe('number') // 80% numeric
    expect(detectColumnType(['1', '2', 'a', 'b'])).toBe('text') // only 50% numeric
  })

  it('prefers currency over number when symbols are present', () => {
    expect(detectColumnType(['$1', '$2', '$3'])).toBe('currency')
  })
})

describe('formatCellValue', () => {
  it('formats numbers with grouping and preserves precision', () => {
    expect(formatCellValue('1234.5', 'number', 'en-US')).toBe('1,234.5')
    expect(formatCellValue('1000000', 'number', 'en-US')).toBe('1,000,000')
  })

  it('formats currency with the detected symbol and 2 decimals', () => {
    expect(formatCellValue('$1234.5', 'currency', 'en-US')).toBe('$1,234.50')
    expect(formatCellValue('($5)', 'currency', 'en-US')).toBe('-$5.00')
  })

  it('formats booleans as Yes/No and leaves unparseable values raw', () => {
    expect(formatCellValue('true', 'boolean')).toBe('Yes')
    expect(formatCellValue('no', 'boolean')).toBe('No')
    expect(formatCellValue('not-a-number', 'number')).toBe('not-a-number')
  })

  it('returns empty string for blank input regardless of type', () => {
    expect(formatCellValue('', 'currency')).toBe('')
    expect(formatCellValue('  ', 'date')).toBe('')
  })
})

describe('compareCellValues', () => {
  it('sorts numbers and currency numerically, not lexically', () => {
    expect(compareCellValues('10', '9', 'number')).toBeGreaterThan(0)
    expect(compareCellValues('$2', '$10', 'currency')).toBeLessThan(0)
  })

  it('sorts dates chronologically', () => {
    expect(compareCellValues('2024-01-01', '2023-12-31', 'date')).toBeGreaterThan(0)
  })

  it('sorts booleans false before true', () => {
    expect(compareCellValues('no', 'yes', 'boolean')).toBeLessThan(0)
  })

  it('always sorts blanks last in ascending order', () => {
    expect(compareCellValues('', '5', 'number')).toBeGreaterThan(0)
    expect(compareCellValues('5', '', 'number')).toBeLessThan(0)
    expect(compareCellValues('', '', 'number')).toBe(0)
  })

  it('falls back to text comparison for text columns', () => {
    expect(compareCellValues('apple', 'banana', 'text')).toBeLessThan(0)
  })
})

describe('numericValue', () => {
  it('extracts the numeric value for chartable types and NaN otherwise', () => {
    expect(numericValue('1,000', 'number')).toBe(1000)
    expect(numericValue('$2.50', 'currency')).toBe(2.5)
    expect(numericValue('yes', 'boolean')).toBe(1)
    expect(Number.isNaN(numericValue('abc', 'number'))).toBe(true)
  })
})
