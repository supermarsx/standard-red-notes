/**
 * Unit tests for the Super editor multi-key line sorter (Word-style
 * Sort by / Then by / Then by).
 */
import { multiKeySort, MultiKeySortOptions, SortKey, splitFields } from './LineSortMultiKey'

const key = (field: number, type: SortKey['type'], direction: SortKey['direction']): SortKey => ({
  field,
  type,
  direction,
})

const opts = (separator: MultiKeySortOptions['separator'], keys: SortKey[]): MultiKeySortOptions => ({
  separator,
  keys,
})

describe('splitFields', () => {
  it('splits on a literal tab', () => {
    expect(splitFields('a\tb\tc', 'tab')).toEqual(['a', 'b', 'c'])
  })

  it('splits on a literal comma', () => {
    expect(splitFields('a,b,c', 'comma')).toEqual(['a', 'b', 'c'])
  })

  it('splits on a single space (preserving empties)', () => {
    expect(splitFields('a  b', 'space')).toEqual(['a', '', 'b'])
  })

  it('collapses any run of whitespace', () => {
    expect(splitFields('a \t  b', 'whitespace')).toEqual(['a', 'b'])
  })
})

describe('multiKeySort — single key', () => {
  it('text ascending', () => {
    const result = multiKeySort(['cherry', 'apple', 'banana'], opts('tab', [key(0, 'text', 'asc')]))
    expect(result).toEqual(['apple', 'banana', 'cherry'])
  })

  it('text descending', () => {
    const result = multiKeySort(['apple', 'banana', 'cherry'], opts('tab', [key(0, 'text', 'desc')]))
    expect(result).toEqual(['cherry', 'banana', 'apple'])
  })

  it('is case-insensitive for text', () => {
    const result = multiKeySort(['Banana', 'apple', 'Cherry'], opts('tab', [key(0, 'text', 'asc')]))
    expect(result).toEqual(['apple', 'Banana', 'Cherry'])
  })
})

describe('multiKeySort — numeric key', () => {
  it('sorts numerically, not lexically (10 after 9)', () => {
    const result = multiKeySort(['9', '10', '2', '1'], opts('tab', [key(0, 'number', 'asc')]))
    expect(result).toEqual(['1', '2', '9', '10'])
  })

  it('numeric descending', () => {
    const result = multiKeySort(['9', '10', '2'], opts('tab', [key(0, 'number', 'desc')]))
    expect(result).toEqual(['10', '9', '2'])
  })

  it('parses leading numeric portion of a field', () => {
    const result = multiKeySort(['12abc', '2xyz', '100q'], opts('tab', [key(0, 'number', 'asc')]))
    expect(result).toEqual(['2xyz', '12abc', '100q'])
  })

  it('blank / non-numeric values sort last in ascending order', () => {
    const result = multiKeySort(['3', '', 'foo', '1'], opts('tab', [key(0, 'number', 'asc')]))
    expect(result.slice(0, 2)).toEqual(['1', '3'])
    expect(result.slice(2).sort()).toEqual(['', 'foo'])
  })

  it('blank / non-numeric values still sort last in descending order', () => {
    const result = multiKeySort(['3', '', 'foo', '1'], opts('tab', [key(0, 'number', 'desc')]))
    expect(result.slice(0, 2)).toEqual(['3', '1'])
    expect(result.slice(2).sort()).toEqual(['', 'foo'])
  })

  it('parses currency only when it starts with a digit/sign (leading $ is non-numeric)', () => {
    // "$3.50" does not start with a digit/sign, so it parses as NaN and sorts last;
    // "3.50" parses as 3.5.
    const result = multiKeySort(['$3.50', '3.50', '1'], opts('tab', [key(0, 'number', 'asc')]))
    expect(result).toEqual(['1', '3.50', '$3.50'])
  })
})

describe('multiKeySort — two keys (primary tie broken by secondary)', () => {
  it('groups by last name then orders by first name', () => {
    const input = ['Smith\tJohn', 'Adams\tZoe', 'Smith\tAnna', 'Adams\tBob']
    const result = multiKeySort(input, opts('tab', [key(0, 'text', 'asc'), key(1, 'text', 'asc')]))
    expect(result).toEqual(['Adams\tBob', 'Adams\tZoe', 'Smith\tAnna', 'Smith\tJohn'])
  })

  it('mixed directions: field0 asc, field1 desc', () => {
    const input = ['Smith\tJohn', 'Adams\tZoe', 'Smith\tAnna', 'Adams\tBob']
    const result = multiKeySort(input, opts('tab', [key(0, 'text', 'asc'), key(1, 'text', 'desc')]))
    expect(result).toEqual(['Adams\tZoe', 'Adams\tBob', 'Smith\tJohn', 'Smith\tAnna'])
  })

  it('numeric secondary key sorts numerically within a text primary group', () => {
    const input = ['team\t10', 'team\t2', 'team\t1', 'zeta\t5']
    const result = multiKeySort(input, opts('tab', [key(0, 'text', 'asc'), key(1, 'number', 'asc')]))
    expect(result).toEqual(['team\t1', 'team\t2', 'team\t10', 'zeta\t5'])
  })
})

