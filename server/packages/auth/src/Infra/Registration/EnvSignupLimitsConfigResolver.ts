import {
  DEFAULT_SIGNUP_LIMITS,
  normalizeSignupLimits,
  SignupLimitsConfig,
  SignupLimitsConfigOverlay,
} from '../../Domain/Registration/SignupLimitsConfig'
import { SignupLimitsConfigResolverInterface } from '../../Domain/Registration/SignupLimitsConfigResolverInterface'

/**
 * Resolves the effective signup-cap policy by layering the persisted admin
 * overlay (`registration.signupsPer*`, read from the shared ServerSettings JSON
 * file) on top of the env-derived baseline: persisted -> env -> default.
 *
 * The overlay getter is a thunk so an admin change takes effect on the next
 * registration without a restart. It must never throw; any failure yields the
 * baseline. The resolved config is always VALID (caps normalized to non-negative
 * integers in range, windows clamped to [1, 168]h).
 */
export class EnvSignupLimitsConfigResolver implements SignupLimitsConfigResolverInterface {
  constructor(
    private baseline: SignupLimitsConfig,
    private overlayGetter: () => Promise<SignupLimitsConfigOverlay | undefined>,
  ) {}

  async resolve(): Promise<SignupLimitsConfig> {
    let overlay: SignupLimitsConfigOverlay | undefined
    try {
      overlay = await this.overlayGetter()
    } catch {
      overlay = undefined
    }

    return normalizeSignupLimits({
      perIpMax: overlay?.perIpMax ?? this.baseline.perIpMax,
      perIpWindowHours: overlay?.perIpWindowHours ?? this.baseline.perIpWindowHours,
      perWeekMax: overlay?.perWeekMax ?? this.baseline.perWeekMax,
      perDeviceMax: overlay?.perDeviceMax ?? this.baseline.perDeviceMax,
      perDeviceWindowHours: overlay?.perDeviceWindowHours ?? this.baseline.perDeviceWindowHours,
    })
  }
}

/** Parses a raw env string into a number, or undefined when unset/blank/NaN. */
const parseEnvNumber = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const parsed = Number(raw)

  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Builds the env baseline (REGISTRATION_SIGNUPS_PER_* env vars) into a valid
 * SignupLimitsConfig, applying the same normalization as the resolver so an
 * invalid env never leaks through. An absent value falls back to the hardcoded
 * default (cap off / 24h window). Env var names mirror the gateway (plan §3.2).
 */
export const signupLimitsBaselineFromEnv = (raw: {
  perIpMax?: string
  perIpWindowHours?: string
  perWeekMax?: string
  perDeviceMax?: string
  perDeviceWindowHours?: string
}): SignupLimitsConfig =>
  normalizeSignupLimits({
    perIpMax: parseEnvNumber(raw.perIpMax) ?? DEFAULT_SIGNUP_LIMITS.perIpMax,
    perIpWindowHours: parseEnvNumber(raw.perIpWindowHours) ?? DEFAULT_SIGNUP_LIMITS.perIpWindowHours,
    perWeekMax: parseEnvNumber(raw.perWeekMax) ?? DEFAULT_SIGNUP_LIMITS.perWeekMax,
    perDeviceMax: parseEnvNumber(raw.perDeviceMax) ?? DEFAULT_SIGNUP_LIMITS.perDeviceMax,
    perDeviceWindowHours: parseEnvNumber(raw.perDeviceWindowHours) ?? DEFAULT_SIGNUP_LIMITS.perDeviceWindowHours,
  })
