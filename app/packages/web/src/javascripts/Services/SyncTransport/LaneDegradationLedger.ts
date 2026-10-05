import {
  SYNC_FALLBACK_REASON_EXPLANATIONS,
  type SyncFallbackReason,
  type SyncTransportState,
} from './syncTransportProtocol'

/**
 * Standard Red Notes: the client-side lane-degradation ledger.
 *
 * *** WHY THIS CANNOT BE A SERVER FIELD. ***
 *
 * The admin Diagnostics pane can already say which lane this client is on RIGHT
 * NOW, and the gateway can say what it is holding right now. Neither can say what
 * happened over the last twenty minutes of THIS browser's session — a socket that
 * fell back, recovered, fell back again and is now healthy reads identically to one
 * that never moved. The sequence is known only to the tab that lived it, so this is
 * the one diagnostic in that pane with no possible server half.
 *
 * -------------------------------------------------------------------------------
 * WHAT IT MAY HOLD
 * -------------------------------------------------------------------------------
 *
 * A closed state, a closed reason, a boolean and a RELATIVE AGE. Nothing else may
 * enter — no endpoint, no ticket, no session scope, no wall-clock instant. The
 * report this feeds is written to be pasted in public, and the point of recording a
 * CREDENTIAL failure is defeated if the record itself carries one.
 *
 * `msSinceLedgerStart` is an offset rather than a timestamp for the same reason
 * `safeDuration` exists in the pane: an offset gives the ordering and the flap
 * frequency the block is for, while an absolute instant additionally lets a reader
 * of the pasted report line this deployment up against other logs and buys nothing.
 *
 * -------------------------------------------------------------------------------
 * WHAT IT DOES NOT DO: SURVIVE A RELOAD
 * -------------------------------------------------------------------------------
 *
 * In memory, for the life of the page, on purpose — and the decision is stated
 * because an unstated one cannot be checked:
 *
 *   1. Every age in here is measured from `startedAt`. Persisting the ring would
 *      put two sessions' offsets under one origin with no way to tell them apart,
 *      so "2m 5s after the ledger started" would stop meaning anything.
 *   2. A reload is the *remedy* for the condition this ledger exists to catch — the
 *      401 row says so in terms: a reconnect re-mints the ticket and clears the
 *      stranded lane. A ledger that outlived the reload would keep reporting
 *      refusals the reload had already fixed, which is the one failure mode worse
 *      than reporting nothing.
 *   3. It would write a durable record of one person's session behaviour to disk to
 *      answer a question about the last few minutes.
 *
 * The cost of that choice is real and is paid for explicitly: a freshly reloaded tab
 * has an EMPTY ledger, which must not read as "a quiet session". `recordingForMs`
 * is published for exactly that, and the pane renders it as its own row.
 */

/**
 * How many ordered transitions are kept.
 *
 * A session-long array is a leak, so there has to be a number here. Twelve is six
 * degrade/recover pairs: comfortably more than ordinary reconnection produces over
 * a working day, and small enough that the whole ring fits in a pasted report.
 *
 * *** THE RING IS THE ONLY THING THAT ELIDES. *** The counters below are keyed by a
 * CLOSED set — nineteen reasons, two statuses — so they are bounded by construction
 * and never drop anything. What overflowing the ring costs is therefore the ORDER of
 * the oldest transitions, never the fact that they happened; `transitionsDropped`
 * carries how many lost their place, so the elision is a reported number rather than
 * a silent truncation.
 */
export const LANE_LEDGER_TRANSITION_CAPACITY = 12

/**
 * The bucket every reason this build does not recognise collapses into.
 *
 * NOT a member of `SyncFallbackReason`, deliberately: it must be impossible to
 * confuse with one the transport can actually emit. A newer build's reason must not
 * be able to push free-form text through a ledger into an older renderer, and the
 * renderer collapses unknown keys a second time on its own — this is the producer
 * half of that, so the guarantee does not rest on one expression in one file.
 */
