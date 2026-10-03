import { SYNC_FALLBACK_REASON_EXPLANATIONS } from '@/Services/SyncTransport/syncTransportProtocol'
import { EFFORT_LABEL } from './diagnosticRemedies'
import {
  UNRECOGNISED,
  VERDICTS,
  type DiagnosticFinding,
  type DiagnosticRow,
  type LaneDegradationLedgerView,
  type SectionModel,
} from './diagnosticsSections'
import { NOT_REPORTED } from './reportAllowlist'
import {
  CLIENT_KNOWN_OPERATIONS,
  describeRealtimeHealth,
  type SyncDiagnosticsPayload,
  type TransportStatusInput,
} from './syncDiagnostics'
import {
  buildWebsocketSection,
  CAPABILITY_STATUSES,
  LANE_GATING_PRECONDITIONS,
  PRECONDITION_CODES,
  SOCKET_FALLBACK_REASONS,
  SOCKET_OPERATIONS,
  SOCKET_TRANSPORT_STATES,
  SYNC_ITEMS_PROBES,
  type SocketGatewayCountersView,
  type WebsocketSectionInput,
} from './websocketSection'

/**
 * Standard Red Notes: the WebSocket section's own tests.
 *
 * *** WHAT THIS FILE IS ACTUALLY GUARDING ***
 *
 * This is the section tonight's headline bug lived in, and three of the
 * properties below are that bug stated as assertions:
 *
 *  1. A `NOT_OBSERVED` SYNC_ITEMS verdict can never read as advertised. The
 *     payloads here plant `syncItemsAdvertised: true` ALONGSIDE a `NOT_OBSERVED`
 *     verdict and alongside no verdict at all, because that boolean was derived
 *     from whether a proxy OBJECT had been constructed rather than from the
 *     predicate the handshake asks — so a build that fell back to it would pass a
 *     test that only checked the happy payload.
 *  2. An EMPTY unmet-condition list is not evidence of health. The
 *     `DURABLE_BACKEND_NOT_READY` payload has `unmetPreconditions: []` and
 *     `unmetCodes: []`, which is the real shape of the live defect, and the row
 *     over it is asserted to be CAPPED — `claimed: 'healthy'`, `verdict:
 *     'undetermined'`, with a caveat — rather than green.
 *  3. Absent is not false, and absent is never zero. The model is built with no
 *     input at all and every row is checked individually, not as a set: an
 *     assertion over a set is satisfied by any member of it. The sharpest case is
 *     `pushesDispatched`: the helper this section reuses printed
 *     `String(x ?? 0)` and this section deliberately did not, which is how that
 *     defect was found. t108 fixed the helper, so the assertion below now pins
 *     the agreement instead of the divergence — this section keeps its own
 *     reading, and neither side may drift back to a fabricated zero.
 *
 * And one that is not about the bug: no server-supplied string may reach a report
 * line. The planted-value scan serialises every `reportLines` entry, with both
 * address-shaped and OPAQUE secrets, because the redactor is explicitly a
 * denylist and an opaque secret is exactly what it cannot catch — so the
 * guarantee has to come from the `SafeValue` constructors, not from the regex.
 *
 * `rowOf` and `blockOf` THROW on a missing label, so renaming a row turns its
 * assertions red instead of silently vacuous.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const transport = (overrides: Partial<TransportStatusInput> = {}): TransportStatusInput => ({
  state: 'READY',
  operations: [...SOCKET_OPERATIONS],
  ...overrides,
})

type GateView = NonNullable<SyncDiagnosticsPayload['gate']>

type RealtimeView = NonNullable<NonNullable<SyncDiagnosticsPayload['live']>['realtime']>

const gate = (overrides: Partial<GateView> = {}): GateView => ({
  recorded: true,
  gatewayAttached: true,
  syncLaneEnabled: true,
  syncItems: { state: 'ADVERTISED', cause: null, remedy: null, probe: 'READY' },
  unmetPreconditions: [],
  unmetCodes: [],
  ...overrides,
})

const payload = (overrides: Partial<SyncDiagnosticsPayload> = {}): SyncDiagnosticsPayload => ({
  gate: gate(),
  live: {
    capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }],
    unavailabilityReasons: [],
    ticketAvailable: true,
  },
  protocol: { version: 1, serverOperations: [...SOCKET_OPERATIONS] },
  ...overrides,
})

const ledger = (overrides: Partial<LaneDegradationLedgerView> = {}): LaneDegradationLedgerView => ({
  controlPlaneRejections: 0,
  controlPlaneRejectionsByStatus: {},
  fallbackCounts: {},
  transitions: [],
  transitionsDropped: 0,
  ...overrides,
})

const counters = (overrides: SocketGatewayCountersView = {}): SocketGatewayCountersView => ({ ...overrides })

/* -------------------------------------------------------------------------- */
/* Sentinels, in the two shapes that discriminate                             */
/* -------------------------------------------------------------------------- */

/**
 * An OPAQUE value: no scheme, no dot, no colon, so nothing in
 * `sanitizeServerCopy` can match any part of it. This is the class the redactor
 * says itself it cannot catch, and the class a live probe measured printing
 * intact out of every field this file now plants it in.
 *
 * Built from markers rather than from plausible prose on purpose: a fragment of
 * real English collides with the build's own copy and fires on innocent text.
 */
const PLANTED_OPAQUE = 'zqx7v2-kkmr9pt4-jjdw3bn8-xxhf6cs1-vvqz5gy0-ttnb8dk2'

/**
 * The same marker alphabet in upper snake case — the shape of a legitimate
 * condition code, a refusal reason or a variable name. It is the class a SHAPE
 * floor ADMITS: it is what got past `safeEnvName` and printed on screen. A sweep
 * built only from address-shaped values cannot see this one.
 */
const PLANTED_SHAPED = 'ZQX7V2_KKMR9PT4_JJDW3BN8_XXHF6CS1_VVQZ5GY0'

/**
 * Head, middle and tail of a planted value, 20 characters each.
 *
 * Asserting on the whole string is what makes a sweep pass vacuously against a
 * TRUNCATED leak — the bytes that got out are then a substring nobody asserted
 * on. The middle and tail windows of these sentinels sit past 30 and 45
 * characters respectively, so a cut at any of the usual widths still fails.
 */
const windowsOf = (value: string): readonly string[] => {
  const middle = Math.max(0, Math.floor((value.length - 20) / 2))
  return [value.slice(0, 20), value.slice(middle, middle + 20), value.slice(-20)]
}

const PLANTED_WINDOWS = windowsOf(PLANTED_OPAQUE)

/* -------------------------------------------------------------------------- */
/* Lookups that fail loudly                                                   */
/* -------------------------------------------------------------------------- */

const allRows = (model: SectionModel): readonly DiagnosticRow[] => model.blocks.flatMap((block) => block.rows)

const allFindings = (model: SectionModel): readonly DiagnosticFinding[] =>
  model.blocks.flatMap((block) => block.findings)

const rowOf = (model: SectionModel, label: string): DiagnosticRow => {
  const found = allRows(model).find((row) => row.label === label)
  if (found === undefined) {
    throw new Error(
      `no row labelled "${label}" — the model has: ${allRows(model)
        .map((row) => row.label)
        .join(' | ')}`,
    )
  }

  return found
}

const blockOf = (model: SectionModel, heading: string) => {
  const found = model.blocks.find((block) => String(block.heading) === heading)
  if (found === undefined) {
    throw new Error(`no block headed "${heading}" — the model has: ${model.blocks.map((b) => b.heading).join(' | ')}`)
  }

  return found
}

/**
 * The capability row for one operation, matched on the `OPERATION —` prefix.
 *
 * A bare `startsWith(operation)` also matches "SYNC_ITEMS on the socket" in the
 * verdict block, which is a different row with a different subject — and a lookup
 * that silently returns the wrong row is how an assertion comes to pass against
 * something it was never about.
 */
