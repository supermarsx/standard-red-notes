import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'

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
  buildCapabilityRows,
  describeDeployment,
  describeTransport,
  diagnose,
  sanitizeServerCopy,
  summarizeTestRun,
  type CapabilityTestOutcome,
  type SyncDiagnosticsPayload,
  type Tone,
  type TransportStatusInput,
} from './syncDiagnostics'
import { buildEnvironmentGroups, describeTopology } from './diagnosticEnvironment'
import {
  EFFORT_LABEL,
  remedyForClientGap,
  remedyForLiveReason,
  remedyForPrecondition,
  remedyForUnstampedDeployment,
  type DeploymentTopology,
  type Remedy,
  type RemedyEffort,
} from './diagnosticRemedies'
import { buildDiagnosticsReport } from './diagnosticsReport'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

const TONE_CHIP: Record<Tone, string> = {
  good: 'bg-success-faded text-success',
  warn: 'bg-warning-faded text-warning',
  bad: 'bg-danger-faded text-danger',
  neutral: 'bg-contrast text-neutral',
}

const Chip: FunctionComponent<{ tone: Tone; children: string }> = ({ tone, children }) => (
  <span className={`rounded px-2 py-0.5 text-xs font-semibold tracking-wide uppercase ${TONE_CHIP[tone]}`}>
    {children}
  </span>
)

const EFFORT_TONE: Record<RemedyEffort, Tone> = {
  restart: 'good',
  rebuild: 'warn',
  'client-update': 'warn',
  none: 'bad',
  wait: 'neutral',
}

/**
 * A remedy, rendered so the operator can see BOTH the instruction and the
 * evidence it rests on.
 *
 * The `because` list is not decoration. This panel's only asset is that it can be
 * believed, and the fastest way to lose that is a confident instruction with no
 * visible reasoning — the operator cannot tell a derived remedy from a canned
 * one, so a single wrong answer discredits all of them. Showing the observed
 * facts makes a wrong remedy falsifiable on sight.
 */
