import { buildAccountSection, type AccountObservations } from './accountSection'
import { buildBackendSection } from './backendSection'
import { buildBrowserSection, type BrowserObservations } from './browserSection'
import {
  buildWitnessBoard,
  CHECK_IDS,
  describeMarkerCheck,
  readingsFrom,
  type CheckOutcome,
  type CheckReading,
} from './diagnosticChecks'
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
 * The captured compose payload, as the OPERATOR's deployment and the TAB's read
 * differ from the capture:
 *
 *   - the capture was taken over plain HTTP on loopback, so the session cookie is
 *     not Secure there. The operator's deployment is HTTPS behind a reverse proxy,
 *     where it is;
 *   - the capture was made with an HTTP-only read, which carries the page's origin.
 *     The tab reads through the app's ordinary helper, which rides the socket's
 *     control-plane lane when the socket is up — and that lane re-enters the
 *     gateway with no origin at all, so the gateway cannot say whether this
 *     client's origin would be admitted. That is the reading the operator saw.
 */
const { originAdmitted: _capturedOverHttp, ...admissionOverTheSocketLane } = COMPOSE_GRPC_DIAGNOSTICS.admission ?? {}
const AS_THE_TAB_READS_IT: SyncDiagnosticsPayload = {
  ...COMPOSE_GRPC_DIAGNOSTICS,
  runtime: { ...COMPOSE_GRPC_DIAGNOSTICS.runtime, cookieSecure: true },
  admission: admissionOverTheSocketLane,
}

const transport: TransportStatusInput = { state: 'READY', operations: [...NEGOTIATED_OPERATIONS] }

/** A ledger as the transport publishes it after one ordinary connect: no refusals, no fallbacks. */
const ledger: LaneLedgerSectionView = {
  controlPlaneRejections: 0,
  controlPlaneRejectionsByStatus: { 401: 0, 498: 0 },
  fallbackCounts: {},
  transitions: [
    { state: 'HALF_OPEN', socketPreserved: false, msSinceLedgerStart: 400 },
    { state: 'CONNECTING', socketPreserved: false, msSinceLedgerStart: 800 },
    { state: 'AUTHENTICATING', socketPreserved: false, msSinceLedgerStart: 1100 },
    { state: 'READY', socketPreserved: false, msSinceLedgerStart: 1300 },
  ],
  transitionsDropped: 0,
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
  // The reading the pane has today: the flags read lands and carries neither flag.
  flagReading: 'read-carried-no-flags',
}

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
          'control-plane': passed('control-plane', 'answered; API_RPC is negotiated, so the socket lane carries it'),
        }
      : {}),
  })

const sectionsFor = (
  payload: SyncDiagnosticsPayload,
  serverStatus: unknown,
  checks: readonly CheckReading[],
): Record<SectionId, SectionModel> => {
  const witnesses = buildWitnessBoard({
    checks,
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
      observations: account,
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
    // The capture itself DID carry the origin answer; the tab's read does not.
    expect(COMPOSE_GRPC_DIAGNOSTICS.admission?.originAdmitted).toBe(true)
    expect(AS_THE_TAB_READS_IT.admission?.originAdmitted).toBeUndefined()
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
  it('reads not-tested, and names the check, while the check that writes has not run', () => {
    const untested = everyRow(notRun).filter(({ row }) => row.verdict === 'untested')

    expect(labelsOf(untested)).toContain('websocket: Socket ticket')
    for (const { row } of untested) {
      expect(row.caveat).toContain('Not tested yet: ')
    }
    expect(notRun.websocket.worstVerdict).not.toBe('healthy')
    expect(BLOCKS_OK[triage({ sections: notRun }).sectionWorst]).toBe(true)
  })

  /**
   * *** WHAT STILL KEEPS THIS DEPLOYMENT OFF "OK" ONCE EVERY CHECK HAS PASSED —
   * NAMED, ROW BY ROW. ***
   *
   * Thirty-three capped rows used to read Unknown here for ever. Each row below
   * is one that is still unestablished, with the reason, and the list is asserted
   * EXACTLY: a row that starts blocking and is not written down here fails this
   * test, and so does a row that stops blocking and is left on the list. It is
   * the pane's remaining debt in one place, and it is meant to shrink — each
   * entry names the check that retires it.
   */
  const STILL_UNESTABLISHED: Record<string, string> = {
    'websocket: Reported fallback reason':
      'a READY socket has no fallback reason, and the row calls that a missing reading rather than nothing to report',
    'websocket: What that reason is worth': 'follows the row above',
    'websocket: This client’s origin admitted':
      'the pane’s read rides the socket lane, which carries no origin; needs an HTTP read of the admission block',
    'environment: Internal gRPC auth secret':
      'that the gateway and the syncing server hold the SAME secret; needs a sync that crosses the durable lane',
    'environment: WEBSOCKET_SYNC_FILES_URL': 'needs a file transfer over the socket lane',
    'environment: VALET_TOKEN_SECRET': 'needs an authorized file transfer',
    'backend: Database write probe': 'a zero-row write was accepted; needs a real write observed landing',
    'backend: Syncing server probe': 'needs an authorized sync round trip',
    'backend: Files service probe': 'needs an authorized file transfer',
    'backend: Revisions service probe': 'needs an authorized revisions read',
    'account: Live sync for this account': 'the flags read does not unwrap the gateway’s envelope',
    'account: Collaboration permitted for this account': 'the flags read does not unwrap the gateway’s envelope',
  }

  it('is kept off OK, once every check has passed, by exactly the rows it says it is', () => {
    const blocking = everyRow(run).filter(({ row }) => BLOCKS_OK[row.verdict])

    expect(labelsOf(blocking).sort()).toEqual(Object.keys(STILL_UNESTABLISHED).sort())
    // Every one of them is something this pane could not establish — none is a
    // fault, and none is a check left unrun.
    for (const { section, row } of blocking) {
      expect({ label: `${section}: ${row.label}`, verdict: row.verdict }).toEqual({
        label: `${section}: ${row.label}`,
        verdict: 'undetermined',
      })
    }
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
    expect(top).toContain('| Browser | OK |')
    expect(top).toContain(`- Checks: ${CHECK_IDS.length} of ${CHECK_IDS.length} checks passed.`)
    expect(top).not.toContain('NOT WORKING** — ')
    // The census is one sentence in which each count owns its words.
    expect(top).toMatch(/- Evidence below: \d+ rows: \d+ carry a value · \d+ were asked for and nothing came back · /)
    expect(top).not.toContain('so there is nothing to wait for')
    // Not a single row of the five sections carries the old reading markers.
    expect(report).not.toMatch(/^- \[(v|\?|n)\] /m)
  })
})
