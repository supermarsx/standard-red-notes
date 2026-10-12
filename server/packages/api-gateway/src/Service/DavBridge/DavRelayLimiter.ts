import { davRefusal } from './DavBridgeRefusal'

/**
 * Standard Red Notes: what keeps the DAV relay from being a general proxy, a
 * password-guessing tool, or a way for one dead server to hold this one's
 * sockets.
 *
 * Four independent ceilings:
 *
 *   budgets      per user: relayed requests, writes, account validations;
 *   concurrency  per account, per origin, and for the whole process;
 *   breaker      per user and origin: after repeated failures, stop trying for
 *                a while;
 *   (time and size ceilings live in the relay itself).
 *
 * EVERYTHING HERE FAILS CLOSED. The gateway's general per-user limiter fails
 * open when its counter store errors, which is the right call for a feature
 * that only spends this server's own resources. This one spends requests
 * against somebody else's server with a stored password, so the in-process
 * counters below always apply. A shared counter store, when the deployment has
 * one, is consulted in addition so that several gateway replicas share one
 * budget; if it errors, the in-process floor is what remains, not nothing.
 */

export type DavBudget = 'requests' | 'writes' | 'validations'

export interface DavBudgetLimit {
  max: number
  windowSeconds: number
}

export interface DavRelayLimits {
  budgets: Record<DavBudget, DavBudgetLimit>
  concurrentPerAccount: number
  concurrentPerOrigin: number
  concurrentTotal: number
  breakerFailures: number
  breakerOpenSeconds: number
}

export const DEFAULT_DAV_RELAY_LIMITS: DavRelayLimits = {
  budgets: {
    requests: { max: 600, windowSeconds: 600 },
    writes: { max: 60, windowSeconds: 60 },
    validations: { max: 10, windowSeconds: 3_600 },
  },
  concurrentPerAccount: 2,
  concurrentPerOrigin: 4,
  concurrentTotal: 32,
  breakerFailures: 5,
  breakerOpenSeconds: 300,
}

/** The two counter contracts the gateway's stores offer (Redis, or the cache-entry store). */
export interface DavSharedCounterStore {
  incr?(key: string): Promise<number>
  expire?(key: string, seconds: number): Promise<unknown>
  incrementInWindow?(key: string, windowSeconds: number): Promise<number>
  ttl?(key: string): Promise<number>
}

interface Window {
  startedAt: number
  count: number
}

interface BreakerState {
  consecutiveFailures: number
  openUntil: number
}

const MAX_TRACKED_KEYS = 20_000

export class DavRelayLimiter {
  private readonly windows = new Map<string, Window>()
  private readonly breakers = new Map<string, BreakerState>()
  private readonly activeByAccount = new Map<string, number>()
  private readonly activeByOrigin = new Map<string, number>()
  private activeTotal = 0

  constructor(
    private readonly limits: DavRelayLimits = DEFAULT_DAV_RELAY_LIMITS,
    private readonly sharedStore?: DavSharedCounterStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Spends one unit of a user's budget, or throws `dav-rate-limited`. */
  async consume(userUuid: string, budget: DavBudget): Promise<void> {
    const limit = this.limits.budgets[budget]
    const windowMs = limit.windowSeconds * 1000
    const key = `${budget}:${userUuid}`
    const now = this.now()

    let window = this.windows.get(key)
    if (!window || now - window.startedAt >= windowMs) {
      window = { startedAt: now, count: 0 }
      this.rememberWindow(key, window, now)
    }
    if (window.count >= limit.max) {
      throw davRefusal.rateLimited(budget, Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000)))
    }
    window.count += 1

