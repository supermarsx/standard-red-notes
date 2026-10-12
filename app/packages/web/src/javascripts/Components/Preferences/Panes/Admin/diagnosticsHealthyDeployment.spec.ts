import { buildAccountSection, type AccountObservations } from './accountSection'
import { buildBackendSection } from './backendSection'
import { buildBrowserSection, type BrowserObservations } from './browserSection'
import {
  buildWitnessBoard,
  CHECK_IDS,
  describeControlPlaneRead,
  describeFileTransfer,
  describeMarkerCheck,
  describeRevisionsRead,
  describeSyncRound,
  readingsFrom,
  type CheckOutcome,
  type CheckReading,
} from './diagnosticChecks'
import type { FileTransferResult } from './diagnosticFileTransfer'
import {
  COMPOSE_GRPC_DIAGNOSTICS,
  COMPOSE_GRPC_SERVER_STATUS,
  NEGOTIATED_OPERATIONS,
} from './diagnosticsDeployments.fixture'
import { buildDiagnosticsReport } from './diagnosticsReport'
import {
  BLOCKS_OK,
  readingOf,
  safeConstant,
  SECTION_IDS,
  type DiagnosticRow,
  type SectionId,
  type SectionModel,
} from './diagnosticsSections'
import { triage } from './diagnosticsTriage'
import { buildEnvironmentSection } from './environmentSection'
import type { SyncDiagnosticsPayload, TransportStatusInput } from './syncDiagnostics'
import { buildWebsocketSection, describeLiveSocketCheck, type LaneLedgerSectionView } from './websocketSection'

/**
 * *** THE QUESTION THE PANE EXISTS TO ANSWER, ASKED OF A SERVER WITH NOTHING
 * WRONG WITH IT. ***
 *
 * An operator pasted this pane's report from a deployment where every check
 * passed, nothing was broken and nothing was degraded — and the headline, and
 * every one of the five sections under it, read UNKNOWN. This file is that
 * deployment: the payloads are the ones a compose stack with
 * `SERVICE_PROXY_TYPE=grpc` really serves (`diagnosticsDeployments.fixture.ts`),
 * the browser is the one the operator was using (Gecko, which exposes neither
 * `navigator.deviceMemory` nor client hints), and the account is theirs in shape.
 *
 * Every section spec in this directory drives its builder with no witness board,
 * where a capped row keeps the old `undetermined`. This is the one place the five
 * are built the way the tab builds them — with the checks run and the board
 * populated — so it is the only spec that can see whether a healthy deployment
 * actually comes out healthy.
 */

const REVISION = '70cf746a7290e224044197392dcc9ef149099bba'
const MARKER = { revision: REVISION, version: 'src-70cf746a7290' }

/**
 * The captured compose payload, as the OPERATOR's deployment differs from the
 * capture: it was taken over plain HTTP on loopback, so the session cookie is not
 * Secure there. Theirs is HTTPS behind a reverse proxy, where it is.
 *
 * The capture was made with an HTTP-only read, which carries the page's origin —
 * and that is now how the tab reads it too. It used to go through the app's
 * ordinary helper, which rides the socket's control-plane lane and re-enters the
 * gateway with no origin at all, so the gateway could not say whether this
 * client's origin would be admitted. `AS_THE_OPERATOR_SAW_IT` is that reading,
 * kept so the difference stays asserted.
 */
const AS_THE_TAB_READS_IT: SyncDiagnosticsPayload = {
  ...COMPOSE_GRPC_DIAGNOSTICS,
  runtime: { ...COMPOSE_GRPC_DIAGNOSTICS.runtime, cookieSecure: true },
}
const { originAdmitted: _capturedOverHttp, ...admissionOverTheSocketLane } = COMPOSE_GRPC_DIAGNOSTICS.admission ?? {}
const AS_THE_OPERATOR_SAW_IT: SyncDiagnosticsPayload = { ...AS_THE_TAB_READS_IT, admission: admissionOverTheSocketLane }

const transport: TransportStatusInput = { state: 'READY', operations: [...NEGOTIATED_OPERATIONS] }

