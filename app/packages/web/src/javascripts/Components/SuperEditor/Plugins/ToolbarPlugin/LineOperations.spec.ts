/**
 * Unit tests for the Super editor line ordering / dedupe helpers.
 */
import { applyLineOperation, dedupeLines, LineSortMode, sortLines } from './LineOperations'

describe('sortLines', () => {
  it('orders digits before letters in digits-first-asc, symbols first', () => {
    const input = ['banana', '2nd', 'Apple', '10things', '!bang', 'apple']
    const result = sortLines(input, 'digits-first-asc')
    expect(result[0]).toBe('!bang') // symbol sorts first
    // digits next, numerically by char ("10things" before "2nd" because '1' < '2')
    expect(result.indexOf('10things')).toBeLessThan(result.indexOf('2nd'))
    // letters after digits
    expect(result.indexOf('2nd')).toBeLessThan(result.indexOf('apple'))
  })

  it('letters-first-asc puts letters before digits', () => {
    const result = sortLines(['1one', 'alpha', '2two', 'beta'], 'letters-first-asc')
    expect(result.indexOf('alpha')).toBeLessThan(result.indexOf('1one'))
    expect(result.indexOf('beta')).toBeLessThan(result.indexOf('2two'))
  })

  it('descending is the exact inverse of the matching ascending', () => {
    const input = ['banana', '2nd', 'Apple', '10things', '!bang', 'apple']
    const asc = sortLines(input, 'digits-first-asc')
    const desc = sortLines(input, 'digits-first-desc')
    expect(desc).toEqual([...asc].reverse())
  })

  it('is case-insensitive (Apple and apple adjacent)', () => {
    const result = sortLines(['Apple', 'apple', 'zebra'], 'digits-first-asc')
    expect(Math.abs(result.indexOf('Apple') - result.indexOf('apple'))).toBe(1)
  })

  it('natural sort compares embedded numbers numerically', () => {
    const result = sortLines(['item10', 'item2', 'item1'], 'natural-asc')
    expect(result).toEqual(['item1', 'item2', 'item10'])
  })

  it('length sorts by line length', () => {
    expect(sortLines(['ccc', 'a', 'bb'], 'length-asc')).toEqual(['a', 'bb', 'ccc'])
    expect(sortLines(['a', 'bb', 'ccc'], 'length-desc')).toEqual(['ccc', 'bb', 'a'])
  })

  it('reverse just flips order without sorting', () => {
    expect(sortLines(['c', 'a', 'b'], 'reverse')).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate the input array', () => {
    const input = ['c', 'a', 'b']
    sortLines(input, 'digits-first-asc')
    expect(input).toEqual(['c', 'a', 'b'])
  })
})

describe('dedupeLines', () => {
  it('removes exact duplicates, keeping first occurrence + order', () => {
    expect(dedupeLines(['a', 'b', 'a', 'c', 'b'], 'dedupe')).toEqual(['a', 'b', 'c'])
  })

  it('case-insensitive dedupe keeps the first-seen casing', () => {
    expect(dedupeLines(['Apple', 'apple', 'APPLE', 'pear'], 'dedupe-ci')).toEqual(['Apple', 'pear'])
  })

  it('case-sensitive dedupe keeps distinct casings', () => {
    expect(dedupeLines(['Apple', 'apple'], 'dedupe')).toEqual(['Apple', 'apple'])
  })
})

describe('applyLineOperation', () => {
  it('dispatches to sort for sort modes and dedupe for dedupe modes', () => {
    expect(applyLineOperation(['b', 'a'], 'digits-first-asc')).toEqual(['a', 'b'])
    expect(applyLineOperation(['a', 'a'], 'dedupe')).toEqual(['a'])
  })
})

const ALL_SORT_MODES: LineSortMode[] = [
  'digits-first-asc',
  'digits-first-desc',
  'letters-first-asc',
  'letters-first-desc',
  'natural-asc',
  'natural-desc',
  'length-asc',
  'length-desc',
  'reverse',
]

describe('edge cases — empty / singleton / degenerate input', () => {
  it.each(ALL_SORT_MODES)('sorting an empty array is an empty array (%s)', (mode) => {
    expect(sortLines([], mode)).toEqual([])
  })

  it.each(ALL_SORT_MODES)('sorting a single line leaves it unchanged (%s)', (mode) => {
    expect(sortLines(['only'], mode)).toEqual(['only'])
  })

  it('dedupe on empty / singleton is a no-op', () => {
    expect(dedupeLines([], 'dedupe')).toEqual([])
    expect(dedupeLines(['x'], 'dedupe')).toEqual(['x'])
    expect(dedupeLines(['x'], 'dedupe-ci')).toEqual(['x'])
  })

  it('sorting all-identical lines is a no-op; dedupe collapses to one', () => {
    expect(sortLines(['a', 'a', 'a'], 'digits-first-asc')).toEqual(['a', 'a', 'a'])
    expect(dedupeLines(['a', 'a', 'a'], 'dedupe')).toEqual(['a'])
  })

  it('handles empty-string lines as real, distinct entries', () => {
    expect(dedupeLines(['', 'a', '', 'b', ''], 'dedupe')).toEqual(['', 'a', 'b'])
    // empty strings sort first (length 0 / nothing to compare)
    expect(sortLines(['b', '', 'a'], 'digits-first-asc')[0]).toBe('')
  })
})