const RemedyBlock: FunctionComponent<{ remedy: Remedy }> = ({ remedy }) => (
  <div className="border-border mt-2 rounded border border-dashed p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Chip tone={EFFORT_TONE[remedy.effort]}>{EFFORT_LABEL[remedy.effort]}</Chip>
      {remedy.basis === 'generic' && <Chip tone="warn">Generic advice</Chip>}
      <span className="text-sm font-semibold">How to fix</span>
    </div>
    <div className="mt-1 text-sm">{remedy.summary}</div>
    {remedy.steps.length > 0 && (
      <ol className="mt-2 list-decimal pl-5 text-sm">
        {remedy.steps.map((step) => (
          <li key={step} className="mt-1">
            {step}
          </li>
        ))}
      </ol>
    )}
    {remedy.because.length > 0 && (
      <ul className="text-passive-0 mt-2 list-disc pl-5 text-sm">
        {remedy.because.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    )}
  </div>
)

/**
 * A short, valid device identifier for the ticket probe. Deliberately NOT the
 * client's real sync device id: a probe must never disturb the device the live
 * socket is registered under, and a distinct id makes the mint attributable in
 * the gateway's logs.
 */
const probeDeviceId = (): string => `admin-diagnostic-probe-${Math.random().toString(36).slice(2, 10)}`

const DIAGNOSTIC_SUBTABS = [
  { id: 'diag-overview', title: 'Overview' },
  { id: 'diag-gate', title: 'Boot gate' },
  { id: 'diag-capabilities', title: 'Capabilities' },
  { id: 'diag-environment', title: 'Configuration' },
  { id: 'diag-checks', title: 'Checks' },
  { id: 'diag-report', title: 'Copyable report' },
]

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
 * SECURITY: the server endpoint behind this reports configuration PRESENCE only
 * and is admin-gated server-side (403 for anyone without the admin role). No
 * value, URL, host or secret is transported, and nothing here may start doing so.
 * The copyable report is written to be pasted somewhere public and holds the same
 * line — see diagnosticsReport.ts.
 */
const AdminDiagnosticsTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [payload, setPayload] = useState<SyncDiagnosticsPayload | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deployment, setDeployment] = useState<unknown>(undefined)
  const [outcomes, setOutcomes] = useState<CapabilityTestOutcome[]>([])
  const [testing, setTesting] = useState(false)
  const [copied, setCopied] = useState(false)

  const tabState = useTabState({ defaultTab: 'diag-overview' })

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
    try {
      const response = await application.serverGetJsonRequest<SyncDiagnosticsPayload>('/v1/admin/sync-diagnostics')
      if (!response.ok) {
        noteIfForbidden(response)
        setPayload(undefined)
        setLoadError(
          response.status === 404
            ? 'This server build does not have the sync diagnostics endpoint yet.'
            : `The server answered ${response.status} for the diagnostics endpoint.`,
        )
        return
      }
      setPayload(response.data)
    } catch (error) {
      console.error(error)
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

  useEffect(() => {
    void loadDiagnostics()
    void loadDeployment()
  }, [loadDiagnostics, loadDeployment])

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
   */
  const runTests = useCallback(async () => {
    setTesting(true)
    const results: CapabilityTestOutcome[] = []

    const record = (name: string, passed: boolean, detail: string, reportDetail: string) =>
      results.push({ name, passed, detail, reportDetail })

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
          'Capability descriptor (GET /v1/sockets/sync/capabilities)',
          response.ok && advertised > 0,
          summary,
          summary,
        )
      } catch (error) {
        record(
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
        record('Ticket issuance (POST /v1/sockets/sync/ticket)', response.ok, summary, summary)
      } catch (error) {
        record(
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
        record('Authenticated control-plane round trip', response.ok, summary, summary)
      } catch (error) {
        record(
          'Authenticated control-plane round trip',
          false,
          String(error),
          'The request threw before an answer arrived.',
        )
      }

      // 4. Live socket negotiation — no request at all, just what this client's
      //    own transport reports.
      const live = application.syncTransportStatus
      const liveSummary = live
        ? live.state === 'READY'
          ? `Socket READY, negotiated: ${live.operations.join(', ') || 'nothing'}.`
          : `Transport is ${live.state}${live.fallbackReason ? ` (${live.fallbackReason})` : ''} — no operations are negotiated.`
        : 'No realtime transport is installed in this client.'
      record('Live socket negotiation', live?.state === 'READY', liveSummary, liveSummary)

      // 5. Deployment marker — "is the running build current" must be answerable.
      try {
        const response = await fetch('/.well-known/srn-deployment.json', { headers: { Accept: 'application/json' } })
        const marker = response.ok ? await response.json() : {}
        setDeployment(marker)
        const view = describeDeployment(marker)
        const summary = view.unstamped ? (view.note ?? 'No revision recorded.') : `Running revision ${view.revision}.`
        record('Deployment marker (/.well-known/srn-deployment.json)', !view.unstamped, summary, summary)
      } catch (error) {
        record(
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
      readTransport()
    }
  }, [application, loadDiagnostics, readTransport, transport])

  const topology: DeploymentTopology | undefined = payload?.deployment
  const verdict = useMemo(() => describeTransport(transport), [transport])
  const diagnosis = useMemo(() => diagnose(payload, transport), [payload, transport])
  const deploymentView = useMemo(() => describeDeployment(deployment), [deployment])
  const rows = useMemo(
    () =>
      buildCapabilityRows(
        payload?.protocol?.serverOperations ?? [],
        transport?.operations ?? [],
        transport?.state === 'READY' || transport?.state === 'DEGRADED',
      ),
    [payload, transport],
  )
  const environmentGroups = useMemo(() => buildEnvironmentGroups(topology), [topology])
  const topologyFacts = useMemo(() => describeTopology(topology), [topology])
  const clientGaps = useMemo(
    () => rows.filter((row) => row.status === 'client-gap').map((row) => row.operation),
    [rows],
  )
  const report = useMemo(
    () => buildDiagnosticsReport({ payload, transport, deploymentMarker: deployment, outcomes, loadError }),
    [payload, transport, deployment, outcomes, loadError],
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
          <Chip tone={diagnosis.tone}>
            {diagnosis.tone === 'good' ? 'Healthy' : diagnosis.tone === 'warn' ? 'Degraded' : 'Unavailable'}
          </Chip>
          {loading && <Spinner className="h-4 w-4" />}
          <Button onClick={() => void loadDiagnostics()} disabled={loading}>
            Refresh
          </Button>
          <Button primary onClick={() => void runTests()} disabled={testing}>
            {testing ? 'Testing…' : 'Test all capabilities'}
          </Button>
        </div>
        {loadError && <Text className="text-danger mt-2">{loadError}</Text>}
      </PreferencesSegment>

      {/* Sub-tab bar, built from the same raw primitives as the Admin shell's own
          strip. The ids are prefixed because Tab renders `tab-control-<id>` as a
          DOM id and this list is nested inside the Admin tab list — an unprefixed
          `capabilities` here would collide with a future top-level tab of the
          same name and break both. */}
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
          <div className="flex items-center gap-3">
            <Subtitle>Transport in use right now</Subtitle>
            <Chip tone={verdict.tone}>{verdict.label}</Chip>
          </div>
          <Text className="mt-1">{verdict.detail}</Text>

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

          <HorizontalSeparator classes="mt-4 mb-4" />

          <Subtitle>Deployment identity</Subtitle>
          <Text>Which build is actually running, so &ldquo;is this fix deployed?&rdquo; is answerable.</Text>
          <div className="mt-2 flex items-center gap-3">
            <Chip tone={deploymentView.tone}>{deploymentView.unstamped ? 'Unstamped' : 'Stamped'}</Chip>
            <span className="text-sm">
              revision <span className="font-mono">{deploymentView.revision}</span> &middot; version{' '}
              <span className="font-mono">{deploymentView.version}</span>
            </span>
          </div>
          {deploymentView.note && <Text className="mt-2">{deploymentView.note}</Text>}
          {deploymentView.unstamped && <RemedyBlock remedy={remedyForUnstampedDeployment()} />}
        </PreferencesSegment>
      </TabPanel>

      <TabPanel state={tabState} id="diag-gate">
        <PreferencesSegment>
          <Subtitle>Boot gate</Subtitle>
          <Text>
            The conditions the gateway checks before it builds the realtime sync lane. All four must hold; a single
            unmet condition turns the whole lane off. Each unmet condition carries the fix for THIS deployment&apos;s
            topology — which is not always the fix the condition&apos;s own name suggests.
          </Text>
          {payload?.gate?.recorded === false && (
            <Text className="text-warning mt-2">
              The server has not recorded a gate decision yet, so no condition below can be confirmed.
            </Text>
          )}
          {/* The lane and SYNC_ITEMS are shown as two separate verdicts because
              they became two separate decisions: a durable-backend condition
              withholds SYNC_ITEMS without taking the socket down. One combined
              verdict would either hide a live lane or hide a missing operation. */}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-2 text-sm">
              <Chip tone={payload?.gate?.syncLaneEnabled ? 'good' : 'bad'}>
                {payload?.gate?.syncLaneEnabled ? 'Lane up' : 'Lane down'}
              </Chip>
              <span>Socket transport</span>
            </span>
            {payload?.gate?.syncItemsAdvertised !== undefined && (
              <span className="flex items-center gap-2 text-sm">
                <Chip tone={payload.gate.syncItemsAdvertised ? 'good' : 'warn'}>
                  {payload.gate.syncItemsAdvertised ? 'Advertised' : 'Withheld'}
                </Chip>
                <span>SYNC_ITEMS — note syncing over the socket</span>
              </span>
            )}
            <span className="flex items-center gap-2 text-sm">
              <Chip tone={payload?.live?.ticketAvailable ? 'good' : 'bad'}>
                {payload?.live?.ticketAvailable ? 'Issuing' : 'Refusing'}
              </Chip>
              <span>Ticket minting</span>
            </span>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {(payload?.gate?.unmetCodes ?? []).length === 0 && payload?.gate?.recorded ? (
              <li className="text-sm">
                <Chip tone="good">Met</Chip> <span className="ml-2">All boot conditions are satisfied.</span>
              </li>
            ) : (
              (payload?.gate?.unmetPreconditions ?? []).map((precondition) => (
                <li key={precondition.code} className="border-border rounded border p-3">
                  <div className="flex items-center gap-2">
                    <Chip tone="bad">Unmet</Chip>
                    <span className="text-sm font-semibold">{sanitizeServerCopy(precondition.code ?? 'Unknown')}</span>
                  </div>
                  <RemedyBlock
                    remedy={remedyForPrecondition(precondition.code ?? 'UNKNOWN', precondition.remedy, topology)}
                  />
                </li>
              ))
            )}
          </ul>

          {(payload?.live?.unavailabilityReasons ?? []).length > 0 && (
            <>
              <HorizontalSeparator classes="mt-4 mb-4" />
              <Subtitle>Live refusals</Subtitle>
              <Text>What the gateway says when asked for a ticket right now.</Text>
              <ul className="mt-3 flex flex-col gap-2">
                {(payload?.live?.unavailabilityReasons ?? []).map((reason) => {
                  const remedy = remedyForLiveReason(reason, topology)

                  return (
                    <li key={reason} className="border-border rounded border p-3">
                      <div className="text-sm font-semibold">{sanitizeServerCopy(reason)}</div>
                      {remedy ? (
                        <RemedyBlock remedy={remedy} />
                      ) : (
                        <div className="text-passive-0 mt-1 text-sm">
                          The gateway reported this refusal reason. This client build has no guidance for it.
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {payload?.gate?.files && (
            <>
              <HorizontalSeparator classes="mt-4 mb-4" />
              <Subtitle>FILES_V1 sub-gate</Subtitle>
              <Text className="mt-1">
                {payload.gate.files.advertised
                  ? 'Advertised by the server.'
                  : sanitizeServerCopy(payload.gate.files.remedy ?? 'Not advertised.')}
              </Text>
            </>
          )}
        </PreferencesSegment>
      </TabPanel>

      <TabPanel state={tabState} id="diag-capabilities">
        <PreferencesSegment>
          <Subtitle>Capabilities</Subtitle>
          <Text>
            Every operation either side knows about. &ldquo;Client gap&rdquo; means the server supports it and this
            client build does not — no server configuration will enable it.
          </Text>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-max text-left text-sm">
              <thead>
                <tr className="text-passive-0">
                  <th className="py-2 pr-4">Operation</th>
                  <th className="py-2 pr-4">Server</th>
                  <th className="py-2 pr-4">Client</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Why</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.operation} className="border-border border-t align-top">
                    <td className="py-2 pr-4 font-semibold">{row.operation}</td>
                    <td className="py-2 pr-4">{row.serverSupported ? 'yes' : 'no'}</td>
                    <td className="py-2 pr-4">{row.clientImplemented ? 'yes' : 'no'}</td>
                    <td className="py-2 pr-4">
                      <Chip tone={row.tone}>
                        {row.status === 'active'
                          ? 'Active'
                          : row.status === 'client-gap'
                            ? 'Client gap'
                            : row.status === 'recognized-only'
                              ? 'Carries nothing'
                              : row.status === 'not-negotiated'
                                ? 'Not offered'
                                : 'Unknown'}
                      </Chip>
                    </td>
                    <td className="text-passive-0 py-2">{row.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {clientGaps.length > 0 && <RemedyBlock remedy={remedyForClientGap(clientGaps)} />}
          <Text className="mt-3">Protocol version: {payload?.protocol?.version ?? 'not reported'}</Text>
        </PreferencesSegment>
      </TabPanel>

      <TabPanel state={tabState} id="diag-environment">
        <PreferencesSegment>
          <Subtitle>Topology</Subtitle>
          <Text>
            What kind of deployment this is. It decides which remedies are even possible: several conditions have no
            configuration fix at all in some topologies, and this is how the panel knows not to send you after one.
          </Text>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-max text-left text-sm">
              <tbody>
                {topologyFacts.map((fact) => (
                  <tr key={fact.label} className="border-border border-t align-top">
                    <td className="py-2 pr-4 font-semibold">{fact.label}</td>
                    <td className="py-2 pr-4 font-mono">{fact.value}</td>
                    <td className="text-passive-0 py-2">{fact.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PreferencesSegment>

        <PreferencesSegment>
          <Subtitle>Configuration presence</Subtitle>
          <Text>
            Which variables are set — never what they are set to. The rows that matter most are the ones marked
            &ldquo;inert&rdquo; while set: those are configured, look correct everywhere, and are not read by this
            deployment.
          </Text>
          {environmentGroups.length === 0 && (
            <Text className="mt-3">This server build does not report configuration presence.</Text>
          )}
          {environmentGroups.map((group) => (
            <div key={group.title} className="mt-4">
              <div className="text-sm font-semibold">{group.title}</div>
              <div className="text-passive-0 text-sm">{group.description}</div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-max text-left text-sm">
                  <tbody>
                    {group.rows.map((row) => (
                      <tr key={row.key} className="border-border border-t align-top">
                        <td className="py-2 pr-4 font-mono">{row.key}</td>
                        <td className="py-2 pr-4">{row.present ? 'set' : 'not set'}</td>
                        <td className="py-2 pr-4">
                          <Chip tone={row.tone}>{row.relevance}</Chip>
                        </td>
                        <td className="text-passive-0 py-2">{row.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </PreferencesSegment>
      </TabPanel>

      <TabPanel state={tabState} id="diag-checks">
        <PreferencesSegment>
          <Subtitle>Capability tests</Subtitle>
          <Text>
            Operator-triggered checks that exercise each lane and report the real error. Read-only against your data:
            nothing is written, no invite is sent, nothing is deleted. The ticket check mints a short-lived, single-use
            ticket for your own session, which is never redeemed and expires by itself.
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
                    <Chip tone={outcome.passed ? 'good' : 'bad'}>{outcome.passed ? 'Pass' : 'Fail'}</Chip>
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
            The whole diagnosis as markdown, for pasting into an issue or a support conversation. It is written on the
            assumption that it becomes public: it carries variable NAMES, booleans and status codes, and contains no
            URL, host, port, token or key — not truncated and not hashed. Run the checks first if you want them
            included.
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