/** A ledger as the transport publishes it after one ordinary connect: no refusals, no fallbacks. */
const ledger: LaneLedgerSectionView = {
  controlPlaneRejections: 0,
  controlPlaneRejectionsByStatus: { 401: 0, 498: 0 },
  fallbackCounts: {},
  transitions: [
    { state: 'HALF_OPEN', msSinceLedgerStart: 400 },
    { state: 'CONNECTING', msSinceLedgerStart: 800 },
    { state: 'AUTHENTICATING', msSinceLedgerStart: 1100 },
    { state: 'READY', msSinceLedgerStart: 1300 },
  ],
  transitionsDropped: 0,
  // The one collaboration authorization the worker sent to HTTP while it was busy.
  // On the operator's screen it was a second READY in the ring and a fallback
  // reason on a READY transport; it is counted here, where it is what it is.
  laneStandDownCounts: { 'reconnect-gap': 1 },
  // What the transport counts where each round settles: the page's first sync
  // went over HTTP before the socket was up, and every one since over the socket.
  syncRoundCounts: { socket: 41, http: 1, failed: 0 },
  lastSyncRound: { carrier: 'socket', msSinceLedgerStart: 2_318_000 },
  recordingForMs: 2_331_000,
}

/** Stock Firefox on Windows, as `observeBrowserCapabilities` reports it. */
const firefox: BrowserObservations = {
  secureContext: true,
  pageScheme: 'https:',
  loopbackOrigin: false,
  subtlePresent: true,
  digest: 'ok',
  aesRoundTrip: 'ok',
  randomValues: 'ok',
  webSocketPresent: true,
  workerPresent: true,
  indexedDbPresent: true,
  localStorageAccess: 'reachable',
  localStorageWrite: 'ok',
  sessionStorageAccess: 'reachable',
  sessionStorageWrite: 'ok',
  storageManagerPresent: true,
  storageEstimate: 'ok',
  storageUsedFraction: 0.0001,
  storageQuotaWholeGb: 465,
  storagePersisted: true,
  wasmPresent: true,
  wasmValidate: 'ok',
  serviceWorkerPresent: true,
  serviceWorkerControlling: true,
  serviceWorkerRegistrations: 1,
  notificationPermission: 'granted',
  online: true,
  visibilityState: 'visible',
  cookiesEnabled: true,
  clipboardWritePresent: true,
  logicalCores: 40,
  engine: 'gecko',
  platform: 'windows',
  userAgentDataPresent: false,
}

const account: AccountObservations = {
  signedIn: true,
  firstPartyServer: false,
  clientBelievesAdmin: true,
  entitledToSharedVaults: true,
  subscriptionPresent: true,
  subscriptionPlan: 'PRO_PLAN',
  subscriptionCancelled: false,
  subscriptionEndsInSeconds: 36_499 * 86_400 + 23 * 3_600,
  fileUploadBytesUsed: 1_400_000,
  fileUploadBytesLimit: -1,
  fileAllowanceOrigin: 'no-active-subscription',
  itemBytesUsed: 815_247,
  itemBytesComplete: true,
  itemUsageReading: 'reported',
  localUsageBytes: 6_500_000,
  localSoftCapBytes: 0,
  spaceFigureSource: 'read-carried-no-figure',
  fileCensus: 'present',
  protocolVersion: 1,
  serverOperations: [...NEGOTIATED_OPERATIONS],
  // Both flags, read through the gateway's envelope. The read used to look for
  // them at the top of the body and report that it carried none.
  flagReading: 'read-carried-no-flags',
  liveSyncEnabledForAccount: true,
  collaborationEnabledForAccount: true,
}

/** The same account as the pane read it before the envelope was unwrapped. */
const accountWithoutFlags: AccountObservations = { ...account }
delete accountWithoutFlags.liveSyncEnabledForAccount
delete accountWithoutFlags.collaborationEnabledForAccount

const passed = (id: CheckOutcome['id'], result: string): CheckOutcome => ({
  id,
  state: 'pass',
  // A literal of this file, standing in for the runner's own closed result.
  result: safeConstant(result as 'passed'),
  detail: 'detail',
})

/** Every registered check, with the ones that need running either run and passed, or not run. */
const checksWith = (run: boolean): readonly CheckReading[] =>
  readingsFrom({
    negotiation: { id: 'negotiation', ...describeLiveSocketCheck(transport) },
    marker: { id: 'marker', ...describeMarkerCheck(MARKER, 'answered') },
    ...(run
      ? {
          capabilities: passed('capabilities', 'advertises 1 capability entry'),
          ticket: passed('ticket', 'issued; never redeemed, and it expires on its own'),
          'control-plane': {
            id: 'control-plane',
            ...describeControlPlaneRead({ status: 200, ok: true, carriedBy: 'socket', apiRpcNegotiated: true }),
          },
          sync: {
            id: 'sync',
            ...describeSyncRound({
              before: { socket: 40, http: 1, failed: 0 },
              after: { socket: 41, http: 1, failed: 0 },
              socketCarriesSync: true,
            }),
          },
          revisions: { id: 'revisions', ...describeRevisionsRead({ status: 200 }) },
          'file-transfer': { id: 'file-transfer', ...describeFileTransfer(ROUND_TRIP) },
        }
      : {}),
  })

