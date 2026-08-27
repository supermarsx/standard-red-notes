import type { SyncNegotiatedOperation } from '@standard-red-notes/websocket-gateway'

import {
  resolveUnmetSyncItemsPreconditions,
  resolveUnmetSyncPreconditions,
  resolveUnmetSyncTransportPreconditions,
  type SyncPrecondition,
  type SyncPreconditionCode,
  type SyncPreconditionState,
} from './SyncWebSocketPreconditions'

/**
 * Every operation this SERVER build knows how to negotiate, in the order
 * syncCommandHandler advertises them at AUTHENTICATED. Which subset a given
 * connection is actually offered depends on the adapters that composed at boot,
 * so this is the CEILING, not a promise — the client compares it against what
 * its own socket negotiated, and against what the client build implements. The
 * `satisfies` clause makes a new protocol operation a compile error here rather
 * than a silently short list in the admin panel.
 */
export const SYNC_SERVER_OPERATIONS = [
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  'FILES_V1',
] as const satisfies readonly SyncNegotiatedOperation[]

/**
 * Standard Red Notes: the boot-time record of WHY the realtime sync lane is (or
 * is not) available, shaped for the admin diagnostics panel.
 *
 * The four-condition gate itself is NOT restated here — `SyncWebSocketPreconditions`
 * owns it, and is the same module the boot log reads from. That is deliberate:
 * a second copy of the condition list would let the log line and the admin panel
 * drift apart, and an operator comparing the two would have no way to tell which
 * one was stale. This module adds only what the panel needs beyond that list:
 *
 *   - whether the gate has run AT ALL. `unmetPreconditions` defaults to an empty
 *     array, which is indistinguishable from "all four satisfied"; a request that
 *     lands during boot would otherwise render four green ticks on no evidence.
 *   - the FILES_V1 outcome, which is decided further inside the gate and has its
 *     own preconditions.
 *
 * *** SECURITY BOUNDARY ***
 * This records configuration PRESENCE, never configuration VALUES. Enforced
 * structurally rather than by convention: `record()` accepts only booleans and a
 * closed set of literal keys, so there is no field a URL, host or secret could
 * be passed through even by mistake. Every human-readable string in the payload
 * is a compile-time constant. Do not add a free-form string field here — route
 * new information through a new literal key instead.
 */

/**
 * Which of the FILES_V1 preconditions the multi-container composition found
 * missing. `FILES_INTERNAL_URL` covers the whole
 * WEBSOCKET_SYNC_FILES_URL / FILES_SERVER_PROBE_URL / FILES_SERVER_URL group,
 * because any one of them satisfies the requirement.
 *
 * `TRANSPORT_CONSTRUCTION` is the residual case: every value was present but the
 * adapter still threw. The thrown message is deliberately NOT carried here — the
 * construction-failure branch interpolates it, and it can embed the resolved
 * files-service URL. That detail stays in the boot log, where the reader already
 * holds the host.
 */
export type SyncFilesUnmetCondition =
  | 'FILES_INTERNAL_URL'
  | 'AUTH_JWT_SECRET'
  | 'VALET_TOKEN_SECRET'
  | 'TRANSPORT_CONSTRUCTION'

const FILES_REMEDIES: Readonly<Record<SyncFilesUnmetCondition, string>> = Object.freeze({
  FILES_INTERNAL_URL:
    'no INTERNAL files service URL is configured. Set WEBSOCKET_SYNC_FILES_URL (or FILES_SERVER_PROBE_URL) to the address the api-gateway can reach the files service on. FILES_SERVER_URL is only used when it is demonstrably not the public URL, because the bundled image aliases the two.',
  AUTH_JWT_SECRET:
    'AUTH_JWT_SECRET is not set, so the live session behind a file transfer cannot be re-validated.',
  VALET_TOKEN_SECRET:
    'VALET_TOKEN_SECRET is not set, so minted valet credentials cannot be verified before they are presented to storage.',
  TRANSPORT_CONSTRUCTION:
    'every required value was present but the files transport still failed to construct. The boot log carries the thrown message, which is withheld here because it can embed the resolved files-service URL.',
})

