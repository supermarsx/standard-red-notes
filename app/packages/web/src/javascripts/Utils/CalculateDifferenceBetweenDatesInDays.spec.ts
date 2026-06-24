import { calculateDifferenceBetweenDatesInDays } from './CalculateDifferenceBetweenDatesInDays'

describe('calculateDifferenceBetweenDatesInDays', () => {
  it('returns 0 for the same calendar day regardless of time of day', () => {
    const morning = new Date(2024, 0, 15, 1, 0, 0)
    const evening = new Date(2024, 0, 15, 23, 59, 59)
    expect(calculateDifferenceBetweenDatesInDays(morning, evening)).toBe(0)
  })

  it('returns the positive day difference when the first date is later', () => {
    const later = new Date(2024, 0, 20)
    const earlier = new Date(2024, 0, 15)
    expect(calculateDifferenceBetweenDatesInDays(later, earlier)).toBe(5)
  })

  it('returns a negative difference when the first date is earlier', () => {
    const earlier = new Date(2024, 0, 15)
    const later = new Date(2024, 0, 20)
    expect(calculateDifferenceBetweenDatesInDays(earlier, later)).toBe(-5)
  })

  it('ignores the time-of-day component when computing whole days', () => {
    // 1 day 23h apart still rounds to a 2-calendar-day difference because the
    // helper truncates each date to UTC midnight before subtracting.
    const a = new Date(2024, 0, 17, 1, 0, 0)
    const b = new Date(2024, 0, 15, 23, 0, 0)
    expect(calculateDifferenceBetweenDatesInDays(a, b)).toBe(2)
  })

  it('spans month boundaries correctly', () => {
    const feb2 = new Date(2024, 1, 2)
    const jan30 = new Date(2024, 0, 30)
    expect(calculateDifferenceBetweenDatesInDays(feb2, jan30)).toBe(3)
  })

  it('counts the leap day across a leap-year February', () => {
    const mar1 = new Date(2024, 2, 1)
    const feb28 = new Date(2024, 1, 28)
    expect(calculateDifferenceBetweenDatesInDays(mar1, feb28)).toBe(2)
  })

  describe('edge cases', () => {
    it('returns 0 for the exact same instant', () => {
      const instant = new Date(2024, 5, 15, 9, 30, 15, 250)
      expect(calculateDifferenceBetweenDatesInDays(instant, instant)).toBe(0)
    })

    it('returns 0 for two instants on the same day a fraction of a second apart', () => {
      const a = new Date(2024, 5, 15, 12, 0, 0, 0)
      const b = new Date(2024, 5, 15, 12, 0, 0, 999)
      expect(calculateDifferenceBetweenDatesInDays(a, b)).toBe(0)
    })

    it('returns exactly 1 for consecutive calendar days (one-unit boundary)', () => {
      const jan16 = new Date(2024, 0, 16)
      const jan15 = new Date(2024, 0, 15)
      expect(calculateDifferenceBetweenDatesInDays(jan16, jan15)).toBe(1)
    })

    it('returns 7 for an exact week apart', () => {
      const jan22 = new Date(2024, 0, 22)
      const jan15 = new Date(2024, 0, 15)
      expect(calculateDifferenceBetweenDatesInDays(jan22, jan15)).toBe(7)
    })

    it('spans a year boundary correctly', () => {
      const jan2 = new Date(2025, 0, 2)
      const dec31 = new Date(2024, 11, 31)
      expect(calculateDifferenceBetweenDatesInDays(jan2, dec31)).toBe(2)
    })

    it('counts a full leap year (2024) as 366 days', () => {
      const start = new Date(2024, 0, 1)
      const end = new Date(2025, 0, 1)
      expect(calculateDifferenceBetweenDatesInDays(end, start)).toBe(366)
    })

    it('counts a full common year (2023) as 365 days', () => {
      const start = new Date(2023, 0, 1)
      const end = new Date(2024, 0, 1)
      expect(calculateDifferenceBetweenDatesInDays(end, start)).toBe(365)
    })

    it('handles a multi-decade gap', () => {
      // 1970-01-01 to 2024-01-01: 54 years including 13 leap days (1972..2020)
      // => 54 * 365 + 13 = 19723 days.
      const epoch = new Date(1970, 0, 1)
      const y2024 = new Date(2024, 0, 1)
      expect(calculateDifferenceBetweenDatesInDays(y2024, epoch)).toBe(19723)
    })

    it('is insensitive to the time-of-day when the calendar dates differ by one', () => {
      // First date earlier in the clock-day but on a later calendar day still
      // yields a 1-day difference because each date is floored to UTC midnight.
      const lateNight = new Date(2024, 0, 16, 0, 0, 1)
      const earlyEvening = new Date(2024, 0, 15, 23, 59, 59)
      expect(calculateDifferenceBetweenDatesInDays(lateNight, earlyEvening)).toBe(1)
    })
  })
})
