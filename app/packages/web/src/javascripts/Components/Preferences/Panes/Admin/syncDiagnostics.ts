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
    /**
     * The SYNC_ITEMS verdict in FULL: three states, a closed cause, and the
     * frozen remedy copy for that cause. This is the block the boolean above
     * cannot express — `WITHHELD` for want of a ready durable backend appears in
     * NO unmet condition (the port is bound, so nothing is unmet), and
     * `NOT_OBSERVED` is not a boolean value at all.
     *
     * Typed with WIDE strings rather than the closed unions on purpose. These are
     * the SERVER's enums and this build cannot be recompiled against a newer
     * server, so `state` and `cause` are parsed against THIS build's own lists
     * (`SYNC_ITEMS_STATES`, `SYNC_ITEMS_CAUSES`) in `describeSyncItems`, and a
     * member added server-side degrades to "this client does not recognise it"
     * instead of being rendered as one of the members it does know. Declaring the
     * unions here would make that mismatch unrepresentable in the type and
     * therefore unhandled in the code.
     *
     * Absent on a server build older than the verdict. `describeSyncItems` treats
     * a missing block as NO CLAIM rather than falling back to
     * `syncItemsAdvertised`, because on those builds that boolean was derived from
     * whether a proxy OBJECT had been constructed — not from the predicate the
     * handshake actually asks — and it read `true` over sockets that withheld the
     * operation. The panel does not repeat a claim that was wrong in the
     * operator's favour.
     */
    syncItems?: { state?: string; cause?: string | null; remedy?: string | null; probe?: string }
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

/**
 * Every tone the panel can render, as a VALUE as well as a type.
 *
 * `Tone` is derived from this list rather than written out as a bare union so
 * that "exhaustive over the tones" is checkable by a test and not only by the
 * compiler. The bug this closes was a ternary chain that mapped two tones to
 * labels and silently gave every other tone — `'neutral'`, which means "no
 * verdict" — the label "Unavailable", a confident claim about the socket. A
 * `Record<Tone, …>` catches that at compile time; iterating this list catches a
 * mapping that compiles and is still wrong.
 *
 * `'neutral'` is not a spare slot: it is already the tone for CONNECTING and
 * AUTHENTICATING transports and for a capability that cannot be confirmed either
 * way. It means the panel does not know, which is a different thing from bad.
 */
export const TONES = ['good', 'warn', 'bad', 'neutral'] as const

export type Tone = (typeof TONES)[number]

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
 * Why the diagnostics endpoint could not be read, when it could not.
 *
 * Supplied ONLY when a read was actually attempted and failed, which keeps three
 * states apart that the panel used to collapse into one: not read yet
 * (`undefined`), answered with a status (`status` set), and never completed at
 * all (`status` absent). Each wants different words, and the old single sentence
 * was wrong for most of them.
 */
export type DiagnosticsReadFailure = {
  /**
   * The HTTP status the endpoint answered with. Absent when the request never
   * completed — offline client, proxy, server not running — which is a different
   * fact from any status and gets different guidance.
   */
  status?: number
}

/**
 * What to tell the operator when the diagnostics could not be READ.
 *
 * *** BRANCHED ON THE STATUS, because the statuses exclude each other. ***
 *
 * The one sentence this replaces read "Either the running build predates this
 * endpoint, or the request was rejected. If the build is current, check that
 * your session carries the admin role." — and on a 401 the admin role is the one
 * cause the status rules OUT. In the api-gateway,
 * `AdminController.getSyncDiagnostics` answers 403 with "Admin role required."
 * when the requestor is not an admin; a 401 comes from
 * `ApiGateway_RequiredCrossServiceTokenMiddleware`, declared on the same route
 * and therefore run BEFORE the role check ever happens. So a 401 means the
 * request was never authenticated, and sending that operator to audit their
 * roles is a guaranteed dead end.
 *
 * NO CAUSE IS STATED AS FACT HERE. Each entry says what the status MEANS and
 * what to check; a mechanism that is merely plausible is named as a possibility,
 * because this panel's only asset is that it can be believed.
 */
