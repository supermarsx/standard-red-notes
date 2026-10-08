import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

/**
 * Standard Red Notes: THE RATE-LIMIT COUNTER FOR DEPLOYMENTS WITH NO REDIS.
 *
 * WHY THIS EXISTS
 *
 * {@link createRateLimitMiddleware} is handed an ioredis client, and when that
 * client is absent it returns a pass-through. `CACHE_TYPE=memory` leaves
 * `ApiGateway_Redis` unbound, so on the single container -- the shape most
 * self-hosters run, and the one the LXC installer builds too -- the WHOLE
 * rate-limit tier was that pass-through: login, the second-factor gate,
 * registration, the magic-link request, account recovery, MCP-token authenticate,
 * session refresh and the realtime mints had no per-address ceiling of any kind.
 * Measured before this class existed: 13 of 13 logins and 63 of 63 session
 * refreshes answered without a single 429, on an env where compose refused the
 * 11th login.
 *
 * WHY A TABLE AND NOT A MAP
 *
 * This follows `TypeORMSessionTokensCooldownRepository` (77061ddc), which gave
 * the same no-Redis arm a real session-token cooldown window off
 * `auth_cache_entries`. The table supplies the two things a hand-rolled map must
 * reimplement: `findUnexpiredOneByKey` filters `expires_at > now` IN SQL, so the
 * window horizon is enforced by the same mechanism the seven sibling
 * repositories in this arm already rely on (ephemeral sessions, PKCE, PoW
 * challenges, locks, offline/subscription tokens, MFA secrets), and the counter
 * SURVIVES A PROCESS RESTART -- a brute-forcer who can crash-loop the server
 * cannot reset their own allowance, which a process-local map would hand them for
 * free. No migration: the table has existed in both the sqlite and mysql
 * migration sets since 2023.
 *
 * ONE STEP, NOT TWO. The Redis counter is `INCR` then, on the first hit,
 * `EXPIRE`. Split across two calls, a table-backed counter can strand a row whose
 * expiry is wrong or missing -- and a rate-limit row that never expires is a
 * PERMANENT LOCKOUT, strictly worse than no limit at all (the same hazard
 * `RedisSignupRateLimiter` re-arms with `EXPIRE ... NX` on every hit to avoid). So
 * this store implements the single-step {@link incrementInWindow} that the
 * middleware prefers when a store offers it, and every write it makes carries an
 * expiry. A row with no expiry, or one past its horizon, is indistinguishable
 * from "no counter" to `findUnexpiredOneByKey`, so the failure mode is a window
 * that resets EARLY, never one that never resets.
 *
 * DELETE BEFORE WRITE. `CacheEntry.create` mints a fresh `UniqueEntityId` per
 * call and `auth_cache_entries` has no unique index on `key`, so `save` INSERTs
 * rather than upserts. Without the delete, every increment would leave another
 * unexpired row under one key, and the unordered `getOne()` behind
 * `findUnexpiredOneByKey` could then hand back a STALE, LOWER count -- an
 * attacker would get an unbounded allowance out of a limiter that looked like it
 * was working -- while the table grew by a row per request.
 *
 * THE INCREMENT IS SERIALIZED PER KEY. Redis `INCR` is atomic; read-then-write is
 * not. Two concurrent logins from one address would both read 4 and both write 5,
 * so a parallel attacker would spend allowance at half rate or less. The single
 * container is ONE node process and nothing else writes this key space, so a
 * per-key promise chain is a real mutex here rather than an approximation. It is
 * per key, so one address never queues behind another.
 *
 * TABLE GROWTH IS BOUNDED BY AN OPPORTUNISTIC SWEEP. Expired rows are inert (the
 * SQL filter ignores them) but they are not free, and this key space is written by
 * UNAUTHENTICATED callers, so its cardinality is the number of distinct addresses
 * that ever touched an auth endpoint. A key is cleaned the next time it is used;
 * for keys that never come back, up to {@link SWEEP_TRACKED_KEYS} of them are
 * remembered with their horizon and deleted once it passes. A swept key is
 * re-read through its OWN mutex and skipped while a live row exists, so the sweep
 * can never delete a counter that a new window has just opened. Losing the
 * tracking (a restart, or more than {@link SWEEP_TRACKED_KEYS} horizons live at
 * once) costs cleanup only, never correctness: those rows are still expired in
 * SQL, and are still deleted if the key is used again.
 */

/** Counter keys are namespaced so they cannot collide with any other cache user. */
const KEY_PREFIX = 'ratelimit'

/**
 * How many not-yet-swept keys to remember. Each entry is a short string plus a
 * number, so 8 192 of them stay well under a megabyte. When full, a new key is
 * simply not tracked (it still expires in SQL) rather than evicting a tracked
 * one, because an evicted entry is a row nothing will ever delete.
 */
