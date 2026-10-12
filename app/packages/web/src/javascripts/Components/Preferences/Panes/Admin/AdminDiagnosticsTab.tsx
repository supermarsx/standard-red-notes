import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ContentType, isErrorResponse, PrefKey, SettingName } from '@standardnotes/snjs'
import { convertTimestampToMilliseconds } from '@standardnotes/utils'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import TabList from '@/Components/Tabs/TabList'
import Tab from '@/Components/Tabs/Tab'
import TabPanel from '@/Components/Tabs/TabPanel'
import { useTabState } from '@/Components/Tabs/useTabState'
import {
  describeDeployment,
  describeTransport,
  diagnose,
  type DiagnosticsReadFailure,
  type SyncDiagnosticsPayload,
  type TransportStatusInput,
} from './syncDiagnostics'
// The ONE copy of the three shared presentation primitives. They lived here as
// verbatim duplicates for the duration of the pane split — `diagnosticsPresentation.tsx`
// says so in its own header — and a duplicated exhaustive `Record` over a union
// that keeps gaining members needs hand-syncing every time one is added, which it
// has already needed twice, the second time leaving HEAD unable to typecheck.
// Imported rather than re-copied, and NOT re-exported: a re-export would leave
// this file looking like a second source of truth for `TONE_CHIP`, which is the
// drift hazard rather than a cure for it. The spec imports it from the module
// that defines it.
import { Chip, FindingCard, StatusChip } from './diagnosticsPresentation'
import {
  AUTO_CHECK_IDS,
  buildWitnessBoard,
  CHECKS,
  checkRow,
  describeControlPlaneRead,
  describeFileTransfer,
  describeMarkerCheck,
  describeRevisionsRead,
  describeSyncRound,
  readingsFrom,
  RUNNABLE_CHECK_IDS,
  summarizeChecks,
  type CheckId,
  type CheckOutcome,
  type RunnableCheckId,
} from './diagnosticChecks'
import {
  BLOCKS_OK,
  describeVerdictCensus,
  safeConstant,
  safeCount,
  safeTokens,
  SECTION_IDS,
  SECTION_TITLE,
  VERDICT_CHIP_LABEL,
  type SectionId,
  type SectionModel,
  type Verdict,
} from './diagnosticsSections'
import DiagnosticsSection from './DiagnosticsSection'
import { runFileTransferCheck, type FileTransferResult } from './diagnosticFileTransfer'
import { fileTransferPortFor, readRevisionsOfOneNote, runSyncRound } from './diagnosticRunners'
import { COVERAGE_SENTENCE, OVERALL_SENTENCE, rankFindings, SOURCE_JOIN, triage } from './diagnosticsTriage'
import {
  buildWebsocketSection,
  describeLiveSocketCheck,
  socketFallbackIsDeferred,
  type LaneLedgerSectionView,
} from './websocketSection'
import { buildEnvironmentSection } from './environmentSection'
import { buildBackendSection } from './backendSection'
import {
  buildAccountSection,
  type AccountFlagReading,
  type AccountObservations,
  type SpaceFigureSource,
  type ItemUsageReading,
} from './accountSection'
import {
  buildBrowserSection,
  observeBrowserCapabilities,
  type BrowserClockReading,
  type BrowserObservations,
  type BrowserRuntime,
} from './browserSection'
import { buildDiagnosticsReport, buildDiagnosticsSummary, describeCaptureInstant } from './diagnosticsReport'
import { admitToken, DEPLOY_REVISION, VERSION_TOKEN } from './reportAllowlist'
import { estimateStorage } from '@/Utils/StorageQuota'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

/**
 * One reading of this account's server-side space figures.
 *
 * `source` is the closed value the Account section needs in order to tell a read
 * that THREW from one that answered carrying nothing from one nobody attempted;
 * the two byte counts are present only when the server carried them. Both figures
 * absent with `read-carried-no-figure` is the ordinary description of an account
 * that has never uploaded a file, and is not a fault.
 */
/**
 * One reading of this account's own per-account feature flags.
 *
 * *** THE ENDPOINT WAS ALWAYS THERE AND THIS TAB NEVER ASKED. ***
 * `LIVE_SYNC_ENABLED` and `COLLABORATION_ENABLED` are answered by
 * `GET /v1/admin/users/:userUuid/feature-flags` — the route the admin Users tab
 * has always read — and the Account section printed "no endpoint publishes this"
 * over both because nothing here fetched it. That constant is reserved for a
 * field with NO producer, and using it for one with a producer closes a question
 * that should have stayed open.
 *
 * The booleans are EFFECTIVE, resolved here rather than in the section: the
 * endpoint reports an unset flag as `null`, and the server reads that as enabled
 * (`CreateCrossServiceToken.readGatingFlag` returns `true` for an absent setting
 * and `false` only for the literal string `'false'`). Applying that rule at the
 * boundary is what lets the section treat "absent" as "the read did not land",
 * which is the only thing it can honestly say about an empty row.
 *
 * `reading` carries WHY a flag is absent, and the member that earns the field is
 * `admin-required`: the endpoint answers 403 to a non-admin session, which is a
 * property of the surface and not a fault in the deployment or the account.
 */
type AccountFlagsReading = {
  reading: AccountFlagReading
  liveSync?: boolean
  collaboration?: boolean
}

/**
 * One reading of this account's STORED ITEM BYTES — the notes, which are the
 * larger half of most accounts' storage and which this pane reported nothing
 * about at all until now.
 *
 * `reading` is the closed value the Account section needs in order to tell a
 * server that does not carry the route (an ordinary state mid-upgrade, and the
 * answer to "would a redeploy fix this") from a read that never arrived from one
 * nobody attempted. `bytes` is present only on a 200, and `complete` is the
 * server's two item counts reduced to the one boolean the section is allowed to
 * see: how many items a person keeps is a fact about that person.
 */
type AccountItemUsageReading = {
  reading: ItemUsageReading
  bytes?: number
  complete?: boolean
}

