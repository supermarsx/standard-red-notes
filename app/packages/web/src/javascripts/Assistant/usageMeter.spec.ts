import { buildMeterModel, formatResetDuration, TokenWindowUsage, WARN_FRACTION, windowFraction } from './usageMeter'

const window = (over: Partial<TokenWindowUsage>): TokenWindowUsage => ({
  usedTokens: 0,
  limitTokens: 0,
  resetsAt: new Date().toISOString(),
  ...over,
})

describe('usageMeter', () => {
  describe('windowFraction', () => {
    it('is undefined when there is no cap (unlimited)', () => {
      expect(windowFraction(window({ usedTokens: 500, limitTokens: 0 }))).toBeUndefined()
    })
    it('clamps to 0..1', () => {
      expect(windowFraction(window({ usedTokens: 50, limitTokens: 100 }))).toBe(0.5)
      expect(windowFraction(window({ usedTokens: 250, limitTokens: 100 }))).toBe(1)
    })
  })

  describe('buildMeterModel', () => {
    it('renders an UNLIMITED window (no fill, ∞ limit)', () => {
      const model = buildMeterModel(window({ usedTokens: 1234, limitTokens: 0 }))
      expect(model.unlimited).toBe(true)
      expect(model.limitLabel).toBe('∞')
      expect(model.valueLabel).toBe('1.2k')
      expect(model.percentLabel).toBe('')
    })

    it('is green/ok well below the warn threshold', () => {
      const model = buildMeterModel(window({ usedTokens: 100, limitTokens: 1000 }))
      expect(model.state).toBe('ok')
      expect(model.percent).toBe(10)
      expect(model.barColorClass).toBe('bg-success')
      expect(model.valueLabel).toBe('100 / 1k')
    })

    it('turns amber at the warn threshold', () => {
      const model = buildMeterModel(window({ usedTokens: WARN_FRACTION * 1000, limitTokens: 1000 }))
      expect(model.state).toBe('warn')
      expect(model.barColorClass).toBe('bg-warning')
    })

    it('turns red at/over the cap', () => {
      const model = buildMeterModel(window({ usedTokens: 1000, limitTokens: 1000 }))
      expect(model.state).toBe('over')
      expect(model.percent).toBe(100)
      expect(model.barColorClass).toBe('bg-danger')
    })

    it('shows an unavailable window (fail-open) muted', () => {
      const model = buildMeterModel(window({ usedTokens: 0, limitTokens: 1000, unavailable: true }))
      expect(model.unavailable).toBe(true)
      expect(model.state).toBe('unavailable')
      expect(model.valueLabel).toBe('Usage unavailable')
    })

    it('treats a missing window as unavailable', () => {
      expect(buildMeterModel(undefined).state).toBe('unavailable')
    })
  })

  describe('formatResetDuration', () => {
    const now = 1_000_000_000_000

    it('returns "now" when already elapsed and "" for bad input', () => {
      expect(formatResetDuration(new Date(now - 5000).toISOString(), now)).toBe('now')
      expect(formatResetDuration('', now)).toBe('')
      expect(formatResetDuration('not-a-date', now)).toBe('')
    })

    it('formats days, hours, minutes and seconds compactly', () => {
      expect(formatResetDuration(new Date(now + 2 * 86_400_000 + 3 * 3_600_000).toISOString(), now)).toBe('2d 3h')
      expect(formatResetDuration(new Date(now + 3 * 3_600_000 + 20 * 60_000).toISOString(), now)).toBe('3h 20m')
      expect(formatResetDuration(new Date(now + 45 * 60_000).toISOString(), now)).toBe('45m')
      expect(formatResetDuration(new Date(now + 30_000).toISOString(), now)).toBe('30s')
    })
  })
})
