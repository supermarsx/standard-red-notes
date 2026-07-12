import { DEFAULT_SIGNUP_LIMITS, SignupLimitsConfig } from '../../Domain/Registration/SignupLimitsConfig'
import { EnvSignupLimitsConfigResolver, signupLimitsBaselineFromEnv } from './EnvSignupLimitsConfigResolver'

describe('EnvSignupLimitsConfigResolver', () => {
  const baseline: SignupLimitsConfig = {
    perIpMax: 2,
    perIpWindowHours: 12,
    perWeekMax: 50,
    perDeviceMax: 3,
    perDeviceWindowHours: 6,
  }

  it('returns the (normalized) baseline when there is no overlay', async () => {
    const resolver = new EnvSignupLimitsConfigResolver(baseline, () => Promise.resolve(undefined))

    expect(await resolver.resolve()).toEqual(baseline)
  })

  it('lets the persisted overlay win over the env baseline (per field)', async () => {
    const resolver = new EnvSignupLimitsConfigResolver(baseline, () =>
      Promise.resolve({ perIpMax: 10, perWeekMax: 500 }),
    )

    expect(await resolver.resolve()).toEqual({
      perIpMax: 10,
      perIpWindowHours: 12,
      perWeekMax: 500,
      perDeviceMax: 3,
      perDeviceWindowHours: 6,
    })
  })

  it('normalizes out-of-range / invalid overlay values (negative caps -> 0, windows clamped)', async () => {
    const resolver = new EnvSignupLimitsConfigResolver(baseline, () =>
      Promise.resolve({ perIpMax: -5, perIpWindowHours: 9999, perWeekMax: 2_000_000, perDeviceWindowHours: 0 }),
    )

    expect(await resolver.resolve()).toEqual({
      // negative -> unlimited/off; 9999 -> clamped to the 7-day (168h) max;
      // 2,000,000 -> clamped to the per-week cap; 0 -> below the 1h min -> 1.
      perIpMax: 0,
      perIpWindowHours: 168,
      perWeekMax: 1_000_000,
      perDeviceMax: 3,
      perDeviceWindowHours: 1,
    })
  })

  it('degrades to the baseline when the overlay getter throws', async () => {
    const resolver = new EnvSignupLimitsConfigResolver(baseline, () => Promise.reject(new Error('unreadable')))

    expect(await resolver.resolve()).toEqual(baseline)
  })

  describe('signupLimitsBaselineFromEnv', () => {
    it('parses a valid env baseline', () => {
      expect(
        signupLimitsBaselineFromEnv({
          perIpMax: '5',
          perIpWindowHours: '48',
          perWeekMax: '100',
          perDeviceMax: '2',
          perDeviceWindowHours: '24',
        }),
      ).toEqual({
        perIpMax: 5,
        perIpWindowHours: 48,
        perWeekMax: 100,
        perDeviceMax: 2,
        perDeviceWindowHours: 24,
      })
    })

    it('falls back to the all-off default for absent/blank/NaN env', () => {
      expect(
        signupLimitsBaselineFromEnv({ perIpMax: undefined, perWeekMax: '', perDeviceMax: 'not-a-number' }),
      ).toEqual(DEFAULT_SIGNUP_LIMITS)
    })

    it('normalizes a negative env cap to 0 (unlimited)', () => {
      expect(signupLimitsBaselineFromEnv({ perWeekMax: '-3' }).perWeekMax).toBe(0)
    })
  })
})