export function describeDiagnosticsReadFailure(failure: DiagnosticsReadFailure): Diagnosis['findings'][number] {
  const status = failure.status

  if (status === 401) {
    return {
      title: 'The diagnostics request was not authenticated (401)',
      detail:
        'The server rejected the request before it reached any role check, so this is NOT an admin-role problem — this endpoint answers 403 for that, and it answered 401. Reload the page; if that does not clear it, sign out and back in. One mechanism worth knowing on this deployment: an admin request can travel over the websocket API_RPC lane, and that lane carries a session credential captured once when the socket ticket was minted and never refreshed afterwards, so a session renewed since the socket connected can be refused there while plain HTTP requests still succeed. Reconnecting the socket, or a reload, re-mints it.',
    }
  }

  if (status === 403) {
    return {
      title: 'The diagnostics request was refused (403)',
      detail:
        'The request WAS authenticated and was then refused on authorization: this endpoint requires the admin role and this session does not carry it. Grant the role to the account, then sign out and back in so a new session picks it up — an existing session keeps the roles it was issued with.',
    }
  }

  if (status === 404) {
    return {
      title: 'This server build has no diagnostics endpoint (404)',
      detail:
        'The running build predates /v1/admin/sync-diagnostics. No configuration change reaches this one; deploy a build that includes the endpoint. The deployment identity on this screen says which build is actually live.',
    }
  }

  if (status !== undefined) {
    return {
      title: `The diagnostics endpoint answered ${status}`,
      detail:
        'The request reached the server and came back without a diagnosis, so none of the server-reported sections could be filled in. That is a fault in answering this request; it is not a report about the socket lane. The gateway log for the request is the next place to look.',
    }
  }

  return {
    title: 'The diagnostics endpoint could not be reached',
    detail:
      'The request never completed, so none of the server-reported sections could be filled in. That is a reachability problem between this client and the server — an offline client, a proxy in the way, or a server that is not running — and it says nothing about the socket lane.',
  }
}

/**
 * ---------------------------------------------------------------------------
 * SYNC_ITEMS: three states, never two.
 * ---------------------------------------------------------------------------
 *
 * The server reports this verdict in full — `state`, a closed `cause`, and the
 * frozen remedy copy for that cause — and until this module read it the panel
 * rendered a single boolean with a two-arm ternary. That lost BOTH halves of the
 * server's answer:
 *
 *   - `NOT_OBSERVED` has no boolean value, so the server omits the boolean
 *     entirely and the chip simply vanished. "The gate cannot say" is a thing an
 *     operator needs told; a missing chip is indistinguishable from a panel that
 *     has not finished loading.
 *   - `WITHHELD` printed the word "Withheld" and nothing else, while the one
 *     cause an operator can actually FIX — `DURABLE_BACKEND_NOT_READY`, a missing
 *     or under-length internal gRPC secret, or an empty `AUTH_JWT_SECRET` — is
 *     invisible in `unmetCodes`, because the port IS bound and so nothing is
 *     unmet. `diagnose()` derived its headline from that empty list and returned
 *     "fully configured and available" over a socket that refuses note syncing.
 *     That false green is what this block exists to make impossible.
 *
 * Everything below is a closed set mapped by an exhaustive `Record`. The copy is
 * written HERE, in the client, for every member: a cause the panel cannot explain
 * is worth less than no cause, and server prose is admitted only as a secondary
 * "the server reports" line, redacted, and only where this build has nothing
 * better to say (the same rule `diagnosticRemedies.ts` applies to precondition
 * remedies).
 */
export const SYNC_ITEMS_STATES = ['ADVERTISED', 'WITHHELD', 'NOT_OBSERVED'] as const

export type SyncItemsState = (typeof SYNC_ITEMS_STATES)[number]

/**
 * Every cause the server can name, as a VALUE as well as a type — so "exhaustive
 * over the causes" is checkable by a test iterating this list, and not only by the
 * compiler checking a `Record`.
 */
export const SYNC_ITEMS_CAUSES = [
  'LANE_PRECONDITION_UNMET',
  'SYNC_LANE_NOT_BUILT',
  'DURABLE_BACKEND_UNBOUND',
  'DURABLE_BACKEND_NOT_READY',
  'NEVER_PROBED',
  'PROBE_FAILED',
  'GATE_NOT_RECORDED',
] as const

