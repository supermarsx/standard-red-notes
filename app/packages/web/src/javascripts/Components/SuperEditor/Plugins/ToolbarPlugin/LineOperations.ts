/**
 * Standard Red Notes: pure line-ordering / deduplication helpers for the Super
 * editor toolbar. These operate on an array of line strings (one per selected
 * block) so they can be unit-tested without React or Lexical.
 *
 * Ordering treats every character as belonging to one of three classes —
 * symbols/whitespace, digits, letters — so callers can choose whether digits
 * sort before or after letters ("0–9 → A–Z" vs "A–Z → 0–9"). Symbols/special
 * characters always sort first within a comparison. Each ascending mode has an
 * exact descending inverse.
 */

export type LineSortMode =
  | 'digits-first-asc'
  | 'digits-first-desc'
  | 'letters-first-asc'
  | 'letters-first-desc'
  | 'natural-asc'
  | 'natural-desc'
  | 'length-asc'
  | 'length-desc'
  | 'reverse'

export type LineDedupeMode = 'dedupe' | 'dedupe-ci'

export type LineOperation = LineSortMode | LineDedupeMode

type CharClass = 0 | 1 | 2 // 0 = symbol/space, 1/2 = digit/letter (order depends on mode)

const classify = (codePoint: number): 'symbol' | 'digit' | 'letter' => {
  if (codePoint >= 48 && codePoint <= 57) {
    return 'digit'
  }
  if ((codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122)) {
    return 'letter'
  }
  // Treat the rest of the Latin-1 letter range and everything above it (accented
  // letters, CJK, etc.) as letters so words sort together; ASCII punctuation and
  // whitespace below 0xC0 fall through to "symbol" and sort first.
  if (codePoint >= 0xc0) {
    return 'letter'
  }
  return 'symbol'
}

/**
 * Build a character-group-aware comparator. `digitsFirst` controls whether the
 * digit group sorts before (true) or after (false) the letter group; symbols
 * always sort first. Comparison is case-insensitive unless `caseSensitive`.
 */
const makeGroupComparator = (digitsFirst: boolean, caseSensitive: boolean) => {
  const groupOf = (codePoint: number): CharClass => {
    const cls = classify(codePoint)
    if (cls === 'symbol') {
      return 0
    }
    if (cls === 'digit') {
      return digitsFirst ? 1 : 2
    }
    return digitsFirst ? 2 : 1
  }

  return (a: string, b: string): number => {
    const left = caseSensitive ? a : a.toLowerCase()
    const right = caseSensitive ? b : b.toLowerCase()
    const length = Math.min(left.length, right.length)
    for (let index = 0; index < length; index++) {
      const ca = left.charCodeAt(index)
      const cb = right.charCodeAt(index)
      if (ca === cb) {
        continue
      }
      const ga = groupOf(ca)
      const gb = groupOf(cb)
      if (ga !== gb) {
        return ga - gb
      }
      return ca - cb
    }
    return left.length - right.length
  }
}

/**
 * "Natural" comparison: embedded runs of digits compare as numbers, so
 * "item2" sorts before "item10". Non-digit runs compare case-insensitively.
 */
const naturalCompare = (a: string, b: string): number => {
  const chunk = /(\d+|\D+)/g
  const left = (a.toLowerCase().match(chunk) ?? []) as string[]
  const right = (b.toLowerCase().match(chunk) ?? []) as string[]
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const la = left[index]
    const rb = right[index]
    const laNum = /^\d/.test(la)
    const rbNum = /^\d/.test(rb)
    if (laNum && rbNum) {
      const diff = Number(la) - Number(rb)
      if (diff !== 0) {
        return diff
      }
    } else if (la !== rb) {
      return la < rb ? -1 : 1
    }
  }
  return left.length - right.length
}

export const sortLines = (lines: string[], mode: LineSortMode): string[] => {
  const arr = [...lines]
  const digitsFirst = makeGroupComparator(true, false)
  const lettersFirst = makeGroupComparator(false, false)
  const byLength = (a: string, b: string) => a.length - b.length || digitsFirst(a, b)
  // Each descending mode is the exact reverse of its ascending counterpart so it
  // is a true inverse (ties included), not just a negated comparator.
  switch (mode) {
    case 'digits-first-asc':
      return arr.sort(digitsFirst)
    case 'digits-first-desc':
      return arr.sort(digitsFirst).reverse()
    case 'letters-first-asc':
      return arr.sort(lettersFirst)
    case 'letters-first-desc':
      return arr.sort(lettersFirst).reverse()
    case 'natural-asc':
      return arr.sort(naturalCompare)
    case 'natural-desc':
      return arr.sort(naturalCompare).reverse()
    case 'length-asc':
      return arr.sort(byLength)
    case 'length-desc':
      return arr.sort(byLength).reverse()
    case 'reverse':
      return arr.reverse()
    default:
      return arr
  }
}

export const dedupeLines = (lines: string[], mode: LineDedupeMode): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const key = mode === 'dedupe-ci' ? line.toLowerCase() : line
    if (!seen.has(key)) {
      seen.add(key)
      out.push(line)
    }
  }
  return out
}

const SORT_MODES = new Set<string>([
  'digits-first-asc',
  'digits-first-desc',
  'letters-first-asc',
  'letters-first-desc',
  'natural-asc',
  'natural-desc',
  'length-asc',
  'length-desc',
  'reverse',
])

export const applyLineOperation = (lines: string[], operation: LineOperation): string[] => {
  if (SORT_MODES.has(operation)) {
    return sortLines(lines, operation as LineSortMode)
  }
  return dedupeLines(lines, operation as LineDedupeMode)
}

/** Menu descriptors (label + mode) for the toolbar's "Sort & lines" dropdown. */
export const LINE_SORT_MODES: { mode: LineSortMode; label: string }[] = [
  { mode: 'digits-first-asc', label: '0–9 → A–Z' },
  { mode: 'digits-first-desc', label: 'Z–A → 9–0' },
  { mode: 'letters-first-asc', label: 'A–Z → 0–9' },
  { mode: 'letters-first-desc', label: '9–0 → Z–A' },
  { mode: 'natural-asc', label: 'Numeric ascending (natural)' },
  { mode: 'natural-desc', label: 'Numeric descending (natural)' },
  { mode: 'length-asc', label: 'Shortest line first' },
  { mode: 'length-desc', label: 'Longest line first' },
  { mode: 'reverse', label: 'Reverse line order' },
]

export const LINE_DEDUPE_MODES: { mode: LineDedupeMode; label: string }[] = [
  { mode: 'dedupe', label: 'Remove duplicate lines' },
  { mode: 'dedupe-ci', label: 'Remove duplicates (ignore case)' },
]
