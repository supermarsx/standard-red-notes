import {
  SYNC_FALLBACK_REASON_EXPLANATIONS,
  syncFallbackDisposition,
  type SyncFallbackDisposition,
  type SyncFallbackReason,
  type SyncNegotiatedOperation,
  type SyncTransportState,
} from '@/Services/SyncTransport/syncTransportProtocol'
import { LANE_STATE_CARRIER } from '@/Services/SyncTransport/LaneDegradationLedger'
import {
  remedyForClientGap,
  remedyForLiveReason,
  remedyForPrecondition,
  remedyForUnrecognisedPreconditions,
  type DeploymentTopology,
  type Remedy,
  type RemedyEffort,
} from './diagnosticRemedies'
import {
  buildSectionModel,
  diagnosticFinding,
  diagnosticRow,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  evidenceProxy,
  LANE_REJECTION_STATUSES,
  outcomesForSection,
  reportLine,
  safeConstant,
  safeCount,
  safeDuration,
  safeEnum,
  safeState,
  safeTokens,
  safeYesNo,
  UNRECOGNISED,
  type DiagnosticBlock,
  type DiagnosticFinding,
  type DiagnosticRow,
  type Evidence,
  type LaneDegradationLedgerView,
  type LaneRejectionStatus,
  type SafeValue,
  type SectionModel,
  type SectionTaggedOutcome,
  type Verdict,
} from './diagnosticsSections'
import {
  admitMembers,
  buildCapabilityRows,
  countOf,
  describeRealtimeHealth,
  describeSyncItems,
  describeTransport,
  FILES_CONDITION_MEANING,
  isKnownFilesUnmetCondition,
  isKnownPreconditionCode,
  KNOWN_FILES_UNMET_CONDITIONS,
  KNOWN_LIVE_REFUSAL_REASONS,
  KNOWN_PRECONDITION_CODES,
  SYNC_ITEMS_CAUSES,
  SYNC_ITEMS_STATES,
  type CapabilityRow,
  type CapabilityStatus,
  type KnownPreconditionCode,
  type SyncDiagnosticsPayload,
  type SyncItemsState,
  type TransportStatusInput,
} from './syncDiagnostics'

/**
 * Standard Red Notes: the WebSocket section of the admin diagnostics pane.
 *
 * This section absorbs the *Boot gate* and *Capabilities* sub-tabs, which were
 * never two subjects: the gate decides whether the lane is built and which
 * operations it may offer, and the capability table is which operations were in
 * fact negotiated. Under the user's taxonomy they ARE "all the websocket stuff",
 * and left as peers of a WebSocket tab they would have taken everything with
 * them, leaving a tab holding one transport chip. They become headed blocks, so
 * no copy and no spec assertion is lost — only its parent panel changes.
 *
 * It is also where tonight's headline bug lived, which is why the evidence
 * discipline in `diagnosticsSections.ts` is applied here more aggressively than
 * anywhere else in the pane.
 *
 * -------------------------------------------------------------------------------
 * 1. The SYNC_ITEMS verdict is CONSUMED, never re-derived.
 * -------------------------------------------------------------------------------
 *
 * `describeSyncItems(payload)` already reads `gate.syncItems` — three states, a
 * closed cause, the raw probe outcome and the server's own remedy, redacted — and
 * this module calls it and renders what it returns. It does NOT look at
 * `gate.syncItemsAdvertised`, and that omission is the entire point:
 *
 *   - On the builds that sent it, that boolean was derived from
 *     `container.isBound(ApiGateway_GRPCSyncingServerServiceProxy)` — whether a
 *     proxy OBJECT had been constructed — while the handshake advertises
 *     SYNC_ITEMS only if `backend.ready()`, which ADDITIONALLY requires a usable
 *     internal gRPC auth secret and a session plane that can revalidate. A
 *     deployment with the proxy bound and a short secret therefore produced a
 *     green chip over a socket that withheld note syncing.
 *   - In the `NOT_OBSERVED` case the server OMITS the boolean rather than sending
 *     `false`, so a `!== true` read of it turns "the gate cannot say" into "no".
 *
 * So the row's value is the STATE, parsed against this build's own closed set, and
 * a `NOT_OBSERVED` state can only ever render as `NOT_OBSERVED` / Unknown. There
 * is no expression in this file that could make it read as advertised.
 *
 * -------------------------------------------------------------------------------
 * 2. An empty unmet-condition list is not evidence of health.
 * -------------------------------------------------------------------------------
 *
 * `DURABLE_BACKEND_NOT_READY` — the one cause an operator can actually fix —
 * leaves `unmetPreconditions` and `unmetCodes` EMPTY, because the durable port IS
 * bound and so nothing reads as unmet. `diagnose()` derived its headline from the
 * length of that list and returned "fully configured and available" over a socket
 * that refuses note syncing.
 *
 * The "Unmet boot conditions" row therefore claims `healthy` for a count of zero
 * through `evidenceProxy(..., necessaryCondition: true)`, which caps it to
 * `undetermined` and prints what the zero does not establish. A count of zero is
 * reported as a fact about the LIST, never as a verdict about the lane — and the
 * row immediately beneath it, the SYNC_ITEMS state, is where the withheld
 * operation actually appears.
 *
 * -------------------------------------------------------------------------------
 * 3. The one genuinely strong signal, and the many weak ones.
 * -------------------------------------------------------------------------------
 *
 * `application.syncTransportStatus` is a DIRECT observation of this client's own
 * socket: the state, the transport's own closed fallback code, and the operations
 * this handshake actually negotiated. Nothing else in this section is that strong.
 * Everything the server reports about the gate is a boot-time DECISION or a probe
 * reading, and a positive one establishes that the gateway intended to offer an
 * operation — not that this socket got it. Those rows are proxies and say so.
 *
 * The asymmetry is deliberate and is the same one `environmentSection.ts` applies
 * to configuration presence: a positive proxy reading caps to `undetermined`, a
 * negative one survives as `broken`, because a necessary condition FAILING is
 * conclusive while its holding is not. Several rows on a healthy deployment
 * therefore read `Unknown` — and the capability rows beside them, measured on this
 * client's own handshake, are the ones reading `OK`.
 *
 * Not every proxy here is necessary, and over-claiming `necessary` to keep a
 * verdict alive is this file's most available mistake. An unmet condition this
 * build does not RECOGNISE is declared `correlated`: the gate reported something,
 * and which part of the lane it closes is genuinely unknown, so no verdict is
 * claimed from it in either direction.
 *
 * -------------------------------------------------------------------------------
 * 4. `broken` means the lane; `degraded` means one operation on a live lane.
 * -------------------------------------------------------------------------------
 *
 * One line, held consistently, because the pane has already contradicted itself
 * about it. A withheld SYNC_ITEMS is `degraded`, not `broken`, and that is not a
 * softening: sync TRANSPARENTLY FALLS BACK TO HTTP, verified live on a real stack
 * rather than merely claimed, so notes keep saving while collaboration, API RPC,
 * invite events and files stay realtime. An operator told their lane is down goes
 * looking for a dead socket that is in fact up, and stops reading the one row that
 * named the missing operation.
 *
 * `broken` is reserved for the lane itself: a lane-gating precondition unmet, a
 * gateway that recorded no attach, a gateway that would refuse a client right now.
 *
 * -------------------------------------------------------------------------------
 * 5. What this section does NOT say, so it is not said twice.
 * -------------------------------------------------------------------------------
 *
 *   - The CAUSE of a withheld lane in configuration terms — a short internal gRPC
 *     secret, an absent `AUTH_JWT_SECRET` — belongs to Environment & setup, which
 *     owns `GRPC_SECRET_TOO_SHORT` and `SESSION_SIGNING_KEY_ABSENT`. This section
 *     states the consequence and names the two variables to check once, inside the
 *     one remedy it owns for the cause no condition list can show.
 *   - `unsupported-browser` is the Browser section's row, with the remedy. Here it
 *     is a reported fallback code and nothing more.
 *   - `live-sync-disabled` is an ACCOUNT fact — an administrator turned the switch
 *     off for this one account — and the Account section owns it. The fallback-code
 *     row prints it, with the protocol's own sentence, and raises no finding.
 *   - Whether the session credential a socket holds is current is observable here
 *     only as a COUNT of refused control-plane reads. Nothing in the diagnostics
 *     payload reports the socket's credential state, and no row is invented for it.
 */

/* -------------------------------------------------------------------------- */
/* Closed vocabularies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The transport's own states, as a tuple so `safeEnum` can admit them, with a
 * compile-time assertion that the tuple still covers the protocol union. A state
 * added to the transport without a verdict here would otherwise arrive as
 * `other (unrecognised)` with no tone at all.
 */
export const SOCKET_TRANSPORT_STATES = [
  'HTTP_ONLY',
  'CONNECTING',
  'AUTHENTICATING',
  'READY',
  'DEGRADED',
  'HTTP_FALLBACK',
  'HALF_OPEN',
] as const satisfies readonly SyncTransportState[]

type AssertNever<T extends never> = T

type UnlistedTransportState = Exclude<SyncTransportState, (typeof SOCKET_TRANSPORT_STATES)[number]>
export type EveryTransportStateIsListed = AssertNever<UnlistedTransportState>

/** The transport's closed fallback codes. Never server text. */
export const SOCKET_FALLBACK_REASONS = [
  'http-only',
  'unsupported-browser',
  'capability-unavailable',
  'ticket-unavailable',
  'ticket-expired',
  'auth-failed',
  'proxy-failed',
  'frame-too-large',
  'result-too-large',
  'ack-timeout',
  'server-kill',
  'reconnect-gap',
  'backpressure',
  'outbox-unavailable',
  'multi-tab-not-owner',
  'worker-error',
  'operation-unavailable',
  'live-sync-disabled',
] as const satisfies readonly SyncFallbackReason[]

type UnlistedFallbackReason = Exclude<SyncFallbackReason, (typeof SOCKET_FALLBACK_REASONS)[number]>
export type EveryFallbackReasonIsListed = AssertNever<UnlistedFallbackReason>

/**
 * What a fallback reason is WORTH, as the lane's own three dispositions.
 *
 * CONSUMED, NEVER RE-DERIVED. `syncFallbackDisposition` is the transport's
 * classification and this tuple exists only so `safeEnum` can admit its three
 * literals, with the usual compile-time assertion that it still covers them. The
 * panel used to answer this question for itself as `!isPermanentSyncFallbackReason`,
 * and that negation is the defect rather than a shortcut: it answers `retryable`
 * for a tab that is deliberately standing down because another tab of the same
 * account holds the socket — a correct steady state, reported here as a transport
 * mid-recovery. The lane's own doc comment on that predicate now says in terms
 * that deriving retryability from its negation is wrong, and this module is one of
 * the surfaces it is talking about.
 */
export const SOCKET_FALLBACK_DISPOSITIONS = [
  'retryable',
  'deferred',
  'permanent',
] as const satisfies readonly SyncFallbackDisposition[]

type UnlistedFallbackDisposition = Exclude<SyncFallbackDisposition, (typeof SOCKET_FALLBACK_DISPOSITIONS)[number]>
export type EveryFallbackDispositionIsListed = AssertNever<UnlistedFallbackDisposition>

/**
 * Whether this reason is an expected steady state rather than a fault.
 *
 * The one question three surfaces of this pane each used to answer for
 * themselves: the transport row's verdict, the probe outcome on the Checks
 * sub-tab, and the disposition row. A `deferred` reason is an expected steady
 * state — the lane's own user-facing copy for `multi-tab-not-owner` says so in
 * those words — so it is reported and carries no verdict.
 *
 * *** POSITIVE ON PURPOSE, AND AN `undefined` REASON IS NOT DEFERRED. *** This was
 * written once as `isFault`, and `!isFault(undefined)` is `true`: a transport in a
 * degraded state with NO reason at all came out deferred, which is the same shape
 * of error as the `!isPermanent` negation this whole change exists to remove. Asked
 * in the positive there is no arm for a caller to invert by accident, and a caller
 * handed nothing is answered "not deferred" rather than "not a fault".
 */
export function socketFallbackIsDeferred(reason: SyncFallbackReason | undefined): boolean {
  return reason !== undefined && syncFallbackDisposition(reason) === 'deferred'
}

/** Every operation the protocol can negotiate. */
export const SOCKET_OPERATIONS = [
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  'FILES_V1',
] as const satisfies readonly SyncNegotiatedOperation[]

type UnlistedOperation = Exclude<SyncNegotiatedOperation, (typeof SOCKET_OPERATIONS)[number]>
export type EveryOperationIsListed = AssertNever<UnlistedOperation>

export const CAPABILITY_STATUSES = [
  'active',
  'not-negotiated',
  'client-gap',
  'recognized-only',
  'unknown',
] as const satisfies readonly CapabilityStatus[]

type UnlistedCapabilityStatus = Exclude<CapabilityStatus, (typeof CAPABILITY_STATUSES)[number]>
export type EveryCapabilityStatusIsListed = AssertNever<UnlistedCapabilityStatus>

