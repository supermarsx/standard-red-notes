import * as IORedis from 'ioredis'

import { TokenUsageEntry, WEEKLY_WINDOW_MS } from './tokenMetering'

/**
 * Standard Red Notes: Redis-backed rolling-window token counter.
 *
 * Each metered subject (a user uuid, or the reserved subscription-aggregate id)
 * owns ONE sorted set whose members are individual completions. The score is the
 * completion's epoch-ms timestamp and the member packs the token count, so a
 * rolling window is answered by ZRANGEBYSCORE over the last 7 days and summed in
 * memory (see tokenMetering.ts). Entries older than the widest (weekly) window
 * are pruned on every write and the whole key carries a TTL, so a subject that
 * stops using the assistant self-cleans.
 *
 * Home-server scale: at most a week of a single user's requests live in one set,
 * which is tiny. A horizontally-sharded deployment would keep working (the set
 * is per-subject) but could swap the in-memory sum for bucketed INCR counters.
 */

/** Reserved subject id: the AGGREGATE of all subscription-backed (Codex) calls. */
export const SUBSCRIPTION_USAGE_SUBJECT = '__subscription__'

/**
 * Per-subscription metering subject: usage attributed to ONE paired subscription
 * (by its credential id), so each pairing's consumption can be polled on its own
 * alongside the cross-subscription aggregate above.
 */
export function subscriptionUsageSubject(subscriptionId: string): string {
  return `${SUBSCRIPTION_USAGE_SUBJECT}:${subscriptionId}`
}

// Keep pruned keys a little past the weekly window so a slightly-late request
// still finds its history, then let Redis expire the whole set.
const KEY_TTL_SECONDS = Math.ceil(WEEKLY_WINDOW_MS / 1000) + 60 * 60

export interface TokenUsageStore {
  record(subject: string, tokens: number, now: number): Promise<void>
  entriesWithinWeek(subject: string, now: number): Promise<TokenUsageEntry[]>
}

export class RedisTokenUsageStore implements TokenUsageStore {
  constructor(private readonly redis: IORedis.Redis) {}

  private key(subject: string): string {
    return `ai-token-usage:${subject}`
  }

  /**
   * Append one completion's token spend. Best-effort de-dupe of the member via a
   * random suffix so two same-millisecond writes don't collide in the set.
   */
  async record(subject: string, tokens: number, now: number): Promise<void> {
    if (tokens <= 0) {
      return
    }
    const key = this.key(subject)
    const member = `${now}:${Math.round(tokens)}:${Math.random().toString(36).slice(2, 10)}`
    await this.redis.zadd(key, now, member)
    // Drop anything already past the weekly window, then bound the key lifetime.
    await this.redis.zremrangebyscore(key, 0, now - WEEKLY_WINDOW_MS)
    await this.redis.expire(key, KEY_TTL_SECONDS)
  }

  /** All entries inside the weekly window (the widest we ever sum over). */
  async entriesWithinWeek(subject: string, now: number): Promise<TokenUsageEntry[]> {
    const key = this.key(subject)
    const raw = await this.redis.zrangebyscore(key, now - WEEKLY_WINDOW_MS, '+inf')
    return raw.map(parseMember).filter((entry): entry is TokenUsageEntry => entry !== null)
  }
}

/** Parse a `${ts}:${tokens}:${rand}` member back into an entry; null when malformed. */
function parseMember(member: string): TokenUsageEntry | null {
  const [tsPart, tokensPart] = member.split(':')
  const ts = Number(tsPart)
  const tokens = Number(tokensPart)
  if (!Number.isFinite(ts) || !Number.isFinite(tokens)) {
    return null
  }
  return { ts, tokens }
}
