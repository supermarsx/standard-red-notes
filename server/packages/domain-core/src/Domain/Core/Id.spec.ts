import { Id } from './Id'

describe('Id', () => {
  it('returns the wrapped value', () => {
    expect(new Id<string>('abc').toValue()).toBe('abc')
    expect(new Id<number>(7).toValue()).toBe(7)
  })

  it('stringifies the wrapped value', () => {
    expect(new Id<number>(7).toString()).toBe('7')
    expect(new Id<string>('abc').toString()).toBe('abc')
  })

  describe('equals', () => {
    it('is true for two ids wrapping the same value', () => {
      expect(new Id<string>('abc').equals(new Id<string>('abc'))).toBe(true)
    })

    it('is false for two ids wrapping different values', () => {
      expect(new Id<string>('abc').equals(new Id<string>('def'))).toBe(false)
    })

    it('compares strictly, so 7 and "7" are not equal', () => {
      expect(new Id<number>(7).equals(new Id<string>('7') as unknown as Id<number>)).toBe(false)
    })

    it('is false when compared with undefined', () => {
      expect(new Id<string>('abc').equals(undefined)).toBe(false)
    })

    it('is false when compared with null', () => {
      expect(new Id<string>('abc').equals(null as unknown as Id<string>)).toBe(false)
    })

    it('is false when the other value is not an Id at all', () => {
      expect(new Id<string>('abc').equals({ toValue: () => 'abc' } as unknown as Id<string>)).toBe(false)
    })
  })
})