/**
 * The gate's own precondition codes, plus the one condition a HOST adds.
 *
 * These are the SERVER's literals and this build cannot be recompiled against a
 * newer server, so an unrecognised code degrades to `other (unrecognised)` through
 * `safeEnum` rather than being echoed.
 *
 * It is an ALIAS of the list in `syncDiagnostics.ts` rather than a second copy.
 * The list is now what admits a code into a REMEDY as well as into a row, and two
 * tuples spelled out in two files is how a row comes to name a condition whose
 * remedy branch no longer exists — or the reverse, which is worse, because the
 * remedy branch is where the server's own prose used to be printed.
 */
export const PRECONDITION_CODES = KNOWN_PRECONDITION_CODES

export type PreconditionCode = KnownPreconditionCode

/**
 * The subset that gates the socket LANE itself. `SYNCING_SERVER_GRPC_UNBOUND` is
 * deliberately absent: since the gate was split it withholds SYNC_ITEMS only, and
 * treating it as a lane condition is how this pane came to describe a live socket
 * as unavailable.
 */
export const LANE_GATING_PRECONDITIONS: readonly PreconditionCode[] = [
  'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
  'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION',
  'REDIS_UNBOUND',
  'WEBSOCKET_REDIS_NAMESPACE_INVALID',
]

/** The gateway's live refusal reasons. Aliased for the reason above. */
export const LIVE_REFUSAL_REASONS = KNOWN_LIVE_REFUSAL_REASONS

/** Which FILES_V1 precondition the composition found missing. Aliased likewise. */
export const FILES_UNMET_CONDITIONS = KNOWN_FILES_UNMET_CONDITIONS

/** The raw handshake-predicate reading the gate recorded. */
export const SYNC_ITEMS_PROBES = ['NEVER_PROBED', 'READY', 'NOT_READY', 'NO_LANE', 'PROBE_FAILED'] as const

/** Which push transport the attached gateway bound. */
export const PUSH_BRIDGES = ['redis', 'in-process', 'none'] as const

/** Whether the gateway would admit a client on the sync path right now. */
export const SYNC_LANE_STATES = ['up', 'down'] as const

/** The advertised socket capability descriptor, as this build knows it. */
export const SOCKET_CAPABILITY_IDS = ['ws-sync'] as const

export const SOCKET_ENDPOINTS = ['/sockets/sync'] as const

/** The gateway's own closed reasons for turning a connection away. */
export const SOCKET_REJECTION_CAUSES = ['originNotAllowed', 'queryStringNotPermitted', 'unavailable'] as const

export type SocketRejectionCause = (typeof SOCKET_REJECTION_CAUSES)[number]

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gateway-side admission and traffic counters.
 *
 * DECLARED HERE AND OPTIONAL ON PURPOSE, and the cost of that is stated rather
 * than hidden: nothing populates this today, so every row it feeds reads "not
 * reported" until the gateway half lands. `environmentSection.ts` has the scar
 * from the other arrangement — it declared a ledger the server was already
 * sending, the payload type did not say so, and every row read "not reported" on
 * a deployment that was reporting. So this shape is the one the gateway must
 * mirror, it is supplied by the caller rather than read off a payload field this
 * build cannot see, and an absent member is "did not ask" everywhere below.
 *
 * Every member is a boolean, a bounded count or a closed-key record. There is no
 * member here that could carry an origin, a URL or a credential — which matters
 * because the subject is an ALLOWLIST: the question "would my browser be let on"
 * is answerable with one boolean about input the client already possesses, and the
 * list's contents never leave the gateway.
 */
export type SocketGatewayCountersView = {
  /** Whether the gateway would admit THIS client's origin. One boolean, never the origin. */
  originAdmitted?: boolean
  /** How many origins are permitted. A cardinality: zero and non-zero are different fixes. */
  allowedOriginCount?: number
  allowsSameOrigin?: boolean
  rejections?: Readonly<Partial<Record<SocketRejectionCause, number>>>
  /** Sockets the attached gateway is holding right now. */
  liveSockets?: number
  ticketsIssued?: number
  ticketsRefused?: number
  /** Handshakes refused AFTER a ticket was accepted at the HTTP leg. */
  handshakeRejected?: number
  /**
   * Whether the gateway could advertise each operation, from the same predicates
   * the handshake itself asks. Keyed by a WIDE string: the server's operation enum
   * is the authority, and a lane this build has never heard of must be ignorable
   * rather than a type error.
   */
  advertisable?: Readonly<Partial<Record<string, boolean>>>
}

export type WebsocketSectionInput = {
  /** `GET /v1/admin/sync-diagnostics`. Absent until a read succeeds. */
  payload?: SyncDiagnosticsPayload
  /** `application.syncTransportStatus`. The one direct observation in this section. */
  transport?: TransportStatusInput
  /** The client-side lane-degradation ledger. Absent in a build that records none. */
  ledger?: LaneLedgerSectionView
  counters?: SocketGatewayCountersView
  outcomes?: readonly SectionTaggedOutcome[]
}

/* -------------------------------------------------------------------------- */
/* Row helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Absent is not false, held structurally rather than remembered.
 *
 * Every directly-observed row in this file routes through here, so a row cannot
 * claim direct evidence for a field nobody reported. The failure this prevents is
 * a row reading "not reported" with a confident tone behind it, which is the panel
 * asserting it looked when it did not.
 */
function absentOr(observed: unknown, verdict: Verdict): { verdict: Verdict; evidence: Evidence } {
  return observed === undefined || observed === null
    ? { verdict: 'undetermined', evidence: EVIDENCE_ABSENT }
    : { verdict, evidence: EVIDENCE_DIRECT }
}

function observedRow(input: {
  label: SafeValue
  observed: unknown
  value: SafeValue
  verdict: Verdict
  note: string
}): DiagnosticRow {
  return diagnosticRow({
    label: input.label,
    value: input.value,
    ...absentOr(input.observed, input.verdict),
    note: input.note,
  })
}

/**
 * A signal the described thing cannot work without. Its failure is conclusive;
 * its holding establishes nothing, so a positive claim caps to `undetermined`.
 */
function necessaryProxy(observed: string, cannotConfirm: string): Evidence {
  return evidenceProxy({ observed, cannotConfirm, necessaryCondition: true })
}

/**
 * A signal that merely travels with the described thing. Neither direction
 * establishes anything, so NO verdict survives it — which is the honest answer
 * for a condition code this build cannot interpret.
 */
function correlatedProxy(observed: string, cannotConfirm: string): Evidence {
  return evidenceProxy({ observed, cannotConfirm, necessaryCondition: false })
}

/**
 * One variable's presence, THREE-VALUED — the same rule, for the same reason, as
 * the copy of this in `environmentSection.ts` and `backendSection.ts`.
 *
 * A key MISSING from the map is a server that said nothing about that variable,
 * and collapsing that to `false` turns silence into "not set". Here that would be
 * worse than a wrong row: `undefined` is what makes the queue-consumer row below
 * keep its old, unjudged reading on a server that reports no presence block at
 * all, instead of asserting that no queue is configured and calling an idle
 * consumer correct.
 */
function presenceOf(topology: DeploymentTopology | undefined, key: string): boolean | undefined {
  if (topology?.recorded !== true) {
    return undefined
  }

  const presence = topology.presence
  if (presence === undefined || !(key in presence)) {
    return undefined
  }

  return presence[key] === true
}

/* -------------------------------------------------------------------------- */
/* Remedies owned by this module                                              */
/* -------------------------------------------------------------------------- */

/**
 * Nobody edits `diagnosticRemedies.ts` — five executors appending to one switch
 * is the collision the section contract avoids — so the three remedies this
 * section needs and nobody else has live here. The ones that already exist are
 * reused untouched: `remedyForPrecondition` for every unmet gate condition,
 * `remedyForLiveReason` for every live refusal, `remedyForClientGap` for an
 * operation the server can negotiate and this client cannot consume.
 */
const CONFIG_AND_RESTART: RemedyEffort = 'restart'

/**
 * The one remedy this section owns for the withheld lane, and ONLY for the cause
 * no condition list can show.
 *
 * `LANE_PRECONDITION_UNMET` and `DURABLE_BACKEND_UNBOUND` both carry
 * `deferToConditions` in `syncDiagnostics.ts`: their fix is already printed, with
 * topology-conditional advice, beside the condition itself. Restating it here is
 * how two copies drift, and on this very deployment the stock sentence sends the
 * reader after a variable that is set and never read.
 *
 * `DURABLE_BACKEND_NOT_READY` is the opposite case. The port is bound, so no
 * condition is unmet, so there is nothing for this to defer TO — which is exactly
 * why the panel used to report the deployment healthy.
 */
function remedyForWithheldSyncItems(): Remedy {
  return {
    code: 'SYNC_ITEMS_WITHHELD',
    summary:
      'The durable command port is bound and FAILED the readiness check the handshake makes, so the socket will not offer note syncing. Two variables decide that check. Restart only — no rebuild.',
    steps: [
      'Set AUTH_JWT_SECRET to the same value the auth server uses. Every socket command revalidates the session behind it before it runs, so a secret that DISAGREES with the one the auth server holds fails the readiness check without any gRPC involvement at all. An EMPTY one is a different failure and not this one: the gateway requires this variable non-optionally at boot, so an empty value is a fatal startup and a restart loop rather than a withheld operation — there would be no gateway left to serve this page.',
      'For the gRPC durable port, set SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET to at least 32 bytes and to the IDENTICAL value on the syncing server. Below 32 bytes the adapter counts it as unconfigured; two valid secrets that disagree fail exactly like one short secret.',
      'Do not read the empty condition list as a clean bill of health. This is the one cause that leaves it empty — the port IS bound, so nothing is unmet — and it is the reason this pane once reported the deployment fully available.',
      'Restart, then re-read this pane. The Environment & setup section reports which of the two variables is set, and the readiness check itself reports a single boolean, so it cannot say which of them failed: check both.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'The gate read the handshake’s own readiness predicate and it answered NOT ready, over a durable command port that is bound.',
      'Notes sync over HTTP while this holds, and collaboration, API RPC, invite events and files stay realtime on the same socket — which is why every other panel on this screen looks healthy.',
    ],
  }
}

/**
 * The origin allowlist, as two different faults with two different fixes.
 *
 * Today the only evidence of this is a `1008 origin-not-allowed` close that no UI
 * reads, and "the list is empty" and "the list is non-empty and mine is not in it"
 * produce identical screens while needing opposite actions.
 */
function remedyForRefusedOrigin(allowedOriginCount: number | undefined): Remedy {
  const listEmpty = allowedOriginCount === 0

  return {
    code: 'SOCKET_ORIGIN_NOT_ADMITTED',
    summary: listEmpty
      ? 'No origin is permitted at all, so the handshake is refused before it starts. Restart only — no rebuild.'
      : 'Origins ARE permitted and this client’s is not among them, so this browser is turned away while others connect. Restart only — no rebuild.',
    steps: listEmpty
      ? [
          'Set WEBSOCKET_SYNC_ALLOWED_ORIGINS to the exact origins clients connect from, or set PUBLIC_URL and let the same-origin entry be derived from it.',
          'An explicit list is strict: one unsafe member fails startup rather than being skipped, so an empty resolved list can also mean a list that was rejected whole.',
          'Restart the container, then re-run the checks on this page.',
        ]
      : [
          'Add the origin this app is served from to WEBSOCKET_SYNC_ALLOWED_ORIGINS. The scheme, host and port must all match — https://notes.example and https://notes.example:443 are the same origin, http:// and https:// are not.',
          'If clients reach the app through a reverse proxy under a different name, the allowlist needs the name the BROWSER uses, not the one the container sees.',
          'Set PUBLIC_URL as well, so the same-origin entry is derived rather than maintained by hand.',
          'Restart the container, then re-run the checks on this page.',
        ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      listEmpty
        ? 'The gateway reports that no origin is permitted, which is the same condition it reports as the live refusal reason no-allowed-origins.'
        : 'The gateway was asked about this client’s own origin and answered that it would not admit it, while reporting a non-empty allowlist.',
      'The origin itself is never carried into this panel or the copyable report — only the gateway’s yes or no about it, and how many entries the list holds.',
    ],
  }
}

/**
 * Tickets mint and the handshake is then refused.
 *
 * The signature of two processes that disagree about
 * `WEB_SOCKET_CONNECTION_TOKEN_SECRET`: the HTTP leg that mints a ticket and the
 * socket leg that redeems it are different processes on a multi-replica
 * deployment, and a ticket signed by one is unreadable to the other. From every
 * other panel this looks like a healthy gateway, because it is one.
 */
function remedyForRejectedHandshakes(): Remedy {
  return {
    code: 'SOCKET_HANDSHAKE_REJECTED',
    summary:
      'Tickets are being issued and the handshakes that present them are being refused. The usual cause is two processes that do not share the ticket secret. Restart only — no rebuild.',
    steps: [
      'Set WEB_SOCKET_CONNECTION_TOKEN_SECRET to the SAME value on every process in the stack. A ticket minted by one replica and redeemed on another must verify against one key.',
      'Check the clock on each process as well. A ticket is short-lived, so a replica whose clock is minutes out rejects tickets that are genuinely current — the Browser section reports this client’s own offset from the server.',
      'A ticket is single-use. Refusals that match the number of reconnects rather than the number of mints are a client retrying a redeemed ticket, which is expected and not this fault.',
      'Restart every process after changing the secret, then re-run the checks on this page.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'The gateway reports tickets issued AND handshakes rejected. Either number alone is ordinary; together they mean clients are reaching the socket with a credential it will not accept.',
      'No secret, length or value is read to establish this — only two counters.',
    ],
  }
}

