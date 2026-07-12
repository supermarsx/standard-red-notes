/**
 * Standard Red Notes: atomic per-key signup counter backing the per-IP and
 * per-device SOFT signup caps. Implemented against the SHARED Redis cache
 * (see Infra/Registration/RedisSignupRateLimiter). Kept as a Domain interface so
 * the Register use case stays free of any cache dependency and is trivially
 * mockable in tests, mirroring IpEscalationCheckerInterface.
 *
 * FAIL-OPEN CONTRACT: `incrementAndCount` MUST NOT throw. When the count cannot
 * be determined (no backing store wired, or a cache error) it returns `null` so
 * the caller treats the situation as "no information" and ALLOWS the signup — a
 * cache outage must never block registration.
 */
export interface SignupRateLimiterInterface {
  /**
   * Atomically increments the counter for `key`, applying `windowSeconds` as the
   * TTL on the first increment (so the counter resets after the rolling window),
   * and returns the post-increment count. Returns `null` when the count cannot be
   * determined, so the caller fails OPEN.
   */
  incrementAndCount(key: string, windowSeconds: number): Promise<number | null>
}
