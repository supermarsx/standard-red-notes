/**
 * Standard Red Notes: lightweight, Redis-backed VISIBILITY for the anti-abuse
 * layer — throttle hits (per tier + a recent-events ring) and IP-block hits — so
 * the admin panel's Anti-abuse view can show what the limiter is doing without a
 * separate metrics stack. Reuses the gateway's ioredis client.
 *
 * Everything here is best-effort telemetry: a Redis error while recording is
 * swallowed (never blocks or fails a request), and the reader degrades to empty
 * counters. It records NO per-user data — only the client IP, the tier bucket,
 * the method + normalized path, and a timestamp — so it does not leak identity
 * beyond the address the limiter already keys on.
 */

export const RL_METRICS_TIER_KEY = 'rl:metrics:tiers'
export const RL_METRICS_RECENT_KEY = 'rl:metrics:recent'
export const RL_METRICS_BLOCK_KEY = 'rl:metrics:blocks'

/** Cap on the recent-events ring so it can never grow unbounded. */
export const RL_METRICS_RECENT_MAX = 200
/** Recent ring + counters self-expire after a day of no throttling. */
export const RL_METRICS_TTL_SECONDS = 24 * 60 * 60

export interface RateLimitMetricsRedis {
  hincrby(key: string, field: string, increment: number): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
  lpush(key: string, value: string): Promise<number>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  expire(key: string, seconds: number): Promise<number>
}

export interface RecentThrottleEvent {
  at: number
  bucket: string
  ip: string
  method: string
  path: string
}

export interface RateLimitMetricsView {
  /** Total throttle (429) hits per tier bucket since the counters last expired. */
  tierHits: Record<string, number>
  /** Total IP-block (403) hits since the counter last expired. */
  blockHits: number
  /** Newest-first ring of recent throttle events (capped). */
  recent: RecentThrottleEvent[]
}

export class RateLimitMetricsStore {
  constructor(private readonly redis: RateLimitMetricsRedis) {}

  /** Record a throttle (429). Never throws. */
  async recordThrottle(event: Omit<RecentThrottleEvent, 'at'> & { at?: number }): Promise<void> {
    const at = event.at ?? Date.now()
    try {
      await this.redis.hincrby(RL_METRICS_TIER_KEY, event.bucket, 1)
      await this.redis.expire(RL_METRICS_TIER_KEY, RL_METRICS_TTL_SECONDS)
      const line = JSON.stringify({
        at,
        bucket: event.bucket,
        ip: event.ip,
        method: event.method,
        path: event.path,
      })
      await this.redis.lpush(RL_METRICS_RECENT_KEY, line)
      await this.redis.ltrim(RL_METRICS_RECENT_KEY, 0, RL_METRICS_RECENT_MAX - 1)
      await this.redis.expire(RL_METRICS_RECENT_KEY, RL_METRICS_TTL_SECONDS)
    } catch {
      // best-effort telemetry — a Redis blip must not affect the request.
    }
  }

  /** Record an IP-block (403). Never throws. */
  async recordBlock(): Promise<void> {
    try {
      await this.redis.hincrby(RL_METRICS_BLOCK_KEY, 'total', 1)
      await this.redis.expire(RL_METRICS_BLOCK_KEY, RL_METRICS_TTL_SECONDS)
    } catch {
      // best-effort.
    }
  }

  /** Read the aggregated view. Never throws — degrades to empty on any error. */
  async view(): Promise<RateLimitMetricsView> {
    try {
      const [tierRaw, blockRaw, recentRaw] = await Promise.all([
        this.redis.hgetall(RL_METRICS_TIER_KEY),
        this.redis.hgetall(RL_METRICS_BLOCK_KEY),
        this.redis.lrange(RL_METRICS_RECENT_KEY, 0, RL_METRICS_RECENT_MAX - 1),
      ])

      const tierHits: Record<string, number> = {}
      for (const [bucket, count] of Object.entries(tierRaw ?? {})) {
        const value = Number(count)
        if (Number.isFinite(value)) {
          tierHits[bucket] = value
        }
      }

      const blockHits = Number((blockRaw ?? {}).total ?? 0)

      const recent: RecentThrottleEvent[] = []
      for (const line of recentRaw ?? []) {
        try {
          const parsed = JSON.parse(line) as RecentThrottleEvent
          if (parsed && typeof parsed.bucket === 'string') {
            recent.push(parsed)
          }
        } catch {
          // skip a malformed ring entry.
        }
      }

      return { tierHits, blockHits: Number.isFinite(blockHits) ? blockHits : 0, recent }
    } catch {
      return { tierHits: {}, blockHits: 0, recent: [] }
    }
  }
}
