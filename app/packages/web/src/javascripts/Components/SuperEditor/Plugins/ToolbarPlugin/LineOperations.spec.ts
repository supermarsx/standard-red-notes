/**
 * Unit tests for the Super editor line ordering / dedupe helpers.
 */
import { applyLineOperation, dedupeLines, sortLines } from './LineOperations'

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