export type SyncItemsCause = (typeof SYNC_ITEMS_CAUSES)[number]

/**
 * The chip, one entry per state.
 *
 * *** EXHAUSTIVE `Record`, NOT A TERNARY — the fall-through was the bug. *** The
 * chip this replaces was `advertised ? 'Advertised' : 'Withheld'` behind a
 * `!== undefined` guard, which is a two-state vocabulary for a three-state answer.
 *
 * `NOT_OBSERVED` takes `'neutral'`, this module's existing tone for "no verdict"
 * (see the CONNECTING transport and the unconfirmable capability row), and a label
 * of its own. It must stay distinct from `'bad'`/"Unavailable" in BOTH the word
 * and the colour: "could not determine" and "not available" are different facts
 * and an operator acts differently on each.
 */
export const SYNC_ITEMS_STATE_CHIP: Record<SyncItemsState, { label: string; tone: Tone }> = {
  ADVERTISED: { label: 'Advertised', tone: 'good' },
  WITHHELD: { label: 'Withheld', tone: 'warn' },
  NOT_OBSERVED: { label: 'Not observed', tone: 'neutral' },
}

/**
 * The same three states as the copyable report's yes/no/unknown vocabulary. The
 * report's other gate lines are `yesNo(...)`, and the third state has to read as
 * something other than a quiet "unknown" there too.
 */
export const SYNC_ITEMS_STATE_REPORT: Record<SyncItemsState, string> = {
  ADVERTISED: 'yes',
  WITHHELD: 'no',
  NOT_OBSERVED: 'could not be determined',
}

type SyncItemsCopy = {
  /** One clause, the finding's title. Written by this build, never the server. */
  title: string
  /** What it means and what to do, in an operator's terms. */
  detail: string
  /**
   * True when the cause is ALREADY named, with better advice, in the gate's own
   * condition list. The server's remedy for these two is a restatement of a
   * precondition remedy, and this panel deliberately REPLACES that text with a
   * topology-conditional one (`remedyForPrecondition`) — on this very deployment
   * the stock sentence sends the reader after `SYNCING_SERVER_GRPC_URL`, which is
   * already set and never read. Printing the server's copy here would put back
   * the exact sentence the panel exists to suppress.
   */
  deferToConditions: boolean
}

/**
 * What each cause MEANS, and what to do about it.
 *
 * *** EXHAUSTIVE OVER THE UNION, both directions. *** `satisfies` rather than a
 * type annotation so the key set stays LITERAL: a missing cause fails to compile,
 * an extra key fails to compile, and the two `AssertNever` lines below state both
 * halves as a type so neither can be weakened without a visible edit. A generic
 * fall-through string for an unmapped member would be the defect pattern this
 * file has already been corrected for twice.
 */
