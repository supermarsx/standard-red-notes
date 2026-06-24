import { Dates } from './Dates'

describe('Dates', () => {
  it('should create a value object', () => {
    const valueOrError = Dates.create(new Date(1), new Date(2))

    expect(valueOrError.isFailed()).toBeFalsy()
    expect(valueOrError.getValue().createdAt).toEqual(new Date(1))
    expect(valueOrError.getValue().updatedAt).toEqual(new Date(2))
  })

  it('should not create an invalid value object', () => {
    let valueOrError = Dates.create(null as unknown as Date, '2' as unknown as Date)

    expect(valueOrError.isFailed()).toBeTruthy()

    valueOrError = Dates.create(new Date(2), '2' as unknown as Date)

    expect(valueOrError.isFailed()).toBeTruthy()
  })

  describe('edge cases', () => {
    it('should accept the epoch date (new Date(0))', () => {
      const valueOrError = Dates.create(new Date(0), new Date(0))

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().createdAt).toEqual(new Date(0))
    })

    it('should accept an Invalid Date object (still an instanceof Date)', () => {
      const valueOrError = Dates.create(new Date('not-a-date'), new Date(2))

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(isNaN(valueOrError.getValue().createdAt.getTime())).toBeTruthy()
    })

    it('should reject a numeric timestamp passed as createdAt', () => {
      expect(Dates.create(123 as unknown as Date, new Date(2)).isFailed()).toBeTruthy()
    })

    it('should reject undefined dates', () => {
      expect(Dates.create(undefined as unknown as Date, new Date(2)).isFailed()).toBeTruthy()
      expect(Dates.create(new Date(2), undefined as unknown as Date).isFailed()).toBeTruthy()
    })
  })
})
