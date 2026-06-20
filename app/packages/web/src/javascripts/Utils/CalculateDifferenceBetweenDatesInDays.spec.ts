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
})
