import {
  SYNC_FALLBACK_REASON_EXPLANATIONS,
  type SyncFallbackReason,
  type SyncNegotiatedOperation,
  type SyncTransportState,
} from '@/Services/SyncTransport/syncTransportProtocol'
import type { DeploymentTopology } from './diagnosticRemedies'

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
 * The operations this client build actually CONSUMES — a negotiated one here
 * carries real traffic.
 *
 * This is deliberately narrower than the protocol union. `SyncNegotiatedOperation`
 * is the set the worker will ACCEPT in an `AUTHENTICATED` frame, which is a
 * different question: the worker rejects the whole handshake on an unrecognized
 * operation, so recognizing one is what stops an advertised lane costing the
 * entire socket. Recognized and consumed are not the same thing, and a panel that
 * conflated them would report a lane as working because the handshake survived it.
 */
export const CLIENT_SYNC_OPERATIONS = [
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  // Consumed since the download lane landed: a negotiated FILES_V1 now carries
  // real encrypted file bytes. Uploads and shared-vault downloads still use HTTP,
  // but this list answers "does a negotiated lane carry traffic", and it does.
  'FILES_V1',
] as const satisfies readonly SyncNegotiatedOperation[]

/**
 * Operations the client recognizes at handshake but does not consume.
 *
 * EMPTY IS A REAL STATE, NOT DEAD CODE — please do not delete this because it has
 * no entries today.
 *
 * Recognizing an operation is what stops an advertised lane costing the ENTIRE
 * socket: the worker rejects any `AUTHENTICATED` frame naming something it does
 * not know, so an unrecognized operation does not disable its own lane, it drops
 * sync, collaboration, RPC and invites to HTTP together. FILES_V1 was exactly
 * that case — advertised by any gateway with a files adapter, unknown to the
 * client, and therefore fatal to the whole socket — then spent time recognized
 * but unconsumed, and only now carries traffic. Every future server-side lane
 * arrives by that same three-step path, and this bucket is the middle step.
 *
 * Deleting it would remove the panel's vocabulary for "negotiated and healthy,
 * but carrying nothing", which is the single row an operator is most likely to
 * misread. Add the next lane here first; move it to CLIENT_SYNC_OPERATIONS only
 * when a client consumer actually exists.
 *
 * Not constrained to `SyncNegotiatedOperation`, so this file compiles whether or
 * not the union has caught up with the worker's accept-set yet.
 */
export const CLIENT_RECOGNIZED_ONLY_OPERATIONS = [] as const

/**
 * Every protocol operation must be classified as consumed or recognized-only.
 * Adding one to `SyncNegotiatedOperation` without deciding which it is makes
 * `UnclassifiedSyncOperation` non-never and fails this file to compile — the
 * panel would otherwise keep rendering a confident, wrong row for it.
 */
type UnclassifiedSyncOperation = Exclude<
  SyncNegotiatedOperation,
  (typeof CLIENT_SYNC_OPERATIONS)[number] | (typeof CLIENT_RECOGNIZED_ONLY_OPERATIONS)[number]
>
type AssertNever<T extends never> = T
export type EverySyncOperationIsClassified = AssertNever<UnclassifiedSyncOperation>

