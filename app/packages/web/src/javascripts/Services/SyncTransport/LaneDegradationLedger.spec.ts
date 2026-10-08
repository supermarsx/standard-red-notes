import {
  LANE_LEDGER_TRANSITION_CAPACITY,
  LANE_LEDGER_UNRECOGNISED_REASON,
  LANE_STATE_CARRIER,
  LaneDegradationLedger,
} from './LaneDegradationLedger'
import { SYNC_FALLBACK_REASON_EXPLANATIONS, type SyncTransportState } from './syncTransportProtocol'

/**
 * Standard Red Notes: the lane-degradation ledger, on its own.
 *
 * The properties here are the ones the pane cannot check for itself, because they
 * are about what the PRODUCER did over time rather than about what a single reading
 * renders as:
 *
 *   - the bound actually bounds, and the elision is a reported number;
 *   - a repeated state is not a transition, but an alternating one is;
 *   - a recovery is recorded as faithfully as a degradation;
 *   - nothing but a closed code, a boolean and a relative age can get in.
 *
 * The clock is injected rather than faked globally: the transport's own suite runs
 * on real timers, and a ledger whose durations are only checkable under
 * `jest.useFakeTimers()` would be untestable from there.
 */

const clock = () => {
  let value = 0
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms
    },
  }
}

