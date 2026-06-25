import {
  clampTableDimension,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MIN_TABLE_COLUMNS,
  MIN_TABLE_ROWS,
  parseTableDimension,
} from './TablePlugin'

describe('parseTableDimension', () => {
  it('accepts whole numbers within the inclusive range', () => {
    expect(parseTableDimension('1', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toEqual({ value: 1, isValid: true })
    expect(parseTableDimension('63', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toEqual({ value: 63, isValid: true })
    expect(parseTableDimension('1000', MIN_TABLE_ROWS, MAX_TABLE_ROWS)).toEqual({ value: 1000, isValid: true })
  })

  it('trims surrounding whitespace', () => {
    expect(parseTableDimension(' 5 ', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toEqual({ value: 5, isValid: true })
  })

  it('rejects values above the maximum', () => {
    expect(parseTableDimension('64', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('1001', MIN_TABLE_ROWS, MAX_TABLE_ROWS).isValid).toBe(false)
  })

  it('rejects values below the minimum', () => {
    expect(parseTableDimension('0', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
  })

  it('rejects empty, non-numeric, decimal, negative and scientific input', () => {
    expect(parseTableDimension('', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('abc', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('2.5', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('-3', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('1e3', MIN_TABLE_ROWS, MAX_TABLE_ROWS).isValid).toBe(false)
  })
})

describe('clampTableDimension', () => {
  it('clamps values into the inclusive range', () => {
    expect(clampTableDimension(100, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(MAX_TABLE_COLUMNS)
    expect(clampTableDimension(0, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(MIN_TABLE_COLUMNS)
    expect(clampTableDimension(10, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(10)
  })

  it('rounds fractional values', () => {
    expect(clampTableDimension(3.6, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(4)
  })

  it('falls back to the minimum for non-finite values', () => {
    expect(clampTableDimension(NaN, MIN_TABLE_ROWS, MAX_TABLE_ROWS)).toBe(MIN_TABLE_ROWS)
    expect(clampTableDimension(Infinity, MIN_TABLE_ROWS, MAX_TABLE_ROWS)).toBe(MIN_TABLE_ROWS)
  })
})