export const SYNC_ITEMS_CAUSE_COPY = {
  LANE_PRECONDITION_UNMET: {
    title: 'SYNC_ITEMS is withheld because the socket lane itself did not come up',
    detail:
      'Nothing is negotiated over a socket that never opens, so this is a consequence of the unmet boot conditions on this screen rather than an independent problem — fix those and it clears with them. Note syncing is on HTTP in the meantime, and so is everything else.',
    deferToConditions: true,
  },
  SYNC_LANE_NOT_BUILT: {
    title: 'A gateway is attached but it was given no sync lane',
    detail:
      'The socket accepts clients and then negotiates nothing at all — not note syncing, not collaboration, not API RPC — because the lane object the handshake reads its operations from was never built. Tickets still mint, so this looks healthy from every other panel. The unmet conditions in this report name why the lane was not built.',
    deferToConditions: false,
  },
  DURABLE_BACKEND_UNBOUND: {
    title: 'SYNC_ITEMS is withheld because no durable command port is bound',
    detail:
      'The handshake offers note syncing only when a durable backend exists to carry the commands, and this deployment bound none. The condition is named in the list on this screen, and the fix printed beside it there is the one written for THIS deployment’s topology — which is not always the fix the condition’s own name suggests. The socket stays up and keeps carrying everything else.',
    deferToConditions: true,
  },
  DURABLE_BACKEND_NOT_READY: {
    title: 'SYNC_ITEMS is withheld: the durable command port is bound but FAILED the handshake’s readiness check',
    detail:
      'This is the state no condition list can show you. The port is bound, so nothing reads as unmet, and the socket still refuses to offer note syncing — notes sync over HTTP while collaboration, API RPC, invite events and files stay realtime, which is exactly why every other panel looks healthy. The check the handshake makes needs AUTH_JWT_SECRET set, because the session behind each command is revalidated, and for the gRPC port it needs SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET at least 32 bytes long and identical on the syncing server. A bound proxy is evidence of neither. The gate reports only the single boolean the handshake computes, so it cannot say which of the two failed: check both.',
    deferToConditions: false,
  },
  NEVER_PROBED: {
    title: 'This server recorded no reading of the handshake predicate',
    detail:
      'The gate cannot say whether SYNC_ITEMS is offered, so this screen does not guess: it is neither a healthy lane nor a withheld operation. A host built before the gate took its own reading reports exactly this. Until the server is upgraded, the Capabilities section is the measurement to use — what this client actually negotiated is observed here and needs no server call.',
    deferToConditions: false,
  },
  PROBE_FAILED: {
    title: 'The readiness check threw while the gate was reading it',
    detail:
      'The server asked the durable backend whether it was ready and the question itself failed, so the answer is unknown rather than no. The thrown message is deliberately not sent here because it can embed a resolved service address; the gateway’s boot log carries it. Meanwhile the Capabilities section — what this client negotiated — is a direct measurement that does not depend on this reading.',
    deferToConditions: false,
  },
  GATE_NOT_RECORDED: {
    title: 'The boot gate has not been recorded, so there is no lane to read the verdict from',
    detail:
      'The server answered while it was still starting, or this build never wired the recorder. Nothing about SYNC_ITEMS can be confirmed yet; reload in a moment. If it persists well past startup then the recorder is not wired in this build, which an upgrade fixes rather than any setting.',
    deferToConditions: false,
  },
} satisfies Record<SyncItemsCause, SyncItemsCopy>

/** Every cause has copy. */
export type EverySyncItemsCauseHasCopy = AssertNever<Exclude<SyncItemsCause, keyof typeof SYNC_ITEMS_CAUSE_COPY>>
/** And nothing that is not a cause has copy, so a typo cannot masquerade as one. */
export type NoStraySyncItemsCauseCopy = AssertNever<Exclude<keyof typeof SYNC_ITEMS_CAUSE_COPY, SyncItemsCause>>

/**
 * The cases where there is no server verdict to render, each with its own words.
 *
 * They are kept APART from the cause copy above rather than folded in as extra
 * members, because none of them is a thing the server said: they are this build
 * describing what it was given. Collapsing them into one "unknown" is how a panel
 * ends up telling an operator their notes are on HTTP when the truth is that
 * nobody asked.
 */
export const SYNC_ITEMS_NO_VERDICT_COPY = {
  /** Nothing was read from the server at all. */
  'not-read': {
    title: 'The SYNC_ITEMS verdict was not read from the server',
    detail:
      'No diagnostics answer has been read, so there is no verdict to show. This is not a finding about note syncing: the transport verdict on this screen is measured by this client and still stands.',
    deferToConditions: false,
  },
  /** An older server: the boolean, and nothing else. */
  'not-reported': {
    title: 'This server build does not report the SYNC_ITEMS verdict',
    detail:
      'The running server predates the three-state verdict and sends only a single boolean. That boolean was derived on those builds from whether a proxy OBJECT had been constructed, not from the predicate the handshake asks — a deployment with the proxy bound and a short or missing internal secret got a green claim over a socket that withheld the operation — so this panel will not repeat it. Nothing here says note syncing is broken; it says this build cannot tell you. The Capabilities section measures what this client actually negotiated and needs no server call, and a server upgrade restores the verdict.',
    deferToConditions: false,
  },
  /** A fourth state from a newer server. */
  'state-unrecognised': {
    title: 'The server reported a SYNC_ITEMS state this client build does not recognise',
    detail:
      'The server is newer than this client and named a state outside the closed set this build knows, so the panel will not map it onto one of the three it does know. Update the client to read this server’s verdict; until then the Capabilities section is the measurement that does not depend on it.',
    deferToConditions: false,
  },
  /** A recognised state, a cause from outside the closed set. */
  'cause-unrecognised': {
    title: 'The server named a SYNC_ITEMS cause this client build does not recognise',
    detail:
      'The state above is the server’s own verdict and stands. The reason it gave is outside the closed set this build knows, so the panel will not paraphrase it as one it does know; any server-reported fix below is printed as sent, with addresses redacted. Updating the client restores the explanation.',
    deferToConditions: false,
  },
  /** A recognised state with no cause at all, which the contract allows only for ADVERTISED. */
  'cause-missing': {
    title: 'The server reported this SYNC_ITEMS state without naming a cause',
    detail:
      'The state above is the server’s own verdict and stands, but it arrived with no reason attached, so this build cannot say why. The gate’s condition list and the Capabilities section are what is left to narrow it.',
    deferToConditions: false,
  },
} satisfies Record<string, SyncItemsCopy>

