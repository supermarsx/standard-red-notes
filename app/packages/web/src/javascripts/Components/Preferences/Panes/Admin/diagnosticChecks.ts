import type { SyncNegotiatedOperation, SyncTransportState } from '@/Services/SyncTransport/syncTransportProtocol'
import {
  FILE_TRANSFER_BYTES,
  type FileSocketRead,
  type FileTransferCleanup,
  type FileTransferResult,
  type FileTransferStage,
} from './diagnosticFileTransfer'
import type { Remedy, RemedyEffort } from './diagnosticRemedies'
import {
  diagnosticFinding,
  diagnosticRow,
  EVIDENCE_DIRECT,
  evidenceNotAvailableHere,
  evidenceUntested,
  readingOf,
  safeConstant,
  safeCount,
  safeNotAvailableHere,
  safeNotTested,
  safeToken,
  safeTokens,
  SECTION_IDS,
  type DiagnosticBlock,
  type DiagnosticFinding,
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
export const CHECK_IDS = [
  'negotiation',
  'capabilities',
  'ticket',
  'control-plane',
  'marker',
  'app-shell',
  'sync-worker',
  'server-build',
  'sync',
  'revisions',
  'file-transfer',
] as const

export type CheckId = (typeof CHECK_IDS)[number]

/**
 * The checks that send nothing and are evaluated on every render.
 *
 * A tuple of its own, so the set of checks that need a RUNNER is a type and not
 * a filter: a check added to `CHECK_IDS` and to neither tuple fails compilation
 * at `RunnableCheckId`'s one consumer, the runner table, instead of reaching the
 * screen as a row nothing can ever fill in.
 */
export const LIVE_CHECK_IDS = [
  'negotiation',
  'marker',
  'app-shell',
  'sync-worker',
] as const satisfies readonly CheckId[]

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
  /**
   * For a check that writes: WHAT it writes, as one clause that completes the
   * sentence "Run all checks …". It is shown beside the button, always, where
   * `does` is the full account folded under it — consent that has to be opened
   * to be read is not consent. Absent on every check that writes nothing.
   */
  readonly writes?: string
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
    writes: 'mints one short-lived socket ticket that is never used',
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
  'app-shell': {
    id: 'app-shell',
    section: 'environment',
    title: safeConstant('App shell this tab is running'),
    mode: 'live',
    does: 'Sends nothing more. Compares the commit compiled into the code THIS TAB is running with the commit the server that serves this page says it is — the deployment marker this pane already fetched, which is never served from a cache.',
    establishes: 'this tab is running the build the server serves',
  },
  'sync-worker': {
    id: 'sync-worker',
    section: 'environment',
    title: safeConstant('Sync worker this tab is running'),
    mode: 'live',
    does: 'Sends nothing. Compares the commit compiled into the code of this page with the commit this tab’s sync worker — a separate file, which does the realtime sync and the file transfers — said it was built from when it started.',
    establishes: 'this page and its sync worker are the same build',
  },
  'server-build': {
    id: 'server-build',
    section: 'environment',
    title: safeConstant('Web app and server are one build'),
    mode: 'auto',
    does: 'Reads the API server’s own readiness answer over plain HTTP (GET /healthcheck/readiness), which names the commit that server was built from, and compares it with the commit of the web app. Read-only: nothing is written.',
    establishes: 'the web app and the API server were built from the same commit',
  },
  sync: {
    id: 'sync',
    section: 'backend',
    title: safeConstant('Sync round trip'),
    mode: 'auto',
    does: 'Asks the app to run one ordinary sync now — the same request it makes whenever a note changes — and reads from this tab’s own transport which lane carried it. It makes no change of its own: with nothing unsaved a sync uploads nothing and only asks what is new, and anything it does upload is an edit you had already made and the app was about to send.',
    establishes: 'a sync from this tab completed just now',
  },
  revisions: {
    id: 'revisions',
    section: 'backend',
    title: safeConstant('Revision history read'),
    mode: 'auto',
    does: 'Asks the server for the revision list of one note already in this account (GET /v2/items/…/revisions), over plain HTTP. Read-only: it lists history and opens none of it. Skipped when this account holds no note to ask about.',
    establishes: 'the revisions service answered an authenticated read through the gateway',
  },
  'file-transfer': {
    id: 'file-transfer',
    section: 'backend',
    title: safeConstant('File transfer round trip'),
    mode: 'operator',
    does: `Uploads ONE throwaway object of ${FILE_TRANSFER_BYTES / 1024} KiB of random bytes over HTTP, under an identifier made up for this check; reads it back in two ranged requests over HTTP — and over the socket lane too, where this tab’s socket negotiated FILES_V1 — and compares every byte; then deletes it. No file item is created, so nothing appears in your files, and none of your own files is read, changed or removed. The object is deleted even when an earlier step fails; if the delete itself fails, the result says so.`,
    establishes: 'an authorized file was stored, read back intact and deleted',
    writes: `uploads one throwaway ${FILE_TRANSFER_BYTES / 1024} KiB file of random bytes, reads it back and deletes it`,
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
  /**
   * The check ran out of time: its request was accepted and never answered.
   * Carried as a fact of its own because every check that times out is the SAME
   * fault — a server that is not answering — and they raise one finding between
   * them instead of one each.
   */
  readonly timedOut?: true
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

/**
 * What to DO when a check did not pass.
 *
 * A row can say a check failed; it cannot be the first entry under "What needs
 * attention", and a failed round trip is the most concrete thing this pane ever
 * learns. So the checks that test a whole path raise a finding of their own,
 * with one action, when they fail or come back with something lost.
 *
 * Only those. The older checks each already have a finding in the section whose
 * rows explain the same fault — a second card for it would be one fact stated
 * twice — which is why this is `Partial`.
 *
 * Every sentence is a literal of this file. The check's own `detail` goes on the
 * screen as the finding's reasoning and is never printed in the report.
 */
type CheckFailureCopy = {
  readonly code: SafeValue
  readonly title: Record<'fail' | 'degraded', string>
  readonly summary: Record<'fail' | 'degraded', string>
  readonly effort: Record<'fail' | 'degraded', RemedyEffort>
}

const CHECK_FAILURE: Partial<Record<CheckId, CheckFailureCopy>> = {
  'app-shell': {
    code: safeConstant('APP_SHELL_STALE'),
    title: {
      fail: 'This tab is running an older build than the server serves',
      degraded: 'This tab is running an older build than the server serves',
    },
    summary: {
      fail: 'Reload this tab, and every other open tab of the app. If it still reads stale after a reload, the browser is serving an old app shell from its cache: use “Reload app and clear cached files” in General preferences, which clears program files only and none of your data.',
      degraded:
        'Reload this tab, and every other open tab of the app. If it still reads stale after a reload, the browser is serving an old app shell from its cache: use “Reload app and clear cached files” in General preferences, which clears program files only and none of your data.',
    },
    effort: { fail: 'device', degraded: 'device' },
  },
  'sync-worker': {
    code: safeConstant('SYNC_WORKER_IS_ANOTHER_BUILD'),
    title: {
      fail: 'This page and its sync worker are different builds',
      degraded: 'This page and its sync worker are different builds',
    },
    summary: {
      fail: 'Reload this tab. If it reads the same after a reload, the deployed image itself carries a sync worker from another build: rebuild the web image without its build cache (docker builder prune --filter type=exec.cachemount --force, then deploy again) and reload every open tab. Until then fixes to sync and to file transfers that live in the worker are not running, whatever build the page says it is.',
      degraded:
        'Reload this tab. If it reads the same after a reload, the deployed image itself carries a sync worker from another build: rebuild the web image without its build cache (docker builder prune --filter type=exec.cachemount --force, then deploy again) and reload every open tab. Until then fixes to sync and to file transfers that live in the worker are not running, whatever build the page says it is.',
    },
    effort: { fail: 'rebuild', degraded: 'rebuild' },
  },
  'server-build': {
    code: safeConstant('WEB_AND_SERVER_BUILDS_DIFFER'),
    title: {
      fail: 'The web app and the API server are different builds',
      degraded: 'The web app and the API server are different builds',
    },
    summary: {
      fail: 'Deploy the web app and the server from the same commit. A newer web app against an older server calls endpoints that are not there yet, and the reverse hides fixes that were shipped; both present as features that half work.',
      degraded:
        'Deploy the web app and the server from the same commit. A newer web app against an older server calls endpoints that are not there yet, and the reverse hides fixes that were shipped; both present as features that half work.',
    },
    effort: { fail: 'rebuild', degraded: 'rebuild' },
  },
  sync: {
    code: safeConstant('SYNC_ROUND_TRIP_DID_NOT_PASS'),
    title: {
      fail: 'A sync from this tab did not complete',
      degraded: 'Sync works, but not over the socket that agreed to carry it',
    },
    summary: {
      fail: 'Notes changed in this tab are not reaching the server. Reload and run the check again; if it fails twice, the syncing server and database rows in this section say which part is down. If the WebSocket ledger shows the server closing the socket each time a sync is tried (cause server-kill), the gateway and the syncing server are not agreeing on the internal gRPC secret: SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET must be the same value for both, and at least 32 bytes.',
      degraded:
        'Nothing is lost but the lane: the sync went over HTTP. Run the check again — one oversized first sync legitimately does this — and if it repeats, the lane degradation ledger in the WebSocket section names the cause.',
    },
    effort: { fail: 'peer-service', degraded: 'wait' },
  },
  revisions: {
    code: safeConstant('REVISIONS_READ_DID_NOT_PASS'),
    title: {
      fail: 'The revisions service did not answer',
      degraded: 'The revisions service did not answer',
    },
    summary: {
      fail: 'Note history will not load. Check that the revisions service is running and that the gateway can reach it; its probe row in this section says whether the process answers at all.',
      degraded:
        'Note history will not load. Check that the revisions service is running and that the gateway can reach it; its probe row in this section says whether the process answers at all.',
    },
    effort: { fail: 'peer-service', degraded: 'peer-service' },
  },
  'file-transfer': {
    code: safeConstant('FILE_TRANSFER_DID_NOT_PASS'),
    title: {
      fail: 'A file could not be stored and read back',
      degraded: 'Files work over HTTP, with something lost',
    },
    summary: {
      fail: 'Attachments do not work on this deployment. The check’s own row names the step that failed, and that step names the service: authorization is auth, opening and sending is the files service, reading back is the download path through any proxy in front of it.',
      degraded:
        'Attachments work. The check’s own row says what was lost — the socket’s file lane not returning the object, or the throwaway object or its usage count being left behind — and that is the thing to look at.',
    },
    effort: { fail: 'peer-service', degraded: 'peer-service' },
  },
}

/**
 * *** ONE FAULT, HOWEVER MANY CHECKS HIT IT. *** Measured with Redis stopped
 * under an open pane: every request was accepted and none was answered, six
 * checks ran out of time, and the pane raised "a sync did not complete", "the
 * revisions service did not answer" and "a file could not be stored" as three
 * separate things to fix. None of them was the fault. A server that is not
 * answering cannot tell the pane what it is waiting for, so the pane says the
 * one thing it does know, once, and where to look instead.
 *
 * The same code from every check that timed out, so the Overview — which keeps
 * one entry per code — shows one card and lists the sections that saw it.
 */
const SERVER_NOT_ANSWERING = safeConstant('SERVER_NOT_ANSWERING')

function serverNotAnsweringFinding(reading: CheckReading): DiagnosticFinding {
  const remedy: Remedy = {
    code: String(SERVER_NOT_ANSWERING),
    summary:
      'The server is accepting requests and not answering them. Look at it from the host: a gateway waiting on a cache or a database it cannot reach behaves exactly like this, and cannot say so because it cannot answer.',
    steps: [
      'On the host, see which of this deployment’s containers or services is stopped or restarting (docker compose ps). The cache and the database are the two the gateway waits on for every request.',
      'Read the gateway’s own log for what it is waiting for. Nothing in this pane can read further: every reading it shows comes from the server that is not answering.',
      'Press Refresh here once the dependency is back. A dependency that was simply stopped needs nothing reconfigured.',
    ],
    effort: 'peer-service',
    basis: 'verified',
    because: [
      `“${reading.definition.title}” sent its request and got no answer within its deadline. That is not a refusal: the connection was accepted.`,
      'Every check that runs out of time raises this same finding, so however many did, it is listed once.',
    ],
  }

  return diagnosticFinding({
    code: SERVER_NOT_ANSWERING,
    title: 'The server is accepting requests and not answering them',
    detail:
      'At least one check sent a request that was accepted and never answered. The checks that depend on the server will all read the same way, and none of them is the fault: the server is waiting on something it cannot reach, and cannot report it.',
    verdict: 'broken',
    evidence: EVIDENCE_DIRECT,
    remedy,
  })
}

function checkFinding(reading: CheckReading): DiagnosticFinding | undefined {
  const { definition, outcome } = reading
  if (outcome?.timedOut === true) {
    return serverNotAnsweringFinding(reading)
  }
  const copy = CHECK_FAILURE[definition.id]
  if (copy === undefined || outcome === undefined || (outcome.state !== 'fail' && outcome.state !== 'degraded')) {
    return undefined
  }

  const remedy: Remedy = {
    code: String(copy.code),
    summary: copy.summary[outcome.state],
    steps: [],
    effort: copy.effort[outcome.state],
    basis: 'verified',
    because: [`“${definition.title}” was run from this pane and did not pass. What it does: ${definition.does}`],
  }

  return diagnosticFinding({
    code: copy.code,
    title: copy.title[outcome.state],
    detail: outcome.detail,
    verdict: CHECK_STATE_VERDICT[outcome.state],
    evidence: EVIDENCE_DIRECT,
    remedy,
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
    findings: mine.flatMap((reading) => {
      const finding = checkFinding(reading)

      return finding === undefined ? [] : [finding]
    }),
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
  'durable-sync',
  'file-socket-read',
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
  'durable-sync': 'a sync from this tab was committed over the socket’s durable lane',
  'file-socket-read': 'the throwaway file was read back intact over the socket’s file lane',
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
  /** Sync rounds this tab's transport settled, by carrier, since the page loaded. */
  readonly syncRounds?: SyncRoundCounts
  /** The socket half of the last file-transfer check, when one has run. */
  readonly fileSocketRead?: FileSocketRead
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
/**
 * Whether a sync has actually crossed the socket's durable lane from this tab.
 *
 * *** THE DIFFERENCE BETWEEN "NEGOTIATED" AND "HAPPENED". *** `sync-items` says
 * the socket agreed to carry sync. This says it DID: the gateway accepted a
 * durable command, the syncing server committed it, and the answer came back —
 * which is the only observation in this pane that the two services hold the same
 * internal secret and that the durable store takes a real write. It is counted by
 * the transport where each round settles, so it needs no check to have been run:
 * the app syncs when it opens.
 *
 * `not-run` and not `unknown` when the socket would carry sync and none has
 * crossed yet: that is a thing a check settles, and the check is named. A tab
 * where sync does not ride the socket at all has nothing to observe.
 */
function durableSyncWitness(
  transport: WitnessTransport | undefined,
  rounds: SyncRoundCounts | undefined,
  syncCheck: Witness['state'],
): Witness {
  const what = PASSIVE_WITNESS_WHAT['durable-sync']
  if (rounds !== undefined && rounds.socket > 0) {
    return { state: 'confirmed', what }
  }
  // The check HAS run and the round did not cross the socket. Sending the reader
  // back to run it again would be a loop; what is left is a real unknown.
  if (transport === undefined || rounds === undefined || syncCheck === 'refuted') {
    return { state: 'unknown', what }
  }
  if (transport.deferred) {
    return {
      state: 'unavailable',
      what,
      how: 'another tab of this account holds the socket lane, so this tab syncs over HTTP by design',
    }
  }
  if (transport.state === 'READY' && transport.operations.includes('SYNC_ITEMS')) {
    return { state: 'not-run', what, how: howToRun(CHECKS.sync) }
  }

  return { state: 'unavailable', what, how: 'sync does not ride a socket on this tab, so it goes over HTTP' }
}

function fileSocketReadWitness(read: FileSocketRead | undefined): Witness {
  const what = PASSIVE_WITNESS_WHAT['file-socket-read']
  if (read === undefined) {
    return { state: 'not-run', what, how: howToRun(CHECKS['file-transfer']) }
  }
  // The round trip RAN and failed before it got as far as the socket read. That
  // is not "not tested" — telling the reader to run the check that just failed
  // is a loop — and it says nothing either way about the socket's file lane.
  if (read === 'not-reached') {
    return { state: 'unknown', what }
  }
  if (read === 'not-negotiated') {
    return { state: 'unavailable', what, how: 'this tab’s socket did not negotiate FILES_V1, so files go over HTTP' }
  }

  return { state: read === 'matched' ? 'confirmed' : 'refuted', what }
}

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
  board['durable-sync'] = durableSyncWitness(transport, input.syncRounds, (board.sync ?? UNOBSERVED_BOARD.sync).state)
  board['file-socket-read'] = fileSocketReadWitness(input.fileSocketRead)

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
const SEPARATOR = safeConstant('·')

/* -------------------------------------------------------------------------- */
/* Three build identities, compared two at a time                             */
/* -------------------------------------------------------------------------- */

/** A marker's revision when it is one this build admits by shape, and nothing otherwise. */
const admittedRevision = (raw: unknown): string | undefined => {
  const view = describeDeployment(raw)

  return !view.unstamped && DEPLOY_REVISION.test(view.revision) ? view.revision : undefined
}

const revisionToken = (revision: string): SafeValue => safeToken(revision, DEPLOY_REVISION)

/**
 * Whether THIS TAB is running the build the server serves.
 *
 * *** THE STALE SHELL, WHICH NOTHING IN THE PAGE COULD SEE. *** The marker is
 * fetched fresh and says what the server serves now. The code in this tab was
 * loaded whenever the tab was — or handed over by an older service worker's
 * cache — and carried no identity of its own, so "fixed in the release that is
 * live" and "still broken in this tab" were the same screen. The bundle now
 * compiles its commit in, and this compares the two.
 *
 * Each silence is its own answer. A marker with no build to compare with is the
 * marker check's finding, so this one has nothing to test rather than a second
 * unknown about the same fact. A bundle with no revision is a real unknown: it
 * is running, and what it is cannot be said.
 */
export function describeAppShellCheck(input: {
  readonly bundleRevision: string
  readonly marker: unknown
  readonly markerRead: 'answered' | 'failed'
}): Omit<CheckOutcome, 'id'> {
  const served = input.markerRead === 'answered' ? admittedRevision(input.marker) : undefined
  if (served === undefined) {
    return {
      state: 'not-applicable',
      result: safeNotAvailableHere('the server names no build to compare with'),
      detail:
        'The server that serves this page publishes no usable build identity — the Deployment marker check says why — so there is nothing to compare this tab’s code against.',
    }
  }
  if (!DEPLOY_REVISION.test(input.bundleRevision)) {
    return {
      state: 'unknown',
      result: safeConstant('this tab’s code carries no build revision'),
      detail:
        'The code this tab is running was built without a revision, so it cannot be compared with the build the server serves. An image built with SRN_DEPLOY_REVISION compiles it in.',
    }
  }
  if (input.bundleRevision === served) {
    return {
      state: 'pass',
      result: safeConstant('this tab runs the build the server serves'),
      detail: `This tab’s code and the server’s deployment marker both name revision ${served}.`,
    }
  }

  return {
    state: 'degraded',
    result: safeTokens(
      safeConstant('stale: this tab runs'),
      revisionToken(input.bundleRevision),
      safeConstant('and the server serves'),
      revisionToken(served),
    ),
    detail: `This tab is running code built from ${input.bundleRevision}, and the server that serves this page is now serving ${served}. The tab was opened before the deployment changed, or the browser is handing it an older app shell from its cache. Fixes in the newer build are not running here.`,
  }
}

/**
 * How long a sync worker may take to say which build it is before its silence
 * is an answer. It says so in its first statement, before it opens a socket, so
 * this is generous; a worker that is still silent after it was built before it
 * could say anything.
 */
export const SYNC_WORKER_ANNOUNCE_GRACE_MS = 15_000

/** What the transport reports about its worker's build. Structural, so the pane imports no transport type. */
export type SyncWorkerBuildInput =
  | { readonly state: 'no-worker' }
  | { readonly state: 'silent'; readonly silentForMs: number }
  | { readonly state: 'reported'; readonly revision: string }

/**
 * Whether this page and its sync worker are the same build.
 *
 * *** THE PAGE CAN BE CURRENT AND ITS WORKER NOT. *** The worker is a file of its
 * own. An image was found whose page, deployment marker and readiness route all
 * named the commit it was built from while the worker beside them came out of a
 * stale build cache, from before a fix that lived in the worker: file downloads
 * went on failing in one browser on a deployment every other check here called
 * current. The stale-tab check compares the PAGE's revision with the server's and
 * could not see it. Only the worker can say which build the worker is, so it
 * does, and this compares.
 *
 * NOT WORKING, not "something lost": the realtime sync and the file transfers run
 * in the worker, and a worker from another build makes every other reading of
 * them here a reading of code that is not the code in front of the reader.
 */
export function describeSyncWorkerBuildCheck(input: {
  readonly bundleRevision: string
  readonly worker: SyncWorkerBuildInput | undefined
}): Omit<CheckOutcome, 'id'> {
  const { worker } = input
  if (worker === undefined || worker.state === 'no-worker') {
    return {
      state: 'not-applicable',
      result: safeNotAvailableHere('this tab has started no sync worker'),
      detail:
        'This tab is not running a sync worker — no realtime transport is installed, or it has not been needed yet — so there is no second build to compare with the page’s.',
    }
  }
  if (!DEPLOY_REVISION.test(input.bundleRevision)) {
    return {
      state: 'not-applicable',
      result: safeNotAvailableHere('this page carries no build revision'),
      detail:
        'The code of this page was built without a revision, so there is nothing to compare its sync worker’s with. The stale-tab check above says the same of the page itself.',
    }
  }
  if (worker.state === 'silent') {
    if (worker.silentForMs < SYNC_WORKER_ANNOUNCE_GRACE_MS) {
      return {
        state: 'unknown',
        result: safeConstant('the sync worker has only just started'),
        detail: 'The sync worker says which build it is as soon as it starts, and it has not had time to yet.',
      }
    }

    return {
      state: 'fail',
      result: safeTokens(
        safeConstant('the page is build'),
        revisionToken(input.bundleRevision),
        safeConstant('and its sync worker did not say which build it is'),
      ),
      detail: `This page was built from ${input.bundleRevision}. Its sync worker has been running for ${Math.round(worker.silentForMs / 1000)} seconds and has not said which build it is, which a worker of this build does before anything else. It is a worker file from an older build.`,
    }
  }
  if (worker.revision === input.bundleRevision) {
    return {
      state: 'pass',
      result: safeConstant('the sync worker is the same build as this page'),
      detail: `This page and its sync worker both name revision ${worker.revision}.`,
    }
  }
  if (!DEPLOY_REVISION.test(worker.revision)) {
    return {
      state: 'fail',
      result: safeTokens(
        safeConstant('the page is build'),
        revisionToken(input.bundleRevision),
        safeConstant('and its sync worker carries no build revision'),
      ),
      detail: `This page was built from ${input.bundleRevision} and its sync worker was built without a revision, so the two did not come out of one build.`,
    }
  }

  return {
    state: 'fail',
    result: safeTokens(
      safeConstant('the page is build'),
      revisionToken(input.bundleRevision),
      safeConstant('but its sync worker is build'),
      revisionToken(worker.revision),
    ),
    detail: `This page was built from ${input.bundleRevision} and its sync worker from ${worker.revision}. The worker does the realtime sync and the file transfers, so fixes to either that are in the page’s build are not running in this tab.`,
  }
}

/**
 * Whether the web app and the API server are the same build.
 *
 * Two images, two build arguments, and on a compose stack nothing forces them to
 * be given the same one: a web app redeployed without its server (or the
 * reverse) is a supported way to end up with endpoints one side calls and the
 * other does not have. The server names its own commit on its readiness route;
 * this compares it with the web app's.
 */
export function describeServerBuildCheck(input: {
  readonly marker: unknown
  readonly markerRead: 'answered' | 'failed'
  readonly readiness: { readonly status: number; readonly body: unknown }
}): Omit<CheckOutcome, 'id'> {
  const { status, body } = input.readiness
  /**
   * *** WHICH BUILD IT IS DOES NOT DEPEND ON WHETHER IT IS READY. *** The
   * readiness route names the build in its body whatever status it answers
   * with, and this check is about the build. It used to fail on anything but a
   * 2xx — so with one backend service stopped, the first entry under "What
   * needs attention" was "the API server did not say which build it is", above
   * the service that was actually down. A server that is not ready is reported
   * by the probes and checks that say WHAT is not ready; this one compares two
   * commits when it is given two, and says it could not when it is not.
   */
  const server = admittedRevision((body as { deployment?: unknown } | null | undefined)?.deployment)
  if (server === undefined) {
    const answered = status >= 200 && status < 300

    return {
      state: 'unknown',
      result: answered
        ? safeConstant('the server names no build')
        : safeTokens(safeConstant('readiness answered HTTP'), safeCount(status), safeConstant('and named no build')),
      detail: answered
        ? 'The server answered as ready and named no usable build revision, so it cannot be compared with the web app. A server image built with SRN_DEPLOY_REVISION publishes one.'
        : `The server’s readiness route answered ${status} with no usable build revision in it, so which build the server is cannot be read from here. Whether the server is working is the other sections’ question.`,
    }
  }

  const web = input.markerRead === 'answered' ? admittedRevision(input.marker) : undefined
  if (web === undefined) {
    return {
      state: 'not-applicable',
      result: safeNotAvailableHere('the web app names no build to compare with'),
      detail:
        'The server names its build, and the web app’s deployment marker names none — the Deployment marker check says why — so the two cannot be compared.',
    }
  }
  if (web === server) {
    return {
      state: 'pass',
      result: safeConstant('same build'),
      detail: `The web app and the API server both name revision ${server}.`,
    }
  }

  return {
    state: 'degraded',
    result: safeTokens(
      safeConstant('different builds: web app'),
      revisionToken(web),
      safeConstant('· server'),
      revisionToken(server),
    ),
    detail: `The web app was built from ${web} and the API server from ${server}. They were deployed separately, and one of them is behind.`,
  }
}

/* -------------------------------------------------------------------------- */
/* What each new check found, in closed words                                 */
/* -------------------------------------------------------------------------- */

export type SyncRoundCounts = Readonly<Record<'socket' | 'http' | 'failed', number>>

/**
 * One sync round, read as the DIFFERENCE between two readings of the transport's
 * own counters — never as "the call returned".
 *
 * `sync()` resolves for a locked client, an offline one and a round that was
 * merged into another, so its returning says nothing. What settled in between is
 * counted by the transport at the one place a round can settle.
 *
 * *** HTTP IS NOT A FAILURE, AND IS NOT ALWAYS FINE EITHER. *** A round the HTTP
 * endpoint served is a working sync. It is "working, with something lost" only
 * where this tab's socket had agreed to carry sync and did not: that is the lane
 * the deployment paid for standing idle.
 */
export function describeSyncRound(input: {
  readonly before: SyncRoundCounts | undefined
  readonly after: SyncRoundCounts | undefined
  /** This tab's socket is READY and negotiated SYNC_ITEMS. */
  readonly socketCarriesSync: boolean
  /** What carried the most recent round this tab settled, when there has been one. */
  readonly lastCarrier?: 'socket' | 'http' | 'failed'
}): Omit<CheckOutcome, 'id'> {
  const { before, after } = input
  if (before === undefined || after === undefined) {
    return {
      state: 'unknown',
      result: safeConstant('the round could not be observed'),
      detail:
        'This tab has no realtime transport to count sync rounds with, so whether the sync completed, and how, cannot be read from here.',
    }
  }

  const socket = after.socket - before.socket
  const http = after.http - before.http
  const failed = after.failed - before.failed

  if (socket > 0) {
    return {
      state: 'pass',
      result: safeConstant('completed over the socket'),
      detail:
        'A sync round was committed over the socket’s durable lane: the gateway accepted it, the syncing server stored and answered it, and the answer came back on the same socket.',
    }
  }
  if (http > 0) {
    return input.socketCarriesSync
      ? {
          state: 'degraded',
          result: safeConstant('completed over HTTP, although this socket negotiated SYNC_ITEMS'),
          detail:
            'The sync completed, so nothing is lost but the lane: this tab’s socket agreed to carry sync and the round went over HTTP instead. The ledger in the WebSocket section names the cause.',
        }
      : {
          state: 'pass',
          result: safeConstant('completed over HTTP'),
          detail:
            'A sync round completed over the HTTP sync endpoint, which is the lane this tab uses: its socket does not carry sync.',
        }
  }
  if (failed > 0) {
    return {
      state: 'fail',
      result: safeConstant('the sync did not complete'),
      detail:
        'The app ran a sync round and it failed on every lane it tried. Notes changed in this tab are not reaching the server.',
    }
  }

  /**
   * *** NOTHING SETTLED WHILE THE CHECK WATCHED — WHICH IS NOT ALWAYS "UNKNOWN". ***
   *
   * Measured on a stack whose gateway and syncing server held different internal
   * secrets: every sync was accepted, never committed, and never finished. The
   * round this check asked for was still hanging when it stopped watching, so it
   * reported "no sync round settled" — unknown — on a deployment where not one
   * note had loaded. The transport's own record says more than that window did:
   * a tab whose every settled round has failed, or whose last one did, is not
   * syncing, whatever the round in flight goes on to do.
   */
  if (after.socket + after.http === 0 && after.failed > 0) {
    return {
      state: 'fail',
      result: safeConstant('no sync has completed since this page loaded'),
      detail:
        'Every sync this tab has attempted since it loaded has failed, and the one this check asked for did not finish either. Nothing is reaching the server from this tab, and nothing new is arriving.',
    }
  }
  if (input.lastCarrier === 'failed') {
    return {
      state: 'fail',
      result: safeConstant('the last sync failed, and this one did not finish'),
      detail:
        'The most recent sync this tab settled failed, and the one this check asked for had not finished when the check stopped watching.',
    }
  }

  return {
    state: 'unknown',
    result: safeConstant('no sync round settled'),
    detail:
      'The app was asked to sync and no round completed or failed in the time allowed. A locked or offline client does that; so does a sync still in progress.',
  }
}

/**
 * The control-plane read, with the lane MEASURED.
 *
 * This used to say "API_RPC is negotiated, so the socket lane carries it". That
 * is an inference, and it is wrong in exactly the case the check exists for: a
 * stranded socket refuses the read and HTTP quietly serves it, and the row read
 * green over a lane that was not working.
 */
export function describeControlPlaneRead(input: {
  readonly status: number
  readonly ok: boolean
  readonly carriedBy: 'socket' | 'http'
  readonly apiRpcNegotiated: boolean
  /** How long the read took, end to end, in whole milliseconds. Absent: not timed. */
  readonly elapsedMs?: number
}): Omit<CheckOutcome, 'id'> {
  if (!input.ok) {
    // *** A REFUSED READ IS NOT A BROKEN DEPLOYMENT. *** 401, 403 and 404 are the
    // server ANSWERING — that this session is not authenticated, is not an
    // administrator, or that this build has no such endpoint. Each is a reason
    // this pane cannot look, and none of them is evidence about the lane the
    // check was asking after. Calling that a failure is the "unread is not down"
    // mistake this pane has already made once.
    const cannotLook = input.status === 401 || input.status === 403 || input.status === 404

    return {
      state: cannotLook ? 'unknown' : 'fail',
      result: safeTokens(safeConstant('answered HTTP'), safeCount(input.status)),
      detail: cannotLook
        ? `The admin endpoint answered ${input.status}, so this session cannot read it. That is why this pane is empty, and it says nothing about whether the deployment is working.`
        : `The admin endpoint answered ${input.status}.`,
    }
  }
  if (input.carriedBy === 'socket') {
    const timed =
      typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0
        ? Math.round(input.elapsedMs)
        : undefined

    return {
      state: 'pass',
      // The round trip THROUGH the socket and whatever sits in front of it: this
      // browser, any reverse proxy, the gateway, and back. A figure, not a
      // verdict — there is no threshold a deployment owes — and it is the one
      // number here that changes when a proxy starts buffering the socket.
      result:
        timed === undefined
          ? safeConstant('answered over the socket’s control-plane lane')
          : safeTokens(
              safeConstant('answered over the socket’s control-plane lane'),
              SEPARATOR,
              safeCount(timed),
              safeConstant('ms'),
            ),
      detail:
        timed === undefined
          ? 'Succeeded, and the socket’s API_RPC lane carried it — measured on this read, not inferred.'
          : `Succeeded, and the socket’s API_RPC lane carried it — measured on this read, not inferred. The read took ${timed} ms end to end, through whatever sits between this browser and the gateway.`,
    }
  }

  return input.apiRpcNegotiated
    ? {
        state: 'degraded',
        result: safeConstant('answered over HTTP, although this socket negotiated API_RPC'),
        detail:
          'The read succeeded, over HTTP: the socket’s control-plane lane was offered it first and did not carry it. That is the stranded-lane case — every admin and settings read is quietly taking the slower path. The ledger in this section counts the refusals and says which kind.',
      }
    : {
        state: 'pass',
        result: safeConstant('answered over HTTP'),
        detail: 'Succeeded, over HTTP. This tab’s socket did not negotiate API_RPC, so HTTP is the lane for it.',
      }
}

/** What the revisions read came back with. `no-note` is an account with nothing to ask about. */
export function describeRevisionsRead(read: { readonly status: number } | 'no-note'): Omit<CheckOutcome, 'id'> {
  if (read === 'no-note') {
    return {
      state: 'not-applicable',
      result: safeNotAvailableHere('this account has no note to ask about'),
      detail: 'This account holds no note, so there is no revision history to ask the server for. Nothing was sent.',
    }
  }
  if (read.status >= 200 && read.status < 300) {
    return {
      state: 'pass',
      result: safeConstant('answered'),
      detail: 'The revisions service listed the history of one note through the gateway.',
    }
  }

  const refused = read.status === 401 || read.status === 403 || read.status === 404

  return {
    state: refused ? 'unknown' : 'fail',
    result: safeTokens(safeConstant('answered HTTP'), safeCount(read.status)),
    detail: refused
      ? `The revisions read answered ${read.status}. This session was refused, or the route is not on this server, which says nothing about whether the service works.`
      : `The revisions read answered ${read.status}: the gateway reached for the revisions service and did not get an answer from it.`,
  }
}

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** The step that failed, and the boundary it crosses. */
const FILE_STAGE_WORDS: Record<FileTransferStage, { readonly result: SafeValue; readonly detail: string }> = {
  'authorize-upload': {
    result: safeConstant('the server would not authorize an upload'),
    detail:
      'The auth service did not mint an upload token for this account. Nothing was stored. That is the account’s file entitlement or the auth service itself — the files service was never reached.',
  },
  open: {
    result: safeConstant('the files service refused the upload'),
    detail:
      'Auth minted an upload token and the files service did not accept it. That is the files service being unreachable at its public address, or the two services disagreeing about the token secret.',
  },
  send: {
    result: safeConstant('the upload did not go through'),
    detail:
      'The files service opened an upload and then did not accept the bytes. That is its storage, or a proxy in front of it limiting the request.',
  },
  close: {
    result: safeConstant('the upload could not be completed'),
    detail:
      'Every byte was sent and the files service did not finalise the object. That is its storage refusing the write.',
  },
  'authorize-read': {
    result: safeConstant('the server would not authorize the read-back'),
    detail:
      'The object was stored, and the auth service then did not mint a token to read it. Reading files back is refused for this account.',
  },
  read: {
    result: safeConstant('the stored object could not be read back'),
    detail:
      'The object was stored and the ranged read-back did not complete. That is the download path: the files service, or a proxy in front of it that does not pass Range requests through.',
  },
  compare: {
    result: safeConstant('the bytes read back were not the bytes stored'),
    detail:
      'The object was stored and read back, and the two differ. Something between this browser and the files service’s storage is altering or truncating file bodies.',
  },
}

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** What became of the throwaway object. */
const FILE_CLEANUP_WORDS: Record<FileTransferCleanup, { readonly result: SafeValue; readonly detail: string }> = {
  deleted: { result: safeConstant('deleted'), detail: 'The throwaway object was deleted.' },
  'nothing-stored': {
    result: safeConstant('nothing was stored'),
    detail: 'Nothing was stored, so there is nothing to clean up.',
  },
  failed: {
    result: safeConstant('THE THROWAWAY OBJECT COULD NOT BE DELETED'),
    detail: `The throwaway object could not be deleted: up to ${FILE_TRANSFER_BYTES / 1024} KiB of random bytes remain on the files service, referenced by nothing in this account. It is counted against this account’s file usage until an administrator removes it.`,
  },
}

/**
 * The file-transfer round trip, in closed words.
 *
 * Four outcomes and no more: it failed at a named step; it worked over HTTP and
 * the socket lane returned the wrong thing; it worked and left something behind;
 * it worked. The usage counter is REPORTED and never the reason for a verdict on
 * its own — except where the object is gone and the counter has not come back,
 * which is this check having changed the account's figure, and is said.
 */
export function describeFileTransfer(result: FileTransferResult): Omit<CheckOutcome, 'id'> {
  const cleanup = FILE_CLEANUP_WORDS[result.cleanup]

  if (result.failedAt !== undefined) {
    const stage = FILE_STAGE_WORDS[result.failedAt]

    return {
      state: 'fail',
      result: safeTokens(stage.result, SEPARATOR, cleanup.result),
      detail: `${stage.detail} ${cleanup.detail}`,
    }
  }

  const stored =
    result.socketRead === 'matched'
      ? safeConstant('stored, read back intact over HTTP and over the socket')
      : safeConstant('stored, read back intact over HTTP')
  const base = `A ${FILE_TRANSFER_BYTES / 1024} KiB object was uploaded over HTTP and read back in two ranged requests, byte for byte.`

  if (result.socketRead === 'mismatched' || result.socketRead === 'failed') {
    return {
      state: 'degraded',
      result: safeTokens(
        stored,
        SEPARATOR,
        safeConstant('the socket lane did not return it'),
        SEPARATOR,
        cleanup.result,
      ),
      detail: `${base} This tab’s socket negotiated FILES_V1, and reading the same object over that lane ${
        result.socketRead === 'failed' ? 'did not complete' : 'returned different bytes'
      }. File transfers still work, over HTTP; the socket file lane does not. ${cleanup.detail}`,
    }
  }
  if (result.cleanup === 'failed') {
    return {
      state: 'degraded',
      result: safeTokens(stored, SEPARATOR, cleanup.result),
      detail: `${base} ${cleanup.detail}`,
    }
  }
  if (result.usage === 'not-returned') {
    return {
      state: 'degraded',
      result: safeTokens(
        stored,
        SEPARATOR,
        cleanup.result,
        SEPARATOR,
        safeConstant('the usage counter did not come back'),
      ),
      detail: `${base} ${cleanup.detail} The account’s file-usage figure has not returned to what it read before the check, although the object is gone: the server’s accounting did not undo what it counted. The figure in the Account section is off by up to ${FILE_TRANSFER_BYTES / 1024} KiB until it is recomputed.`,
    }
  }

  const socket =
    result.socketRead === 'matched'
      ? ' The same object was then read back over the socket’s FILES_V1 lane, byte for byte.'
      : ' This tab’s socket did not negotiate FILES_V1, so the socket file lane was not exercised.'

  return {
    state: 'pass',
    result: safeTokens(stored, SEPARATOR, cleanup.result),
    detail: `${base}${socket} ${cleanup.detail}${
      result.usage === 'returned' ? ' The account’s file-usage figure is back where it was.' : ''
    }`,
  }
}

/**
 * How long each check is given before it is reported as not answering.
 *
 * *** A CHECK THAT HANGS IS A CHECK THAT FAILED, AND IT USED TO BE NEITHER. ***
 * Measured against a real stack with Redis stopped under an open pane: the
 * gateway accepted the capability request and never answered it, the run sat on
 * "Running 1 of 6…" for as long as anyone cared to watch, and the five checks
 * behind it were never reached. A server waiting on a dependency it cannot reach
 * is the commonest way a deployment is broken, and it is exactly the case where
 * the pane has to finish and say so.
 *
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** A check added without a deadline does
 * not compile. The figures are generous on purpose — a slow answer is not a
 * failure — and each allows for what that check does: the control-plane read
 * waits out the socket lane's own thirty-second deadline before HTTP is tried,
 * and the file round trip is seven requests and a delete.
 */
export const CHECK_DEADLINE_MS: Record<RunnableCheckId, number> = {
  capabilities: 20_000,
  ticket: 20_000,
  'control-plane': 45_000,
  'server-build': 20_000,
  sync: 45_000,
  revisions: 20_000,
  'file-transfer': 90_000,
}

/** What a check that ran out of time reports. Closed copy and a whole number of seconds. */
export function describeCheckTimeout(deadlineMs: number): Omit<CheckOutcome, 'id'> {
  const seconds = Math.max(1, Math.round(deadlineMs / 1000))

  return {
    state: 'fail',
    result: safeTokens(safeConstant('no answer within'), safeCount(seconds), safeConstant('s')),
    detail: `The check sent its request and nothing came back in ${seconds} seconds. That is not a refusal: something accepted the request and never answered it, which is what a server waiting on a dependency it cannot reach looks like.`,
    timedOut: true,
  }
}

export const SECTIONS_WITH_CHECKS: readonly SectionId[] = SECTION_IDS.filter((section) =>
  CHECK_IDS.some((id) => CHECKS[id].section === section),
)