/**
 * The control-plane lane refusing reads.
 *
 * The socket's API_RPC credential is captured once, when the ticket is minted.
 * The worker can now adopt a current credential in place through a REAUTH frame
 * and replay the parked read where that is provably safe, so a refusal that
 * reaches the ledger is one the in-place refresh did NOT repair — or one recorded
 * before it could be attempted. The counter is the only way to tell a stranded
 * socket from a healthy one, because note syncing stays healthy throughout.
 */
function remedyForRefusedControlPlaneReads(stranded: boolean): Remedy {
  return {
    code: 'SOCKET_LANE_CREDENTIAL_REFUSALS',
    summary: stranded
      ? 'The socket’s control-plane lane answered 401 for reads this client made, and they were served over HTTP instead. Reconnect the socket — a reload is enough — and the credential is re-minted.'
      : 'The socket’s control-plane lane answered 498 for reads this client made. That is the recoverable half: the credential was stale rather than refused, and it clears on its own.',
    steps: stranded
      ? [
          'Reload the page, or sign out and back in. Either re-mints the socket ticket, and the lane picks up the current session credential with it.',
          'Expect nothing to look broken in the meantime. Note syncing, collaboration and invites are unaffected; what degrades is the admin and control-plane reads that rode the socket, and they are served over HTTP with no error reaching the screen.',
          'If the count climbs again after a reconnect, the session itself is being refused rather than merely aged — the Account section reports whether this session is signed in and carries the admin role.',
        ]
      : [
          'Nothing to do. A 498 is a stale credential inside the refresh window, the worker presents a fresh one on the socket it already holds, and the read is replayed where replaying it is safe.',
          'Watch the 401 count beside this one. That is the stranded case, and it is the one worth acting on.',
        ],
    effort: stranded ? 'device' : 'wait',
    basis: 'verified',
    because: [
      'This client recorded control-plane reads that the socket lane refused and that were then served over HTTP. The counter is kept precisely because that degradation leaves no other trace.',
      stranded
        ? 'At least one refusal was a 401, which is the lane answering that the credential it holds does not authenticate at all — after the refresh window, or after an in-place refresh could not repair it.'
        : 'The refusals were 498 only, which is the lane answering that its credential is stale and refreshable.',
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Block 1: this client's own transport                                       */
/* -------------------------------------------------------------------------- */

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** What each transport state is worth. */
const TRANSPORT_VERDICT: Record<SyncTransportState, Verdict> = {
  HTTP_ONLY: 'degraded',
  CONNECTING: 'undetermined',
  AUTHENTICATING: 'undetermined',
  READY: 'healthy',
  DEGRADED: 'degraded',
  HTTP_FALLBACK: 'degraded',
  HALF_OPEN: 'degraded',
}

const TRANSPORT_NO_STATUS_NOTE =
  'No transport status was read. That is NOT the same as "no socket": this build cannot tell a client with no realtime transport installed from a caller that did not supply the status, so neither is claimed. Every other row in this block reads "not reported" with it.'

const TRANSPORT_DEFERRED_NOTE =
  'Not negotiated HERE, and not a fault: another tab of this account owns the socket lane, so this tab stands down and sends over HTTP by design. One socket per account is the intended arrangement — two tabs competing for the lane is the defect this replaced. Close or reload the other tab and this one takes the lease over within its TTL.'

/**
 * What the transport's state is worth, with the fallback reason taken into
 * account.
 *
 * A `degraded` state over a DEFERRED reason is not a degradation: the lane is
 * standing down because an external condition holds that is expected and clears
 * on its own. Reported as `informational` so it is still on the screen, still in
 * the copyable report, and no longer drags this section's worst verdict — which
 * is what sent an operator looking for a transport fault over a second browser
 * tab behaving exactly as designed.
 *
 * Every other reason keeps the state's own verdict, so a genuine fallback —
 * `proxy-failed`, `auth-failed`, `worker-error` — still reads `degraded`.
 */
export function transportStateVerdict(
  state: SyncTransportState | undefined,
  reason: SyncFallbackReason | undefined,
): Verdict {
  if (state === undefined) {
    return 'undetermined'
  }

  const verdict = TRANSPORT_VERDICT[state]

  return verdict === 'degraded' && socketFallbackIsDeferred(reason) ? 'informational' : verdict
}

function buildTransportBlock(transport: TransportStatusInput | undefined): DiagnosticBlock {
  const state = transport?.state
  const reason = transport?.fallbackReason
  const disposition = reason === undefined ? undefined : syncFallbackDisposition(reason)
  const operations = transport === undefined ? undefined : transport.operations.length

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Transport in use right now'),
      value: safeEnum(state, SOCKET_TRANSPORT_STATES),
      ...absentOr(state, transportStateVerdict(state, reason)),
      note:
        state === undefined
          ? TRANSPORT_NO_STATUS_NOTE
          : disposition === 'deferred'
            ? `${TRANSPORT_DEFERRED_NOTE} ${describeTransport(transport).detail}`
            : describeTransport(transport).detail,
    }),
    observedRow({
      label: safeConstant('Reported fallback reason'),
      observed: reason,
      value: safeEnum(reason, SOCKET_FALLBACK_REASONS),
      verdict: 'informational',
      note:
        reason === undefined
          ? 'The transport reported no fallback reason. On a READY socket that is correct and expected; with no transport status at all it means nothing was read.'
          : SYNC_FALLBACK_REASON_EXPLANATIONS[reason],
    }),
    diagnosticRow({
      label: safeConstant('What that reason is worth'),
      value: safeEnum(disposition, SOCKET_FALLBACK_DISPOSITIONS),
      ...absentOr(disposition, disposition === 'permanent' ? 'degraded' : 'informational'),
      note: 'Three answers, not two. "permanent" describes an absence rather than a fault — this deployment does not advertise the socket lane, or this client is built or configured never to use it — and no amount of retrying makes one succeed. "retryable" clears on the next attempt, so a transport sitting on one is mid-recovery rather than broken. "deferred" is neither: the lane is standing down because an external condition holds which is EXPECTED and clears by itself, and the only member today is another tab of this account holding the socket. This row read a boolean before, so "deferred" was answered "retryable" — a correct steady state described as a recovery in progress.',
    }),
    diagnosticRow({
      label: safeConstant('Operations negotiated on this socket'),
      value: safeCount(operations),
      ...absentOr(operations, 'informational'),
      note: 'How many operations THIS client negotiated, measured on its own handshake rather than reported by anyone. The count is context; which operations they are, and what each missing one costs, is the Negotiated capabilities block below.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (reason === 'capability-unavailable') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('SOCKET_CAPABILITY_REFUSED'),
        title: 'The server ANSWERED that it does not advertise the socket lane',
        detail:
          'This is not a timeout or a guess: the capability descriptor was read and it offered no sync capability, so the client stood down rather than retrying forever. The boot gate block below is where the reason lives — a lane-gating condition unmet, or the kill switch set — and the fix is there, not here.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
      }),
    )
  }

  return {
    heading: safeConstant('This client’s transport'),
    description:
      'What this browser is actually on, read from its own transport rather than reported by the server. The only direct observation in this section, and the one row that still stands when the diagnostics endpoint cannot be read at all.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 2: the lane and the boot gate                                        */
/* -------------------------------------------------------------------------- */

/**
 * The unmet conditions to report: the shared list, PLUS the host's own when the
 * server reported one and did not already merge it in.
 *
 * Merged here rather than trusted to arrive merged, because the whole point of the
 * host condition is that a lane can read as configured while the host attached
 * nothing — and a condition the panel silently drops is worse than no panel. A
 * duplicate is a cosmetic fault; a dropped condition is the fault this exists to
 * prevent.
 *
 * *** IT RETURNS CODES AND NOTHING ELSE. *** It used to carry
 * `{ code, remedy }`, and the remedy — `entry.remedy`, or `gate.host.remedy` for
 * the merged one — travelled from here into `remedyForPrecondition`'s generic
 * branch and was printed. A measurement over the live payload caught both: an
 * opaque `gate.host.remedy` reached this section's findings whenever the host
 * condition was the only one this build could not name. There is no field for it
 * to travel in now.
 */
function mergedConditions(
  gate: NonNullable<SyncDiagnosticsPayload['gate']> | undefined,
): readonly (string | undefined)[] {
  const listed = (gate?.unmetPreconditions ?? []).map((entry) => entry.code)

  const hostCondition = gate?.host?.unmetCondition
  if (typeof hostCondition !== 'string' || hostCondition.length === 0) {
    return listed
  }
  if (listed.includes(hostCondition)) {
    return listed
  }

  return [...listed, hostCondition]
}

const UNMET_COUNT_NOTE =
  'How many conditions the gate itself reports unmet — a fact about the LIST, never a verdict about the lane. A count of zero is reported as undetermined on purpose: the one cause an operator can fix, a durable command port that is bound and fails the handshake’s readiness check, leaves this list EMPTY because nothing is unmet. An empty list read as health is how this pane once reported a deployment fully available over a socket that refused note syncing.'

/**
 * One finding for one condition — or, for the ones this build cannot name, one
 * finding for all of them, carrying the count.
 *
 * `unnameable` is passed in rather than derived here because the loop below
 * collapses every unrecognised condition onto a single finding (they all reduce to
 * the same `safeEnum` constant, and two findings with one code is a duplicate key
 * in the renderer). The count is what that single finding has to carry instead of
 * the names, so it has to be the count of the whole list and not of this entry.
 */
function conditionFinding(
  raw: string | undefined,
  unnameable: number,
  topology: DeploymentTopology | undefined,
): DiagnosticFinding {
  const known: KnownPreconditionCode | undefined = isKnownPreconditionCode(raw) ? raw : undefined
  const laneGating = known !== undefined && LANE_GATING_PRECONDITIONS.includes(known)

  return diagnosticFinding({
    code: safeEnum(raw, PRECONDITION_CODES),
    title:
      known === undefined
        ? `The gate reports ${countOf(unnameable, 'unmet condition')} this client build does not recognise`
        : laneGating
          ? 'A condition the socket lane itself requires is unmet'
          : 'A condition that withholds note syncing is unmet',
    detail:
      known === undefined
        ? `The server is newer than this client and named a condition outside the closed set this build knows, so the panel will not map it onto one it does know and claims no verdict from it. Neither the code nor the server’s own advice for it is echoed — both are strings the server chose, and the remedy was measured going through the redactor intact on this exact path — so they are counted instead. Updating the client restores the explanation; the server’s boot log names the condition meanwhile. This build knows ${KNOWN_PRECONDITION_CODES.join(
            ', ',
          )}.`
        : laneGating
          ? 'An unmet lane condition closes the socket outright: no ticket is redeemed, nothing is negotiated, and every request — sync, collaboration, API RPC, invites and files — is an HTTP request. The fix below is the one written for THIS deployment’s topology, which is not always the fix the condition’s own name suggests.'
          : 'This condition withholds SYNC_ITEMS only. The socket stays up and keeps carrying collaboration, API RPC, invite events and files while notes sync over HTTP, which is why the lane can be perfectly healthy with this condition unmet.',
    // An unrecognised code claims `broken` and is CAPPED, which is the point
    // rather than a quirk: this build suspects an unmet condition closes the
    // lane, its signal is only correlated, and a `broken` claim survives a proxy
    // ONLY on a necessary condition. Claiming less would hide that the panel had
    // a suspicion at all; claiming it on a necessary relation would assert a
    // logical link nobody established.
    verdict: known === undefined ? 'broken' : laneGating ? 'broken' : 'degraded',
    evidence:
      known === undefined
        ? correlatedProxy(
            'that the gate reported a condition code outside the closed set this build knows',
            'which part of the socket lane that condition closes',
          )
        : EVIDENCE_DIRECT,
    remedy:
      known === undefined ? remedyForUnrecognisedPreconditions(unnameable) : remedyForPrecondition(known, topology),
  })
}

function buildGateBlock(
  gate: NonNullable<SyncDiagnosticsPayload['gate']> | undefined,
  ticketAvailable: boolean | undefined,
  topology: DeploymentTopology | undefined,
): DiagnosticBlock {
  const recorded = gate?.recorded
  const laneEnabled = recorded === true ? gate?.syncLaneEnabled : undefined
  const attached = recorded === true ? gate?.gatewayAttached : undefined
  const conditions = mergedConditions(gate)
  // Counted only against a RECORDED gate. Without one the list establishes
  // nothing in either direction, and a zero read off an unrecorded gate is the
  // same false green one row down.
  const unmetCount = recorded === true ? conditions.length : undefined
  const admitted = admitMembers(conditions, KNOWN_PRECONDITION_CODES)
  const unnameableCount = recorded === true ? admitted.unnameable : undefined

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Boot gate recorded'),
      value: safeYesNo(recorded),
      ...absentOr(recorded, recorded === true ? 'informational' : 'undetermined'),
      note: 'Whether the gateway has written down its boot decision at all. Until it has, nothing else in this block can be read — a request that lands during startup, or a build whose recorder was never wired, reports exactly this. An unrecorded gate is reported as "could not determine", never as a gate that failed.',
    }),
    diagnosticRow({
      label: safeConstant('Socket lane built at boot'),
      value: safeState(laneEnabled, 'built', 'not built'),
      verdict: laneEnabled === true ? 'healthy' : laneEnabled === false ? 'broken' : 'undetermined',
      evidence:
        laneEnabled === undefined
          ? EVIDENCE_ABSENT
          : necessaryProxy(
              'that the boot gate decided to build the socket lane',
              'that a client is being admitted onto it now',
            ),
      note: 'The gate records a DECISION, taken once when the process started. Building the lane is necessary for a client to get onto it and is nowhere near sufficient — which is why a positive reading here is reported as undetermined and the transport row above, measured on this client’s own socket, is the one that can say the lane works. A negative reading is conclusive: an unbuilt lane admits nobody.',
    }),
    diagnosticRow({
      label: safeConstant('Gateway attached to this process'),
      value: safeState(attached, 'attached', 'not attached'),
      verdict: attached === true ? 'healthy' : attached === false ? 'broken' : 'undetermined',
      evidence:
        attached === undefined
          ? EVIDENCE_ABSENT
          : necessaryProxy(
              'that the composition root recorded a successful gateway attach',
              'that the gateway is still serving sockets now',
            ),
      note: 'The gate records a decision; the composition root records the attach OUTCOME. They come from different places and can disagree, and showing only the decision is how this pane came to report a working lane over a gateway that was never there.',
    }),
    diagnosticRow({
      label: safeConstant('Ticket minting right now'),
      value: safeState(ticketAvailable, 'issuing', 'refusing'),
      ...absentOr(ticketAvailable, ticketAvailable === true ? 'healthy' : 'broken'),
      note: 'The gateway’s own answer, asked at the moment the diagnostics were captured rather than at boot: would it mint a socket ticket for a client right now. A refusal closes the lane for everybody and the live refusal reasons below say why.',
    }),
    diagnosticRow({
      label: safeConstant('Unmet boot conditions'),
      value: safeCount(unmetCount),
      verdict: unmetCount === undefined ? 'undetermined' : unmetCount === 0 ? 'healthy' : 'degraded',
      evidence:
        unmetCount === undefined
          ? EVIDENCE_ABSENT
          : unmetCount === 0
            ? necessaryProxy(
                'that the gate listed no unmet condition',
                'that every socket operation is actually offered',
              )
            : EVIDENCE_DIRECT,
      note: UNMET_COUNT_NOTE,
    }),
    observedRow({
      label: safeConstant('Unmet conditions this build cannot name'),
      observed: unnameableCount,
      value: safeCount(unnameableCount),
      // A fact about this build's VOCABULARY, not about the lane — so zero is
      // `informational` rather than healthy, and a non-zero reading is
      // `undetermined` rather than degraded: there is a condition here whose
      // effect this build cannot establish, which is precisely what that verdict
      // means. The finding beside it carries the same count and says so.
      verdict: unnameableCount === 0 ? 'informational' : 'undetermined',
      note: 'How many of the conditions above the gate named outside the closed set this build knows. They are counted and never echoed, because a condition code is a string the server chose and this screen is written to be pasted into an issue — the row that used to print such a code did it through a denylist, and a value with no address shape was measured going straight through. A non-zero reading says the server is newer than this client: a client update restores the explanation, and the server’s boot log names the condition meanwhile.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  /**
   * One finding per condition, deduplicated by the SAFE code rather than the raw
   * one: two unrecognised codes both reduce to the same constant, and a finding
   * list with two identical codes is a duplicate key in the renderer as well as a
   * duplicate row on screen. The single collapsed finding carries the COUNT of
   * what was collapsed into it, which is why `admitted.unnameable` is passed down
   * rather than recomputed per entry.
   */
  const seen = new Set<string>()
  for (const condition of conditions) {
    const finding = conditionFinding(condition, admitted.unnameable, topology)
    const key = String(finding.code)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    findings.push(finding)
  }

  if (recorded === true && laneEnabled === true && attached === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('LANE_BUILT_WITHOUT_GATEWAY'),
        title: 'The lane was built and no attached gateway was recorded',
        detail:
          'The boot gate built the sync lane and the host recorded no successful attach. On a current server build that combination means the host declined to attach AFTER the gate passed — an invalid WEBSOCKET_REDIS_NAMESPACE does exactly this, closing the push bridge rather than publishing on a sibling stack’s channels — so tickets mint while nothing is ever delivered. On a server older than the attach-outcome record the field is simply never set, and then this says only that it was not reported.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        // The host's own remedy string used to be handed in beside this code and
        // printed in the remedy's `because`. It is not: the condition is one this
        // build owns, so the advice is this build's own copy for it.
        remedy: remedyForPrecondition('WEBSOCKET_REDIS_NAMESPACE_INVALID', topology),
      }),
    )
  }

  return {
    heading: safeConstant('Socket lane and boot gate'),
    description:
      'The conditions the gateway checks at boot, and what it decided. THREE of them gate the socket lane itself — the connection-token secret, shared Redis state and the WEBSOCKET_SYNC_ENABLED kill switch — and an unmet one closes the lane outright. The fourth, the durable gRPC backend, withholds SYNC_ITEMS only: the socket stays up and keeps carrying collaboration, API RPC, invite events and files while note syncing falls back to HTTP.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 3: SYNC_ITEMS                                                        */
/* -------------------------------------------------------------------------- */

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each SYNC_ITEMS state claims.
 *
 * `WITHHELD` is `degraded` rather than `broken` because sync transparently falls
 * back to HTTP — verified live on a real stack, not inferred — so notes keep
 * saving. `NOT_OBSERVED` is `undetermined` and must never be anything else: it is
 * the gate saying it cannot tell, and the state the server omits the legacy
 * boolean for entirely.
 */
const SYNC_ITEMS_VERDICT: Record<SyncItemsState, Verdict> = {
  ADVERTISED: 'healthy',
  WITHHELD: 'degraded',
  NOT_OBSERVED: 'undetermined',
}

function buildSyncItemsBlock(payload: SyncDiagnosticsPayload | undefined): DiagnosticBlock {
  // CONSUMED, not re-derived. `gate.syncItemsAdvertised` is never read in this
  // file: on the builds that sent it, it was derived from whether a proxy OBJECT
  // had been constructed rather than from the predicate the handshake asks.
  const verdict = describeSyncItems(payload)
  const probe = payload?.gate?.syncItems?.probe

  /**
   * `describeSyncItems` nulls a cause it does not recognise and raises
   * `unrecognisedCause` instead, so the two are told apart HERE: a cause outside
   * the closed set reads "other (unrecognised)" and a verdict that named none at
   * all reads "not reported". Collapsing them would report a server that DID say
   * something as a server that said nothing.
   */
  const causeKnown = verdict.cause !== null
  const causeNamed = causeKnown || verdict.unrecognisedCause

  /**
   * Whether the server reports the structured verdict is only knowable once a
   * payload has been READ. With none in hand, `reported` is `false` because
   * nothing was there to read — and printing that as "no" would be a claim about
   * a server this build never asked.
   */
  const reportsVerdict = payload === undefined ? undefined : verdict.reported

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('SYNC_ITEMS on the socket'),
      value: safeEnum(verdict.state, SYNC_ITEMS_STATES),
      verdict: SYNC_ITEMS_VERDICT[verdict.state],
      evidence:
        verdict.state === 'NOT_OBSERVED'
          ? EVIDENCE_ABSENT
          : verdict.state === 'ADVERTISED'
            ? necessaryProxy(
                'that the gate read the handshake’s own readiness predicate and it answered ready',
                'that this client’s socket negotiated SYNC_ITEMS',
              )
            : EVIDENCE_DIRECT,
      note: verdict.detail,
    }),
    diagnosticRow({
      label: safeConstant('Why, as the gate names it'),
      value: causeKnown
        ? safeEnum(verdict.cause, SYNC_ITEMS_CAUSES)
        : verdict.unrecognisedCause
          ? safeConstant(UNRECOGNISED)
          : safeEnum(undefined, SYNC_ITEMS_CAUSES),
      ...absentOr(causeNamed || undefined, 'informational'),
      note: verdict.unrecognisedCause
        ? 'The server named a cause outside the closed set this build knows, so it is refused rather than paraphrased as one this build does know. The state above is the server’s own verdict and still stands.'
        : verdict.title,
    }),
    observedRow({
      label: safeConstant('Handshake predicate reading'),
      observed: probe,
      value: safeEnum(probe, SYNC_ITEMS_PROBES),
      verdict: 'informational',
      note: 'The raw reading the gate took of the predicate the handshake itself asks, which is what lets "unknown" be told apart from "no". NEVER_PROBED is a host that took no reading; PROBE_FAILED is the question itself throwing, and the thrown message is deliberately not sent here because it can embed a resolved service address. Neither is a withheld operation.',
    }),
    diagnosticRow({
      label: safeConstant('Server reports the structured verdict'),
      value: safeYesNo(reportsVerdict),
      ...absentOr(reportsVerdict, reportsVerdict === true ? 'informational' : 'undetermined'),
      note: 'Whether the running server sends the three-state verdict at all. A server that does not sends only a single boolean, and this panel will NOT fall back to it: that boolean was derived from whether a proxy object had been constructed, not from the predicate the handshake asks, so it read green over sockets that withheld the operation. The capability rows below measure what this client actually negotiated and need no server call.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  // WITHHELD only. "The gate could not say" is not a gap in the lane, and
  // inventing a finding for it would make every pre-verdict server build read as
  // degraded on no evidence — the same error in the other direction.
  if (verdict.state === 'WITHHELD') {
    const remedy = verdict.cause === 'DURABLE_BACKEND_NOT_READY' ? remedyForWithheldSyncItems() : undefined

    findings.push(
      diagnosticFinding({
        code: safeConstant('SYNC_ITEMS_WITHHELD'),
        title: verdict.title,
        // The server's own sentence, already redacted by `describeSyncItems` and
        // already null for the two causes whose advice is printed beside their
        // condition instead. Prose for the screen: a finding's detail is not a
        // path into the copyable report, which is what makes printing server copy
        // here affordable at all.
        detail: verdict.remedy === null ? verdict.detail : `${verdict.detail} The server reports: ${verdict.remedy}`,
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        ...(remedy === undefined ? {} : { remedy }),
      }),
    )
  }

  return {
    heading: safeConstant('SYNC_ITEMS — note syncing over the socket'),
    description:
      'Its own block because it is its own decision: the socket can be perfectly healthy and carrying collaboration, API RPC, invite events and files while note syncing falls back to HTTP. The verdict is read whole from the gate — three states, a closed cause and the raw predicate reading — and never derived from the older advertised boolean, which reported a constructed proxy object rather than a ready backend.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 4: negotiated capabilities                                           */
/* -------------------------------------------------------------------------- */

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** The label for each operation. */
const OPERATION_LABEL: Record<SyncNegotiatedOperation, SafeValue> = {
  SYNC_ITEMS: safeConstant('SYNC_ITEMS — note syncing'),
  AUTHORIZE_COLLABORATION: safeConstant('AUTHORIZE_COLLABORATION — live editing'),
  API_RPC: safeConstant('API_RPC — control-plane reads'),
  STREAM_ASSISTANT: safeConstant('STREAM_ASSISTANT — assistant streaming'),
  INVITE_EVENTS: safeConstant('INVITE_EVENTS — pushed invitations'),
  FILES_V1: safeConstant('FILES_V1 — file transfers'),
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each capability status is worth.
 *
 * `not-negotiated` is `degraded` and not `broken`, held consistently with the
 * SYNC_ITEMS row: one operation missing from a live socket costs that operation's
 * realtime lane, and its traffic is carried over HTTP. The pane has already
 * contradicted itself on this exact point once, reporting the same withheld
 * operation as a degradation in one tab and an outage in the next.
 */
const CAPABILITY_VERDICT: Record<CapabilityStatus, Verdict> = {
  active: 'healthy',
  'not-negotiated': 'degraded',
  'client-gap': 'degraded',
  'recognized-only': 'degraded',
  unknown: 'undetermined',
}

function advertisableNote(status: CapabilityStatus, advertisable: boolean | undefined): string {
  if (advertisable === undefined || status === 'active') {
    return ''
  }
  return advertisable === false
    ? ' The gateway reports that it could not advertise this operation at all, which is the server-side half of the same fact: the adapter behind it did not compose at boot, and the boot gate block says which condition declined it.'
    : ' The gateway reports that it CAN advertise this operation, so the gap is in this socket’s own handshake rather than in the server’s composition — a client that connected before the adapter was ready keeps the handshake it was given until it reconnects.'
}

function buildCapabilityBlock(
  payload: SyncDiagnosticsPayload | undefined,
  transport: TransportStatusInput | undefined,
  counters: SocketGatewayCountersView,
): DiagnosticBlock {
  const serverOperations = payload?.protocol?.serverOperations
  const negotiated = transport?.operations
  const socketIsLive = transport?.state === 'READY' || transport?.state === 'DEGRADED'
  const capabilityRows: readonly CapabilityRow[] = buildCapabilityRows(
    serverOperations ?? [],
    negotiated ?? [],
    socketIsLive,
  )

  const byOperation = new Map<string, CapabilityRow>(capabilityRows.map((row) => [row.operation, row]))
  const unrecognised = capabilityRows.filter((row) => !(SOCKET_OPERATIONS as readonly string[]).includes(row.operation))

  /**
   * No row is built when NEITHER side was read. `buildCapabilityRows` always
   * returns a row per operation this build knows about — correct for the panel it
   * was written for, and here it would mean six confident "not negotiated" rows
   * over a client whose transport was never read and a server that answered
   * nothing. That is a negative verdict from absent evidence, which is the one
   * thing the contract forbids outright.
   */
  const observedEitherSide = serverOperations !== undefined || negotiated !== undefined

  const rows: DiagnosticRow[] = []

  for (const operation of SOCKET_OPERATIONS) {
    const row = byOperation.get(operation)
    const advertisable = counters.advertisable?.[operation]

    if (!observedEitherSide || row === undefined) {
      rows.push(
        diagnosticRow({
          label: OPERATION_LABEL[operation],
          value: safeEnum(undefined, CAPABILITY_STATUSES),
          verdict: 'undetermined',
          evidence: EVIDENCE_ABSENT,
          note: 'Neither this client’s handshake nor the server’s operation list was read, so nothing is known about this operation. Not negotiated, and not reported, are different answers.',
        }),
      )
      continue
    }

    rows.push(
      diagnosticRow({
        label: OPERATION_LABEL[operation],
        value: safeEnum(row.status, CAPABILITY_STATUSES),
        verdict: CAPABILITY_VERDICT[row.status],
        // Direct for every status except `unknown`: an operation's presence in or
        // absence from THIS client's handshake is observed, not reported. The
        // `unknown` arm is the one where the socket was not live or one side was
        // never advertised, and nothing was observed about it at all.
        evidence: row.status === 'unknown' ? EVIDENCE_ABSENT : EVIDENCE_DIRECT,
        note: `${row.explanation}${advertisableNote(row.status, advertisable)}`,
      }),
    )
  }

  rows.push(
    diagnosticRow({
      label: safeConstant('Protocol version the server reports'),
      value: safeCount(payload?.protocol?.version),
      ...absentOr(payload?.protocol?.version, 'informational'),
      note: 'The handshake protocol version this server build speaks. Context for a client and server that disagree about an operation; it is not a verdict on its own.',
    }),
    diagnosticRow({
      label: safeConstant('Operations this server advertises'),
      value: safeCount(serverOperations?.length),
      ...absentOr(serverOperations, 'informational'),
      note: 'How many operations the server build knows how to negotiate, which is a property of the BUILD and not of its configuration. An operation missing from this list is never fixed by a setting.',
    }),
    diagnosticRow({
      label: safeConstant('Operations this build does not recognise'),
      value: safeCount(observedEitherSide ? unrecognised.length : undefined),
      ...absentOr(
        observedEitherSide ? unrecognised.length : undefined,
        unrecognised.length > 0 ? 'degraded' : 'informational',
      ),
      note: 'Operations either side named that this client build has no handler for. COUNTED here AND counted in the finding below — the names are never printed anywhere on this screen. This row used to say they were named below, on the grounds that a remedy is screen-only and already redacted, and a live probe falsified both halves: the redaction is a denylist, so it withheld an address-shaped operation name and printed an opaque one verbatim, and the remedy is not screen-only either — it reaches the copyable report, which exists to be pasted into an issue. An operation name is a string the SERVER chose; the only ones this pane prints are the ones this build itself declares, and the finding lists those beside the count so you can tell which side the gap is on. Recognising an operation at the handshake is what stops its advertisement dropping the WHOLE socket, so this count is worth watching even while each individual lane is merely absent.',
    }),
  )

  const findings: DiagnosticFinding[] = []

  const gaps = capabilityRows.filter((row) => row.status === 'client-gap').map((row) => row.operation)
  if (gaps.length > 0) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('CLIENT_GAP'),
        title: 'The server can negotiate operations this client build cannot consume',
        detail:
          'The server advertises them and this client has no handler, so they will never be used however the server is configured. Nothing on the server fixes this — it needs a client release. The remedy below COUNTS them rather than naming them, and lists the operations this build does declare instead: an operation name is a string the server chose, and this screen — remedy included — is written to be pasted into an issue. Read the two together and the count tells you which side the gap is on, which the bare name of a lane you have never heard of does not.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForClientGap(gaps),
      }),
    )
  }

  const recognizedOnly = capabilityRows.filter((row) => row.status === 'recognized-only')
  if (recognizedOnly.length > 0) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('RECOGNIZED_BUT_UNCONSUMED'),
        title: 'An operation is negotiated and carries nothing',
        detail:
          'This client tolerates the operation at the handshake, which is what stops its advertisement costing the entire socket, but it has no handler for it — so the lane appears in a healthy handshake and its traffic stays on HTTP. It is the single row an operator is most likely to misread as working, and it needs a client change rather than configuration.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
      }),
    )
  }

  return {
    heading: safeConstant('Negotiated capabilities'),
    description:
      'Every operation either side knows about, and what happened to it on THIS client’s socket. The one direct measurement of the gate’s decisions: a server that intended to offer an operation and a socket that actually carries it are different facts, and this block holds the second.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 5: the advertised capability descriptor                              */
/* -------------------------------------------------------------------------- */

/**
 * `live.capabilities` has been in the payload since the endpoint existed and was
 * rendered NOWHERE. It is the descriptor the transport reads before it will even
 * attempt a socket, so an empty list is the difference between "the socket failed"
 * and "the client never tried", and its `endpoint` is a compile-time constant of
 * the gateway rather than a configured address.
 */
function buildDescriptorBlock(
  capabilities: NonNullable<SyncDiagnosticsPayload['live']>['capabilities'],
): DiagnosticBlock {
  const entries = capabilities
  const count = entries?.length
  const sync = entries?.find((entry) => entry.id === 'ws-sync') ?? entries?.[0]

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Capability entries advertised'),
      value: safeCount(count),
      verdict: count === undefined ? 'undetermined' : count === 0 ? 'broken' : 'healthy',
      evidence:
        count === undefined
          ? EVIDENCE_ABSENT
          : count === 0
            ? EVIDENCE_DIRECT
            : necessaryProxy(
                'that the gateway advertises at least one capability entry',
                'that a client can open and authenticate a socket',
              ),
      note: 'What the capability descriptor offers. An EMPTY list is conclusive in the bad direction: the transport reads this before it will attempt a socket at all, so an empty list means no client on this deployment ever tries, and the fallback reason above reads capability-unavailable. A non-empty list is necessary and not sufficient, which is why it is reported as undetermined.',
    }),
    observedRow({
      label: safeConstant('Socket capability id'),
      observed: sync?.id,
      value: safeEnum(sync?.id, SOCKET_CAPABILITY_IDS),
      verdict: 'informational',
      note: 'The id the transport looks for. Admitted against the one value this build knows, so an entry a newer gateway adds is refused rather than printed.',
    }),
    observedRow({
      label: safeConstant('Protocol version advertised'),
      observed: sync?.version,
      value: safeCount(sync?.version),
      verdict: 'informational',
      note: 'The version in the descriptor. Read against the protocol version the server reports in the block above: a disagreement between the two is a gateway and an api-gateway from different builds.',
    }),
    observedRow({
      label: safeConstant('Socket endpoint advertised'),
      observed: sync?.endpoint,
      value: safeEnum(sync?.endpoint, SOCKET_ENDPOINTS),
      verdict: 'informational',
      note: 'A compile-time constant of the gateway, not a configured address, which is why it can be printed at all. Admitted against this build’s own value: an endpoint the descriptor reported that does not match is refused rather than echoed.',
    }),
  ]

  return {
    heading: safeConstant('Advertised socket capability'),
    description:
      'The descriptor a client reads before it attempts a socket. It is in the diagnostics payload and was rendered nowhere until now, which left "the client never tried" looking exactly like "the socket failed".',
    rows,
    findings: [],
  }
}