export const SWEEP_TRACKED_KEYS = 8192

/** How many expired keys to delete per increment, so the work stays O(1). */
export const SWEEP_BATCH_SIZE = 4

export class CacheEntryRateLimitStore {
  /** Per-key promise chain: the mutex that makes read-modify-write atomic. */
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Insertion-ordered plain key -> horizon in epoch ms, for the sweep. */
  private readonly tracked = new Map<string, number>()

  constructor(
    private cacheEntryRepository: () => CacheEntryRepositoryInterface,
    private timer: TimerInterface,
  ) {}

  /**
   * Increment the counter for `key` and, when it is the first hit of a window,
   * arm that window -- in ONE serialized step, so no row can exist without a
   * correct horizon. Returns the post-increment count, like Redis `INCR`.
   */
  async incrementInWindow(key: string, windowSeconds: number): Promise<number> {
    const count = await this.withLock(key, async (): Promise<number> => {
      const repository = this.cacheEntryRepository()
      const cacheKey = this.cacheKeyFor(key)
      const existing = await repository.findUnexpiredOneByKey(cacheKey)

      // An existing row is a window already in progress, so keep ITS horizon: a
      // horizon that slid forward on every hit would let a steady attacker stay
      // refused forever once they tripped the ceiling once.
      const horizon =
        existing !== null && existing.props.expiresAt !== null
          ? existing.props.expiresAt
          : this.timer.getUTCDateNSecondsAhead(windowSeconds)
      const next = existing !== null ? this.parseCount(existing.props.value) + 1 : 1

      await repository.removeByKey(cacheKey)
      await repository.save(CacheEntry.create({ key: cacheKey, value: String(next), expiresAt: horizon }).getValue())

      this.track(key, this.timer.convertDateToMilliseconds(horizon))

      return next
    })

    await this.sweep()

    return count
  }

  /**
   * Seconds left in the current window, or -2 when there is no live counter --
   * the value Redis `TTL` returns for a missing key, which the middleware reads as
   * "fall back to the configured window length".
   */
  async ttl(key: string): Promise<number> {
    const existing = await this.cacheEntryRepository().findUnexpiredOneByKey(this.cacheKeyFor(key))
    if (existing === null || existing.props.expiresAt === null) {
      return -2
    }

    const remainingMs = this.timer.convertDateToMilliseconds(existing.props.expiresAt) - this.nowMs()

    // findUnexpiredOneByKey already proved the row is live, so round UP: a live
    // window must never report 0 seconds left, which a caller reads as "gone".
    return Math.max(1, Math.ceil(remainingMs / 1000))
  }

  private async sweep(): Promise<void> {
    const now = this.nowMs()
    const due: string[] = []
    for (const [key, horizonMs] of this.tracked) {
      // Insertion order is not horizon order (a long window tracked early
      // outlives a short one tracked later), so keep scanning past a live entry
      // rather than stopping; the scan is capped by the batch size.
      if (horizonMs <= now) {
        due.push(key)
        if (due.length === SWEEP_BATCH_SIZE) {
          break
        }
      }
    }

    for (const key of due) {
      this.tracked.delete(key)
      // Through the key's OWN mutex, and only while no live row exists: between
      // the horizon passing and this delete, a request may have opened a NEW
      // window under the same key, and deleting that would hand the caller a
      // fresh allowance.
      await this.withLock(key, async (): Promise<void> => {
        const repository = this.cacheEntryRepository()
        const cacheKey = this.cacheKeyFor(key)
        if ((await repository.findUnexpiredOneByKey(cacheKey)) !== null) {
          return
        }
        await repository.removeByKey(cacheKey)
      })
    }
  }

  private track(key: string, horizonMs: number): void {
    if (!this.tracked.has(key) && this.tracked.size >= SWEEP_TRACKED_KEYS) {
      return
    }
    this.tracked.set(key, horizonMs)
  }

  /**
   * Run `work` after everything already queued for `key`, and never before. The
   * chain is cleared once it drains, so the map holds only keys with work in
   * flight.
   */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    // Swallow a predecessor's rejection: one failed increment must not poison
    // every later request from that address.
    const run = previous.then(
      () => work(),
      () => work(),
    )
    this.locks.set(key, run)

    try {
      return await run
    } finally {
      if (this.locks.get(key) === run) {
        this.locks.delete(key)
      }
    }
  }

  private parseCount(value: string): number {
    const parsed = Number.parseInt(value, 10)

    // A row this store did not write (or a truncated one) must not read as a huge
    // count and lock the address out, nor as a negative one and exempt it.
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }

  private nowMs(): number {
    return this.timer.convertDateToMilliseconds(this.timer.getUTCDate())
  }

  private cacheKeyFor(key: string): string {
    return `${KEY_PREFIX}:${key}`
  }
}
