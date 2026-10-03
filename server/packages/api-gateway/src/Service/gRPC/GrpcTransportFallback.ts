import { Status } from '@grpc/grpc-js/build/src/constants'

/**
 * Standard Red Notes: WHICH gRPC failures a gateway call may retry over HTTP,
 * and which it must surface.
 *
 * WHY THIS EXISTS
 *
 * `GRPCServiceProxy` is constructed with the Axios client and every HTTP
 * service URL already in hand, yet before this module every non-`UNAVAILABLE`
 * gRPC failure propagated out of `validateSession` — which runs on EVERY
 * authenticated request — and out of the `items/sync` gRPC route. A single gRPC
 * listener dying after boot therefore took the whole authenticated API down
 * rather than degrading to the HTTP transport sitting right beside it.
 * (`supervisor-server.sh` only gates the gRPC *default* on both ports answering
 * at STARTUP; it cannot see a listener that fails later, and it never probes an
 * explicitly set `SERVICE_PROXY_TYPE=grpc`.)
 *
 * WHY IT IS NOT A BARE `catch { useHttp() }`
 *
 * Two different reasons, and both are load-bearing:
 *
 *  1. A blanket catch would replay ITEM MUTATIONS on a second transport after
 *     an AMBIGUOUS failure. `UNAVAILABLE` does not mean "not applied" — gRPC
 *     raises it when a connection drops mid-call too, so the save may already
 *     be committed. Re-sending the same item hashes with their now-stale
 *     `updated_at` makes the syncing server emit a sync conflict, which the
 *     client materialises as a duplicate "conflicted copy" note. Silent user
 *     data duplication is worse than a failed request — but the failed request
 *     has to SAY what it is, which is what the refusal contract at the bottom
 *     of this file exists for. "The client will retry" was never a safe thing
 *     to assume here, and is not what the client is now told.
 *  2. A blanket catch would turn a loud outage into a PERMANENT INVISIBLE
 *     misconfiguration: the operator would serve every request over HTTP while
 *     believing they were on gRPC. Every degradation is therefore counted in
 *     `GrpcTransportFallbackDiagnostics` and logged at `error`.
 *
 * The two axes are kept apart on purpose: WHAT the call is (`GrpcCallReplaySafety`)
 * and HOW the attempt failed (`GrpcFailureClass`). A fallback needs both to say
 * yes, so neither one widening by itself can let a mutation through.
 */

/**
 * How the gRPC attempt failed, in exactly the terms the fallback decision needs.
 *
 * Mapped from `ServiceError.code`. An error with no numeric `code` is not a gRPC
 * call outcome at all — see `never-dispatched`.
 */