type AccountSpaceReading = {
  source: SpaceFigureSource
  used?: number
  limit?: number
  /**
   * Standard Red Notes: where the ALLOWANCE came from, as the server's own closed
   * enum. Carried raw and admitted by the Account section rather than narrowed
   * here, so an unrecognised origin reaches one place that knows how to collapse
   * it instead of being silently dropped on the way in.
   */
  limitOrigin?: string
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What the summary says about a section
 * that raised NO finding and has no single row to name, per worst verdict.
 *
 * A single sentence for all of them would have to be either reassuring or
 * alarming, and both are wrong half the time: a section with no findings and a
 * `healthy` worst verdict read everything it needed, while one whose worst is
 * `undetermined` is missing a reading. Those are the two states this whole pane
 * exists to keep apart, so the summary does not collapse them into "nothing to
 * report".
 */
const SECTION_NO_FINDING: Record<Verdict, string> = {
  healthy: 'Everything this section read is working.',
  degraded: 'At least one row in this section is degraded.',
  broken: 'At least one row in this section reads as not working.',
  undetermined:
    'At least one reading in this section did not arrive, so no verdict is claimed for it. That is NOT the same as everything being fine.',
  untested: 'Nothing read here is wrong; at least one check in this section has not been run.',
  'not-applicable': 'Nothing in this section applies here.',
  informational: 'This section carries context only — nothing in it is a verdict.',
}

/**
 * The ONE line the summary prints beside a section: why it has the status it has.
 *
 * In order of usefulness. A finding at the section's worst verdict is the answer
 * outright, and its title is one sentence by construction. Failing that, the rows
 * that carry the worst verdict are NAMED — "Not tested: Socket ticket" tells a
 * reader what to press, where "this section could not establish its facts" told
 * them nothing and was the only thing this line used to say. The generic sentence
 * is the last resort, for a verdict no row and no finding accounts for.
 *
 * Only a verdict that keeps the section off OK is worth naming rows for: a section
 * whose worst is `healthy` has dozens of rows at that verdict and no reader wants
 * the first of them.
 */
export function sectionReason(model: SectionModel): string {
  const worst = model.worstVerdict
  if (model.headline !== undefined && model.headline.verdict === worst) {
    return model.headline.title
  }
  if (!BLOCKS_OK[worst]) {
    return SECTION_NO_FINDING[worst]
  }

  const rows = model.blocks.flatMap((block) => block.rows.filter((row) => row.verdict === worst))
  if (rows.length === 0) {
    return SECTION_NO_FINDING[worst]
  }

  return `${VERDICT_CHIP_LABEL[worst]}: ${rows[0].label}${rows.length > 1 ? `, and ${rows.length - 1} more` : ''}`
}

/**
 * How far a run has got.
 *
 * `current` is the check being run right now, so its own row and its own control
 * can say so; `done` and `total` are what "Running 2 of 3" is built from.
 */
export type CheckProgress = { readonly done: number; readonly total: number; readonly current: CheckId }

/** What a check runner returns. The id is added by the one loop that calls it. */
type CheckFinding = Omit<CheckOutcome, 'id'>

/** A request that threw before any answer arrived. Closed copy; the message stays on screen. */
const REQUEST_DID_NOT_COMPLETE = safeConstant('the request did not complete')

const requestThrew = (error: unknown): CheckFinding => ({
  state: 'fail',
  result: REQUEST_DID_NOT_COMPLETE,
  detail: `The request threw before an answer arrived: ${String(error)}.`,
})

/** An HTTP status as a closed result: a literal of this build and a bounded count. */
const answeredStatus = (status: number): CheckFinding['result'] =>
  safeTokens(safeConstant('answered HTTP'), safeCount(status))

/**
 * A short, valid device identifier for the ticket probe. Deliberately NOT the
 * client's real sync device id: a probe must never disturb the device the live
 * socket is registered under, and a distinct id makes the mint attributable in
 * the gateway's logs.
 */
const probeDeviceId = (): string => `admin-diagnostic-probe-${Math.random().toString(36).slice(2, 10)}`

/**
 * The sub-tab id for a section. Derived from the section id so the strip, the
 * panel and the router's "Open" control cannot disagree about where a section
 * lives — and PREFIXED, because `Tab` renders `tab-control-<id>` as a DOM id and
 * this list is nested inside the Admin shell's own tab list. An unprefixed
 * `browser` or `account` here would collide with a same-named top-level tab and
 * break both.
 */
const sectionTabId = (id: SectionId): string => `diag-${id}`

/**
 * The sub-tab strip. The five topic sections come from `SECTION_IDS` and their
 * titles from `SECTION_TITLE`, so a section cannot be added to the contract and
 * left off the screen — the defect this integration step exists to fix, in which
 * five finished section models were reachable only from their own specs.
 *
 * Overview, Checks and Copyable report are not topic sections and are listed
 * explicitly: Overview is a router over the five, Checks is the single place a
 * run that mints a real server-side ticket can be started, and the report is an
 * output of all of them.
 *
 * NO ICONS. An `Icon` whose `type` is missing from `IconNameToSvgMapping.ts`
 * renders its own name as literal text, and tsc and any `Icon`-mocking spec are
 * both blind to it. Nothing in this pane imports `Icon`, and the spec asserts the
 * whole rendered pane emits zero `svg` elements, so that hazard cannot enter here
 * without a test failing first.
 */
const DIAGNOSTIC_SUBTABS: { id: string; title: string }[] = [
  { id: 'diag-overview', title: 'Overview' },
  ...SECTION_IDS.map((id) => ({ id: sectionTabId(id), title: SECTION_TITLE[id] as string })),
  { id: 'diag-checks', title: 'Checks' },
  { id: 'diag-report', title: 'Copyable report' },
]

/**
 * The clock reading the Browser section needs, or nothing at all.
 *
 * BOTH halves are required and neither is invented. `serverCapturedAtMs` is
 * parsed from the payload's own `capturedAt` and `localReceivedAtMs` is
 * `Date.now()` at the instant that payload ARRIVED — not at render time, which
 * would measure the age of the payload as much as the skew of the clock.
 *
 * An absent, non-string or unparseable `capturedAt` yields `undefined`, so the
 * clock rows read "not reported". It deliberately does NOT fall back to zero or
 * to the current instant: a zero would read as a 56-year skew and a `Date.now()`
 * on both sides would read as perfect alignment, and both are the panel
 * inventing a measurement it never made.
 */
export const clockReadingFor = (
  capturedAt: string | undefined,
  localReceivedAtMs: number,
): BrowserClockReading | undefined => {
  if (typeof capturedAt !== 'string') {
    return undefined
  }

  const serverCapturedAtMs = Date.parse(capturedAt)

  return Number.isFinite(serverCapturedAtMs) ? { serverCapturedAtMs, localReceivedAtMs } : undefined
}

/**
 * The injected runtime the Browser section reads.
 *
 * `globalThis` is handed over as a whole rather than copied field by field, and
 * that is the point: assigning it to this type READS NOTHING. Every property
 * access happens later, inside `observeBrowserCapabilities`, where each one is
 * individually contained — and several of them throw rather than return a value
 * (`localStorage` in a cookie-blocked profile is the common case). Copying the
 * fields here would move those throws into the composition root, which is the one
 * place with nothing to catch them.
 *
 * There is no cast. If the shape the section declares and the shape the DOM lib
 * provides ever disagree, this line fails to compile instead of silently handing
 * over an object the section cannot read.
 */
const injectedBrowserRuntime = (): BrowserRuntime => globalThis

/** Read one ambient fact, or report nothing. A thrown read is never a `false`. */
const observed = <T,>(read: () => T): T | undefined => {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Standard Red Notes: admin capability diagnostics.
 *
 * This tab exists because the deployment could not answer basic questions about
 * itself. `/v1/sockets/sync/capabilities` returned an empty list, `POST /ticket`
 * returned `503 SYNC_DISABLED`, everything silently ran over HTTP, and the only
 * clue in the logs was "durable backend and shared Redis state are required" —
 * which never says which of the two is missing. Answering it meant reading the
 * gateway's boot file line by line against the running environment.
 *
 * It now answers five things: what transport am I on, what is advertised, what is
 * broken, WHAT DO I DO ABOUT IT, and what can I hand to someone else. The fourth
 * is the hard one and the reason for `diagnosticRemedies.ts`: the correct action
 * depends on the deployment's topology, and the stock advice for the condition
 * this deployment actually hit — "configure SYNCING_SERVER_GRPC_URL" — was wrong,
 * because the variable was already set and was never being read.
 *
 * THE STRUCTURE. Five topic sections, each a pure model builder rendered by the
 * one generic `DiagnosticsSection`, plus three tabs that are not topics:
 *
 *   - Overview is a ROUTER. One row per section showing that section's own worst
 *     verdict, so an operator arriving mid-incident knows which tab to open
 *     instead of reading five of them. The verdict is never computed here: it is
 *     the `worstVerdict` the section model derived from its own rows and
 *     findings, so the router cannot be reassuring about a section that is not.
 *   - Checks is the ONLY tab that probes. One of its probes mints a real
 *     server-side ticket, and that consent paragraph must appear exactly once
 *     rather than on six tabs; sections render the results read-only, tagged by
 *     `outcomesForSection`.
 *   - Copyable report covers all five sections, because a report that silently
 *     omits one is worse than no report.
 *
 * SECURITY: the server endpoint behind this reports configuration PRESENCE only
 * and is admin-gated server-side (403 for anyone without the admin role). No
 * value, URL, host or secret is transported, and nothing here may start doing so.
 * The copyable report is written to be pasted somewhere public and holds the same
 * line — see diagnosticsReport.ts and `SafeValue` in diagnosticsSections.ts.
 */
const AdminDiagnosticsTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [payload, setPayload] = useState<SyncDiagnosticsPayload | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  /**
   * The read failure itself, not just its sentence. The status is in hand right
   * here at the call site, and the diagnosis needs it: 401, 403 and 404 exclude
   * each other on this endpoint, so one catch-all remedy is wrong for at least
   * two of them. Held as a distinct state from `loadError` — which is the red
   * line under the chips — and left `undefined` while nothing has failed, so
   * "not read yet" stays distinguishable from "the read failed".
   */
  const [readFailure, setReadFailure] = useState<DiagnosticsReadFailure | undefined>(undefined)
  const [deployment, setDeployment] = useState<unknown>(undefined)
  /**
   * Whether the marker fetch itself landed. Held beside `deployment` because that
   * state is `{}` both for a marker that answered empty and for one that could
   * not be fetched, and the `marker` check must not call the second "unstamped".
   */
  const [markerRead, setMarkerRead] = useState<'answered' | 'failed' | undefined>(undefined)
  /**
   * What each RUN check found, keyed by its id. A check that has not run has no
   * entry — never a placeholder — which is what makes its row read "not tested".
   */
  const [outcomes, setOutcomes] = useState<Partial<Record<CheckId, CheckOutcome>>>({})
  /**
   * The last file round trip, as the closed facts it returned.
   *
   * Kept beside the check's worded outcome because a row in ANOTHER section
   * rests on half of it: whether the socket's file lane returned the object is
   * what settles `WEBSOCKET_SYNC_FILES_URL`, and that is not recoverable from a
   * sentence.
   */
  const [fileTransfer, setFileTransfer] = useState<FileTransferResult | undefined>(undefined)
  /**
   * How far the run in flight has got, or `null` when idle.
   *
   * It carries WHICH check is running and how many are done, so the button can
   * say "Running 2 of 3" and the row being run can say so too. A boolean could
   * express neither, and a run that mints a ticket should not be a spinner.
   */
  const [progress, setProgress] = useState<CheckProgress | null>(null)
  /** Guards re-entry without waiting for a render: two clicks must not start two runs. */
  const runInFlight = useRef(false)
  /**
   * Which copy button last succeeded, so the confirmation sits beside the button
   * that was pressed. A single boolean put "Copied" next to both.
   */
  const [copied, setCopied] = useState<'report' | 'summary' | null>(null)
  /**
   * The clock reading, captured where BOTH halves are known: the server's own
   * capture instant off the payload, and the local instant that payload arrived.
   * Nothing else in this pane can produce it, and nothing invents one.
   */
  const [clock, setClock] = useState<BrowserClockReading | undefined>(undefined)
  /** The `/v1/admin/server-status` body the Database section reads. */
  const [serverStatus, setServerStatus] = useState<unknown>(undefined)
  const [statusError, setStatusError] = useState<string | null>(null)
  /** Absent until the first collection run resolves; every Browser row then reads "not reported". */
  const [browserObservations, setBrowserObservations] = useState<BrowserObservations | undefined>(undefined)
  /**
   * This account's space figures, and WHY they are absent when they are.
   *
   * `undefined` while the read is in flight, so the Space block says neither kind of
   * empty before it knows which — an in-flight read reported as "nobody asked" would
   * be the same conflation the block's finding exists to end, one frame early.
   */
  const [spaceReading, setSpaceReading] = useState<AccountSpaceReading | undefined>(undefined)
  /**
   * This account's stored-item total, and WHY it is absent when it is.
   * `undefined` while the read is in flight, for the same reason as
   * `spaceReading`: an in-flight read reported as "nobody asked" is a claim.
   */
  const [itemUsage, setItemUsage] = useState<AccountItemUsageReading | undefined>(undefined)
  /**
   * The origin's own storage usage in BYTES, for the soft-cap comparison.
   *
   * *** THE FIELD THE SECTION DECLARED AND NOTHING EVER SUPPLIED. *** The Account
   * section has carried `localUsageBytes` and a row comparing it against the
   * user's advisory cap since the block was written, and no caller has ever filled
   * it — so that row read "not reported" on every deployment while the row above
   * it reported the cap perfectly. The Browser section's own collection run
   * already calls `navigator.storage.estimate()`, but it reduces the answer to a
   * share of quota and a whole-gigabyte quota before anything else can see it, and
   * that section is not this one's to widen. So the estimate is taken here too,
   * through the app's own helper, which answers `undefined` on a browser with no
   * StorageManager and on a call that throws — both of which must stay absent
   * rather than arriving as a flattering zero.
   */
  const [localUsageBytes, setLocalUsageBytes] = useState<number | undefined>(undefined)
  /**
   * This account's per-account feature flags, and WHY they are absent when they
   * are. `undefined` while the read is in flight, for the same reason as
   * `spaceReading`: an in-flight read reported as "nobody asked" is a claim.
   */
  const [flagsReading, setFlagsReading] = useState<AccountFlagsReading | undefined>(undefined)

  const tabState = useTabState({ defaultTab: 'diag-overview' })
  const { setActiveTab } = tabState

  // The transport state is read live rather than cached: the question this tab
  // answers is "what am I on RIGHT NOW", and a value captured at mount would be
  // wrong within seconds of a reconnect.
  const [transport, setTransport] = useState<TransportStatusInput | undefined>(undefined)
  // The ledger rides the SAME poll, and is read off the same accessor pattern: it
  // is the history half of the question that row answers, and two readings taken a
  // tick apart would let the block disagree with the row above it.
  const [ledger, setLedger] = useState<LaneLedgerSectionView | undefined>(undefined)
  const readTransport = useCallback(() => {
    const status = application.syncTransportStatus
    setTransport(status ? { ...status, operations: [...status.operations] } : undefined)
    // Passed through RAW, with no `?? {}` and no zeroed stand-in. A client with no
    // realtime transport installed has no ledger, and the block says so in its own
    // sentence; a fabricated empty one would claim this client watched the lane and
    // saw nothing happen, which is a different and much stronger statement.
    setLedger(application.syncTransportLedger)
  }, [application])

  useEffect(() => {
    readTransport()
    const timer = setInterval(readTransport, 2000)
    return () => clearInterval(timer)
  }, [readTransport])

  const loadDiagnostics = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setReadFailure(undefined)
    try {
      /**
       * *** PLAIN HTTP, AND NOT THE HELPER THE REST OF THE APP USES. ***
       *
       * `serverGetJsonRequest` prefers the socket's control-plane lane, and a
       * request that rides it reaches the gateway over its own loopback with no
       * `Origin` and no `Referer`. The admission block is computed from exactly
       * those two headers — so "This client's origin admitted" read "not
       * reported" on every deployment whose socket was healthy, which is the
       * one case where the answer is a plain yes. Measured on both topologies:
       * the same endpoint over HTTP answers `originAdmitted: true`.
       *
       * It is also the right lane on principle. This read is the pane; a pane
       * that goes blank when the socket's control-plane lane is stranded cannot
       * report that it is. Whether THAT lane works is the control-plane check's
       * question, and it asks it separately, on purpose.
       */
      const response = await application.httpOnlyJsonRequest<SyncDiagnosticsPayload>(
        'GET',
        '/v1/admin/sync-diagnostics',
      )
      if (!response.ok) {
        noteIfForbidden(response)
        setPayload(undefined)
        setClock(undefined)
        setReadFailure({ status: response.status })
        setLoadError(
          response.status === 404
            ? 'This server build does not have the sync diagnostics endpoint yet.'
            : `The server answered ${response.status} for the diagnostics endpoint.`,
        )
        return
      }
      // The local instant is taken HERE, at arrival, and never at render: see
      // `clockReadingFor`. One response's travel time is immaterial at the
      // threshold the Browser section uses; the age of a cached payload is not.
      const localReceivedAtMs = Date.now()
      setPayload(response.data)
      setClock(clockReadingFor(response.data?.capturedAt, localReceivedAtMs))
    } catch (error) {
      console.error(error)
      // No status: the request never completed, which is a different fact from
      // any status the server could have sent, and gets its own guidance.
      setReadFailure({})
      setClock(undefined)
      setLoadError('Could not reach the sync diagnostics endpoint.')
    } finally {
      setLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadDeployment = useCallback(async () => {
    try {
      // Same-origin static marker, served beside the web bundle rather than by
      // the api-gateway, so it is fetched directly rather than through the
      // authenticated helpers.
      const response = await fetch('/.well-known/srn-deployment.json', { headers: { Accept: 'application/json' } })
      setDeployment(response.ok ? await response.json() : {})
      setMarkerRead(response.ok ? 'answered' : 'failed')
    } catch {
      setDeployment({})
      setMarkerRead('failed')
    }
  }, [])

  /**
   * The server-status read the Database & internal comms section needs.
   *
   * The SAME endpoint and the SAME client method the Server pane uses
   * (`legacyApi.adminGetServerStatus`), read ADDITIVELY: nothing is migrated out
   * of that pane, no new route is introduced, and this section restates none of
   * its readout — it reads the handful of fields the Server pane does not
   * interpret (connection state, cache answerability, per-service outcomes) by
   * allowlist. An inactive `TabPanel` is unmounted, so the Server pane's own copy
   * of this payload does not exist while Diagnostics is open and cannot be shared
   * without lifting state into the Admin shell, which this change does not own.
   *
   * The failure is kept as a MESSAGE carrying the status rather than a code
   * because `backendSection` reduces it with `healthReport.ts`'s `errorKind`, so
   * the Server pane's report and this section cannot come to disagree about why
   * the endpoint did not answer.
   */
  const loadServerStatus = useCallback(async () => {
    setStatusError(null)
    try {
      const response = await application.legacyApi.adminGetServerStatus()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setServerStatus(undefined)
        setStatusError(
          `The server answered ${response.status ?? 'an error'} for the server status endpoint, so nothing below could be read.`,
        )
        return
      }
      setServerStatus((response as { data?: unknown }).data)
    } catch (error) {
      console.error(error)
      setServerStatus(undefined)
      setStatusError('Could not reach the server status endpoint.')
    }
  }, [application, noteIfForbidden])

  useEffect(() => {
    void loadDiagnostics()
    void loadDeployment()
    void loadServerStatus()
  }, [loadDiagnostics, loadDeployment, loadServerStatus])

  /**
   * This account's own server-side space figures, read on mount.
   *
   * *** A SELF-SCOPED SURFACE DOES EXIST, AND THIS PANE WRONGLY CONCLUDED IT DID
   * NOT. *** The Space block read "not reported" on every deployment because the
   * tab supplied no space fields at all, and the reason recorded for that was that
   * the only reader of these two numbers was the admin Users tab, which reaches
   * them by USER ID — and no identifier may enter this pane. That was wrong about
   * the surface: `settings.getSubscriptionSetting` answers for the REQUESTING
   * SESSION, carries no identifier in either direction, and the account's own
   * Files preferences pane has always used it. So the block can report, and does.
   *
   * THREE OUTCOMES, kept apart, because the whole point of the Space block's
   * finding is that the kinds of empty must not render alike:
   *   - figures arrive          -> the rows carry them, no finding
   *   - the read THREW          -> `read-threw`, and the emptiness is a symptom
   *   - the read ANSWERED none  -> `read-carried-no-figure`, which is an ordinary
   *     state on this fork and emphatically not a failure.
   *
   * *** THE THIRD CASE USED TO REPORT AS THE SECOND, AND THAT WAS A FALSE ALARM
   * ON EVERY ACCOUNT THAT HAD NEVER UPLOADED A FILE. *** The previous version of
   * this comment argued the merge was correct — "still a read that did not produce
   * one" — and the Space block rated it `broken`. It is not one read with two
   * finishes; it is two different answers:
   *
   *   - `FILE_UPLOAD_BYTES_USED` has no row until an upload succeeds. Auth's
   *     `GetSubscriptionSetting` fails for a missing row, the controller answers
   *     400, and `SettingsGateway` maps 400 to `undefined` WITHOUT throwing.
   *   - With no subscription row at all the same controller answers
   *     `200 {success: true, setting: undefined}` deliberately, so that "clients
   *     treat it as 'no usage data' rather than surfacing a request error".
   *
   * Both of those are an ANSWER. Only a rejected promise is not, and only that is
   * reported as a failed read now.
   *
   * *** AND THE SERVER NOW ANSWERS THE ALLOWANCE EVEN WITH NO ROW TO READ IT
   * FROM. *** An absent FILE_UPLOAD_BYTES_LIMIT was never an absent allowance —
   * `CreateValetToken` falls back to the plan default, and to unlimited where there
   * is no live subscription — so auth derives that EFFECTIVE figure and sends its
   * provenance alongside it. The USAGE total is still never derived: a fabricated
   * zero would make a lost bookkeeping write unobservable, which is the one thing
   * the Space block's degraded finding exists to see. So "the allowance arrived and
   * the usage did not" is now an ordinary reading, and the Account section keys its
   * findings on the figure each one is about rather than on both being absent.
   *
   * The two settings are also read INDEPENDENTLY rather than in sequence. They
   * were awaited one after the other in a single `try`, so a throw on the usage
   * read discarded the allowance read that had not happened yet — one failure
   * erasing an unrelated figure, and making "both absent" look like one verdict
   * about both. `allSettled` keeps each answer with its own outcome; the source is
   * the WORST of the two, because a throw anywhere is a failed read.
   *
   * Only bytes cross this boundary: each setting is parsed to a finite
   * non-negative number and the string is discarded, so no server text can reach a
   * row even though these settings are free-form on the wire. The rows reduce the
   * numbers to buckets and whole megabytes, as they already did.
   */
  useEffect(() => {
    let cancelled = false

    /**
     * `async`, and the setting NAME is resolved inside it rather than at the call
     * site, so every throw on this path — including one from `SettingName` itself
     * — becomes a rejected promise instead of an exception thrown out of the
     * effect. Reading `SettingName.NAMES` in the argument list took the whole tab
     * down on a host where that namespace was not available, which is the shape
     * of defect this pane least affords: the screen that explains a broken
     * deployment must not be the screen that cannot render on one.
     */
    /**
     * *** `>= 0` DISCARDED THE ONE VALUE THAT MEANS UNLIMITED. ***
     *
     * This predicate was `Number.isFinite(parsed) && parsed >= 0`, and `-1` is the
     * ONLY value the files server treats as unlimited — so the commonest allowance
     * on this fork was parsed, recognised as a number, and then thrown away as if
     * the server had said nothing. The Account section already handles `-1` as its
     * own state and its own printed value; what it could not do was handle a figure
     * it was never given. The floor is now `-1`: anything below it is not a
     * sentinel this build knows and is still refused rather than rendered.
     */
    const readFigure = async (
      pick: 'FileUploadBytesUsed' | 'FileUploadBytesLimit',
    ): Promise<{ value?: number; origin?: string }> => {
      const name = SettingName.create(SettingName.NAMES[pick]).getValue()
      const detail = await application.settings.getSubscriptionSettingDetail(name)
      const parsed = typeof detail.value === 'string' ? Number.parseFloat(detail.value) : Number.NaN

      return {
        ...(Number.isFinite(parsed) && parsed >= -1 ? { value: parsed } : {}),
        ...(detail.origin === undefined ? {} : { origin: detail.origin }),
      }
    }

    const figureOf = (
      settled: PromiseSettledResult<{ value?: number; origin?: string }>,
    ): { value?: number; origin?: string } => {
      return settled.status === 'fulfilled' ? settled.value : {}
    }

    void Promise.allSettled([readFigure('FileUploadBytesUsed'), readFigure('FileUploadBytesLimit')]).then((settled) => {
      if (cancelled) {
        return
      }

      const used = figureOf(settled[0]).value
      const allowance = figureOf(settled[1])
      const threw = settled.some((result) => result.status === 'rejected')

      setSpaceReading({
        source: threw ? 'read-threw' : 'read-carried-no-figure',
        ...(used === undefined ? {} : { used }),
        ...(allowance.value === undefined ? {} : { limit: allowance.value }),
        ...(allowance.origin === undefined ? {} : { limitOrigin: allowance.origin }),
      })
    })

    return () => {
      cancelled = true
    }
  }, [application])

  /**
   * This account's STORED ITEM BYTES, read on mount.
   *
   * *** THIS IS THE FIGURE THE OPERATOR ASKED FOR. *** The Space block reported
   * uploaded-FILE bytes and nothing else, so an account whose storage is notes —
   * which is most accounts — read "0 MB" at best and "not reported" at worst. The
   * notes are the storage. `GET /v1/items/storage-usage` answers them from the
   * item table itself, scoped to the requesting session and carrying no account
   * identifier in either direction.
   *
   * *** 404 IS NOT A FAILURE AND IS NOT MERGED WITH ONE. *** A deployment that
   * predates the route answers 404, and that is the commonest reading while a
   * fleet is being upgraded. Reported as `endpoint-absent`, which the Space block
   * renders as "not answered by this server build" and explains in its own
   * finding, because sending that operator to debug their syncing service is a
   * guaranteed dead end — the answer is a redeploy, and the first read after one
   * is already correct for everything stored before it.
   *
   * Only NUMBERS cross this boundary, and the two item COUNTS are reduced to one
   * boolean here rather than passed on: the section has nowhere to put a
   * population and must not acquire one. `itemsUnmeasured` is what makes the
   * total a floor, and `complete` is the whole of what the rows need to say so.
   */
  useEffect(() => {
    let cancelled = false

    type StorageUsageBody = { itemBytesUsed?: unknown; itemsMeasured?: unknown; itemsUnmeasured?: unknown }

    const read = async (): Promise<AccountItemUsageReading> => {
      /**
       * *** `httpOnlyJsonRequest`, AND THE ORDINARY HELPER CANNOT BE USED HERE. ***
       *
       * `serverGetJsonRequest` tries the websocket control-plane lane first, and
       * `/v1/items` is a forbidden FAMILY on that lane by design: durable item sync
       * owns its own idempotency and must never be re-entered over the transport it
       * established. The refusal arrives as an error the transport worker marks
       * unsafe to fall back from, so it is re-thrown rather than retried over HTTP —
       * and this pane then reported "the read did not arrive" for a route that
       * answered perfectly over HTTP. Measured live on a single container.
       *
       * Mounting the figure OUTSIDE the family was tried and is worse: the lane then
       * accepts the path, re-enters the gateway over its own loopback, and the
       * request stalls until the 30-second RPC deadline before failing the same way.
       * Also measured live.
       *
       * So this read goes straight to HTTP, through the helper this codebase already
       * keeps for the case — the socket-handshake probes in this very tab use it for
       * the same reason, and its own comment records why. HTTP is the correct lane
       * for a diagnostic read regardless: a figure that is wrong exactly when the
       * socket is healthiest is worse than no figure.
       */
      const response = await application.httpOnlyJsonRequest<StorageUsageBody & { data?: StorageUsageBody }>(
        'GET',
        '/v1/items/storage-usage',
      )

      if (response.status === 404) {
        return { reading: 'endpoint-absent' }
      }
      if (!response.ok) {
        return { reading: 'read-threw' }
      }

      /**
       * *** THE GATEWAY WRAPS EVERY PROXIED SERVICE RESPONSE. *** Both the HTTP
       * proxy and the single-container direct-call proxy send
       * `{ meta: {...}, data: <the service's body> }`, and `serverGetJsonRequest`
       * hands back the whole thing — the admin endpoints this tab also reads are
       * answered BY the gateway and are not wrapped, which is why the difference
       * is easy to miss. Read through the envelope when there is one and off the
       * body when there is not, so neither topology nor a future unwrapping
       * silently turns a real figure into "the read did not arrive".
       */
      const body: StorageUsageBody =
        response.data?.data !== undefined && response.data?.data !== null ? response.data.data : (response.data ?? {})

      const bytes = body.itemBytesUsed
      const unmeasured = body.itemsUnmeasured
      // A 200 whose body carries no usable figure is still a read that did not
      // produce one. It reports `read-threw` rather than `reported` with an empty
      // figure, because "the server answered and said nothing" on THIS endpoint is
      // not an ordinary state the way it is for the file settings: the route
      // either computes the sum or it does not exist.
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
        return { reading: 'read-threw' }
      }

      return {
        reading: 'reported',
        bytes,
        // ABSENT rather than `true` when the server did not send the count: a
        // fabricated "every item measured" would present a floor as a measurement,
        // which is the flattering direction and therefore the dangerous one.
        ...(typeof unmeasured === 'number' && Number.isFinite(unmeasured) && unmeasured >= 0
          ? { complete: unmeasured === 0 }
          : {}),
      }
    }

    void read()
      .catch((): AccountItemUsageReading => ({ reading: 'read-threw' }))
      .then((result) => {
        if (!cancelled) {
          setItemUsage(result)
        }
      })

    return () => {
      cancelled = true
    }
  }, [application])

  /**
   * The origin's own storage usage, for the soft-cap row that has never had a
   * figure to compare against.
   *
   * `estimateStorage` answers `undefined` for a browser with no StorageManager and
   * for a call that throws, and both of those must stay ABSENT: a zero here would
   * read as "this device is storing nothing" and would put the soft-cap row on
   * "within the cap" for a machine nobody measured.
   */
  useEffect(() => {
    let cancelled = false

    void estimateStorage()
      .catch(() => undefined)
      .then((estimate) => {
        if (cancelled || estimate === undefined) {
          return
        }
        const usage = estimate.usage
        if (typeof usage === 'number' && Number.isFinite(usage) && usage >= 0) {
          setLocalUsageBytes(usage)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * This account's own per-account feature flags, read on mount.
   *
   * ADMIN-GATED, and that is handled as a state rather than as an error: a 403
   * means this session may not read its own flags, which is the ordinary condition
   * for every non-admin user and says nothing about whether the flags are on. It
   * is reported as `admin-required` so the rows can word it, and no verdict is
   * claimed from it.
   *
   * The user uuid goes in the REQUEST PATH, exactly as the subscription-setting
   * reads above put it there, and nothing carrying it crosses into the Account
   * section — two booleans and one closed reading do. A session with no user at
   * all cannot form the request, which is `not-attempted` rather than a failure.
   *
   * Only `'false'` disables, because that is the server's own rule; every other
   * value, `null` included, is enabled. Reading it the other way round would
   * report a perfectly healthy default-on account as switched off.
   */
  useEffect(() => {
    let cancelled = false

    const readFlags = async (): Promise<AccountFlagsReading> => {
      const userUuid = observed(() => application.sessions.getUser()?.uuid)
      if (userUuid === undefined) {
        return { reading: 'not-attempted' }
      }

      type FlagsBody = { flags?: Record<string, string | null> }

      const response = await application.serverGetJsonRequest<FlagsBody & { data?: FlagsBody }>(
        `/v1/admin/users/${encodeURIComponent(userUuid)}/feature-flags`,
      )
      if (!response.ok) {
        return { reading: response.status === 403 ? 'admin-required' : 'read-threw' }
      }

      /**
       * *** THE GATEWAY WRAPS THIS ONE. *** The route is proxied to the auth
       * service, so the body arrives as `{ meta, data: { flags } }` — and this
       * read looked for `flags` at the top, found nothing, and reported "the
       * read carried no flags" on every deployment. "Live sync for this
       * account" and "Collaboration permitted" were unanswered for that reason
       * alone. Read through the envelope when there is one and off the body
       * when there is not, exactly as the storage-usage read above does.
       */
      const flags = (response.data?.data ?? response.data)?.flags
      if (flags === undefined || flags === null || typeof flags !== 'object') {
        return { reading: 'read-carried-no-flags' }
      }

      const effective = (name: string): boolean | undefined => (name in flags ? flags[name] !== 'false' : undefined)

      const liveSync = effective('LIVE_SYNC_ENABLED')
      const collaboration = effective('COLLABORATION_ENABLED')

      return {
        reading: 'read-carried-no-flags',
        ...(liveSync === undefined ? {} : { liveSync }),
        ...(collaboration === undefined ? {} : { collaboration }),
      }
    }

    readFlags().then(
      (result) => {
        if (!cancelled) {
          setFlagsReading(result)
        }
      },
      (error: unknown) => {
        console.error(error)
        if (!cancelled) {
          setFlagsReading({ reading: 'read-threw' })
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [application])

  /**
   * One browser collection run, on mount.
   *
   * `observeBrowserCapabilities` resolves whatever happens — every access and
   * every call inside it is contained — so this cannot be the thing that takes
   * down the only screen able to explain why the browser is misbehaving. It reads
   * the injected runtime and never the ambient scope.
   */
  useEffect(() => {
    let cancelled = false
    void observeBrowserCapabilities(injectedBrowserRuntime()).then((result) => {
      if (!cancelled) {
        setBrowserObservations(result)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * The checks that DO something, one runner each.
   *
   * *** A `Record` OVER `RunnableCheckId`, SO A CHECK CANNOT BE REGISTERED WITHOUT
   * A RUNNER. *** The registry in `diagnosticChecks.ts` says what each one does in
   * words; this says it in code, and the two are bound by the key type — a check
   * added there and not here fails compilation on this line.
   *
   * Each runner answers with a `CheckFinding`: a closed `result` for the row and
   * the copyable report, and a `detail` for the operator in front of the screen.
   * `detail` MAY quote a thrown message — an exception from `fetch` can name the
   * host it failed to reach, which is worth having where the reader already knows
   * their own hosts — and is never copied anywhere. The two are separate fields at
   * the point of recording rather than filtered later.
   *
   * The transport is read off `application` at RUN time, not captured from render
   * state: a runner closed over a two-second-old status would report the lane a
   * request rode from a reading taken before the request was made.
   */
  const runners: Record<RunnableCheckId, () => Promise<CheckFinding>> = useMemo(
    () => ({
      capabilities: async () => {
        try {
          // HTTP-only on purpose. `/v1/sockets/*` is a forbidden family on the
          // websocket RPC lane (routing the handshake through the transport it
          // establishes is circular), and that refusal is not safe-to-fallback —
          // through the ordinary helper this check would throw and be reported as
          // FAILED precisely when the socket is healthy.
          const response = await application.httpOnlyJsonRequest<{ capabilities?: unknown[] }>(
            'GET',
            '/v1/sockets/sync/capabilities',
          )
          if (!response.ok) {
            return {
              state: 'fail',
              result: answeredStatus(response.status),
              detail: `The capability descriptor answered ${response.status}.`,
            }
          }

          const advertised = Array.isArray(response.data?.capabilities) ? response.data.capabilities.length : 0
          if (advertised === 0) {
            return {
              state: 'fail',
              result: safeConstant('reachable, and advertises nothing'),
              detail:
                'Reachable, but advertises an EMPTY capability list — the client will not attempt a socket at all.',
            }
          }

          const noun = advertised === 1 ? 'capability entry' : 'capability entries'

          return {
            state: 'pass',
            result: safeTokens(
              safeConstant('advertises'),
              safeCount(advertised),
              advertised === 1 ? safeConstant('capability entry') : safeConstant('capability entries'),
            ),
            detail: `The server advertises ${advertised} ${noun}.`,
          }
        } catch (error) {
          return requestThrew(error)
        }
      },
      ticket: async () => {
        try {
          // HTTP-only for the same reason as the capability check above.
          const response = await application.httpOnlyJsonRequest<{ error?: { code?: string } }>(
            'POST',
            '/v1/sockets/sync/ticket',
            { deviceId: probeDeviceId() },
          )
          if (response.ok) {
            return {
              state: 'pass',
              result: safeConstant('issued; never redeemed, and it expires on its own'),
              detail: 'A short-lived single-use ticket was issued. It is not redeemed, and expires on its own.',
            }
          }
          if (response.data?.error?.code === 'SYNC_DISABLED') {
            return {
              state: 'fail',
              result: safeConstant('refused: SYNC_DISABLED'),
              detail:
                'Refused with SYNC_DISABLED — the sync lane was not composed at boot. The unmet boot conditions in this section say why.',
            }
          }

          return {
            state: 'fail',
            result: safeTokens(safeConstant('refused with HTTP'), safeCount(response.status)),
            detail: `The ticket request was refused with ${response.status}.`,
          }
        } catch (error) {
          return requestThrew(error)
        }
      },
      'control-plane': async () => {
        try {
          const response =
            await application.serverGetJsonRequestObservingLane<SyncDiagnosticsPayload>('/v1/admin/sync-diagnostics')
          const status = application.syncTransportStatus

          return describeControlPlaneRead({
            status: response.status,
            ok: response.ok,
            carriedBy: response.carriedBy,
            apiRpcNegotiated: status?.state === 'READY' && status.operations.includes('API_RPC'),
          })
        } catch (error) {
          return requestThrew(error)
        }
      },
      sync: async () => {
        const status = application.syncTransportStatus
        const round = await runSyncRound(application)

        return describeSyncRound({
          ...round,
          socketCarriesSync: status?.state === 'READY' && status.operations.includes('SYNC_ITEMS'),
        })
      },
      revisions: async () => describeRevisionsRead(await readRevisionsOfOneNote(application)),
      'file-transfer': async () => {
        const result = await runFileTransferCheck(fileTransferPortFor(application))
        setFileTransfer(result)

        return describeFileTransfer(result)
      },
    }),
    [application],
  )

  /**
   * Run some checks, in order, one at a time.
   *
   * ONE AT A TIME, so the progress line is true and so a failure is attributable:
   * five requests in flight together would all be "running" and would all report
   * against a transport that the first of them may have moved.
   *
   * A runner that THROWS — as opposed to one that reports a thrown request — is a
   * defect in this pane, and is still recorded as that check failing rather than
   * allowed to abandon the run: the checks after it are independent of it, and a
   * run that stops at the first surprise reports less exactly when more is wanted.
   *
   * `reload` re-reads the payload, the server status and the marker afterwards.
   * A full run does, because its results are read against them; a single check
   * does not, which is the whole reason a single check can be run on its own: it
   * answers the one question asked and leaves every other row as it was.
   */
  const runChecks = useCallback(
    async (ids: readonly RunnableCheckId[], reload: boolean) => {
      if (runInFlight.current) {
        return
      }
      runInFlight.current = true

      try {
        for (let index = 0; index < ids.length; index++) {
          const id = ids[index]
          setProgress({ done: index, total: ids.length, current: id })

          let finding: CheckFinding
          try {
            finding = await runners[id]()
          } catch (error) {
            finding = requestThrew(error)
          }

          setOutcomes((previous) => ({ ...previous, [id]: { id, ...finding } }))
        }
      } finally {
        runInFlight.current = false
        setProgress(null)
        readTransport()
        if (reload) {
          void loadDiagnostics()
          void loadServerStatus()
          void loadDeployment()
        }
      }
    },
    [loadDeployment, loadDiagnostics, loadServerStatus, readTransport, runners],
  )

  const runAllChecks = useCallback(() => runChecks(RUNNABLE_CHECK_IDS, true), [runChecks])

  /**
   * The read-only checks, run once when the pane opens.
   *
   * They write nothing, so there is nothing to consent to, and a pane that opened
   * with every check reading "not tested" would be asking the operator to press a
   * button to learn what it could have told them already. The checks that DO
   * write stay behind the button that says what they write.
   */
  useEffect(() => {
    void runChecks(AUTO_CHECK_IDS, false)
  }, [runChecks])

  /**
   * Every registered check with what it found: the run ones from state, the LIVE
   * ones evaluated here from what this pane already holds.
   *
   * The marker check has no outcome until the marker fetch has settled one way or
   * the other, so that for the first frame it reads "not tested" rather than
   * claiming a failure nobody has observed yet.
   */
  const readings = useMemo(
    () =>
      readingsFrom(
        {
          ...outcomes,
          negotiation: { id: 'negotiation', ...describeLiveSocketCheck(transport) },
          ...(markerRead === undefined
            ? {}
            : { marker: { id: 'marker' as const, ...describeMarkerCheck(deployment, markerRead) } }),
        },
        progress === null ? [] : [progress.current],
      ),
    [outcomes, transport, deployment, markerRead, progress],
  )

  /**
   * The direct observations a capped row can point at, from what this pane holds
   * right now. Built once and handed to all five sections, so two of them
   * pointing at one observation cannot disagree about whether it was made.
   *
   * `cryptoWorks` is three-valued and that is the care here: both round trips
   * passing confirms, either one FAILING refutes, and anything else — not
   * collected yet, or an API that was absent so nothing was attempted — is left
   * unobserved rather than read as a failure.
   */
  const witnesses = useMemo(() => {
    const digest = browserObservations?.digest
    const aes = browserObservations?.aesRoundTrip
    const failed = (outcome: string | undefined): boolean =>
      outcome === 'mismatch' || outcome === 'threw' || outcome === 'timed-out'
    const cryptoWorks = digest === 'ok' && aes === 'ok' ? true : failed(digest) || failed(aes) ? false : undefined
    const localDatabaseLoaded = observed(() => application.sync.isDatabaseLoaded())
    // Read by shape and nothing else: `true` and `false` are the ping's two
    // answers, and anything else — including the `null` the gateway sends when it
    // holds no cache client at all — is no reading.
    const cachePing = (serverStatus as { health?: { gateway?: { redis?: unknown } } } | undefined)?.health?.gateway
      ?.redis
    const gatewayCachePing = typeof cachePing === 'boolean' ? cachePing : undefined

    return buildWitnessBoard({
      checks: readings,
      ...(transport === undefined
        ? {}
        : {
            transport: {
              state: transport.state,
              operations: transport.operations,
              deferred: transport.state !== 'READY' && socketFallbackIsDeferred(transport.fallbackReason),
            },
          }),
      ...(payload?.protocol?.serverOperations === undefined
        ? {}
        : { serverOperations: payload.protocol.serverOperations }),
      ...(payload !== undefined ? { adminRead: true } : readFailure !== undefined ? { adminRead: false } : {}),
      ...(cryptoWorks === undefined ? {} : { cryptoWorks }),
      ...(localDatabaseLoaded === undefined ? {} : { localDatabaseLoaded }),
      ...(gatewayCachePing === undefined ? {} : { gatewayCachePing }),
      ...(ledger?.syncRoundCounts === undefined ? {} : { syncRounds: ledger.syncRoundCounts }),
      ...(fileTransfer === undefined ? {} : { fileSocketRead: fileTransfer.socketRead }),
    })
  }, [application, browserObservations, fileTransfer, ledger, payload, readFailure, readings, serverStatus, transport])

  const topology = payload?.deployment
  /**
   * The build identity, as one line, under the SAME admission the report uses.
   *
   * `describeDeployment` reduces the marker to its own sentinels, and the revision
   * is then admitted by SHAPE against the pattern `app/Dockerfile` itself
   * validates — never by the denylist that marker used to go through, which
   * printed `token-sk-live-…` verbatim because it has no address shape. An
   * unstamped build keeps its own sentinel, which the pattern rejects, so it is
   * restored explicitly exactly as the report does it.
   */
  const deploymentIdentity = useMemo(() => {
    const marker = describeDeployment(deployment)
    return marker.unstamped
      ? `${marker.revision} (not stamped)`
      : `${admitToken(marker.revision, DEPLOY_REVISION)} (version ${admitToken(marker.version, VERSION_TOKEN)})`
  }, [deployment])
  /** The server's capture instant, through the report's own rule. */
  const capturedLabel = useMemo(() => describeCaptureInstant(payload?.capturedAt), [payload])
  const verdict = useMemo(() => describeTransport(transport), [transport])
  const diagnosis = useMemo(() => diagnose(payload, transport, readFailure), [payload, transport, readFailure])

  /**
   * What this client knows about its own account, gathered at the one boundary
   * that can see it.
   *
   * Every field is read through `observed`, so a controller that has been
   * deinitialised — this codebase destroys its controllers' own properties on
   * teardown — reports NOTHING rather than taking the pane down or, worse,
   * reporting a `false` it never measured.
   *
   * *** ONE OF THESE OMISSIONS WAS WRONG, AND IS NOW WIRED. ***
   * `subscriptionEndsInSeconds` was left out on the recorded ground that
   * "`Subscription.endsAt` is a bare `number` in every type in this tree and
   * nothing establishes whether it is in milliseconds or microseconds". Something
   * does: `SubscriptionManager.userSubscriptionExpirationDate` — this repo's own
   * single reader of that field — converts it with `convertTimestampToMilliseconds`,
   * which decides by DIGIT COUNT and handles seconds, milliseconds and microseconds
   * alike. The ambiguity the omission was defending against is the one thing that
   * helper exists to resolve, so the duration is computed with the same call the
   * rest of the app uses rather than with a second guess about the unit. It throws
   * on a precision it does not recognise, which is why the call sits INSIDE
   * `observed` — an unrecognisable timestamp then reports nothing instead of a
   * fabricated duration, which is the behaviour the omission was reaching for.
   *
   * Three fields the shape declares are deliberately NOT supplied, and their rows
   * say so on screen:
   *   - `roles`: no client surface exposes the role NAMES, only `hasRole()` for
   *     one name at a time, and a list assembled from four probes of this build's
   *     own four names could not report an unrecognised one — which is the only
   *     thing that row is for.
   *   - `offlineSubscription`: `hasFirstPartyOfflineSubscription()` is on the snjs
   *     features client and is not exposed through `featuresController`.
   * `liveSyncEnabledForAccount` and `collaborationEnabledForAccount` USED TO BE
   * on that list, on the recorded ground that "no endpoint lets a client read its
   * own per-account flags". One does — `GET /v1/admin/users/:userUuid/feature-flags`,
   * the route the admin Users tab has always read — so they are supplied, with a
   * closed reading beside them for the admin-gated 403 that a non-admin session
   * gets.
   */
  const accountObservations = useMemo((): AccountObservations => {
    const subscription = observed(() => application.subscriptionController.onlineSubscription)

    return {
      signedIn: observed(() => application.sessions.isSignedIn()),
      firstPartyServer: observed(() => application.sessions.isSignedIntoFirstPartyServer()),
      clientBelievesAdmin: observed(() => application.featuresController.isAdminUser()),
      entitledToSharedVaults: observed(() => application.featuresController.isEntitledToSharedVaults()),
      subscriptionPresent: observed(() => application.subscriptionController.onlineSubscription !== undefined),
      ...(subscription === undefined
        ? {}
        : { subscriptionPlan: subscription.planName, subscriptionCancelled: subscription.cancelled }),
      // A DURATION, computed here and never an instant: the row reports how long is
      // left, and an expiry date in a pasteable report pins this account to a
      // purchase. `convertTimestampToMilliseconds` is the repo's own reader of this
      // field and throws on a precision it cannot place, so the whole expression
      // sits inside `observed` and an unplaceable timestamp reports nothing.
      ...(subscription === undefined
        ? {}
        : (() => {
            const endsIn = observed(() => (convertTimestampToMilliseconds(subscription.endsAt) - Date.now()) / 1000)
            return endsIn === undefined || !Number.isFinite(endsIn) ? {} : { subscriptionEndsInSeconds: endsIn }
          })()),
      /**
       * Whether this account holds any FILE, as the Account section's closed
       * three-state census — the fact that decides whether an absent server usage
       * figure is a lost bookkeeping write or simply nothing to report.
       *
       * *** THE EMPTY LIST IS THE TRAP, AND `isDatabaseLoaded()` IS THE GUARD. ***
       * `items` answers `[]` for the whole window between launch and the cold load
       * completing — `Application.launch` sets `launched` BEFORE
       * `loadDatabasePayloads()` is even started — so a count taken without this
       * guard reports "this account has no files" on every freshly opened app, and
       * the Space block would read that as "nothing to report" over a real loss.
       * `SyncService.isDatabaseLoaded()` flips only after the cold load's own
       * completeness check, so it is the one signal that separates the two.
       *
       * ONE KNOWN GAP, stated rather than papered over: `getItems` is the decrypted
       * view, and `getAnyItems` — which would also count a file whose key is
       * missing — is not on `ItemManagerInterface`, so it is not reachable from
       * here without widening a shared package. An account whose file items cannot
       * be decrypted therefore reads `none`. The Space block's row says so, and
       * that account's undecryptable items are a louder signal elsewhere than a
       * usage figure would be.
       */
      fileCensus: observed(() => {
        if (!application.sync.isDatabaseLoaded()) {
          return 'not-loaded'
        }
        return application.items.getItems(ContentType.TYPES.File).length > 0 ? 'present' : 'none'
      }),
      // The default is supplied EXPLICITLY, and that is the whole fix for a row
      // that read "not reported" on every deployment where nobody had set a cap.
      // `getPreference` with one argument answers `undefined` for an unset
      // preference, `observed` answers `undefined` for a read that threw, and the
      // row cannot tell those apart — so "the user set no cap", which is both the
      // commonest case and a perfectly good reading, arrived as "this pane did not
      // look". `0` is this preference's own documented default (`PrefDefaults`)
      // and is what the Storage pane means by unlimited; it is inlined rather than
      // imported because the default is also the floor this row is interpreting,
      // and a `?? 0` INSIDE the closure keeps a thrown read answering nothing.
      localSoftCapBytes: observed(() => application.getPreference(PrefKey.StorageMaxUsageBytes) ?? 0),
      /**
       * The account's own space figures, from the self-scoped subscription settings
       * read above. Spread rather than assigned, so an absent figure stays absent
       * instead of arriving as a zero, and `spaceFigureSource` is carried only once
       * the read has resolved: while it is in flight the block says neither kind of
       * empty, which is the honest answer for one frame.
       */
      ...(spaceReading === undefined
        ? {}
        : {
            spaceFigureSource: spaceReading.source,
            ...(spaceReading.used === undefined ? {} : { fileUploadBytesUsed: spaceReading.used }),
            ...(spaceReading.limit === undefined ? {} : { fileUploadBytesLimit: spaceReading.limit }),
            ...(spaceReading.limitOrigin === undefined ? {} : { fileAllowanceOrigin: spaceReading.limitOrigin }),
          }),
      /**
       * The account's stored-item total. Spread for the same reason as the file
       * figures: an absent figure must stay absent rather than arriving as a zero,
       * because a zero is an answer and this one would be the most misleading
       * answer on the screen. `itemUsageReading` is carried only once the read has
       * resolved, so the block says neither kind of empty for the one frame before
       * it knows which.
       */
      ...(itemUsage === undefined
        ? {}
        : {
            itemUsageReading: itemUsage.reading,
            ...(itemUsage.bytes === undefined ? {} : { itemBytesUsed: itemUsage.bytes }),
            ...(itemUsage.complete === undefined ? {} : { itemBytesComplete: itemUsage.complete }),
          }),
      /**
       * The origin's own usage, which is what the user's advisory soft cap is
       * about. Spread rather than assigned: a browser that cannot be asked must
       * leave the comparison undetermined, not "within the cap".
       */
      ...(localUsageBytes === undefined ? {} : { localUsageBytes }),
      /**
       * The per-account flags, from the admin feature-flags read above. Spread
       * rather than assigned so an unreadable flag stays ABSENT instead of
       * arriving as a `false` — the flattering direction here is the dangerous
       * one, because a fabricated `false` renders as "an administrator switched
       * this account off" and is a verdict rather than a gap.
       */
      ...(flagsReading === undefined
        ? {}
        : {
            flagReading: flagsReading.reading,
            ...(flagsReading.liveSync === undefined ? {} : { liveSyncEnabledForAccount: flagsReading.liveSync }),
            ...(flagsReading.collaboration === undefined
              ? {}
              : { collaborationEnabledForAccount: flagsReading.collaboration }),
          }),
      ...(payload?.protocol?.version === undefined ? {} : { protocolVersion: payload.protocol.version }),
      ...(payload?.protocol?.serverOperations === undefined
        ? {}
        : { serverOperations: payload.protocol.serverOperations }),
      ...(transport?.fallbackReason === undefined ? {} : { fallbackReason: transport.fallbackReason }),
    }
  }, [application, payload, transport, spaceReading, flagsReading, itemUsage, localUsageBytes])

  const websocketModel = useMemo(
    // `counters` is still NOT passed, and it no longer carries the admission half:
    // the gateway publishes that on `payload.admission`, which the section reads
    // for itself from the payload below. What is left in `counters` is
    // `advertisable`, which feeds the capability block's notes and which nothing
    // produces — and a `{}` there would be a claim that the gateway reported zero
    // sockets and zero refusals, so the block renders its own empty note instead.
    //
    // `ledger` IS passed now, and only when the transport actually produced one —
    // `application.syncTransportLedger` is `undefined` with no realtime transport
    // installed, and that absence must reach the block rather than be smoothed into
    // an empty reading.
    () =>
      buildWebsocketSection({
        payload,
        transport,
        checks: readings,
        witnesses,
        ...(ledger === undefined ? {} : { ledger }),
      }),
    [payload, transport, readings, witnesses, ledger],
  )
  const environmentModel = useMemo(
    // `runtime` IS passed now and is threaded straight off the payload. It used
    // to be withheld because nothing produced it: the gateway uptime, the two
    // EFFECTIVE session-cookie attributes, `E2E_TESTING` and auth's own uptime
    // are read by the AUTH process, and no endpoint carried them. The gateway
    // probes auth's runtime route for them today and reports its own outcome
    // beside them, so the section can say WHY they are absent instead of leaving
    // four blanks. The lane decision moved to `topology`, where the server puts
    // it. Passed RAW, with no `?? {}`: an absent block must stay absent, because
    // the section tells "older server" apart from "the probe did not answer".
    () =>
      buildEnvironmentSection({
        topology,
        deploymentMarker: deployment,
        fallback: payload?.transportFallback,
        runtime: payload?.runtime,
        checks: readings,
        witnesses,
      }),
    [topology, deployment, payload, readings, witnesses],
  )
  const backendModel = useMemo(
    // `datastore` and `queues` ARE passed now, both raw and both optional. The
    // durable store is reported by the service that OWNS the handle and relayed
    // through the same auth runtime probe, so it is absent exactly when that
    // probe did not answer; the queue block carries the separation VERDICT the
    // server derives once from its own consumer census plus the presence pair,
    // which is the only place that derivation may happen — doing it again here
    // would be two implementations of one rule.
    //
    // Raw rather than defaulted, for the queue block especially: an absent block
    // is a server older than it, and a present block with no verdict in it is a
    // server that looked and could not classify. A `?? {}` here would erase that
    // distinction before the row that depends on it ever saw it.
    //
    // `buildIdentified` IS passed, and it is one boolean rather than the revision:
    // the section needs only "did this build record one", for the single inference
    // that a probe reporting no depth cannot be read on an image nobody can place.
    // Threaded from the same marker Environment & setup reads, so the two sections
    // cannot disagree about whether the build is stamped.
    () =>
      buildBackendSection({
        serverStatus,
        statusError,
        topology,
        datastore: payload?.datastore,
        queues: payload?.queues,
        buildIdentified: !describeDeployment(deployment).unstamped,
        checks: readings,
        witnesses,
      }),
    [serverStatus, statusError, topology, deployment, payload, readings, witnesses],
  )
  const accountModel = useMemo(
    () =>
      buildAccountSection({
        observations: accountObservations,
        // The pane's OWN admin request, which is the only probe of the role it
        // needs. `payloadRead` wins over a stale status inside the section.
        adminAccess: {
          payloadRead: payload !== undefined,
          ...(readFailure?.status === undefined ? {} : { status: readFailure.status }),
        },
        checks: readings,
        witnesses,
      }),
    [accountObservations, payload, readFailure, readings, witnesses],
  )
  const browserModel = useMemo(
    () => buildBrowserSection({ observations: browserObservations, clock, checks: readings, witnesses }),
    [browserObservations, clock, readings, witnesses],
  )

  /**
   * The five models, as a complete `Record`. The compiler requires every member
   * of `SectionId`, so a section cannot be dropped from the pane — or from the
   * copyable report, which takes this same object — by forgetting it.
   */
  const sections: Record<SectionId, SectionModel> = useMemo(
    () => ({
      websocket: websocketModel,
      environment: environmentModel,
      backend: backendModel,
      account: accountModel,
      browser: browserModel,
    }),
    [websocketModel, environmentModel, backendModel, accountModel, browserModel],
  )

  const report = useMemo(
    () =>
      buildDiagnosticsReport({
        payload,
        transport,
        deploymentMarker: deployment,
        checks: readings,
        loadError,
        readFailure,
        sections,
      }),
    [payload, transport, deployment, readings, loadError, readFailure, sections],
  )

  /**
   * The ANSWER on its own, for the Copy summary button.
   *
   * Built from the same input as the report by the same module, so the two cannot
   * disagree — see `buildDiagnosticsSummary`. It exists because the full report is
   * tens of kilobytes and what somebody wants in a chat message is the verdict,
   * the ranked list of what to fix and the legend that makes them readable.
   */
  const summary = useMemo(
    () =>
      buildDiagnosticsSummary({
        payload,
        transport,
        deploymentMarker: deployment,
        checks: readings,
        loadError,
        readFailure,
        sections,
      }),
    [payload, transport, deployment, readings, loadError, readFailure, sections],
  )

  const copy = useCallback((text: string, which: 'report' | 'summary') => {
    setCopied(null)
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(which))
      .catch(() => setCopied(null))
  }, [])

  const copyReport = useCallback(() => copy(report, 'report'), [copy, report])
  const copySummary = useCallback(() => copy(summary, 'summary'), [copy, summary])

  /**
   * The headline, and the findings the Overview lists.
   *
   * BOTH from the same five section models the report is built from, through the
   * same module the report uses — `triage` for the headline verdict, `rankFindings`
   * for the order — so the screen and the paste cannot give one deployment two
   * headlines or put its findings in two orders.
   */
  const overall: Verdict = useMemo(() => triage({ sections }).sectionWorst, [sections])
  const ranked = useMemo(() => rankFindings(sections), [sections])
  const busy = progress !== null
  const operatorChecks = RUNNABLE_CHECK_IDS.filter((id) => CHECKS[id].mode === 'operator')

  return (
    <>
      <PreferencesSegment>
        <Title>Capability diagnostics</Title>

        {/* *** THE ANSWER FIRST, AND IN THREE FORMS. *** One status for the whole
            pane as a word, a shape and a colour, then one sentence saying what the
            word is worth, then what it does and does not cover. The verdict is on
            the element as `data-diagnostics-headline`, which is what a test reads:
            the sentence is copy, the verdict is the fact. */}
        <div className="mt-3 flex flex-wrap items-center gap-3" data-diagnostics-headline={overall}>
          <StatusChip verdict={overall} large />
          <span className="text-base font-semibold">{OVERALL_SENTENCE[overall]}</span>
        </div>
        <Text className="mt-2">{COVERAGE_SENTENCE}</Text>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button primary onClick={() => void runAllChecks()} disabled={busy}>
            {progress === null ? 'Run all checks' : `Running ${progress.done + 1} of ${progress.total}…`}
          </Button>
          <Button onClick={() => void loadDiagnostics()} disabled={loading || busy}>
            Refresh
          </Button>
          {loading && <Spinner className="h-4 w-4" />}
          <span className="text-passive-0 text-sm" data-diagnostics-check-summary="true">
            {summarizeChecks(readings)}
          </span>
        </div>
        {progress !== null && (
          <div className="mt-2" data-diagnostics-progress={`${progress.done}/${progress.total}`}>
            <div className="bg-contrast h-1.5 w-full overflow-hidden rounded">
              <div
                className="bg-info h-full"
                style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
              />
            </div>
            <Text className="mt-1">{`Now running: ${CHECKS[progress.current].title}`}</Text>
          </div>
        )}
        {/* WHAT A RUN DOES, BESIDE THE BUTTON THAT STARTS ONE, AND NOWHERE ELSE.
            Built from the registry, so a check that writes cannot be added without
            its sentence appearing here: the list is every check whose mode is
            `operator`, in its own words. */}
        {operatorChecks.length > 0 && (
          <Text className="mt-2">
            <span data-diagnostics-writes="true">
              {`Run all checks ${operatorChecks
                .map((id) => CHECKS[id].writes ?? `runs “${CHECKS[id].title}”`)
                .join(', and ')}. Nothing of yours is read, changed or removed.`}
            </span>
          </Text>
        )}
        <details className="mt-1" data-diagnostics-consent="true">
          <summary className="text-passive-0 cursor-pointer text-xs">
            {`What “Run all checks” does — ${operatorChecks.length} of ${RUNNABLE_CHECK_IDS.length} checks write something`}
          </summary>
          <Text className="mt-1">
            It runs every check on the Checks tab, one at a time. The read-only ones already ran when this pane opened.
            None of them reads, changes or deletes a note or a file of yours. The ones that write anything are:
          </Text>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {operatorChecks.map((id) => (
              <li key={id}>
                <span className="font-semibold">{CHECKS[id].title}</span>
                {` — ${CHECKS[id].does}`}
              </li>
            ))}
          </ul>
        </details>

        {/* The one-line answer to "what am I on right now", OUTSIDE the panels so
            it is readable from whichever section the operator is in. The full
            transport breakdown is the WebSocket section's and is not restated. */}
        <Text className="mt-3">{`Transport: ${verdict.label}. ${verdict.detail}`}</Text>
        {/* *** IDENTITY AND CAPTURE TIME, ON THE PANE AND NOT ONLY IN THE REPORT. ***
            "Which commit is live" and "how old is this reading" are the first two
            questions of every incident. Admitted by exactly the rules the report
            uses, so the screen and the paste cannot disagree. */}
        <Text className="mt-1">
          {/* The attribute lives on a span rather than on `Text`, which takes only
              `children` and `className` and silently drops anything else. */}
          <span data-diagnostics-identity="true">{`Build: ${deploymentIdentity} · captured ${capturedLabel}`}</span>
        </Text>
        {loadError && <Text className="text-danger mt-2">{loadError}</Text>}

        {/* *** ONE LINE PER SECTION: STATUS, COUNTS, AND WHY. *** Each line carries
            the WORST verdict anything in that section reported — never a summary
            written here — how many rows carry each status, and the one reason it
            has the status it has. An operator arriving mid-incident reads these
            five lines and opens one tab instead of five. */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-max text-left text-sm" data-diagnostics-summary="true">
            <tbody>
              {SECTION_IDS.map((id) => {
                const model = sections[id]

                return (
                  <tr key={id} data-diagnostics-router-row={id} className="border-border border-t align-top">
                    <td className="py-2 pr-4">
                      <StatusChip verdict={model.worstVerdict} />
                    </td>
                    <td className="py-2 pr-4 font-semibold">{model.title}</td>
                    <td className="text-passive-0 py-2 pr-4 whitespace-nowrap">
                      {describeVerdictCensus(model.counts)}
                    </td>
                    <td className="text-passive-0 max-w-md py-2 pr-4 whitespace-normal">{sectionReason(model)}</td>
                    <td className="py-2">
                      <Button small onClick={() => setActiveTab(sectionTabId(id))}>
                        Open
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </PreferencesSegment>

      {/* Sub-tab bar, built from the same raw primitives as the Admin shell's own
          strip. The ids are prefixed because Tab renders `tab-control-<id>` as a
          DOM id and this list is nested inside the Admin tab list — an unprefixed
          `browser` here would collide with a future top-level tab of the same
          name and break both. */}
      <div className="border-border bg-default mb-4 overflow-x-auto rounded-md border">
        <TabList state={tabState} className="flex min-w-max" aria-label="Diagnostics sections">
          {DIAGNOSTIC_SUBTABS.map(({ id, title }) => (
            <Tab key={id} id={id} className="whitespace-nowrap first:rounded-tl-md">
              {title}
            </Tab>
          ))}
        </TabList>
      </div>

      <TabPanel state={tabState} id="diag-overview">
        <PreferencesSegment>
          <Subtitle>What needs attention</Subtitle>
          {ranked.actions.length === 0 ? (
            <Text className="mt-1">
              {BLOCKS_OK[overall]
                ? 'No finding needs action. What keeps the headline off OK is a row rather than a finding: the summary above names it, section by section.'
                : 'Nothing. No section raised a finding that is not working, degraded, untested or unknown.'}
            </Text>
          ) : (
            <>
              <Text className="mt-1">
                Worst first, one entry per fact however many sections saw it. Each says what is wrong and ONE thing to
                do; the steps and the reasoning are folded under it.
              </Text>
              <ol className="mt-3 flex flex-col gap-2" data-diagnostics-attention="true">
                {ranked.actions.map((entry) => (
                  <li key={entry.finding.code}>
                    <FindingCard finding={entry.finding} source={`Seen in: ${entry.sources.join(SOURCE_JOIN)}`} />
                  </li>
                ))}
              </ol>
            </>
          )}

          {ranked.context.length > 0 && (
            <details className="mt-4" data-diagnostics-context="true">
              <summary className="cursor-pointer text-sm font-semibold">
                {`Context: ${ranked.context.length} finding(s) that are not faults`}
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {ranked.context.map((entry) => (
                  <li key={entry.finding.code}>
                    <FindingCard finding={entry.finding} source={`Seen in: ${entry.sources.join(SOURCE_JOIN)}`} />
                  </li>
                ))}
              </ul>
            </details>
          )}

          <HorizontalSeparator classes="mt-4 mb-4" />

          <Subtitle>Diagnosis</Subtitle>
          <Text className="mt-1">{diagnosis.headline}</Text>
          {diagnosis.findings.length > 0 && (
            <ul className="mt-3 flex flex-col gap-3">
              {diagnosis.findings.map((finding) => (
                <li key={finding.title} className="border-border rounded border p-3">
                  <div className="text-sm font-semibold">{finding.title}</div>
                  <div className="text-passive-0 mt-1 text-sm">{finding.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </PreferencesSegment>
      </TabPanel>

      {/* One panel per section, rendered by the ONE section renderer. There is no
          per-section JSX: a section is a pure model, and `DiagnosticsSection`
          paints any model that conforms. */}
      {SECTION_IDS.map((id) => (
        <TabPanel key={id} state={tabState} id={sectionTabId(id)}>
          <DiagnosticsSection model={sections[id]} />
        </TabPanel>
      ))}

      <TabPanel state={tabState} id="diag-checks">
        <PreferencesSegment>
          <Subtitle>Checks</Subtitle>
          <Text>
            What this pane tests, as opposed to what it is told. Each check says what running it does BEFORE it runs.
            The ones marked “read-only” ran when the pane opened; the ones marked “writes” run only from here or from
            Run all checks. None of them reads, changes or deletes a note or a file of yours.
          </Text>
          <Text className="mt-2">{summarizeChecks(readings)}</Text>
          <div className="mt-3">
            <Button primary onClick={() => void runAllChecks()} disabled={busy}>
              {progress === null ? 'Run all checks' : `Running ${progress.done + 1} of ${progress.total}…`}
            </Button>
          </div>
          {/* EVERY check, listed whether or not it has run. Iterated over the
              registry's readings rather than over the outcomes, so a check that has
              never run is visible as "Not tested" with its own control instead of
              being absent. The status shown is the ROW's — the same `checkRow` its
              section renders — so this list and the section cannot disagree. */}
          <ul className="mt-3 flex flex-col gap-2">
            {readings.map((reading) => {
              const { definition } = reading
              const row = checkRow(reading)
              const runnable = RUNNABLE_CHECK_IDS.find((id) => id === definition.id)

              return (
                <li
                  key={definition.id}
                  data-diagnostics-probe={definition.id}
                  data-diagnostics-probe-status={row.verdict}
                  className="border-border rounded border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip verdict={row.verdict} />
                    <span className="text-sm font-semibold">{definition.title}</span>
                    <Chip tone={definition.mode === 'operator' ? 'warn' : 'neutral'}>
                      {definition.mode === 'operator' ? 'writes' : definition.mode === 'live' ? 'live' : 'read-only'}
                    </Chip>
                    {runnable !== undefined && (
                      <Button small onClick={() => void runChecks([runnable], false)} disabled={busy}>
                        {reading.running === true
                          ? 'Running…'
                          : reading.outcome === undefined
                            ? 'Run this check'
                            : 'Re-run this check'}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-sm">{row.value}</div>
                  {reading.outcome !== undefined && (
                    <div className="text-passive-0 mt-1 text-sm">{reading.outcome.detail}</div>
                  )}
                  <div className="text-passive-0 mt-1 text-sm">{`What it does: ${definition.does}`}</div>
                </li>
              )
            })}
          </ul>
        </PreferencesSegment>
      </TabPanel>

      <TabPanel state={tabState} id="diag-report">
        <PreferencesSegment>
          <Subtitle>Copyable report</Subtitle>
          <Text>
            The whole diagnosis as markdown, for pasting into an issue or a support conversation — the summary table,
            what needs attention, the gate, the capability matrix, configuration presence, the checks, and all five
            sections with a status on every row. It is written on the assumption that it becomes public: it carries
            variable NAMES, booleans, closed codes, bounded counts and durations, and contains no URL, host, port, token
            or key — not truncated and not hashed.
          </Text>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {/* The SUMMARY first, and primary. It is what an operator wants in a
                chat message or an issue title: the status table, the ranked list
                of what needs attention, and the legend that makes both readable.
                The whole report is the attachment, not the message. */}
            <Button primary onClick={copySummary}>
              Copy summary
            </Button>
            {copied === 'summary' && <Chip tone="good">Summary copied</Chip>}
            <Button onClick={copyReport}>Copy whole report</Button>
            {copied === 'report' && <Chip tone="good">Report copied</Chip>}
          </div>
          <textarea
            className="border-border bg-default text-text mt-3 h-48 w-full rounded border p-3 font-mono text-xs"
            readOnly
            aria-label="Diagnostics summary"
            value={summary}
          />
          <textarea
            className="border-border bg-default text-text mt-3 h-96 w-full rounded border p-3 font-mono text-xs"
            readOnly
            aria-label="Diagnostics report"
            value={report}
          />
        </PreferencesSegment>
      </TabPanel>
    </>
  )
}

export default AdminDiagnosticsTab
