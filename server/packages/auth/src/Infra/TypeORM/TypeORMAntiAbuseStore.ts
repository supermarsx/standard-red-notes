import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

/**
 * Standard Red Notes: THE IP ALLOW/BLOCK LISTS AND THROTTLE TELEMETRY FOR
 * DEPLOYMENTS WITH NO REDIS.
 *
 * WHAT THEY ARE SUPPOSED TO DO
 *
 * The gateway classifies every request's address against two admin-managed
 * lists BEFORE the rate-limit tiers run: a blocklisted address is refused 403
 * outright, an allowlisted one bypasses the tiers entirely (allow wins, so an
 * admin who blocks a broad range and allowlists themselves cannot lock
 * themselves out). Alongside them sits the telemetry the admin panel's
 * Anti-abuse view reads: throttle hits per tier, total block hits, and a capped
 * ring of recent refusals.
 *
 * WHAT THEY ACTUALLY DID ON THE NO-REDIS ARM
 *
 * Nothing. The gateway bound `IpAccessListStore` and `RateLimitMetricsStore`
 * only when its ioredis client was bound, so with `CACHE_TYPE=memory` the
 * middleware got `undefined` for both and skipped the classification and the
 * recording. This is a worse shape than the missing rate limit 23a87ae4 fixed:
 * a rate limit nobody configured is merely absent, whereas an operator who types
 * an address into the block list has been told the request will be refused. The
 * two paths an operator actually has both said so out loud -- `POST
 * /v1/admin/anti-abuse/ip-block` answered 503 "IP access lists are not available
 * on this deployment", `srn-admin ip block` threw "Redis is not configured on
 * this deployment" -- and `GET /v1/admin/anti-abuse` reported `available: false`
 * with every counter at zero, so the panel could not distinguish "nothing is
 * attacking this instance" from "nothing is being recorded".
 *
 * HOW THIS FIXES IT
 *
 * `IpAccessListStore` and `RateLimitMetricsStore` each take a MINIMAL slice of
 * ioredis (`IpAccessListRedis`, `RateLimitMetricsRedis`) rather than the client,
 * so a store that answers those nine commands drops straight in and NEITHER of
 * them changes. This is that store, over `auth_cache_entries` -- the same table
 * 23a87ae4 and 77061ddc put this arm's rate-limit counter and session-token
 * cooldown in, needing no migration. The Redis topologies keep the exact ioredis
 * client and the exact commands they had.
 *
 * It also has to be ONE store rather than one per consumer, because the
 * single-container operator's primary path is `srn-admin`, which is a SEPARATE
 * PROCESS from the server. A process-local map would have let the CLI write a
 * block list the gateway never sees. A table is the only shared medium those two
 * processes have here, and it is the one the lists belong in anyway: an
 * operator's block list must survive a restart.
 *
 * KEYS AND VALUES. The caller's key is stored verbatim (`rl:acl:allow`,
 * `rl:metrics:*`) -- it arrives already namespaced by its `rl:` prefix, and
 * keeping it identical to the Redis key means an operator reads one name for one
 * thing on either topology. The value is a typed JSON envelope, so a key read
 * back as the wrong shape degrades to empty (Redis would answer WRONGTYPE; every
 * consumer here already treats an empty read as "no information") instead of
 * being coerced into nonsense.
 *
 * HORIZONS. A Redis key has no TTL until something `EXPIRE`s it, and `SADD` /
 * `HINCRBY` / `LPUSH` never touch an existing one. Mirrored exactly: a row this
 * store creates gets a nominal century-long horizon (the table's expiry filter
 * is `expires_at > now`, and a NULL would read as already expired), every
 * mutation CARRIES THE EXISTING HORIZON FORWARD, and only {@link expire} moves
 * it. So the ACL lists persist, and the telemetry's 24h self-expiry behaves as
 * its author wrote it -- a sliding horizon there is deliberate, because the ring
 * is meant to disappear after a day with no throttling, not a day after the
 * first one.
 *
 * DELETE BEFORE WRITE. `CacheEntry.create` mints a fresh id per call and
 * `auth_cache_entries` has no unique index on `key`, so `save` INSERTs. Without
 * the delete, every `sadd` would add a row under one key and the unordered
 * `getOne()` behind `findUnexpiredOneByKey` could return a STALE EARLIER
 * version of the list -- an address an admin had just blocked would come back
 * unblocked, intermittently, which is the worst possible failure for a control
 * an operator has been told is in force.
 *
 * SERIALIZED PER KEY. Read-modify-write is not atomic. Both lists are single
 * keys, so two admins adding entries at once (or the gateway recording two
 * throttles) would otherwise read the same list and write it back twice, losing
 * one entry. Per key, so the allow list never queues behind the recent-events
 * ring.
 */

/** Envelope kinds, so a key read back as the wrong shape degrades to empty. */
type AntiAbuseValue = { t: 'set'; m: string[] } | { t: 'hash'; f: Record<string, string> } | { t: 'list'; v: string[] }

/**
 * Nominal horizon for a key nothing has `EXPIRE`d: a Redis key without a TTL
 * lives until deleted, and the ACL lists must. A century is far enough to be
 * "never" and finite enough to satisfy the table's `expires_at > now` filter,
 * which a NULL would fail.
 */
const PERSISTENT_HORIZON_SECONDS = 100 * 365 * 24 * 60 * 60

export class TypeORMAntiAbuseStore {
  /** Per-key promise chain: the mutex that makes read-modify-write atomic. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private timer: TimerInterface,
  ) {}

  /* ----- SET: the two IP access lists ----------------------------------- */

