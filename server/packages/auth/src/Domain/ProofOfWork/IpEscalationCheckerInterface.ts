/**
 * Standard Red Notes: reads the gateway's per-IP "escalate" signal from the
 * SHARED Redis cache (the api-gateway writes `rl:escalate:<ip>` with a short TTL
 * when an IP trips a rate-limit tier AND adaptive escalation is enabled). The
 * auth sign-in proof-of-work gate consults this so an abusive IP is challenged
 * even before its account crosses the failed-attempt threshold.
 *
 * MUST fail-open: any Redis error (or when escalation is disabled) resolves to
 * `false` so an infrastructure blip never forces PoW on legitimate users beyond
 * the normal account-based adaptive rule.
 */
export interface IpEscalationCheckerInterface {
  isEscalated(clientIp: string): Promise<boolean>
}
