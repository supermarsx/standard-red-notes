import { namespacedDedupPrefix, parseRedisNamespace } from '@standard-red-notes/websocket-gateway'

/**
 * Standard Red Notes (C10 / R34 / N17): one per-deployment namespace for every
 * Redis channel and key the realtime path uses, so two stacks on one Redis stop
 * cross-talking. Resolved ONCE at boot and handed to every consumer — the
 * gateway config, the SQS dedup store, the invite-event store and its
 * availability bus — so they can never disagree. Empty means byte-identical
 * names to a deployment that never set it (a rolling upgrade keeps old and new
 * replicas talking).
 */
export interface RealtimeRedisNamespace {
  /** Validated `WEBSOCKET_REDIS_NAMESPACE`, or undefined when unset/blank. */
  namespace: string | undefined
  /** The gateway's `namespacedDedupPrefix`: `ws:sqs:event:v1:` or `<namespace>:ws:sqs:event:v1:`. */
  sqsDedupKeyPrefix: string
}

/**
 * Both validators are the gateway's own: `parseRedisNamespace` (trim, blank →
 * undefined, `^[a-z0-9:_-]{1,64}$`) and, inside `namespacedDedupPrefix`, the
 * channel/key rule that also refuses a leading or trailing colon. Running them
 * HERE means an invalid value is refused at boot with the variable named,
 * before any consumer that would otherwise throw at construction is built.
 */
export function resolveRealtimeRedisNamespace(raw: string | undefined): RealtimeRedisNamespace {
  const namespace = parseRedisNamespace(raw)

  return { namespace, sqsDedupKeyPrefix: namespacedDedupPrefix(namespace) }
}
