import { getRelativeTimeString } from './GetRelativeTimeString'

describe('getRelativeTimeString', () => {
  // dayjs().fromNow() is computed relative to the current time, so we freeze the
  // clock to a fixed instant for deterministic assertions.
  const NOW = new Date('2024-06-15T12:00:00.000Z').getTime()

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const ago = (ms: number) => getRelativeTimeString(new Date(NOW - ms))
  const ahead = (ms: number) => getRelativeTimeString(new Date(NOW + ms))

  const SECOND = 1000
  const MINUTE = 60 * SECOND
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  describe('seconds', () => {
    it('reports the same instant as "0s ago"', () => {
      expect(getRelativeTimeString(new Date(NOW))).toBe('0s ago')
    })

    it('rounds a sub-second (500ms) difference up to "1s ago"', () => {
      expect(ago(500)).toBe('1s ago')
    })

    it('formats whole seconds with the %ds pattern', () => {
      expect(ago(5 * SECOND)).toBe('5s ago')
    })

    it('still reports seconds at the 44s upper threshold', () => {
      expect(ago(44 * SECOND)).toBe('44s ago')
    })
  })

  describe('minute boundary', () => {
    it('switches to "a minute ago" at 45 seconds', () => {
      expect(ago(45 * SECOND)).toBe('a minute ago')
    })

    it('uses the singular "a minute ago" for exactly one minute', () => {
      expect(ago(MINUTE)).toBe('a minute ago')
    })

    it('uses the plural "minutes" wording past the singular threshold', () => {
      expect(ago(90 * SECOND)).toBe('2 minutes ago')
    })
  })

  describe('hour boundary', () => {
    it('uses the singular "an hour ago" for exactly one hour', () => {
      expect(ago(HOUR)).toBe('an hour ago')
    })

    it('uses the plural "hours" wording for multiple hours', () => {
      expect(ago(3 * HOUR)).toBe('3 hours ago')
    })
  })

  describe('day boundary', () => {
    it('uses the singular "a day ago" for exactly one day', () => {
      expect(ago(DAY)).toBe('a day ago')
    })

    it('reports a week as "7 days ago" (no dedicated week unit)', () => {
      expect(ago(7 * DAY)).toBe('7 days ago')
    })

    it('still reports days at the 25-day upper threshold', () => {
      expect(ago(25 * DAY)).toBe('25 days ago')
    })
  })

  describe('month boundary', () => {
    it('switches to "a month ago" at 26 days', () => {
      expect(ago(26 * DAY)).toBe('a month ago')
    })

    it('keeps the singular "a month ago" at 45 days', () => {
      expect(ago(45 * DAY)).toBe('a month ago')
    })

    it('uses the plural "months" wording at 46 days', () => {
      expect(ago(46 * DAY)).toBe('2 months ago')
    })
  })

  describe('year boundary', () => {
    it('uses the singular "a year ago" near 365 days', () => {
      expect(ago(365 * DAY)).toBe('a year ago')
    })

    it('uses the plural "years" wording for a multi-decade gap', () => {
      expect(ago(3650 * DAY)).toBe('10 years ago')
    })

    it('describes the unix epoch relative to the frozen 2024 clock', () => {
      expect(getRelativeTimeString(new Date(0))).toBe('54 years ago')
    })
  })

  describe('future dates', () => {
    it('uses the "in %s" future prefix for seconds', () => {
      expect(ahead(5 * SECOND)).toBe('in 5s')
    })

    it('uses the singular "in a day" for exactly one day ahead', () => {
      expect(ahead(DAY)).toBe('in a day')
    })

    it('uses the "in" prefix with plural wording for multiple months ahead', () => {
      expect(ahead(46 * DAY)).toBe('in 2 months')
    })
  })

  describe('input parsing edge cases', () => {
    it('accepts a numeric (millisecond) timestamp', () => {
      expect(getRelativeTimeString(NOW - 5 * SECOND)).toBe('5s ago')
    })

    it('accepts an ISO date string', () => {
      expect(getRelativeTimeString('2024-06-15T11:59:55.000Z')).toBe('5s ago')
    })

    it('treats undefined input as "now" (dayjs default)', () => {
      expect(getRelativeTimeString(undefined)).toBe('0s ago')
    })

    // Surprising behavior: dayjs(null) and dayjs(invalid) both produce an
    // Invalid Date whose .fromNow() falls back to "a month ago" rather than
    // throwing or returning "Invalid Date". Asserting the ACTUAL behavior.
    it('falls back to "a month ago" for null input (Invalid Date)', () => {
      expect(getRelativeTimeString(null as unknown as undefined)).toBe('a month ago')
    })

    it('falls back to "a month ago" for an unparseable date string (Invalid Date)', () => {
      expect(getRelativeTimeString('not-a-real-date')).toBe('a month ago')
    })

    it('falls back to "a month ago" for an Invalid Date object', () => {
      expect(getRelativeTimeString(new Date('not-a-real-date'))).toBe('a month ago')
    })
  })
})