const SYNC_ITEMS_ADVERTISED_COPY: SyncItemsCopy = {
  title: 'SYNC_ITEMS is advertised on the socket',
  detail:
    'The gate read the handshake’s own predicate on the lane the gateway was handed, and it answered ready — so note syncing is offered over the socket rather than falling back to HTTP.',
  deferToConditions: false,
}

/**
 * The whole SYNC_ITEMS verdict, as the panel and the report both render it.
 *
 * ONE source of truth. `state` comes from `gate.syncItems.state` and never from
 * `gate.syncItemsAdvertised`: the two agree on a current server because the server
 * derives the boolean FROM the state, and where they disagree the structured
 * verdict is the one measured at the handshake's own predicate.
 */
export type SyncItemsVerdict = {
  state: SyncItemsState
  tone: Tone
  /** The chip label for `state`. */
  label: string
  title: string
  detail: string
  /** The cause, when the server named one this build recognises. */
  cause: SyncItemsCause | null
  /** The server named a cause outside this build's closed set. */
  unrecognisedCause: boolean
  /**
   * The server's own remedy copy, redacted. Null when it sent none, and null for
   * a cause whose `deferToConditions` holds (see `SyncItemsCopy`).
   */
  remedy: string | null
  /** The server reported the structured verdict at all. False on an older build. */
  reported: boolean
}

const isSyncItemsState = (value: unknown): value is SyncItemsState =>
  typeof value === 'string' && (SYNC_ITEMS_STATES as readonly string[]).includes(value)

const isSyncItemsCause = (value: unknown): value is SyncItemsCause =>
  typeof value === 'string' && (SYNC_ITEMS_CAUSES as readonly string[]).includes(value)

/**
 * Read the verdict, parsing both enums against this build's own closed sets.
 *
 * Early returns rather than a chain of ternaries, deliberately: these branches are
 * five structurally different situations, not one union being mapped to copy, and
 * the mapping of the union itself is the `Record` above.
 */
