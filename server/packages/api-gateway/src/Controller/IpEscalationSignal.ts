/**
 * Standard Red Notes: THE WRITER FOR THE PER-IP ESCALATE SIGNAL.
 *
 * When an address trips a rate-limit tier AND adaptive escalation is enabled,
 * the limiter's refusal branch flags it for five windows. Auth's adaptive
 * sign-in gate then demands a proof-of-work solution from that address on its
 * next attempts -- before the account it is guessing at has crossed the
 * failed-attempt threshold. That is the point of it: the account rule only fires
 * once ONE account has absorbed a run of failures, so a guesser spreading
 * attempts thinly across many accounts never trips it, and the per-address flag
 * is what charges them for the spread.
 *
 * WHY THIS IS A MODULE AND NOT TWO COPIES. This hook existed twice, inline and
 * byte-identical, in `api-gateway/bin/server.ts` and
 * `home-server/src/Server/HomeServer.ts` -- the two places that install the
 * limiter -- and both were keyed off the ioredis client, so the home-server copy
 * was never installed on the arm that bundle always runs. Two copies of one hook
 * is how one of them gets fixed and its twin does not, and neither copy had a
 * test, because neither was reachable without booting a server. One module with
 * its own spec, used by both.
 *
 * TWO BACKENDS, ONE BEHAVIOUR. With a shared Redis cache the flag is a
 * `SET <key> 1 EX <ttl>` on that client, which is what every Redis topology has
 * always done and what auth's `RedisIpEscalationChecker` reads. Without one
 * there is no shared cache client to write through, so the writer is the SAME
 * OBJECT auth reads from -- its `auth_cache_entries`-backed store, resolved
 * lazily out of the shared container -- so the key format has a single owner
 * rather than a copy at each end.
 *
 * IT IS A DECAYING MARKER, NOT A FIXED WINDOW. A later throttle legitimately
 * pushes the horizon out again: the flag lives `ttl` seconds past the LAST
 * refusal on both topologies. (A fixed window would be wrong here and the two
 * arms must not diverge.) Every write carries a horizon, so the flag cannot
 * become permanent -- a permanent proof-of-work demand on an address is a
 * lockout of everyone behind it.
 *
 * BEST-EFFORT, AND SILENT ABOUT IT. This runs inside the limiter's 429 branch,
 * whose own catch treats a throw as fail-open and calls `next()` -- which would
 * silently SPEND the refusal and admit the request. So the recorder returns
 * `void`, never throws, and swallows every error. The sync wrapper exists for
 * exactly that reason: `onThrottle` is synchronous, and an unhandled rejection
 * from a floating promise is not an option either.
 */

/** The key the flag is written under, identical on both backends. */
export const ESCALATE_KEY_PREFIX = 'rl:escalate'

/** The slice of ioredis this needs (keeps it unit-testable). */
export interface IpEscalationRedis {
  set(key: string, value: string, mode: string, seconds: number): Promise<unknown>
}

/** The slice of auth's table-backed store this needs. */
export interface IpEscalationWriter {
  escalate(clientIp: string, ttlSeconds: number): Promise<void>
}

export interface IpEscalationRecorderOptions {
  /** The effective tier config, re-resolved per refusal so an admin toggle applies live. */
  resolveConfig: () => Promise<{ adaptiveEscalation: boolean; windowSeconds: number }>
  /**
   * The shared cache client, when there is one. Checked for a callable `set`
   * rather than for presence: reading `.set` off a client that does not have it
   * throws a TypeError straight into the limiter's fail-open.
   */
  redis?: { set?(key: string, value: string, mode: string, seconds: number): Promise<unknown> }
  /**
   * The table-backed writer, resolved LAZILY because auth's container is loaded
   * into the gateway's AFTER it on the bundled topology. Returning `undefined`
   * means there is nothing to write for, which is the correct answer for a
   * standalone gateway with no cache and no database of its own.
   */
  resolveStore?: () => IpEscalationWriter | undefined
}

/**
 * How many tier windows the flag outlives. Five, so an address that trips a
 * 60-second tier stays challenged for five minutes -- long enough to outlast the
 * refusal it caused, short enough that a shared-NAT bystander is not punished
 * for someone else's afternoon.
 */
export const ESCALATE_WINDOW_MULTIPLE = 5

/**
 * Record an escalation for `clientIp`. Resolves once the write has been
 * attempted, so a spec can await it. NEVER REJECTS.
 */
export const recordIpEscalation = async (options: IpEscalationRecorderOptions, clientIp: string): Promise<void> => {
  try {
    if (!clientIp) {
      return
    }
    const resolved = await options.resolveConfig()
    if (!resolved.adaptiveEscalation) {
      return
    }
    const ttlSeconds = resolved.windowSeconds * ESCALATE_WINDOW_MULTIPLE
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      // A flag we could not expire is worse than no flag at all.
      return
    }

    if (typeof options.redis?.set === 'function') {
      await options.redis.set(`${ESCALATE_KEY_PREFIX}:${clientIp}`, '1', 'EX', ttlSeconds)

      return
    }

    await options.resolveStore?.()?.escalate(clientIp, ttlSeconds)
  } catch {
    // best-effort escalation signal: never let this reach the limiter.
  }
}

/**
 * The synchronous `onThrottle` hook the limiter takes. Fires and forgets
 * {@link recordIpEscalation}, which never rejects, so nothing escapes into the
 * refusal branch and no promise is left unhandled.
 */
export const createIpEscalationRecorder =
  (options: IpEscalationRecorderOptions): ((clientIp: string) => void) =>
  (clientIp: string): void => {
    void recordIpEscalation(options, clientIp)
  }