export const LANE_LEDGER_UNRECOGNISED_REASON = 'other'

export type LaneLedgerReason = SyncFallbackReason | typeof LANE_LEDGER_UNRECOGNISED_REASON

/** The two statuses the control-plane lane refuses a read with. Mirrors the pane's. */
export const LANE_LEDGER_REJECTION_STATUSES = [401, 498] as const

export type LaneLedgerRejectionStatus = (typeof LANE_LEDGER_REJECTION_STATUSES)[number]

/**
 * Which lane a transport state actually carries traffic on.
 *
 * Three answers, not two, and the third is the one that matters: CONNECTING,
 * AUTHENTICATING and HALF_OPEN are steps on the way to READY. Counting them as
 * degradations would report every ordinary reconnect as a fault, and counting them
 * as recoveries would report a dial that never completed as one.
 */
export const LANE_STATE_CARRIER: Record<SyncTransportState, 'http' | 'socket' | 'dialling'> = {
  HTTP_ONLY: 'http',
  CONNECTING: 'dialling',
  AUTHENTICATING: 'dialling',
  READY: 'socket',
  DEGRADED: 'http',
  HTTP_FALLBACK: 'http',
  HALF_OPEN: 'dialling',
}

export type LaneLedgerTransition = {
  readonly state: SyncTransportState
  readonly reason?: LaneLedgerReason
  /** Whether the socket itself survived the transition, or was torn down. */
  readonly socketPreserved: boolean
  /** A DURATION from the start of this ledger. Never a wall-clock instant. */
  readonly msSinceLedgerStart: number
}

/**
 * What the ledger publishes.
 *
 * Structurally a superset of the pane's `LaneDegradationLedgerView`, which is
 * declared in `diagnosticsSections.ts` and deliberately not imported here: a service
 * must not depend on a preferences pane. The two are kept in agreement by
 * `websocketSection.spec.ts`, which feeds a REAL ledger into the real section
 * builder — if the shapes ever drift, that file stops compiling.
 */
export type LaneLedgerReading = {
  readonly controlPlaneRejections: number
  readonly controlPlaneRejectionsByStatus: Readonly<Partial<Record<LaneLedgerRejectionStatus, number>>>
  readonly fallbackCounts: Readonly<Partial<Record<LaneLedgerReason, number>>>
  /** Oldest first, at most `LANE_LEDGER_TRANSITION_CAPACITY` of them. */
  readonly transitions: readonly LaneLedgerTransition[]
  /** How many transitions fell off the end of the bounded ring. */
  readonly transitionsDropped: number
  /** How long this ledger has been recording. An empty ledger is not a quiet one. */
  readonly recordingForMs: number
}

/**
 * Is this a reason the current build can name?
 *
 * Asked against `SYNC_FALLBACK_REASON_EXPLANATIONS` rather than a tuple written out
 * again here, because that Record is `Record<SyncFallbackReason, string>` and is
 * therefore kept exhaustive by the compiler. A second hand-maintained list of the
 * same eighteen members is a list that goes stale.
 */
function isKnownReason(reason: string): reason is SyncFallbackReason {
  return Object.hasOwn(SYNC_FALLBACK_REASON_EXPLANATIONS, reason)
}

export class LaneDegradationLedger {
  private readonly now: () => number
  private readonly startedAt: number
  private readonly ring: LaneLedgerTransition[] = []
  private readonly fallbacks = new Map<LaneLedgerReason, number>()
  private readonly rejections = new Map<LaneLedgerRejectionStatus, number>()
  private dropped = 0
  private rejectionTotal = 0

  /**
   * `lastSignature` starts at the transport's own initial state rather than at
   * `undefined`.
   *
   * A transport is constructed HTTP_ONLY and only leaves it when something happens.
   * Without the baseline, the first main-thread code path that re-asserts HTTP_ONLY
   * for a cause it cannot name — a torn-down session, a deinit — would be recorded
   * as transition #1, and the ledger's most valuable row ("did it ever recover?")
   * would open with a transition nobody watched.
   */
  private lastSignature: string