export type GrpcFailureClass =
  /**
   * `UNAVAILABLE`. The canonical "nothing is listening / the connection went
   * away". TRANSPORT: HTTP is a different socket to a different port and can
   * well succeed. Note it does NOT prove the call was not applied — a
   * connection that drops after the request bytes were written reports
   * `UNAVAILABLE` too, which is why a mutation needs its own idempotency story.
   */
  | 'channel-unavailable'
  /**
   * `DEADLINE_EXCEEDED`. Also transport-shaped, and also ambiguous about
   * application. (These call sites set no deadline today, so this is a
   * forward-looking entry rather than a path exercised in production.)
   */
  | 'deadline-exceeded'
  /**
   * `UNIMPLEMENTED`. Something answers the port but does not serve this
   * service/method: the wrong process is bound, or the proto generation is
   * skewed between gateway and backend. The call never reached a handler.
   */
  | 'method-unimplemented'
  /**
   * `INTERNAL`. grpc-js reports HTTP/2 framing failures (RST_STREAM, header
   * errors, decompression failures) with this code. Neither backend answers
   * `INTERNAL` deliberately on these methods — auth uses PERMISSION_DENIED /
   * INVALID_ARGUMENT carrying `x-auth-error-response-code` (which the proxy
   * RESOLVES, so it never reaches a catch), and syncing attaches
   * `x-sync-error-response-code` for the same reason. So an `INTERNAL` that
   * reaches us is a transport/framing fault.
   */
  | 'transport-internal'
  /**
   * `RESOURCE_EXHAUSTED`. Two very different things wear this code, which is
   * why it is its own class rather than folded into the transport ones:
   * grpc-js raises it client-side when a message exceeds the configured
   * max send/receive length (a transport sizing limit HTTP does not share),
   * and the syncing server raises it DELIBERATELY for a user over their
   * content limit — on which the gateway publishes a ContentSizesFixRequested
   * domain event. Eligible for a read, never for a mutation.
   */
  | 'message-limit'
  /**
   * `CANCELLED`. The call was cancelled or the stream was reset. The client is
   * usually gone, and for a mutation the server may well have applied it.
   * Never eligible.
   */
  | 'cancelled'
  /**
   * `UNKNOWN`. This is NOT an unknown-to-us code — it is the code BOTH
   * backends' own catch-all uses (`AuthServer.validate` and
   * `AuthServer.validateWebsocket` both answer `Status.UNKNOWN` with no
   * metadata when their use case throws). So it means: the call arrived, the
   * handler ran, and the handler faulted. HTTP terminates in the SAME use case
   * and cannot do better, and counting it as a transport degradation would
   * mislabel a backend bug. Never eligible.
   */
  | 'server-fault'
  /**
   * No numeric gRPC `code` at all, so this is not a call outcome: the proxy's
   * synchronous block threw while BUILDING or dispatching the request (a mapper
   * failure, a metadata/signing failure, a closed channel object). Nothing was
   * applied. Eligible for reads and for ledger-deduplicated mutations; still
   * not for a plain mutation, see `mayFallBackToHttp`.
   */
  | 'never-dispatched'
  /**
   * Every other status: the backend deliberately answered this way. Retrying a
   * deliberate refusal on a second transport is not a fallback, it is a bypass.
   */
  | 'application'

/** The gateway lane a failure was observed on. Closed enum — see the secrecy note on the recorder. */
export type GrpcFallbackLane = 'session-validation' | 'items-sync'

/**
 * What a SECOND delivery of this particular call would do, which is the only
 * question that decides whether a cross-transport retry is allowed.
 */
export type GrpcCallReplaySafety =
  /** Writes nothing. A second delivery is a repeat of a read. */
  | 'read-only'
  /**
   * Writes, but carries a durable sync command id + digest that the syncing
   * server's shared command ledger deduplicates. Both transports reach the same
   * `ExecuteSyncCommand` use case against the same database
   * (`BaseItemsController.sync` for HTTP, `SyncingServer.syncItems` for gRPC),
   * and `GRPCServiceProxy.callServer` forwards the `x-sync-command-id` /
   * `x-sync-command-digest` headers and the body verbatim — so a replay returns
   * the stored result with `replayed: true` instead of applying twice.
   */
  | 'idempotent-mutation'
  /** Writes with nothing to deduplicate it. No failure class makes this safe. */
  | 'non-idempotent-mutation'

const CODE_TO_CLASS: Readonly<Record<number, GrpcFailureClass>> = Object.freeze({
  [Status.UNAVAILABLE]: 'channel-unavailable',
  [Status.DEADLINE_EXCEEDED]: 'deadline-exceeded',
  [Status.UNIMPLEMENTED]: 'method-unimplemented',
  [Status.INTERNAL]: 'transport-internal',
  [Status.RESOURCE_EXHAUSTED]: 'message-limit',
  [Status.CANCELLED]: 'cancelled',
  [Status.UNKNOWN]: 'server-fault',
})

/**
 * Classes a READ may be retried over HTTP on. A read cannot double-apply
 * anything, so this set is the full transport-fault family.
 */
const READ_ONLY_ELIGIBLE: readonly GrpcFailureClass[] = [
  'channel-unavailable',
  'deadline-exceeded',
  'method-unimplemented',
  'transport-internal',
  'message-limit',
  'never-dispatched',
]

