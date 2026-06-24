import { addDaysToDate } from '@standardnotes/utils'
import {
  addCalendarMonths,
  areDatesInSameDay,
  areDatesInSameMonth,
  numberOfMonthsBetweenDates,
  numDaysBetweenDates,
  numHoursBetweenDates,
} from './DateUtils'

describe('date utils', () => {
  describe('numDaysBetweenDates', () => {
    it('should return full days diff accurately', () => {
      const today = new Date()

      expect(numDaysBetweenDates(today, addDaysToDate(today, 1))).toEqual(1)
      expect(numDaysBetweenDates(today, addDaysToDate(today, 2))).toEqual(2)
      expect(numDaysBetweenDates(today, addDaysToDate(today, 3))).toEqual(3)
    })

    it('should return absolute value of difference', () => {
      const today = new Date()

      expect(numDaysBetweenDates(today, addDaysToDate(today, 3))).toEqual(3)
      expect(numDaysBetweenDates(addDaysToDate(today, 3), today)).toEqual(3)
    })

    it('should return 1 day difference between two dates on different days but 1 hour apart', () => {
      const today = new Date()
      const oneHourBeforeMidnight = new Date()
      oneHourBeforeMidnight.setHours(0, 0, 0, 0)
      oneHourBeforeMidnight.setHours(-1, 0, 0, 0)

      expect(today.toDateString()).not.toEqual(oneHourBeforeMidnight.toDateString())
      expect(numDaysBetweenDates(today, oneHourBeforeMidnight)).toEqual(1)
    })

    describe('edge cases', () => {
      it('returns 0 for the exact same instant', () => {
        const instant = new Date(2024, 5, 15, 9, 30, 0)
        expect(numDaysBetweenDates(instant, instant)).toEqual(0)
      })

      it('returns 0 for two instants on the same calendar day a few hours apart', () => {
        const morning = new Date(2024, 5, 15, 1, 0, 0)
        const evening = new Date(2024, 5, 15, 23, 0, 0)
        expect(numDaysBetweenDates(morning, evening)).toEqual(0)
      })

      it('floors a 1-day-23-hours gap (within the same calendar days) to 1', () => {
        const a = new Date(2024, 5, 17, 1, 0, 0)
        const b = new Date(2024, 5, 15, 2, 0, 0)
        expect(numDaysBetweenDates(a, b)).toEqual(1)
      })

      it('spans a leap day correctly', () => {
        const feb28 = new Date(2024, 1, 28, 12, 0, 0)
        const mar1 = new Date(2024, 2, 1, 12, 0, 0)
        expect(numDaysBetweenDates(mar1, feb28)).toEqual(2)
      })
    })
  })

  describe('numHoursBetweenDates', () => {
    it('returns 0 for the same instant', () => {
      const instant = new Date(2024, 0, 1, 0, 0, 0)
      expect(numHoursBetweenDates(instant, instant)).toBe(0)
    })

    it('returns the absolute fractional hours regardless of argument order', () => {
      const a = new Date(2024, 0, 1, 0, 0, 0)
      const b = new Date(2024, 0, 1, 1, 30, 0)
      expect(numHoursBetweenDates(a, b)).toBe(1.5)
      expect(numHoursBetweenDates(b, a)).toBe(1.5)
    })

    it('handles a multi-day gap as a large hour count', () => {
      const a = new Date(2024, 0, 1, 0, 0, 0)
      const b = new Date(2024, 0, 6, 0, 0, 0)
      expect(numHoursBetweenDates(a, b)).toBe(120)
    })
  })

  describe('areDatesInSameDay', () => {
    it('is true for two distinct times on the same calendar day', () => {
      const morning = new Date(2024, 1, 29, 0, 0, 1)
      const night = new Date(2024, 1, 29, 23, 59, 59)
      expect(areDatesInSameDay(morning, night)).toBe(true)
    })

    it('is false across a midnight boundary into the next day', () => {
      const lastSecond = new Date(2024, 0, 15, 23, 59, 59)
      const firstSecond = new Date(2024, 0, 16, 0, 0, 0)
      expect(areDatesInSameDay(lastSecond, firstSecond)).toBe(false)
    })
  })

  describe('areDatesInSameMonth', () => {
    it('is true for the first and the leap day of the same February', () => {
      expect(areDatesInSameMonth(new Date(2024, 1, 1), new Date(2024, 1, 29))).toBe(true)
    })

    it('is false for the same month number in different years', () => {
      expect(areDatesInSameMonth(new Date(2023, 1, 1), new Date(2024, 1, 1))).toBe(false)
    })

    it('is false across a month boundary in the same year', () => {
      expect(areDatesInSameMonth(new Date(2024, 0, 31), new Date(2024, 1, 1))).toBe(false)
    })
  })

  describe('addCalendarMonths', () => {
    it('returns the first day of the offset month', () => {
      const result = addCalendarMonths(new Date(2024, 0, 15), 1)
      expect(result.getFullYear()).toBe(2024)
      expect(result.getMonth()).toBe(1)
      expect(result.getDate()).toBe(1)
    })

    it('normalizes Jan 31 + 1 month to Feb 1 (no day overflow)', () => {
      const result = addCalendarMonths(new Date(2024, 0, 31), 1)
      expect(result.getMonth()).toBe(1)
      expect(result.getDate()).toBe(1)
    })

    it('wraps forward across a year boundary', () => {
      const result = addCalendarMonths(new Date(2024, 11, 15), 1)
      expect(result.getFullYear()).toBe(2025)
      expect(result.getMonth()).toBe(0)
      expect(result.getDate()).toBe(1)
    })

    it('wraps backward across a year boundary for negative offsets', () => {
      const result = addCalendarMonths(new Date(2024, 0, 15), -2)
      expect(result.getFullYear()).toBe(2023)
      expect(result.getMonth()).toBe(10)
      expect(result.getDate()).toBe(1)
    })

    it('does not mutate the input date', () => {
      const input = new Date(2024, 0, 15)
      addCalendarMonths(input, 3)
      expect(input.getMonth()).toBe(0)
      expect(input.getDate()).toBe(15)
    })
  })

  describe('numberOfMonthsBetweenDates', () => {
    it('returns 0 for the same date', () => {
      const date = new Date(2024, 0, 1)
      expect(numberOfMonthsBetweenDates(date, date)).toBe(0)
    })

    it('returns 1 for exactly one month apart on the same day-of-month', () => {
      expect(numberOfMonthsBetweenDates(new Date(2024, 0, 1), new Date(2024, 1, 1))).toBe(1)
    })

    it('returns 12 for exactly one year apart', () => {
      expect(numberOfMonthsBetweenDates(new Date(2023, 0, 1), new Date(2024, 0, 1))).toBe(12)
    })

    it('rounds a fractional partial month up by default', () => {
      expect(numberOfMonthsBetweenDates(new Date(2024, 0, 1), new Date(2024, 0, 15))).toBe(1)
    })

    it('does not round a fractional partial month up when rounding is disabled', () => {
      expect(numberOfMonthsBetweenDates(new Date(2024, 0, 1), new Date(2024, 0, 15), false)).toBe(0)
    })

    it('returns a negative count when the first date is later (inverse)', () => {
      expect(numberOfMonthsBetweenDates(new Date(2024, 1, 1), new Date(2024, 0, 1))).toBe(-1)
    })
  })
})
