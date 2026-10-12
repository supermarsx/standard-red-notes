import type { SyncNegotiatedOperation, SyncTransportState } from '@/Services/SyncTransport/syncTransportProtocol'
import {
  diagnosticRow,
  EVIDENCE_DIRECT,
  evidenceNotAvailableHere,
  evidenceUntested,
  readingOf,
  safeConstant,
  safeNotAvailableHere,
  safeNotTested,
  safeToken,
  safeTokens,
  SECTION_IDS,
  type DiagnosticBlock,
  type DiagnosticRow,
  type SafeValue,
  type SectionId,
  type Verdict,
  type Witness,
} from './diagnosticsSections'
import { DEPLOY_REVISION } from './reportAllowlist'
import { describeDeployment } from './syncDiagnostics'

/**
 * Standard Red Notes: the CHECKS — the things this pane actually tests, as
 * opposed to the things it is told.
 *
 * *** WHY A CHECK IS A ROW NOW, AND WAS NOT ONE BEFORE. *** The pane had five
 * probes, and their results lived in a list of their own: a section printed them
 * under its rows, read-only, and they took no part in that section's verdict. A
 * probe could fail outright and the section above it went on reading whatever its
 * rows said. Worse in the other direction: thirty-odd rows were capped to
 * "Unknown" precisely because nothing had TESTED the thing they implied — and the
 * tests that would have settled them were sitting two tabs away with nothing
 * connecting the two.
 *
 * So a check is three things at once, and this module is where they meet:
 *
 *   1. a ROW in its own section, with a verdict that counts — `untested` until it
 *      has run, which is what keeps a headline off OK until somebody tested;
 *   2. a WITNESS (`diagnosticsSections.ts`) that a capped row elsewhere can point
 *      at, so "the lane was built at boot" can finally say what would confirm it;
 *   3. an entry in the one list the operator runs from, saying in plain words what
 *      running it does BEFORE they press anything.
 *
 * *** THE PUBLIC-PASTE RULE, AND THE HOLE THIS CLOSES. *** A probe used to record
 * two strings: `detail` for the screen and `reportDetail` for the copyable
 * report, the second described as "constant copy". It was a `string`, and one
 * probe built it by interpolating the deployment marker's revision — a value
 * served by whatever fronts the web bundle, and passed through a denylist that
 * prints anything with no address shape. A marker carrying an opaque secret in
 * that field therefore reached the report's Checks block verbatim, while the
 * Deployment block twenty lines above refused the same value by shape. There is
 * no `reportDetail` now. A check's contribution to the report is `result`, a
 * `SafeValue`, and the only way to obtain one is a constructor that admits a
 * literal of this build, a closed enum, a bounded count, a duration or a token of
 * a declared shape. `detail` stays a `string`, stays on screen, and is not a path
 * into the report.
 */

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every check, as a VALUE as well as a type, so "exhaustive over the checks" is
 * checkable by a test and not only by the compiler.
 */
export const CHECK_IDS = ['negotiation', 'capabilities', 'ticket', 'control-plane', 'marker'] as const

export type CheckId = (typeof CHECK_IDS)[number]

/**
 * The checks that send nothing and are evaluated on every render.
 *
 * A tuple of its own, so the set of checks that need a RUNNER is a type and not
 * a filter: a check added to `CHECK_IDS` and to neither tuple fails compilation
 * at `RunnableCheckId`'s one consumer, the runner table, instead of reaching the
 * screen as a row nothing can ever fill in.
 */
export const LIVE_CHECK_IDS = ['negotiation', 'marker'] as const satisfies readonly CheckId[]

export type LiveCheckId = (typeof LIVE_CHECK_IDS)[number]

export type RunnableCheckId = Exclude<CheckId, LiveCheckId>

/**
 * How a check comes to have a result.
 *
 *   - `live`     — it sends nothing. It reads what this client already holds, on
 *     every render, so it is never stale and never "not tested".
 *   - `auto`     — it makes a read-only request. Run when the pane opens and again
 *     on every full run, because a result nobody asked for is still a result.
 *   - `operator` — it WRITES something, however small, so it runs only when the
 *     operator presses a button that said what it would do.
 */
