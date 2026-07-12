import { SignupLimitsConfig } from './SignupLimitsConfig'

/**
 * Resolves the effective signup-cap policy for the current registration.
 * Implementations MUST layer persisted (admin) overrides on top of the env
 * baseline (persisted -> env -> default), MUST return a validated/normalized
 * config (non-negative integer caps in range, valid windows) and MUST never
 * throw — a resolver failure degrades to the default (all caps off).
 */
export interface SignupLimitsConfigResolverInterface {
  resolve(): Promise<SignupLimitsConfig>
}
