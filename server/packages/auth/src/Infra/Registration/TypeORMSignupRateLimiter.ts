import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { SignupRateLimiterInterface } from '../../Domain/Registration/SignupRateLimiterInterface'

/**
 * Standard Red Notes: THE PER-IP / PER-DEVICE SIGNUP COUNTER FOR DEPLOYMENTS
 * WITH NO REDIS.
 *
 * WHAT THE CAPS ARE SUPPOSED TO DO
 *
 * `REGISTRATION_SIGNUPS_PER_IP_MAX` refuses more than N registrations from one
 * address inside `REGISTRATION_SIGNUPS_PER_IP_WINDOW_HOURS`, and
 * `REGISTRATION_SIGNUPS_PER_DEVICE_MAX` does the same on the client-supplied
 * device id (a soft speed bump -- the client controls that value). They are the
 * only thing standing between an open instance and an automated mass-signup run,
 * because the per-week cap is global: set it low enough to stop one bot and it
 * also stops the deployment's real users.
 *
 * WHAT THEY ACTUALLY DID ON THE NO-REDIS ARM
 *
 * Nothing. `Register` guards both blocks on `this.signupRateLimiter !==
 * undefined`, and auth's container bound a limiter only when `Auth_Redis` was
 * bound -- which `CACHE_TYPE=memory` leaves unbound. So on the single container
 * and the LXC install both caps were inert WHILE `docker-compose.single.yml` and
 * `.env.single.example` advertised all five knobs. (The entrypoint did not even
 * project them into the process, which is fixed alongside this.)
 *
 * HOW THIS FIXES IT
 *
 * One row per counter in `auth_cache_entries`, the way 23a87ae4's rate-limit
 * counter and 77061ddc's session-token cooldown already do in this same arm.
 * `findUnexpiredOneByKey` filters `expires_at > now` IN SQL, so the window
 * horizon is enforced by the existing mechanism, no migration is needed, and the
 * count SURVIVES A RESTART -- which matters more here than for a login tier: a
 * mass-signup script that can crash-loop the process would otherwise reset its
 * own allowance, and unlike a refused login a created account does not go away.
 *
 * ONE STEP, NOT TWO. Redis `INCR` then `EXPIRE` is two commands, and a counter
 * whose row exists with no horizon never resets -- the address can never register
 * again, which is strictly worse than no cap. (`RedisSignupRateLimiter` re-arms
 * with `EXPIRE ... NX` on every hit precisely to self-heal that.) Here the count
 * and its horizon are written by a single `save`, so the row cannot exist
 * without one, and a row we could not give a horizon is not written at all.
 *
 * THE HORIZON IS ARMED ONLY ON THE FIRST INCREMENT. This is a FIXED window: an
 * existing row's horizon is carried forward unchanged. A horizon refreshed on
 * every increment would mean an address that keeps trying never gets a fresh
 * window -- worse for an honest client retrying a registration that failed for
 * an unrelated reason than for an attacker who simply waits out the window.
 *
 * DELETE BEFORE WRITE. `CacheEntry.create` mints a fresh id per call and
 * `auth_cache_entries` has no unique index on `key`, so `save` INSERTs. Without
 * the delete each signup would add a row under one key and the unordered
 * `getOne()` behind `findUnexpiredOneByKey` could return a STALE, LOWER count --
 * an unbounded allowance out of a cap that looked like it was working.
 *
 * SERIALIZED PER KEY. Read-modify-write is not atomic the way `INCR` is; two
 * concurrent registrations from one address would both read 4 and both write 5.
 * The single container is one node process and nothing else writes this key
 * space, so a per-key promise chain is a real mutex here. Per key, so one
 * address never queues behind another.
 *
 * FAIL-OPEN. Every failure path returns `null`, which `Register` treats as "no
 * information" and ALLOWS -- a database blip must never take registration down.
 */

/** Counter keys are namespaced so they cannot collide with any other cache user. */
const KEY_PREFIX = 'signup-limit'

export class TypeORMSignupRateLimiter implements SignupRateLimiterInterface {
  /** Per-key promise chain: the mutex that makes read-modify-write atomic. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private timer: TimerInterface,
  ) {}

  async incrementAndCount(key: string, windowSeconds: number): Promise<number | null> {
    // No key, or a window we cannot turn into a horizon, means we would have to
    // write a row that never expires. Fail OPEN instead of locking the address
    // out of registration forever.
    if (!key || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      return null
    }

    try {
      return await this.withLock(key, async (): Promise<number> => {
        const cacheKey = this.cacheKeyFor(key)
        const existing = await this.cacheEntryRepository.findUnexpiredOneByKey(cacheKey)

        // A live row is a window already in progress, so keep ITS horizon.
        const expiresAt =
          existing !== null && existing.props.expiresAt !== null
            ? existing.props.expiresAt
            : this.timer.getUTCDateNSecondsAhead(Math.floor(windowSeconds))
        const next = existing !== null ? this.parseCount(existing.props.value) + 1 : 1

        await this.cacheEntryRepository.removeByKey(cacheKey)
        await this.cacheEntryRepository.save(
          CacheEntry.create({ key: cacheKey, value: String(next), expiresAt }).getValue(),
        )

        return next
      })
    } catch {
      // FAIL-OPEN: never let a store error block registration.
      return null
    }
  }

  /**
   * Run `work` after everything already queued for `key`, never before. The
   * chain is cleared once it drains, so the map only holds keys with work in
   * flight.
   */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    // Swallow a predecessor's rejection: one failed increment must not poison
    // every later registration from that address.
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

    // A row this limiter did not write (or a truncated one) must not read as a
    // huge count and refuse the address, nor as a negative one and exempt it.
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }

  private cacheKeyFor(key: string): string {
    return `${KEY_PREFIX}:${key}`
  }
}