export const CHECK_MODES = ['live', 'auto', 'operator'] as const

export type CheckMode = (typeof CHECK_MODES)[number]

export type CheckDefinition = {
  readonly id: CheckId
  readonly section: SectionId
  /** The row label and the name in the report. A literal of this build. */
  readonly title: SafeValue
  readonly mode: CheckMode
  /**
   * What running it DOES, in the reader's terms and in full, shown before it is
   * run. For an `operator` check this is the consent: it must name every write.
   */
  readonly does: string
  /** The observation a pass establishes, as a clause a caveat can end with. */
  readonly establishes: string
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** A check added to `CHECK_IDS` without a
 * definition fails compilation here, so it cannot reach the screen with no
 * statement of what it does.
 */
export const CHECKS: Record<CheckId, CheckDefinition> = {
  negotiation: {
    id: 'negotiation',
    section: 'websocket',
    title: safeConstant('This tab’s live socket'),
    mode: 'live',
    does: 'Sends nothing. Reads what this tab’s own realtime transport reports: whether its socket is up, and which operations that socket negotiated.',
    establishes: 'this tab’s own socket is up and authenticated',
  },
  capabilities: {
    id: 'capabilities',
    section: 'websocket',
    title: safeConstant('Capability descriptor'),
    mode: 'auto',
    does: 'Reads the public capability descriptor over plain HTTP (GET /v1/sockets/sync/capabilities). Read-only: nothing is written.',
    establishes: 'the server advertises a socket capability to clients',
  },
  ticket: {
    id: 'ticket',
    section: 'websocket',
    title: safeConstant('Socket ticket'),
    mode: 'operator',
    does: 'Asks the server to mint ONE short-lived, single-use socket ticket for your own session (POST /v1/sockets/sync/ticket), under a throwaway device id so the device your live socket is registered under is not disturbed. The ticket is never redeemed and expires by itself. Nothing else is written.',
    establishes: 'the server mints a socket ticket for this session',
  },
  'control-plane': {
    id: 'control-plane',
    section: 'websocket',
    title: safeConstant('Authenticated control-plane read'),
    mode: 'auto',
    does: 'Reads this pane’s own admin endpoint once more, through the same helper the rest of the app uses, and reports which lane carried it — the socket’s API_RPC lane when that is negotiated, plain HTTP otherwise. Read-only.',
    establishes: 'an authenticated admin read succeeds on the lane the app actually uses',
  },
  marker: {
    id: 'marker',
    section: 'environment',
    title: safeConstant('Deployment marker'),
    mode: 'live',
    does: 'Sends nothing more. Reads the deployment marker this pane already fetched when it opened (/.well-known/srn-deployment.json, from the server that serves this page), which names the commit that server was built from. Refresh fetches it again.',
    establishes: 'the server that serves this page names the build it is running',
  },
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a completed check found. FIVE answers, because two were three too few.
 *
 *   - `pass`           — it established what it set out to.
 *   - `degraded`       — it works, with something lost (a lane that fell back).
 *   - `fail`           — it does not work. A request that threw before any
 *     answer arrived is THIS: from where this client sits the thing under test
 *     could not be reached, which is the fault an operator has to see in red.
 *   - `unknown`        — it ran and the answer is not settled or not readable: a
 *     dial still in progress, a build that recorded no revision.
 *   - `not-applicable` — it ran and found there is nothing to test here. The
 *     motivating case is the live-socket check in a second browser tab: the
 *     transport correctly stands down because another tab of the same account
 *     owns the lane, and a runner that recorded a failure for it produced a
 *     report whose own diagnosis contradicted it on the same screen.
 */
export const CHECK_STATES = ['pass', 'degraded', 'fail', 'unknown', 'not-applicable'] as const

export type CheckState = (typeof CHECK_STATES)[number]

export type CheckOutcome = {
  readonly id: CheckId
  readonly state: CheckState
  /**
   * The finding in closed form — the row's value and the whole of what this check
   * contributes to the copyable report. A `SafeValue`: see the header.
   */
  readonly result: SafeValue
  /**
   * The same finding for the operator in front of the screen. MAY quote a thrown
   * message, which can name the host a request failed to reach — worth having
   * where the reader already knows their own hosts, and never copied anywhere.
   */
  readonly detail: string
}

/** One check as the pane holds it: what it is, what it found, whether it is running now. */
export type CheckReading = {
  readonly definition: CheckDefinition
  /** Absent until it has run. Never fabricated: an unrun check has no outcome. */
  readonly outcome?: CheckOutcome
  readonly running?: boolean
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each outcome is worth as a verdict.
 *
 * `fail` is `broken` and not something gentler: a check tests the thing itself,
 * so its failure is direct evidence in the one direction the pane never softens.
 */
export const CHECK_STATE_VERDICT: Record<CheckState, Verdict> = {
  pass: 'healthy',
  degraded: 'degraded',
  fail: 'broken',
  unknown: 'undetermined',
  'not-applicable': 'not-applicable',
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each outcome makes of the check as
 * a WITNESS for somebody else's row.
 *
 * `degraded` REFUTES: a row asking "is the thing I am necessary for working" is
 * not answered yes by something that half works, and the check's own row is where
 * the degradation is reported.
 */
const CHECK_STATE_WITNESS: Record<CheckState, Witness['state']> = {
  pass: 'confirmed',
  degraded: 'refuted',
  fail: 'refuted',
  unknown: 'unknown',
  'not-applicable': 'unavailable',
}

/** How to run one check, as the instruction every "not tested" sentence ends with. */
export const howToRun = (definition: CheckDefinition): string =>
  `run “${definition.title}” on the Checks tab, or Run all checks`

/**
 * One check as a row in its own section.
 *
 * Three shapes, and they are three different rows:
 *
 *   - NOT RUN — value `not tested`, verdict `untested`, with the instruction. It
 *     is deliberately not `not reported`: nothing was asked.
 *   - RAN, AND THERE WAS NOTHING TO TEST — value `not available here`, verdict
 *     `not-applicable`, with the check's own reason.
 *   - RAN — the closed result, on DIRECT evidence, because a check exercises the
 *     thing it reports.
 *
 * A check that is running keeps its previous outcome until the new one lands.
 * Blanking it would make every other row that points at it as a witness flicker
 * to "not tested" for the length of a request.
 */
export function checkRow(reading: CheckReading): DiagnosticRow {
  const { definition, outcome } = reading

  if (outcome === undefined) {
    return diagnosticRow({
      label: definition.title,
      value: safeNotTested('run it from this pane'),
      verdict: 'untested',
      evidence: evidenceUntested(howToRun(definition)),
      note: definition.does,
    })
  }

  if (outcome.state === 'not-applicable') {
    return diagnosticRow({
      label: definition.title,
      // The check's own closed reason when it supplied one in the shape the
      // reading is derived from; a generic one otherwise, so the value and the
      // verdict cannot disagree about whether this row is a silence.
      value:
        readingOf(outcome.result) === 'unavailable' ? outcome.result : safeNotAvailableHere('nothing to test here'),
      verdict: 'not-applicable',
      evidence: evidenceNotAvailableHere(outcome.detail),
      note: definition.does,
    })
  }

  return diagnosticRow({
    label: definition.title,
    value: outcome.result,
    verdict: CHECK_STATE_VERDICT[outcome.state],
    evidence: EVIDENCE_DIRECT,
    note: `${outcome.detail} What this check does: ${definition.does}`,
  })
}

const CHECKS_HEADING = safeConstant('Checks')

/**
 * The checks belonging to one section, as its FIRST block.
 *
 * First because a tested fact outranks a reported one, and the rows beneath it
 * that were resolved on these results say so by name. `undefined` when the caller
 * supplied no readings at all, so a section built without them — every section
 * spec written before checks were rows — has exactly the blocks it had.
 */
export function buildChecksBlock(
  section: SectionId,
  readings: readonly CheckReading[] | undefined,
): DiagnosticBlock | undefined {
  const mine = (readings ?? []).filter((reading) => reading.definition.section === section)
  if (mine.length === 0) {
    return undefined
  }

  return {
    heading: CHECKS_HEADING,
    description:
      'What this pane tested, rather than what it was told. A check that has not been run reads “not tested” and keeps this section — and the headline — off OK until it has. The Checks tab says what each one does before it runs, and is where one can be run on its own.',
    rows: mine.map(checkRow),
    findings: [],
  }
}

/** Every check in the registry, in `CHECK_IDS` order, each with its outcome if it has one. */
export function readingsFrom(
  outcomes: Readonly<Partial<Record<CheckId, CheckOutcome>>>,
  running: readonly CheckId[] = [],
): readonly CheckReading[] {
  return CHECK_IDS.map((id) => {
    const outcome = outcomes[id]

    return {
      definition: CHECKS[id],
      ...(outcome === undefined ? {} : { outcome }),
      ...(running.includes(id) ? { running: true } : {}),
    }
  })
}

/**
 * The run as one sentence, for the headline and the report.
 *
 * Counts every REGISTERED check, not every recorded outcome: "5 of 5 passed" over
 * a registry of nine would be the flattering denominator this pane has already
 * been caught using once. A check with nothing to test here is named as that and
 * leaves the denominator, exactly as before.
 */
export function summarizeChecks(readings: readonly CheckReading[]): string {
  const applicable = readings.filter((reading) => reading.outcome?.state !== 'not-applicable')
  const skipped = readings.length - applicable.length
  const passed = applicable.filter((reading) => reading.outcome?.state === 'pass').length
  const notRun = applicable.filter((reading) => reading.outcome === undefined).length
  const other = applicable.length - passed - notRun

  const parts = [`${passed} of ${applicable.length} checks passed`]
  if (notRun > 0) {
    parts.push(`${notRun} not run yet`)
  }
  if (other > 0) {
    parts.push(`${other} did not pass`)
  }
  if (skipped > 0) {
    parts.push(`${skipped} had nothing to test here`)
  }

  return `${parts.join(', ')}.`
}

/* -------------------------------------------------------------------------- */
/* Witnesses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Direct observations this client holds WITHOUT running anything, which capped
 * rows across the five sections can point at.
 *
 * They are not checks, because there is nothing to run and nothing to consent
 * to: each is already true or false by the time the pane renders. They are listed
 * apart from `CHECK_IDS` so that the registry the operator sees holds only things
 * that DO something.
 */
export const PASSIVE_WITNESS_IDS = [
  'all-operations',
  'sync-items',
  'files-lane',
  'admin-read',
  'crypto',
  'local-database',
  'gateway-cache',
] as const

export type PassiveWitnessId = (typeof PASSIVE_WITNESS_IDS)[number]

export type WitnessId = CheckId | PassiveWitnessId

export const WITNESS_IDS: readonly WitnessId[] = [...CHECK_IDS, ...PASSIVE_WITNESS_IDS]

export type WitnessBoard = Readonly<Record<WitnessId, Witness>>

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** What each passive witness observes. */
const PASSIVE_WITNESS_WHAT: Record<PassiveWitnessId, string> = {
  'all-operations': 'this tab’s own socket negotiated every operation the server advertises',
  'sync-items': 'this tab’s own socket negotiated SYNC_ITEMS',
  'files-lane': 'this tab’s own socket negotiated FILES_V1',
  'admin-read': 'the server answered this pane’s own authenticated admin read',
  crypto: 'this browser hashed and round-tripped an encryption with Web Crypto just now',
  'local-database': 'this app opened and read its own local database in this browser profile',
  'gateway-cache': 'the cache client this gateway holds answered a ping when the server status was read',
}

const whatOf = (id: WitnessId): string => {
  return (PASSIVE_WITNESS_IDS as readonly string[]).includes(id)
    ? PASSIVE_WITNESS_WHAT[id as PassiveWitnessId]
    : CHECKS[id as CheckId].establishes
}

/**
 * A board on which nothing has been observed.
 *
 * This is what a section builder reads when its caller supplies no board, and
 * `unknown` is the member that makes that safe: a capped row resolves to
 * `undetermined` on it, which is the verdict the cap gave before witnesses
 * existed. So a builder driven directly — a spec, or a future caller that has not
 * been wired — can never come to read OK because nobody told it otherwise.
 */
export const UNOBSERVED_BOARD: WitnessBoard = Object.fromEntries(
  WITNESS_IDS.map((id) => [id, { state: 'unknown', what: whatOf(id) } satisfies Witness]),
) as WitnessBoard

/** What a section builder reads a witness through. An absent board is the unobserved one. */
export const witnessFrom =
  (board: WitnessBoard | undefined) =>
  (id: WitnessId): Witness =>
    (board ?? UNOBSERVED_BOARD)[id]

const checkWitness = (reading: CheckReading): Witness => {
  const { definition, outcome } = reading
  if (outcome === undefined) {
    return { state: 'not-run', what: definition.establishes, how: howToRun(definition) }
  }

  return {
    state: CHECK_STATE_WITNESS[outcome.state],
    what: definition.establishes,
    ...(outcome.state === 'not-applicable' ? { how: outcome.detail } : {}),
  }
}

/** What the transport says, reduced to the one thing a passive witness needs. */
export type WitnessTransport = {
  readonly state: SyncTransportState
  readonly operations: readonly SyncNegotiatedOperation[]
  /** True when the lane is standing down for a cause the transport calls expected. */
  readonly deferred: boolean
}

export type WitnessInputs = {
  readonly checks: readonly CheckReading[]
  /** `undefined` when no transport status was read at all. */
  readonly transport?: WitnessTransport
  /** Every operation the server says it can negotiate, when the payload carried the list. */
  readonly serverOperations?: readonly string[]
  /** `true` answered, `false` failed, `undefined` still in flight. */
  readonly adminRead?: boolean
  /** `true` both round trips passed, `false` one did not, `undefined` not collected yet. */
  readonly cryptoWorks?: boolean
  /** `true` once the app's own cold load completed. `undefined` when it cannot be read. */
  readonly localDatabaseLoaded?: boolean
  /** The gateway's own cache ping, as the server status reported it. Absent: not reported. */
  readonly gatewayCachePing?: boolean
}

/**
 * Whether one operation is on this tab's socket, as a witness.
 *
 * FOUR answers. A socket that is up and carries the operation confirms. A socket
 * that is up and does NOT carry it refutes — that is the withheld-operation case,
 * and it is conclusive. A tab standing down for a sibling cannot observe either
 * way and says so. Anything else — no transport, a dial in progress, a fallback —
 * is a socket that is not there to ask, which is `unknown` here: the transport row
 * and the live-socket check are what report THAT, and a second verdict about it
 * from every operation would be one fault stated six times.
 */
function operationWitness(
  what: string,
  transport: WitnessTransport | undefined,
  holds: (operations: readonly SyncNegotiatedOperation[]) => boolean | undefined,
): Witness {
  if (transport === undefined) {
    return { state: 'unknown', what }
  }
  if (transport.deferred) {
    return {
      state: 'unavailable',
      what,
      how: 'another tab of this account holds the socket lane, so this tab is on HTTP by design and has no socket of its own to observe',
    }
  }
  if (transport.state !== 'READY') {
    return { state: 'unknown', what }
  }

  const answer = holds(transport.operations)

  return { state: answer === undefined ? 'unknown' : answer ? 'confirmed' : 'refuted', what }
}

/**
 * Every witness, from what the pane holds right now.
 *
 * Pure, and total over `WITNESS_IDS`: each member is derived here and nowhere
 * else, so two sections pointing at one observation cannot come to disagree about
 * whether it was made.
 */
export function buildWitnessBoard(input: WitnessInputs): WitnessBoard {
  const board: Partial<Record<WitnessId, Witness>> = {}

  for (const reading of input.checks) {
    board[reading.definition.id] = checkWitness(reading)
  }
  for (const id of CHECK_IDS) {
    if (board[id] === undefined) {
      board[id] = UNOBSERVED_BOARD[id]
    }
  }

  const transport = input.transport
  const advertised = input.serverOperations

  board['all-operations'] = operationWitness(PASSIVE_WITNESS_WHAT['all-operations'], transport, (operations) => {
    return advertised === undefined
      ? undefined
      : advertised.every((operation) => (operations as readonly string[]).includes(operation))
  })
  board['sync-items'] = operationWitness(PASSIVE_WITNESS_WHAT['sync-items'], transport, (operations) =>
    operations.includes('SYNC_ITEMS'),
  )
  board['files-lane'] = operationWitness(PASSIVE_WITNESS_WHAT['files-lane'], transport, (operations) =>
    operations.includes('FILES_V1'),
  )
  board['admin-read'] = {
    state: input.adminRead === undefined ? 'unknown' : input.adminRead ? 'confirmed' : 'refuted',
    what: PASSIVE_WITNESS_WHAT['admin-read'],
  }
  board.crypto = {
    state: input.cryptoWorks === undefined ? 'unknown' : input.cryptoWorks ? 'confirmed' : 'refuted',
    what: PASSIVE_WITNESS_WHAT.crypto,
  }
  // NOT `refuted` on `false`: a database that has not finished loading is one
  // still loading, and "it has not loaded yet" is not "it cannot be opened".
  board['local-database'] = {
    state: input.localDatabaseLoaded === true ? 'confirmed' : 'unknown',
    what: PASSIVE_WITNESS_WHAT['local-database'],
  }
  board['gateway-cache'] = {
    state: input.gatewayCachePing === undefined ? 'unknown' : input.gatewayCachePing ? 'confirmed' : 'refuted',
    what: PASSIVE_WITNESS_WHAT['gateway-cache'],
  }

  return board as WitnessBoard
}

/** Every check that needs running, in the registry's order. */
export const RUNNABLE_CHECK_IDS: readonly RunnableCheckId[] = CHECK_IDS.filter(
  (id): id is RunnableCheckId => !(LIVE_CHECK_IDS as readonly CheckId[]).includes(id),
)

/** The runnable checks that are read-only, and so run when the pane opens. */
export const AUTO_CHECK_IDS: readonly RunnableCheckId[] = RUNNABLE_CHECK_IDS.filter((id) => CHECKS[id].mode === 'auto')

/**
 * The deployment marker this pane fetched, as the outcome of the `marker` check.
 *
 * THREE answers. The fetch failing is a FAILURE — the server that serves this
 * page did not serve its own marker. A marker that arrived and names no usable
 * build is UNKNOWN: nothing is broken, and which commit is live cannot be said.
 * A stamped marker passes, and the revision is admitted by SHAPE through
 * `safeToken`, never by the denylist `describeDeployment` applies: that denylist
 * prints anything with no address shape, and a marker is served by whatever
 * fronts the web bundle.
 */
export function describeMarkerCheck(raw: unknown, read: 'answered' | 'failed'): Omit<CheckOutcome, 'id'> {
  if (read === 'failed') {
    return {
      state: 'fail',
      result: safeConstant('the marker could not be read'),
      detail:
        'The server that serves this page did not answer /.well-known/srn-deployment.json, so which build is live cannot be read from here.',
    }
  }

  const view = describeDeployment(raw)
  if (view.unstamped || !DEPLOY_REVISION.test(view.revision)) {
    return {
      state: 'unknown',
      result: safeConstant('no usable build identity in the marker'),
      detail: view.note ?? 'The marker arrived and carries no revision this build recognises.',
    }
  }

  return {
    state: 'pass',
    result: safeTokens(safeConstant('revision'), safeToken(view.revision, DEPLOY_REVISION)),
    detail: `The server that serves this page is running revision ${view.revision}.`,
  }
}

/** The sections that hold at least one check, in the contract's order. For tests. */
export const SECTIONS_WITH_CHECKS: readonly SectionId[] = SECTION_IDS.filter((section) =>
  CHECK_IDS.some((id) => CHECKS[id].section === section),
)
