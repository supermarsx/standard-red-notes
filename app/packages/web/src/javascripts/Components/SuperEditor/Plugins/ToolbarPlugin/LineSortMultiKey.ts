/**
 * Standard Red Notes: pure multi-key line sorter for the Super editor toolbar,
 * modelled on Microsoft Word's Sort dialog (Sort by / Then by / Then by). Each
 * line is split into fields by a chosen separator and compared by up to three
 * ordered keys; the first key whose comparison is non-zero decides the order.
 *
 * Like the single-key sorter in LineOperations.ts this works on a plain array of
 * line strings so it can be unit-tested without React or Lexical. It does not
 * mutate its input and is stable: lines that compare equal on every active key
 * keep their original relative order.
 */

export type SortKeyType = 'text' | 'number'

export type SortKey = { field: number; type: SortKeyType; direction: 'asc' | 'desc' }

export type MultiKeySortOptions = {
  separator: 'tab' | 'comma' | 'space' | 'whitespace'
  keys: SortKey[]
}

/**
 * Split a line into fields by the chosen separator. `tab`/`comma`/`space` split
 * on a single literal character; `whitespace` collapses any run of whitespace.
 */
export function splitFields(line: string, separator: MultiKeySortOptions['separator']): string[] {
  switch (separator) {
    case 'tab':
      return line.split('\t')
    case 'comma':
      return line.split(',')
    case 'space':
      return line.split(' ')
    case 'whitespace':
      return line.split(/\s+/)
    default:
      return [line]
  }
}

/**
 * Locale-aware, case-insensitive text comparison — mirrors the single-key
 * sorter's "case-insensitive" intent while using Intl collation so accented and
 * non-Latin scripts order sensibly.
 */
const compareText = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'accent' })

/**
 * Parse the leading numeric portion of a field (e.g. "12abc" → 12, "$3.50" → 3.5
 * only if it starts with a digit/sign). Blank or non-numeric fields yield NaN so
 * they can be ordered last regardless of direction.
 */
const parseLeadingNumber = (value: string): number => {
  const trimmed = value.trim()
  if (trimmed === '') {
    return NaN
  }
  const match = trimmed.match(/^[+-]?(\d+(\.\d+)?|\.\d+)/)
  return match ? Number(match[0]) : NaN
}

/**
 * Compare two field values for one key. NaN (blank/non-numeric) always sorts
 * last; this is applied before the direction flip so blanks stay last in both
 * ascending and descending order, matching Word's behaviour.
 */
const compareForKey = (a: string, b: string, type: SortKeyType, direction: 'asc' | 'desc'): number => {
  if (type === 'number') {
    const na = parseLeadingNumber(a)
    const nb = parseLeadingNumber(b)
    const aNaN = Number.isNaN(na)
    const bNaN = Number.isNaN(nb)
    if (aNaN && bNaN) {
      return 0
    }
    if (aNaN) {
      return 1 // a sorts last regardless of direction
    }
    if (bNaN) {
      return -1
    }
    const diff = na - nb
    return direction === 'desc' ? -diff : diff
  }
  const diff = compareText(a, b)
  return direction === 'desc' ? -diff : diff
}

const fieldAt = (fields: string[], index: number): string => fields[index] ?? ''

/**
 * Sort `lines` by up to three ordered keys. Each key splits the line by
 * `options.separator`, picks its 0-based `field`, and compares as text (locale,
 * case-insensitive) or number (leading numeric, NaN/blank last) honouring its
 * own asc/desc direction. Keys are applied in array order; the first non-equal
 * comparison wins. Stable, non-mutating; arrays shorter than 2 (or with no
 * active keys) return an unchanged copy.
 */
export function multiKeySort(lines: string[], options: MultiKeySortOptions): string[] {
  const copy = [...lines]
  if (copy.length < 2) {
    return copy
  }

  // Drop null entries and keys targeting a negative field; nothing left ⇒ no-op.
  const activeKeys = (options.keys ?? []).filter(
    (key): key is SortKey => key != null && key.field >= 0,
  )
  if (activeKeys.length === 0) {
    return copy
  }

  // Decorate-sort-undecorate to keep the comparator cheap and guarantee
  // stability via the original index tiebreaker.
  const decorated = copy.map((line, index) => ({
    line,
    index,
    fields: splitFields(line, options.separator),
  }))

  decorated.sort((left, right) => {
    for (const key of activeKeys) {
      const result = compareForKey(
        fieldAt(left.fields, key.field),
        fieldAt(right.fields, key.field),
        key.type,
        key.direction,
      )
      if (result !== 0) {
        return result
      }
    }
    return left.index - right.index
  })

  return decorated.map((entry) => entry.line)
}