export type SyncFilesReport = {
  /** FILES_V1 was advertised to clients. */
  advertised: boolean
  /** Null when advertised, or when the lane never got far enough to decide. */
  unmetCondition: SyncFilesUnmetCondition | null
  /** Constant copy for the unmet condition. Null when there is none. */
  remedy: string | null
}

export type SyncGateDiagnosticsReport = {
  /**
   * False before the gate has run at all — a request that lands during boot, or
   * a build where the recorder was never wired. The UI must say "not recorded"
   * rather than present an empty unmet list as a healthy gate.
   */
  recorded: boolean
  /** The ws gateway was attached to the http server (token minting is possible). */
  gatewayAttached: boolean
  /** The sync lane itself was built — this is what makes POST /ticket succeed. */
  syncLaneEnabled: boolean
  /**
   * Whether the SYNC_ITEMS operation is offered on that lane. Reported
   * SEPARATELY from `syncLaneEnabled` because they are now independent: a lane
   * can be fully up and serving collaboration, API RPC, invite events and files
   * while SYNC_ITEMS is withheld for want of a durable command port, with
   * clients syncing over HTTP. Collapsing the two would show an operator a
   * healthy lane and leave them no way to see the missing operation.
   */
  syncItemsAdvertised: boolean
  /** Every unmet boot condition, from SyncWebSocketPreconditions. */
  unmetPreconditions: SyncPrecondition[]
  /** Just the codes, for callers that only need the set. */
  unmetCodes: SyncPreconditionCode[]
  files: SyncFilesReport
}

/**
 * Recorded by bin/server.ts at the gate. Every field is a boolean or a literal
 * key — see the security note above.
 */
export type SyncGateObservation = SyncPreconditionState & {
  filesAdvertised: boolean
  filesUnmetCondition?: SyncFilesUnmetCondition
}

const NO_FILES: SyncFilesReport = Object.freeze({ advertised: false, unmetCondition: null, remedy: null })

/**
 * Late-bound like SyncWebSocketAccessService: the controller is registered
 * before app.build(), the gate runs afterwards against the owned http server.
 */
export class SyncGateDiagnosticsRecorder {
  private observation?: SyncGateObservation

  record(observation: SyncGateObservation): void {
    this.observation = observation
  }

  clear(): void {
    this.observation = undefined
  }

  report(): SyncGateDiagnosticsReport {
    const observed = this.observation
    if (!observed) {
      return {
        recorded: false,
        gatewayAttached: false,
        syncLaneEnabled: false,
        syncItemsAdvertised: false,
        unmetPreconditions: [],
        unmetCodes: [],
        files: { ...NO_FILES },
      }
    }

    // The full list is still what the panel renders, so the gRPC condition
    // remains visible and named; only which of them gate WHAT has changed.
    const unmetPreconditions = resolveUnmetSyncPreconditions(observed)
    const laneEnabled = resolveUnmetSyncTransportPreconditions(observed).length === 0

    return {
      recorded: true,
      gatewayAttached: observed.connectionTokenSecretPresent,
      syncLaneEnabled: laneEnabled,
      syncItemsAdvertised: laneEnabled && resolveUnmetSyncItemsPreconditions(observed).length === 0,
      unmetPreconditions,
      unmetCodes: unmetPreconditions.map(({ code }) => code),
      files: {
        advertised: observed.filesAdvertised,
        unmetCondition: observed.filesUnmetCondition ?? null,
        remedy: observed.filesUnmetCondition ? FILES_REMEDIES[observed.filesUnmetCondition] : null,
      },
    }
  }
}

export const syncGateDiagnostics = new SyncGateDiagnosticsRecorder()