/** The file round trip as it comes back on a healthy compose stack. Measured, not assumed. */
const ROUND_TRIP: FileTransferResult = { socketRead: 'matched', cleanup: 'deleted', usage: 'returned' }

const sectionsFor = (
  payload: SyncDiagnosticsPayload,
  serverStatus: unknown,
  checks: readonly CheckReading[],
  observed: AccountObservations = account,
): Record<SectionId, SectionModel> => {
  const fileCheckRan = checks.some((reading) => reading.definition.id === 'file-transfer' && reading.outcome)
  const witnesses = buildWitnessBoard({
    checks,
    ...(ledger.syncRoundCounts === undefined ? {} : { syncRounds: ledger.syncRoundCounts }),
    ...(fileCheckRan ? { fileSocketRead: ROUND_TRIP.socketRead } : {}),
    transport: { state: transport.state, operations: transport.operations, deferred: false },
    ...(payload.protocol?.serverOperations === undefined
      ? {}
      : { serverOperations: payload.protocol.serverOperations }),
    adminRead: true,
    cryptoWorks: true,
    localDatabaseLoaded: true,
    gatewayCachePing: true,
  })

  return {
    websocket: buildWebsocketSection({ payload, transport, ledger, checks, witnesses }),
    environment: buildEnvironmentSection({
      topology: payload.deployment,
      deploymentMarker: MARKER,
      fallback: payload.transportFallback,
      runtime: payload.runtime,
      checks,
      witnesses,
    }),
    backend: buildBackendSection({
      serverStatus,
      statusError: null,
      topology: payload.deployment,
      datastore: payload.datastore,
      queues: payload.queues,
      buildIdentified: true,
      checks,
      witnesses,
    }),
    account: buildAccountSection({
      observations: observed,
      adminAccess: { payloadRead: true },
      checks,
      witnesses,
    }),
    browser: buildBrowserSection({
      observations: firefox,
      clock: { serverCapturedAtMs: 1_000, localReceivedAtMs: 1_200 },
      checks,
      witnesses,
    }),
  }
}

type Located = { readonly section: SectionId; readonly row: DiagnosticRow }

const everyRow = (sections: Record<SectionId, SectionModel>): readonly Located[] =>
  SECTION_IDS.flatMap((section) =>
    sections[section].blocks.flatMap((block) => block.rows.map((row) => ({ section, row }))),
  )

const labelsOf = (rows: readonly Located[]): string[] => rows.map(({ section, row }) => `${section}: ${row.label}`)

