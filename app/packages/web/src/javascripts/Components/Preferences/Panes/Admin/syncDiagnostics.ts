import type { SyncNegotiatedOperation, SyncTransportState } from '@/Services/SyncTransport/syncTransportProtocol'

/**
 * Standard Red Notes: the model behind the admin Diagnostics tab.
 *
 * The tab exists to answer, in one screen, four questions this deployment has
 * repeatedly been unable to answer about itself: what transport am I on, what is
 * advertised, what is broken, and exactly which configuration item is missing.
 * The rendering lives in AdminDiagnosticsTab.tsx; everything that decides what
 * the operator is TOLD lives here, so the wording of a diagnosis is testable
 * without a DOM.
 *
 * SECURITY: nothing in this module ever receives a configured value. The server
 * payload it consumes carries booleans and closed-enum codes only (enforced in
 * SyncGateDiagnostics on the server); this module must not introduce a field
 * that would carry one.
 */

/**
 * The operations THIS CLIENT BUILD implements. Deliberately spelled out rather
 * than derived: the client protocol's `SyncNegotiatedOperation` union is the
 * definition of what the client can handle, so a `satisfies` check against it
 * turns a protocol change into a compile error here.
 *
 * Note what is absent: FILES_V1. The server protocol defines it and a configured
 * gateway advertises it, but the client has no implementation, so file transfers
 * do not use the socket lane no matter how the server is configured. That gap is
 * invisible in every other surface, which is why the tab reports it explicitly.
 */
export const CLIENT_SYNC_OPERATIONS = [
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
] as const satisfies readonly SyncNegotiatedOperation[]

/** Shape of GET /v1/admin/sync-diagnostics. Every field is presence, never value. */
export type SyncDiagnosticsPayload = {
  capturedAt?: string
  gate?: {
    recorded?: boolean
    gatewayAttached?: boolean
    syncLaneEnabled?: boolean
    unmetPreconditions?: { code?: string; remedy?: string }[]
    unmetCodes?: string[]
    files?: { advertised?: boolean; unmetCondition?: string | null; remedy?: string | null }
  }
  live?: {
    capabilities?: { id?: string; version?: number; endpoint?: string }[]
    unavailabilityReasons?: string[]
    ticketAvailable?: boolean
  }
  protocol?: { version?: number; serverOperations?: string[] }
}

