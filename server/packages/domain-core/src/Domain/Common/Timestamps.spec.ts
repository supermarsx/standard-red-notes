import { Timestamps } from './Timestamps'

describe('Timestamps', () => {
  it('should create a value object', () => {
    const valueOrError = Timestamps.create(123, 234)

    expect(valueOrError.isFailed()).toBeFalsy()
    expect(valueOrError.getValue().createdAt).toEqual(123)
    expect(valueOrError.getValue().updatedAt).toEqual(234)
  })

  it('should not create an invalid value object', () => {
    const valueOrError = Timestamps.create('' as unknown as number, 123)

    expect(valueOrError.isFailed()).toBeTruthy()
  })

  it('should not create an invalid value object', () => {
    const valueOrError = Timestamps.create(123, '' as unknown as number)

    expect(valueOrError.isFailed()).toBeTruthy()
  })

  describe('edge cases', () => {
    it('should accept zero timestamps', () => {
      const valueOrError = Timestamps.create(0, 0)

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().createdAt).toEqual(0)
    })

    it('should accept negative timestamps (no range check)', () => {
      const valueOrError = Timestamps.create(-1, -2)

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().createdAt).toEqual(-1)
    })

    it('should accept floating-point timestamps', () => {
      const valueOrError = Timestamps.create(1.5, 2.5)

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().createdAt).toEqual(1.5)
    })

    it('should accept Infinity since it is a number and not NaN', () => {
      const valueOrError = Timestamps.create(Infinity, 1)

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().createdAt).toEqual(Infinity)
    })

    it('should reject NaN', () => {
      expect(Timestamps.create(NaN, 1).isFailed()).toBeTruthy()
      expect(Timestamps.create(1, NaN).isFailed()).toBeTruthy()
    })

    it('should reject undefined and null', () => {
      expect(Timestamps.create(undefined as unknown as number, 1).isFailed()).toBeTruthy()
      expect(Timestamps.create(1, null as unknown as number).isFailed()).toBeTruthy()
    })
  })
})