describe('a healthy compose deployment with the gRPC proxy, as the operator saw it', () => {
  const run = sectionsFor(AS_THE_TAB_READS_IT, COMPOSE_GRPC_SERVER_STATUS, checksWith(true))
  const notRun = sectionsFor(AS_THE_TAB_READS_IT, COMPOSE_GRPC_SERVER_STATUS, checksWith(false))

  it('is a real deployment and not an empty one', () => {
    expect(everyRow(run).length).toBeGreaterThan(180)
    expect(COMPOSE_GRPC_DIAGNOSTICS.deployment?.boundServiceProxy).toBe('grpc')
    // The capture carries the origin answer, and so does the tab's read now. The
    // reading the operator saw did not.
    expect(COMPOSE_GRPC_DIAGNOSTICS.admission?.originAdmitted).toBe(true)
    expect(AS_THE_TAB_READS_IT.admission?.originAdmitted).toBe(true)
    expect(AS_THE_OPERATOR_SAW_IT.admission?.originAdmitted).toBeUndefined()
    expect(_capturedOverHttp).toBe(true)
    expect(checksWith(true).every((reading) => reading.outcome?.state === 'pass')).toBe(true)
    expect(checksWith(true)).toHaveLength(CHECK_IDS.length)
  })

  it('has nothing not working and nothing degraded anywhere, and raises no finding that says so', () => {
    const alarming = everyRow(run).filter(({ row }) => row.verdict === 'broken' || row.verdict === 'degraded')
    expect(labelsOf(alarming)).toEqual([])

    const triaged = triage({ sections: run })
    expect(triaged.counts.broken).toBe(0)
    expect(triaged.counts.degraded).toBe(0)
  })

  /**
   * The twelve rows the operator's report printed as `[?] … not reported` over a
   * deployment with nothing wrong with it. Each is settled now — nothing happened
   * that it would describe, or this browser cannot produce it — and NONE of them
   * may go back to being counted as a question that went unanswered. Two more of
   * the original thirteen are a different kind of row and are pinned below.
   */
  it('settles every row that read "not reported" because there was nothing to report', () => {
    const settled: Record<string, 'not-applicable' | 'unavailable'> = {
      'websocket: Why, as the gate names it': 'not-applicable',
      'websocket: FILES_V1 unmet condition': 'not-applicable',
      'environment: Most recent gRPC failure': 'not-applicable',
      'environment: Lane of the most recent gRPC failure': 'not-applicable',
      'environment: Time since the last gRPC failure': 'not-applicable',
      'backend: Why the read failed': 'not-applicable',
      'account: Roles held by this account': 'unavailable',
      'browser: Device memory, GB': 'unavailable',
      'browser: Mobile form factor': 'unavailable',
    }
    const rows = everyRow(run)

    for (const [label, reading] of Object.entries(settled)) {
      const found = rows.find(({ section, row }) => `${section}: ${row.label}` === label)
      expect({ label, found: found !== undefined }).toEqual({ label, found: true })
      expect({ label, reading: readingOf(found?.row.value ?? ''), verdict: found?.row.verdict }).toEqual({
        label,
        reading,
        verdict: 'not-applicable',
      })
      // Never bare: the row says what established that there is nothing to say.
      expect((found?.row.caveat ?? '').length).toBeGreaterThan(20)
    }

    // The two refusal counters are MEASURED zeros now, not silences.
    for (const label of ['Control-plane reads refused with 401', 'Control-plane reads refused with 498']) {
      const found = rows.find(({ row }) => String(row.label) === label)
      expect({ label, value: String(found?.row.value), verdict: found?.row.verdict }).toEqual({
        label,
        value: '0',
        verdict: 'informational',
      })
    }
  })

  /**
   * The value and the verdict cannot disagree about whether a row is a silence —
   * the disagreement that printed "a value arrived" over a row the screen called
   * Unknown. Swept over EVERY row of all five sections, in both states.
   */
  it('never lets a row’s reading and its status disagree', () => {
    for (const sections of [run, notRun]) {
      for (const { section, row } of everyRow(sections)) {
        const reading = readingOf(row.value)
        const label = `${section}: ${row.label}`

        if (reading === 'not-applicable' || reading === 'unavailable') {
          expect({ label, verdict: row.verdict }).toEqual({ label, verdict: 'not-applicable' })
        }
        if (reading === 'untested') {
          expect({ label, verdict: row.verdict }).toEqual({ label, verdict: 'untested' })
        }
        if (row.verdict === 'not-applicable') {
          expect({ label, settled: reading === 'not-applicable' || reading === 'unavailable' }).toEqual({
            label,
            settled: true,
          })
        }
        if (row.verdict === 'healthy' || row.verdict === 'degraded' || row.verdict === 'broken') {
          expect({ label, reading }).toEqual({ label, reading: 'answered' })
        }
      }
    }
  })

  /**
   * *** BEFORE THE CHECKS ARE RUN, THE HEADLINE IS "NOT TESTED" — NOT UNKNOWN, AND
   * NOT OK. *** The one check that writes has not been asked to, and that row is
   * what says so. An OK nobody tested is the claim this pane exists to refuse.
   */
  it('reads not-tested, and names the check, while the checks have not run', () => {
    const blocking = everyRow(notRun).filter(({ row }) => BLOCKS_OK[row.verdict])

    // NOTHING is "unknown" here. Every row that keeps this deployment off OK
    // before the checks run is one a check settles, and says which.
    for (const { section, row } of blocking) {
      expect({ label: `${section}: ${row.label}`, verdict: row.verdict }).toEqual({
        label: `${section}: ${row.label}`,
        verdict: 'untested',
      })
      expect(row.caveat).toContain('Not tested yet: ')
    }
    expect(labelsOf(blocking)).toEqual(
      expect.arrayContaining([
        'websocket: Socket ticket',
        'backend: Sync round trip',
        'backend: Revision history read',
        'backend: File transfer round trip',
      ]),
    )

    // The rows a check exists FOR name that check, so "not tested" is an
    // instruction and not a shrug.
    const settledBy: Record<string, string> = {
      'backend: Syncing server probe': 'Sync round trip',
      'backend: Revisions service probe': 'Revision history read',
      'backend: Files service probe': 'File transfer round trip',
      'environment: VALET_TOKEN_SECRET': 'File transfer round trip',
      'environment: WEBSOCKET_SYNC_FILES_URL': 'File transfer round trip',
    }
    for (const [label, check] of Object.entries(settledBy)) {
      const found = blocking.find(({ section, row }) => `${section}: ${row.label}` === label)

      expect({ label, caveat: found?.row.caveat }).toEqual({
        label,
        caveat: expect.stringContaining(`run “${check}”`),
      })
    }

    expect(notRun.websocket.worstVerdict).not.toBe('healthy')
    expect(triage({ sections: notRun }).sectionWorst).toBe('untested')
  })

  /**
   * *** THE POINT OF THE WHOLE PANE: A HEALTHY DEPLOYMENT CAN SAY SO. ***
   *
   * Thirty-three capped rows used to read Unknown here for ever, and after the
   * verdict split ten still did — each named in this file, with the check that
   * would retire it. Those checks exist now. Asserted EXACTLY: not one row of the
   * five sections may keep a healthy deployment off OK once the checks have
   * passed, and a row that starts doing so fails here by name.
   */
  it('reaches OK once every check has passed, with nothing left unestablished', () => {
    const blocking = everyRow(run).filter(({ row }) => BLOCKS_OK[row.verdict])

    expect(labelsOf(blocking)).toEqual([])
    for (const id of SECTION_IDS) {
      expect({ id, worst: run[id].worstVerdict }).toEqual({ id, worst: 'healthy' })
    }
    expect(triage({ sections: run }).sectionWorst).toBe('healthy')
  })

  /**
   * And it is not a green bought by reclassifying. Each of the ten is OK because
   * something OBSERVED it — take the observation away and the row goes back to
   * blocking, by itself, with the rest unmoved.
   */
  it('owes each of those rows to an observation, and loses the row when the observation is taken away', () => {
    const blockingIn = (sections: Record<SectionId, SectionModel>): string[] =>
      labelsOf(everyRow(sections).filter(({ row }) => BLOCKS_OK[row.verdict])).sort()

    // The read that rode the socket lane carried no origin.
    expect(blockingIn(sectionsFor(AS_THE_OPERATOR_SAW_IT, COMPOSE_GRPC_SERVER_STATUS, checksWith(true)))).toEqual([
      'websocket: This client’s origin admitted',
    ])

    // The flags read that did not unwrap the gateway's envelope carried neither flag.
    expect(
      blockingIn(sectionsFor(AS_THE_TAB_READS_IT, COMPOSE_GRPC_SERVER_STATUS, checksWith(true), accountWithoutFlags)),
    ).toEqual(['account: Collaboration permitted for this account', 'account: Live sync for this account'])

    // A check that FAILED refutes the rows that rested on it, and does not leave them green.
    const failedTransfer = readingsFrom({
      ...Object.fromEntries(checksWith(true).map((reading) => [reading.definition.id, reading.outcome])),
      'file-transfer': {
        id: 'file-transfer',
        ...describeFileTransfer({ failedAt: 'open', socketRead: 'not-reached', cleanup: 'deleted', usage: 'returned' }),
      },
    } as Partial<Record<CheckOutcome['id'], CheckOutcome>>)
    const withFailedTransfer = sectionsFor(AS_THE_TAB_READS_IT, COMPOSE_GRPC_SERVER_STATUS, failedTransfer)

    expect(withFailedTransfer.backend.worstVerdict).toBe('broken')
    expect(blockingIn(withFailedTransfer)).toContain('backend: File transfer round trip')
    const filesProbe = everyRow(withFailedTransfer).find(({ row }) => String(row.label) === 'Files service probe')
    expect(filesProbe?.row.verdict).not.toBe('healthy')
  })

  /**
   * *** THE REPORT CONTRADICTED ITSELF IN SIX PLACES, ON A DEPLOYMENT WITH NOTHING
   * WRONG WITH IT. *** Each is pinned here against the operator's own figures, so
   * the pair of rows that disagreed is asserted TOGETHER — a fix to one that
   * leaves the other saying the opposite fails this test rather than passing two.
   */
  it('does not contradict itself anywhere the operator’s report did', () => {
    const sections = run
    const value = (section: SectionId, label: string): string => {
      const found = everyRow(sections).find((entry) => entry.section === section && String(entry.row.label) === label)
      return String(found?.row.value)
    }

    // "Transport: READY" beside "Reported fallback reason: reconnect-gap".
    expect(value('websocket', 'Transport in use right now')).toBe('READY')
    expect(value('websocket', 'Reported fallback reason')).toBe('nothing to report (the socket is up)')

    // "never-degraded" and "Degradations recorded: 0" beside "Recoveries recorded: 2".
    expect(value('websocket', 'Where the lane ended up')).toBe('never-degraded')
    expect(value('websocket', 'Degradations recorded')).toBe('0')
    expect(value('websocket', 'Recoveries recorded')).toBe('0')
    expect(value('websocket', 'Connections established')).toBe('1')
    expect(value('websocket', 'Single requests sent to HTTP on a live socket')).toBe('1')

    // "HALF_OPEN not reported socket torn down", and every transition "1s after
    // the ledger started" on a ledger 38 minutes old.
    const history = everyRow(sections)
      .filter((entry) => entry.section === 'websocket' && String(entry.row.label).startsWith('Transition '))
      .map((entry) => String(entry.row.value))
    expect(history).toEqual([
      'HALF_OPEN · no socket yet · 38m 50s ago',
      'CONNECTING · no socket yet · 38m 50s ago',
      'AUTHENTICATING · no socket yet · 38m 49s ago',
      'READY · socket up · 38m 49s ago',
    ])

    // "Subscription: active" beside "allowance from: no-active-subscription", and
    // "Time until the subscription ends: 36499d 23h".
    expect(value('account', 'Subscription')).toBe('included by this deployment')
    expect(value('account', 'Where the file allowance comes from')).toBe('no-subscription-record')
    expect(value('account', 'Time until the subscription ends')).toBe(
      'nothing to report (an included plan does not expire)',
    )

    // Items 0 MB + files 1 MB beside a total of 2 MB.
    const megabytes = ['Server item bytes used, whole MB', 'Server file bytes used, whole MB'].map((label) =>
      Number(value('account', label)),
    )
    expect(megabytes[0] + megabytes[1]).toBe(Number(value('account', 'Total account storage, whole MB')))
    expect(value('account', 'Total account storage, whole MB')).toBe('2')
  })

  it('keeps the browser section, which has nothing left to establish, on OK', () => {
    expect(run.browser.worstVerdict).toBe('healthy')
    expect(run.browser.counts.undetermined).toBe(0)
    expect(run.browser.counts.untested).toBe(0)
  })

  /**
   * The headline and the per-section table in the pasted report are the same
   * verdicts the models carry — read back out of the document, not recomputed.
   */
  it('puts the same statuses at the top of the copyable report', () => {
    const report = buildDiagnosticsReport({
      payload: AS_THE_TAB_READS_IT,
      transport,
      deploymentMarker: MARKER,
      checks: checksWith(true),
      loadError: null,
      sections: run,
      generatedAt: '2026-10-12T11:46:17.766Z',
    })
    const top = report.slice(0, report.indexOf('## What needs attention'))

    expect(top).toContain(`Build: revision ${REVISION}, version src-70cf746a7290, stamped yes`)
    expect(top).toContain('**OK** — ')
    for (const title of [
      'WebSocket',
      'Environment & setup',
      'Database & internal comms',
      'Account, space & requirements',
      'Browser',
    ]) {
      expect(top).toContain(`| ${title} | OK |`)
    }
    expect(top).toContain(`- Checks: ${CHECK_IDS.length} of ${CHECK_IDS.length} checks passed.`)
    expect(top).not.toContain('NOT WORKING** — ')
    // The census is one sentence in which each count owns its words.
    expect(top).toMatch(/- Evidence below: \d+ rows: \d+ carry a value · \d+ were asked for and nothing came back · /)
    expect(top).not.toContain('so there is nothing to wait for')
    // Not a single row of the five sections carries the old reading markers.
    expect(report).not.toMatch(/^- \[(v|\?|n)\] /m)
  })
})