    const sharedCount = await this.sharedCount(key, limit.windowSeconds)
    if (sharedCount !== undefined && sharedCount > limit.max) {
      throw davRefusal.rateLimited(budget, await this.sharedRetryAfter(key, limit.windowSeconds))
    }
  }

  /**
   * Takes one of the concurrency slots, or throws `dav-busy`. The returned
   * function gives the slot back and is safe to call more than once.
   */
  acquire(accountKey: string, origin: string): () => void {
    if (this.activeTotal >= this.limits.concurrentTotal) {
      throw davRefusal.busy('server')
    }
    if ((this.activeByOrigin.get(origin) ?? 0) >= this.limits.concurrentPerOrigin) {
      throw davRefusal.busy('origin')
    }
    if ((this.activeByAccount.get(accountKey) ?? 0) >= this.limits.concurrentPerAccount) {
      throw davRefusal.busy('account')
    }

    this.activeTotal += 1
    this.activeByOrigin.set(origin, (this.activeByOrigin.get(origin) ?? 0) + 1)
    this.activeByAccount.set(accountKey, (this.activeByAccount.get(accountKey) ?? 0) + 1)

    let released = false
    return (): void => {
      if (released) {
        return
      }
      released = true
      this.activeTotal -= 1
      this.decrement(this.activeByOrigin, origin)
      this.decrement(this.activeByAccount, accountKey)
    }
  }

  /**
   * Throws `dav-remote-circuit-open` while this user's breaker for the origin
   * is open.
   *
   * The key includes the user on purpose. A breaker shared by everyone who
   * uses one origin would let one user close a public CalDAV provider for all
   * the others by provoking five errors. The process-wide socket ceiling is
   * what protects this server; the breaker only stops one user's sync from
   * hammering a server that is down.
   */
  assertCircuitClosed(userUuid: string, origin: string): void {
    const state = this.breakers.get(this.breakerKey(userUuid, origin))
    if (!state) {
      return
    }
    const now = this.now()
    if (state.openUntil > now) {
      throw davRefusal.circuitOpen(Math.max(1, Math.ceil((state.openUntil - now) / 1000)))
    }
  }

  recordSuccess(userUuid: string, origin: string): void {
    this.breakers.delete(this.breakerKey(userUuid, origin))
  }

  /**
   * A network failure or a 5xx. After the open period one request is let
   * through; if it fails too, the count is still at the threshold and the
   * breaker opens again at once.
   */
  recordFailure(userUuid: string, origin: string): void {
    const key = this.breakerKey(userUuid, origin)
    const state = this.breakers.get(key) ?? { consecutiveFailures: 0, openUntil: 0 }
    state.consecutiveFailures += 1
    if (state.consecutiveFailures >= this.limits.breakerFailures) {
      state.openUntil = this.now() + this.limits.breakerOpenSeconds * 1000
    }
    if (!this.breakers.has(key) && this.breakers.size >= MAX_TRACKED_KEYS) {
      this.breakers.clear()
    }
    this.breakers.set(key, state)
  }

  /** Requests in flight right now, for the administrator's view. */
  activeRequests(): number {
    return this.activeTotal
  }

  private breakerKey(userUuid: string, origin: string): string {
    return `${userUuid}|${origin}`
  }

  private decrement(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 1) - 1
    if (next <= 0) {
      counts.delete(key)
    } else {
      counts.set(key, next)
    }
  }

  private rememberWindow(key: string, window: Window, now: number): void {
    if (!this.windows.has(key) && this.windows.size >= MAX_TRACKED_KEYS) {
      // Drop windows that have run out. Dropping a live window would hand its
      // user a fresh budget, so live ones are kept even if that leaves the map
      // above the soft bound.
      for (const [existingKey, existing] of this.windows) {
        const budget = existingKey.slice(0, existingKey.indexOf(':')) as DavBudget
        if (now - existing.startedAt >= this.limits.budgets[budget].windowSeconds * 1000) {
          this.windows.delete(existingKey)
        }
      }
    }
    this.windows.set(key, window)
  }

  private async sharedCount(key: string, windowSeconds: number): Promise<number | undefined> {
    const store = this.sharedStore
    if (!store) {
      return undefined
    }
    const sharedKey = `dav-bridge:${key}`
    try {
      if (typeof store.incrementInWindow === 'function') {
        return await store.incrementInWindow(sharedKey, windowSeconds)
      }
      if (typeof store.incr === 'function') {
        const count = await store.incr(sharedKey)
        if (count === 1 && typeof store.expire === 'function') {
          await store.expire(sharedKey, windowSeconds)
        }
        return count
      }
    } catch {
      // The shared store is unavailable. The in-process count above has
      // already been applied, so this is a narrower budget, not an open door.
    }
    return undefined
  }

  private async sharedRetryAfter(key: string, windowSeconds: number): Promise<number> {
    const sharedKey = `dav-bridge:${key}`
    try {
      const ttl = await this.sharedStore?.ttl?.(sharedKey)
      if (typeof ttl === 'number' && ttl > 0) {
        return Math.ceil(ttl)
      }
      // A counter with no expiry (the increment landed and the expire did not)
      // would refuse this user for ever. Give it its horizon now.
      if (ttl === -1) {
        await this.sharedStore?.expire?.(sharedKey, windowSeconds)
      }
    } catch {
      // Fall through to the whole window: an honest upper bound.
    }
    return windowSeconds
  }
}
