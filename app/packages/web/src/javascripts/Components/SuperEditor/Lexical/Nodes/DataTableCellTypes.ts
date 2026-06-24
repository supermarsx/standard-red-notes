/**
 * Standard Red Notes: pure cell value typing/formatting helpers for the Super
 * editor's structured Data table block. Side-effect-free so they can be unit
 * tested in isolation. Cells are stored as raw strings; these helpers infer a
 * column's type, format a raw value for display, and compare values for sorting.
 */

export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'boolean'
export type ColumnTypeSetting = ColumnType | 'auto'

export const COLUMN_TYPES: ColumnType[] = ['text', 'number', 'currency', 'date', 'boolean']

const CURRENCY_SYMBOLS = '$€£¥₹₽₩₪₺R$'
// One symbol char OR the "R$" pair; matched as a whole below.
const CURRENCY_SYMBOL_RE = /(R\$|[$€£¥₹₽₩₪₺])/

const stripGrouping = (value: string): string => value.replace(/,/g, '').trim()

const PLAIN_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/

export const parseNumberValue = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  const cleaned = stripGrouping(trimmed)
  if (!PLAIN_NUMBER_RE.test(cleaned)) {
    return null
  }
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export type ParsedCurrency = { value: number; symbol: string }

export const parseCurrencyValue = (raw: string): ParsedCurrency | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  const match = trimmed.match(CURRENCY_SYMBOL_RE)
  if (!match) {
    return null
  }
  const symbol = match[0]
  // Remove the symbol (prefix or suffix) and parentheses-style negatives.
  let rest = trimmed.replace(symbol, '').trim()
  let sign = 1
  if (/^\(.*\)$/.test(rest)) {
    sign = -1
    rest = rest.slice(1, -1).trim()
  }
  const n = parseNumberValue(rest)
  if (n === null) {
    return null
  }
  return { value: sign * n, symbol }
}

const ISO_DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/
const MONTH_NAME_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i

export const parseDateValue = (raw: string): Date | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  // A bare integer is a number, never a date.
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return null
  }
  const looksLikeDate =
    ISO_DATE_RE.test(trimmed) || SLASH_DATE_RE.test(trimmed) || (MONTH_NAME_RE.test(trimmed) && /\d/.test(trimmed))
  if (!looksLikeDate) {
    return null
  }
  const time = Date.parse(trimmed)
  return Number.isNaN(time) ? null : new Date(time)
}

const TRUE_VALUES = new Set(['true', 'yes'])
const FALSE_VALUES = new Set(['false', 'no'])

export const parseBooleanValue = (raw: string): boolean | null => {
  const value = raw.trim().toLowerCase()
  if (TRUE_VALUES.has(value)) {
    return true
  }
  if (FALSE_VALUES.has(value)) {
    return false
  }
  return null
}

const matchRatio = (values: string[], predicate: (value: string) => boolean): number => {
  if (values.length === 0) {
    return 0
  }
  let matches = 0
  for (const value of values) {
    if (predicate(value)) {
      matches++
    }
  }
  return matches / values.length
}

/**
 * Infer a column's type from its (non-empty) values. A type is chosen when at
 * least 80% of non-empty cells match it; checked from most-specific to least.
 * An empty column is `text`.
 */
export const detectColumnType = (values: string[]): ColumnType => {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v.length > 0)
  if (nonEmpty.length === 0) {
    return 'text'
  }
  const threshold = 0.8
  if (matchRatio(nonEmpty, (v) => parseBooleanValue(v) !== null) >= threshold) {
    return 'boolean'
  }
  if (matchRatio(nonEmpty, (v) => parseCurrencyValue(v) !== null) >= threshold) {
    return 'currency'
  }
  if (matchRatio(nonEmpty, (v) => parseNumberValue(v) !== null) >= threshold) {
    return 'number'
  }
  if (matchRatio(nonEmpty, (v) => parseDateValue(v) !== null) >= threshold) {
    return 'date'
  }
  return 'text'
}

export const formatCellValue = (raw: string, type: ColumnType, locale?: string): string => {
  if (raw.trim().length === 0) {
    return ''
  }
  switch (type) {
    case 'number': {
      const n = parseNumberValue(raw)
      return n === null ? raw : new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(n)
    }
    case 'currency': {
      const parsed = parseCurrencyValue(raw)
      if (!parsed) {
        return raw
      }
      const formatted = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Math.abs(parsed.value))
      return parsed.value < 0 ? `-${parsed.symbol}${formatted}` : `${parsed.symbol}${formatted}`
    }
    case 'date': {
      const date = parseDateValue(raw)
      return date ? new Intl.DateTimeFormat(locale).format(date) : raw
    }
    case 'boolean': {
      const bool = parseBooleanValue(raw)
      return bool === null ? raw : bool ? 'Yes' : 'No'
    }
    default:
      return raw
  }
}

/** Numeric value used for sorting/charting; NaN when not parseable as the type. */
export const numericValue = (raw: string, type: ColumnType): number => {
  if (type === 'currency') {
    return parseCurrencyValue(raw)?.value ?? NaN
  }
  if (type === 'date') {
    const date = parseDateValue(raw)
    return date ? date.getTime() : NaN
  }
  if (type === 'boolean') {
    const bool = parseBooleanValue(raw)
    return bool === null ? NaN : bool ? 1 : 0
  }
  const n = parseNumberValue(raw)
  return n === null ? NaN : n
}

/** Compare two raw cell values by type; empty values always sort last (ascending). */
export const compareCellValues = (a: string, b: string, type: ColumnType): number => {
  const aEmpty = a.trim().length === 0
  const bEmpty = b.trim().length === 0
  if (aEmpty || bEmpty) {
    return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1
  }
  if (type === 'text') {
    return a.localeCompare(b)
  }
  const an = numericValue(a, type)
  const bn = numericValue(b, type)
  const aNaN = Number.isNaN(an)
  const bNaN = Number.isNaN(bn)
  if (aNaN || bNaN) {
    // Fall back to text comparison when a value doesn't parse for its type.
    return aNaN === bNaN ? a.localeCompare(b) : aNaN ? 1 : -1
  }
  return an - bn
}
