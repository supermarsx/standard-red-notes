/**
 * @jest-environment jsdom
 */

import { buildSearchRegExp, compileSearch, computeReplacement, escapeRegExp, SearchOptions } from './replaceLogic'

const baseOptions: SearchOptions = {
  isCaseSensitive: false,
  isWholeWord: false,
  isRegex: false,
}

function options(overrides: Partial<SearchOptions>): SearchOptions {
  return { ...baseOptions, ...overrides }
}

describe('escapeRegExp', () => {
  test('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c+')).toBe('a\\.b\\*c\\+')
    expect(escapeRegExp('(foo|bar)')).toBe('\\(foo\\|bar\\)')
  })
})

describe('buildSearchRegExp', () => {
  test('returns null for empty query', () => {
    expect(buildSearchRegExp('', baseOptions)).toBeNull()
  })

  test('literal query is escaped', () => {
    const regex = buildSearchRegExp('a.b', options({ isRegex: false }))
    expect(regex).not.toBeNull()
    expect('axb'.match(regex as RegExp)).toBeNull()
    expect('a.b'.match(regex as RegExp)).not.toBeNull()
  })

  test('regex query is used raw', () => {
    const regex = buildSearchRegExp('a.b', options({ isRegex: true }))
    expect('axb'.match(regex as RegExp)).not.toBeNull()
  })

  test('case sensitivity controls the i flag', () => {
    expect(buildSearchRegExp('x', options({ isCaseSensitive: false }))?.flags).toContain('i')
    expect(buildSearchRegExp('x', options({ isCaseSensitive: true }))?.flags).not.toContain('i')
  })

  test('global flag is controlled by the global argument', () => {
    expect(buildSearchRegExp('x', baseOptions, true)?.flags).toContain('g')
    expect(buildSearchRegExp('x', baseOptions, false)?.flags).not.toContain('g')
  })

  test('whole word wraps in word boundaries', () => {
    const regex = buildSearchRegExp('cat', options({ isWholeWord: true }))
    expect('cats and dogs'.match(regex as RegExp)).toBeNull()
    expect('a cat sat'.match(regex as RegExp)).not.toBeNull()
  })

  test('invalid regex throws', () => {
    expect(() => buildSearchRegExp('(', options({ isRegex: true }))).toThrow()
  })
})

describe('compileSearch', () => {
  test('returns null regex and no error for empty query', () => {
    const result = compileSearch('', baseOptions)
    expect(result.regex).toBeNull()
    expect(result.error).toBeNull()
  })

  test('returns regex for valid query', () => {
    const result = compileSearch('abc', baseOptions)
    expect(result.regex).not.toBeNull()
    expect(result.error).toBeNull()
  })

  test('returns error string for invalid regex, never throws', () => {
    const result = compileSearch('(', options({ isRegex: true }))
    expect(result.regex).toBeNull()
    expect(typeof result.error).toBe('string')
    expect((result.error as string).length).toBeGreaterThan(0)
  })
})

describe('computeReplacement', () => {
  test('empty query returns input unchanged', () => {
    const { output, count } = computeReplacement('hello', '', 'x', baseOptions, true)
    expect(output).toBe('hello')
    expect(count).toBe(0)
  })

  test('literal replace single only replaces first match', () => {
    const { output, count } = computeReplacement('a a a', 'a', 'b', baseOptions, false)
    expect(output).toBe('b a a')
    expect(count).toBe(1)
  })

  test('literal replace all replaces every match', () => {
    const { output, count } = computeReplacement('a a a', 'a', 'b', baseOptions, true)
    expect(output).toBe('b b b')
    expect(count).toBe(3)
  })

  test('case-insensitive by default', () => {
    const { output, count } = computeReplacement('Cat cat CAT', 'cat', 'dog', baseOptions, true)
    expect(output).toBe('dog dog dog')
    expect(count).toBe(3)
  })

  test('case-sensitive only replaces exact case', () => {
    const { output, count } = computeReplacement(
      'Cat cat CAT',
      'cat',
      'dog',
      options({ isCaseSensitive: true }),
      true,
    )
    expect(output).toBe('Cat dog CAT')
    expect(count).toBe(1)
  })

  test('whole word boundaries are respected', () => {
    const { output, count } = computeReplacement(
      'cat category cats',
      'cat',
      'X',
      options({ isWholeWord: true }),
      true,
    )
    expect(output).toBe('X category cats')
    expect(count).toBe(1)
  })

  test('regex backreferences $1 $2', () => {
    const { output, count } = computeReplacement(
      'John Smith',
      '(\\w+) (\\w+)',
      '$2 $1',
      options({ isRegex: true }),
      false,
    )
    expect(output).toBe('Smith John')
    expect(count).toBe(1)
  })

  test('regex whole-match $&', () => {
    const { output, count } = computeReplacement(
      'abc',
      'b',
      '[$&]',
      options({ isRegex: true }),
      true,
    )
    expect(output).toBe('a[b]c')
    expect(count).toBe(1)
  })

  test('non-regex mode treats $ in replacement literally', () => {
    const { output } = computeReplacement('price', 'price', '$5', baseOptions, true)
    expect(output).toBe('$5')
  })

  test('non-regex mode treats $1 in replacement literally', () => {
    const { output } = computeReplacement('x', 'x', 'a$1b', baseOptions, true)
    expect(output).toBe('a$1b')
  })

  test('regex global replace all vs single', () => {
    const all = computeReplacement('a1b2c3', '\\d', '#', options({ isRegex: true }), true)
    expect(all.output).toBe('a#b#c#')
    expect(all.count).toBe(3)

    const single = computeReplacement('a1b2c3', '\\d', '#', options({ isRegex: true }), false)
    expect(single.output).toBe('a#b2c3')
    expect(single.count).toBe(1)
  })

  test('regex case sensitivity', () => {
    const insensitive = computeReplacement('Hello HELLO', 'h\\w+', 'x', options({ isRegex: true }), true)
    expect(insensitive.count).toBe(2)

    const sensitive = computeReplacement(
      'Hello HELLO',
      'Hello',
      'x',
      options({ isRegex: true, isCaseSensitive: true }),
      true,
    )
    expect(sensitive.output).toBe('x HELLO')
    expect(sensitive.count).toBe(1)
  })

  test('regex $$ produces a literal dollar', () => {
    const { output } = computeReplacement('a', 'a', '$$', options({ isRegex: true }), true)
    expect(output).toBe('$')
  })
})
