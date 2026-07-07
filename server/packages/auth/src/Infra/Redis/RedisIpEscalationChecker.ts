import * as IORedis from 'ioredis'

import { IpEscalationCheckerInterface } from '../../Domain/ProofOfWork/IpEscalationCheckerInterface'

/**
 * Standard Red Notes: Redis-backed reader for the gateway's per-IP escalate flag
 * (`rl:escalate:<ip>`), which the api-gateway sets on the SAME shared Redis cache
 * when an IP trips a rate-limit tier and adaptive escalation is on.
 *
 * The check is config-gated by the SAME `adaptiveEscalation` flag the gateway
 * uses to decide whether to write the key, resolved per call from the shared
 * ServerSettings overlay so an admin toggle takes effect without a restart.
 *
 * FAIL-OPEN: when escalation is disabled OR any Redis/overlay read throws, this
 * returns `false` (no escalation) so a cache outage can never force PoW on
 * legitimate users beyond the normal account-based adaptive rule.
 */
export class RedisIpEscalationChecker implements IpEscalationCheckerInterface {
  private readonly PREFIX = 'rl:escalate'

  constructor(
    private redisClient: IORedis.Redis,
    private adaptiveEscalationEnabled: () => Promise<boolean>,
  ) {}

  async isEscalated(clientIp: string): Promise<boolean> {
    if (!clientIp) {
      return false
    }

    try {
      if (!(await this.adaptiveEscalationEnabled())) {
        return false
      }

      const exists = await this.redisClient.exists(`${this.PREFIX}:${clientIp}`)

      return exists === 1
    } catch {
      // FAIL-OPEN: never let a Redis error force proof-of-work on sign-in.
      return false
    }
  }
}
