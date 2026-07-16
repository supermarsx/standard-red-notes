import { clampSignupMax, clampSignupWindowHours, normalizeSignupLimits } from './SignupLimitsConfig'

describe('SignupLimitsConfig helpers', () => {
  describe('clampSignupMax', () => {
    it('fails open for non-numeric, non-finite, and non-positive values', () => {
      expect(clampSignupMax('10', 100)).toBe(0)
      expect(clampSignupMax(Number.NaN, 100)).toBe(0)
      expect(clampSignupMax(Number.POSITIVE_INFINITY, 100)).toBe(0)
      expect(clampSignupMax(0, 100)).toBe(0)
      expect(clampSignupMax(-10, 100)).toBe(0)
    })

    it('floors fractional values and enforces the supplied upper bound', () => {
      expect(clampSignupMax(10.9, 100)).toBe(10)
      expect(clampSignupMax(101, 100)).toBe(100)
    })
  })

  describe('clampSignupWindowHours', () => {
    it('uses the 24-hour default for non-numeric or non-finite values', () => {
      expect(clampSignupWindowHours(undefined)).toBe(24)
      expect(clampSignupWindowHours(Number.NaN)).toBe(24)
    })

    it('floors and clamps windows to the supported one-hour to seven-day range', () => {
      expect(clampSignupWindowHours(0)).toBe(1)
      expect(clampSignupWindowHours(12.9)).toBe(12)
      expect(clampSignupWindowHours(169)).toBe(168)
    })
  })

  it('normalizes every independent cap and window', () => {
    expect(
      normalizeSignupLimits({
        perIpMax: 100_001,
        perIpWindowHours: 0,
        perWeekMax: 1_000_001,
        perDeviceMax: -1,
        perDeviceWindowHours: 200,
      }),
    ).toEqual({
      perIpMax: 100_000,
      perIpWindowHours: 1,
      perWeekMax: 1_000_000,
      perDeviceMax: 0,
      perDeviceWindowHours: 168,
    })
  })
})
