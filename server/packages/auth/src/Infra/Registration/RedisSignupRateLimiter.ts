import * as IORedis from 'ioredis'

import { SignupRateLimiterInterface } from '../../Domain/Registration/SignupRateLimiterInterface'

/**
 * Standard Red Notes: Redis-backed atomic counter for the per-IP / per-device
 * SOFT signup caps, using the SAME shared Redis cache the rest of auth uses.
 *
 * INCR is atomic; the window TTL is applied ONLY on the first increment (when the
 * post-increment value is 1) so the counter spans a rolling window and then
 * resets. A missing TTL (e.g. the process died between INCR and EXPIRE on the
 * very first hit) self-heals within one window at worst.
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
      if (count === 1 && windowSeconds > 0) {
        await this.redisClient.expire(key, windowSeconds)
      }

      return count
    } catch {
      // FAIL-OPEN: never let a Redis error block registration.
      return null
    }
  }
}