/** Shape of GET /v1/admin/sync-diagnostics. Every field is presence, never value. */
export type SyncDiagnosticsPayload = {
  capturedAt?: string
  /**
   * Topology and configuration presence. Absent on a server build older than
   * this block — which is why every consumer treats `recorded !== true` as
   * "make no topology-conditional claim", rather than as a set of falses.
   */
  deployment?: DeploymentTopology
  gate?: {
    recorded?: boolean
    gatewayAttached?: boolean
    syncLaneEnabled?: boolean
    /**
     * Whether SYNC_ITEMS is offered on that lane. Independent of
     * `syncLaneEnabled` since the boot gate was split: the socket can be up and
     * serving collaboration, API RPC, invite events and files while SYNC_ITEMS
     * is withheld for want of a durable command port, with items syncing over
     * HTTP. Absent on a server build older than that split, which is why every
     * read of it distinguishes `false` from `undefined`.
     */
    syncItemsAdvertised?: boolean
    unmetPreconditions?: { code?: string; remedy?: string }[]
    unmetCodes?: string[]
    files?: { advertised?: boolean; unmetCondition?: string | null; remedy?: string | null }
    /**
     * A condition only the HOST that composed the gateway can see, on top of the
     * shared four. It exists because the shared gate has no word for "this
     * process refused to attach": with a malformed WEBSOCKET_REDIS_NAMESPACE the
     * home server closes its push bridge rather than publish on a sibling
     * stack's un-namespaced channels, and the panel used to report the lane
     * ENABLED, the gateway UNATTACHED and an EMPTY condition list — a screen
     * that was wrong in every field at once.
     *
     * Optional and additive: a host with nothing to add, or a server older than
     * the field, sends no block and the panel reads exactly as it did before.
     */
    host?: { unmetCondition?: string | null; remedy?: string | null }
  }
  live?: {
    capabilities?: { id?: string; version?: number; endpoint?: string }[]
    unavailabilityReasons?: string[]
    ticketAvailable?: boolean
    /**
     * The attached gateway's own health snapshot (C9). INFORMATIONAL — readiness
     * is deliberately not gated on it, because gating would restart the
     * container on a Redis blip. Absent when no gateway is attached at all,
     * which is itself the single most useful thing this block can say.
     */
    realtime?: {
      attached?: boolean
      pushBridge?: string
      pushBridgeReady?: boolean
      sqsConsumerRunning?: boolean
      collaborationRelayHealthy?: boolean
      syncLane?: string
      pushesDispatched?: number
    }
  }
  protocol?: { version?: number; serverOperations?: string[] }
}

/**
 * Redact address- and credential-shaped text from copy the SERVER supplied.
 *
 * The real guarantee is server-side: every remedy string in the payload is a
 * frozen compile-time constant, and the recorder that builds the payload accepts
 * only booleans and literal keys, so there is no field a value can travel in.
 * This is the second line, and it exists because of what the panel is FOR — an
 * operator reads it during an incident and pastes it into an issue, so the cost
 * of one future server change interpolating a resolved URL into a remedy is out
 * of all proportion to the cost of this function.
 *
 * It cannot catch an opaque secret with no structure, and does not pretend to.
 * It catches the shapes that actually leak from this codebase: connection URLs,
 * internal hostnames, host:port pairs and bare addresses — the things a thrown
 * error or an interpolated config value looks like.
 *
 * Applied ONLY to strings that came off the wire. Copy that this build owns is
 * never passed through it, because a redaction there would be a bug, not a save.
 */
export function sanitizeServerCopy(text: string): string {
  return (
    text
      // scheme://anything, which also takes any embedded user:password@ with it
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address withheld]')
      // dotted quad, with or without a port
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '[address withheld]')
      // a hostname of three or more labels ending in an alphabetic TLD. Requiring
      // the final label to be alphabetic is what keeps a version like "1.2.3"
      // intact, and requiring three labels keeps "e.g." and sentence punctuation
      // intact.
      .replace(/\b[a-z0-9][\w-]*(?:\.[\w-]+)+\.[a-z]{2,}(?::\d{1,5})?\b/gi, '[address withheld]')
      // a two-label host WITH a port — "files.internal:3104". Without the port
      // this shape is indistinguishable from ordinary prose, so it is left alone.
      .replace(/\b[a-z][\w-]*\.[a-z]{2,}:\d{1,5}\b/gi, '[address withheld]')
  )
}