  constructor(options: { now?: () => number; baselineState?: SyncTransportState } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.startedAt = this.now()
    this.lastSignature = signatureOf(options.baselineState ?? 'HTTP_ONLY', undefined, false)
  }

  /**
   * Record a transport transition — a degradation, a recovery or a dial.
   *
   * *** DEDUPLICATED BY SIGNATURE, NOT BY STATE. *** A fallback re-asserts the same
   * state and the same cause on every sync round; the worker posts DEGRADED from one
   * lane and HTTP_FALLBACK from another for a single unchanged condition. Recording
   * each repeat would fill a twelve-entry ring in seconds and report a stable lane as
   * one that flaps. Keyed on the whole triple, an alternating READY/HTTP_FALLBACK
   * sequence is still recorded entry by entry, which IS a flap and must be visible.
   */
  recordTransition(state: SyncTransportState, reason: string | undefined, socketPreserved: boolean): void {
    const closedReason = reason === undefined ? undefined : this.closeReason(reason)
    const signature = signatureOf(state, closedReason, socketPreserved)
    if (signature === this.lastSignature) {
      return
    }
    this.lastSignature = signature

    this.ring.push({
      state,
      ...(closedReason === undefined ? {} : { reason: closedReason }),
      socketPreserved,
      msSinceLedgerStart: Math.max(0, this.now() - this.startedAt),
    })
    if (this.ring.length > LANE_LEDGER_TRANSITION_CAPACITY) {
      this.ring.shift()
      this.dropped += 1
    }

    // Counted only where the transition actually moved saves onto HTTP. A reason
    // riding a dial (HALF_OPEN after a reconnect) describes why the last attempt
    // ended, not a degradation of its own, and counting it would double every flap.
    if (closedReason !== undefined && LANE_STATE_CARRIER[state] === 'http') {
      this.fallbacks.set(closedReason, (this.fallbacks.get(closedReason) ?? 0) + 1)
    }
  }

  /**
   * Record a control-plane read the socket lane refused and that HTTP then served.
   *
   * Only 401 and 498 are counted, and that is not a filter on noise — it is the only
   * pair `WebApplication.controlPlaneRpc` degrades on. Any other status is returned
   * to the caller as the answer, so it is not a silent degradation and this ledger
   * has nothing to say about it. Keeping the total equal to the sum of the two named
   * buckets is what lets the pane report an unnameable remainder instead of a
   * flattering denominator.
   */
  recordControlPlaneRejection(status: number): void {
    if (status !== 401 && status !== 498) {
      return
    }
    this.rejectionTotal += 1
    this.rejections.set(status, (this.rejections.get(status) ?? 0) + 1)
  }

  view(): LaneLedgerReading {
    const controlPlaneRejectionsByStatus: Partial<Record<LaneLedgerRejectionStatus, number>> = {}
    for (const [status, count] of this.rejections) {
      controlPlaneRejectionsByStatus[status] = count
    }

    const fallbackCounts: Partial<Record<LaneLedgerReason, number>> = {}
    for (const [reason, count] of this.fallbacks) {
      fallbackCounts[reason] = count
    }

    return {
      controlPlaneRejections: this.rejectionTotal,
      controlPlaneRejectionsByStatus,
      fallbackCounts,
      transitions: [...this.ring],
      transitionsDropped: this.dropped,
      recordingForMs: Math.max(0, this.now() - this.startedAt),
    }
  }

  private closeReason(reason: string): LaneLedgerReason {
    return isKnownReason(reason) ? reason : LANE_LEDGER_UNRECOGNISED_REASON
  }
}

function signatureOf(
  state: SyncTransportState,
  reason: LaneLedgerReason | undefined,
  socketPreserved: boolean,
): string {
  return `${state}|${reason ?? ''}|${socketPreserved ? 'kept' : 'gone'}`
}
