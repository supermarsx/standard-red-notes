import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import {
  buildCapabilityRows,
  describeDeployment,
  describeTransport,
  diagnose,
  summarizeTestRun,
  type CapabilityTestOutcome,
  type SyncDiagnosticsPayload,
  type Tone,
  type TransportStatusInput,
} from './syncDiagnostics'

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

/**
 * A short, valid device identifier for the ticket probe. Deliberately NOT the
 * client's real sync device id: a probe must never disturb the device the live
 * socket is registered under, and a distinct id makes the mint attributable in
 * the gateway's logs.
 */
const probeDeviceId = (): string => `admin-diagnostic-probe-${Math.random().toString(36).slice(2, 10)}`

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
 * So the tab answers four things on one screen: what transport am I on, what is
 * advertised, what is broken, and exactly which configuration item is missing.
 * The last one is the point — "SYNCING_SERVER_GRPC_URL is not set" is worth more
 * than any amount of "unavailable".
 *
 * SECURITY: the server endpoint behind this reports configuration PRESENCE only
 * and is admin-gated server-side (403 for anyone without the admin role). No
 * value, URL, host or secret is transported, and nothing here may start doing so.
 */
const AdminDiagnosticsTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [payload, setPayload] = useState<SyncDiagnosticsPayload | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deployment, setDeployment] = useState<unknown>(undefined)
  const [outcomes, setOutcomes] = useState<CapabilityTestOutcome[]>([])
  const [testing, setTesting] = useState(false)

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
   */
  const runTests = useCallback(async () => {
    setTesting(true)
    const results: CapabilityTestOutcome[] = []

    const record = (name: string, passed: boolean, detail: string) => results.push({ name, passed, detail })

    try {
      // 1. The public capability descriptor — the same call the transport makes
      //    before it will even attempt a socket.
      try {
        const response = await application.serverGetJsonRequest<{ capabilities?: unknown[] }>(
          '/v1/sockets/sync/capabilities',
        )
        const advertised = Array.isArray(response.data?.capabilities) ? response.data.capabilities.length : 0
        record(
          'Capability descriptor (GET /v1/sockets/sync/capabilities)',
          response.ok && advertised > 0,
          response.ok
            ? advertised > 0
              ? `Advertises ${advertised} capability entry(ies).`
              : 'Reachable, but advertises an EMPTY capability list — the client will not attempt a socket at all.'
            : `Answered ${response.status}.`,
        )
      } catch (error) {
        record('Capability descriptor (GET /v1/sockets/sync/capabilities)', false, String(error))
      }

      // 2. Ticket issuance — the definitive test of whether this session can get
      //    onto the socket lane.
      try {
        const response = await application.serverJsonRequest<{ error?: { code?: string }; endpoint?: string }>(
          '/v1/sockets/sync/ticket',
          { deviceId: probeDeviceId() },
        )
        const code = response.data?.error?.code
        record(
          'Ticket issuance (POST /v1/sockets/sync/ticket)',
          response.ok,
          response.ok
            ? 'A short-lived single-use ticket was issued. It is not redeemed, and expires on its own.'
            : code === 'SYNC_DISABLED'
              ? 'Refused with SYNC_DISABLED — the sync lane was not composed at boot. See the unmet conditions above.'
              : `Refused with ${response.status}${code ? ` (${code})` : ''}.`,
        )
      } catch (error) {
        record('Ticket issuance (POST /v1/sockets/sync/ticket)', false, String(error))
      }

      // 3. Authenticated control-plane round trip. When API_RPC is negotiated
      //    this rides the socket; otherwise it is an ordinary HTTP request. Either
      //    way a failure here means the admin surface itself is broken.
      try {
        const response = await application.serverGetJsonRequest<SyncDiagnosticsPayload>('/v1/admin/sync-diagnostics')
        record(
          'Authenticated control-plane round trip',
          response.ok,
          response.ok
            ? transport?.operations.includes('API_RPC')
              ? 'Succeeded, over the socket API_RPC lane.'
              : 'Succeeded, over HTTP (API_RPC is not negotiated).'
            : `Answered ${response.status}.`,
        )
      } catch (error) {
        record('Authenticated control-plane round trip', false, String(error))
      }

      // 4. Live socket negotiation — no request at all, just what this client's
      //    own transport reports.
      const live = application.syncTransportStatus
      record(
        'Live socket negotiation',
        live?.state === 'READY',
        live
          ? live.state === 'READY'
            ? `Socket READY, negotiated: ${live.operations.join(', ') || 'nothing'}.`
            : `Transport is ${live.state}${live.fallbackReason ? ` (${live.fallbackReason})` : ''} — no operations are negotiated.`
          : 'No realtime transport is installed in this client.',
      )

      // 5. Deployment marker — "is the running build current" must be answerable.
      try {
        const response = await fetch('/.well-known/srn-deployment.json', { headers: { Accept: 'application/json' } })
        const marker = response.ok ? await response.json() : {}
        setDeployment(marker)
        const view = describeDeployment(marker)
        record(
          'Deployment marker (/.well-known/srn-deployment.json)',
          !view.unstamped,
          view.unstamped ? (view.note ?? 'No revision recorded.') : `Running revision ${view.revision}.`,
        )
      } catch (error) {
        record('Deployment marker (/.well-known/srn-deployment.json)', false, String(error))
      }

      setOutcomes(results)
    } finally {
      setTesting(false)
      void loadDiagnostics()
      readTransport()
    }
  }, [application, loadDiagnostics, readTransport, transport])

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

  return (
    <>
      <PreferencesSegment>
        <Title>Capability diagnostics</Title>
        <Text>
          What transport this client is actually on, what the server advertises, and — when something is unavailable —
          which specific configuration item is missing. Reports configuration presence only; no value, address or secret
          is read from the server.
        </Text>

        <div className="mt-4 flex items-center gap-3">
          <Subtitle>Transport in use right now</Subtitle>
          <Chip tone={verdict.tone}>{verdict.label}</Chip>
          {loading && <Spinner className="h-4 w-4" />}
        </div>
        <Text className="mt-1">{verdict.detail}</Text>

        <HorizontalSeparator classes="mt-4 mb-4" />

        <Subtitle>Diagnosis</Subtitle>
        <div className="mt-1 flex items-center gap-3">
          <Chip tone={diagnosis.tone}>
            {diagnosis.tone === 'good' ? 'Healthy' : diagnosis.tone === 'warn' ? 'Degraded' : 'Unavailable'}
          </Chip>
          <Text>{diagnosis.headline}</Text>
        </div>
        {loadError && <Text className="text-danger mt-2">{loadError}</Text>}
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

        <div className="mt-4 flex gap-3">
          <Button onClick={() => void loadDiagnostics()} disabled={loading}>
            Refresh
          </Button>
          <Button primary onClick={() => void runTests()} disabled={testing}>
            {testing ? 'Testing…' : 'Test all capabilities'}
          </Button>
        </div>
      </PreferencesSegment>

      <PreferencesSegment>
        <Subtitle>Boot gate</Subtitle>
        <Text>
          The conditions the gateway checks before it builds the realtime sync lane. All four must hold; a single unmet
          condition turns the whole lane off.
        </Text>
        {payload?.gate?.recorded === false && (
          <Text className="text-warning mt-2">
            The server has not recorded a gate decision yet, so no condition below can be confirmed.
          </Text>
        )}
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
                  <span className="text-sm font-semibold">{precondition.code}</span>
                </div>
                <div className="text-passive-0 mt-1 text-sm">{precondition.remedy}</div>
              </li>
            ))
          )}
        </ul>
        {payload?.gate?.files && (
          <Text className="mt-3">
            FILES_V1 transport:{' '}
            {payload.gate.files.advertised
              ? 'advertised by the server.'
              : (payload.gate.files.remedy ?? 'not advertised.')}
          </Text>
        )}
      </PreferencesSegment>

      <PreferencesSegment>
        <Subtitle>Capabilities</Subtitle>
        <Text>
          Every operation either side knows about. &ldquo;Client gap&rdquo; means the server supports it and this client
          build does not — no server configuration will enable it.
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
      </PreferencesSegment>

      <PreferencesSegment>
        <Subtitle>Capability tests</Subtitle>
        <Text>
          Operator-triggered checks that exercise each lane and report the real error. Read-only against your data:
          nothing is written, no invite is sent, nothing is deleted. The ticket check mints a short-lived, single-use
          ticket for your own session, which is never redeemed and expires by itself.
        </Text>
        <Text className="mt-2">{summarizeTestRun(outcomes)}</Text>
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

      <PreferencesSegment>
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
      </PreferencesSegment>
    </>
  )
}

export default AdminDiagnosticsTab