export type TransportStatusInput = {
  state: SyncTransportState
  /**
   * The transport's OWN closed code, never server text — which is why it is
   * printed without going through the redactor.
   *
   * Typed as the union rather than `string` deliberately: while this was
   * `string` the panel's own spec asserted on `'ticket-refused'`, a reason that
   * has never existed in the protocol, and neither the compiler nor the test
   * run could tell. A panel whose job is to be believed cannot be pinned to a
   * code the transport cannot emit.
   */
  fallbackReason?: SyncFallbackReason
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
 * What each fallback code MEANS, in an operator's terms.
 *
 * Exhaustive `Record` on purpose: a new reason added to the protocol fails this
 * file to compile rather than rendering as a bare token nobody can act on. The
 * distinction the panel has to carry is whether the operator should change
 * something, wait, or do nothing at all — several of these describe a working
 * system making a correct decision, and reading them as faults sends an
 * operator after a problem that does not exist.
 */
const FALLBACK_REASON_COPY: Record<SyncFallbackReason, string> = SYNC_FALLBACK_REASON_EXPLANATIONS

/**
 * What lane this client is on RIGHT NOW, and why. When the transport reports a
 * fallback reason it is appended verbatim — those are the transport's own closed
 * codes, not free text from the server — followed by what that code means.
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

  if (!status.fallbackReason) {
    return { ...copy }
  }

  const meaning = FALLBACK_REASON_COPY[status.fallbackReason]

  return {
    ...copy,
    detail: `${copy.detail} Reported reason: ${status.fallbackReason}.${meaning ? ` ${meaning}` : ''}`,
  }
}

export type CapabilityStatus = 'active' | 'not-negotiated' | 'client-gap' | 'recognized-only' | 'unknown'

export type CapabilityRow = {
  operation: string
  /** The server build knows how to negotiate this operation. */
  serverSupported: boolean
  /** This client build CONSUMES it — not merely tolerates it at handshake. */
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
  const recognizedOnly = new Set<string>(CLIENT_RECOGNIZED_ONLY_OPERATIONS)
  const negotiatedSet = new Set(negotiated)
  const operations = [
    ...new Set([...serverOperations, ...CLIENT_SYNC_OPERATIONS, ...CLIENT_RECOGNIZED_ONLY_OPERATIONS, ...negotiated]),
  ].sort()

  return operations.map((operation) => {
    const onServer = serverOperations.includes(operation)
    const onClient = clientImplemented.has(operation)
    const isNegotiated = negotiatedSet.has(operation)

    let status: CapabilityStatus
    let tone: Tone
    let explanation: string

    // Recognized-only is checked BEFORE negotiated on purpose: such an operation
    // appears in a healthy handshake and still carries nothing, so calling it
    // active because it was negotiated would be a confident lie. No operation is
    // in that bucket today — FILES_V1 was, until the download lane began consuming
    // it — but the ordering is the invariant, not the occupant, so it stays
    // correct for whichever lane lands server-side first next.
    if (recognizedOnly.has(operation)) {
      status = 'recognized-only'
      tone = 'warn'
      explanation = isNegotiated
        ? 'Negotiated, but this client only tolerates it at the handshake — it has no handler, so the lane carries nothing and its traffic stays on HTTP. Recognising it is what stops the advertisement dropping the whole socket.'
        : 'This client tolerates this operation at the handshake but has no handler for it, so it carries nothing. Not a misconfiguration — it needs a client change.'
    } else if (isNegotiated) {
      status = 'active'
      tone = 'good'
      explanation = 'Negotiated on the live socket and carrying traffic.'
    } else if (onServer && !onClient) {
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
      // The operation name is a closed protocol token in a correct server, and
      // this row is printed into the copyable report, so it is redacted like any
      // other string that arrived over the wire.
      operation: sanitizeServerCopy(operation),
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
 * The Boot gate section's header, kept here rather than inline in the JSX so the
 * wording is testable without a DOM — the same reason every other decision about
 * what the operator is TOLD lives in this module.
 *
 * It is a correction, not a refresh. The header used to read "All four must
 * hold; a single unmet condition turns the whole lane off", which had been
 * false since the gate was split and was contradicted by the "Lane up" chip
 * rendered directly beneath it. An operator reading a live lane described as
 * dead stops believing the screen, and the screen's only asset is that it can
 * be believed.
 */
export const BOOT_GATE_HEADER =
  'The conditions the gateway checks at boot. THREE of them gate the socket lane itself — the connection-token ' +
  'secret, shared Redis state, and the WEBSOCKET_SYNC_ENABLED kill switch — and an unmet one closes the lane ' +
  'outright. The fourth, the durable gRPC backend, withholds SYNC_ITEMS ONLY: the socket stays up and keeps ' +
  'carrying collaboration, API RPC, invite events and files while note syncing falls back to HTTP. Each unmet ' +
  'condition below carries the fix for THIS deployment’s topology, which is not always the fix the condition’s ' +
  'own name suggests.'

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

  // Every string below arrives from the server, so every one of them goes through
  // the redactor on the way in. Codes and reasons are closed enums in a correct
  // server, but "in a correct server" is exactly the assumption a leak breaks.
  const unmet = gate.unmetPreconditions ?? []
  for (const precondition of unmet) {
    findings.push({
      title: sanitizeServerCopy(precondition.code ?? 'Unknown unmet condition'),
      detail: sanitizeServerCopy(precondition.remedy ?? 'No remedy was reported for this condition.'),
    })
  }

  // The HOST's own condition. A current server already merges it into
  // `unmetPreconditions`, so this fires only when it did not — and it is
  // deduplicated by code rather than trusted to be absent, because printing a
  // condition twice is a cosmetic fault and dropping one is the fault this
  // whole block exists to prevent.
  const hostCondition = gate.host?.unmetCondition
  const hostConditionUnlisted =
    typeof hostCondition === 'string' &&
    hostCondition.length > 0 &&
    !unmet.some((precondition) => precondition.code === hostCondition)
  if (hostConditionUnlisted) {
    findings.push({
      title: sanitizeServerCopy(hostCondition),
      detail: sanitizeServerCopy(gate.host?.remedy ?? 'No remedy was reported for this condition.'),
    })
  }

  // A lane the gate calls enabled on a host that recorded no attach. The two
  // come from different places — the gate records a DECISION, the composition
  // root records an OUTCOME — so they can disagree, and the panel must say so
  // instead of choosing the cheerful one. This is the screen an invalid
  // WEBSOCKET_REDIS_NAMESPACE produced before the host reported its own
  // condition: lane enabled, gateway unattached, not one condition named.
  // Worded to stay true on an older server too, where the attach outcome was
  // simply never recorded and `false` means "not reported" rather than "no".
  if (gate.recorded === true && gate.gatewayAttached === false && gate.syncLaneEnabled === true) {
    findings.push({
      title: 'The lane is enabled but no attached gateway was recorded',
      detail:
        'The boot gate built the sync lane and the host recorded no successful gateway attach. On a current server build that combination means the host declined to attach AFTER the gate passed — an invalid WEBSOCKET_REDIS_NAMESPACE does exactly this, closing the push bridge rather than publishing on a sibling stack’s channels — so tickets mint while nothing is ever delivered. On a server older than the attach-outcome record the field is never set and this line only means it was not reported.',
    })
  }

  // Live refusals only add information when the LANE itself came up; otherwise
  // they merely restate the gate. Keyed on the lane rather than on "no unmet
  // conditions at all", because since the gate was split an unmet
  // SYNCING_SERVER_GRPC_UNBOUND no longer stops the lane — suppressing live
  // reasons on its account would hide a real, independent refusal.
  // A server that predates the split reports no `syncLaneEnabled`, and on that
  // build ANY unmet condition did take the lane down — so the old rule is the
  // correct reading of an old payload, and the new field is the correct reading
  // of a new one. Treating a missing field as "up" would make an old server's
  // gate failure print its live reason twice.
  const unmetCount = unmet.length + (hostConditionUnlisted ? 1 : 0)
  const laneDown = gate.syncLaneEnabled === false || (gate.syncLaneEnabled === undefined && unmetCount > 0)
  if (!laneDown) {
    for (const reason of live.unavailabilityReasons ?? []) {
      findings.push({
        title: sanitizeServerCopy(reason),
        detail: LIVE_REASON_COPY[reason] ?? 'The gateway reported this refusal reason.',
      })
    }
  }

  // A lane that is up and can never deliver a push. The gate cannot see this:
  // it decides whether to BUILD the lane, and the push bridge is a separate
  // attach-time outcome. Reported as a finding rather than left to the health
  // rows because "realtime is on" and "your other devices are never told
  // anything changed" look identical from every other panel on this screen.
  //
  // `'none'` is a MISCONFIGURATION, not a topology. It stopped describing "a
  // deployment without Redis" when the in-process shared-state plane landed: a
  // single process that holds every socket now reports `'in-process'` and is
  // healthy, because delivery is a function call into the same registry the
  // Redis subscriber would have fed. What is left is a process asked for the
  // Redis-backed plane with no host to reach. Saying "you have no Redis" here
  // would send a single-container operator to install one they do not need,
  // and would contradict the Push bridge row on this same screen.
  if (live.realtime?.attached === true && live.realtime.pushBridge === 'none') {
    findings.push({
      title: 'The socket is attached with no push bridge',
      detail:
        'The lane accepts clients, but nothing carries server-side change notifications to them, so a save on one device never reaches another until that device syncs on its own. This is a misconfiguration rather than a topology: a process that was asked for a Redis-backed plane without a reachable Redis host. A deployment that simply has no Redis reports an in-process bridge instead and is healthy, and a multi-container one reports redis — only "none" is a fault. The other way to reach it is a server build older than the in-process plane, which an upgrade fixes rather than any setting.',
    })
  }

  if (gate.files?.advertised === false && gate.files.unmetCondition) {
    findings.push({
      title: `FILES_V1 not advertised (${sanitizeServerCopy(gate.files.unmetCondition)})`,
      detail: sanitizeServerCopy(gate.files.remedy ?? 'The realtime file transport was waived at boot.'),
    })
  }

  const serverOperations = payload.protocol?.serverOperations ?? []
  const clientGaps = serverOperations.filter(
    (operation) =>
      !(CLIENT_SYNC_OPERATIONS as readonly string[]).includes(operation) &&
      !(CLIENT_RECOGNIZED_ONLY_OPERATIONS as readonly string[]).includes(operation),
  )
  if (clientGaps.length > 0) {
    findings.push({
      title: `This client does not implement ${clientGaps.join(', ')}`,
      detail:
        'The server build can negotiate these operations but this client build has no handler for them, so they will never be used. Nothing on the server fixes this — it needs a client change.',
    })
  }

  // Reported separately from an outright gap: these DO appear in the handshake,
  // so they look healthy everywhere else, and they carry nothing.
  const recognizedOnly = serverOperations.filter((operation) =>
    (CLIENT_RECOGNIZED_ONLY_OPERATIONS as readonly string[]).includes(operation),
  )
  if (recognizedOnly.length > 0) {
    findings.push({
      title: `${recognizedOnly.join(', ')} is advertised but carries nothing`,
      detail:
        'This client recognises the operation at the handshake so the advertisement does not cost the socket, but it has no handler, so that traffic stays on HTTP. It needs a client change, not server configuration.',
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
  // "Blocking" means the LANE cannot come up — not merely that some condition is
  // unmet. Since the boot gate was split, an unmet durable-backend condition
  // withholds SYNC_ITEMS while the socket still carries collaboration, API RPC,
  // invite events and files. Calling that "unavailable" would be the panel's
  // worst possible error: it would send an operator chasing a dead lane that is
  // in fact up, and it would hide the one operation that really is missing.
  const blocking = laneDown || live.ticketAvailable === false
  const itemsWithheld = !blocking && gate.syncItemsAdvertised === false

  if (itemsWithheld) {
    return {
      headline:
        'The realtime lane is up, but SYNC_ITEMS is not advertised — note syncing is on HTTP while everything else uses the socket.',
      tone: 'warn',
      findings,
    }
  }

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

export type RealtimeHealthRow = {
  label: string
  /** Short, closed-enum-shaped answer. Never a configured value. */
  value: string
  tone: Tone
  /** What this row means when it reads badly — and, as often, when it does not. */
  note: string
}

/**
 * What the panel says when the server reports no `live.realtime` block at all.
 *
 * Two very different causes share this shape, and the sentence has to cover
 * both without asserting either: no gateway is attached to this process, or the
 * server build predates the health snapshot. Guessing between them is how a
 * panel earns its reputation for being wrong.
 */
export const REALTIME_UNATTACHED_NOTE =
  'This server reported no realtime health snapshot. Either no websocket gateway is attached to the process that answered — in which case nothing is delivered over the socket, whatever the boot gate says — or this build predates the snapshot. The Boot gate section distinguishes the two.'

/**
 * The attached gateway's own view of itself (C9), as rows an operator can read.
 *
 * INFORMATIONAL BY DESIGN, and the rows say so where it matters. Readiness is
 * deliberately not gated on any of this, because a container that restarts
 * itself on a Redis blip converts a ten-second degradation into an outage. The
 * panel's job is to make the degradation VISIBLE, not to act on it.
 */
export function describeRealtimeHealth(
  realtime: NonNullable<SyncDiagnosticsPayload['live']>['realtime'],
): RealtimeHealthRow[] {
  if (!realtime) {
    return []
  }

  const bridge = realtime.pushBridge ?? 'unknown'
  const bridgeBound = bridge === 'redis' || bridge === 'in-process'
  const bridgeValue = bridgeBound
    ? `${sanitizeServerCopy(bridge)} (${realtime.pushBridgeReady ? 'ready' : 'not ready'})`
    : 'none'

  /**
   * `redis` and `in-process` are BOTH bound and both healthy — a single process
   * that holds every socket needs no Redis to deliver a push, because delivery
   * is a function call into the same registry a Redis subscriber would feed.
   * They are still told apart here rather than merged into one cheerful
   * sentence: the in-process plane only reaches sockets THIS process holds, so
   * an operator about to add a second replica needs to know which one they have.
   */
  const bridgeNote = !bridgeBound
    ? 'Nothing carries server-side change notifications, so a change saved on one device is never pushed to another. This is a misconfiguration rather than a topology: a process asked for a Redis-backed plane with no reachable Redis host. A deployment that simply has no Redis reports an in-process bridge instead and is healthy, and a multi-container one reports redis. A server build older than the in-process plane also lands here, and needs an upgrade rather than a setting.'
    : !realtime.pushBridgeReady
      ? 'The bridge is bound but its client is not ready — a reconnect window. It recovers on its own; nothing here needs a restart.'
      : bridge === 'in-process'
        ? 'Pushes are delivered in-process, to the sockets this process holds, so no Redis is needed for them. Correct for a single process serving every socket; a second replica would need the Redis plane to reach sockets it does not hold itself.'
        : 'The push subscriber is connected, so changes committed elsewhere — including on another replica — are delivered to live sockets.'

  return [
    {
      label: 'Gateway',
      value: realtime.attached === true ? 'attached' : 'not attached',
      tone: realtime.attached === true ? 'good' : 'bad',
      note:
        realtime.attached === true
          ? 'A websocket gateway is attached to this process, so sockets can be accepted and tokens minted.'
          : 'No gateway is attached to the process that answered. Nothing reaches a client over a socket, regardless of what the boot gate decided.',
    },
    {
      label: 'Push bridge',
      value: bridgeValue,
      tone: !bridgeBound ? 'bad' : realtime.pushBridgeReady ? 'good' : 'warn',
      note: bridgeNote,
    },
    {
      label: 'Queue consumer',
      value: realtime.sqsConsumerRunning ? 'running' : 'not running',
      tone: realtime.sqsConsumerRunning ? 'good' : 'neutral',
      note: realtime.sqsConsumerRunning
        ? 'The realtime queue consumer loop is running and draining websocket events.'
        : 'No queue consumer is running. Expected where pushes are delivered through the bridge alone; on a stack that provisions the websocket queue this means those events are not being drained.',
    },
    {
      label: 'Collaboration relay',
      value: realtime.collaborationRelayHealthy ? 'healthy' : 'unhealthy',
      tone: realtime.collaborationRelayHealthy ? 'good' : 'warn',
      note: realtime.collaborationRelayHealthy
        ? 'Room traffic is relayed fleet-wide, so collaborators served by different replicas see each other.'
        : 'The relay subscription is not established. Collaboration still works between clients on the SAME replica, which is why this fails quietly on a multi-replica deployment.',
    },
    {
      label: 'Sync lane',
      value: realtime.syncLane === 'up' ? 'up' : 'down',
      tone: realtime.syncLane === 'up' ? 'good' : 'bad',
      note:
        realtime.syncLane === 'up'
          ? 'The gateway would admit a client on /sockets/sync right now.'
          : 'The gateway would refuse a client on /sockets/sync right now. The live refusal reasons above say why.',
    },
    {
      label: 'Pushes dispatched',
      value: String(realtime.pushesDispatched ?? 0),
      tone: 'neutral',
      note: 'Push messages handed to local sockets since this gateway attached. It resets on every restart; a count that stays at zero on a busy deployment is the signature of a delivery path that never fires.',
    },
  ]
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
  // The marker is served by whatever is in front of the web bundle, so it is
  // untrusted input like any other server string — and both fields are printed
  // into the copyable report. A real revision (40 hex) and a real version token
  // pass through the redactor untouched.
  const revision = typeof marker.revision === 'string' ? sanitizeServerCopy(marker.revision) : ''
  const version = typeof marker.version === 'string' ? sanitizeServerCopy(marker.version) : ''

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
  /**
   * Shown in the panel. MAY embed a thrown message — an exception from `fetch`
   * can carry the URL it was attempting, and that detail is worth having in
   * front of the operator who already knows their own hosts.
   */
  detail: string
  /**
   * The same outcome, reduced to constant copy and closed codes, for the
   * copyable report. Separated from `detail` STRUCTURALLY rather than by
   * sanitising at copy time: the report is written to be pasted somewhere
   * public, and a regex that tries to strip hosts out of an arbitrary thrown
   * message is a guess, whereas never putting one in is a guarantee.
   */
  reportDetail: string
}

/** Human summary of a completed test run, for the header line. */
export function summarizeTestRun(outcomes: readonly CapabilityTestOutcome[]): string {
  if (outcomes.length === 0) {
    return 'No tests have been run yet.'
  }
  const passed = outcomes.filter((outcome) => outcome.passed).length
  return `${passed} of ${outcomes.length} checks passed.`
}
