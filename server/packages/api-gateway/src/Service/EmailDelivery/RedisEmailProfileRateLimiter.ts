import { EmailProfileRateLimiter, ProfileRateLimitDecision, RelayRateLimit } from './Types'

export interface EmailRateLimitRedis {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>
}

const RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], 1, 'PX', ARGV[2], 'NX')
  return { 1, 0 }
end
local next = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
if next > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return { 0, ttl }
end
return { 1, 0 }
`

export class RedisEmailProfileRateLimiter implements EmailProfileRateLimiter {
  constructor(
    private readonly redis: EmailRateLimitRedis,
    private readonly keyPrefix = 'srn:email:profile-limit',
  ) {}

  async reserve(profileId: string, limit: RelayRateLimit): Promise<ProfileRateLimitDecision> {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profileId) ||
      !Number.isSafeInteger(limit.max) ||
      limit.max < 0 ||
      !Number.isSafeInteger(limit.windowSeconds) ||
      limit.windowSeconds < 1 ||
      limit.windowSeconds > 2_592_000
    ) {
      throw new Error('Email relay rate limit is invalid.')
    }
    if (limit.max === 0) {
      return { allowed: true, retryAfterMs: 0 }
    }
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      1,
      `${this.keyPrefix}:{${profileId}}`,
      limit.max,
      limit.windowSeconds * 1_000,
    )
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('Email relay rate limiter returned an invalid result.')
    }

    return { allowed: Number(result[0]) === 1, retryAfterMs: Math.max(0, Number(result[1]) || 0) }
  }
}
