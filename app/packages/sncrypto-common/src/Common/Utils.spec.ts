import { timingSafeEqual } from './Utils'

/**
 * This package's `test` script used to be `yarn lint`: it ran no tests at all and reported
 * success up into `yarn test:app`. `timingSafeEqual` is the only runtime code in the package
 * and it is the comparison the 002/003 authentication gate and `SNRootKey.compare` are built
 * on, so a wrong answer here either accepts a tampered note or locks a user out of their own.
 */
describe('timingSafeEqual', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('a', 'a')).toBe(true)
    expect(timingSafeEqual('an-auth-hash', 'an-auth-hash')).toBe(true)
  })

  it('rejects same-length strings differing anywhere', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'zbc')).toBe(false)
    expect(timingSafeEqual('abc', 'axc')).toBe(false)
  })

  it('rejects strings of different length, including a prefix of the other', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
    expect(timingSafeEqual('a', '')).toBe(false)
  })

  it('compares every character rather than stopping at the first difference', () => {
    /**
     * The accumulate-with-|= shape is the point of the function: an implementation that
     * returned at the first mismatching character would leak, through its running time, how
     * much of a guessed authentication hash was correct. Behaviour cannot observe the timing,
     * but it can pin that a trailing-only difference is still caught, which an implementation
     * truncating the loop early would get wrong.
     */
    const base = 'a'.repeat(64)
    expect(timingSafeEqual(base, `${base.slice(0, 63)}b`)).toBe(false)
    expect(timingSafeEqual(base, `b${base.slice(1)}`)).toBe(false)
  })

  it('distinguishes characters that differ beyond the ASCII range', () => {
    expect(timingSafeEqual('é', 'e')).toBe(false)
    expect(timingSafeEqual('é', 'é')).toBe(true)
    /** Compared by UTF-16 code unit, so an astral character is two units and still matches itself. */
    expect(timingSafeEqual('🔑', '🔑')).toBe(true)
    expect(timingSafeEqual('🔑', '🔒')).toBe(false)
  })
})