/**
 * Classes a LEDGER-DEDUPLICATED mutation may be retried over HTTP on. Same as
 * the read set minus `message-limit`: that code is how the syncing server says
 * "this user is over their content limit", and the gateway publishes a
 * ContentSizesFixRequested event on it. Replaying it over HTTP would both
 * re-ask a question already answered and risk firing that event twice.
 */
const IDEMPOTENT_MUTATION_ELIGIBLE: readonly GrpcFailureClass[] = [
  'channel-unavailable',
  'deadline-exceeded',
  'method-unimplemented',
  'transport-internal',
  'never-dispatched',
]

/** The eligibility sets, exported so a spec can pin them rather than restate them. */
export const GRPC_FALLBACK_ELIGIBILITY: Readonly<Record<GrpcCallReplaySafety, readonly GrpcFailureClass[]>> =
  Object.freeze({
    'read-only': READ_ONLY_ELIGIBLE,
    'idempotent-mutation': IDEMPOTENT_MUTATION_ELIGIBLE,
    // Structural, not an omission: there is no failure class on which an
    // un-deduplicated write may be delivered a second time over a second
    // transport. `never-dispatched` is excluded DELIBERATELY even though it
    // currently proves the request never left the gateway — that proof rests on
    // nothing but the present shape of the two proxy files' synchronous blocks,
    // and the cost of it quietly ceasing to hold is duplicated user notes.
    'non-idempotent-mutation': [],
  })

/** Map a rejected gRPC attempt onto the taxonomy above. */
export function classifyGrpcFailure(error: unknown): GrpcFailureClass {
  if (typeof error !== 'object' || error === null) {
    return 'never-dispatched'
  }

  const code = (error as { code?: unknown }).code
  if (typeof code !== 'number') {
    return 'never-dispatched'
  }

  return CODE_TO_CLASS[code] ?? 'application'
}

/**
 * The single gate. BOTH axes must agree, so widening one of them cannot by
 * itself let an un-deduplicated write onto a second transport.
 */
export function mayFallBackToHttp(safety: GrpcCallReplaySafety, failure: GrpcFailureClass): boolean {
  return GRPC_FALLBACK_ELIGIBILITY[safety].includes(failure)
}

/**
 * Standard Red Notes: HOW a refusal is reported to the client. Nothing below
 * changes WHICH failures are refused — `GRPC_FALLBACK_ELIGIBILITY` above is the
 * only authority on that and is untouched.
 *
 * WHY THIS EXISTS
 *
 * The refusal above was reported as a bare `500` with an empty body (measured
 * live at `44c3c59b`: `POST /v1/items` with one item against a dead syncing
 * gRPC target answered `500`, no code, no body, no `Retry-After`). That made the
 * one failure the design expects the client to RECOVER from indistinguishable
 * from every other `500`. The justification for refusing — "the failure goes
 * back to the client, and the client retries with fresh state" — rested on a
 * signal that was not on the wire.
 *
 * WHY IT IS NOT "RETRYABLE"
 *
 * This failure is AMBIGUOUS BY CONSTRUCTION. The entire reason the write is not
 * replayed is that nobody knows whether it was applied: `UNAVAILABLE` is raised
 * for a connection that dropped after the request bytes went out just as
 * readily as for a listener that was never there. So the signal must NOT say
 * "retry this". A blind re-delivery of the same item hashes with their now-stale
 * `updated_at` is exactly the double-apply the refusal exists to prevent — the
 * syncing server answers with a sync conflict and the client materialises a
 * duplicate "conflicted copy" note.
 *
 * What the client needs to be told is therefore "the outcome of this write is
 * UNKNOWN; reconcile your state rather than resending it", and that is what the
 * code and the copy below say. `retryable` is `false` on every refusal code for
 * the same reason, and the retryability answer is a property OF THE CODE (a
 * frozen table, not a computation over the failure) so that no failure-class
 * detail can leak out through the flag.
 *
 * *** SECRECY BOUNDARY ***
 * `grpcFallbackRefusal` takes ONE argument, and it is the closed
 * `GrpcCallReplaySafety` union. There is no parameter through which a request
 * path, an item uuid, a user uuid, a service URL, a gRPC status, a failure
 * class, an upstream error message or a stack could reach the wire even by
 * mistake — the same argument `GrpcTransportFallbackDiagnostics` makes for its
 * recorder, and the same one `357487cb` made for `RPC_PATH_FORBIDDEN`. The copy
 * is a frozen constant per code, never built from an input. Do not add a
 * free-form field here; add another closed code instead.
 */