describe('edge cases — whitespace and special characters', () => {
  it('sorts symbols/whitespace before digits and letters', () => {
    const result = sortLines(['apple', '  leading-space', '3', '#hash', '!bang'], 'digits-first-asc')
    // the two symbol-leading lines come before the digit, which comes before the letter
    expect(result.indexOf('  leading-space')).toBeLessThan(result.indexOf('3'))
    expect(result.indexOf('!bang')).toBeLessThan(result.indexOf('3'))
    expect(result.indexOf('3')).toBeLessThan(result.indexOf('apple'))
  })

  it('treats tabs and spaces as sortable leading symbols without throwing', () => {
    expect(() => sortLines(['\tindented', ' spaced', 'plain'], 'digits-first-asc')).not.toThrow()
  })

  it('whitespace differences make lines distinct for dedupe', () => {
    expect(dedupeLines(['a', 'a ', ' a', 'a'], 'dedupe')).toEqual(['a', 'a ', ' a'])
  })
})

describe('edge cases — unicode / emoji / accents / RTL', () => {
  const unicode = ['café', 'Café', '日本語', '😀 grin', 'Ärger', 'zebra', 'العربية', 'naïve']

  it.each(ALL_SORT_MODES)('never throws on unicode/emoji/RTL input (%s)', (mode) => {
    expect(() => sortLines(unicode, mode)).not.toThrow()
  })

  it('sorting is deterministic and a stable multiset (same elements, idempotent)', () => {
    const once = sortLines(unicode, 'digits-first-asc')
    const twice = sortLines(once, 'digits-first-asc')
    expect(twice).toEqual(once) // idempotent
    expect([...once].sort()).toEqual([...unicode].sort()) // same multiset
  })

  it('case-insensitive dedupe folds accented casing the way String.toLowerCase does', () => {
    // 'Café'.toLowerCase() === 'café', so they collapse; keeps first-seen casing.
    expect(dedupeLines(['Café', 'café', 'CAFÉ'], 'dedupe-ci')).toEqual(['Café'])
    // case-sensitive keeps them distinct
    expect(dedupeLines(['Café', 'café'], 'dedupe')).toEqual(['Café', 'café'])
  })
})

describe('edge cases — numeric / natural ordering', () => {
  it('digits sort by character, so leading zeros order before bare digits', () => {
    // '0' < '7' puts '007' first; '7' precedes '70' (shorter, shared prefix).
    expect(sortLines(['7', '007', '70'], 'digits-first-asc')).toEqual(['007', '7', '70'])
  })

  it('natural sort treats leading-zero numbers as numerically equal (stable on tie)', () => {
    expect(sortLines(['item7', 'item007'], 'natural-asc')).toEqual(['item7', 'item007'])
    expect(sortLines(['item007', 'item7'], 'natural-asc')).toEqual(['item007', 'item7'])
  })

  it('natural sort handles very large numbers beyond typical int ranges without crashing', () => {
    const big = ['v99999999999999999999', 'v2', 'v10']
    const result = sortLines(big, 'natural-asc')
    expect(result.indexOf('v2')).toBeLessThan(result.indexOf('v10'))
    expect(result[result.length - 1]).toBe('v99999999999999999999')
  })

  it('natural sort with no digits falls back to text comparison', () => {
    expect(sortLines(['cherry', 'apple', 'banana'], 'natural-asc')).toEqual(['apple', 'banana', 'cherry'])
  })
})

describe('edge cases — scale and invariants', () => {
  it('sorts a few thousand lines correctly: idempotent + multiset-preserving', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${(i * 7919) % 3000}`)
    const sorted = sortLines(lines, 'natural-asc')
    expect(sorted).toHaveLength(3000)
    expect(sortLines(sorted, 'natural-asc')).toEqual(sorted) // idempotent
    expect([...sorted].sort()).toEqual([...lines].sort()) // same multiset
  })

  it('handles a very long single line among others without throwing', () => {
    const huge = 'x'.repeat(50000)
    expect(() => sortLines([huge, 'a', 'b'], 'length-desc')).not.toThrow()
    expect(sortLines([huge, 'a', 'b'], 'length-desc')[0]).toBe(huge)
  })

  it('reverse of empty / singleton is unchanged', () => {
    expect(sortLines([], 'reverse')).toEqual([])
    expect(sortLines(['solo'], 'reverse')).toEqual(['solo'])
  })
})
