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
 *     data duplication is worse than a 500 the client retries.
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
