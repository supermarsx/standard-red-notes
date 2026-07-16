import * as IORedis from 'ioredis'

import { SignupRateLimiterInterface } from '../../Domain/Registration/SignupRateLimiterInterface'

/**
 * Standard Red Notes: Redis-backed atomic counter for the per-IP / per-device
 * SOFT signup caps, using the SAME shared Redis cache the rest of auth uses.
 *
 * INCR is atomic. The window TTL is (re-)armed on EVERY increment via
 * `EXPIRE key windowSeconds NX`: the `NX` flag sets a TTL only when the key has
 * none, so it preserves the fixed-window-reset semantic (the window does not
 * slide on later hits) while GUARANTEEING a key can never exist without a TTL.
 *
 * This closes a permanent-lockout hole: if the TTL were armed only on the first
 * increment, a lost EXPIRE (process restart in the gap between INCR and EXPIRE,
 * or a transient Redis error on the EXPIRE specifically) would strand a key with
 * no TTL — no later call would re-arm it, so the per-IP counter would climb
 * across windows and never reset, refusing the IP signup forever. Re-arming with
 * NX on every call self-heals such a stranded key on its very next hit.
 *
 * FAIL-OPEN: any Redis error returns `null` so a cache outage never blocks a
 * signup — the caller treats `null` as "no information" and allows the signup.
 */
export class RedisSignupRateLimiter implements SignupRateLimiterInterface {
  constructor(private redisClient: IORedis.Redis) {}

  async incrementAndCount(key: string, windowSeconds: number): Promise<number | null> {
    if (!key) {
      return null
    }

    try {
      const count = await this.redisClient.incr(key)
      if (windowSeconds > 0) {
        // Re-arm on EVERY call. `NX` only sets a TTL when the key has none, so a
        // key that survived a lost EXPIRE (which would otherwise live forever and
        // lock the IP out permanently) gets its TTL restored on the next hit,
        // while a key that already has a live TTL is left untouched (no slide).
        await this.redisClient.expire(key, windowSeconds, 'NX')
      }

      return count
    } catch {
      // FAIL-OPEN: never let a Redis error block registration.
      return null
    }
  }
}