/* -------------------------------------------------------------------------- */
/* Block 6: live refusals                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The gateway's answer when asked for a ticket right now.
 *
 * Reported only when the LANE itself came up. Otherwise they merely restate the
 * gate, and keyed on the lane rather than on "no unmet conditions at all",
 * because since the gate was split an unmet `SYNCING_SERVER_GRPC_UNBOUND` no
 * longer stops the lane — suppressing live reasons on its account would hide a
 * real, independent refusal.
 */
function buildRefusalBlock(
  payload: SyncDiagnosticsPayload | undefined,
  topology: DeploymentTopology | undefined,
): DiagnosticBlock {
  const reasons = payload?.live?.unavailabilityReasons
  const gate = payload?.gate
  const conditions = mergedConditions(gate)
  const laneDown = gate?.syncLaneEnabled === false || (gate?.syncLaneEnabled === undefined && conditions.length > 0)

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Live refusal reasons reported'),
      value: safeCount(reasons?.length),
      ...absentOr(reasons, reasons !== undefined && reasons.length > 0 ? 'degraded' : 'informational'),
      note: 'How many reasons the gateway gives for refusing a ticket at the moment the diagnostics were captured. Zero is informational rather than healthy: a gateway with nothing to refuse and a gateway nobody asked look identical from here, and the ticket-minting row above is the one that carries that verdict.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (!laneDown) {
    const seen = new Set<string>()
    for (const reason of reasons ?? []) {
      const code = safeEnum(reason, LIVE_REFUSAL_REASONS)
      const key = String(code)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)

      const known = KNOWN_LIVE_REFUSAL_REASONS.find((candidate) => candidate === reason)
      const remedy = known === undefined ? undefined : remedyForLiveReason(known, topology)

      findings.push(
        diagnosticFinding({
          code,
          title:
            known === undefined
              ? 'The gateway reported a refusal reason this client build does not recognise'
              : 'The gateway is refusing tickets, and named why',
          detail:
            known === undefined
              ? 'The reason is outside the closed set this build knows, so it is refused rather than paraphrased and no verdict is claimed from it. The reason itself is not echoed; a client update restores the explanation.'
              : 'The boot gate passed and the gateway is still refusing. That makes this an independent fault rather than a restatement of the gate, which is why it is reported at all — a live reason printed on top of an unmet gate is the same problem twice.',
          // Capped for the same reason the unrecognised precondition is: the
          // suspicion is stated, and a `broken` claim does not survive a merely
          // correlated signal.
          verdict: 'broken',
          evidence:
            known === undefined
              ? correlatedProxy(
                  'that the gateway named a refusal reason outside the closed set this build knows',
                  'what that reason refuses, or for how long',
                )
              : EVIDENCE_DIRECT,
          ...(remedy === undefined ? {} : { remedy }),
        }),
      )
    }
  }

  return {
    heading: safeConstant('Live refusals'),
    description: laneDown
      ? 'What the gateway says when asked for a ticket right now. The lane itself did not come up on this deployment, so any live reason restates the boot gate above rather than adding to it, and none is reported here.'
      : 'What the gateway says when asked for a ticket right now. These are reported only because the lane DID come up, which makes each one an independent fault rather than an echo of a condition already named above.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 7: realtime health                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The attached gateway's own view of itself.
 *
 * `describeRealtimeHealth` is reused for its NOTES — the copy that distinguishes
 * an in-process push bridge from a missing one, and a relay that only reaches one
 * replica — and its VALUES are re-derived from the typed fields instead. ONE
 * structural reason, which is sufficient on its own:
 *
 *   - Its values are plain strings with server text already interpolated into
 *     them (`${sanitizeServerCopy(bridge)} (ready)`), so crossing the presence-only
 *     boundary with one would need the brand cast that
 *     `diagnosticsSections.spec.ts` greps every section module for. This is the
 *     same decision `environmentSection.ts` made about `describeTopology`.
 *
 * A second reason used to stand beside it and no longer holds. It is corrected
 * here rather than deleted, because a justification this specific gets
 * re-derived from memory by the next reader: that helper printed
 * `String(realtime.pushesDispatched ?? 0)`, so an absent counter read as a
 * measured zero — rule 3 of the contract inverted, on the row where it mattered
 * most. `bf6dafe0` fixed the helper itself; every field on the snapshot is now
 * read with an explicit presence test and answers "not reported" when there is
 * nothing there. So absent-is-not-a-reading is no longer an argument for
 * re-deriving anything, and the brand cast above is carrying the decision alone.
 */
const CONSUMER_NOT_APPLICABLE = safeConstant('not applicable (no queue configured)')

const CONSUMER_TOPOLOGY_NOTE =
  'Whether an idle loop is a fault depends on whether there is a queue at all, which is why this row reads the queue\'s presence boolean as well as the loop. With events fanned out in process there is nothing to drain and "not running" is the only correct reading, so it is reported as not applicable here rather than as an absence — true either way, and one of them reads as a defect. Where a queue IS configured the same idle loop means its events are not being drained, and that IS reported as a degradation. With no presence block to read, no claim is made in either direction.'

/**
 * The queue-consumer loop, judged against whether a queue exists.
 *
 * Split out of the row so each of the four readings can be pinned by a test. The
 * `undefined` queue case keeps this build's previous unjudged reading on purpose:
 * a server that reports no presence block has not said there is no queue.
 */
export function consumerVerdict(running: boolean | undefined, queueConfigured: boolean | undefined): Verdict {
  if (running === true) {
    return 'healthy'
  }
  if (running === false && queueConfigured === true) {
    return 'degraded'
  }
  return 'informational'
}

function consumerValue(running: boolean | undefined, queueConfigured: boolean | undefined): SafeValue {
  if (running === false && queueConfigured === false) {
    return CONSUMER_NOT_APPLICABLE
  }
  return safeState(running, 'running', 'not running')
}

function buildRealtimeBlock(
  realtime: NonNullable<SyncDiagnosticsPayload['live']>['realtime'],
  topology: DeploymentTopology | undefined,
): DiagnosticBlock {
  const notes = new Map<string, string>(describeRealtimeHealth(realtime).map((row) => [row.label, row.note]))
  const noteFor = (label: string, fallback: string): string => notes.get(label) ?? fallback

  if (realtime === undefined) {
    return {
      heading: safeConstant('Realtime health'),
      description:
        'What the attached gateway says about itself. Informational by design: readiness is deliberately not gated on any of it, because a container that restarts itself on a Redis blip turns ten seconds of degradation into an outage.',
      rows: [],
      findings: [],
      emptyNote:
        'This server reported no realtime health snapshot. Either no websocket gateway is attached to the process that answered — in which case nothing is delivered over the socket, whatever the boot gate says — or this build predates the snapshot. The boot gate block above distinguishes the two, and no verdict is claimed from the silence.',
    }
  }

  const bridge = realtime.pushBridge
  const bridgeBound = bridge === 'redis' || bridge === 'in-process'
  const queueConfigured = presenceOf(topology, 'SQS_QUEUE_URL')

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Attached gateway'),
      value: safeState(realtime.attached, 'attached', 'not attached'),
      ...absentOr(realtime.attached, realtime.attached === true ? 'healthy' : 'broken'),
      note: noteFor(
        'Gateway',
        'Whether a websocket gateway is attached to the process that answered. Nothing reaches a client over a socket without one, regardless of what the boot gate decided.',
      ),
    }),
    diagnosticRow({
      label: safeConstant('Push bridge'),
      value: safeTokens(safeEnum(bridge, PUSH_BRIDGES), safeState(realtime.pushBridgeReady, '(ready)', '(not ready)')),
      verdict:
        bridge === undefined
          ? 'undetermined'
          : !bridgeBound
            ? 'broken'
            : realtime.pushBridgeReady === true
              ? 'healthy'
              : 'degraded',
      evidence: bridge === undefined ? EVIDENCE_ABSENT : EVIDENCE_DIRECT,
      note: noteFor(
        'Push bridge',
        'What carries server-side change notifications to live sockets. Only "none" is a fault: a single process holding every socket reports an in-process bridge and is healthy, and a multi-container deployment reports redis.',
      ),
    }),
    diagnosticRow({
      label: safeConstant('Realtime queue consumer'),
      value: consumerValue(realtime.sqsConsumerRunning, queueConfigured),
      ...absentOr(realtime.sqsConsumerRunning, consumerVerdict(realtime.sqsConsumerRunning, queueConfigured)),
      note: `${noteFor(
        'Queue consumer',
        'The loop that drains websocket events from the queue.',
      )} ${CONSUMER_TOPOLOGY_NOTE}`,
    }),
    diagnosticRow({
      label: safeConstant('Collaboration relay'),
      value: safeState(realtime.collaborationRelayHealthy, 'healthy', 'unhealthy'),
      ...absentOr(
        realtime.collaborationRelayHealthy,
        realtime.collaborationRelayHealthy === true ? 'healthy' : 'degraded',
      ),
      note: noteFor(
        'Collaboration relay',
        'The fleet-wide relay subscription. Collaboration still works between clients on the SAME replica without it, which is why it fails quietly on a multi-replica deployment.',
      ),
    }),
    diagnosticRow({
      label: safeConstant('Gateway would admit a client now'),
      value: safeEnum(realtime.syncLane, SYNC_LANE_STATES),
      verdict: realtime.syncLane === undefined ? 'undetermined' : realtime.syncLane === 'up' ? 'healthy' : 'broken',
      evidence: realtime.syncLane === undefined ? EVIDENCE_ABSENT : EVIDENCE_DIRECT,
      note: noteFor(
        'Sync lane',
        'Whether the gateway would accept a client on the sync path at this instant. The live refusal reasons above say why it would not.',
      ),
    }),
    diagnosticRow({
      label: safeConstant('Pushes dispatched since attach'),
      value: safeCount(realtime.pushesDispatched),
      ...absentOr(realtime.pushesDispatched, 'informational'),
      note: `${noteFor('Pushes dispatched', 'Push messages handed to local sockets since this gateway attached. It resets on every restart.')} Reported as "not reported" when the server sent no counter at all, rather than as a zero: a count that stays at zero on a busy deployment is the signature of a delivery path that never fires, and that reading is only worth anything if a silent server cannot produce it. A zero is NOT that signature on its own and carries no verdict here: a quiet account, a gateway restarted a moment ago, and an account whose only live socket is in another tab of this browser all dispatch nothing and are all correct. It is the counter staying at zero WHILE two devices are visibly saving that means something.`,
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (realtime.attached === true && bridge === 'none') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('PUSH_BRIDGE_ABSENT'),
        title: 'The socket is attached with no push bridge',
        detail:
          'The lane accepts clients, but nothing carries server-side change notifications to them, so a save on one device never reaches another until that device syncs on its own. This is a misconfiguration rather than a topology: a process that was asked for a Redis-backed plane without a reachable Redis host. A deployment that simply has no Redis reports an in-process bridge instead and is healthy, and a multi-container one reports redis — only "none" is a fault. The other way to reach it is a server build older than the in-process plane, which an upgrade fixes rather than any setting.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
      }),
    )
  }

  return {
    heading: safeConstant('Realtime health'),
    description:
      'What the attached gateway says about itself. Informational by design: readiness is deliberately not gated on any of it, because a container that restarts itself on a Redis blip turns ten seconds of degradation into an outage. This block makes the degradation visible; it does not act on it.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 8: the FILES_V1 sub-gate                                             */
/* -------------------------------------------------------------------------- */

function buildFilesBlock(gate: NonNullable<SyncDiagnosticsPayload['gate']> | undefined): DiagnosticBlock {
  const files = gate?.files
  const advertised = files?.advertised
  const condition = files?.unmetCondition

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('FILES_V1 at the boot gate'),
      value: safeState(advertised, 'advertised', 'withheld'),
      verdict: advertised === true ? 'healthy' : advertised === false ? 'degraded' : 'undetermined',
      evidence:
        advertised === undefined
          ? EVIDENCE_ABSENT
          : advertised === true
            ? necessaryProxy(
                'that the boot gate advertised the realtime file transport',
                'that this client’s socket negotiated FILES_V1',
              )
            : EVIDENCE_DIRECT,
      note: 'A sub-gate of its own: the file transport can be waived at boot while every other operation is offered. Withheld, file uploads and downloads use ordinary HTTP requests — slower, and no other symptom — which is why this is a degradation rather than an outage. What this client actually negotiated is the FILES_V1 row in the capabilities block.',
    }),
    observedRow({
      label: safeConstant('FILES_V1 unmet condition'),
      observed: condition,
      value: safeEnum(condition, FILES_UNMET_CONDITIONS),
      verdict: 'informational',
      note: 'Which precondition the composition found missing. FILES_INTERNAL_URL covers the whole internal-URL group, because any one of them satisfies the requirement; TRANSPORT_CONSTRUCTION is the residual case where every value was present and the adapter still threw, and its thrown message stays in the boot log because it can embed the resolved files-service address.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (advertised === false) {
    // *** THE SERVER'S OWN SENTENCE IS NOT PRINTED HERE ANY MORE. ***
    //
    // It was, through `sanitizeServerCopy`, on the argument that a finding's
    // detail is screen-only and therefore affordable. Both halves of that were
    // wrong. The screen is the thing an operator photographs and pastes during an
    // incident, and a denylist is the wrong mechanism either way: a marker-built
    // `gate.files.remedy` with no address shape was measured printing intact into
    // this section's findings. What replaces it is this build's own sentence for
    // the ADMITTED condition, which is more specific than the server's generic
    // copy was, and a counted placeholder for a condition outside the four.
    const named = isKnownFilesUnmetCondition(condition) ? condition : undefined

    findings.push(
      diagnosticFinding({
        code: safeConstant('FILES_V1_WITHHELD'),
        title: 'The realtime file transport was waived at boot',
        detail:
          named === undefined
            ? `File transfers use ordinary HTTP requests. The gate named a condition outside the closed set this build knows, so neither it nor the server’s advice for it is echoed — both are strings the server chose. This build knows ${KNOWN_FILES_UNMET_CONDITIONS.join(
                ', ',
              )}; a client update restores the explanation.`
            : FILES_CONDITION_MEANING[named],
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
      }),
    )
  }

  return {
    heading: safeConstant('FILES_V1 sub-gate'),
    description:
      'The file transport has its own boot condition, so it can be withheld while the rest of the socket is healthy. Kept as its own block because its causes are different variables from the lane’s and from note syncing’s.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 9: gateway admission and traffic                                     */
/* -------------------------------------------------------------------------- */

const REJECTION_ROW: Record<SocketRejectionCause, { label: SafeValue; note: string }> = {
  originNotAllowed: {
    label: safeConstant('Connections refused: origin not allowed'),
    note: 'Clients that reached the socket and were turned away at the allowlist. Non-zero with a non-empty allowlist means some origin is connecting that nobody added — read it with the admission row above, which answers the same question for THIS browser.',
  },
  queryStringNotPermitted: {
    label: safeConstant('Connections refused: query string not permitted'),
    note: 'The ticket travels in a header, never in the URL, and a connection that carries a query string is refused rather than read. Non-zero means something between the client and the gateway is rewriting the URL — or an older client is still presenting its ticket the old way.',
  },
  unavailable: {
    label: safeConstant('Connections refused: lane unavailable'),
    note: 'Clients refused because the lane itself was not serving. A consequence of the boot gate and the live refusals above rather than an independent fault, and it is here so that "nobody connects" can be told apart from "everybody is turned away".',
  },
}

const ADMISSION_HEADING = safeConstant('Gateway admission and traffic')

const ADMISSION_DESCRIPTION =
  'Whether clients arrive, and whether they are being turned away. Counters and one boolean about this client’s own origin — never the allowlist, and never an address.'

/**
 * Whether the caller reported ANY admission counter.
 *
 * Read member by member rather than from the object's presence, because
 * `buildWebsocketSection` substitutes `{}` for an absent `counters` — so "the
 * caller passed nothing" and "the caller passed an empty object" arrive here
 * identically, and both mean the same thing: nothing was reported.
 */
function admissionReported(counters: SocketGatewayCountersView): boolean {
  return (
    counters.originAdmitted !== undefined ||
    counters.allowedOriginCount !== undefined ||
    counters.allowsSameOrigin !== undefined ||
    counters.liveSockets !== undefined ||
    counters.ticketsIssued !== undefined ||
    counters.ticketsRefused !== undefined ||
    counters.handshakeRejected !== undefined ||
    counters.rejections !== undefined
  )
}

function buildAdmissionBlock(counters: SocketGatewayCountersView): DiagnosticBlock {
  /**
   * ONE SENTENCE RATHER THAN ELEVEN EMPTY ROWS.
   *
   * No endpoint publishes these counters — the gateway half of this block lands
   * separately — so on every deployment today each row rendered "not reported",
   * and eleven of them in a row is a panel that looks broken while saying nothing.
   * The information content of the eleven is identical to the information content
   * of the sentence, and the sentence is the half an operator reads. The rows
   * return the moment anything populates them, member by member.
   *
   * It also stops eleven `undetermined` rows contributing to this section's worst
   * verdict, which is correct for the same reason: a block with no producer
   * established nothing, and the Lane degradation ledger block below has reported
   * its own absence this way since it was written.
   */
  if (!admissionReported(counters)) {
    return {
      heading: ADMISSION_HEADING,
      description: ADMISSION_DESCRIPTION,
      rows: [],
      findings: [],
      emptyNote:
        'Nothing populates these counters on any deployment yet: the gateway half — origins admitted and permitted, same-origin admission, sockets held, tickets issued and refused, handshakes rejected, and the three connection-refusal counts — lands separately, and no endpoint this pane can reach reports one of them today. Every row here appears the moment one is reported. Until then this block claims nothing rather than rendering ten rows that each say "not reported".',
    }
  }

  const admitted = counters.originAdmitted
  const originCount = counters.allowedOriginCount
  const issued = counters.ticketsIssued
  const rejected = counters.handshakeRejected

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('This client’s origin admitted'),
      value: safeYesNo(admitted),
      verdict: admitted === true ? 'healthy' : admitted === false ? 'broken' : 'undetermined',
      evidence:
        admitted === undefined
          ? EVIDENCE_ABSENT
          : necessaryProxy(
              'that the gateway would admit the origin this admin request arrived from',
              'that a socket from this origin then authenticates',
            ),
      note: 'Whether this browser would be let onto the socket at all — the question whose only other evidence is a 1008 close that no screen reads. Admission is necessary and nowhere near sufficient, so a yes is reported as undetermined; a no is conclusive, and it is a different fault from an empty allowlist. The origin itself is never carried into this panel or the copyable report.',
    }),
    diagnosticRow({
      label: safeConstant('Origins the gateway permits'),
      value: safeCount(originCount),
      ...absentOr(originCount, originCount === 0 ? 'broken' : 'informational'),
      note: 'A cardinality, never the list. Zero and non-zero are two different fixes that currently produce identical screens: an empty list refuses every client, and a non-empty list that omits one origin refuses one browser while the rest connect.',
    }),
    diagnosticRow({
      label: safeConstant('Same-origin requests permitted'),
      value: safeYesNo(counters.allowsSameOrigin),
      ...absentOr(counters.allowsSameOrigin, 'informational'),
      note: 'Whether the same-origin entry was derived, which is what PUBLIC_URL does when the explicit allowlist is not maintained by hand. Informational: a deployment can legitimately permit only named origins.',
    }),
    diagnosticRow({
      label: safeConstant('Sockets the gateway holds now'),
      value: safeCount(counters.liveSockets),
      ...absentOr(counters.liveSockets, 'informational'),
      note: 'Live connections on this process at the moment of capture. Zero on a deployment with users is the signature of clients that never arrive, which the rejection counts below separate from clients that arrive and are turned away.',
    }),
    diagnosticRow({
      label: safeConstant('Tickets issued'),
      value: safeCount(issued),
      ...absentOr(issued, 'informational'),
      note: 'Tickets minted over the HTTP leg since this gateway attached. Read against the two rows below: tickets issued with no sockets held, or with handshakes rejected, are three different faults that look identical from every other panel.',
    }),
    diagnosticRow({
      label: safeConstant('Tickets refused'),
      value: safeCount(counters.ticketsRefused),
      ...absentOr(
        counters.ticketsRefused,
        counters.ticketsRefused !== undefined && counters.ticketsRefused > 0 ? 'degraded' : 'informational',
      ),
      note: 'Mint requests the gateway declined. Non-zero with a healthy boot gate means the refusal is live rather than structural, and the live refusal reasons above name it.',
    }),
    diagnosticRow({
      label: safeConstant('Handshakes rejected'),
      value: safeCount(rejected),
      ...absentOr(rejected, rejected !== undefined && rejected > 0 ? 'degraded' : 'informational'),
      note: 'Sockets that presented a ticket and were refused at the handshake. This is the counter that separates "nobody asks" from "asks and is refused" from "tickets mint and the socket will not take them" — the last being the signature of two replicas that do not share the ticket secret.',
    }),
  ]

  for (const cause of SOCKET_REJECTION_CAUSES) {
    const value = counters.rejections?.[cause]
    rows.push(
      diagnosticRow({
        label: REJECTION_ROW[cause].label,
        value: safeCount(value),
        ...absentOr(value, value !== undefined && value > 0 ? 'degraded' : 'informational'),
        note: REJECTION_ROW[cause].note,
      }),
    )
  }

  const findings: DiagnosticFinding[] = []

  if (admitted === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('SOCKET_ORIGIN_NOT_ADMITTED'),
        title: 'This browser’s origin would not be admitted onto the socket',
        detail:
          'The gateway was asked about the origin this admin request arrived from and answered no, so a socket from this page is closed before it authenticates. Every other row in this section can read perfectly healthy while this holds, because the deployment IS healthy — for clients served from an origin on its list.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForRefusedOrigin(originCount),
      }),
    )
  }

  if (issued !== undefined && issued > 0 && rejected !== undefined && rejected > 0) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('SOCKET_HANDSHAKE_REJECTED'),
        title: 'Tickets are minting and the handshakes presenting them are refused',
        detail:
          'Both counters are non-zero, which means clients are getting a credential over HTTP and the socket will not accept it. Either number alone is ordinary — a refused mint is a refused request, a rejected handshake is a replayed ticket — and together they are the signature of two processes that do not agree on the ticket secret.',
        // CLAIMED `undetermined`, deliberately, so the correlated caveat prints
        // in full rather than being swallowed by a cap. Two counters moving
        // together are a hypothesis worth a remedy and not a verdict: a
        // single-use ticket replayed on a reconnect produces the same pair.
        verdict: 'undetermined',
        evidence: correlatedProxy(
          'that tickets are being issued and handshakes are being rejected at the same time',
          'that the two processes disagree about the ticket secret',
        ),
        remedy: remedyForRejectedHandshakes(),
      }),
    )
  }

  return {
    heading: ADMISSION_HEADING,
    description: `${ADMISSION_DESCRIPTION} A row reads "not reported" rather than zero for any counter this server did not send.`,
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 10: the lane-degradation ledger                                      */
/* -------------------------------------------------------------------------- */

const REJECTION_STATUS_ROW: Record<LaneRejectionStatus, { label: SafeValue; note: string }> = {
  401: {
    label: safeConstant('Control-plane reads refused with 401'),
    note: 'The lane answering that the credential it holds does not authenticate at all. This is the STRANDED case: it survives the refresh window, and a read counted here was served over HTTP after an in-place credential refresh either failed or could not be attempted safely. A reconnect — a reload is enough — re-mints the ticket and clears it.',
  },
  498: {
    label: safeConstant('Control-plane reads refused with 498'),
    note: 'The lane answering that its credential is stale and refreshable. The recoverable half: the worker presents a fresh credential on the socket it already holds through a REAUTH frame and replays the parked read where replaying it is safe, so a count here is history rather than a fault to act on.',
  },
}

/**
 * Where the lane ENDED UP, as a closed four-member bucket.
 *
 * *** THE ONE THING THE LIVE ROWS CANNOT SAY. *** "Transport in use right now" at
 * the top of this section reads READY for a lane that has never moved and for one
 * that fell back four times in the last minute and happens to be up as the pane
 * renders. An operator opens this pane because they just watched it move, and that
 * row answers a question they did not ask. Distinguishing "degraded once and
 * recovered" from "degraded and never came back" is the single most useful thing
 * this ledger holds, so it is a row of its own rather than something a reader has
 * to reconstruct from the history below.
 *
 * `reconnecting` is not a spare slot: CONNECTING, AUTHENTICATING and HALF_OPEN are
 * steps on the way to READY, and calling a dial in progress either a recovery or a
 * failure would be a verdict the data does not support.
 */
export const LANE_LEDGER_OUTCOMES = ['never-degraded', 'recovered', 'still-degraded', 'reconnecting'] as const

export type LaneLedgerOutcome = (typeof LANE_LEDGER_OUTCOMES)[number]

/**
 * The ledger as this SECTION reads it: every closed field WIDENED to `string`.
 *
 * `LaneDegradationLedgerView` in `diagnosticsSections.ts` types the states and
 * reasons as their closed unions, and it stays assignable to this. Widening here is
 * not a loosening — it is what makes the `safeEnum` calls below load-bearing instead
 * of decorative. A closed union in the type system is a compile-time fact about one
 * build; the producer is a long-lived object in a page that may have been running
 * since before the last deploy, and an unrecognised code must collapse to
 * `other (unrecognised)` rather than reach a row. The producer collapses unknown
 * reasons too; neither half is trusted to be the only one that does.
 *
 * `recordingForMs` is optional because the shared view cannot carry it, and a caller
 * that does not supply it must get "not reported" rather than a fabricated zero.
 */
export type LaneLedgerSectionView = {
  readonly controlPlaneRejections: number
  readonly controlPlaneRejectionsByStatus: Readonly<Partial<Record<LaneRejectionStatus, number>>>
  readonly fallbackCounts: Readonly<Record<string, number | undefined>>
  readonly transitions: readonly {
    readonly state: string
    readonly reason?: string
    readonly socketPreserved: boolean
    readonly msSinceLedgerStart: number
  }[]
  readonly transitionsDropped: number
  readonly recordingForMs?: number
}

/** `LaneDegradationLedgerView` must stay readable here. A drift fails this line. */
type LedgerViewIsReadable = LaneDegradationLedgerView extends LaneLedgerSectionView ? true : never
export type TheSharedLedgerViewIsReadable = LedgerViewIsReadable

const KNOWN_TRANSPORT_STATES: ReadonlySet<string> = new Set<string>(SOCKET_TRANSPORT_STATES)
const KNOWN_FALLBACK_REASONS: ReadonlySet<string> = new Set<string>(SOCKET_FALLBACK_REASONS)

/** Narrows a recorded cause to one this build can name, so no cast is needed. */
function isKnownFallbackReason(reason: string): reason is SyncFallbackReason {
  return KNOWN_FALLBACK_REASONS.has(reason)
}

/** Which lane a recorded state carried traffic on, or `undefined` if unnameable. */
function carrierOf(state: string): 'http' | 'socket' | 'dialling' | undefined {
  return KNOWN_TRANSPORT_STATES.has(state) ? LANE_STATE_CARRIER[state as SyncTransportState] : undefined
}

/**
 * Degradation counts per reason, with every unrecognised key folded into ONE bucket.
 *
 * Folded rather than listed: two unknown keys both render as `other (unrecognised)`,
 * and two rows with the same label are a duplicate React key and a report line that
 * says the same thing twice. Iterating the RECORD'S OWN keys rather than this build's
 * closed tuple is what makes the fold reachable at all — a loop over the tuple would
 * skip an unknown key silently and the count would just be missing.
 */
function foldedFallbackCounts(counts: Readonly<Record<string, number | undefined>>): Map<string, number> {
  const folded = new Map<string, number>()
  for (const [reason, count] of Object.entries(counts)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
      continue
    }
    const key = KNOWN_FALLBACK_REASONS.has(reason) ? reason : UNRECOGNISED_REASON_KEY
    folded.set(key, (folded.get(key) ?? 0) + count)
  }
  return folded
}

