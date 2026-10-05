import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
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
  CAPABILITY_OUTCOME_CHIP,
  capabilityOutcomeState,
  describeDeployment,
  describeTransport,
  diagnose,
  summarizeTestRun,
  type CapabilityOutcomeState,
  type DiagnosticsReadFailure,
  type SyncDiagnosticsPayload,
  type Tone,
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
import { Chip } from './diagnosticsPresentation'
import {
  SECTION_IDS,
  SECTION_TITLE,
  VERDICT_CHIP_LABEL,
  type SectionId,
  type SectionModel,
  type SectionTaggedOutcome,
  type Verdict,
} from './diagnosticsSections'
import DiagnosticsSection from './DiagnosticsSection'
import { buildWebsocketSection, socketFallbackIsDeferred } from './websocketSection'
import { buildEnvironmentSection } from './environmentSection'
import { buildBackendSection } from './backendSection'
import { buildAccountSection, type AccountObservations, type SpaceFigureSource } from './accountSection'
import {
  buildBrowserSection,
  observeBrowserCapabilities,
  type BrowserClockReading,
  type BrowserObservations,
  type BrowserRuntime,
} from './browserSection'
import { buildDiagnosticsReport } from './diagnosticsReport'

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
type AccountSpaceReading = {
  source: SpaceFigureSource
  used?: number
  limit?: number
}

/**
 * The diagnosis chip, one label per tone.
 *
 * *** EXHAUSTIVE `Record` ON PURPOSE — the fall-through WAS the bug. ***
 *
 * This was a ternary chain: `good ? 'Healthy' : warn ? 'Degraded' : 'Unavailable'`.
 * Every other tone therefore inherited "Unavailable", including the `'neutral'`
 * that means "no verdict at all" — so a failure to READ the diagnostics endpoint
 * was rendered as a confident claim that the socket was unavailable, directly
 * beside a verdict chip reading "WebSocket" that said the opposite and was right.
 * A tone added to the union now fails this file to compile rather than quietly
 * acquiring that claim.
 *
 * `Chip` can render all four: `TONE_CHIP` in `diagnosticsPresentation.tsx` is
 * itself a `Record<Tone, string>` and already carries the neutral styling.
 */