  async sadd(key: string, member: string): Promise<number> {
    return this.withLock(key, async (): Promise<number> => {
      const current = await this.read(key)
      const members = current.value?.t === 'set' ? current.value.m : []
      if (members.includes(member)) {
        return 0
      }

      await this.write(key, { t: 'set', m: [...members, member] }, current.horizon)

      return 1
    })
  }

  async srem(key: string, member: string): Promise<number> {
    return this.withLock(key, async (): Promise<number> => {
      const current = await this.read(key)
      const members = current.value?.t === 'set' ? current.value.m : []
      if (!members.includes(member)) {
        return 0
      }
      const remaining = members.filter((entry) => entry !== member)

      // Redis drops a set once its last member is removed.
      if (remaining.length === 0) {
        await this.cacheEntryRepository.removeByKey(key)
      } else {
        await this.write(key, { t: 'set', m: remaining }, current.horizon)
      }

      return 1
    })
  }

  async smembers(key: string): Promise<string[]> {
    const current = await this.read(key)

    return current.value?.t === 'set' ? [...current.value.m] : []
  }

  /* ----- HASH: the per-tier and block hit counters ---------------------- */

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.withLock(key, async (): Promise<number> => {
      const current = await this.read(key)
      const fields = current.value?.t === 'hash' ? { ...current.value.f } : {}
      const parsed = Number.parseInt(fields[field] ?? '0', 10)
      const base = Number.isSafeInteger(parsed) ? parsed : 0
      const next = base + Math.trunc(increment)
      fields[field] = String(next)

      await this.write(key, { t: 'hash', f: fields }, current.horizon)

      return next
    })
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const current = await this.read(key)

    return current.value?.t === 'hash' ? { ...current.value.f } : {}
  }

  /* ----- LIST: the recent-throttle ring --------------------------------- */

  async lpush(key: string, value: string): Promise<number> {
    return this.withLock(key, async (): Promise<number> => {
      const current = await this.read(key)
      const values = current.value?.t === 'list' ? current.value.v : []
      const next = [value, ...values]

      await this.write(key, { t: 'list', v: next }, current.horizon)

      return next.length
    })
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return this.withLock(key, async (): Promise<void> => {
      const current = await this.read(key)
      if (current.value?.t !== 'list') {
        return
      }
      const kept = this.slice(current.value.v, start, stop)

      // Redis drops a list left empty by a trim.
      if (kept.length === 0) {
        await this.cacheEntryRepository.removeByKey(key)

        return
      }
      await this.write(key, { t: 'list', v: kept }, current.horizon)
    })
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const current = await this.read(key)
    if (current.value?.t !== 'list') {
      return []
    }

    return this.slice(current.value.v, start, stop)
  }

  /* ----- TTL ------------------------------------------------------------- */

  /** Set this key's horizon. Returns 0 for a missing key, exactly like Redis. */
  async expire(key: string, seconds: number): Promise<number> {
    return this.withLock(key, async (): Promise<number> => {
      const current = await this.read(key)
      if (current.value === null) {
        return 0
      }
      if (!Number.isFinite(seconds) || seconds <= 0) {
        // Redis deletes a key given a non-positive expiry.
        await this.cacheEntryRepository.removeByKey(key)

        return 1
      }

      await this.write(key, current.value, this.timer.getUTCDateNSecondsAhead(Math.floor(seconds)))

      return 1
    })
  }

  /* ----- internals ------------------------------------------------------- */

  /**
   * Read a key's envelope and the horizon a mutation must carry forward. An
   * absent, expired or unparseable row reads as no value, and a fresh nominal
   * horizon -- so a corrupt row is replaced rather than inherited.
   */
  private async read(key: string): Promise<{ value: AntiAbuseValue | null; horizon: Date }> {
    const entry = await this.cacheEntryRepository.findUnexpiredOneByKey(key)
    const fallbackHorizon = this.timer.getUTCDateNSecondsAhead(PERSISTENT_HORIZON_SECONDS)
    if (entry === null) {
      return { value: null, horizon: fallbackHorizon }
    }

    return {
      value: this.parse(entry.props.value),
      horizon: entry.props.expiresAt ?? fallbackHorizon,
    }
  }

  /** Replace the row for `key` -- delete first, because `save` INSERTs. */
  private async write(key: string, value: AntiAbuseValue, horizon: Date): Promise<void> {
    await this.cacheEntryRepository.removeByKey(key)
    await this.cacheEntryRepository.save(
      CacheEntry.create({ key, value: JSON.stringify(value), expiresAt: horizon }).getValue(),
    )
  }

  private parse(raw: string): AntiAbuseValue | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') {
      return null
    }
    const envelope = parsed as { t?: unknown; m?: unknown; f?: unknown; v?: unknown }
    if (envelope.t === 'set' && this.isStringArray(envelope.m)) {
      return { t: 'set', m: envelope.m }
    }
    if (envelope.t === 'hash' && this.isStringRecord(envelope.f)) {
      return { t: 'hash', f: envelope.f }
    }
    if (envelope.t === 'list' && this.isStringArray(envelope.v)) {
      return { t: 'list', v: envelope.v }
    }

    return null
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')
    )
  }

  /** Redis LRANGE/LTRIM index semantics, negative offsets included. */
  private slice(values: string[], start: number, stop: number): string[] {
    const length = values.length
    const from = Math.max(0, start < 0 ? length + start : start)
    const toInclusive = Math.min(length - 1, stop < 0 ? length + stop : stop)
    if (from > toInclusive) {
      return []
    }

    return values.slice(from, toInclusive + 1)
  }

  /**
   * Run `work` after everything already queued for `key`, never before. The
   * chain is cleared once it drains, so the map only holds keys with work in
   * flight.
   */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    // Swallow a predecessor's rejection: one failed write must not poison every
    // later read of the same list.
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
}