export type GrpcFallbackRefusalCode =
  /**
   * A sync that writes nothing was refused. Only reachable when the backend's
   * own handler answered — every transport-fault class a read is eligible for
   * was already served over HTTP and so never arrives here, leaving
   * `cancelled`, `server-fault` and `application`. Nothing was written, so
   * there is no state to reconcile; and a second delivery reaches the same
   * handler on either transport, so it is not reported as retryable.
   */
  | 'SYNC_TRANSPORT_READ_FAILED'
  /**
   * A LEDGER-DEDUPLICATED write was refused. The outcome is unknown, but unlike
   * the code below it is DISCOVERABLE: the command carries an id the syncing
   * server's shared ledger keys its stored result on, so the client can ask what
   * became of that id instead of guessing. Still not retryable — the classes
   * that reach this refusal are `message-limit` (how the syncing server says
   * "over the content limit", on which the gateway publishes a
   * ContentSizesFixRequested event that a blind retry would fire again),
   * `cancelled`, `server-fault` and `application`.
   */
  | 'SYNC_COMMAND_OUTCOME_UNKNOWN'
  /**
   * An UN-DEDUPLICATED write was refused: the case with the empty eligibility
   * set. The outcome is unknown and there is nothing to ask — no ledger key
   * exists — so the only safe remedy is to reconcile against the server's state.
   * This is the code whose absence made the live `500` unreadable.
   */
  | 'SYNC_WRITE_OUTCOME_UNKNOWN'

/**
 * The code a refusal reports, decided by WHAT THE CALL WAS and nothing else.
 * Keyed on the replay-safety axis rather than the failure axis on purpose: the
 * client already knows what it sent, so this adds no information about the
 * deployment, while the failure class stays where it belongs — in the log and
 * in the operator-only diagnostics payload.
 */
const REFUSAL_CODE_BY_REPLAY_SAFETY: Readonly<Record<GrpcCallReplaySafety, GrpcFallbackRefusalCode>> = Object.freeze({
  'read-only': 'SYNC_TRANSPORT_READ_FAILED',
  'idempotent-mutation': 'SYNC_COMMAND_OUTCOME_UNKNOWN',
  'non-idempotent-mutation': 'SYNC_WRITE_OUTCOME_UNKNOWN',
})

/**
 * The wire contract per code: fixed copy and a fixed retryability answer.
 *
 * The copy is written to say "unknown outcome, reconcile" and NEVER "retry" —
 * `GrpcTransportFallback.spec.ts` asserts the two unknown-outcome messages
 * contain neither "retry" nor "try again" nor "resend", because a client acting
 * on the opposite reading is what costs a user a duplicated note.
 *
 * It is written as END-USER copy, not developer copy, because it reaches a
 * person with no client change at all: SNJS's
 * `ApiService.errorResponseWithFallbackMessage` only substitutes its generic
 * sync message when `error.message` is ABSENT, and the web client's footer
 * renders `getErrorMessageFromErrorResponseBody(data, …)` into
 * `failedSyncError` on `ApplicationEvent.FailedSync`. So this string is the
 * sentence the user sees when a save could not be confirmed, and it has to tell
 * them to reload rather than keep hammering save.
 *
 * `retryable` is `false` throughout. For the two write codes that is the whole
 * point. For the read code it is honest too: the transport faults a read MAY
 * cross transports on never reach a refusal, so a refused read is one the
 * backend itself answered, and asking the same handler again over either
 * transport cannot change that answer. A future code added here must state its
 * own answer — the table is exhaustive over the union, so the compiler asks.
 */
const GRPC_FALLBACK_REFUSAL_CONTRACT: Readonly<
  Record<GrpcFallbackRefusalCode, Readonly<{ message: string; retryable: boolean }>>
