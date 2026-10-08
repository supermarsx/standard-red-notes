import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { IpEscalationStoreInterface } from '../../Domain/ProofOfWork/IpEscalationStoreInterface'

/**
 * Standard Red Notes: THE PROOF-OF-WORK IP ESCALATION RAMP FOR DEPLOYMENTS WITH
 * NO REDIS.
 *
 * WHAT THE RAMP IS SUPPOSED TO DO
 *
 * When an address trips one of the gateway's rate-limit tiers AND adaptive
 * escalation is enabled, the gateway flags it (`rl:escalate:<ip>`) for five
 * windows. Auth's sign-in gate, in `adaptive` mode, then demands a proof-of-work
 * solution from that address on its NEXT attempts -- before the account it is
 * guessing at has crossed the failed-attempt threshold. That is the whole point:
 * the account-based rule only fires once one account has already absorbed a
 * run of failures, so an attacker spreading guesses thinly across many accounts
 * never trips it. The IP rule is what charges them for the spread.
 *
 * WHAT IT ACTUALLY DID ON THE NO-REDIS ARM
 *
 * Nothing, at BOTH ends. The writer (`recordEscalation` in HomeServer.ts and the
 * gateway's bin/server.ts) is keyed off the ioredis client, which `CACHE_TYPE=
 * memory` leaves unbound, so the hook was not installed. The reader
 * (`RedisIpEscalationChecker`) is bound under the same condition, so
 * `ProofOfWorkGate.ipEscalated()` short-circuited to false for every request. On
 * the single container and the LXC install the ramp did not exist.
 *
 * HOW THIS FIXES IT
 *
 * The same way 23a87ae4 gave that arm a rate-limit counter and 77061ddc gave it
 * a session-token cooldown: one row in `auth_cache_entries`, whose horizon
 * `findUnexpiredOneByKey` enforces IN SQL (`expires_at > now`). No migration --
 * the table has been in both the sqlite and mysql sets since 2023 -- and the flag
 * survives a restart, so an attacker who can crash-loop the process cannot clear
 * their own escalation.
 *
 * ONE OBJECT, BOTH ENDS. The home-server resolves THIS instance as the writer and
 * auth's gate holds it as the reader (see IpEscalationStoreInterface), so the key
 * format has a single owner and the two halves cannot drift apart.
 *
 * ONE STEP, NOT TWO. `escalate` writes the value and its horizon in a single
 * `save`, so no row can exist without one. (The Redis arm needs `SET ... EX`
 * for the same reason; a flag with no horizon would be a PERMANENT escalation,
 * and a permanent proof-of-work demand on an address is a lockout of everyone
 * behind it.)
 *
 * DELETE BEFORE WRITE. `CacheEntry.create` mints a fresh id per call and
 * `auth_cache_entries` has no unique index on `key`, so `save` INSERTs rather
 * than upserts. Without the delete, every throttle would add a row under one key
 * and the unordered `getOne()` behind `findUnexpiredOneByKey` could hand back an
 * ALREADY-EXPIRED row -- reading as "not escalated" while a live flag sat beside
 * it -- while the table grew by a row per refusal.
 *
 * SERIALIZED PER ADDRESS. Two throttles for one address arriving together would
 * otherwise interleave delete/insert and leave two rows, which is the stale-read
 * above. Per address, so one address never queues behind another.
 *
 * FAIL-OPEN. `isEscalated` returns false on ANY error and whenever escalation is
 * disabled, so a database blip can never force proof-of-work on legitimate
 * users beyond the normal account-based adaptive rule. `escalate` swallows its
 * errors because it runs on the refusal path, where throwing would be caught by
 * the limiter's own fail-open and spend the refusal.
 */

/**
 * The SAME key the gateway writes on a Redis deployment, so an operator reading
 * either store sees one name for one signal. Already namespaced by its `rl:`
 * prefix, so it is stored unprefixed rather than nested under a second one.
 */
const KEY_PREFIX = 'rl:escalate'

export class TypeORMIpEscalationStore implements IpEscalationStoreInterface {
  /** Per-address promise chain: the mutex that makes delete-then-write atomic. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private timer: TimerInterface,
    private adaptiveEscalationEnabled: () => Promise<boolean>,
  ) {}

  async escalate(clientIp: string, ttlSeconds: number): Promise<void> {
    // A horizon is not optional: refuse to write a flag we could not expire.
    if (!clientIp || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return
    }

    try {
      await this.withLock(clientIp, async (): Promise<void> => {
        const key = this.keyFor(clientIp)
        const expiresAt = this.timer.getUTCDateNSecondsAhead(Math.floor(ttlSeconds))

        await this.cacheEntryRepository.removeByKey(key)
        await this.cacheEntryRepository.save(CacheEntry.create({ key, value: '1', expiresAt }).getValue())
      })
    } catch {
      // Best-effort signal, written from the limiter's refusal path: a failure
      // here must never propagate into that branch.
    }
  }

  async isEscalated(clientIp: string): Promise<boolean> {
    if (!clientIp) {
      return false
    }

    try {
      // Gated by the SAME switch the writer consults, resolved per call so an
      // admin toggle applies without a restart.
      if (!(await this.adaptiveEscalationEnabled())) {
        return false
      }

      return (await this.cacheEntryRepository.findUnexpiredOneByKey(this.keyFor(clientIp))) !== null
    } catch {
      // FAIL-OPEN: never let a store error force proof-of-work on sign-in.
      return false
    }
  }

  /**
   * Run `work` after everything already queued for this address, never before.
   * The chain is cleared once it drains, so the map only holds addresses with
   * work in flight.
   */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    // Swallow a predecessor's rejection: one failed write must not poison every
    // later throttle from that address.
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

  private keyFor(clientIp: string): string {
    return `${KEY_PREFIX}:${clientIp}`
  }
}
