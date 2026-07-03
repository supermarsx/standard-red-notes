import {
  buildWindowUsage,
  estimateTokensFromText,
  FIVE_HOUR_WINDOW_MS,
  isOverTokenLimit,
  oldestTimestampInWindow,
  sumTokensInWindow,
  TokenUsageEntry,
  unavailableWindowUsage,
  WEEKLY_WINDOW_MS,
  windowLabel,
  windowResetsAt,
} from './tokenMetering'

describe('tokenMetering', () => {
  const now = 1_000_000_000_000 // fixed reference instant

  const entry = (offsetMs: number, tokens: number): TokenUsageEntry => ({ ts: now - offsetMs, tokens })

  describe('sumTokensInWindow', () => {
    it('sums only entries inside the rolling window', () => {
      const entries = [
        entry(0, 100), // now
        entry(FIVE_HOUR_WINDOW_MS - 1, 50), // just inside 5h
        entry(FIVE_HOUR_WINDOW_MS + 1, 999), // just outside 5h
      ]
      expect(sumTokensInWindow(entries, now, FIVE_HOUR_WINDOW_MS)).toBe(150)
      // The same entries all sit inside the weekly window.
      expect(sumTokensInWindow(entries, now, WEEKLY_WINDOW_MS)).toBe(1149)
    })

    it('ignores negative token entries and returns 0 for an empty set', () => {
      expect(sumTokensInWindow([], now, FIVE_HOUR_WINDOW_MS)).toBe(0)
      expect(sumTokensInWindow([entry(0, -5)], now, FIVE_HOUR_WINDOW_MS)).toBe(0)
    })
  })

  describe('oldestTimestampInWindow / windowResetsAt', () => {
    it('finds the oldest in-window entry and derives the reset time from it', () => {
      const entries = [entry(60_000, 10), entry(120_000, 10), entry(FIVE_HOUR_WINDOW_MS + 5, 10)]
      const oldest = oldestTimestampInWindow(entries, now, FIVE_HOUR_WINDOW_MS)
      expect(oldest).toBe(now - 120_000)
      expect(windowResetsAt(entries, now, FIVE_HOUR_WINDOW_MS)).toBe(now - 120_000 + FIVE_HOUR_WINDOW_MS)
    })

    it('resets at `now` when the window is empty', () => {
      expect(oldestTimestampInWindow([], now, FIVE_HOUR_WINDOW_MS)).toBeUndefined()
      expect(windowResetsAt([], now, FIVE_HOUR_WINDOW_MS)).toBe(now)
    })
  })

  describe('isOverTokenLimit', () => {
    it('treats 0/unset as unlimited', () => {
      expect(isOverTokenLimit(1_000_000, 0)).toBe(false)
    })
    it('is over once used reaches the positive limit', () => {
      expect(isOverTokenLimit(99, 100)).toBe(false)
      expect(isOverTokenLimit(100, 100)).toBe(true)
      expect(isOverTokenLimit(101, 100)).toBe(true)
    })
  })

  describe('estimateTokensFromText', () => {
    it('approximates ~4 chars per token and handles empties', () => {
      expect(estimateTokensFromText('')).toBe(0)
      expect(estimateTokensFromText('abcd')).toBe(1)
      expect(estimateTokensFromText('abcde')).toBe(2)
    })
  })

  describe('buildWindowUsage', () => {
    it('reports used, limit and an ISO reset time', () => {
      const entries = [entry(60_000, 40), entry(30_000, 60)]
      const usage = buildWindowUsage(entries, now, FIVE_HOUR_WINDOW_MS, 1000)
      expect(usage.usedTokens).toBe(100)
      expect(usage.limitTokens).toBe(1000)
      expect(usage.resetsAt).toBe(new Date(now - 60_000 + FIVE_HOUR_WINDOW_MS).toISOString())
      expect(usage.unavailable).toBeUndefined()
    })

    it('normalises a non-positive limit to 0 (unlimited)', () => {
      expect(buildWindowUsage([], now, WEEKLY_WINDOW_MS, -1).limitTokens).toBe(0)
    })
  })

  describe('unavailableWindowUsage (fail-open)', () => {
    it('reports 0 used and flags unavailable so callers do not block', () => {
      const usage = unavailableWindowUsage(now, FIVE_HOUR_WINDOW_MS, 500)
      expect(usage.usedTokens).toBe(0)
      expect(usage.limitTokens).toBe(500)
      expect(usage.unavailable).toBe(true)
    })
  })

  describe('windowLabel', () => {
    it('names each window for the rejection message', () => {
      expect(windowLabel('fiveHour')).toBe('rolling 5-hour')
      expect(windowLabel('weekly')).toBe('weekly')
    })
  })
})