describe('LaneDegradationLedger', () => {
  it('records a degradation and the recovery that followed it, oldest first', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })

    time.advance(1_000)
    ledger.recordTransition('HTTP_FALLBACK', 'multi-tab-not-owner', false)
    time.advance(4_000)
    ledger.recordTransition('READY', undefined, false)

    expect(ledger.view().transitions).toEqual([
      { state: 'HTTP_FALLBACK', reason: 'multi-tab-not-owner', socketPreserved: false, msSinceLedgerStart: 1_000 },
      { state: 'READY', socketPreserved: false, msSinceLedgerStart: 5_000 },
    ])
    expect(ledger.view().fallbackCounts).toEqual({ 'multi-tab-not-owner': 1 })
    expect(ledger.view().transitionsDropped).toBe(0)
  })

  /**
   * The one property that distinguishes this ledger from a log. A fallback
   * re-asserts the same state and cause on every sync round and the worker posts
   * DEGRADED from one lane and HTTP_FALLBACK from another for a single unchanged
   * condition, so recording repeats would fill the ring in seconds — and would
   * report a lane that never moved as one that moved two hundred times.
   */
  it('treats a re-asserted state as no transition at all, however many times it arrives', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })

    for (let round = 0; round < 50; round += 1) {
      time.advance(100)
      ledger.recordTransition('HTTP_FALLBACK', 'server-kill', false)
    }

    expect(ledger.view().transitions).toHaveLength(1)
    expect(ledger.view().fallbackCounts).toEqual({ 'server-kill': 1 })
  })

  it('records an alternating lane entry by entry, because that IS a flap', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })

    for (let round = 0; round < 3; round += 1) {
      time.advance(1_000)
      ledger.recordTransition('HTTP_FALLBACK', 'ack-timeout', false)
      time.advance(1_000)
      ledger.recordTransition('READY', undefined, false)
    }

    expect(ledger.view().transitions.map((transition) => transition.state)).toEqual([
      'HTTP_FALLBACK',
      'READY',
      'HTTP_FALLBACK',
      'READY',
      'HTTP_FALLBACK',
      'READY',
    ])
    expect(ledger.view().fallbackCounts).toEqual({ 'ack-timeout': 3 })
  })

  it('separates a transition that kept the socket from one that tore it down', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })

    ledger.recordTransition('HTTP_FALLBACK', 'operation-unavailable', true)
    ledger.recordTransition('HTTP_FALLBACK', 'operation-unavailable', false)

    expect(ledger.view().transitions.map((transition) => transition.socketPreserved)).toEqual([true, false])
  })

  /* ------------------------------------------------------------------------ */
  /* The bound                                                                */
  /* ------------------------------------------------------------------------ */

  it('stops growing at the capacity and reports every entry it elided', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })
    const overflow = LANE_LEDGER_TRANSITION_CAPACITY * 5

    for (let round = 0; round < overflow; round += 1) {
      time.advance(10)
      ledger.recordTransition(
        round % 2 === 0 ? 'HTTP_FALLBACK' : 'READY',
        round % 2 === 0 ? 'proxy-failed' : undefined,
        false,
      )
    }

    const view = ledger.view()

    expect(view.transitions).toHaveLength(LANE_LEDGER_TRANSITION_CAPACITY)
    expect(view.transitionsDropped).toBe(overflow - LANE_LEDGER_TRANSITION_CAPACITY)
    // The elision is visible as a NUMBER, not merely as a shorter array: the two
    // together are what let a reader add them back up to what really happened.
    expect(view.transitions.length + view.transitionsDropped).toBe(overflow)
  })

  it('drops the OLDEST and keeps the newest, so the ring answers "what just happened"', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })

    for (let round = 0; round < LANE_LEDGER_TRANSITION_CAPACITY + 3; round += 1) {
      time.advance(1_000)
      ledger.recordTransition(
        round % 2 === 0 ? 'HTTP_FALLBACK' : 'READY',
        round % 2 === 0 ? 'backpressure' : undefined,
        false,
      )
    }

    const ages = ledger.view().transitions.map((transition) => transition.msSinceLedgerStart)

    expect(ages[0]).toBe(4_000)
    expect(ages[ages.length - 1]).toBe((LANE_LEDGER_TRANSITION_CAPACITY + 3) * 1_000)
    expect([...ages].sort((left, right) => left - right)).toEqual(ages)
  })

  /**
   * The counters are the half that must NOT elide, and this is the case that proves
   * the split is real rather than asserted in a comment: the ring has forgotten the
   * first eight degradations and the per-cause counter still knows they happened.
   */
  it('keeps counting causes after their transitions have fallen off the ring', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })

    for (let round = 0; round < 40; round += 1) {
      time.advance(10)
      ledger.recordTransition('HTTP_FALLBACK', 'auth-failed', false)
      time.advance(10)
      ledger.recordTransition('READY', undefined, false)
    }

    expect(ledger.view().transitions).toHaveLength(LANE_LEDGER_TRANSITION_CAPACITY)
    expect(ledger.view().fallbackCounts).toEqual({ 'auth-failed': 40 })
  })

  /* ------------------------------------------------------------------------ */
  /* The closed reason set                                                    */
  /* ------------------------------------------------------------------------ */

  it('accepts every reason the protocol declares, and no list of its own', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })
    const reasons = Object.keys(SYNC_FALLBACK_REASON_EXPLANATIONS)

    for (const reason of reasons) {
      ledger.recordTransition('HTTP_FALLBACK', reason, false)
    }

    expect(Object.keys(ledger.view().fallbackCounts).sort()).toEqual([...reasons].sort())
    expect(reasons).toHaveLength(22)
  })

  it('collapses a reason this build cannot name, rather than carrying its text', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })
    const forged = 'https://sync.internal.example:8443/?token=hunter2'

    ledger.recordTransition('HTTP_FALLBACK', forged, false)
    ledger.recordTransition('READY', undefined, false)
    ledger.recordTransition('HTTP_FALLBACK', 'a-reason-from-a-newer-build', false)

    const serialised = JSON.stringify(ledger.view())

    expect(serialised).not.toContain('sync.internal.example')
    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain('a-reason-from-a-newer-build')
    // Not vacuous: both forged reasons WERE recorded, folded onto the one bucket.
    expect(ledger.view().fallbackCounts).toEqual({ [LANE_LEDGER_UNRECOGNISED_REASON]: 2 })
    expect(ledger.view().transitions.filter((transition) => transition.reason === 'other')).toHaveLength(2)
  })

  /* ------------------------------------------------------------------------ */
  /* What counts as a degradation                                             */
  /* ------------------------------------------------------------------------ */

  it('counts a cause only where the transition actually moved saves onto HTTP', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })

    ledger.recordTransition('HALF_OPEN', 'reconnect-gap', false)
    ledger.recordTransition('CONNECTING', 'reconnect-gap', false)
    ledger.recordTransition('READY', undefined, false)
    ledger.recordTransition('DEGRADED', 'reconnect-gap', false)

    // The two dials carry the same cause and are NOT degradations; only the
    // DEGRADED transition is. Counting a dial would double every flap.
    expect(ledger.view().fallbackCounts).toEqual({ 'reconnect-gap': 1 })
    expect(ledger.view().transitions).toHaveLength(4)
  })

  it('classifies every transport state the protocol declares', () => {
    const states: readonly SyncTransportState[] = [
      'HTTP_ONLY',
      'CONNECTING',
      'AUTHENTICATING',
      'READY',
      'DEGRADED',
      'HTTP_FALLBACK',
      'HALF_OPEN',
    ]

    for (const state of states) {
      expect(['http', 'socket', 'dialling']).toContain(LANE_STATE_CARRIER[state])
    }
    expect(Object.keys(LANE_STATE_CARRIER).sort()).toEqual([...states].sort())
  })

  /* ------------------------------------------------------------------------ */
  /* The baseline                                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * A transport is constructed HTTP_ONLY. Re-asserting that state for a cause it
   * cannot name is not something anybody watched happen, and recording it would open
   * every ledger with a transition the operator did not experience.
   */
  it('does not record the state the transport was already in', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0, baselineState: 'HTTP_ONLY' })

    ledger.recordTransition('HTTP_ONLY', undefined, false)

    expect(ledger.view().transitions).toEqual([])

    ledger.recordTransition('HTTP_ONLY', 'capability-unavailable', false)

    expect(ledger.view().transitions).toHaveLength(1)
  })

  /* ------------------------------------------------------------------------ */
  /* Control-plane refusals                                                   */
  /* ------------------------------------------------------------------------ */

  it('counts only the two statuses the control-plane lane actually degrades on', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })

    ledger.recordControlPlaneRejection(401)
    ledger.recordControlPlaneRejection(498)
    ledger.recordControlPlaneRejection(498)
    for (const ignored of [200, 403, 404, 500, 503, 0, -1, Number.NaN]) {
      ledger.recordControlPlaneRejection(ignored)
    }

    expect(ledger.view().controlPlaneRejections).toBe(3)
    expect(ledger.view().controlPlaneRejectionsByStatus).toEqual({ 401: 1, 498: 2 })
  })

  /**
   * The invariant the pane's "Refusals on a status this build cannot name" row is
   * derived from. If the total ever exceeded the named buckets, that row would have
   * something to report — and it would be this producer that was wrong.
   */
  it('keeps the total equal to the sum of its named buckets', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })

    for (let round = 0; round < 9; round += 1) {
      ledger.recordControlPlaneRejection(round % 3 === 0 ? 401 : 498)
      ledger.recordControlPlaneRejection(418)
    }

    const view = ledger.view()
    const named = (view.controlPlaneRejectionsByStatus[401] ?? 0) + (view.controlPlaneRejectionsByStatus[498] ?? 0)

    expect(named).toBe(view.controlPlaneRejections)
    expect(view.controlPlaneRejections).toBe(9)
  })

  /* ------------------------------------------------------------------------ */
  /* Recording time, and the reload decision                                  */
  /* ------------------------------------------------------------------------ */

  it('publishes how long it has been recording, so an empty ledger is not a quiet one', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })

    expect(ledger.view().recordingForMs).toBe(0)
    expect(ledger.view().transitions).toEqual([])

    time.advance(90_000)

    expect(ledger.view().recordingForMs).toBe(90_000)
    expect(ledger.view().transitions).toEqual([])
  })

  /**
   * *** THE RELOAD DECISION, AS AN ASSERTION. ***
   *
   * It does not persist, and that is a choice rather than an omission — so it is
   * pinned here: a new ledger starts empty, and nothing in the module reaches for
   * storage. A later change that "helpfully" restored the ring across a reload would
   * be re-reporting refusals that the reload itself had already cleared, because a
   * reconnect re-mints the ticket. That failure mode is worse than reporting nothing.
   */
  it('starts empty, and touches no storage of any kind', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })
    ledger.recordTransition('HTTP_FALLBACK', 'server-kill', false)
    ledger.recordControlPlaneRejection(401)

    expect(ledger.view().transitions).toHaveLength(1)

    const reloaded = new LaneDegradationLedger({ now: () => 0 })

    expect(reloaded.view()).toEqual({
      controlPlaneRejections: 0,
      controlPlaneRejectionsByStatus: {},
      fallbackCounts: {},
      transitions: [],
      transitionsDropped: 0,
      recordingForMs: 0,
    })
  })

  it('hands out a copy, so a reader cannot push an entry back into the ring', () => {
    const ledger = new LaneDegradationLedger({ now: () => 0 })
    ledger.recordTransition('DEGRADED', 'server-kill', false)

    const view = ledger.view()
    ;(view.transitions as unknown as unknown[]).push({ forged: true })

    expect(ledger.view().transitions).toHaveLength(1)
  })

  /* ------------------------------------------------------------------------ */
  /* The secrecy floor                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * Every field of every entry, enumerated. A ledger that acquired a `url`, an
   * `endpoint` or a `sessionScope` would still pass a scan that only looked for a
   * planted value, because the leak would be of a field nobody planted into.
   */
  it('publishes nothing but closed codes, booleans, counts and relative ages', () => {
    const time = clock()
    const ledger = new LaneDegradationLedger({ now: time.now })
    time.advance(3_000)
    ledger.recordTransition('HTTP_FALLBACK', 'auth-failed', true)
    ledger.recordControlPlaneRejection(401)

    const view = ledger.view()

    expect(Object.keys(view).sort()).toEqual(
      [
        'controlPlaneRejections',
        'controlPlaneRejectionsByStatus',
        'fallbackCounts',
        'recordingForMs',
        'transitions',
        'transitionsDropped',
      ].sort(),
    )
    for (const transition of view.transitions) {
      expect(Object.keys(transition).sort()).toEqual(['msSinceLedgerStart', 'reason', 'socketPreserved', 'state'])
      expect(typeof transition.msSinceLedgerStart).toBe('number')
      expect(Object.hasOwn(SYNC_FALLBACK_REASON_EXPLANATIONS, transition.reason ?? 'auth-failed')).toBe(true)
    }
    // A relative age, never an instant: 3s after a ledger that started at 0, not a
    // number anywhere near a wall clock.
    expect(view.transitions[0]?.msSinceLedgerStart).toBe(3_000)
    expect(JSON.stringify(view)).not.toMatch(/1[6-9]\d{11}/u)
  })
})
