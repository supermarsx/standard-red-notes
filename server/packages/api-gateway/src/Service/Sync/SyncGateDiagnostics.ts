import type { AttachOptions, SyncNegotiatedOperation } from '@standard-red-notes/websocket-gateway'

import {
  resolveUnmetSyncItemsPreconditions,
  resolveUnmetSyncPreconditions,
  resolveUnmetSyncTransportPreconditions,
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
 *   - the SYNC_ITEMS outcome, which is NOT a precondition question at all: the
 *     handshake decides it by calling `backend.ready()`, so the gate reads that
 *     same predicate instead of inferring it. See the SYNC_ITEMS block below.
 *
 * *** SECURITY BOUNDARY ***
 * This records configuration PRESENCE, never configuration VALUES. Enforced
 * structurally rather than by convention: `record()` accepts only booleans and a
 * closed set of literal keys, so there is no field a URL, host or secret could
 * be passed through even by mistake. Every human-readable string in the payload
 * is a compile-time constant. Do not add a free-form string field here — route
 * new information through a new literal key instead.
 *
 * `observeSyncItems()` is the one method that takes a rich object rather than
 * booleans, and it is not a hole in that boundary: the lane is READ and handed
 * straight back, and the only thing kept from it is one value of the closed
 * `SyncItemsProbeOutcome` set. Nothing derived from the lane — not a thrown
 * message, not a resolved address, not a length — may be stored or reported.
 * The lane's IDENTITY is kept, in a `WeakSet` that holds no strong reference
 * and that nothing is ever read out of (see `observeSyncItems`); it is a
 * membership token for "this lane has already been read", never a channel.
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
  'FILES_INTERNAL_URL' | 'AUTH_JWT_SECRET' | 'VALET_TOKEN_SECRET' | 'TRANSPORT_CONSTRUCTION'

const FILES_REMEDIES: Readonly<Record<SyncFilesUnmetCondition, string>> = Object.freeze({
  FILES_INTERNAL_URL:
    'no INTERNAL files service URL is configured. Set WEBSOCKET_SYNC_FILES_URL (or FILES_SERVER_PROBE_URL) to the address the api-gateway can reach the files service on. FILES_SERVER_URL is only used when it is demonstrably not the public URL, because the bundled image aliases the two.',
  AUTH_JWT_SECRET: 'AUTH_JWT_SECRET is not set, so the live session behind a file transfer cannot be re-validated.',
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

/**
 * A condition a HOST adds on top of the shared four, when its own composition
 * cannot attach the lane for a reason the shared gate has no word for. The
 * home server records `WEBSOCKET_REDIS_NAMESPACE_INVALID` when the namespace
 * every shared Redis name would take is malformed: attaching WITHOUT it would
 * publish on a sibling stack's bare channels, so it attaches nothing. Like
 * every other key here it is a literal, never the configured value. Each host
 * records at most one.
 */
export type SyncHostUnmetCondition = 'WEBSOCKET_REDIS_NAMESPACE_INVALID'

export const SYNC_HOST_REMEDIES: Readonly<Record<SyncHostUnmetCondition, string>> = Object.freeze({
  WEBSOCKET_REDIS_NAMESPACE_INVALID:
    'WEBSOCKET_REDIS_NAMESPACE is set but does not match ^[a-z0-9:_-]{1,64}$ (no leading or trailing colon); fix or unset it. Until then the realtime gateway is not attached and the push bridge stays closed, so nothing is published on the un-namespaced channels of a sibling stack sharing this Redis',
})

/** A code the report can carry: one of the shared four, or a host condition. */
export type SyncGateUnmetCode = SyncPreconditionCode | SyncHostUnmetCondition

export type SyncGateUnmetPrecondition = {
  code: SyncGateUnmetCode
  remedy: string
}

export type SyncHostReport = {
  /** Null when the host recorded no condition of its own. */
  unmetCondition: SyncHostUnmetCondition | null
  /** Constant copy for the unmet condition. Null when there is none. */
  remedy: string | null
}

/**
 * ---------------------------------------------------------------------------
 * SYNC_ITEMS: observed from the handshake's own predicate, never derived.
 * ---------------------------------------------------------------------------
 *
 * The bug this exists to make unrepeatable: the gate reported SYNC_ITEMS as
 * AVAILABLE from `container.isBound(ApiGateway_GRPCSyncingServerServiceProxy)`
 * -- that a proxy OBJECT was constructed -- while the handshake offers the
 * operation only when `options.backend.ready()` is true (syncCommandHandler,
 * at AUTHENTICATED). Those are not the same question. `ready()` additionally
 * requires `AUTH_JWT_SECRET` (session revalidation) and a durable port whose
 * `durableCommandAuthenticationReady()` holds -- which for the gRPC port means
 * a `SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET` of at least 32 bytes. So a
 * deployment that sets `SERVICE_PROXY_TYPE=grpc` and forgets (or truncates)
 * that secret binds the proxy, satisfies the old gate, and is refused by the
 * socket: the panel read "available" for days while every client synced over
 * HTTP. A diagnostic that is wrong in the operator's favour is worse than none.
 *
 * Two structural properties keep the claim and the handshake together, rather
 * than one more boolean in the conjunction:
 *
 *   1. `SyncGateObservation` -- everything a composition root can `record()` --
 *      has NO field for this verdict. A host cannot assert SYNC_ITEMS
 *      availability at all, by accident or by re-derivation from a weaker
 *      signal, because no such field exists to carry it. The verdict lives in
 *      its own slot on the recorder, which `record()` neither sets nor clears,
 *      so the repeated whole-record patches both hosts perform cannot touch it.
 *   2. The ONLY way to reach `'ADVERTISED'` is `observeSyncItems()`, which
 *      takes the sync lane the gateway is being handed and calls
 *      `backend.ready()` on it itself. Its parameter type is derived from
 *      `AttachOptions['sync']`, so it is the gateway's own option shape: the
 *      object probed is the object that will answer the handshake, and
 *      renaming either the option or the predicate is a compile error here.
 *   3. It is called from exactly ONE place: `SyncWebSocketRuntime.attach()`,
 *      the seam every host's lane passes through to exist at all. It was
 *      first wired in the api-gateway's own composition root, which left the
 *      bundled home server self-asserting a green it had never measured; and a
 *      per-host probe is one more line each new host can forget. The runtime
 *      seam covers every host with no host code, is probed only AFTER the
 *      gateway attached (a lane whose attach threw can no longer report
 *      ADVERTISED), and -- unlike a composition root, which has no spec -- is
 *      covered by `SyncWebSocketRuntime.spec.ts`, so deleting the probe fails
 *      a test instead of silently restoring the original bug.
 *
 * The one signal admitted WITHOUT a probe is admitted only in the direction
 * that WITHHOLDS: an unbound durable port cannot be ready (`ready()` requires
 * `durableSync !== undefined`), so `syncingServerGrpcBound === false` is
 * sufficient for `'WITHHELD'`. Bound-ness is never sufficient for available.
 *
 * That same signal is ALSO what names the cause, and conflating the two states
 * it separates was a live, operator-visible defect: a deployment with no
 * durable port bound at all was told "the durable command port IS BOUND but
 * failed its readiness check" and sent after the internal gRPC secret, while
 * the same response carried `boundServiceProxy: 'http'` and
 * `unmetCodes: ['SYNCING_SERVER_GRPC_UNBOUND']`. One response contradicting
 * itself, and the remedy pointing at the wrong variable. `ready()` is a
 * CONJUNCTION (see `SyncWebSocketCommandAdapter.ready`) and a single `false`
 * cannot say which term failed -- but the gate separately observed whether a
 * port exists, so the two reachable shapes of that `false` are distinguishable
 * without inventing anything:
 *
 *   - no port bound          -> `'DURABLE_BACKEND_UNBOUND'`, whose remedy is the
 *                              shared `SYNCING_SERVER_GRPC_UNBOUND` one
 *                              (SERVICE_PROXY_TYPE, the dial target), taken from
 *                              `SyncWebSocketPreconditions` rather than copied;
 *   - a port bound, refusing -> `'DURABLE_BACKEND_NOT_READY'`, whose remedy is
 *                              the under-32-byte internal secret.
 *
 * Both are `'WITHHELD'`, so splitting them adds no route to `'ADVERTISED'`.
 * The split keys off a POSITIVE observation of absence (`=== false`), never off
 * a missing one: where the gate recorded nothing there is no bound-ness reading
 * at all, and claiming `UNBOUND` from an absent gate would be fabricating a
 * configuration fact in place of the one that was fabricated before.
 *
 * *** AUTH_JWT_SECRET is deliberately NOT named by either remedy. *** `ready()`
 * does require it -- `sessionAuthorizationReady()` is `authJwtSecret.length > 0`
 * -- and the remedy used to say so, but that term's FALSE branch is unreachable
 * on every host that can serve this report: `Bootstrap/Container.ts` reads
 * `env.get('AUTH_JWT_SECRET')` NON-optionally, and `AbstractEnv.get` throws on a
 * falsy value, so an empty or unset secret is a fatal startup (measured live:
 * `FATAL startup`, a supervisord restart loop, readiness `502`) and there is no
 * gateway left to answer `/v1/admin/sync-diagnostics`. Both composition roots
 * then pass `env.get('AUTH_JWT_SECRET', true) || ''` into the adapter, so the
 * `''` the predicate tests for cannot arrive. The term is retained in `ready()`
 * regardless, and must be: the adapter is a library class that any host may
 * compose (its own spec drives the empty case directly), the non-optional read
 * is one `Container.ts` edit away from becoming optional, and a predicate that
 * stopped checking a key it signs with would fail OPEN. What was removed is the
 * ADVICE, not the check -- an operator cannot act on a variable whose absence
 * would have stopped their server.
 *
 * `'NOT_OBSERVED'` is deliberately NOT folded into "withheld". A host that
 * never probed (or a probe that threw) leaves the gate unable to answer, and
 * saying "withheld" there would be the same class of error in the other
 * direction -- it would tell a single-container operator their notes are on
 * HTTP when they are not. In that state `syncItemsAdvertised` is ABSENT from
 * the report (the panel's own guard is `!== undefined`), so the panel makes no
 * claim at all.
 *
 * SNAPSHOT, not a subscription: this is a boot-time reading of a live
 * predicate, correct because every input to `ready()` is fixed at process
 * start. The strictly better source is the attached gateway's own closure --
 * `SyncGatewayAccess` would have to expose it -- which the admin endpoint could
 * then read per request for every host at once.
 */

/** Exactly the lane object the gateway receives, so the probe cannot drift. */
type GatewaySyncLane = NonNullable<AttachOptions['sync']>

/**
 * The handshake's predicate, and nothing else: `syncCommandHandler` advertises
 * SYNC_ITEMS if and only if `options.backend.ready()`.
 */
export type SyncItemsHandshakeProbe = Pick<GatewaySyncLane, 'backend'>

/** What the probe found. `'NEVER_PROBED'` is the recorder's initial state. */
export type SyncItemsProbeOutcome = 'NEVER_PROBED' | 'READY' | 'NOT_READY' | 'NO_LANE' | 'PROBE_FAILED'

/**
 * Three states, never two: available, withheld, or not determined. The panel
 * must be able to tell the third from the second.
 */
export type SyncItemsGateState = 'ADVERTISED' | 'WITHHELD' | 'NOT_OBSERVED'

/**
 * Why, as a closed enum. A too-short or missing internal secret is reported as
 * `DURABLE_BACKEND_NOT_READY` -- never by length, never by content, never by
 * naming which of the readiness terms failed, because the probe is a single
 * boolean and inventing detail it does not carry would be a second lie.
 *
 * `DURABLE_BACKEND_UNBOUND` is the OTHER shape of the same `false` and has its
 * own remedy: no durable port was bound at all, which is a SERVICE_PROXY_TYPE /
 * dial-target problem and not a secret-length one. The two are separated by the
 * gate's own `syncingServerGrpcBound` reading, which is recorded independently
 * of the probe -- see the SYNC_ITEMS block above for why collapsing them onto
 * the "bound but not ready" cause was a defect rather than a simplification.
 */
export type SyncItemsGateCause =
  | 'LANE_PRECONDITION_UNMET'
  | 'SYNC_LANE_NOT_BUILT'
  | 'DURABLE_BACKEND_UNBOUND'
  | 'DURABLE_BACKEND_NOT_READY'
  | 'NEVER_PROBED'
  | 'PROBE_FAILED'
  | 'GATE_NOT_RECORDED'

export const SYNC_ITEMS_CAUSE_REMEDIES: Readonly<Record<SyncItemsGateCause, string | null>> = Object.freeze({
  // The lane's own conditions are already listed, with remedies, in
  // `unmetPreconditions`; restating them here is how two copies drift.
  LANE_PRECONDITION_UNMET: null,
  SYNC_LANE_NOT_BUILT:
    'a gateway is attached but it was given no sync lane, so no operation is negotiated on the socket at all; the unmet conditions in this report name why the lane was not built',
  // Taken from SyncWebSocketPreconditions at report time, not copied here.
  DURABLE_BACKEND_UNBOUND: null,
  DURABLE_BACKEND_NOT_READY:
    'the durable command port FAILED the readiness check the handshake itself makes, so the socket will not offer SYNC_ITEMS and notes sync over HTTP while every other capability stays realtime. A deployment that binds NO durable command port is a DIFFERENT cause with a different fix (DURABLE_BACKEND_UNBOUND, which is about SERVICE_PROXY_TYPE and the dial target), so this one is about a port that exists and refuses: for the gRPC port the check needs SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET set to AT LEAST 32 bytes and identical on the syncing server. A bound proxy is not evidence of that',
  NEVER_PROBED:
    'this host recorded no reading of the handshake predicate, so the gate cannot say whether SYNC_ITEMS is offered. Treat it as unknown: it is neither a healthy lane nor a withheld operation. A host built before the gate took its own reading reports this',
  PROBE_FAILED:
    'the readiness check the handshake makes threw while the gate was reading it, so the answer is unknown. The boot log carries the failure; it is withheld here because a thrown message can embed a resolved service address',
  GATE_NOT_RECORDED:
    'the boot gate has not been recorded yet (a request that landed during startup), so there is nothing to read the lane from. See `recorded` in this report',
})

export type SyncItemsReport = {
  state: SyncItemsGateState
  /** Null only when `state` is `'ADVERTISED'`. */
  cause: SyncItemsGateCause | null
  /** Constant copy, or the shared precondition remedy. Null when there is none. */
  remedy: string | null
  /** The raw probe reading, so the panel can tell "unknown" apart from "no". */
  probe: SyncItemsProbeOutcome
}

export type SyncGateDiagnosticsReport = {
  /**
   * False before the gate has run at all — a request that lands during boot, or
   * a build where the recorder was never wired. The UI must say "not recorded"
   * rather than present an empty unmet list as a healthy gate.
   */
  recorded: boolean
  /**
   * The ws gateway was attached to the http server (token minting is possible).
   * Taken from the recorded attach outcome; `false` until the host records one.
   */
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
   *
   * ABSENT -- not `false` -- when `syncItems.state` is `'NOT_OBSERVED'`. The
   * panel's guard on this field is `!== undefined`, so omitting it is how "the
   * gate cannot say" renders as no claim instead of as a withheld operation.
   * `syncItems` carries the same verdict in full, including that third state.
   */
  syncItemsAdvertised?: boolean
  /** The SYNC_ITEMS verdict with its provenance (see `SyncItemsReport`). */
  syncItems: SyncItemsReport
  /**
   * Every unmet boot condition: the shared ones from SyncWebSocketPreconditions,
   * then the host's own (see `host`), so the panel's single list names ALL of
   * them and never shows a lane down with an empty list.
   */
  unmetPreconditions: SyncGateUnmetPrecondition[]
  /** Just the codes, for callers that only need the set. */
  unmetCodes: SyncGateUnmetCode[]
  files: SyncFilesReport
  /** The host-added condition on its own, for renderers that treat it apart. */
  host: SyncHostReport
}

/**
 * Recorded by bin/server.ts at the gate. Every field is a boolean or a literal
 * key — see the security note above.
 */
/**
 * Recorded by each composition root at its gate. Beyond the shared
 * `SyncPreconditionState` booleans it carries only literal keys -- including
 * C16's `sharedState` (`'redis' | 'in-process' | 'none'`), which is what keeps
 * REDIS_UNBOUND off a single container that keeps its realtime state in the one
 * process holding the sockets. Nothing here is ever a configured VALUE.
 */
export type SyncGateObservation = SyncPreconditionState & {
  filesAdvertised: boolean
  filesUnmetCondition?: SyncFilesUnmetCondition
  /**
   * Whether the ws gateway actually attached to the http server — recorded
   * from the ATTACH OUTCOME by the composition root, never re-derived from the
   * secret's presence. Deriving it used to report `true` on a single container
   * that attached no gateway (no Redis) and `false` on a compose stack whose
   * legacy lane was up on a short secret. Optional so a host that has not yet
   * recorded the outcome (boot in progress, an older host) reads as not
   * attached rather than as attached on no evidence.
   */
  gatewayAttached?: boolean
  /**
   * A condition only this host's composition can see (see
   * `SyncHostUnmetCondition`). Optional and additive: a host with nothing to
   * add, or an older host, records no key and the report reads as before.
   */
  hostUnmetCondition?: SyncHostUnmetCondition
  /**
   * There is deliberately NO field here for SYNC_ITEMS availability. It is the
   * one verdict a composition root cannot assert: it comes only from
   * `observeSyncItems()`, which reads the handshake's own predicate off the
   * lane being handed to the gateway. `syncingServerGrpcBound` above is a
   * weaker signal (a proxy object exists) and is admitted only where it
   * WITHHOLDS. See the SYNC_ITEMS block above for why.
   */
}

const NO_FILES: SyncFilesReport = Object.freeze({ advertised: false, unmetCondition: null, remedy: null })
const NO_HOST: SyncHostReport = Object.freeze({ unmetCondition: null, remedy: null })

/**
 * Late-bound like SyncWebSocketAccessService: the controller is registered
 * before app.build(), the gate runs afterwards against the owned http server.
 */
export class SyncGateDiagnosticsRecorder {
  private observation?: SyncGateObservation
  /**
   * The SYNC_ITEMS reading, in its OWN slot. `record()` neither sets nor clears
   * it, which is what makes it un-clobberable: both composition roots record
   * the whole observation repeatedly as boot proceeds (files, then the attach
   * outcome), so a verdict kept inside that object would be erased by whichever
   * patch landed next, and a verdict a host could pass through `record()` could
   * be re-derived from the wrong signal. Only `observeSyncItems()` writes here.
   */
  private syncItemsProbe: SyncItemsProbeOutcome = 'NEVER_PROBED'
  /**
   * The lanes already read, by IDENTITY. Re-reading one cannot help -- every
   * input to `ready()` is fixed at process start -- and it can HARM: a second
   * call that happened to throw would replace a real reading with
   * `'PROBE_FAILED'`, i.e. downgrade a definite answer to "unknown". So the
   * first reading of a lane is final.
   *
   * Keyed per lane rather than "probed at all" on purpose. A blanket
   * first-wins flag would make a reading survive the lane it was taken from:
   * an in-process host that stops and restarts its gateway (HomeServer is a
   * library, not only a process) would keep the PREVIOUS boot's verdict, and a
   * boot that built no lane would still read `'READY'` -- a false ADVERTISED,
   * the exact failure direction this module exists to rule out. A lane the
   * recorder has not seen is therefore always read afresh.
   *
   * A `WeakSet` because the recorder is process-global and must not keep a
   * stopped gateway's composition alive. Nothing is ever read out of it beyond
   * membership, so it carries no information (see the security note above).
   */
  private syncItemsRead = new WeakSet<object>()

  record(observation: SyncGateObservation): void {
    this.observation = observation
  }

  /**
   * Reads the handshake's own predicate off the sync lane the gateway was just
   * given, and returns that same lane so the call can sit in the handover
   * itself. Its one caller is `SyncWebSocketRuntime.attach()`:
   *
   *     const gateway = this.attachGateway(options)
   *     this.diagnostics.observeSyncItems(options.sync)
   *
   * The object probed is therefore the object that will answer the handshake --
   * not a second one that could disagree -- for EVERY host, because that is
   * the seam a lane must pass through to exist at all. `undefined` (this
   * deployment built no lane) is an answer, not a failure to answer.
   *
   * IDEMPOTENT per lane: the first reading of a given lane is final, so a
   * second call site (a host that also probes, a gateway re-attached to the
   * same lane) can neither change the verdict nor weaken it. A lane the
   * recorder has not read before is always read afresh -- see
   * `syncItemsRead` for why that distinction is not an optimisation.
   *
   * A thrown predicate is recorded as `'PROBE_FAILED'` -- unknown, never
   * available -- and the thrown value is dropped here: it can embed a resolved
   * service address, and nothing in this module may carry one.
   */
  observeSyncItems<TLane extends SyncItemsHandshakeProbe>(lane: TLane | undefined): TLane | undefined {
    if (lane === undefined) {
      this.syncItemsProbe = 'NO_LANE'
      return undefined
    }
    if (this.syncItemsRead.has(lane)) {
      return lane
    }
    this.syncItemsRead.add(lane)
    try {
      this.syncItemsProbe = lane.backend.ready() ? 'READY' : 'NOT_READY'
    } catch {
      this.syncItemsProbe = 'PROBE_FAILED'
    }
    return lane
  }

  clear(): void {
    this.observation = undefined
    this.syncItemsProbe = 'NEVER_PROBED'
    // Forgets which lanes were read as well as what they said, so `clear()`
    // leaves a recorder indistinguishable from a fresh one.
    this.syncItemsRead = new WeakSet()
  }

  /**
   * The SYNC_ITEMS verdict. Three states, and the only route to `'ADVERTISED'`
   * is a probe that returned `'READY'` over a lane the gate also found enabled.
   */
  private resolveSyncItems(lane: {
    recorded: boolean
    enabled: boolean
    /**
     * Whether a durable command port was observed to exist. `undefined` is NOT
     * `false`: it means the gate recorded no observation at all, so there is
     * nothing to read bound-ness from. The distinction is load-bearing --
     * `false` names `DURABLE_BACKEND_UNBOUND`, which is a claim about this
     * deployment's configuration, and deriving that claim from an absent gate
     * would be exactly the kind of fabrication this module exists to prevent.
     */
    durableBackendBound: boolean | undefined
    /** The shared module's own remedy for the unbound port, never a copy. */
    unboundRemedy: string | null
  }): SyncItemsReport {
    const probe = this.syncItemsProbe
    const report = (state: SyncItemsGateState, cause: SyncItemsGateCause | null, remedy?: string | null) => ({
      state,
      cause,
      remedy: remedy !== undefined ? remedy : cause === null ? null : SYNC_ITEMS_CAUSE_REMEDIES[cause],
      probe,
    })

    /**
     * The two shapes of a refusing durable backend, told apart by the gate's
     * own independent reading rather than by the probe -- `ready()` is a
     * conjunction and its single `false` cannot say which term failed.
     *
     * Keyed on `=== false`, a POSITIVE observation that no port exists. An
     * absent reading (`undefined`, no gate recorded) keeps the bound-port cause
     * rather than asserting the deployment binds nothing; both are `'WITHHELD'`
     * either way, so the fail-safe direction is unaffected by which is chosen.
     */
    const refusedByDurableBackend = (): SyncItemsReport =>
      lane.durableBackendBound === false
        ? report('WITHHELD', 'DURABLE_BACKEND_UNBOUND', lane.unboundRemedy)
        : report('WITHHELD', 'DURABLE_BACKEND_NOT_READY')

    if (!lane.recorded) {
      // No gate to read the lane from. A probe can still settle it NEGATIVELY
      // -- a backend that refuses, or a lane that was never built, offers
      // nothing whatever the gate would have said -- but never positively.
      if (probe === 'NOT_READY') {
        return refusedByDurableBackend()
      }
      if (probe === 'NO_LANE') {
        return report('WITHHELD', 'SYNC_LANE_NOT_BUILT')
      }
      if (probe === 'PROBE_FAILED') {
        return report('NOT_OBSERVED', 'PROBE_FAILED')
      }
      return report('NOT_OBSERVED', 'GATE_NOT_RECORDED')
    }

    // SYNC_ITEMS cannot be offered over a socket that never opens, so the
    // lane's own conditions outrank the backend reading and are named first.
    if (!lane.enabled) {
      return report('WITHHELD', 'LANE_PRECONDITION_UNMET')
    }

    switch (probe) {
      case 'READY':
        return report('ADVERTISED', null)
      case 'NOT_READY':
        // The probe said no. WHICH no it was comes from the gate's separate
        // bound-ness reading, not from the probe -- see
        // `refusedByDurableBackend`. This is the branch an attached gateway
        // reaches on every negative reading, so collapsing it onto the
        // bound-port cause mislabelled every unbound deployment in the fleet.
        return refusedByDurableBackend()
      case 'NO_LANE':
        return report('WITHHELD', 'SYNC_LANE_NOT_BUILT')
      case 'PROBE_FAILED':
        return report('NOT_OBSERVED', 'PROBE_FAILED')
      case 'NEVER_PROBED':
        // The ONE inference allowed without a probe, and only because it can
        // only withhold: `ready()` requires a durable port to exist, so an
        // unbound one cannot be ready. Bound-ness never implies the reverse --
        // that inference is the bug this whole block exists to prevent.
        //
        // Still reachable, and not only by an older host: `observeSyncItems` is
        // called AFTER `attachGateway` returns, so a composition whose attach
        // THREW records the gate and leaves the probe unread (pinned by
        // SyncWebSocketRuntime.spec.ts). It is no longer the only route to
        // `DURABLE_BACKEND_UNBOUND`, though, which is what made that cause
        // effectively dead for every successfully attached gateway.
        return lane.durableBackendBound === false
          ? report('WITHHELD', 'DURABLE_BACKEND_UNBOUND', lane.unboundRemedy)
          : report('NOT_OBSERVED', 'NEVER_PROBED')
    }
  }

  report(): SyncGateDiagnosticsReport {
    const observed = this.observation
    if (!observed) {
      const syncItems = this.resolveSyncItems({
        recorded: false,
        enabled: false,
        // `undefined`, not `false`: nothing was recorded, so bound-ness was
        // never observed. Passing `false` here used to be harmless because
        // every negative probe reported the same cause; now that the two are
        // told apart it would make an unrecorded gate claim this deployment
        // binds no durable port, which it has no evidence of.
        durableBackendBound: undefined,
        unboundRemedy: null,
      })
      return {
        recorded: false,
        gatewayAttached: false,
        syncLaneEnabled: false,
        ...(syncItems.state === 'NOT_OBSERVED' ? {} : { syncItemsAdvertised: syncItems.state === 'ADVERTISED' }),
        syncItems,
        unmetPreconditions: [],
        unmetCodes: [],
        files: { ...NO_FILES },
        host: { ...NO_HOST },
      }
    }

    // The full list is still what the panel renders, so the gRPC condition
    // remains visible and named; only which of them gate WHAT has changed.
    // A host condition closes the lane like a transport one: the host
    // attached nothing, and the list must say why rather than show a lane
    // down over an empty list.
    const hostUnmetCondition = observed.hostUnmetCondition
    const unmetPreconditions: SyncGateUnmetPrecondition[] = [
      ...resolveUnmetSyncPreconditions(observed),
      ...(hostUnmetCondition ? [{ code: hostUnmetCondition, remedy: SYNC_HOST_REMEDIES[hostUnmetCondition] }] : []),
    ]
    const laneEnabled =
      resolveUnmetSyncTransportPreconditions(observed).length === 0 && hostUnmetCondition === undefined
    // The SYNC_ITEMS verdict is NOT derived from this list -- that is the
    // divergence. The list still names the condition for the panel, and its
    // remedy is reused verbatim when the port is unbound so the two cannot
    // drift apart.
    const unmetSyncItems = resolveUnmetSyncItemsPreconditions(observed)
    const syncItems = this.resolveSyncItems({
      recorded: true,
      enabled: laneEnabled,
      durableBackendBound: observed.syncingServerGrpcBound,
      unboundRemedy: unmetSyncItems[0]?.remedy ?? null,
    })

    return {
      recorded: true,
      gatewayAttached: observed.gatewayAttached ?? false,
      syncLaneEnabled: laneEnabled,
      ...(syncItems.state === 'NOT_OBSERVED' ? {} : { syncItemsAdvertised: syncItems.state === 'ADVERTISED' }),
      syncItems,
      unmetPreconditions,
      unmetCodes: unmetPreconditions.map(({ code }) => code),
      files: {
        advertised: observed.filesAdvertised,
        unmetCondition: observed.filesUnmetCondition ?? null,
        remedy: observed.filesUnmetCondition ? FILES_REMEDIES[observed.filesUnmetCondition] : null,
      },
      host: {
        unmetCondition: hostUnmetCondition ?? null,
        remedy: hostUnmetCondition ? SYNC_HOST_REMEDIES[hostUnmetCondition] : null,
      },
    }
  }
}

export const syncGateDiagnostics = new SyncGateDiagnosticsRecorder()