const operationRow = (model: SectionModel, operation: string): DiagnosticRow => {
  const found = allRows(model).find((row) => String(row.label).startsWith(`${operation} —`))
  if (found === undefined) {
    throw new Error(`no capability row for "${operation}"`)
  }

  return found
}

const findingOf = (model: SectionModel, code: string): DiagnosticFinding | undefined =>
  allFindings(model).find((finding) => finding.code === code)

const codesOf = (model: SectionModel): string[] => allFindings(model).map((finding) => String(finding.code))

const build = (input: WebsocketSectionInput = {}): SectionModel => buildWebsocketSection(input)

const SYNC_ITEMS_ROW = 'SYNC_ITEMS on the socket'
const UNMET_ROW = 'Unmet boot conditions'
const UNNAMEABLE_ROW = 'Unmet conditions this build cannot name'

/* -------------------------------------------------------------------------- */
/* Absent is not false                                                        */
/* -------------------------------------------------------------------------- */

describe('buildWebsocketSection with nothing reported', () => {
  it('claims absent evidence and no verdict for every single row', () => {
    const rows = allRows(build())

    // 40 since the gate block gained "Unmet conditions this build cannot name",
    // which is the count that replaced the condition codes this build cannot
    // print. It reads "not reported" with no gate, like every row beside it — a
    // zero read off an unrecorded gate would be the same false green.
    expect(rows).toHaveLength(40)
    for (const row of rows) {
      expect({ label: String(row.label), kind: row.evidence.kind, verdict: row.verdict }).toEqual({
        label: String(row.label),
        kind: 'absent',
        verdict: 'undetermined',
      })
    }
  })

  it('reads "not reported" in every row but the SYNC_ITEMS state, which has a word of its own', () => {
    const model = build()

    for (const row of allRows(model)) {
      if (String(row.label) === SYNC_ITEMS_ROW) {
        continue
      }
      expect(String(row.value)).toBe(NOT_REPORTED)
    }

    // NOT_OBSERVED is a reported STATE rather than silence: the gate could not
    // say. It must never collapse into "not reported", and it must never read as
    // advertised.
    expect(String(rowOf(model, SYNC_ITEMS_ROW).value)).toBe('NOT_OBSERVED')
  })

  it('never renders an absent count as zero', () => {
    for (const row of allRows(build())) {
      expect(String(row.value)).not.toBe('0')
    }
  })

  it('raises no finding and reports the section as undetermined rather than healthy', () => {
    const model = build()

    expect(codesOf(model)).toEqual([])
    expect(model.worstVerdict).toBe('undetermined')
    expect(model.worst).toBe('neutral')
    expect(model.headline).toBeUndefined()
    expect(model.id).toBe('websocket')
    expect(String(model.title)).toBe('WebSocket')
  })

  it('says a block is empty in words rather than leaving a blank panel', () => {
    const model = build()

    expect(blockOf(model, 'Realtime health').rows).toEqual([])
    expect(blockOf(model, 'Realtime health').emptyNote).toContain('no realtime health snapshot')
    expect(blockOf(model, 'Lane degradation ledger').rows).toEqual([])
    expect(blockOf(model, 'Lane degradation ledger').emptyNote).toContain('records no lane-degradation ledger')
    expect(model.reportLines.join('\n')).toContain('- Nothing was reported for this block.')
  })

  it('does not turn an unread payload into six confident capability gaps', () => {
    const model = build({ transport: undefined })

    for (const operation of SOCKET_OPERATIONS) {
      const row = operationRow(model, operation)
      expect(row.verdict).toBe('undetermined')
      expect(row.evidence.kind).toBe('absent')
      expect(String(row.value)).toBe(NOT_REPORTED)
    }
  })

  it('keeps every row label unique inside its block and every heading unique', () => {
    const model = build({
      outcomes: [{ name: 'probe', passed: true, detail: 'd', reportDetail: 'd', section: 'websocket' }],
    })

    for (const block of model.blocks) {
      const labels = block.rows.map((row) => String(row.label))
      expect(new Set(labels).size).toBe(labels.length)
    }

    const headings = model.blocks.map((block) => String(block.heading))
    expect(new Set(headings).size).toBe(headings.length)
  })

  it('only claims a verdict from the closed set', () => {
    const model = build({ payload: payload(), transport: transport(), ledger: ledger(), counters: counters() })

    for (const row of allRows(model)) {
      expect(VERDICTS).toContain(row.verdict)
      expect(VERDICTS).toContain(row.claimed)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The SYNC_ITEMS verdict: consumed, never re-derived                         */
/* -------------------------------------------------------------------------- */

describe('the SYNC_ITEMS verdict', () => {
  /**
   * THE DEFECT, AS A TEST. Every one of these payloads sets
   * `syncItemsAdvertised: true` — which is what the pre-verdict server derived
   * from a merely CONSTRUCTED proxy object — while the structured verdict says
   * something else or says nothing. A build that read the boolean would render a
   * green chip over each of them.
   */
  const withAdvertisedBoolean = (syncItems?: Record<string, unknown>): SyncDiagnosticsPayload =>
    payload({
      gate: gate({
        syncItemsAdvertised: true,
        ...(syncItems === undefined ? { syncItems: undefined } : { syncItems }),
      }),
    })

  it('never reads NOT_OBSERVED as advertised, even beside an advertised boolean', () => {
    const model = build({
      payload: withAdvertisedBoolean({
        state: 'NOT_OBSERVED',
        cause: 'NEVER_PROBED',
        remedy: null,
        probe: 'NEVER_PROBED',
      }),
      transport: transport(),
    })
    const row = rowOf(model, SYNC_ITEMS_ROW)

    expect(String(row.value)).toBe('NOT_OBSERVED')
    expect(row.verdict).toBe('undetermined')
    expect(row.claimed).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
    // "Could not determine" is not a gap in the lane, so it raises nothing.
    expect(codesOf(model)).not.toContain('SYNC_ITEMS_WITHHELD')
    expect(String(rowOf(model, 'Handshake predicate reading').value)).toBe('NEVER_PROBED')
  })

  it('refuses to fall back to the boolean on a server that sends no structured verdict', () => {
    const model = build({ payload: withAdvertisedBoolean(undefined), transport: transport() })

    expect(String(rowOf(model, SYNC_ITEMS_ROW).value)).toBe('NOT_OBSERVED')
    expect(String(rowOf(model, 'Server reports the structured verdict').value)).toBe('no')
    expect(rowOf(model, 'Server reports the structured verdict').verdict).toBe('undetermined')
    expect(rowOf(model, 'Server reports the structured verdict').evidence.kind).toBe('direct')
    expect(rowOf(model, SYNC_ITEMS_ROW).note).toContain('predates the three-state verdict')
    expect(rowOf(model, SYNC_ITEMS_ROW).note).toContain('will not repeat it')
  })

  it('refuses a state from a newer server rather than mapping it onto one it knows', () => {
    const model = build({
      payload: withAdvertisedBoolean({ state: 'PARTIALLY_ADVERTISED', cause: null, remedy: null }),
      transport: transport(),
    })

    expect(String(rowOf(model, SYNC_ITEMS_ROW).value)).toBe('NOT_OBSERVED')
    expect(rowOf(model, SYNC_ITEMS_ROW).note).toContain('outside the closed set this build knows')
    expect(rowOf(model, SYNC_ITEMS_ROW).note).not.toContain('PARTIALLY_ADVERTISED')
  })

  it('caps an ADVERTISED verdict rather than claiming the operation works', () => {
    const row = rowOf(build({ payload: payload(), transport: transport() }), SYNC_ITEMS_ROW)

    expect(String(row.value)).toBe('ADVERTISED')
    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    // The CAPPED caveat, not the uncapped relationship sentence: a claim that was
    // reduced says what it was reduced from and why.
    expect(row.caveat).toContain('does not establish')
    expect(row.caveat).toContain('negotiated SYNC_ITEMS')
    expect(row.caveat).toContain('Reported as undetermined rather than claiming it')
  })

  it('reports a WITHHELD verdict as degraded, because sync falls back to HTTP', () => {
    const model = build({
      payload: payload({
        gate: gate({
          syncItems: { state: 'WITHHELD', cause: 'DURABLE_BACKEND_NOT_READY', remedy: null, probe: 'NOT_READY' },
        }),
      }),
      transport: transport(),
    })
    const row = rowOf(model, SYNC_ITEMS_ROW)

    expect(String(row.value)).toBe('WITHHELD')
    expect(row.verdict).toBe('degraded')
    expect(row.evidence.kind).toBe('direct')
    expect(row.caveat).toBeUndefined()
    expect(String(rowOf(model, 'Why, as the gate names it').value)).toBe('DURABLE_BACKEND_NOT_READY')
  })

  it('refuses a cause from a newer server without echoing it', () => {
    const model = build({
      payload: payload({
        gate: gate({ syncItems: { state: 'WITHHELD', cause: 'SOMETHING_NEW', remedy: null, probe: 'NOT_READY' } }),
      }),
      transport: transport(),
    })

    const row = rowOf(model, 'Why, as the gate names it')

    // "Outside the closed set" and "none was named" are different answers, and
    // `describeSyncItems` nulls the cause for both.
    expect(String(row.value)).toBe(UNRECOGNISED)
    expect(row.evidence.kind).toBe('direct')
    expect(row.note).toContain('outside the closed set')
    expect(row.note).not.toContain('SOMETHING_NEW')

    const none = build({
      payload: payload({
        gate: gate({ syncItems: { state: 'WITHHELD', cause: null, remedy: null, probe: 'NOT_READY' } }),
      }),
    })
    expect(String(rowOf(none, 'Why, as the gate names it').value)).toBe(NOT_REPORTED)
    expect(rowOf(none, 'Why, as the gate names it').evidence.kind).toBe('absent')
  })

  it('admits every probe reading this build declares, and nothing else', () => {
    for (const probe of SYNC_ITEMS_PROBES) {
      const model = build({
        payload: payload({ gate: gate({ syncItems: { state: 'ADVERTISED', cause: null, remedy: null, probe } }) }),
      })
      expect(String(rowOf(model, 'Handshake predicate reading').value)).toBe(probe)
    }

    const newer = build({
      payload: payload({
        gate: gate({ syncItems: { state: 'ADVERTISED', cause: null, remedy: null, probe: 'PROBED_SIDEWAYS' } }),
      }),
    })
    expect(String(rowOf(newer, 'Handshake predicate reading').value)).toBe(UNRECOGNISED)
  })
})

/* -------------------------------------------------------------------------- */
/* An empty unmet list is not health                                          */
/* -------------------------------------------------------------------------- */

describe('the empty unmet-condition list', () => {
  /** The live defect's exact shape: the port is bound, so nothing is unmet. */
  const notReady = payload({
    gate: gate({
      syncItemsAdvertised: true,
      syncItems: { state: 'WITHHELD', cause: 'DURABLE_BACKEND_NOT_READY', remedy: null, probe: 'NOT_READY' },
      unmetPreconditions: [],
      unmetCodes: [],
    }),
  })

  /**
   * The lane is UP and five of the six operations are negotiated. That is the
   * live shape of the defect, and the fixture has to be coherent for the
   * assertions to mean anything: a transport that negotiated SYNC_ITEMS while the
   * gate withholds it is a payload no deployment produces, and it would let a
   * capability row read healthy over the very operation under test.
   */
  const liveWithoutSyncItems = transport({
    operations: SOCKET_OPERATIONS.filter((operation) => operation !== 'SYNC_ITEMS'),
  })

  it('caps a zero count rather than calling it healthy', () => {
    const model = build({ payload: notReady, transport: liveWithoutSyncItems })
    const row = rowOf(model, UNMET_ROW)

    expect(String(row.value)).toBe('0')
    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    expect(row.caveat).toContain('every socket operation is actually offered')
    expect(row.note).toContain('EMPTY')

    // Nothing in the model reads healthy about note syncing, from either side:
    // the gate's verdict and this client's own handshake agree, and they are
    // measured independently.
    expect(rowOf(model, SYNC_ITEMS_ROW).verdict).toBe('degraded')
    expect(String(operationRow(model, 'SYNC_ITEMS').value)).toBe('not-negotiated')
    expect(operationRow(model, 'SYNC_ITEMS').verdict).toBe('degraded')
  })

  it('still names the withheld operation and the two variables to check', () => {
    const model = build({ payload: notReady, transport: liveWithoutSyncItems })
    const finding = findingOf(model, 'SYNC_ITEMS_WITHHELD')

    expect(finding?.verdict).toBe('degraded')
    expect(finding?.remedy?.code).toBe('SYNC_ITEMS_WITHHELD')

    const steps = finding?.remedy?.steps.join(' ') ?? ''

    expect(steps).toContain('AUTH_JWT_SECRET')
    expect(steps).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')

    // And that step claims only what can actually happen. It used to say "an
    // empty or disagreeing secret fails the readiness check"; the empty half
    // cannot occur, because `api-gateway/src/Bootstrap/Container.ts` binds
    // `env.get('AUTH_JWT_SECRET')` with no `optional` flag and
    // `AbstractEnv.get` throws on a falsy value — measured live as a FATAL
    // startup, a supervisord restart loop and readiness 502, i.e. no gateway
    // left to serve the diagnostic that names it. The DISAGREEING half is real
    // and is the one the step has to send the reader after.
    expect(steps).toContain('same value the auth server uses')
    expect(steps).toContain('DISAGREES')
    expect(steps).toMatch(/empty[\s\S]*fatal startup/i)
    expect(steps).not.toMatch(/empty or disagreeing/i)

    expect(EFFORT_LABEL[finding?.remedy?.effort ?? 'none']).toBe('Config + restart')
    // The section is not reported healthy over this payload, which is the whole point.
    expect(model.worstVerdict).toBe('degraded')
  })

  it('leaves the remedy to the condition list for the two causes that already carry one', () => {
    for (const cause of ['LANE_PRECONDITION_UNMET', 'DURABLE_BACKEND_UNBOUND']) {
      const model = build({
        payload: payload({
          gate: gate({
            syncLaneEnabled: cause === 'LANE_PRECONDITION_UNMET' ? false : true,
            syncItems: { state: 'WITHHELD', cause, remedy: null, probe: 'NEVER_PROBED' },
            unmetPreconditions: [{ code: 'SYNCING_SERVER_GRPC_UNBOUND', remedy: 'configure it' }],
          }),
        }),
        transport: transport(),
      })

      expect(findingOf(model, 'SYNC_ITEMS_WITHHELD')?.remedy).toBeUndefined()
      // And the condition itself still carries the topology-conditional advice.
      expect(findingOf(model, 'SYNCING_SERVER_GRPC_UNBOUND')?.remedy).toBeDefined()
    }
  })

  it('does not count conditions against a gate that was never recorded', () => {
    const row = rowOf(build({ payload: payload({ gate: gate({ recorded: false }) }) }), UNMET_ROW)

    expect(String(row.value)).toBe(NOT_REPORTED)
    expect(row.evidence.kind).toBe('absent')
    expect(row.verdict).toBe('undetermined')
  })
})

/* -------------------------------------------------------------------------- */
/* The boot gate                                                              */
/* -------------------------------------------------------------------------- */

describe('the boot gate block', () => {
  it('caps a positive lane decision and lets the negative one survive', () => {
    const up = rowOf(build({ payload: payload() }), 'Socket lane built at boot')
    expect(up.claimed).toBe('healthy')
    expect(up.verdict).toBe('undetermined')
    expect(up.caveat).toContain('does not establish that a client is being admitted onto it now')

    const down = rowOf(
      build({ payload: payload({ gate: gate({ syncLaneEnabled: false }) }) }),
      'Socket lane built at boot',
    )
    expect(down.claimed).toBe('broken')
    expect(down.verdict).toBe('broken')
    expect(String(down.value)).toBe('not built')
  })

  it('separates a lane-gating condition from one that withholds note syncing only', () => {
    const laneGating = build({
      payload: payload({
        gate: gate({
          syncLaneEnabled: false,
          unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: 'bind redis' }],
          unmetCodes: ['REDIS_UNBOUND'],
        }),
      }),
    })
    expect(findingOf(laneGating, 'REDIS_UNBOUND')?.verdict).toBe('broken')
    expect(findingOf(laneGating, 'REDIS_UNBOUND')?.detail).toContain('closes the socket outright')

    const itemsOnly = build({
      payload: payload({
        gate: gate({ unmetPreconditions: [{ code: 'SYNCING_SERVER_GRPC_UNBOUND', remedy: 'configure it' }] }),
      }),
    })
    expect(findingOf(itemsOnly, 'SYNCING_SERVER_GRPC_UNBOUND')?.verdict).toBe('degraded')
    expect(findingOf(itemsOnly, 'SYNCING_SERVER_GRPC_UNBOUND')?.detail).toContain('withholds SYNC_ITEMS only')
  })

  it('every declared precondition code is classified as lane-gating or not', () => {
    for (const code of PRECONDITION_CODES) {
      const model = build({ payload: payload({ gate: gate({ unmetPreconditions: [{ code, remedy: 'fix' }] }) }) })
      const finding = findingOf(model, code)

      expect(finding).toBeDefined()
      expect(finding?.verdict).toBe(LANE_GATING_PRECONDITIONS.includes(code) ? 'broken' : 'degraded')
    }
  })

  /**
   * The honest use of `correlated` in this section. The gate reported something
   * and this build cannot say what it closes, so NEITHER direction establishes
   * anything and no verdict survives — which is different from, and weaker than,
   * the necessary-condition proxies everywhere else here.
   */
  it('claims no verdict from a condition code it does not recognise, and says why', () => {
    const model = build({
      payload: payload({ gate: gate({ unmetPreconditions: [{ code: 'A_NEWER_CONDITION', remedy: 'do a thing' }] }) }),
    })
    const finding = findingOf(model, UNRECOGNISED)

    // `broken` claimed, `undetermined` reported: the suspicion is stated and the
    // cap is what withholds it, because a `broken` claim survives a proxy only on
    // a NECESSARY condition. Flip this signal to necessary and the panel asserts
    // an outage from a code it cannot read.
    expect(finding?.claimed).toBe('broken')
    expect(finding?.verdict).toBe('undetermined')
    expect(finding?.caveat).toContain('does not establish')
    expect(finding?.detail).not.toContain('A_NEWER_CONDITION')
    // `verified`, not `generic`. `generic` means "the server's own default copy,
    // printed because the topology is unknown", and that is precisely what this
    // branch no longer does: the remedy is this build's own counted one, derived
    // from the DIRECT observation that the code is outside its closed set. A
    // `generic` basis here would print ", generic advice" beside advice that is
    // not a default at all.
    expect(finding?.remedy?.basis).toBe('verified')
    expect(finding?.remedy?.effort).toBe('client-update')
    // Counted, and the server's advice for it is nowhere in the finding.
    expect(finding?.remedy?.summary).toContain('1 unmet condition')
    expect(JSON.stringify(finding)).not.toContain('do a thing')
  })

  it('merges the host condition rather than trusting it to arrive merged', () => {
    const model = build({
      payload: payload({
        gate: gate({
          unmetPreconditions: [],
          host: { unmetCondition: 'WEBSOCKET_REDIS_NAMESPACE_INVALID', remedy: 'fix the namespace' },
        }),
      }),
    })

    expect(String(rowOf(model, UNMET_ROW).value)).toBe('1')
    expect(findingOf(model, 'WEBSOCKET_REDIS_NAMESPACE_INVALID')?.verdict).toBe('broken')
  })

  /**
   * *** THE FAMILY MEMBER THE MEASUREMENT TABLE UNDER-REPORTED. ***
   *
   * `gate.host.unmetCondition` and `gate.host.remedy` were recorded as reaching
   * the Overview only. They reached THIS section too, and the reason they looked
   * clean is the reason it is worth a test of its own: the dedup loop collapses
   * every unrecognised condition onto one finding, so with any OTHER unrecognised
   * code in the list the host's finding is the one dropped. Measured on the live
   * payload with an empty `unmetPreconditions`, both fields printed.
   *
   * There is no channel for the remedy now — `mergedConditions` returns codes and
   * nothing else — so this is the assertion over a structural fix rather than
   * over a filter.
   */
  it('counts a host condition it cannot name and carries neither it nor its remedy', () => {
    const model = build({
      payload: payload({
        gate: gate({
          unmetPreconditions: [],
          host: { unmetCondition: PLANTED_SHAPED, remedy: PLANTED_OPAQUE },
        }),
      }),
    })

    const serialised = JSON.stringify(model)
    for (const fragment of [...windowsOf(PLANTED_SHAPED), ...windowsOf(PLANTED_OPAQUE)]) {
      expect(serialised).not.toContain(fragment)
    }
    expect(serialised).not.toContain('[address withheld]')
    // The condition is still REPORTED, as a count in two places.
    expect(String(rowOf(model, UNMET_ROW).value)).toBe('1')
    expect(String(rowOf(model, UNNAMEABLE_ROW).value)).toBe('1')
    expect(findingOf(model, UNRECOGNISED)?.title).toContain('1 unmet condition')
  })

  it('does not print the host condition twice when the server already merged it', () => {
    const model = build({
      payload: payload({
        gate: gate({
          unmetPreconditions: [{ code: 'WEBSOCKET_REDIS_NAMESPACE_INVALID', remedy: 'fix it' }],
          host: { unmetCondition: 'WEBSOCKET_REDIS_NAMESPACE_INVALID', remedy: 'fix it' },
        }),
      }),
    })

    expect(codesOf(model).filter((code) => code === 'WEBSOCKET_REDIS_NAMESPACE_INVALID')).toHaveLength(1)
    expect(String(rowOf(model, UNMET_ROW).value)).toBe('1')
  })

  it('deduplicates two unrecognised codes into one finding rather than two identical keys', () => {
    const model = build({
      payload: payload({
        gate: gate({
          unmetPreconditions: [
            { code: 'FUTURE_ONE', remedy: 'a' },
            { code: 'FUTURE_TWO', remedy: 'b' },
          ],
        }),
      }),
    })

    expect(codesOf(model).filter((code) => code === UNRECOGNISED)).toHaveLength(1)
    // The COUNT still reports both: a dropped condition is the fault, a merged
    // finding is only a presentation choice.
    expect(String(rowOf(model, UNMET_ROW).value)).toBe('2')
    // And the merged finding carries the count of what was merged into it, which
    // is the only thing it has instead of the two names.
    expect(String(rowOf(model, UNNAMEABLE_ROW).value)).toBe('2')
    expect(findingOf(model, UNRECOGNISED)?.title).toContain('2 unmet conditions')
    expect(findingOf(model, UNRECOGNISED)?.remedy?.summary).toContain('2 unmet conditions')
  })

  it('reports a lane built with no attached gateway as the lane being broken', () => {
    const model = build({ payload: payload({ gate: gate({ gatewayAttached: false }) }) })
    const finding = findingOf(model, 'LANE_BUILT_WITHOUT_GATEWAY')

    expect(finding?.verdict).toBe('broken')
    expect(finding?.remedy?.code).toBe('WEBSOCKET_REDIS_NAMESPACE_INVALID')
    expect(rowOf(model, 'Gateway attached to this process').verdict).toBe('broken')
  })
})

/* -------------------------------------------------------------------------- */
/* This client's own transport: the one direct observation                    */
/* -------------------------------------------------------------------------- */

describe('the transport block', () => {
  it('gives every transport state a verdict of its own', () => {
    const expected: Record<string, string> = {
      HTTP_ONLY: 'degraded',
      CONNECTING: 'undetermined',
      AUTHENTICATING: 'undetermined',
      READY: 'healthy',
      DEGRADED: 'degraded',
      HTTP_FALLBACK: 'degraded',
      HALF_OPEN: 'degraded',
    }

    for (const state of SOCKET_TRANSPORT_STATES) {
      const row = rowOf(build({ transport: transport({ state }) }), 'Transport in use right now')
      expect({ state, verdict: row.verdict }).toEqual({ state, verdict: expected[state] })
      expect(row.evidence.kind).toBe('direct')
      expect(String(row.value)).toBe(state)
    }
  })

  it('tells "no transport read" apart from "no socket"', () => {
    const row = rowOf(build({ payload: payload() }), 'Transport in use right now')

    expect(row.evidence.kind).toBe('absent')
    expect(row.verdict).toBe('undetermined')
    expect(row.note).toContain('NOT the same as')
  })

  it('prints the protocol’s own sentence for every fallback reason', () => {
    for (const reason of SOCKET_FALLBACK_REASONS) {
      const model = build({ transport: transport({ state: 'HTTP_FALLBACK', fallbackReason: reason }) })
      const row = rowOf(model, 'Reported fallback reason')

      expect(String(row.value)).toBe(reason)
      expect(row.note).toBe(SYNC_FALLBACK_REASON_EXPLANATIONS[reason])
    }
  })

  it('separates a structural fallback reason from a retryable one', () => {
    const structural = build({ transport: transport({ state: 'HTTP_ONLY', fallbackReason: 'capability-unavailable' }) })
    expect(String(rowOf(structural, 'Is that reason retryable').value)).toBe('structural')
    expect(rowOf(structural, 'Is that reason retryable').verdict).toBe('degraded')
    expect(findingOf(structural, 'SOCKET_CAPABILITY_REFUSED')?.verdict).toBe('degraded')

    const retryable = build({ transport: transport({ state: 'HALF_OPEN', fallbackReason: 'ack-timeout' }) })
    expect(String(rowOf(retryable, 'Is that reason retryable').value)).toBe('retryable')
    expect(rowOf(retryable, 'Is that reason retryable').verdict).toBe('informational')
  })

  it('leaves the two reasons other sections own without a finding of its own', () => {
    for (const reason of ['unsupported-browser', 'live-sync-disabled'] as const) {
      const model = build({ transport: transport({ state: 'HTTP_ONLY', fallbackReason: reason }) })

      expect(codesOf(model)).toEqual([])
      expect(String(rowOf(model, 'Reported fallback reason').value)).toBe(reason)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Capabilities, measured on this client's handshake                          */
/* -------------------------------------------------------------------------- */

/**
 * A planted operation name with NO structure for a denylist to match. Built from
 * markers rather than plausible prose so no fragment collides with the build's own
 * copy, and asserted by head, middle AND tail — the tail sits past 60 characters,
 * which is where a peer's planted fragments silently landed behind a truncation
 * earlier tonight.
 */
const PLANTED_HEAD = 'SRNLEAKHEAD41'
const PLANTED_MIDDLE = 'SRNLEAKMIDDLE62'
const PLANTED_TAIL = 'SRNLEAKTAIL83'
const PLANTED_OPAQUE_OPERATION = `${PLANTED_HEAD}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_MIDDLE}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_TAIL}`
const PLANTED_FRAGMENTS = [PLANTED_HEAD, PLANTED_MIDDLE, PLANTED_TAIL, PLANTED_OPAQUE_OPERATION]

describe('the capability block', () => {
  it('reports an operation this socket negotiated as healthy on direct evidence', () => {
    const model = build({ payload: payload(), transport: transport() })
    const row = rowOf(model, 'SYNC_ITEMS — note syncing')

    expect(String(row.value)).toBe('active')
    expect(row.verdict).toBe('healthy')
    expect(row.evidence.kind).toBe('direct')
    expect(row.caveat).toBeUndefined()
  })

  it('reports an operation a live socket did not negotiate as degraded, not as an outage', () => {
    const model = build({
      payload: payload(),
      transport: transport({ operations: SOCKET_OPERATIONS.filter((operation) => operation !== 'SYNC_ITEMS') }),
    })
    const row = rowOf(model, 'SYNC_ITEMS — note syncing')

    expect(String(row.value)).toBe('not-negotiated')
    expect(row.verdict).toBe('degraded')
    expect(row.evidence.kind).toBe('direct')
  })

  it('cannot confirm an operation while no socket is live', () => {
    const model = build({ payload: payload(), transport: transport({ state: 'HTTP_ONLY', operations: [] }) })
    const row = rowOf(model, 'API_RPC — control-plane reads')

    expect(String(row.value)).toBe('unknown')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
  })

  /**
   * *** COUNTS A CLIENT GAP IN BOTH PLACES; NAMES IT IN NEITHER. ***
   *
   * This test asserted the opposite until tonight — `summary).toContain('FUTURE_LANE')`
   * — on the row note's own justification that "a remedy is screen-only and
   * already redacted". A live probe falsified both halves: `sanitizeServerCopy`
   * is a denylist, so it withheld an address-shaped operation name and printed
   * the opaque value `hunter2` intact, and the remedy is not screen-only either —
   * it reaches the copyable report.
   *
   * Three things are pinned, and each fails on a different regression: the count
   * going missing, the name coming back, and the redactor being reinstated as the
   * defence (which would print `[address withheld]` rather than nothing).
   */
  it('counts a client gap in the row AND in the remedy, and names it in neither', () => {
    const model = build({
      payload: payload({
        protocol: { version: 1, serverOperations: [...SOCKET_OPERATIONS, 'FUTURE_LANE', PLANTED_OPAQUE_OPERATION] },
      }),
      transport: transport(),
    })

    expect(String(rowOf(model, 'Operations this build does not recognise').value)).toBe('2')
    expect(rowOf(model, 'Operations this build does not recognise').verdict).toBe('degraded')
    const finding = findingOf(model, 'CLIENT_GAP')
    expect(finding?.verdict).toBe('degraded')
    expect(finding?.remedy?.summary).toContain('2 operations this build does not recognise')
    expect(finding?.remedy?.summary).not.toContain('FUTURE_LANE')
    expect(finding?.remedy?.summary).not.toContain('[address withheld]')
    for (const fragment of PLANTED_FRAGMENTS) {
      expect(JSON.stringify(finding)).not.toContain(fragment)
    }
    // The count is only actionable beside the list it complements, so the remedy
    // carries this build's own operations — all of which are already in the
    // bundle the reader is running.
    for (const operation of CLIENT_KNOWN_OPERATIONS) {
      expect(finding?.remedy?.because.join(' ')).toContain(operation)
    }
    expect(EFFORT_LABEL[finding?.remedy?.effort ?? 'none']).toBe('Client update')
  })

  it('admits only the capability statuses this build declares', () => {
    const model = build({ payload: payload(), transport: transport() })
    const statuses = SOCKET_OPERATIONS.map((operation) => String(operationRow(model, operation).value))

    for (const status of statuses) {
      expect(CAPABILITY_STATUSES as readonly string[]).toContain(status)
    }
  })

  it('adds the gateway’s own advertisability reading to an operation that is missing', () => {
    const missing = SOCKET_OPERATIONS.filter((operation) => operation !== 'FILES_V1')

    const cannot = build({
      payload: payload(),
      transport: transport({ operations: missing }),
      counters: counters({ advertisable: { FILES_V1: false } }),
    })
    expect(rowOf(cannot, 'FILES_V1 — file transfers').note).toContain('could not advertise this operation')

    const can = build({
      payload: payload(),
      transport: transport({ operations: missing }),
      counters: counters({ advertisable: { FILES_V1: true } }),
    })
    expect(rowOf(can, 'FILES_V1 — file transfers').note).toContain('this socket’s own handshake')
  })

  it('reads the advertised capability descriptor nobody rendered before', () => {
    const model = build({ payload: payload() })

    expect(String(rowOf(model, 'Socket capability id').value)).toBe('ws-sync')
    expect(String(rowOf(model, 'Socket endpoint advertised').value)).toBe('/sockets/sync')
    expect(String(rowOf(model, 'Protocol version advertised').value)).toBe('1')

    const capped = rowOf(model, 'Capability entries advertised')
    expect(capped.claimed).toBe('healthy')
    expect(capped.verdict).toBe('undetermined')
  })

  it('reports an empty descriptor as conclusive in the bad direction', () => {
    const model = build({
      payload: payload({ live: { capabilities: [], unavailabilityReasons: [], ticketAvailable: true } }),
    })
    const row = rowOf(model, 'Capability entries advertised')

    expect(String(row.value)).toBe('0')
    expect(row.verdict).toBe('broken')
    expect(row.evidence.kind).toBe('direct')
  })

  it('refuses a descriptor entry whose id or endpoint it does not know', () => {
    const model = build({
      payload: payload({
        live: {
          capabilities: [{ id: 'ws-something', version: 9, endpoint: '/sockets/elsewhere' }],
          unavailabilityReasons: [],
          ticketAvailable: true,
        },
      }),
    })

    expect(String(rowOf(model, 'Socket capability id').value)).toBe(UNRECOGNISED)
    expect(String(rowOf(model, 'Socket endpoint advertised').value)).toBe(UNRECOGNISED)
  })
})

/* -------------------------------------------------------------------------- */
/* Live refusals, realtime health and the files sub-gate                      */
/* -------------------------------------------------------------------------- */

describe('live refusals', () => {
  it('reports a live reason as an independent fault when the lane came up', () => {
    const model = build({
      payload: payload({
        live: {
          capabilities: [],
          unavailabilityReasons: ['ticket-store-unavailable'],
          ticketAvailable: false,
        },
      }),
    })
    const finding = findingOf(model, 'ticket-store-unavailable')

    expect(finding?.verdict).toBe('broken')
    expect(EFFORT_LABEL[finding?.remedy?.effort ?? 'none']).toBe('Transient')
    expect(String(rowOf(model, 'Live refusal reasons reported').value)).toBe('1')
  })

  it('suppresses live reasons that merely restate a lane that never came up', () => {
    const model = build({
      payload: payload({
        gate: gate({ syncLaneEnabled: false }),
        live: { capabilities: [], unavailabilityReasons: ['sync-not-configured'], ticketAvailable: false },
      }),
    })

    expect(codesOf(model)).not.toContain('sync-not-configured')
    expect(blockOf(model, 'Live refusals').description).toContain('restates the boot gate')
    // The count still reports what arrived, so nothing is silently dropped.
    expect(String(rowOf(model, 'Live refusal reasons reported').value)).toBe('1')
  })

  it('claims no verdict from a refusal reason it does not recognise', () => {
    const model = build({
      payload: payload({
        live: { capabilities: [], unavailabilityReasons: ['a-newer-reason'], ticketAvailable: false },
      }),
    })
    const finding = findingOf(model, UNRECOGNISED)

    expect(finding?.claimed).toBe('broken')
    expect(finding?.verdict).toBe('undetermined')
    expect(finding?.detail).not.toContain('a-newer-reason')
  })
})

describe('realtime health', () => {
  const realtime = (overrides: Partial<RealtimeView> = {}): SyncDiagnosticsPayload =>
    payload({
      live: {
        capabilities: [],
        unavailabilityReasons: [],
        ticketAvailable: true,
        realtime: {
          attached: true,
          pushBridge: 'redis',
          pushBridgeReady: true,
          sqsConsumerRunning: true,
          collaborationRelayHealthy: true,
          syncLane: 'up',
          pushesDispatched: 12,
          ...overrides,
        },
      },
    })

  it('re-derives every value from the typed fields and keeps the helper’s notes', () => {
    const model = build({ payload: realtime() })
    const notes = new Map(
      describeRealtimeHealth(realtime().live?.realtime).map((row) => [row.label, row.note] as const),
    )

    expect(String(rowOf(model, 'Push bridge').value)).toBe('redis (ready)')
    expect(rowOf(model, 'Push bridge').note).toBe(notes.get('Push bridge'))
    expect(rowOf(model, 'Attached gateway').note).toBe(notes.get('Gateway'))
    expect(rowOf(model, 'Gateway would admit a client now').note).toBe(notes.get('Sync lane'))
    expect(rowOf(model, 'Collaboration relay').note).toBe(notes.get('Collaboration relay'))
  })

  /**
   * This row's own absent-versus-zero reading. It was written as a DIVERGENCE
   * from `describeRealtimeHealth`, which printed `String(pushesDispatched ?? 0)`
   * and so made a server that sent no counter look exactly like one that
   * measured none — on the single row where a zero is the signature of a
   * delivery path that never fires. t108 fixed the helper, so the two now agree
   * and the assertion below pins the AGREEMENT: this block must keep its own
   * reading (it re-derives every value from the typed fields for the brand-cast
   * reason in `buildRealtimeBlock`), and the helper must not drift back.
   */
  it('does not turn an absent push counter into a measured zero', () => {
    const model = build({ payload: realtime({ pushesDispatched: undefined }) })
    const row = rowOf(model, 'Pushes dispatched since attach')

    expect(String(row.value)).toBe(NOT_REPORTED)
    expect(row.evidence.kind).toBe('absent')
    expect(describeRealtimeHealth(realtime({ pushesDispatched: undefined }).live?.realtime)[5].value).not.toBe('0')
    // ...and a REPORTED zero is still a measurement on both sides.
    expect(
      String(rowOf(build({ payload: realtime({ pushesDispatched: 0 }) }), 'Pushes dispatched since attach').value),
    ).toBe('0')
    expect(describeRealtimeHealth(realtime({ pushesDispatched: 0 }).live?.realtime)[5].value).toBe('0')
  })

  it('reports a bound-but-unready bridge as degraded and an absent one as broken', () => {
    expect(rowOf(build({ payload: realtime({ pushBridgeReady: false }) }), 'Push bridge').verdict).toBe('degraded')

    const none = build({ payload: realtime({ pushBridge: 'none', pushBridgeReady: false }) })
    expect(rowOf(none, 'Push bridge').verdict).toBe('broken')
    expect(findingOf(none, 'PUSH_BRIDGE_ABSENT')?.verdict).toBe('broken')
  })

  it('treats an in-process bridge as healthy rather than as a missing Redis', () => {
    const model = build({ payload: realtime({ pushBridge: 'in-process' }) })

    expect(rowOf(model, 'Push bridge').verdict).toBe('healthy')
    expect(codesOf(model)).not.toContain('PUSH_BRIDGE_ABSENT')
  })

  it('refuses a push bridge value it does not recognise', () => {
    const model = build({ payload: realtime({ pushBridge: 'kafka' }) })

    expect(String(rowOf(model, 'Push bridge').value)).toContain(UNRECOGNISED)
    expect(rowOf(model, 'Push bridge').verdict).toBe('broken')
  })
})

describe('the FILES_V1 sub-gate', () => {
  it('caps an advertised sub-gate and reports a withheld one as degraded', () => {
    const advertised = rowOf(
      build({ payload: payload({ gate: gate({ files: { advertised: true } }) }) }),
      'FILES_V1 at the boot gate',
    )
    expect(advertised.claimed).toBe('healthy')
    expect(advertised.verdict).toBe('undetermined')

    const model = build({
      payload: payload({
        gate: gate({
          files: { advertised: false, unmetCondition: 'VALET_TOKEN_SECRET', remedy: 'VALET_TOKEN_SECRET is not set.' },
        }),
      }),
    })
    expect(rowOf(model, 'FILES_V1 at the boot gate').verdict).toBe('degraded')
    expect(String(rowOf(model, 'FILES_V1 unmet condition').value)).toBe('VALET_TOKEN_SECRET')
    // This build's own sentence for the ADMITTED condition, which still names the
    // variable — a variable NAME is inside the presence-only contract, it is the
    // server's prose around it that is not. The server's own sentence for this
    // condition is nowhere in the finding.
    expect(findingOf(model, 'FILES_V1_WITHHELD')?.detail).toContain('VALET_TOKEN_SECRET was absent')
    expect(findingOf(model, 'FILES_V1_WITHHELD')?.detail).not.toContain('VALET_TOKEN_SECRET is not set.')
  })

  /**
   * *** WITHHELD BECAUSE IT IS NEVER PRINTED, NOT BECAUSE A DENYLIST MATCHED. ***
   *
   * This case used to assert that `[address withheld]` was PRESENT, which pinned
   * the redactor as the defence on this path. It is the trap the three commits
   * before this one each walked into from the other side: an address-shaped value
   * is caught by a denylist AND by a correct allowlist, so asserting on it cannot
   * tell the two apart. The opaque sibling below is the one that discriminates —
   * it was measured printing intact — and `[address withheld]` must now be ABSENT,
   * because its presence would mean `sanitizeServerCopy` had been put back here.
   */
  it('does not print the files remedy at all, address-shaped or opaque', () => {
    const shaped = build({
      payload: payload({
        gate: gate({
          files: {
            advertised: false,
            unmetCondition: 'FILES_INTERNAL_URL',
            remedy: 'could not reach files.internal.example:3104',
          },
        }),
      }),
    })

    expect(findingOf(shaped, 'FILES_V1_WITHHELD')?.detail).not.toContain('files.internal.example')
    expect(findingOf(shaped, 'FILES_V1_WITHHELD')?.detail).not.toContain('[address withheld]')

    const opaque = build({
      payload: payload({
        gate: gate({
          files: { advertised: false, unmetCondition: 'FILES_INTERNAL_URL', remedy: PLANTED_OPAQUE },
        }),
      }),
    })

    for (const fragment of PLANTED_WINDOWS) {
      expect(JSON.stringify(opaque)).not.toContain(fragment)
    }
    expect(findingOf(opaque, 'FILES_V1_WITHHELD')?.detail).toContain('FILES_INTERNAL_URL')
  })

  /**
   * The condition itself, in the two shapes that discriminate. An upper
   * snake case value is the class a SHAPE floor admits — it is what defeated
   * `safeEnvName` — and it is refused here by MEMBERSHIP instead.
   */
  it('refuses a sub-gate condition outside its four, by membership rather than by shape', () => {
    for (const planted of [PLANTED_OPAQUE, PLANTED_SHAPED]) {
      const model = build({
        payload: payload({
          gate: gate({ files: { advertised: false, unmetCondition: planted, remedy: planted } }),
        }),
      })

      expect(String(rowOf(model, 'FILES_V1 unmet condition').value)).toBe(UNRECOGNISED)
      expect(findingOf(model, 'FILES_V1_WITHHELD')?.detail).toContain('outside the closed set this build knows')
      for (const fragment of windowsOf(planted)) {
        expect(JSON.stringify(model)).not.toContain(fragment)
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Gateway admission and traffic                                              */
/* -------------------------------------------------------------------------- */

describe('gateway admission and traffic', () => {
  it('caps an admitted origin and lets a refused one survive, with two different fixes', () => {
    const admitted = rowOf(
      build({ counters: counters({ originAdmitted: true, allowedOriginCount: 2 }) }),
      'This client’s origin admitted',
    )
    expect(admitted.claimed).toBe('healthy')
    expect(admitted.verdict).toBe('undetermined')

    const empty = build({ counters: counters({ originAdmitted: false, allowedOriginCount: 0 }) })
    expect(findingOf(empty, 'SOCKET_ORIGIN_NOT_ADMITTED')?.verdict).toBe('broken')
    expect(findingOf(empty, 'SOCKET_ORIGIN_NOT_ADMITTED')?.remedy?.summary).toContain('No origin is permitted')

    const omitted = build({ counters: counters({ originAdmitted: false, allowedOriginCount: 3 }) })
    expect(findingOf(omitted, 'SOCKET_ORIGIN_NOT_ADMITTED')?.remedy?.summary).toContain('not among them')
  })

  it('names the ticket-secret disagreement only when both counters are non-zero', () => {
    const both = build({ counters: counters({ ticketsIssued: 40, handshakeRejected: 40 }) })
    const finding = findingOf(both, 'SOCKET_HANDSHAKE_REJECTED')

    expect(finding?.claimed).toBe('undetermined')
    expect(finding?.verdict).toBe('undetermined')
    // The UNCAPPED correlated sentence, which is the one this pane printed the
    // necessary-condition wording over until the relation became a closed set.
    // "Its failure is conclusive" is false of two counters moving together, and
    // this assertion is what stops it being printed here.
    expect(finding?.caveat).toContain('travels with')
    expect(finding?.caveat).toContain('no verdict is claimed from it')
    expect(finding?.caveat).not.toContain('Its failure is conclusive')
    expect(finding?.remedy?.steps.join(' ')).toContain('WEB_SOCKET_CONNECTION_TOKEN_SECRET')

    expect(codesOf(build({ counters: counters({ ticketsIssued: 40, handshakeRejected: 0 }) }))).not.toContain(
      'SOCKET_HANDSHAKE_REJECTED',
    )
    expect(codesOf(build({ counters: counters({ handshakeRejected: 5 }) }))).not.toContain('SOCKET_HANDSHAKE_REJECTED')
  })

  it('reports each rejection cause as its own count, and never as zero when absent', () => {
    const model = build({ counters: counters({ rejections: { originNotAllowed: 7 } }) })

    expect(String(rowOf(model, 'Connections refused: origin not allowed').value)).toBe('7')
    expect(rowOf(model, 'Connections refused: origin not allowed').verdict).toBe('degraded')
    expect(String(rowOf(model, 'Connections refused: lane unavailable').value)).toBe(NOT_REPORTED)
    expect(rowOf(model, 'Connections refused: lane unavailable').evidence.kind).toBe('absent')
  })

  it('reads a reported zero as a measurement rather than as silence', () => {
    const model = build({ counters: counters({ rejections: { unavailable: 0 }, liveSockets: 0 }) })

    expect(String(rowOf(model, 'Connections refused: lane unavailable').value)).toBe('0')
    expect(rowOf(model, 'Connections refused: lane unavailable').evidence.kind).toBe('direct')
    expect(rowOf(model, 'Sockets the gateway holds now').verdict).toBe('informational')
  })
})

/* -------------------------------------------------------------------------- */
/* The lane-degradation ledger                                                */
/* -------------------------------------------------------------------------- */

describe('the lane-degradation ledger', () => {
  it('reports a 401 refusal as the stranded case, with a reconnect', () => {
    const model = build({
      payload: payload(),
      transport: transport(),
      ledger: ledger({ controlPlaneRejections: 3, controlPlaneRejectionsByStatus: { 401: 2, 498: 1 } }),
    })
    const finding = findingOf(model, 'SOCKET_LANE_CREDENTIAL_REFUSALS')

    expect(String(rowOf(model, 'Control-plane reads the lane refused').value)).toBe('3')
    expect(String(rowOf(model, 'Control-plane reads refused with 401').value)).toBe('2')
    expect(finding?.verdict).toBe('degraded')
    expect(finding?.detail).toContain('outlived the refresh')
    expect(EFFORT_LABEL[finding?.remedy?.effort ?? 'none']).toBe('On this device')
  })

  it('reports a 498-only refusal as the recoverable case, with nothing to do', () => {
    const model = build({
      ledger: ledger({ controlPlaneRejections: 2, controlPlaneRejectionsByStatus: { 498: 2 } }),
    })
    const finding = findingOf(model, 'SOCKET_LANE_CREDENTIAL_REFUSALS')

    expect(finding?.detail).toContain('inside the refresh window')
    expect(EFFORT_LABEL[finding?.remedy?.effort ?? 'none']).toBe('Transient')
  })

  it('raises nothing from a quiet ledger and calls its zero informational', () => {
    const model = build({ ledger: ledger() })

    expect(codesOf(model)).toEqual([])
    expect(rowOf(model, 'Control-plane reads the lane refused').verdict).toBe('informational')
    expect(rowOf(model, 'Control-plane reads the lane refused').evidence.kind).toBe('direct')
    expect(String(rowOf(model, 'Control-plane reads refused with 401').value)).toBe(NOT_REPORTED)
  })

  it('reports the most recent transition as a duration, never an instant', () => {
    const model = build({
      ledger: ledger({
        transitions: [
          { state: 'HTTP_FALLBACK', reason: 'ack-timeout', socketPreserved: false, msSinceLedgerStart: 1_000 },
          { state: 'READY', socketPreserved: true, msSinceLedgerStart: 125_000 },
        ],
        transitionsDropped: 4,
      }),
    })

    expect(String(rowOf(model, 'Most recent transition').value)).toBe(`READY ${NOT_REPORTED}`)
    expect(String(rowOf(model, 'Socket survived that transition').value)).toBe('preserved')
    expect(String(rowOf(model, 'That transition, after the ledger started').value)).toBe('2m 5s')
    expect(String(rowOf(model, 'Transitions dropped from the ring').value)).toBe('4')
    expect(rowOf(model, 'Transitions dropped from the ring').verdict).toBe('degraded')
  })
})

/* -------------------------------------------------------------------------- */
/* The copyable report                                                        */
/* -------------------------------------------------------------------------- */

describe('the copyable report', () => {
  /**
   * BOTH shapes on purpose. The address-shaped ones are what the redactor can
   * catch; the opaque ones are what it explicitly cannot, and they are the reason
   * the guarantee has to come from the `SafeValue` constructors instead.
   */
  const SECRETS = [
    'redis://admin:hunter2@redis.internal.example:6379',
    'syncing.internal.example:50051',
    'super-secret-jwt-signing-key',
    'hunter2',
    // Appended, so every index above keeps its meaning. These two are the shapes
    // the four above cannot discriminate: one with nothing for a denylist to
    // match, one shaped exactly like a legitimate condition code.
    PLANTED_OPAQUE,
    PLANTED_SHAPED,
  ]

  const poisoned = (secret: string): WebsocketSectionInput => ({
    payload: {
      capturedAt: secret,
      gate: {
        recorded: true,
        gatewayAttached: true,
        syncLaneEnabled: true,
        syncItemsAdvertised: true,
        syncItems: { state: secret, cause: secret, remedy: secret, probe: secret },
        unmetPreconditions: [{ code: secret, remedy: secret }],
        unmetCodes: [secret],
        files: { advertised: false, unmetCondition: secret, remedy: secret },
        host: { unmetCondition: secret, remedy: secret },
      },
      live: {
        capabilities: [{ id: secret, version: 1, endpoint: secret }],
        unavailabilityReasons: [secret],
        ticketAvailable: true,
        realtime: {
          attached: true,
          pushBridge: secret,
          pushBridgeReady: true,
          sqsConsumerRunning: true,
          collaborationRelayHealthy: true,
          syncLane: secret,
          pushesDispatched: 1,
        },
      },
      protocol: { version: 1, serverOperations: [secret] },
    },
    transport: transport(),
    ledger: ledger({ controlPlaneRejections: 1, controlPlaneRejectionsByStatus: { 401: 1 } }),
    counters: counters({ originAdmitted: false, allowedOriginCount: 1, ticketsIssued: 1, handshakeRejected: 1 }),
  })

  it.each(SECRETS)('keeps a planted value out of every report line: %s', (secret) => {
    const model = build(poisoned(secret))
    const report = model.reportLines.join('\n')

    expect(report).not.toContain(secret)
    expect(report).not.toMatch(/redis:\/\//)
    // And the report is not empty of content, so the assertion above is not
    // passing because nothing was built.
    expect(report).toContain('## WebSocket')
    expect(report).toContain('### SYNC_ITEMS')
  })

  it('keeps a planted value out of every row label and value', () => {
    for (const secret of SECRETS) {
      for (const row of allRows(build(poisoned(secret)))) {
        expect(String(row.label)).not.toContain(secret)
        expect(String(row.value)).not.toContain(secret)
      }
      for (const finding of allFindings(build(poisoned(secret)))) {
        expect(String(finding.code)).not.toContain(secret)
      }
    }
  })

  /**
   * *** THE WHOLE MODEL, NOT ONLY THE SAFE-VALUE FIELDS. ***
   *
   * The two sweeps above read `reportLines`, row labels and values, and finding
   * CODES — every field that is a `SafeValue`. That is the set the type system
   * already guarantees, and it left this file structurally blind to the fields
   * that are plain `string`: a finding's `detail`, a row's `note`, a `caveat`,
   * and every line of a `Remedy`. All four were leaking. `gate.files.remedy`
   * reached a finding's detail, and `gate.host.remedy` reached a remedy's
   * `because` whenever the host's condition was the only one this build could not
   * name — measured on the live payload, not supposed.
   *
   * So this serialises the ENTIRE model and asserts head, middle and tail of each
   * planted value. `[address withheld]` must be absent too: its presence would
   * mean the denylist had been reinstated as the defence somewhere in here.
   */
  it('keeps a planted value out of every note, detail, caveat and remedy as well', () => {
    for (const secret of [...SECRETS, PLANTED_OPAQUE, PLANTED_SHAPED]) {
      const serialised = JSON.stringify(build(poisoned(secret)))

      for (const fragment of windowsOf(secret)) {
        expect(serialised).not.toContain(fragment)
      }
      expect(serialised).not.toContain('[address withheld]')
      // Not vacuous: the model was built and does carry its findings.
      expect(serialised).toContain('FILES_V1_WITHHELD')
    }
  })

  it('states the three things it withholds rather than leaving them unexplained', () => {
    const report = build({ payload: payload(), transport: transport() }).reportLines.join('\n')

    expect(report).toContain('- Allowed origin list: never collected')
    expect(report).toContain('- Socket session credential: never reported')
    expect(report).toContain('- SYNC_ITEMS verdict source: the gate’s structured verdict')
  })

  it('carries one heading per block and the section’s worst verdict', () => {
    const model = build({ payload: payload(), transport: transport(), ledger: ledger(), counters: counters() })
    const report = model.reportLines.join('\n')

    for (const block of model.blocks) {
      expect(report).toContain(`### ${block.heading}`)
    }
    expect(report).toContain(`- Worst verdict: ${model.worstVerdict}`)
  })
})

/* -------------------------------------------------------------------------- */
/* Probe outcomes                                                             */
/* -------------------------------------------------------------------------- */

describe('operator-triggered check results', () => {
  it('renders only the outcomes tagged for this section', () => {
    const model = build({
      outcomes: [
        { name: 'socket probe', passed: true, detail: 'ok', reportDetail: 'ok', section: 'websocket' },
        { name: 'browser probe', passed: false, detail: 'no', reportDetail: 'no', section: 'browser' },
        { name: 'untagged probe', passed: true, detail: 'ok', reportDetail: 'ok' },
      ],
    })
    const block = blockOf(model, 'Operator-triggered checks')

    expect(block.outcomes?.map((outcome) => outcome.name)).toEqual(['socket probe'])
    expect(block.description).toContain('exactly one place')
  })

  it('adds no block at all when nothing was run', () => {
    expect(build().blocks.map((block) => String(block.heading))).not.toContain('Operator-triggered checks')
  })
})
