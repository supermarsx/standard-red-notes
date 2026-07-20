import { addDaysToDate, addHoursToDate, addMonthsToDate, addYearsToDate } from './DateUtils'

const base = () => new Date('2022-03-15T10:30:00.000Z')

describe('DateUtils', () => {
  describe('addHoursToDate', () => {
    it('should add the hours', () => {
      expect(addHoursToDate(base(), 3).getTime() - base().getTime()).toBe(3 * 60 * 60 * 1000)
    })

    it('should subtract for a negative amount', () => {
      expect(addHoursToDate(base(), -3).getTime() - base().getTime()).toBe(-3 * 60 * 60 * 1000)
    })

    it('should not mutate the input date', () => {
      const date = base()
      addHoursToDate(date, 5)
      expect(date.getTime()).toBe(base().getTime())
    })
  })

  describe('addDaysToDate', () => {
    it('should add the days', () => {
      expect(addDaysToDate(base(), 2).getTime() - base().getTime()).toBe(2 * 24 * 60 * 60 * 1000)
    })

    it('should subtract for a negative amount', () => {
      expect(addDaysToDate(base(), -2).getTime() - base().getTime()).toBe(-2 * 24 * 60 * 60 * 1000)
    })

    it('should not mutate the input date', () => {
      const date = base()
      addDaysToDate(date, 10)
      expect(date.getTime()).toBe(base().getTime())
    })
  })

  describe('addMonthsToDate', () => {
    it('should advance the calendar month', () => {
      const result = addMonthsToDate(base(), 2)
      expect(result.getMonth()).toBe((base().getMonth() + 2) % 12)
    })

    it('should roll over into the next year', () => {
      const result = addMonthsToDate(new Date('2022-11-15T10:30:00.000Z'), 3)
      expect(result.getFullYear()).toBe(2023)
    })

    it('should not mutate the input date', () => {
      const date = base()
      addMonthsToDate(date, 4)
      expect(date.getTime()).toBe(base().getTime())
    })
  })

  describe('addYearsToDate', () => {
    it('should advance the year', () => {
      expect(addYearsToDate(base(), 3).getFullYear()).toBe(base().getFullYear() + 3)
    })

    it('should go back for a negative amount', () => {
      expect(addYearsToDate(base(), -3).getFullYear()).toBe(base().getFullYear() - 3)
    })

    it('should not mutate the input date', () => {
      const date = base()
      addYearsToDate(date, 1)
      expect(date.getTime()).toBe(base().getTime())
    })
  })
})