describe('multiKeySort — three keys', () => {
  it('applies all three in order', () => {
    const input = [
      'A\tred\t2',
      'A\tred\t1',
      'A\tblue\t9',
      'B\tred\t1',
      'A\tred\t3',
    ]
    const result = multiKeySort(
      input,
      opts('tab', [key(0, 'text', 'asc'), key(1, 'text', 'asc'), key(2, 'number', 'asc')]),
    )
    expect(result).toEqual(['A\tblue\t9', 'A\tred\t1', 'A\tred\t2', 'A\tred\t3', 'B\tred\t1'])
  })
})

describe('multiKeySort — missing / short fields', () => {
  it('treats a missing field as empty string (text)', () => {
    // second line has no field index 1; empty string sorts before "z"
    const input = ['a\tz', 'a']
    const result = multiKeySort(input, opts('tab', [key(0, 'text', 'asc'), key(1, 'text', 'asc')]))
    expect(result).toEqual(['a', 'a\tz'])
  })

  it('a missing numeric field is blank ⇒ sorts last', () => {
    const input = ['x\t5', 'x']
    const result = multiKeySort(input, opts('tab', [key(0, 'text', 'asc'), key(1, 'number', 'asc')]))
    expect(result).toEqual(['x\t5', 'x'])
  })

  it('a field index beyond every line compares as empty (no reordering on that key)', () => {
    const input = ['b', 'a', 'c']
    const result = multiKeySort(input, opts('tab', [key(5, 'text', 'asc')]))
    expect(result).toEqual(['b', 'a', 'c']) // all equal-empty ⇒ stable original order
  })
})

describe('multiKeySort — blank lines and stability', () => {
  it('handles blank lines as real entries', () => {
    const result = multiKeySort(['b', '', 'a'], opts('tab', [key(0, 'text', 'asc')]))
    expect(result).toEqual(['', 'a', 'b'])
  })

  it('keeps original relative order for fully-equal lines (stable)', () => {
    const input = ['same#1', 'same#2', 'same#3'].map((tag) => `dup\t${tag}`)
    // sort only on field 0, which is identical ⇒ order must be preserved
    const result = multiKeySort(input, opts('tab', [key(0, 'text', 'asc')]))
    expect(result).toEqual(input)
  })
})

describe('multiKeySort — separators', () => {
  it('comma separator', () => {
    const input = ['Smith,John', 'Adams,Zoe', 'Adams,Bob']
    const result = multiKeySort(input, opts('comma', [key(0, 'text', 'asc'), key(1, 'text', 'asc')]))
    expect(result).toEqual(['Adams,Bob', 'Adams,Zoe', 'Smith,John'])
  })

  it('space separator', () => {
    const input = ['b 2', 'a 3', 'a 1']
    const result = multiKeySort(input, opts('space', [key(0, 'text', 'asc'), key(1, 'number', 'asc')]))
    expect(result).toEqual(['a 1', 'a 3', 'b 2'])
  })

  it('whitespace separator collapses runs of spaces/tabs', () => {
    const input = ['b   2', 'a\t3', 'a  1']
    const result = multiKeySort(input, opts('whitespace', [key(0, 'text', 'asc'), key(1, 'number', 'asc')]))
    expect(result).toEqual(['a  1', 'a\t3', 'b   2'])
  })
})

describe('multiKeySort — degenerate input and no-ops', () => {
  it('returns a copy unchanged for empty input', () => {
    const input: string[] = []
    const result = multiKeySort(input, opts('tab', [key(0, 'text', 'asc')]))
    expect(result).toEqual([])
    expect(result).not.toBe(input)
  })

  it('returns a copy unchanged for a single line', () => {
    const result = multiKeySort(['only'], opts('tab', [key(0, 'text', 'asc')]))
    expect(result).toEqual(['only'])
  })

  it('returns a copy unchanged when keys is empty', () => {
    const input = ['c', 'a', 'b']
    const result = multiKeySort(input, opts('tab', []))
    expect(result).toEqual(['c', 'a', 'b'])
    expect(result).not.toBe(input)
  })

  it('ignores null key entries and negative-field keys', () => {
    const input = ['c\t1', 'a\t2', 'b\t3']
    const keys = [null as unknown as SortKey, key(-1, 'text', 'asc'), key(0, 'text', 'asc')]
    const result = multiKeySort(input, opts('tab', keys))
    expect(result).toEqual(['a\t2', 'b\t3', 'c\t1'])
  })

  it('returns a copy unchanged when only negative/null keys are supplied', () => {
    const input = ['c', 'a', 'b']
    const keys = [null as unknown as SortKey, key(-2, 'text', 'asc')]
    const result = multiKeySort(input, opts('tab', keys))
    expect(result).toEqual(['c', 'a', 'b'])
  })
})

describe('multiKeySort — does not mutate input', () => {
  it('leaves the original array untouched', () => {
    const input = ['c\t1', 'a\t2', 'b\t3']
    const snapshot = [...input]
    multiKeySort(input, opts('tab', [key(0, 'text', 'asc')]))
    expect(input).toEqual(snapshot)
  })
})
