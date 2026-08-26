/**
 * Standard Red Notes: why WebSocket sync is off, in operator terms.
 *
 * The realtime lane is gated at boot by a conjunction of four independent
 * conditions. Until now a failure of ANY of them produced the same two
 * artefacts: a `503 SYNC_DISABLED` on the wire and, at best, one warning saying
 * "durable backend and shared Redis state are required" -- which does not say
 * WHICH is missing. An operator staring at that line cannot tell an unset
 * signing secret from a deliberate kill switch from an unbound Redis, and the
 * three have nothing in common to fix. This module turns the gate into a list of
 * named, stable codes so a refusal explains itself.
 *
 * SECURITY: a code and its remedy name an ENVIRONMENT VARIABLE, never its value.
 * Nothing here accepts, stores, or formats a secret -- the inputs are booleans
 * derived by the caller precisely so a value cannot reach a log line.
 */
export const SyncPreconditionCodes = [
  'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
  'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION',
  'REDIS_UNBOUND',
  'SYNCING_SERVER_GRPC_UNBOUND',
] as const

export type SyncPreconditionCode = (typeof SyncPreconditionCodes)[number]

export interface SyncPreconditionState {
  /** WEB_SOCKET_CONNECTION_TOKEN_SECRET is set to a non-empty value. */
  connectionTokenSecretPresent: boolean
  /** WEBSOCKET_SYNC_ENABLED is not the exact `false` kill switch. */
  webSocketSyncEnabled: boolean
  /** A Redis client is bound in the container (see REDIS_URL / REDIS_HOST). */
  redisBound: boolean
  /** The gRPC syncing-server proxy is bound (see SYNCING_SERVER_GRPC_URL). */
  syncingServerGrpcBound: boolean
}

const REMEDIES: Readonly<Record<SyncPreconditionCode, string>> = Object.freeze({
  WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING:
    'set WEB_SOCKET_CONNECTION_TOKEN_SECRET to a strong random value; the gateway refuses to sign tickets with an empty key',
  WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION:
    'WEBSOCKET_SYNC_ENABLED is set to the exact string "false"; unset it or set it to "true" to re-enable the realtime transport',
  REDIS_UNBOUND:
    'no Redis client is bound; configure REDIS_URL (or REDIS_HOST/REDIS_PORT) and do not run with CACHE_TYPE=memory, because sync requires fleet-shared ticket, lease and socket-budget state',
  SYNCING_SERVER_GRPC_UNBOUND:
    'the gRPC syncing-server proxy is not bound; configure SYNCING_SERVER_GRPC_URL so realtime commands have a durable backend',
})

export interface SyncPrecondition {
  code: SyncPreconditionCode
  remedy: string
}

/**
 * Returns EVERY unmet precondition, not just the first. An operator who fixes
 * one and restarts only to hit the next has learned nothing from the first log
 * line; one line naming all of them ends the investigation in a single pass.
 * An empty array means the boot-time gate is fully satisfied.
 */
export function resolveUnmetSyncPreconditions(state: SyncPreconditionState): SyncPrecondition[] {
  const unmet: SyncPreconditionCode[] = []

  if (!state.connectionTokenSecretPresent) {
    unmet.push('WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING')
  }
  if (!state.webSocketSyncEnabled) {
    unmet.push('WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION')
  }
  if (!state.redisBound) {
    unmet.push('REDIS_UNBOUND')
  }
  if (!state.syncingServerGrpcBound) {
    unmet.push('SYNCING_SERVER_GRPC_UNBOUND')
  }

  return unmet.map((code) => ({ code, remedy: REMEDIES[code] }))
}

export function describeUnmetSyncPreconditions(preconditions: readonly SyncPrecondition[]): string {
  if (preconditions.length === 0) {
    return 'none'
  }
  return preconditions.map((precondition) => `${precondition.code} (${precondition.remedy})`).join('; ')
}