export type TransportStatusInput = {
  state: SyncTransportState
  fallbackReason?: string
  operations: readonly SyncNegotiatedOperation[]
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral'

export type TransportVerdict = {
  label: string
  tone: Tone
  detail: string
}

const TRANSPORT_COPY: Record<SyncTransportState, { label: string; tone: Tone; detail: string }> = {
  HTTP_ONLY: {
    label: 'HTTP',
    tone: 'warn',
    detail:
      'The socket lane was never entered. Every sync, invite and collaboration call goes over plain HTTP requests.',
  },
  CONNECTING: {
    label: 'Connecting',
    tone: 'neutral',
    detail: 'Opening the socket. Requests are on HTTP until it is authenticated.',
  },
  AUTHENTICATING: {
    label: 'Authenticating',
    tone: 'neutral',
    detail: 'The socket is open and presenting its ticket. No operations are negotiated yet.',
  },
  READY: {
    label: 'WebSocket',
    tone: 'good',
    detail: 'The socket lane is live and carrying the negotiated operations below.',
  },
  DEGRADED: {
    label: 'WebSocket (degraded)',
    tone: 'warn',
    detail: 'The socket is up but is not carrying everything it should. Individual operations fall back to HTTP.',
  },
  HTTP_FALLBACK: {
    label: 'HTTP (fell back)',
    tone: 'warn',
    detail: 'The socket lane was attempted and abandoned. Everything is on HTTP until the next attempt.',
  },
  HALF_OPEN: {
    label: 'Reconnecting',
    tone: 'warn',
    detail: 'The socket is being re-established after a failure. Requests are on HTTP in the meantime.',
  },
}

/**
 * What lane this client is on RIGHT NOW, and why. When the transport reports a
 * fallback reason it is appended verbatim — those are the transport's own closed
 * codes, not free text from the server.
 */
export function describeTransport(status: TransportStatusInput | undefined): TransportVerdict {
  if (!status) {
    return {
      label: 'HTTP',
      tone: 'warn',
      detail:
        'No realtime transport is installed in this client at all, so there is nothing to fall back FROM — every request is an HTTP request.',
    }
  }

  const copy = TRANSPORT_COPY[status.state] ?? {
    label: status.state,
    tone: 'neutral' as Tone,
    detail: 'Unrecognised transport state.',
  }

  return {
    ...copy,
    detail: status.fallbackReason ? `${copy.detail} Reported reason: ${status.fallbackReason}.` : copy.detail,
  }
}

export type CapabilityStatus = 'active' | 'not-negotiated' | 'client-gap' | 'unknown'

export type CapabilityRow = {
  operation: string
  /** The server build knows how to negotiate this operation. */
  serverSupported: boolean
  /** This client build implements a handler for it. */
  clientImplemented: boolean
  /** This client's current socket actually negotiated it. */
  negotiated: boolean
  status: CapabilityStatus
  tone: Tone
  explanation: string
}

/**
 * One row per operation in the union of what either side knows about, so an
 * operation missing from ONE side is still visible — a row that silently
 * disappears is exactly the failure mode this tab exists to end.
 */
export function buildCapabilityRows(
  serverOperations: readonly string[],
  negotiated: readonly string[],
  socketIsLive: boolean,
): CapabilityRow[] {
  const clientImplemented = new Set<string>(CLIENT_SYNC_OPERATIONS)
  const negotiatedSet = new Set(negotiated)
  const operations = [...new Set([...serverOperations, ...CLIENT_SYNC_OPERATIONS, ...negotiated])].sort()

  return operations.map((operation) => {
    const onServer = serverOperations.includes(operation)
    const onClient = clientImplemented.has(operation)
    const isNegotiated = negotiatedSet.has(operation)

    let status: CapabilityStatus
    let tone: Tone
    let explanation: string

    if (isNegotiated) {
      status = 'active'
      tone = 'good'
      explanation = 'Negotiated on the live socket and carrying traffic.'
    } else if (onServer && !onClient) {
      // The FILES_V1 case: a correctly configured server advertises it and this
      // client still cannot use it. No amount of server configuration fixes it.
      status = 'client-gap'
      tone = 'warn'
      explanation =
        'The server build supports this operation but this client build does not implement it, so it will never be used no matter how the server is configured. This is a client gap, not a misconfiguration.'
    } else if (onClient && !onServer) {
      status = 'unknown'
      tone = 'warn'
      explanation =
        'This client implements the operation but the server build does not advertise it. The server is likely older than the client.'
    } else if (!socketIsLive) {
      status = 'unknown'
      tone = 'neutral'
      explanation =
        'Both sides support this operation, but no socket is negotiated right now so it cannot be confirmed. It falls back to HTTP.'
    } else {
      status = 'not-negotiated'
      tone = 'bad'
      explanation =
        'Both sides support this operation and a socket IS live, but it was not offered at authentication — the adapter behind it did not compose at boot.'
    }

    return {
      operation,
      serverSupported: onServer,
      clientImplemented: onClient,
      negotiated: isNegotiated,
      status,
      tone,
      explanation,
    }
  })
}

export type Diagnosis = {
  /** Short headline: what is wrong, in one clause. */
  headline: string
  tone: Tone
  /** Ordered, specific findings. Each names the thing to change where one exists. */
  findings: { title: string; detail: string }[]
}

const LIVE_REASON_COPY: Record<string, string> = {
  'sync-not-configured': 'The sync lane was never composed at boot — see the gate conditions above.',
  'gateway-stopping': 'The gateway is shutting down and is refusing new tickets. Expected during a restart.',
  'disabled-by-configuration': 'WEBSOCKET_SYNC_ENABLED is set to the exact string "false".',
  'no-allowed-origins':
    'No request origin is permitted. Set WEBSOCKET_SYNC_ALLOWED_ORIGINS, or PUBLIC_URL so same-origin is derived.',
  'ticket-store-unavailable': 'The shared ticket store is not answering. Redis is bound but unhealthy.',
  'command-lease-store-unavailable': 'The shared command-lease store is not answering. Redis is bound but unhealthy.',
  'socket-budget-store-unavailable': 'The shared socket-budget store is not answering. Redis is bound but unhealthy.',
  'authorization-adapter-unavailable': 'The collaboration authorization adapter is not ready.',
  'durable-backend-unavailable': 'The durable syncing backend is not reachable over gRPC.',
  'invite-event-store-unavailable': 'The durable invite-event store is not answering. Redis is bound but unhealthy.',
}

/**
 * The highest-value output of this tab: turn "unavailable" into the one thing an
 * operator has to change.
 *
 * The order matters. Boot-gate conditions come first because nothing downstream
 * can succeed while one is unmet, and a live refusal reason on top of an unmet
 * gate is a consequence, not an independent problem.
 */
export function diagnose(
  payload: SyncDiagnosticsPayload | undefined,
  transport: TransportStatusInput | undefined,
): Diagnosis {
  const findings: Diagnosis['findings'] = []

  if (!payload) {
    return {
      headline: 'Diagnostics could not be read from the server.',
      tone: 'bad',
      findings: [
        {
          title: 'No response from /v1/admin/sync-diagnostics',
          detail:
            'Either the running build predates this endpoint, or the request was rejected. If the build is current, check that your session carries the admin role.',
        },
      ],
    }
  }

  const gate = payload.gate ?? {}
  const live = payload.live ?? {}

  if (gate.recorded === false) {
    findings.push({
      title: 'The boot gate has not been recorded',
      detail:
        'The server answered but has no record of the sync gate decision — it is still starting, or this build does not record it. The conditions below cannot be trusted yet; reload in a moment.',
    })
  }

  const unmet = gate.unmetPreconditions ?? []
  for (const precondition of unmet) {
    findings.push({
      title: precondition.code ?? 'Unknown unmet condition',
      detail: precondition.remedy ?? 'No remedy was reported for this condition.',
    })
  }

  // Live refusals only add information when the gate itself is satisfied;
  // otherwise they merely restate it.
  if (unmet.length === 0) {
    for (const reason of live.unavailabilityReasons ?? []) {
      findings.push({ title: reason, detail: LIVE_REASON_COPY[reason] ?? 'The gateway reported this refusal reason.' })
    }
  }

  if (gate.files?.advertised === false && gate.files.unmetCondition) {
    findings.push({
      title: `FILES_V1 not advertised (${gate.files.unmetCondition})`,
      detail: gate.files.remedy ?? 'The realtime file transport was waived at boot.',
    })
  }

  const serverOperations = payload.protocol?.serverOperations ?? []
  const clientGaps = serverOperations.filter(
    (operation) => !(CLIENT_SYNC_OPERATIONS as readonly string[]).includes(operation),
  )
  if (clientGaps.length > 0) {
    findings.push({
      title: `This client does not implement ${clientGaps.join(', ')}`,
      detail:
        'The server build can negotiate these operations but this client build has no handler for them, so they will never be used. Nothing on the server fixes this — it needs a client change.',
    })
  }

  if (findings.length === 0) {
    return {
      headline: 'The realtime sync lane is fully configured and available.',
      tone: 'good',
      findings: [],
    }
  }

  const socketDown = transport === undefined || transport.state === 'HTTP_ONLY' || transport.state === 'HTTP_FALLBACK'
  const blocking = unmet.length > 0 || live.ticketAvailable === false

  return {
    headline: blocking
      ? socketDown
        ? 'Everything is running over HTTP because the realtime sync lane is unavailable.'
        : 'The realtime sync lane is unavailable on the server.'
      : 'The realtime sync lane is available, with gaps.',
    tone: blocking ? 'bad' : 'warn',
    findings,
  }
}

export type DeploymentIdentityView = {
  revision: string
  version: string
  /** True when the build explicitly recorded that it was never stamped. */
  unstamped: boolean
  tone: Tone
  note: string | null
}

/**
 * Read /.well-known/srn-deployment.json into something an operator can act on.
 *
 * The marker exists to answer one question during an incident — which commit is
 * live — and it shipped serving empty strings, which is indistinguishable from a
 * serialization bug. An unstamped build now records the explicit `unstamped`
 * sentinel, so this renders that as a stated fact rather than a blank cell; a
 * still-blank value is reported as the older, ambiguous form it is.
 */
export function describeDeployment(raw: unknown): DeploymentIdentityView {
  const marker = (raw ?? {}) as { revision?: unknown; version?: unknown }
  const revision = typeof marker.revision === 'string' ? marker.revision : ''
  const version = typeof marker.version === 'string' ? marker.version : ''

  if (revision === 'unstamped') {
    return {
      revision: 'unstamped',
      version: version || 'unstamped',
      unstamped: true,
      tone: 'warn',
      note: 'This build did not record a revision. It was built without SRN_DEPLOY_REVISION, so "is the running build current?" cannot be answered from here.',
    }
  }

  if (revision === '') {
    return {
      revision: '—',
      version: version || '—',
      unstamped: true,
      tone: 'bad',
      note: 'The marker is blank rather than carrying the "unstamped" sentinel, so this build predates the deployment-marker fix. Its revision is unknown and unknowable.',
    }
  }

  return { revision, version: version || '—', unstamped: false, tone: 'good', note: null }
}

export type CapabilityTestOutcome = {
  name: string
  passed: boolean
  detail: string
}

/** Human summary of a completed test run, for the header line. */
export function summarizeTestRun(outcomes: readonly CapabilityTestOutcome[]): string {
  if (outcomes.length === 0) {
    return 'No tests have been run yet.'
  }
  const passed = outcomes.filter((outcome) => outcome.passed).length
  return `${passed} of ${outcomes.length} checks passed.`
}
