import type { GrpcFailureClass, GrpcFallbackLane } from './GrpcTransportFallback'

/**
 * Standard Red Notes: the RUNTIME record of a gateway that bound gRPC and is
 * serving over HTTP anyway.
 *
 * WHY THIS IS SEPARATE FROM THE EXISTING RECORDERS
 *
 * `DeploymentDiagnostics` records `boundServiceProxy` ONCE, at container
 * configuration time, and `SyncGateDiagnostics` records the boot gate. Neither
 * can express this, because a gRPC listener that fails AFTER boot changes
 * nothing either of them observed: `boundServiceProxy` still reads `'grpc'`
 * forever. Read together, the three now separate three states that used to be
 * two:
 *
 *   boundServiceProxy 'http' + degradedCalls 0   -> plain HTTP deployment
 *   boundServiceProxy 'grpc' + degradedCalls 0   -> gRPC, healthy
 *   boundServiceProxy 'grpc' + degradedCalls > 0 -> gRPC BOUND, HTTP SERVING
 *
 * The third line is the one that did not exist before, and it is the reason the
 * per-call fallback in `GRPCServiceProxy` is an improvement rather than a way
 * to hide a broken deployment forever.
 *
 * `refusedCalls` is deliberately reported beside it. A fallback that is
 * correctly REFUSED (an un-deduplicated item write on an ambiguous failure, see
 * `GrpcTransportFallback`) still fails the user's request, and an operator
 * reading only a degradation count would conclude the gateway had absorbed the
 * outage. Both numbers, or neither.
 *
 * *** SECURITY BOUNDARY — same contract as SyncGateDiagnostics ***
 * Everything this module can emit is a boolean, a count, a duration, or a
 * member of a closed literal union. `record()` takes a `GrpcFallbackLane` and a
 * `GrpcFailureClass`, both closed unions, so there is no parameter a URL, host,
 * env value or secret could travel through even by mistake. There is no
 * free-form string field; do not add one — add a literal-union field instead.
 * `AdminController.spec.ts` pins this with a scan of the serialized response
 * against planted secret values.
 *
 * This file imports nothing at runtime (the two types above are `import type`),
 * so surfacing the report from a controller adds no dependency to that
 * controller's module graph.
 */

export type GrpcFallbackLaneReport = {
  /**
   * Calls whose gRPC attempt failed in a replay-safe way and were served over
   * the HTTP transport instead. "Served" means the HTTP attempt was made and
   * owns the response; whether HTTP then answered 2xx or 5xx is the HTTP
   * transport's own business and is reported by its own logging.
   */
  degradedCalls: number
  /**
   * Calls whose gRPC attempt failed and which were NOT retried over HTTP,
   * because the failure class or the call's own replay safety made a second
   * delivery unsafe. These requests failed. That is the intended outcome, and
   * it must stay visible.
   */
  refusedCalls: number
  /** The class of the most recent failure on this lane, degraded or refused. */
  lastFailureClass: GrpcFailureClass | null
  /**
   * How long ago, in milliseconds, the most recent failure on this lane was
   * recorded. Null when there has been none. A duration, not a timestamp, so
   * the payload carries no clock the reader could correlate against.
   */
  lastFailureAgeMs: number | null
}

export type GrpcTransportFallbackReport = {
  /**
   * False when nothing has ever been recorded. On a deployment that bound the
   * gRPC proxy this is the healthy reading; on one that bound HTTP or
   * direct-call it is simply the only possible reading, which is why it must be
   * read together with `deployment.boundServiceProxy` and never on its own.
   */
  observed: boolean
  /** True as soon as any lane has served a call over HTTP instead of gRPC. */
  everDegraded: boolean
  lanes: Record<GrpcFallbackLane, GrpcFallbackLaneReport>
}

const LANES: readonly GrpcFallbackLane[] = ['session-validation', 'items-sync']

type LaneState = {
  degradedCalls: number
  refusedCalls: number
  lastFailureClass: GrpcFailureClass | null
  lastFailureAtMs: number | null
}

const emptyLane = (): LaneState => ({
  degradedCalls: 0,
  refusedCalls: 0,
  lastFailureClass: null,
  lastFailureAtMs: null,
})

/**
 * Process-global like `syncGateDiagnostics` and `deploymentDiagnostics`: the
 * proxy that writes to it is constructed by the container, the controller that
 * reads it is registered before that, and neither can hold a reference to the
 * other.
 */
export class GrpcTransportFallbackRecorder {
  private lanes = new Map<GrpcFallbackLane, LaneState>()

  constructor(private now: () => number = () => Date.now()) {}

  /** A gRPC failure that WAS replaced by an HTTP attempt. */
  recordDegradation(lane: GrpcFallbackLane, failure: GrpcFailureClass): void {
    const state = this.laneState(lane)
    state.degradedCalls += 1
    state.lastFailureClass = failure
    state.lastFailureAtMs = this.now()
  }

  /** A gRPC failure that was SURFACED because a second delivery was unsafe. */
  recordRefusal(lane: GrpcFallbackLane, failure: GrpcFailureClass): void {
    const state = this.laneState(lane)
    state.refusedCalls += 1
    state.lastFailureClass = failure
    state.lastFailureAtMs = this.now()
  }

  /** How many calls this lane has already degraded, for the log line's context. */
  degradedCallsOn(lane: GrpcFallbackLane): number {
    return this.lanes.get(lane)?.degradedCalls ?? 0
  }

  clear(): void {
    this.lanes = new Map()
  }

  report(): GrpcTransportFallbackReport {
    const now = this.now()
    const lanes = {} as Record<GrpcFallbackLane, GrpcFallbackLaneReport>
    let observed = false
    let everDegraded = false

    for (const lane of LANES) {
      const state = this.lanes.get(lane) ?? emptyLane()
      observed = observed || state.degradedCalls > 0 || state.refusedCalls > 0
      everDegraded = everDegraded || state.degradedCalls > 0
      lanes[lane] = {
        degradedCalls: state.degradedCalls,
        refusedCalls: state.refusedCalls,
        lastFailureClass: state.lastFailureClass,
        lastFailureAgeMs: state.lastFailureAtMs === null ? null : Math.max(0, now - state.lastFailureAtMs),
      }
    }

    return { observed, everDegraded, lanes }
  }

  private laneState(lane: GrpcFallbackLane): LaneState {
    const existing = this.lanes.get(lane)
    if (existing) {
      return existing
    }

    const created = emptyLane()
    this.lanes.set(lane, created)

    return created
  }
}

export const grpcTransportFallbackDiagnostics = new GrpcTransportFallbackRecorder()