/** Not a member of any closed set, so it can never collide with a real reason. */
const UNRECOGNISED_REASON_KEY = '__unrecognised__'

const LEDGER_HISTORY_NOTE =
  'One transition this client watched, in the order it happened: the lane it moved to, the transport’s own closed cause where it gave one, whether the socket survived, and how long after this ledger started. Nothing here is a clock reading.'

function buildLedgerBlock(ledger: LaneLedgerSectionView | undefined): DiagnosticBlock {
  const heading = safeConstant('Lane degradation ledger')
  const description =
    'What this client has watched the socket lane do, recorded as it happened. The only place a refused control-plane read appears at all: the lane degrades those to HTTP silently, note syncing stays healthy throughout, and without these counters a stranded socket and a working one are the same screen. Kept in memory for the life of this page — a reload starts it over, which is why it reports its own age.'

  if (ledger === undefined) {
    return {
      heading,
      description,
      rows: [],
      findings: [],
      emptyNote:
        'This client build records no lane-degradation ledger, so a control-plane read the socket refused leaves no trace anywhere. That is an absence of evidence, not evidence of none: the refusals this would count are invisible by construction, which is the whole reason the ledger exists.',
    }
  }

  const transitions = ledger.transitions
  const latest = transitions.length > 0 ? transitions[transitions.length - 1] : undefined
  const rejections = ledger.controlPlaneRejections

  let degradations = 0
  let recoveries = 0
  let unnameableStates = 0
  for (const transition of transitions) {
    const carrier = carrierOf(transition.state)
    if (carrier === undefined) {
      unnameableStates += 1
    } else if (carrier === 'http') {
      degradations += 1
    } else if (carrier === 'socket') {
      recoveries += 1
    }
  }

  const namedRefusals = LANE_REJECTION_STATUSES.reduce(
    (total, status) => total + (ledger.controlPlaneRejectionsByStatus[status] ?? 0),
    0,
  )
  // A remainder, never a clamp. `Math.max(0, …)` here would hide the one case worth
  // seeing — named buckets summing ABOVE the total, which is a producer whose
  // counters disagree with each other — behind a comfortable zero.
  const unnameableRefusals = rejections - namedRefusals

  const outcome: LaneLedgerOutcome | undefined =
    latest === undefined || unnameableStates > 0
      ? undefined
      : degradations === 0
        ? 'never-degraded'
        : carrierOf(latest.state) === 'http'
          ? 'still-degraded'
          : carrierOf(latest.state) === 'socket'
            ? 'recovered'
            : 'reconnecting'

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('This ledger has been recording for'),
      value: safeDuration(ledger.recordingForMs === undefined ? undefined : ledger.recordingForMs / 1000),
      ...absentOr(ledger.recordingForMs, 'informational'),
      note: 'How long this page has been watching. Read every count below against it: the ledger lives in memory and starts over on a reload, so zero transitions on a ledger seconds old establishes nothing at all, while zero on one that has been recording for an hour is a genuinely stable lane. It is deliberately not persisted — the ages here are offsets from this ledger’s own start, a reload is itself the remedy for the stranded lane these counters exist to catch, and neither survives being written to disk and read back.',
    }),
    diagnosticRow({
      label: safeConstant('Control-plane reads the lane refused'),
      value: safeCount(rejections),
      ...absentOr(rejections, rejections > 0 ? 'degraded' : 'informational'),
      note: 'Reads this client made over the socket’s control-plane lane that came back refused and were then served over HTTP with no error reaching the screen. A count of zero is informational rather than healthy — a client that has made no control-plane read produces the same zero — and any non-zero count is the one signal that separates a stranded socket from a healthy one.',
    }),
  ]

  for (const status of LANE_REJECTION_STATUSES) {
    const value = ledger.controlPlaneRejectionsByStatus[status]
    rows.push(
      diagnosticRow({
        label: REJECTION_STATUS_ROW[status].label,
        value: safeCount(value),
        ...absentOr(value, value !== undefined && value > 0 ? 'degraded' : 'informational'),
        note: REJECTION_STATUS_ROW[status].note,
      }),
    )
  }

  rows.push(
    diagnosticRow({
      label: safeConstant('Refusals on a status this build cannot name'),
      value: safeCount(unnameableRefusals < 0 ? undefined : unnameableRefusals),
      ...absentOr(
        unnameableRefusals < 0 ? undefined : unnameableRefusals,
        unnameableRefusals > 0 ? 'degraded' : 'informational',
      ),
      note: 'The total above, less the two statuses this build has rows for. It exists so the two named buckets cannot become a flattering denominator: a producer counting a third refusal status would otherwise leave those refusals in the total with nothing on screen accounting for them. A negative remainder is impossible from a correct producer — the named buckets are subsets of the total — so it is reported as "not reported" rather than as a number, because at that point the counters disagree and neither is worth printing.',
    }),
    diagnosticRow({
      label: safeConstant('Transport transitions recorded'),
      value: safeCount(transitions.length),
      verdict: 'informational',
      evidence: EVIDENCE_DIRECT,
      note: 'How many lane transitions this client has watched, deduplicated by state, cause and whether the socket survived — a fallback re-asserts the same state on every sync round and counting those repeats would report a stable lane as one that flaps. The answer to "it was working a minute ago": a handful over a session is ordinary reconnection, and a ring that keeps filling is a lane that flaps.',
    }),
    diagnosticRow({
      label: safeConstant('Transitions dropped from the ring'),
      value: safeCount(ledger.transitionsDropped),
      ...absentOr(ledger.transitionsDropped, ledger.transitionsDropped > 0 ? 'degraded' : 'informational'),
      note: 'Transitions that fell off the end of the bounded ring. The ring is the only thing here that elides — the counters above and below are keyed by closed sets and are bounded by construction, so what overflowing costs is the ORDER of the oldest transitions and never the fact that they happened. Non-zero is itself a finding: the ring is sized for ordinary reconnection, so filling it means the lane changed state more often than a healthy session ever does.',
    }),
    diagnosticRow({
      label: safeConstant('Transitions this build cannot name'),
      value: safeCount(unnameableStates),
      ...absentOr(unnameableStates, unnameableStates > 0 ? 'undetermined' : 'informational'),
      note: 'Recorded transitions whose transport state is not one this build knows. Expected to be zero and worth a row anyway: the derived counts beneath cannot classify such a transition as a degradation or a recovery, so a non-zero count here is why "Where the lane ended up" refuses to answer rather than guessing from a partial reading.',
    }),
    diagnosticRow({
      label: safeConstant('Degradations recorded'),
      value: safeCount(degradations),
      ...absentOr(degradations, degradations > 0 ? 'degraded' : 'informational'),
      note: 'Transitions onto HTTP — HTTP_ONLY, DEGRADED or HTTP_FALLBACK. Counted from the recorded transitions, so a degradation that fell off the ring is NOT counted here; the per-reason counters below are the ones that survive elision.',
    }),
    diagnosticRow({
      label: safeConstant('Recoveries recorded'),
      value: safeCount(recoveries),
      ...absentOr(recoveries, 'informational'),
      note: 'Transitions back onto the socket. A ledger that counted only failures could not tell a lane that degraded once and came straight back from one that went down and stayed down, which is the question an operator actually has. Dials in progress — CONNECTING, AUTHENTICATING, HALF_OPEN — are counted as neither.',
    }),
    diagnosticRow({
      label: safeConstant('Where the lane ended up'),
      value: safeEnum(outcome, LANE_LEDGER_OUTCOMES),
      ...absentOr(outcome, outcome === 'still-degraded' ? 'degraded' : 'informational'),
      note: 'The whole ledger in one word, read from the last transition recorded. "never-degraded" means nothing moved the lane off the socket while this page has been open — which is only as strong as the recording time at the top of this block. "recovered" means it fell back and came back. "still-degraded" means it fell back and has not. "reconnecting" means a dial is in progress and the answer is not settled yet. With no transitions at all, or with a transition this build cannot name, no answer is given rather than a guess.',
    }),
  )

  const folded = foldedFallbackCounts(ledger.fallbackCounts)

  rows.push(
    diagnosticRow({
      label: safeConstant('Distinct degradation causes recorded'),
      value: safeCount(folded.size),
      ...absentOr(folded.size, 'informational'),
      note: 'How many different causes sent this lane to HTTP. One cause recurring is a condition; several is usually a lane that cannot hold a connection at all. These counters are keyed by a closed set of reasons and so are bounded without eliding anything — unlike the transition ring, a cause that happened is still counted here after its transition has been dropped.',
    }),
  )

  // Iterated in THIS build's order rather than the record's, so the rows do not
  // reshuffle between two readings of the same lane, with the folded bucket last.
  for (const reason of [...SOCKET_FALLBACK_REASONS, UNRECOGNISED_REASON_KEY]) {
    const count = folded.get(reason)
    if (count === undefined) {
      continue
    }
    const named = isKnownFallbackReason(reason)
    rows.push(
      diagnosticRow({
        label: safeTokens(safeConstant('Degradations with cause'), safeEnum(reason, SOCKET_FALLBACK_REASONS)),
        value: safeCount(count),
        // A cause this build cannot name is reported as a degradation rather than
        // asked about: `syncFallbackDisposition` would have to be given a value it
        // has no answer for, and guessing "expected" over an unknown cause is the
        // flattering direction.
        verdict: named && socketFallbackIsDeferred(reason) ? 'informational' : 'degraded',
        evidence: EVIDENCE_DIRECT,
        note: named
          ? SYNC_FALLBACK_REASON_EXPLANATIONS[reason]
          : 'A cause this build has no name for, so it is counted and not printed. Every unrecognised cause is folded into this one row on purpose: a newer build’s reason must never be able to put free-form text into an older renderer, and two rows both reading "other" would say the same thing twice.',
      }),
    )
  }

  rows.push(
    diagnosticRow({
      label: safeConstant('Most recent transition'),
      value:
        latest === undefined
          ? safeEnum(undefined, SOCKET_TRANSPORT_STATES)
          : safeTokens(
              safeEnum(latest.state, SOCKET_TRANSPORT_STATES),
              safeEnum(latest.reason, SOCKET_FALLBACK_REASONS),
            ),
      ...absentOr(latest, 'informational'),
      note: 'The state the lane moved to last, with the transport’s own closed reason where it gave one. Read with the transport row at the top of this section: that row is where the lane is now, this one is how it got there.',
    }),
    diagnosticRow({
      label: safeConstant('Socket survived that transition'),
      value: safeState(latest?.socketPreserved, 'preserved', 'torn down'),
      ...absentOr(latest?.socketPreserved, 'informational'),
      note: 'Whether the socket itself outlived the transition. A preserved socket keeps its collaboration rooms, invite subscription, command lease and in-flight transfers; a torn-down one discards all of them and rebuilds, which is why an in-place credential refresh is worth the complexity it costs.',
    }),
    diagnosticRow({
      label: safeConstant('That transition, after the ledger started'),
      value: safeDuration(latest === undefined ? undefined : latest.msSinceLedgerStart / 1000),
      ...absentOr(latest, 'informational'),
      note: 'An offset from the start of this ledger, not a clock reading. It gives the ordering and the frequency this block is for, and a duration is a category the copyable report already permits while an absolute instant would let a reader line this deployment up against other logs.',
    }),
  )

  transitions.forEach((transition, index) => {
    rows.push(
      diagnosticRow({
        label: safeTokens(safeConstant('Transition'), safeCount(index + 1)),
        value: safeTokens(
          safeEnum(transition.state, SOCKET_TRANSPORT_STATES),
          safeEnum(transition.reason, SOCKET_FALLBACK_REASONS),
          safeState(transition.socketPreserved, 'socket preserved', 'socket torn down'),
          safeDuration(transition.msSinceLedgerStart / 1000),
        ),
        verdict: 'informational',
        evidence: EVIDENCE_DIRECT,
        note: LEDGER_HISTORY_NOTE,
      }),
    )
  })

  const findings: DiagnosticFinding[] = []

  const stranded = (ledger.controlPlaneRejectionsByStatus[401] ?? 0) > 0
  const stale = (ledger.controlPlaneRejectionsByStatus[498] ?? 0) > 0

  if (stranded || stale) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('SOCKET_LANE_CREDENTIAL_REFUSALS'),
        title: stranded
          ? 'The socket’s control-plane lane refused reads outright'
          : 'The socket’s control-plane lane refused reads while its credential was stale',
        detail: stranded
          ? 'The credential a socket holds is captured once, when its ticket is minted. The worker can now adopt a current one in place and replay a parked read where that is provably safe, so a 401 counted here is a refusal that outlived the refresh — and every one of them was quietly served over HTTP instead. Note syncing is unaffected throughout, which is exactly what makes this invisible from every other screen.'
          : 'These were stale-credential refusals inside the refresh window. The worker presents a fresh credential on the socket it already holds and replays the read where replaying it is safe, so the reads succeeded; the counter is here so that the recoverable case cannot be mistaken for the stranded one beside it.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForRefusedControlPlaneReads(stranded),
      }),
    )
  }

  /**
   * A flap is the one fault only the HISTORY can report.
   *
   * Two recoveries mean the lane does come back, so neither the live transport row
   * nor "Where the lane ended up" will ever be red for it — a flapping lane is
   * healthy exactly when anybody looks. The threshold is three degradations with at
   * least two recoveries, which no ordinary session reaches: a reconnect after a
   * sleep or a network change is one pair.
   */
  if (degradations >= 3 && recoveries >= 2) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('SOCKET_LANE_FLAPPING'),
        title: 'The socket lane has been falling back and recovering repeatedly',
        detail:
          'This client has watched the lane leave the socket and come back several times over one page. Every individual reading is healthy — it recovers each time — so nothing else in this pane can report it, and the cost is paid in the gaps: while the lane is off the socket every save is one HTTP request, collaboration rooms are rebuilt and the invite stream re-subscribes from its checkpoint. The causes are the per-cause counters above; a deferred cause such as another tab holding the lane is expected and not this.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
      }),
    )
  }

  return { heading, description, rows, findings }
}

