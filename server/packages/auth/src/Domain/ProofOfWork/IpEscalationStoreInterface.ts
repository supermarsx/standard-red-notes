import { IpEscalationCheckerInterface } from './IpEscalationCheckerInterface'

/**
 * Standard Red Notes: the per-IP escalate signal from BOTH ends.
 *
 * {@link IpEscalationCheckerInterface} is the reader the sign-in proof-of-work
 * gate consults. On a Redis deployment the WRITER is the gateway's ioredis client
 * itself (`SET rl:escalate:<ip> 1 EX <ttl>` straight out of the rate limiter's
 * 429 branch), so there was never an interface for it.
 *
 * On the no-Redis arm there is no shared cache client to write through, so the
 * store that answers the read has to be the same object that takes the write --
 * otherwise the two halves of the ramp would own the key format separately and
 * could drift. This is that object: ONE owner of `rl:escalate:<ip>`, handed to
 * auth's gate as a reader and resolved by the home-server's throttle hook as a
 * writer.
 */
export interface IpEscalationStoreInterface extends IpEscalationCheckerInterface {
  /**
   * Flag `clientIp` as escalated for `ttlSeconds`. Mirrors the Redis arm's
   * `SET ... EX`: this is a DECAYING MARKER, not a fixed-window counter, so a
   * later throttle legitimately pushes the horizon out again -- the flag lives
   * `ttlSeconds` past the LAST throttle on both topologies.
   *
   * MUST NOT throw: this runs inside a best-effort hook on the refusal path.
   */
  escalate(clientIp: string, ttlSeconds: number): Promise<void>
}
