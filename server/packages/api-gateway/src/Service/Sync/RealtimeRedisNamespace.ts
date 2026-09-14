import { parseRedisNamespace } from '@standard-red-notes/websocket-gateway'

/**
 * Standard Red Notes (C10 / R34 / N17): one per-deployment namespace for every
 * Redis channel and key the realtime path uses, so two stacks on one Redis stop
 * cross-talking. Resolved ONCE at boot and handed to every consumer — the
 * gateway config, the SQS dedup store, the invite-event store and its
 * availability bus — so they can never disagree. Empty means byte-identical
 * names to a deployment that never set it (a rolling upgrade keeps old and new
 * replicas talking).
 */

/**
 * The gateway's own dedup key prefix (`DEFAULT_SQS_DEDUP_KEY_PREFIX` in
 * websocket-gateway/src/sqsConsumer.ts). Its `namespacedDedupPrefix` helper is
 * not re-exported from the package barrel yet; this mirrors it byte for byte
 * and the spec pins the format. Replace with the helper once it is exported.
 */
export const SQS_DEDUP_KEY_PREFIX = 'ws:sqs:event:v1:'

export interface RealtimeRedisNamespace {
  /** Validated `WEBSOCKET_REDIS_NAMESPACE`, or undefined when unset/blank. */
  namespace: string | undefined
  /** `ws:sqs:event:v1:` or `<namespace>:ws:sqs:event:v1:`. */
  sqsDedupKeyPrefix: string
}

/**
 * Validates like the gateway (`^[a-z0-9:_-]{1,64}$`, no leading or trailing
 * colon — the rule its channel helper enforces at attach) and throws a message
 * that names the VARIABLE, never the value, so the boot log can print it.
 */
export function resolveRealtimeRedisNamespace(raw: string | undefined): RealtimeRedisNamespace {
  const namespace = parseRedisNamespace(raw)
  if (namespace !== undefined && (namespace.startsWith(':') || namespace.endsWith(':'))) {
    throw new Error('WEBSOCKET_REDIS_NAMESPACE must not start or end with a colon.')
  }

  return {
    namespace,
    sqsDedupKeyPrefix: namespace === undefined ? SQS_DEDUP_KEY_PREFIX : `${namespace}:${SQS_DEDUP_KEY_PREFIX}`,
  }
}