/* -------------------------------------------------------------------------- */
/* The section                                                                */
/* -------------------------------------------------------------------------- */

const REPORT_NO_ORIGINS = reportLine(
  safeConstant('Allowed origin list'),
  safeConstant('never collected; only whether this client’s own origin is admitted, and how many entries exist'),
)

const REPORT_NO_CREDENTIAL = reportLine(
  safeConstant('Socket session credential'),
  safeConstant('never reported; a refusal appears only as a count against a closed status'),
)

const REPORT_SYNC_ITEMS_SOURCE = reportLine(
  safeConstant('SYNC_ITEMS verdict source'),
  safeConstant('the gate’s structured verdict; the older advertised boolean is never read'),
)

/**
 * Build the WebSocket section.
 *
 * Pure and synchronous. Every input is optional and every absent input produces
 * rows reading "not reported" on absent evidence rather than a negative verdict,
 * which is the contract's third rule holding by construction rather than by
 * remembering to write it. In particular a missing payload must not turn six
 * capability rows into six confident gaps, and a missing ledger must not turn a
 * refusal counter into a zero.
 */
export function buildWebsocketSection(input: WebsocketSectionInput = {}): SectionModel {
  const payload = input.payload
  const gate = payload?.gate
  const topology = payload?.deployment
  const counters = input.counters ?? {}
  const outcomes = outcomesForSection(input.outcomes ?? [], 'websocket')

  const blocks: DiagnosticBlock[] = [
    buildTransportBlock(input.transport),
    buildGateBlock(gate, payload?.live?.ticketAvailable, topology),
    buildSyncItemsBlock(payload),
    buildCapabilityBlock(payload, input.transport, counters),
    buildDescriptorBlock(payload?.live?.capabilities),
    buildRefusalBlock(payload, topology),
    buildRealtimeBlock(payload?.live?.realtime, topology),
    buildFilesBlock(gate),
    buildAdmissionBlock(counters),
    buildLedgerBlock(input.ledger),
  ]

  if (outcomes.length > 0) {
    blocks.push({
      heading: safeConstant('Operator-triggered checks'),
      description:
        'Results from the last run on the Checks sub-tab. Read-only here: one of those probes mints a real server-side ticket for your own session, so the paragraph explaining what a run does appears in exactly one place.',
      rows: [],
      findings: [],
      outcomes,
    })
  }

  return buildSectionModel({
    id: 'websocket',
    blocks,
    extraReportLines: [REPORT_NO_ORIGINS, REPORT_NO_CREDENTIAL, REPORT_SYNC_ITEMS_SOURCE],
  })
}