> = Object.freeze({
  SYNC_TRANSPORT_READ_FAILED: Object.freeze({
    message: 'Your notes could not be fetched from the server. Nothing was written, so no change was lost.',
    retryable: false,
  }),
  SYNC_COMMAND_OUTCOME_UNKNOWN: Object.freeze({
    message:
      'This change could not be confirmed, so whether it was saved is unknown. ' +
      'Ask for the status of the command id you supplied and reconcile from that answer, ' +
      'rather than sending the same change twice.',
    retryable: false,
  }),
  SYNC_WRITE_OUTCOME_UNKNOWN: Object.freeze({
    message:
      'This change could not be confirmed, so whether it was saved is unknown. ' +
      'Reload the current server state and reconcile against it, rather than sending the same change twice.',
    retryable: false,
  }),
})

/** The closed set, exported so a spec — and any future producer — can pin it. */
export const GRPC_FALLBACK_REFUSAL_CODES: ReadonlySet<string> = new Set<GrpcFallbackRefusalCode>(
  Object.keys(GRPC_FALLBACK_REFUSAL_CONTRACT) as GrpcFallbackRefusalCode[],
)

/**
 * The HTTP status a refusal keeps. Deliberately UNCHANGED from the bare `500`
 * this replaces: HTTP has no status for "the outcome of your write is unknown",
 * `503` and a `Retry-After` would both say the one thing that must not be said,
 * and `409` is already spoken for on this route by
 * `sync_command_digest_mismatch`. The defect being fixed is an unreadable BODY,
 * not a wrong status, so the status stays where live measurement found it and
 * the meaning travels in the code.
 */
export const GRPC_FALLBACK_REFUSAL_STATUS = 500

/** Exactly the fields a refusal puts on the wire. Nothing may be added to this. */
export type GrpcFallbackRefusalBody = {
  error: {
    code: GrpcFallbackRefusalCode
    message: string
    retryable: boolean
  }
}

/**
 * The refusal body for one refused call. A pure function of the closed
 * replay-safety union — see the secrecy boundary above.
 */
export function grpcFallbackRefusal(safety: GrpcCallReplaySafety): GrpcFallbackRefusalBody {
  const code = REFUSAL_CODE_BY_REPLAY_SAFETY[safety]
  const contract = GRPC_FALLBACK_REFUSAL_CONTRACT[code]

  return { error: { code, message: contract.message, retryable: contract.retryable } }
}

/**
 * Body keys of an `items/sync` payload that cause NO write. Taken from the
 * fields `SyncRequestGRPCMapper.toProjection` maps and `BaseItemsController.sync`
 * reads: every one of these only filters, paginates or versions the READ half
 * of a sync.
 *
 * This is an ALLOW-list rather than a deny-list on `items`, deliberately: a new
 * body field added upstream must make a call look mutating (and so refuse the
 * fallback) rather than silently inherit read-only treatment.
 *
 * `command` is NOT here. A command makes the call a mutation; whether it is a
 * DEDUPLICATED one is decided separately by
 * `GRPCSyncingServerServiceProxy.durableCommandReplayKeyPresent`.
 */
const READ_ONLY_SYNC_BODY_KEYS: readonly string[] = [
  'api',
  'sync_token',
  'cursor_token',
  'limit',
  'content_type',
  'compute_integrity',
  'shared_vault_uuids',
]

/**
 * Whether an `items/sync` payload writes nothing — every key is from the
 * read-only allow-list, and `items`, if present at all, is an empty array.
 * Anything else (a non-array `items`, one item, an unrecognised key) is
 * reported as mutating.
 */
export function syncPayloadWritesNothing(payload: Record<string, unknown> | string | undefined): boolean {
  if (payload === undefined || typeof payload === 'string' || payload === null) {
    return false
  }

  for (const key of Object.keys(payload)) {
    if (key === 'items') {
      if (!Array.isArray(payload.items) || payload.items.length > 0) {
        return false
      }
      continue
    }
    if (!READ_ONLY_SYNC_BODY_KEYS.includes(key)) {
      return false
    }
  }

  return true
}