export const DIAGNOSIS_CHIP_LABEL: Record<Tone, string> = {
  good: 'Healthy',
  warn: 'Degraded',
  bad: 'Unavailable',
  neutral: 'Unknown',
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What the Overview router says about a
 * section that raised NO finding, per worst verdict.
 *
 * A single sentence for all of them would have to be either reassuring or
 * alarming, and both are wrong half the time: a section with no findings and a
 * `healthy` worst verdict read everything it needed, while one with no findings
 * and an `undetermined` worst verdict read almost nothing. Those are the two
 * states this whole pane exists to keep apart, so the router does not collapse
 * them into "nothing to report".
 */
const ROUTER_NO_FINDING: Record<Verdict, string> = {
  healthy: 'Every row this section could read came back healthy.',
  degraded: 'No single finding, but at least one row in this section is degraded.',
  broken: 'No single finding, but at least one row in this section reads as down.',
  undetermined:
    'Nothing in this section established its facts, so no verdict is claimed. That is NOT the same as everything being fine.',
  informational: 'This section carries context only — nothing in it is a verdict.',
}

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
  const [outcomes, setOutcomes] = useState<SectionTaggedOutcome[]>([])
  const [testing, setTesting] = useState(false)
  const [copied, setCopied] = useState(false)
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

  const tabState = useTabState({ defaultTab: 'diag-overview' })
  const { setActiveTab } = tabState

  // The transport state is read live rather than cached: the question this tab
  // answers is "what am I on RIGHT NOW", and a value captured at mount would be
  // wrong within seconds of a reconnect.
  const [transport, setTransport] = useState<TransportStatusInput | undefined>(undefined)
  const readTransport = useCallback(() => {
    const status = application.syncTransportStatus
    setTransport(status ? { ...status, operations: [...status.operations] } : undefined)
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
      const response = await application.serverGetJsonRequest<SyncDiagnosticsPayload>('/v1/admin/sync-diagnostics')
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
    } catch {
      setDeployment({})
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
    const readBytes = async (pick: 'FileUploadBytesUsed' | 'FileUploadBytesLimit'): Promise<number | undefined> => {
      const name = SettingName.create(SettingName.NAMES[pick]).getValue()
      const raw = await application.settings.getSubscriptionSetting(name)
      const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN

      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    }

    const figureOf = (settled: PromiseSettledResult<number | undefined>): number | undefined => {
      return settled.status === 'fulfilled' ? settled.value : undefined
    }

    void Promise.allSettled([readBytes('FileUploadBytesUsed'), readBytes('FileUploadBytesLimit')]).then((settled) => {
      if (cancelled) {
        return
      }

      const used = figureOf(settled[0])
      const limit = figureOf(settled[1])
      const threw = settled.some((result) => result.status === 'rejected')

      setSpaceReading({
        source: threw ? 'read-threw' : 'read-carried-no-figure',
        ...(used === undefined ? {} : { used }),
        ...(limit === undefined ? {} : { limit }),
      })
    })

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
   * Operator-triggered checks that actually exercise each lane and report the
   * real error. All are read-only against user data: nothing is written, no
   * invite is sent, nothing is deleted. The one probe that does cause a server
   * write — the ticket mint — is called out in its own row, because a
   * short-lived single-use ticket for your own session is the ONLY way to learn
   * whether `/ticket` would actually succeed.
   *
   * Each outcome carries TWO details. `detail` is for the operator in front of
   * the screen and may quote a thrown message; `reportDetail` is constant copy
   * for the copyable report, which is assumed to become public. A thrown message
   * from `fetch` can name the host it failed to reach, so the two are kept
   * separate at the point of recording rather than filtered later.
   *
   * Each outcome is also TAGGED with the section it belongs to, so the result
   * appears read-only inside that section while the consent paragraph and the
   * button that mints a real server-side ticket stay in exactly one place.
   */
  const runTests = useCallback(async () => {
    setTesting(true)
    const results: SectionTaggedOutcome[] = []

    const record = (
      section: SectionId,
      name: string,
      passed: boolean,
      detail: string,
      reportDetail: string,
      state?: CapabilityOutcomeState,
    ) => results.push({ section, name, passed, detail, reportDetail, ...(state === undefined ? {} : { state }) })

    try {
      // 1. The public capability descriptor — the same call the transport makes
      //    before it will even attempt a socket.
      try {
        // HTTP-only on purpose. `/v1/sockets/*` is a forbidden family on the
        // websocket RPC lane (routing the handshake through the transport it
        // establishes is circular), and that refusal is not safe-to-fallback —
        // through the ordinary helper this probe would throw and be reported as a
        // FAILED check precisely when the socket is healthy.
        const response = await application.httpOnlyJsonRequest<{ capabilities?: unknown[] }>(
          'GET',
          '/v1/sockets/sync/capabilities',
        )
        const advertised = Array.isArray(response.data?.capabilities) ? response.data.capabilities.length : 0
        const summary = response.ok
          ? advertised > 0
            ? `Advertises ${advertised} capability entry(ies).`
            : 'Reachable, but advertises an EMPTY capability list — the client will not attempt a socket at all.'
          : `Answered ${response.status}.`
        record(
          'websocket',
          'Capability descriptor (GET /v1/sockets/sync/capabilities)',
          response.ok && advertised > 0,
          summary,
          summary,
        )
      } catch (error) {
        record(
          'websocket',
          'Capability descriptor (GET /v1/sockets/sync/capabilities)',
          false,
          String(error),
          'The request threw before an answer arrived.',
        )
      }

      // 2. Ticket issuance — the definitive test of whether this session can get
      //    onto the socket lane.
      try {
        // HTTP-only for the same reason as the capability probe above.
        const response = await application.httpOnlyJsonRequest<{ error?: { code?: string }; endpoint?: string }>(
          'POST',
          '/v1/sockets/sync/ticket',
          { deviceId: probeDeviceId() },
        )
        const code = response.data?.error?.code
        const summary = response.ok
          ? 'A short-lived single-use ticket was issued. It is not redeemed, and expires on its own.'
          : code === 'SYNC_DISABLED'
            ? 'Refused with SYNC_DISABLED — the sync lane was not composed at boot. See the unmet conditions above.'
            : `Refused with ${response.status}${code ? ` (${code})` : ''}.`
        record('websocket', 'Ticket issuance (POST /v1/sockets/sync/ticket)', response.ok, summary, summary)
      } catch (error) {
        record(
          'websocket',
          'Ticket issuance (POST /v1/sockets/sync/ticket)',
          false,
          String(error),
          'The request threw before an answer arrived.',
        )
      }

      // 3. Authenticated control-plane round trip. When API_RPC is negotiated
      //    this rides the socket; otherwise it is an ordinary HTTP request. Either
      //    way a failure here means the admin surface itself is broken.
      try {
        const response = await application.serverGetJsonRequest<SyncDiagnosticsPayload>('/v1/admin/sync-diagnostics')
        const summary = response.ok
          ? transport?.operations.includes('API_RPC')
            ? 'Succeeded, over the socket API_RPC lane.'
            : 'Succeeded, over HTTP (API_RPC is not negotiated).'
          : `Answered ${response.status}.`
        record('websocket', 'Authenticated control-plane round trip', response.ok, summary, summary)
      } catch (error) {
        record(
          'websocket',
          'Authenticated control-plane round trip',
          false,
          String(error),
          'The request threw before an answer arrived.',
        )
      }

      // 4. Live socket negotiation — no request at all, just what this client's
      //    own transport reports.
      //
      //    THREE ANSWERS, NOT TWO. A transport standing down because another tab
      //    of this account owns the socket lane is a correct steady state — the
      //    lane's own copy for that reason reads "Expected, and not a fault" —
      //    and this check recorded `[FAIL]` for it, in a report whose top-level
      //    Diagnosis said on the same screen that the lane is fully available.
      //    The disposition comes from the transport's own classification
      //    (`socketFallbackIsDeferred`, which consumes `syncFallbackDisposition`);
      //    it is not re-derived here, because re-deriving it as the negation of
      //    "permanent" is exactly the defect that produced the FAIL.
      //
      //    Every other way this check fails still fails: a reason the lane calls
      //    retryable or permanent, a non-READY state with no reason at all, and
      //    no transport installed are each still recorded as a failure.
      const live = application.syncTransportStatus
      const deferred = live !== undefined && live.state !== 'READY' && socketFallbackIsDeferred(live.fallbackReason)
      const liveSummary = live
        ? live.state === 'READY'
          ? `Socket READY, negotiated: ${live.operations.join(', ') || 'nothing'}.`
          : deferred
            ? 'Not negotiated here: another tab of this account owns the socket lane. Expected, and not a fault — this tab sends over HTTP by design while that one holds the lease.'
            : `Transport is ${live.state}${live.fallbackReason ? ` (${live.fallbackReason})` : ''} — no operations are negotiated.`
        : 'No realtime transport is installed in this client.'
      record(
        'websocket',
        'Live socket negotiation',
        live?.state === 'READY',
        liveSummary,
        liveSummary,
        deferred ? 'informational' : undefined,
      )

      // 5. Deployment marker — "is the running build current" must be answerable.
      //    Tagged for Environment & setup, which is where the deployment identity
      //    block now lives.
      try {
        const response = await fetch('/.well-known/srn-deployment.json', { headers: { Accept: 'application/json' } })
        const marker = response.ok ? await response.json() : {}
        setDeployment(marker)
        const view = describeDeployment(marker)
        const summary = view.unstamped ? (view.note ?? 'No revision recorded.') : `Running revision ${view.revision}.`
        record('environment', 'Deployment marker (/.well-known/srn-deployment.json)', !view.unstamped, summary, summary)
      } catch (error) {
        record(
          'environment',
          'Deployment marker (/.well-known/srn-deployment.json)',
          false,
          String(error),
          'The marker could not be read.',
        )
      }

      setOutcomes(results)
    } finally {
      setTesting(false)
      void loadDiagnostics()
      void loadServerStatus()
      readTransport()
    }
  }, [application, loadDiagnostics, loadServerStatus, readTransport, transport])

  const topology = payload?.deployment
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
   *   - `liveSyncEnabledForAccount` / `collaborationEnabledForAccount`: no
   *     endpoint lets a client read its own per-account flags. The section's own
   *     header says so and its rows name what they are waiting for.
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
          }),
      ...(payload?.protocol?.version === undefined ? {} : { protocolVersion: payload.protocol.version }),
      ...(payload?.protocol?.serverOperations === undefined
        ? {}
        : { serverOperations: payload.protocol.serverOperations }),
      ...(transport?.fallbackReason === undefined ? {} : { fallbackReason: transport.fallbackReason }),
    }
  }, [application, payload, transport, spaceReading])

  const websocketModel = useMemo(
    // `counters` and `ledger` are NOT passed: nothing in this build produces
    // either — the lane-degradation ledger module does not exist at all — and a
    // `{}` would be a claim that the gateway reported zero sockets and zero
    // refusals. Their blocks render their own empty notes instead.
    () => buildWebsocketSection({ payload, transport, outcomes }),
    [payload, transport, outcomes],
  )
  const environmentModel = useMemo(
    // `runtime` is NOT passed: `serviceProxyDecision`, the two effective cookie
    // flags, `E2E_TESTING` and the process uptime are read by the AUTH process
    // and no endpoint this pane can reach reports any of them. `transportFallback`
    // IS on the wire and is threaded.
    () =>
      buildEnvironmentSection({
        topology,
        deploymentMarker: deployment,
        fallback: payload?.transportFallback,
        outcomes,
      }),
    [topology, deployment, payload, outcomes],
  )
  const backendModel = useMemo(
    // `datastore` and `queues` are NOT passed: no endpoint reports a connection
    // state, a migration count, a pool figure or a queue identity yet, and those
    // rows say which field they are waiting for.
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
        buildIdentified: !describeDeployment(deployment).unstamped,
        outcomes,
      }),
    [serverStatus, statusError, topology, deployment, outcomes],
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
        outcomes,
      }),
    [accountObservations, payload, readFailure, outcomes],
  )
  const browserModel = useMemo(
    () => buildBrowserSection({ observations: browserObservations, clock, outcomes }),
    [browserObservations, clock, outcomes],
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
        outcomes,
        loadError,
        readFailure,
        sections,
      }),
    [payload, transport, deployment, outcomes, loadError, readFailure, sections],
  )

  const copyReport = useCallback(() => {
    setCopied(false)
    void navigator.clipboard
      ?.writeText(report)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }, [report])

  return (
    <>
      <PreferencesSegment>
        <Title>Capability diagnostics</Title>
        <Text>
          What transport this client is actually on, what the server advertises, and — when something is unavailable —
          which specific configuration item is missing and what to do about it. Reports configuration presence only; no
          value, address or secret is read from the server.
        </Text>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Chip tone={verdict.tone}>{verdict.label}</Chip>
          <Chip tone={diagnosis.tone}>{DIAGNOSIS_CHIP_LABEL[diagnosis.tone]}</Chip>
          {loading && <Spinner className="h-4 w-4" />}
          <Button onClick={() => void loadDiagnostics()} disabled={loading}>
            Refresh
          </Button>
          <Button primary onClick={() => void runTests()} disabled={testing}>
            {testing ? 'Testing…' : 'Test all capabilities'}
          </Button>
        </div>
        {/* The one-line answer to "what am I on right now", beside the chip it
            belongs to and OUTSIDE the panels, so it is readable from whichever
            section the operator is in. The full transport breakdown is the
            WebSocket section's and is not restated there or here. */}
        <Text className="mt-2">{verdict.detail}</Text>
        {loadError && <Text className="text-danger mt-2">{loadError}</Text>}
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
          <Subtitle>Which section to open</Subtitle>
          <Text>
            One row per section, each carrying the WORST verdict anything in that section reported — not a summary
            written here. An operator arriving mid-incident reads this table and opens one tab instead of five.
            &ldquo;Unknown&rdquo; is not a quiet pass: it means that section could not establish its facts, which is
            worth opening and is deliberately ranked above healthy and below degraded.
          </Text>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-max text-left text-sm">
              <tbody>
                {SECTION_IDS.map((id) => {
                  const model = sections[id]

                  return (
                    <tr key={id} data-diagnostics-router-row={id} className="border-border border-t align-top">
                      <td className="py-2 pr-4 font-semibold">{model.title}</td>
                      <td className="py-2 pr-4">
                        <Chip tone={model.worst}>{VERDICT_CHIP_LABEL[model.worstVerdict]}</Chip>
                      </td>
                      <td className="text-passive-0 py-2 pr-4">
                        {model.headline?.title ?? ROUTER_NO_FINDING[model.worstVerdict]}
                      </td>
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
          <Subtitle>Capability tests</Subtitle>
          {/* THE ONLY PLACE A RUN CAN BE STARTED, and therefore the only place
              this paragraph appears. One of these probes mints a real
              server-side ticket; a consent notice repeated on six tabs is a
              notice nobody reads, so the sections show the results read-only. */}
          <Text>
            Operator-triggered checks that exercise each lane and report the real error. This is the only tab that
            probes anything: every other section reads what the server already reported, and shows the results below
            read-only. Read-only against your data — nothing is written, no invite is sent, nothing is deleted. The
            ticket check mints a short-lived, single-use ticket for your own session, which is never redeemed and
            expires by itself.
          </Text>
          <Text className="mt-2">{summarizeTestRun(outcomes)}</Text>
          <div className="mt-3">
            <Button primary onClick={() => void runTests()} disabled={testing}>
              {testing ? 'Testing…' : 'Test all capabilities'}
            </Button>
          </div>
          {outcomes.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {outcomes.map((outcome) => (
                <li key={outcome.name} className="border-border rounded border p-3">
                  <div className="flex items-center gap-2">
                    <Chip tone={CAPABILITY_OUTCOME_CHIP[capabilityOutcomeState(outcome)].tone}>
                      {CAPABILITY_OUTCOME_CHIP[capabilityOutcomeState(outcome)].label}
                    </Chip>
                    <span className="text-sm font-semibold">{outcome.name}</span>
                  </div>
                  <div className="text-passive-0 mt-1 text-sm">{outcome.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </PreferencesSegment>
      </TabPanel>

      <TabPanel state={tabState} id="diag-report">
        <PreferencesSegment>
          <Subtitle>Copyable report</Subtitle>
          <Text>
            The whole diagnosis as markdown, for pasting into an issue or a support conversation — the verdict, the
            gate, the capability matrix, configuration presence, the checks, and all five sections with their own worst
            verdicts. It is written on the assumption that it becomes public: it carries variable NAMES, booleans,
            closed codes, bounded counts and durations, and contains no URL, host, port, token or key — not truncated
            and not hashed. Run the checks first if you want them included.
          </Text>
          <div className="mt-3 flex items-center gap-3">
            <Button primary onClick={copyReport}>
              Copy report
            </Button>
            {copied && <Chip tone="good">Copied</Chip>}
          </div>
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
