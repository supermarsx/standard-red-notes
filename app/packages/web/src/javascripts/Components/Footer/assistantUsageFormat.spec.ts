import {
  buildChipModel,
  capFraction,
  formatTokens,
  isAtLimit,
  isNearLimit,
  NEAR_LIMIT_THRESHOLD,
} from './assistantUsageFormat'

describe('formatTokens', () => {
  it('shows exact counts below 1000', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses k above 1000 with one decimal, trimming .0', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(12345)).toBe('12.3k')
    expect(formatTokens(1500)).toBe('1.5k')
  })

  it('uses M above one million', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })

  it('clamps and rounds defensively', () => {
    expect(formatTokens(-10)).toBe('0')
    expect(formatTokens(1234.7)).toBe('1.2k')
  })
})

describe('capFraction', () => {
  it('returns the consumed fraction', () => {
    expect(capFraction({ used: 50, limit: 100 })).toBe(0.5)
  })

  it('clamps to [0,1]', () => {
    expect(capFraction({ used: 150, limit: 100 })).toBe(1)
    expect(capFraction({ used: -5, limit: 100 })).toBe(0)
  })

  it('returns undefined when there is no cap', () => {
    expect(capFraction(null)).toBeUndefined()
    expect(capFraction(undefined)).toBeUndefined()
    expect(capFraction({ used: 5, limit: 0 })).toBeUndefined()
  })
})

describe('isNearLimit', () => {
  it('is true at or above the threshold', () => {
    expect(isNearLimit({ used: 80, limit: 100 })).toBe(true)
    expect(isNearLimit({ used: 95, limit: 100 })).toBe(true)
  })

  it('is false below the threshold', () => {
    expect(isNearLimit({ used: 79, limit: 100 })).toBe(false)
  })

  it('respects a custom threshold', () => {
    expect(isNearLimit({ used: 50, limit: 100 }, 0.5)).toBe(true)
    expect(isNearLimit({ used: 49, limit: 100 }, 0.5)).toBe(false)
  })

  it('never warns without a cap', () => {
    expect(isNearLimit(null)).toBe(false)
    expect(isNearLimit({ used: 999, limit: 0 })).toBe(false)
  })

  it('default threshold is 0.8', () => {
    expect(NEAR_LIMIT_THRESHOLD).toBe(0.8)
  })
})

describe('isAtLimit', () => {
  it('is true when used >= limit', () => {
    expect(isAtLimit({ used: 100, limit: 100 })).toBe(true)
    expect(isAtLimit({ used: 101, limit: 100 })).toBe(true)
  })

  it('is false below the limit or with no cap', () => {
    expect(isAtLimit({ used: 99, limit: 100 })).toBe(false)
    expect(isAtLimit(null)).toBe(false)
    expect(isAtLimit({ used: 5, limit: 0 })).toBe(false)
  })
})

describe('buildChipModel', () => {
  it('hides the chip when AI is unused and there is no cap', () => {
    expect(buildChipModel(0, 0, null)).toEqual({ label: '', visible: false, warn: false })
  })

  it('shows session tokens when there is no server cap', () => {
    const model = buildChipModel(12345, 3, null)
    expect(model.visible).toBe(true)
    expect(model.label).toBe('AI: 12.3k tokens')
    expect(model.warn).toBe(false)
  })

  it('leads with used/limit requests when a cap is configured', () => {
    const model = buildChipModel(5000, 8, { used: 8, limit: 100 })
    expect(model.label).toBe('AI: 8 / 100')
    expect(model.visible).toBe(true)
  })

  it('warns near the cap', () => {
    const model = buildChipModel(0, 90, { used: 90, limit: 100 })
    expect(model.warn).toBe(true)
  })

  it('is visible when a cap exists even before any session usage', () => {
    const model = buildChipModel(0, 0, { used: 0, limit: 100 })
    expect(model.visible).toBe(true)
    expect(model.label).toBe('AI: 0 / 100')
  })

  it('shows tokens when only requests (no tokens) were recorded', () => {
    const model = buildChipModel(0, 2, null)
    expect(model.visible).toBe(true)
    expect(model.label).toBe('AI: 0 tokens')
  })
})