export function describeSyncItems(payload: SyncDiagnosticsPayload | undefined): SyncItemsVerdict {
  const wire = payload?.gate?.syncItems
  const reported = wire !== undefined

  const verdict = (
    state: SyncItemsState,
    copy: SyncItemsCopy,
    fields: Partial<SyncItemsVerdict> = {},
  ): SyncItemsVerdict => ({
    state,
    ...SYNC_ITEMS_STATE_CHIP[state],
    title: copy.title,
    detail: copy.detail,
    cause: null,
    unrecognisedCause: false,
    remedy: null,
    reported,
    ...fields,
  })

  if (payload === undefined) {
    return verdict('NOT_OBSERVED', SYNC_ITEMS_NO_VERDICT_COPY['not-read'])
  }
  if (wire === undefined) {
    return verdict('NOT_OBSERVED', SYNC_ITEMS_NO_VERDICT_COPY['not-reported'])
  }
  if (!isSyncItemsState(wire.state)) {
    return verdict('NOT_OBSERVED', SYNC_ITEMS_NO_VERDICT_COPY['state-unrecognised'])
  }

  // `cause` is null only for ADVERTISED in the server contract. A cause sent
  // alongside ADVERTISED is dropped rather than rendered: the state is the
  // verdict, and there is no "advertised, but" to report.
  if (wire.state === 'ADVERTISED') {
    return verdict('ADVERTISED', SYNC_ITEMS_ADVERTISED_COPY)
  }

  const named = typeof wire.cause === 'string' && wire.cause.length > 0
  const cause = isSyncItemsCause(wire.cause) ? wire.cause : null
  const copy =
    cause !== null
      ? SYNC_ITEMS_CAUSE_COPY[cause]
      : SYNC_ITEMS_NO_VERDICT_COPY[named ? 'cause-unrecognised' : 'cause-missing']
  // Server-authored prose, so it goes through the redactor on the way in — the
  // same rule every other string off this wire follows. It is a frozen constant
  // in a correct server, and "in a correct server" is the assumption a leak breaks.
  const sent = typeof wire.remedy === 'string' && wire.remedy.trim().length > 0 ? sanitizeServerCopy(wire.remedy) : null

  return verdict(wire.state, copy, {
    cause,
    unrecognisedCause: named && cause === null,
    remedy: copy.deferToConditions ? null : sent,
  })
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
  readFailure?: DiagnosticsReadFailure,
): Diagnosis {
  const findings: Diagnosis['findings'] = []

  if (!payload) {
    /**
     * *** "I COULD NOT ASK" IS NOT "IT IS DOWN." ***
     *
     * This branch used to return tone `'bad'` with a headline about the sync
     * lane, which the chip row rendered as "Unavailable" immediately beside a
     * verdict chip reading "WebSocket" — derived, correctly, from the live
     * transport this client had actually measured. Two independent sources of
     * truth, and the one that had failed to read anything overwrote the one that
     * had observed something.
     *
     * `'neutral'` is this module's existing tone for "no verdict" (see the
     * CONNECTING and AUTHENTICATING transport states, and the unconfirmable
     * capability row). The panel maps it to its own chip label, so the unread
     * case can no longer borrow a negative claim about availability.
     */
    const verdict = describeTransport(transport)

    return {
      headline: readFailure
        ? `Diagnostics could not be READ from the server, so nothing the server reports is known here. This is not a finding about the socket: the transport verdict on this screen (${verdict.label}) is measured by this client, needs no server call, and still stands.`
        : 'Diagnostics have not been read from the server yet.',
      tone: 'neutral',
      findings: readFailure ? [describeDiagnosticsReadFailure(readFailure)] : [],
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

  // *** THE FALSE GREEN. *** A withheld SYNC_ITEMS has to become a FINDING, not
  // merely a chip, because the one cause an operator can fix —
  // `DURABLE_BACKEND_NOT_READY` — leaves `unmetPreconditions` EMPTY: the durable
  // port is bound, so no condition reads as unmet. This function returns "fully
  // configured and available" whenever the finding list is empty, so before this
  // was pushed a deployment whose socket refuses note syncing was reported as
  // healthy, in the `good` tone, with the real fault named nowhere on the screen.
  //
  // Pushed for `WITHHELD` only. `NOT_OBSERVED` deliberately adds nothing here:
  // "the gate could not say" is not a gap in the lane, and inventing a finding
  // for it would make every pre-verdict server build read as degraded on no
  // evidence — the same error in the other direction. It gets its own chip and
  // its own copy instead, which is where a reader looks for it.
  const syncItems = describeSyncItems(payload)
  if (syncItems.state === 'WITHHELD') {
    findings.push({
      title: syncItems.title,
      detail: syncItems.remedy ? `${syncItems.detail} The server reports: ${syncItems.remedy}` : syncItems.detail,
    })
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
  // Sourced from the structured verdict, never from `gate.syncItemsAdvertised`.
  // One source of truth: a current server derives that boolean FROM this state, so
  // they agree; where they disagree the state is the one measured at the
  // handshake's own predicate, and the boolean is the signal that used to read
  // green over a socket withholding the operation. A server too old to send the
  // verdict reports `NOT_OBSERVED` and therefore makes no claim here either.
  const itemsWithheld = !blocking && syncItems.state === 'WITHHELD'

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
