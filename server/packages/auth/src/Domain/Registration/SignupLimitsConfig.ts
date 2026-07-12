/**
 * Standard Red Notes: runtime-configurable SIGNUP CAP policy (admin-set via the
 * gateway ServerSettings overlay, with an env baseline and a hardcoded default).
 * Enforced auth-side in the Register use case, layered persisted (admin) -> env
 * -> default exactly like RegistrationConfig. Kept SEPARATE from
 * RegistrationConfig so that already-large interface is not widened further.
 *
 * Three independent caps, each OFF by default (0 = unlimited):
 *   - per-IP: rolling cap on signups from one client IP within a window.
 *   - per-week: a GLOBAL rolling-7-day cap across all signups (DB-backed).
 *   - per-device: a SOFT cap keyed on a CLIENT-SUPPLIED device id. It is trivially
 *     forgeable (the client controls it) so it is NOT a security boundary — only a
 *     best-effort speed bump, enforced solely when the client actually sends one.
 *
 * All enforcement FAILS OPEN: a broken overlay/cache must never block signups.
 */

/** The fully-resolved signup-cap policy — every field populated, ready for use. */
export interface SignupLimitsConfig {
  /** Max signups per client IP per window. 0 = unlimited (cap off). */
  perIpMax: number
  /** Rolling window (hours) the per-IP counter spans. */
  perIpWindowHours: number
  /** Global rolling-7-day cap across ALL signups. 0 = unlimited (cap off). */
  perWeekMax: number
  /** Max signups per client-supplied device id per window (SOFT). 0 = unlimited. */
  perDeviceMax: number
  /** Rolling window (hours) the per-device counter spans. */
  perDeviceWindowHours: number
}

/**
 * A partial admin overlay read from the persisted ServerSettings JSON
 * (`registration.signupsPer*`). Any field left undefined falls back to the env
 * baseline / default. Field names mirror the persisted contract shared with the
 * gateway admin surface (see plan §3.1).
 */
export interface SignupLimitsConfigOverlay {
  perIpMax?: number
  perIpWindowHours?: number
  perWeekMax?: number
  perDeviceMax?: number
  perDeviceWindowHours?: number
}

export const DEFAULT_SIGNUP_LIMITS: SignupLimitsConfig = {
  perIpMax: 0,
  perIpWindowHours: 24,
  perWeekMax: 0,
  perDeviceMax: 0,
  perDeviceWindowHours: 24,
}

// Bounds (mirror the gateway validation ranges in plan §3.1). A cap of 0 means
// unlimited; windows are always at least 1h and at most 7d.
const PER_IP_MAX_CAP = 100_000
const PER_WEEK_MAX_CAP = 1_000_000
const PER_DEVICE_MAX_CAP = 100_000
const MIN_WINDOW_HOURS = 1
const MAX_WINDOW_HOURS = 168
const DEFAULT_WINDOW_HOURS = 24

/**
 * Coerces a raw cap value to a valid non-negative integer within [0, upperBound].
 * Anything not a finite number, or negative, collapses to 0 (unlimited / off) so
 * a misconfiguration can never produce a nonsensical (e.g. negative) cap.
 */
export const clampSignupMax = (value: unknown, upperBound: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  const int = Math.floor(value)
  if (int <= 0) {
    return 0
  }

  return Math.min(int, upperBound)
}

/**
 * Coerces a raw window value to a valid integer number of hours within
 * [MIN_WINDOW_HOURS, MAX_WINDOW_HOURS]. A non-finite value falls back to the
 * 24h default; an out-of-range value is clamped into range.
 */
export const clampSignupWindowHours = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_WINDOW_HOURS
  }
  const int = Math.floor(value)
  if (int < MIN_WINDOW_HOURS) {
    return MIN_WINDOW_HOURS
  }

  return Math.min(int, MAX_WINDOW_HOURS)
}

/**
 * Normalizes a raw (possibly partial/invalid) set of cap values into a valid
 * SignupLimitsConfig. Used by the env-baseline builder and the resolver so an
 * invalid env/overlay never leaks an out-of-range cap into enforcement.
 */
export const normalizeSignupLimits = (raw: Partial<SignupLimitsConfig>): SignupLimitsConfig => ({
  perIpMax: clampSignupMax(raw.perIpMax, PER_IP_MAX_CAP),
  perIpWindowHours: clampSignupWindowHours(raw.perIpWindowHours),
  perWeekMax: clampSignupMax(raw.perWeekMax, PER_WEEK_MAX_CAP),
  perDeviceMax: clampSignupMax(raw.perDeviceMax, PER_DEVICE_MAX_CAP),
  perDeviceWindowHours: clampSignupWindowHours(raw.perDeviceWindowHours),
})
