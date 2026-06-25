/**
 * @jest-environment node
 */

import {
  clampResultIndex,
  getMatchCounter,
  nextResultIndex,
  previousResultIndex,
} from './matchCounter'

describe('clampResultIndex', () => {
  test('returns -1 when there are no results', () => {
    expect(clampResultIndex(0, 0)).toBe(-1)
    expect(clampResultIndex(5, 0)).toBe(-1)
    expect(clampResultIndex(-1, 0)).toBe(-1)
  })

  test('clamps a negative index to the first result', () => {
    expect(clampResultIndex(-1, 3)).toBe(0)
    expect(clampResultIndex(-10, 3)).toBe(0)
  })

  test('clamps an overflowing index to the last result', () => {
    expect(clampResultIndex(3, 3)).toBe(2)
    expect(clampResultIndex(99, 3)).toBe(2)
  })

  test('passes through a valid index unchanged', () => {
    expect(clampResultIndex(0, 3)).toBe(0)
    expect(clampResultIndex(1, 3)).toBe(1)
    expect(clampResultIndex(2, 3)).toBe(2)
  })
})

describe('nextResultIndex', () => {
  test('returns -1 when there are no results', () => {
    expect(nextResultIndex(-1, 0)).toBe(-1)
  })

  test('advances forward', () => {
    expect(nextResultIndex(0, 3)).toBe(1)
    expect(nextResultIndex(1, 3)).toBe(2)
  })

  test('wraps to the start at the end', () => {
    expect(nextResultIndex(2, 3)).toBe(0)
  })

  test('starts at 0 when nothing is active', () => {
    expect(nextResultIndex(-1, 3)).toBe(0)
  })
})

describe('previousResultIndex', () => {
  test('returns -1 when there are no results', () => {
    expect(previousResultIndex(-1, 0)).toBe(-1)
  })

  test('moves backward', () => {
    expect(previousResultIndex(2, 3)).toBe(1)
    expect(previousResultIndex(1, 3)).toBe(0)
  })

  test('wraps to the end at the start', () => {
    expect(previousResultIndex(0, 3)).toBe(2)
  })
})

describe('getMatchCounter', () => {
  test('no matches', () => {
    expect(getMatchCounter(-1, 0)).toEqual({ current: 0, total: 0, label: '0' })
    expect(getMatchCounter(5, 0)).toEqual({ current: 0, total: 0, label: '0' })
  })

  test('matches but none active yet', () => {
    expect(getMatchCounter(-1, 4)).toEqual({ current: 0, total: 4, label: '4' })
  })

  test('active result is 1-based', () => {
    expect(getMatchCounter(0, 4)).toEqual({ current: 1, total: 4, label: '1 / 4' })
    expect(getMatchCounter(3, 4)).toEqual({ current: 4, total: 4, label: '4 / 4' })
  })

  test('never reports a position greater than the total', () => {
    expect(getMatchCounter(10, 4)).toEqual({ current: 4, total: 4, label: '4 / 4' })
  })

  test('guards against a negative total', () => {
    expect(getMatchCounter(0, -3)).toEqual({ current: 0, total: 0, label: '0' })
  })
})
