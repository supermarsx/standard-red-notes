import { type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  classifyConnectionTokenError,
  decodeCrossServiceToken,
  InMemorySyncAuthTicketStore,
  MAX_CONNECTIONS_PER_USER_CEILING,
  mintConnectionToken,
  parseConnectionTokenTtl,
  parseRedisNamespace,
  verifyConnectionToken,
  verifyRoomCapabilityWithExpiry,
  type SyncAuthTicketStore,
  type SyncTicketIdentity,
} from './auth.js'
import {
  ConnectionRegistry,
  InMemorySyncCommandLeaseRegistry,
  InMemorySyncSocketBudget,
  dispatch as dispatchToRegistry,
  type Conn,
  type DispatchMessage,
  type SyncCommandLeaseRegistry,
  type SyncSocketBudget,
} from './registry.js'
import {
  RoomRegistry,
  parseRelayFrame,
  rejectedControlFrameIdentity,
  handleRelayFrame,
  type RoomDeniedReason,
  type RoomJoinAuthorizer,
} from './rooms.js'
import { startRedisBridge, type Logger } from './redisBridge.js'
import { startCollaborationRedisBridge } from './collaborationRedisBridge.js'
import { InProcessCollaborationLifecycle, type CollaborationPlane } from './inProcessCollaborationLifecycle.js'
import { createLogThrottle, type LogThrottle } from './logThrottle.js'
import { safeErrorLogMetadata } from './safeLog.js'
import { startSqsConsumer, type SqsConsumerHandle, type SqsEventDedupStore } from './sqsConsumer.js'
import {
  SyncCommandHandler,
  sessionAuthorizationReady,
  type SyncCommandBackendAdapter,
  type SyncCollaborationAuthorizationAdapter,
  type SyncCommandMetrics,
  type SyncApiRpcAdapter,
  type SyncInviteEventsAdapter,
  type SyncLiveAuthorizationAdapter,
} from './syncCommandHandler.js'
import type { SyncFilesAdapter } from './filesSession.js'
import { MAX_FILE_BINARY_FRAME_BYTES } from './filesProtocol.js'
import { InviteRealtimeDomainEventHandler } from './inviteEventDomainEventHandler.js'
import type { InviteEventOutboxDispatcher } from './inviteEventOutbox.js'
import {
  MAX_SYNC_FRAME_BYTES,
  SYNC_BACKEND_TIMEOUT_MS,
  SYNC_PROTOCOL_VERSION,
  type SyncNegotiatedOperation,
} from './syncProtocol.js'

// ---------------------------------------------------------------------------
// Shared gateway logic.
//
// This module owns the WebSocket connection lifecycle, the token-mint handler,
// the Redis bridge and the SQS consumer. It is consumed two ways:
//
//   - The standalone entry (`index.ts`) creates its own http.Server (serving
//     /health + POST /sockets/tokens) and attaches the ws server to it. This is
//     the original process model (listens on :3106) and is kept working so the
//     package can still run on its own / in tests.
//
//   - The api-gateway ATTACHES the gateway in-process: it already owns the
//     :3000 http.Server and the Express app, so it passes both in. The ws server
//     binds to that same http server (sharing the port), and the token-mint is
//     registered on the Express app as `POST /sockets/tokens` instead of a
//     second raw http server.
// ---------------------------------------------------------------------------

/** Heartbeat interval for dropping dead sockets. */
const HEARTBEAT_MS = 30_000

/**
 * `parseRelayFrame` accepts at most a 512 KiB base64 payload. Apply a slightly
 * larger limit in `ws` itself so an oversized message is rejected while the
 * protocol parser is still streaming it, before a complete Buffer/string is
 * retained by application code. The 32 KiB margin covers JSON keys, the room
 * identifier, request id and signed capability.
 */
export const MAX_WEBSOCKET_MESSAGE_BYTES = 544 * 1024
/** Allows several tabs/devices while bounding one account's aggregate sockets. */
export const DEFAULT_MAX_CONNECTIONS_PER_USER = 16

export interface WebSocketIngressLimits {
  /** Maximum instantaneous application messages accepted from one connection. */
  frameCapacity: number
  /** Sustained application messages replenished per second, per connection. */
  frameRefillPerSecond: number
  /** Maximum instantaneous message bytes accepted from one connection. */
  byteCapacity: number
  /** Sustained message bytes replenished per second, per connection. */
  byteRefillPerSecond: number
}

/**
 * Deliberately roomy for legitimate Yjs bootstrap/update bursts while bounding
 * a single authenticated socket to a finite sustained ingress rate.
 */
export const DEFAULT_WEBSOCKET_INGRESS_LIMITS: Readonly<WebSocketIngressLimits> = Object.freeze({
  frameCapacity: 512,
  frameRefillPerSecond: 256,
  byteCapacity: 8 * 1024 * 1024,
  byteRefillPerSecond: 2 * 1024 * 1024,
})

export const DEFAULT_SYNC_WEBSOCKET_INGRESS_LIMITS: Readonly<WebSocketIngressLimits> = Object.freeze({
  frameCapacity: 32,
  frameRefillPerSecond: 16,
  byteCapacity: 2 * 1024 * 1024,
  byteRefillPerSecond: 512 * 1024,
})

/**
 * The FILES_V1 BINARY plane's own ingress budget, kept separate from the JSON
 * command budget above.
 *
 * WHY THIS EXISTS. Every message on `/sockets/sync` used to be charged to
 * {@link DEFAULT_SYNC_WEBSOCKET_INGRESS_LIMITS}, whose numbers describe a
 * command plane: 2 MiB of burst and 512 KiB/s sustained is roomy for `SYNC_ITEMS`
 * frames and nowhere near a file. An upload re-slices the encrypted stream into
 * 256 KiB frames (`MAX_FILE_CHUNK_BYTES`), so the 2 MiB bucket is empty after
 * EIGHT of them and the ninth or tenth is refused -- closing the whole socket
 * (1008 when this was measured; the ingress refusal now closes 1013, which is
 * the truthful code for a bucket that refills). Measured on a single container
 * built from `main`: 2,097,152 bytes (8
 * frames) uploaded every time, 2,359,297 bytes and above failed, and an ordinary
 * 2,971,413-byte photo failed on every attempt with `SOCKET_CLOSED` on the
 * client. The cap was never a file-size policy; it was the command plane's rate
 * limit applied to bulk bytes.
 *
 * WHAT THE NUMBERS MEAN. A token bucket's capacity is the burst it absorbs and
 * its refill is the sustained rate it allows. 64 MiB of burst clears the web
 * client's own 50 MB ceiling (`ClassicFileReader.maximumFileSize`) in one go, so
 * a normal attachment never stalls mid-transfer; 16 MiB/s is the finite
 * per-socket sustained ceiling that keeps this a rate limit rather than an open
 * door. The frame bucket is deliberately NOT the binding constraint (64 MiB of
 * 256 KiB frames is 256 frames, well under `frameCapacity`), because a hidden
 * frame wall is exactly the failure this replaces.
 *
 * WHAT THIS DOES NOT CHANGE. The limiter only counts; it retains nothing. What a
 * socket can hold in memory is bounded elsewhere and independently -- `ws`'s
 * `maxPayload` (`MAX_WEBSOCKET_MESSAGE_BYTES`), the per-frame ceiling
 * (`MAX_FILE_BINARY_FRAME_BYTES`) and the handler's ingress queue
 * (`MAX_SYNC_QUEUED_FRAMES` frames / `MAX_SYNC_QUEUED_BINARY_BYTES` bytes on
 * this plane). A transfer is
 * still bounded end to end by `declaredSize <= MAX_FILE_TRANSFER_BYTES`, by the
 * upload having been opened and authorized, and by the account's storage quota.
 */
export const DEFAULT_SYNC_WEBSOCKET_FILE_INGRESS_LIMITS: Readonly<WebSocketIngressLimits> = Object.freeze({
  frameCapacity: 512,
  frameRefillPerSecond: 256,
  byteCapacity: 64 * 1024 * 1024,
  byteRefillPerSecond: 16 * 1024 * 1024,
})

export const SYNC_SOCKET_PATH = '/sockets/sync'
/**
 * The only path the legacy `?authToken=` lane upgrades on. It used to accept
 * any path that was not `/sockets/sync` (a probe observed `/?authToken=`),
 * which made the front door's path-based routing meaningless for it.
 */
export const LEGACY_SOCKET_PATH = '/sockets'
export const SYNC_CAPABILITY_ID = 'ws-sync' as const

export interface SyncCapability {
  id: typeof SYNC_CAPABILITY_ID
  version: typeof SYNC_PROTOCOL_VERSION
  endpoint: typeof SYNC_SOCKET_PATH
}

export interface SyncCapabilityResponse {
  capabilities: SyncCapability[]
}

export interface SyncTicketResponse {
  ticket: string
  expiresAt: number
  /**
   * Server clock at issue time, so a client whose clock is skewed derives the
   * ticket's remaining life from `expiresAt - issuedAt` instead of comparing
   * `expiresAt` with its own clock. The gateway always sets it; optional only
   * so host-side doubles that predate it keep compiling.
   */
  issuedAt?: number
  endpoint: typeof SYNC_SOCKET_PATH
  capability: typeof SYNC_CAPABILITY_ID
  version: typeof SYNC_PROTOCOL_VERSION
}

export interface SyncGatewayOptions {
  /**
   * Kill switch, consulted during negotiation and before every frame. Both
   * hosts evaluate WEBSOCKET_SYNC_ENABLED once at boot and pass a constant
   * closure, so in production this is NOT a runtime switch: flipping the
   * setting takes effect on the next process start. It stays a function so a
   * composition root that does hold a live setting can supply one.
   */
  isEnabled: () => boolean
  /** Exact browser origins allowed to establish `/sockets/sync`. */
  allowedOrigins: readonly string[]
  /**
   * Admit the browser origin when its host (and, when available, forwarded
   * scheme) matches the WebSocket upgrade target. This is the secure
   * self-hosted default when PUBLIC_URL is not known at process start; explicit
   * origins above remain the only way to admit a different web/desktop origin.
   */
  allowSameOrigin?: boolean
  authorization: SyncLiveAuthorizationAdapter
  backend: SyncCommandBackendAdapter
  /** Optional authenticated control-plane operation negotiated on socket AUTH. */
  collaborationAuthorization?: SyncCollaborationAuthorizationAdapter
  /**
   * Resolves the room's CURRENT epoch during collaboration epoch discovery.
   * The authorization adapter answers discovery with the deterministic initial
   * epoch; once a room has been used and released, the fleet-shared room state
   * holds a rotated epoch, and a grant bound to the initial one is refused
   * forever. When this returns a value it replaces `roomEpoch` in both the
   * discovery record and the frame sent to the client, so the one-use
   * challenge binding is preserved. Undefined, a rejection or a slow answer
   * (bounded by the handler) keeps the initial epoch.
   */
  collaborationRoomEpochResolver?: (room: string, collaborationSecurityEpoch: string) => Promise<string | undefined>
  /** Optional same-origin authenticated API RPC adapter. */
  apiRpc?: SyncApiRpcAdapter
  /** Fleet-shared durable invitation/membership/application-state stream. */
  inviteEvents?: SyncInviteEventsAdapter
  /** Durable dispatcher used by the single production SQS consumer before ACK. */
  inviteEventDispatcher?: Pick<InviteEventOutboxDispatcher, 'dispatch'>
  /**
   * Declares that THIS HOST drives `inviteEventDispatcher` itself -- a
   * DirectCall domain-event bridge, say -- rather than relying on the SQS
   * consumer this gateway starts.
   *
   * It exists because the gateway can see exactly one invite-event ingress: the
   * SQS consumer it builds from `config.sqs.queueUrl`. Nothing else it is
   * handed distinguishes "the host publishes into this store" from "nobody
   * does". Measured on a real distributed deployment with no `SQS_QUEUE_URL`,
   * the undeclared case advertised `INVITE_EVENTS`, answered `INVITE_READY`
   * -- the frame that means "you are caught up" -- and then delivered nothing,
   * ever: not an invite, not an acceptance, not a revocation. The lane was
   * inert and every client was told it was healthy.
   *
   * So a fleet-shared composition must now STATE its ingress, the way `files`
   * must state its intent. Supply `config.sqs.queueUrl` (the gateway's own
   * consumer), or set this (the host's). Declare neither and `INVITE_EVENTS`
   * is withheld from the advertised operations instead of being advertised
   * over nothing -- clients then take the HTTP invite path, which carries the
   * same invites in the ordinary sync response.
   *
   * NOT a boot failure: a waived capability is this gateway's established
   * answer for a lane it cannot serve (see `filesUnsupported` and the
   * SYNC_ITEMS warning), and refusing the process would take down HTTP sync
   * over a realtime-only misconfiguration.
   */
  inviteEventIngressOwnedByHost?: boolean
  /** Canonical in-process file storage adapter for the binary FILES_V1 lane. */
  files?: SyncFilesAdapter
  /**
   * Declares that this deployment intentionally serves no FILES_V1 lane.
   *
   * Under `requireSharedState` a composition root must state its intent about
   * `files` explicitly: supply an adapter, or set this. Omitting both is a
   * composition bug and fails at attach time. This exists because `files` was
   * silently absent from every bootstrap while the whole lane looked wired --
   * nothing errored, the capability simply never appeared on the wire.
   */
  filesUnsupported?: boolean
  tickets?: SyncAuthTicketStore
  leases?: SyncCommandLeaseRegistry
  socketBudget?: SyncSocketBudget
  /** Require fleet-shared ticket/lease/socket state; production wiring should set true. */
  requireSharedState?: boolean
  maxSocketsPerUser?: number
  metrics?: SyncCommandMetrics
  ingressLimits?: Partial<WebSocketIngressLimits>
  /**
   * Optional override for the FILES_V1 binary plane's own ingress budget
   * ({@link DEFAULT_SYNC_WEBSOCKET_FILE_INGRESS_LIMITS}). Separate from
   * `ingressLimits` on purpose: the two planes carry completely different
   * traffic, and tightening the command plane must not silently cap file size.
   */
  fileIngressLimits?: Partial<WebSocketIngressLimits>
  authDeadlineMs?: number
  backendTimeoutMs?: number
  /**
   * How often a live, authenticated sync socket re-presents its credential to
   * the session plane (default {@link SYNC_SESSION_REVALIDATION_INTERVAL_MS}).
   * No host passes one; a probe shortens it to observe a revocation.
   */
  sessionRevalidationIntervalMs?: number
  /** Bound on a socket whose authorization adapter cannot revalidate at all. */
  socketMaxLifetimeMs?: number
  leaseRenewIntervalMs?: number
  socketBudgetRenewIntervalMs?: number
}

/** One `[ws-sync-metric]` line per this window, however many events it covers. */
export const SYNC_METRIC_FLUSH_INTERVAL_MS = 60_000
/**
 * Distinct `event`/`code` pairs held before a window is cut short. Every pair
 * is an internal literal (a protocol code, a refusal cause), so ~40 is the real
 * ceiling; this only stops an unforeseen caller from growing the map unbounded.
 */
const MAX_TRACKED_SYNC_METRICS = 256

export interface AggregatingSyncCommandMetrics extends SyncCommandMetrics {
  observe(event: string, code: string, value: number): void
  /** Emit the pending window immediately (shutdown, tests). */
  flush(): void
  /** Flush and release the backstop timer. */
  close(): void
}

interface SyncMetricCount {
  event: string
  code?: string
  count: number
}

interface SyncMetricSample {
  event: string
  code: string
  count: number
  sum: number
  max: number
}

/**
 * Production-safe sync telemetry adapter. Keeping the payload as one compact
 * JSON value preserves its fields through the minimal variadic logger bridge
 * used by both api-gateway and home-server.
 *
 * N6: the counters are AGGREGATED into one line per window rather than logged
 * per event. Every rate-limited frame, every protocol error and every
 * backpressure sample used to write its own line at info level, so the one
 * thing these numbers are for -- noticing a rate -- was the thing the volume
 * made unreadable, and a client in a retry loop could drive the log on its own.
 * A window carries the same stable, non-sensitive identifiers as before, so
 * `grep '[ws-sync-metric]'` still finds everything; it now finds counts.
 */
export function createLoggerSyncCommandMetrics(
  logger: Pick<Logger, 'info'>,
  options: { flushIntervalMs?: number; now?: () => number; backstopTimer?: boolean } = {},
): AggregatingSyncCommandMetrics {
  const flushIntervalMs = options.flushIntervalMs ?? SYNC_METRIC_FLUSH_INTERVAL_MS
  const now = options.now ?? Date.now
  if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs < 1) {
    throw new Error('Invalid sync metric flush interval: expected a positive safe integer number of milliseconds.')
  }

  const counts = new Map<string, SyncMetricCount>()
  const samples = new Map<string, SyncMetricSample>()
  let windowStartedAt = now()

  const flushAt = (at: number): void => {
    if (counts.size === 0 && samples.size === 0) {
      windowStartedAt = at
      return
    }
    logger.info(
      '[ws-sync-metric]',
      JSON.stringify({
        windowMs: Math.max(0, at - windowStartedAt),
        ...(counts.size > 0 ? { counts: [...counts.values()] } : {}),
        ...(samples.size > 0 ? { samples: [...samples.values()] } : {}),
      }),
    )
    counts.clear()
    samples.clear()
    windowStartedAt = at
  }

  /**
   * Cut the window BEFORE recording, so the event that rolls it over opens the
   * next one instead of being counted twice. A key space that is already full
   * also cuts it, which bounds retention without discarding a measurement.
   */
  const rollWindow = (tracked: number, isNewKey: boolean): void => {
    const at = now()
    if (at - windowStartedAt >= flushIntervalMs || (isNewKey && tracked >= MAX_TRACKED_SYNC_METRICS)) {
      flushAt(at)
    }
  }

  const metrics: AggregatingSyncCommandMetrics = {
    increment(event, code) {
      const key = `${event}\u0000${code ?? ''}`
      rollWindow(counts.size + samples.size, !counts.has(key))
      const existing = counts.get(key)
      if (existing) {
        existing.count += 1
        return
      }
      counts.set(key, code === undefined ? { event, count: 1 } : { event, code, count: 1 })
    },
    // Gauge-style samples (per-RPC backpressure count / max wait) ride the same
    // window with a count/sum/max, so one log grep finds both kinds and a
    // single outlier is still visible inside the aggregate.
    observe(event, code, value) {
      if (!Number.isFinite(value)) {
        return
      }
      const key = `${event}\u0000${code}`
      rollWindow(counts.size + samples.size, !samples.has(key))
      const existing = samples.get(key)
      if (existing) {
        existing.count += 1
        existing.sum += value
        existing.max = Math.max(existing.max, value)
        return
      }
      samples.set(key, { event, code, count: 1, sum: value, max: value })
    },
    flush() {
      flushAt(now())
    },
    close() {
      if (backstop) {
        clearInterval(backstop)
        backstop = undefined
      }
      flushAt(now())
    },
  }

  // A window that rolls only when the next event arrives would sit unlogged for
  // as long as the gateway is quiet -- exactly when an operator is looking.
  let backstop: NodeJS.Timeout | undefined
  if (options.backstopTimer !== false) {
    backstop = setInterval(() => metrics.flush(), flushIntervalMs)
    backstop.unref()
  }

  return metrics
}

/**
 * The individual preconditions behind `SyncGatewayAccess.capabilities()` being
 * empty. Sync availability is a conjunction of eight independent clauses, and
 * for a long time a false result was reported as one undifferentiated
 * "unavailable" -- which is indistinguishable, from outside, from a kill switch,
 * an unbound Redis, or an adapter that has not finished starting. These codes
 * exist so a refusal names its own cause. They are STABLE, non-sensitive
 * identifiers: never put a secret, URL or user identifier in one.
 */
export type SyncUnavailabilityReason =
  | 'sync-not-configured'
  | 'gateway-stopping'
  | 'disabled-by-configuration'
  | 'no-allowed-origins'
  | 'ticket-store-unavailable'
  | 'command-lease-store-unavailable'
  | 'socket-budget-store-unavailable'
  | 'authorization-adapter-unavailable'
  /**
   * Retained and still reported, but NO LONGER FATAL to the socket. The durable
   * backend is a dependency of `SYNC_ITEMS` alone; when it is unready the
   * socket opens and simply does not advertise that one operation. It used to
   * be part of the availability conjunction, which meant an unbound gRPC proxy
   * -- or a bound one missing SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET -- shut
   * the lane and took INVITE_EVENTS, AUTHORIZE_COLLABORATION, API_RPC,
   * STREAM_ASSISTANT and FILES_V1 down with it, none of which depend on it.
   */
  | 'durable-backend-unavailable'
  /**
   * Retained as a diagnostic code but NO LONGER produced by the lane gate.
   * The invite availability bus is a dependency of `INVITE_EVENTS` alone,
   * which the command handler already withholds per socket while the bus is
   * not ready. Gating the whole lane on it meant a client that connected
   * during a 1-2 s Redis reconnect window was HTTP-only for the session.
   */
  | 'invite-event-store-unavailable'

export interface SyncGatewayAccess {
  capabilities(): SyncCapabilityResponse
  issueTicket(identity: SyncTicketIdentity): Promise<SyncTicketResponse>
  /**
   * Optional so existing hosts and test doubles keep satisfying the interface.
   * An empty array means available; a non-empty one lists EVERY unmet
   * precondition, not just the first, so one log line resolves the whole gate.
   */
  unavailabilityReasons?(): readonly SyncUnavailabilityReason[]
}

/**
 * The preconditions that describe a fleet-shared store which has not (yet)
 * reported ready: a boot or a Redis reconnect window rather than a
 * configuration decision. A refusal made only of these is transient, and the
 * ticket endpoint says so (503 + Retry-After) instead of letting the client
 * cache "sync disabled" for a minute.
 */
export const SYNC_STORE_READINESS_REASONS: ReadonlySet<SyncUnavailabilityReason> = new Set<SyncUnavailabilityReason>([
  'ticket-store-unavailable',
  'command-lease-store-unavailable',
  'socket-budget-store-unavailable',
  'invite-event-store-unavailable',
])

/* -------------------------------------------------------------------------- */
/* Admission and traffic counters                                             */
/* -------------------------------------------------------------------------- */

/**
 * The gateway's own closed reasons for turning a `/sockets/sync` upgrade away,
 * as the CLOSE REASON spells them. They are protocol identifiers a client reads
 * off a 1008/1013, so they are kebab-case and they are not free to change.
 */
export const SOCKET_REJECTION_CODES = ['origin-not-allowed', 'query-string-not-permitted', 'unavailable'] as const

export type SocketRejectionCode = (typeof SOCKET_REJECTION_CODES)[number]

/**
 * The counter key each close reason increments.
 *
 * One map, so the counter and the close reason cannot drift: a new refusal
 * cause has to name its counter here or it does not compile. The keys are the
 * camelCase ones the admin panel already declares (`SOCKET_REJECTION_CAUSES` in
 * `websocketSection.ts`), member for member, so a count served from here cannot
 * arrive under a name the client has no row for.
 */
export const SOCKET_REJECTION_COUNTERS = {
  'origin-not-allowed': 'originNotAllowed',
  'query-string-not-permitted': 'queryStringNotPermitted',
  unavailable: 'unavailable',
} as const satisfies Record<SocketRejectionCode, string>

export type SocketRejectionCounter = (typeof SOCKET_REJECTION_COUNTERS)[SocketRejectionCode]

/**
 * Bounds this build declares for the admission block. Every count is SATURATED
 * at its ceiling on the way out (the same move `runtime.processUptimeSeconds`
 * makes), so no figure this gateway emits can ever be unbounded -- and a reader
 * may treat anything above a ceiling as malformed rather than as a measurement.
 */
export const MAX_REPORTED_ORIGIN_RULES = 1_024
export const MAX_REPORTED_LIVE_SOCKETS = 1_000_000
export const MAX_REPORTED_ADMISSION_EVENTS = 1_000_000_000

/**
 * Every operation this protocol can negotiate, as a runtime tuple, purely so
 * the advertisable COUNT has a declared ceiling that cannot be larger than the
 * number of operations that exist.
 *
 * `AssertNever` below makes a new member of `SyncNegotiatedOperation` a COMPILE
 * ERROR here rather than a silently short ceiling -- the `satisfies` clause
 * alone would catch a misspelling and miss an omission, which is the failure
 * mode that matters for a bound.
 *
 * The tuple is never emitted and never read by the admission block. Only its
 * LENGTH is used: operation names are server-chosen strings, this report is
 * pasted in public, and a name is the one value here with an address-shaped
 * future.
 */
export const NEGOTIABLE_OPERATIONS = [
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  'FILES_V1',
] as const satisfies readonly SyncNegotiatedOperation[]

type AssertNever<T extends never> = T
export type EveryNegotiableOperationIsListed = AssertNever<
  Exclude<SyncNegotiatedOperation, (typeof NEGOTIABLE_OPERATIONS)[number]>
>

/**
 * The ceiling on the advertisable-operation count: the number of operations
 * this protocol defines. A figure above it is malformed by this contract rather
 * than merely large, because no handshake can advertise an operation that does
 * not exist.
 */
export const MAX_REPORTED_ADVERTISABLE_OPERATIONS = NEGOTIABLE_OPERATIONS.length

/**
 * What the advertisable count reads: the adapters, structurally, so the
 * function below can be driven directly by a test over every combination.
 *
 * Narrower than `SyncGatewayOptions` on purpose — it names exactly the members
 * the AUTHENTICATED frame consults and nothing else, so a reader can check this
 * against the handshake by eye.
 */
export type AdvertisableOperationInputs = {
  backend: { ready(): boolean }
  collaborationAuthorization?: { collaborationAuthorizationReady(): boolean }
  apiRpc?: { ready(): boolean; operations(): readonly unknown[] }
  inviteEvents?: { ready(): boolean; readonly distribution: 'process' | 'shared' }
  files?: { ready(): boolean }
  requireSharedState?: boolean
}

/**
 * How many operations the next AUTHENTICATED frame would advertise.
 *
 * THE SAME PREDICATES THE HANDSHAKE ASKS, clause for clause and in the same
 * order, because the list itself is built in the command handler and a second
 * opinion about it is worse than no figure at all: an operator reading "5
 * advertisable" on a lane advertising 3 has been told something false by the
 * one screen that exists to tell them the truth. A gateway test pins this
 * function's answer against a REAL handshake's operation list across every
 * configuration a gateway can attach in, so the two cannot drift silently.
 *
 * Evaluated per question, never cached: every clause is a readiness call whose
 * answer changes while the process runs.
 *
 * `apiRpc.operations().length` rather than `1`, because that one adapter
 * advertises TWO operations (`API_RPC` and `STREAM_ASSISTANT`) and advertises
 * them independently — counting it as one would under-report exactly the
 * deployment whose assistant stream is the missing thing.
 *
 * The invite clause carries the handler's shared-distribution condition. On an
 * attached gateway that condition is additionally guaranteed by `attach()`,
 * which refuses a `requireSharedState` lane whose invite bus is process-local;
 * it is mirrored anyway because the handler is the authority on what gets
 * advertised, and a count that agrees with the handler only because of a guard
 * three hundred lines away is a count that breaks when the guard moves.
 *
 * A COUNT ONLY. Nothing here reads, returns or so much as names an operation.
 */
export function countAdvertisableOperations(sync: AdvertisableOperationInputs | undefined): number {
  if (!sync) {
    return 0
  }

  const count =
    (sync.backend.ready() ? 1 : 0) +
    (sync.collaborationAuthorization?.collaborationAuthorizationReady() === true ? 1 : 0) +
    (sync.apiRpc?.ready() === true ? sync.apiRpc.operations().length : 0) +
    (sync.inviteEvents?.ready() === true && (!sync.requireSharedState || sync.inviteEvents.distribution === 'shared')
      ? 1
      : 0) +
    (sync.files?.ready() === true ? 1 : 0)

  return boundedAdmissionCount(count, MAX_REPORTED_ADVERTISABLE_OPERATIONS)
}

/**
 * What an upgrade (or a diagnostics question ABOUT one) carries that the origin
 * decision reads. A struct rather than an `IncomingMessage` so the admission
 * question can be asked by a caller that holds an ordinary HTTP request -- the
 * admin diagnostics endpoint -- through the SAME predicate the upgrade path
 * runs, rather than through a second implementation of the rule that can
 * disagree with it silently.
 *
 * It carries no credential: an origin, a host and a forwarded scheme are the
 * whole of what the decision looks at.
 */
export interface AdmissionProbe {
  /** The browser's `Origin` header, verbatim. Attacker-controlled input; never logged, never emitted. */
  origin?: string
  /** The `Host` header the request arrived at. */
  host?: string
  forwardedProto?: string | readonly string[]
  /** Whether the socket underneath is TLS, used only when no forwarded scheme is present. */
  encrypted?: boolean
  /**
   * THE ONE WIDENING, and only a diagnostics probe may set it.
   *
   * A reverse proxy may forward the API under a host whose port it normalised
   * away while forwarding the socket under the host the browser used --
   * `app/docker/single/nginx.conf` does exactly that, `Host $host` for `/v1`
   * and `Host $http_host` for `/sockets`, thirty lines apart, the second with a
   * comment about this very check. Comparing the ADMIN request's host strictly
   * would then answer a conclusive NO about a socket the same deployment
   * admits, and a NO is the answer the panel renders as broken.
   *
   * So when the host carries no port at all, the comparison falls back to
   * scheme and hostname. It can only ever turn an ambiguous NO into a YES, and
   * a YES is reported by the panel as `undetermined` ("admission is necessary
   * and nowhere near sufficient") while a NO is conclusive. The real upgrade
   * path NEVER sets this: a socket is admitted or refused on the strict rule.
   */
  proxyNormalizedHostPort?: boolean
}

/**
 * Gateway-side admission and traffic counters: the eight members the admin
 * panel's `SocketGatewayCountersView` declares, with the same names, so the
 * client pass is a field read.
 *
 * SECRECY. Every member is a boolean or a bounded count. There is no `string`
 * field here and there is nowhere for one to go: a refusal is a count against a
 * closed cause, never an identified client. No origin, address, port, ticket,
 * session, device or user identifier can travel in this shape.
 *
 * LIFETIME, stated per member below, because a counter that silently resets is
 * worse than no counter: four of them are monotonic SINCE ATTACH (the same
 * lifetime the existing `pushesDispatched` already has), one is an
 * instantaneous gauge, two are configuration and one is per-question.
 */
export interface GatewayAdmission {
  /**
   * Whether this gateway would admit the origin the asking request carried.
   * PER QUESTION, not a counter. OMITTED when the caller could not name an
   * origin at all -- which is not `false`: absent means nobody asked the
   * question with an origin in hand, while `false` is this gateway answering
   * no about a real one.
   */
  originAdmitted?: boolean
  /**
   * How many ORIGIN RULES admit a client: each entry of the normalised
   * allowlist, plus ONE for the derived same-origin rule when it is enabled.
   *
   * Rules rather than list entries, deliberately. Zero then means exactly what
   * the lane's own `no-allowed-origins` precondition means -- this gateway
   * admits nobody -- which is the reading the panel renders as broken. The raw
   * list cardinality would read zero on the bundled single container, whose
   * allowlist is empty BECAUSE same-origin admission covers it, and paint a
   * healthy deployment broken forever. The `allowsSameOrigin` boolean beside it
   * says what the extra rule is. CONFIGURATION, not a counter.
   */
  allowedOriginCount: number
  /** Whether the derived same-origin rule is enabled. CONFIGURATION, not a counter. */
  allowsSameOrigin: boolean
  /** Open sockets this ws server holds right now, both lanes. An instantaneous GAUGE, never a total. */
  liveSockets: number
  /** Sync tickets minted. MONOTONIC SINCE ATTACH. */
  ticketsIssued: number
  /**
   * Mint requests that reached this issuer and produced no ticket: an unmet
   * precondition, the shutdown race, or a ticket store that failed. Issued plus
   * refused is every mint that reached the issuer. MONOTONIC SINCE ATTACH.
   *
   * WHAT IT DOES NOT COUNT, measured on a live container rather than reasoned
   * about: a mint made while the lane advertises NO capability at all is
   * refused by the HTTP layer before the request reaches this issuer
   * (`SyncWebSocketAccessService.issueTicket` throws on an empty capability
   * list), so a structurally-down lane shows `ticketsRefused: 0` however many
   * clients ask. That is not this counter's job to report and it is not
   * invisible: `live.unavailabilityReasons` names the structural refusal
   * directly. What lands here is the refusal no other field can show — the
   * store that was ready at the capability check and failed at the issue, and
   * the mint that raced a shutdown.
   */
  ticketsRefused: number
  /**
   * Handshakes that presented a ticket the store did not accept (or whose
   * device did not match it). NOT the deadline, the per-user socket limit or a
   * store outage -- each of those is a different fault with a different fix,
   * and folding them in here would fire the panel's "the two processes disagree
   * about the ticket secret" correlation over an idle client. MONOTONIC SINCE
   * ATTACH: it is counted in the gateway, not on the socket, so a reconnect
   * cannot reset it.
   */
  handshakeRejected: number
  /** Upgrades refused at the door, by closed cause. MONOTONIC SINCE ATTACH. */
  rejections: Readonly<Record<SocketRejectionCounter, number>>
  /**
   * How many operations a socket authenticating RIGHT NOW would be advertised.
   * CONFIGURATION-AND-READINESS, read per question; neither a counter nor a
   * total.
   *
   * A COUNT AND NEVER THE NAMES. The names are server-chosen strings and the
   * report this feeds is written to be pasted in public; a count answers the
   * question the panel asks ("is this lane advertising anything, and is it
   * advertising less than the protocol defines") without putting a
   * server-chosen string on the wire. The ceiling is the number of operations
   * this protocol defines, so a figure above it is malformed rather than large.
   *
   * ZERO IS A REAL READING and the one that matters: a lane whose socket opens
   * and advertises nothing refuses every mint BEFORE the issuer, which is why
   * `ticketsRefused` stays at 0 while every client is turned away. The panel's
   * capability block had no producer for this at all and rendered its own empty
   * note.
   *
   * It is derived from the SAME predicates the AUTHENTICATED frame asks, in the
   * same order, so the figure is what the next handshake would actually
   * advertise rather than a second opinion about it. A gateway test pins it
   * against a real handshake's operation list, because the list itself is built
   * in the command handler and the two must not drift.
   */
  advertisableOperationCount: number
}

/** Thrown by `SyncGatewayAccess.issueTicket` so the HTTP layer can name the cause. */
export class SyncUnavailableError extends Error {
  readonly reasons: readonly SyncUnavailabilityReason[]
  /** True when EVERY unmet reason is a store-readiness one (see above). */
  readonly transient: boolean

  constructor(reasons: readonly SyncUnavailabilityReason[], message = 'WebSocket sync is unavailable.') {
    super(message)
    this.name = 'SyncUnavailableError'
    this.reasons = [...reasons]
    this.transient = reasons.length > 0 && reasons.every((reason) => SYNC_STORE_READINESS_REASONS.has(reason))
  }
}

export interface WebSocketRelayBacklogLimits {
  /** Maximum parsed collaboration frames waiting for ordered async handling. */
  frameCapacity: number
  /** Maximum serialized bytes retained by those pending frames. */
  byteCapacity: number
}

export const DEFAULT_WEBSOCKET_RELAY_BACKLOG_LIMITS: Readonly<WebSocketRelayBacklogLimits> = Object.freeze({
  /**
   * At least the legacy lane's instantaneous ingress burst
   * (`DEFAULT_WEBSOCKET_INGRESS_LIMITS.frameCapacity`). The backlog used to be
   * 128 against a 512-frame burst, so a client the rate limiter deliberately
   * admits -- a Yjs bootstrap chunk train, or a tab returning from background
   * with queued awareness updates -- could overflow the ordered relay queue
   * purely because room authorization is async. The two limits are one policy
   * and must not disagree; this one is the wider of the pair by construction.
   */
  frameCapacity: DEFAULT_WEBSOCKET_INGRESS_LIMITS.frameCapacity,
  // Covers one maximum 4 MiB Yjs transfer after base64/JSON overhead while
  // still placing a hard per-socket ceiling on retained queued input.
  byteCapacity: 8 * 1024 * 1024,
})

function assertValidIngressLimits(limits: WebSocketIngressLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid WebSocket ingress limit ${name}: expected a finite positive number.`)
    }
  }
}

function assertValidRelayBacklogLimits(limits: WebSocketRelayBacklogLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid WebSocket relay backlog limit ${name}: expected a positive safe integer.`)
    }
  }
}

/** Exact accounting for the ordered async relay chain retained by one socket. */
export class WebSocketRelayBacklog {
  private frames = 0
  private bytes = 0

  constructor(private readonly limits: WebSocketRelayBacklogLimits) {}

  tryEnqueue(bytes: number): boolean {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.frames >= this.limits.frameCapacity ||
      this.bytes + bytes > this.limits.byteCapacity
    ) {
      return false
    }
    this.frames += 1
    this.bytes += bytes
    return true
  }

  settle(bytes: number): void {
    this.frames = Math.max(0, this.frames - 1)
    this.bytes = Math.max(0, this.bytes - bytes)
  }

  clear(): void {
    this.frames = 0
    this.bytes = 0
  }

  pending(): Readonly<{ frames: number; bytes: number }> {
    return { frames: this.frames, bytes: this.bytes }
  }
}

export class WebSocketIngressLimiter {
  private frameTokens: number
  private byteTokens: number
  private lastRefill: number

  constructor(
    private readonly limits: WebSocketIngressLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.frameTokens = limits.frameCapacity
    this.byteTokens = limits.byteCapacity
    this.lastRefill = now()
  }

  tryConsume(bytes: number): boolean {
    const currentTime = this.now()
    const elapsedSeconds = Math.max(0, currentTime - this.lastRefill) / 1_000
    this.lastRefill = currentTime
    this.frameTokens = Math.min(
      this.limits.frameCapacity,
      this.frameTokens + elapsedSeconds * this.limits.frameRefillPerSecond,
    )
    this.byteTokens = Math.min(
      this.limits.byteCapacity,
      this.byteTokens + elapsedSeconds * this.limits.byteRefillPerSecond,
    )

    if (!Number.isFinite(bytes) || bytes < 0 || this.frameTokens < 1 || this.byteTokens < bytes) {
      return false
    }

    this.frameTokens -= 1
    this.byteTokens -= bytes
    return true
  }
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.byteLength, 0)
  }
  return data.byteLength
}

function copyRawData(data: RawData): Uint8Array {
  const copy = new Uint8Array(rawDataByteLength(data))
  if (Array.isArray(data)) {
    let offset = 0
    for (const part of data) {
      copy.set(part, offset)
      offset += part.byteLength
    }
    return copy
  }
  copy.set(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
  return copy
}

/**
 * Constant-time comparison of two secrets that does not leak length or content
 * via timing. Both sides are SHA-256 digested first so the comparison is always
 * over equal-length buffers (timingSafeEqual throws on length mismatch, which
 * itself leaks length). Returns false for any missing/non-string input.
 */
function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0 || expected.length === 0) {
    return false
  }
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

export interface GatewayConfig {
  /** WEB_SOCKET_CONNECTION_TOKEN_SECRET — HS256 key for connection tokens. */
  connectionTokenSecret: string
  /** WEB_SOCKET_CONNECTION_TOKEN_TTL, e.g. '60s'. */
  connectionTokenTtl: string
  /** WEBSOCKET_GATEWAY_INTERNAL_SECRET. When empty, internal minting is disabled. */
  internalSecret: string
  /** AUTH_JWT_SECRET — verifies the api-gateway's forwarded x-auth-token. */
  authJwtSecret: string
  /**
   * REDIS_HOST. OPTIONAL since the single-container and LXC topologies attach
   * with `sharedState: 'in-process'` (C16) and open no Redis connection at all;
   * omitting it used to mean the host attached no gateway, so those
   * deployments shipped with no push, no live collaboration, no realtime
   * invites and no push-MFA.
   */
  redisHost?: string
  redisPort: number
  /**
   * WEBSOCKET_REDIS_NAMESPACE. When set (`^[a-z0-9:_-]{1,64}$`) it prefixes the
   * push channel, the collaboration relay channel and keys, the SQS dedup keys
   * and the invite stream keys as `<namespace>:<original>`. Empty means the
   * names a deployment has always used, so a rolling upgrade keeps talking.
   */
  redisNamespace?: string
  /** Optional operator override; attach-level override wins (primarily tests). */
  maxConnectionsPerUser?: number
  /** SQS source; when queueUrl is unset the consumer is not started. */
  sqs?: {
    queueUrl?: string
    endpoint?: string
    region?: string
    accessKeyId?: string
    secretAccessKey?: string
  }
}

/**
 * Minimal Express-app shape we need: registering a POST handler. The handler
 * param is intentionally loose (`...args: any[]`) so a fully-typed Express
 * `Application` (whose `post` is heavily overloaded) satisfies this interface;
 * the handler we register is `(req: IncomingMessage, res: ServerResponse)`,
 * which Express's `Request`/`Response` subtypes accept.
 */
export interface RouteRegistrar {
  post(path: string, handler: (...args: any[]) => void): unknown
}

export interface AttachOptions {
  httpServer: HttpServer
  config: GatewayConfig
  logger: Logger
  /** Shared completion store for durable SQS websocket event IDs. */
  sqsEventDedupStore?: SqsEventDedupStore
  /**
   * When provided (attached mode), the token-mint endpoint is registered here
   * as `POST /sockets/tokens`. When omitted (standalone mode), the caller wires
   * the returned `handleMintToken` into its own http server instead.
   */
  app?: RouteRegistrar
  /**
   * Collaborative-room membership gate. Decides whether `userUuid` may join the
   * note-room `room` (room id === note uuid), given the signed capability the
   * client presents on the join frame. Without a gate, ANY authenticated socket
   * could `room-join` an arbitrary note uuid and receive/inject every yjs/awareness
   * frame for it (presence/edit-timing metadata leak + junk injection; note
   * content stays E2E-encrypted).
   *
   * SECURITY DEFAULT: when this is omitted, the gateway does NOT fall back to
   * allow-all. It installs a built-in authorizer that verifies the room
   * capability against `config.connectionTokenSecret` (see verifyRoomCapability)
   * and FAILS CLOSED on anything missing/invalid/expired/mismatched. Pass a custom
   * authorizer only to override that (e.g. tests).
   */
  authorizeRoomJoin?: RoomJoinAuthorizer
  /**
   * Optional tighter limits for constrained deployments and deterministic
   * tests. Omitted fields retain the conservative production defaults.
   */
  ingressLimits?: Partial<WebSocketIngressLimits>
  /** Optional tighter ordered-relay backlog limits (primarily tests). */
  relayBacklogLimits?: Partial<WebSocketRelayBacklogLimits>
  /**
   * Aggregate live-socket ceiling for one authenticated user. This prevents
   * bypassing per-connection ingress limits by opening unbounded tabs/sockets.
   */
  maxConnectionsPerUser?: number
  /** Separate authenticated command plane. Omitted means capability off. */
  sync?: SyncGatewayOptions
  /**
   * Where the state several gateway replicas would have to agree on lives (C16).
   *
   *   - `'redis'` (the default whenever `config.redisHost` is set): the push
   *     bridge subscribes to the shared channel and the collaboration plane is
   *     the Redis bridge. This is the ONLY correct choice for more than one
   *     gateway process.
   *   - `'in-process'` (the default when `config.redisHost` is empty): the same
   *     decisions over in-memory maps, with no Redis connection. Correct for
   *     exactly one process -- the single container, the LXC image -- and
   *     wrong for any fleet, which is why `sync.requireSharedState` is refused
   *     alongside it rather than quietly downgraded.
   */
  sharedState?: 'redis' | 'in-process'
}

/**
 * What the realtime path can say about itself, for `/healthcheck/readiness`
 * (informational, never gating: a Redis blip must not restart the container)
 * and the admin sync diagnostics. Nothing in here is secret or per-user.
 */
export interface GatewayHealth {
  attached: true
  /** Which push transport this deployment attached: Redis pub/sub, an in-process bridge, or none. */
  pushBridge: 'redis' | 'in-process' | 'none'
  /** The push subscriber's client currently reports `ready`. */
  pushBridgeReady: boolean
  /** The SQS consumer loop was started and has not been stopped. */
  sqsConsumerRunning: boolean
  /** The collaboration relay subscription is established (fleet-wide relay works). */
  collaborationRelayHealthy: boolean
  /** Whether `/sockets/sync` would admit a client right now. */
  syncLane: 'up' | 'down'
  /** Push messages handed to the local connection registry since attach. */
  pushesDispatched: number
}

export interface AttachedGateway {
  registry: ConnectionRegistry<WebSocket>
  rooms: RoomRegistry<WebSocket>
  /** POST /sockets/tokens handler, exposed for callers that own their own http server. */
  handleMintToken(req: IncomingMessage, res: ServerResponse): void
  /**
   * Push one already-composed message to a user's live sockets, returning how
   * many received it (C16). This is the SAME fan-out the Redis bridge performs
   * on a received channel message, exposed for a host that has no Redis to
   * publish through: `WebSocketInProcessBridge` in home-server calls it
   * directly from the domain event. Counted by `health().pushesDispatched`
   * like every other transport.
   */
  dispatch(message: DispatchMessage): number
  sync: SyncGatewayAccess
  /** A point-in-time, side-effect-free snapshot; cheap enough to call per readiness probe. */
  health(): GatewayHealth
  /**
   * The admission and traffic block for the admin diagnostics, answered for
   * ONE asking request. Side-effect-free and cheap; it takes a probe rather
   * than returning a snapshot because one of its eight members -- "would you
   * admit this caller's origin" -- is a question and not a measurement.
   *
   * Separate from `health()` deliberately: `health()` is what the readiness
   * probe calls on an interval and it answers the same thing for everyone.
   */
  admission(probe?: AdmissionProbe): GatewayAdmission
  /** Tear down the ws server, heartbeat, redis bridge and SQS consumer. */
  stop(): Promise<void>
}

/**
 * Build the POST /sockets/tokens handler. See the standalone entry's original
 * doc for the security model: web-client path uses the forwarded x-auth-token;
 * the internal path requires WEBSOCKET_GATEWAY_INTERNAL_SECRET and a body.
 */
function buildMintTokenHandler(
  config: GatewayConfig,
  logger: Logger,
): (req: IncomingMessage, res: ServerResponse) => void {
  const logRefusal = createRefusalLogger(logger)

  return function handleMintToken(req: IncomingMessage, res: ServerResponse): void {
    const xAuthToken = req.headers['x-auth-token']
    if (typeof xAuthToken === 'string' && xAuthToken.length > 0) {
      const identity = config.authJwtSecret ? decodeCrossServiceToken(xAuthToken, config.authJwtSecret) : undefined
      if (!identity) {
        // Distinguishes "AUTH_JWT_SECRET is not configured here" from "the
        // presented cross-service token did not verify" -- the first is an
        // operator misconfiguration, the second is normal client churn.
        logRefusal(
          config.authJwtSecret
            ? '[token] mint refused: x-auth-token did not decode against AUTH_JWT_SECRET'
            : '[token] mint refused: AUTH_JWT_SECRET is not configured, so no x-auth-token can be accepted',
          config.authJwtSecret ? 'mint:bad-x-auth-token' : 'mint:no-auth-jwt-secret',
        )
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid auth token' }))
        return
      }
      const token = mintConnectionToken(identity, config.connectionTokenSecret, config.connectionTokenTtl)
      // No user identifier on the success line: every legacy reconnect on
      // every device would otherwise write it three times at info.
      logger.info('[token] minted (x-auth)')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token }))
      return
    }

    // Internal path: fail CLOSED when no internal secret is configured.
    if (!config.internalSecret) {
      logRefusal(
        '[token] mint refused: WEBSOCKET_GATEWAY_INTERNAL_SECRET is not configured, so internal minting is disabled',
        'mint:no-internal-secret',
      )
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal token minting is disabled (no internal secret configured)' }))
      return
    }
    // The internal path mints a connection token for ANY user the body names.
    // It is meant for a process on this host, yet every front door proxies
    // `/sockets` straight through, so a holder of the secret could open a
    // legacy socket as anyone from the internet. A proxied request always
    // carries X-Forwarded-For (both shipped nginx configs set it), and a
    // direct one arrives from a non-loopback peer; both are refused before
    // the secret is even compared. Fails closed when the peer is unknown.
    if (!isDirectLoopbackRequest(req)) {
      logRefusal(
        '[token] mint refused: the internal-secret path is only accepted from a direct loopback caller (request was proxied or remote)',
        'mint:internal-secret-proxied',
      )
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    const provided = req.headers['x-internal-secret']
    // Constant-time compare so the internal secret cannot be recovered byte by
    // byte via response-timing analysis. Fails closed for missing/array headers.
    if (!secretsMatch(provided, config.internalSecret)) {
      logRefusal(
        '[token] mint refused: x-internal-secret absent or did not match WEBSOCKET_GATEWAY_INTERNAL_SECRET',
        'mint:internal-secret-mismatch',
      )
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }

    // The api-gateway parses JSON bodies before this handler runs, so prefer an
    // already-parsed body when present; otherwise read the raw stream (standalone).
    const parsedBody = (req as { body?: unknown }).body
    if (parsedBody && typeof parsedBody === 'object') {
      mintFromBody(parsedBody as Record<string, unknown>, config, logger, res, logRefusal)
      return
    }

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 16_384) {
        logRefusal('[token] mint refused: request body exceeded the 16384-byte bound', 'mint:body-too-large')
        req.destroy()
      }
    })
    req.on('end', () => {
      let parsed: Record<string, unknown>
      try {
        parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      } catch {
        logRefusal('[token] mint refused: request body was not valid JSON', 'mint:invalid-json')
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid json body' }))
        return
      }
      mintFromBody(parsed, config, logger, res, logRefusal)
    })
  }
}

function mintFromBody(
  parsed: Record<string, unknown>,
  config: GatewayConfig,
  logger: Logger,
  res: ServerResponse,
  logRefusal: RefusalLogger,
): void {
  const userUuid = parsed.userUuid
  const sessionUuid = parsed.sessionUuid
  if (typeof userUuid !== 'string' || typeof sessionUuid !== 'string' || !userUuid || !sessionUuid) {
    logRefusal('[token] mint refused: body is missing a userUuid or sessionUuid', 'mint:incomplete-body')
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'userUuid and sessionUuid are required' }))
    return
  }
  const token = mintConnectionToken({ userUuid, sessionUuid }, config.connectionTokenSecret, config.connectionTokenTtl)
  logger.info('[token] minted (internal)')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ token }))
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * True only for a request that reached this process directly from the local
 * machine: no X-Forwarded-For (set by every reverse proxy in front of the
 * gateway) and a loopback peer address. An unknown peer counts as remote.
 */
function isDirectLoopbackRequest(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] !== undefined) {
    return false
  }
  const remoteAddress = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
  return (
    typeof remoteAddress === 'string' && (LOOPBACK_ADDRESSES.has(remoteAddress) || remoteAddress.startsWith('127.'))
  )
}

export type RefusalLogger = (message: string, throttleKey: string, metadata?: Record<string, unknown>) => void

/**
 * Every refusal in this file goes through here. Two rules it enforces for free:
 * the line is THROTTLED (an unauthenticated caller must not be able to drive
 * unbounded log volume by retrying), and the metadata is serialized with
 * JSON.stringify so it survives the minimal variadic logger bridge the
 * api-gateway and home-server install -- the same reason
 * `createLoggerSyncCommandMetrics` does it.
 *
 * Callers pass only stable, non-sensitive codes and counters. No token, no
 * header value, no body, no email.
 */
export function createRefusalLogger(logger: Logger, throttle: LogThrottle = createLogThrottle()): RefusalLogger {
  return (message: string, throttleKey: string, metadata?: Record<string, unknown>): void => {
    const decision = throttle.consider(throttleKey)
    if (!decision.emit) {
      return
    }
    logger.warn(message, JSON.stringify({ ...(metadata ?? {}), suppressedSinceLastLog: decision.suppressed }))
  }
}

function normalizeAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  const normalized = new Set<string>()
  for (const origin of origins) {
    if (origin === '*' || origin === 'null') {
      continue
    }
    try {
      const parsed = new URL(origin)
      const permittedScheme =
        parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'tauri:'
      const hasOriginOnly =
        parsed.username === '' &&
        parsed.password === '' &&
        (parsed.pathname === '' || parsed.pathname === '/') &&
        parsed.search === '' &&
        parsed.hash === '' &&
        (parsed.protocol === 'tauri:' ? `${parsed.protocol}//${parsed.host}` === origin : parsed.origin === origin)
      if (permittedScheme && hasOriginOnly) {
        normalized.add(origin)
      }
    } catch {
      // Invalid and wildcard origins are not admitted.
    }
  }
  return normalized
}

/**
 * Browser WebSockets always carry an Origin header while Host identifies the
 * actual upgrade target and cannot be set by page script. Reverse proxies in
 * the supported deployments preserve Host and overwrite X-Forwarded-Proto.
 * Comparing those values gives an exact same-site fallback without accepting a
 * wildcard origin or trusting a caller-provided query credential.
 *
 * Takes an `AdmissionProbe` rather than the request so that the admin
 * diagnostics question -- "would this gateway admit the origin my caller
 * arrived from?" -- is answered by THIS function and not by a second copy of
 * the rule. See `AdmissionProbe.proxyNormalizedHostPort` for the single
 * widening a diagnostics caller may ask for, which the upgrade path never sets.
 */
function isSameOriginTarget(probe: AdmissionProbe, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  const rawHost = probe.host
  if (typeof rawHost !== 'string' || rawHost.length === 0) {
    return false
  }
  const forwarded = probe.forwardedProto
  const forwardedValue = typeof forwarded === 'string' ? forwarded : forwarded?.[0]
  let effectiveProtocol: 'http:' | 'https:'
  if (forwardedValue !== undefined) {
    const forwardedProtocols = forwardedValue.split(',').map((value) => value.trim().toLowerCase())
    if (forwardedProtocols.length !== 1 || (forwardedProtocols[0] !== 'http' && forwardedProtocols[0] !== 'https')) {
      return false
    }
    effectiveProtocol = `${forwardedProtocols[0]}:`
  } else {
    effectiveProtocol = probe.encrypted === true ? 'https:' : 'http:'
  }

  let target: URL
  try {
    target = new URL(`${effectiveProtocol}//${rawHost}`)
  } catch {
    return false
  }

  // URL.origin canonicalizes host case and default ports. Comparing the full
  // effective origins therefore admits https://host against Host host:443,
  // while rejecting the same hostname on another port or forwarded scheme.
  if (parsed.origin === target.origin) {
    return true
  }

  // The diagnostics widening, and ONLY when the host carries no port for the
  // comparison to use. `/:\d+$/` rather than a search for ':' so a bracketed
  // IPv6 host (`[::1]`, `[::1]:3000`) is read correctly.
  return (
    probe.proxyNormalizedHostPort === true &&
    !/:\d+$/.test(rawHost) &&
    parsed.protocol === target.protocol &&
    parsed.hostname === target.hostname
  )
}

/**
 * The ONE origin decision, run by the upgrade path and by the diagnostics
 * probe alike.
 *
 * An absent or non-string origin is refused: a browser always sends one on a
 * WebSocket upgrade, so a missing one is not a browser.
 */
function admitsProbeOrigin(
  allowedOrigins: ReadonlySet<string>,
  allowSameOrigin: boolean,
  probe: AdmissionProbe,
): boolean {
  const origin = probe.origin

  return (
    typeof origin === 'string' && (allowedOrigins.has(origin) || (allowSameOrigin && isSameOriginTarget(probe, origin)))
  )
}

/** The probe an actual upgrade carries. The widening is deliberately absent. */
function admissionProbeOf(request: IncomingMessage): AdmissionProbe {
  const origin = request.headers.origin

  return {
    ...(typeof origin === 'string' ? { origin } : {}),
    ...(typeof request.headers.host === 'string' ? { host: request.headers.host } : {}),
    ...(request.headers['x-forwarded-proto'] === undefined
      ? {}
      : { forwardedProto: request.headers['x-forwarded-proto'] }),
    encrypted: (request.socket as { encrypted?: boolean }).encrypted === true,
  }
}

/** Saturate a measured count at the ceiling this build declares for it. */
function boundedAdmissionCount(value: number, max: number): number {
  return Math.max(0, Math.min(Math.floor(value), max))
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Attach a WebSocket gateway to an existing http server.
 *
 * Creates the ws server (sharing the http server / port), wires the connection
 * registry + collaborative-room relay + heartbeat, starts the Redis bridge and
 * (optionally) the SQS consumer, and either registers the token-mint endpoint on
 * the provided Express app or exposes it for the caller to wire up.
 *
 * Fails CLOSED: an empty connection-token secret means tokens are signed with an
 * empty HS256 key (trivially forgeable), so it throws rather than run an open relay.
 */
/**
 * The default, fail-closed room-join authorizer used when a caller does NOT
 * supply its own. It requires a valid signed room capability (verified against
 * the connection-token secret) for the exact user + room; everything else is
 * denied. Exported so the production wiring can be asserted in tests (proving the
 * default is NOT allow-all).
 */
export function defaultRoomJoinAuthorizer(connectionTokenSecret: string): RoomJoinAuthorizer {
  return (userUuid: string, room: string, capability?: string) => {
    const verified = verifyRoomCapabilityWithExpiry(capability, connectionTokenSecret, userUuid, room)
    return verified ? { authorized: true, ...verified } : { authorized: false }
  }
}

export function attachWebSocketGateway(opts: AttachOptions): AttachedGateway {
  const { httpServer, logger, app, authorizeRoomJoin } = opts

  if (!opts.config.connectionTokenSecret) {
    throw new Error('WEB_SOCKET_CONNECTION_TOKEN_SECRET is required (refusing to attach with an empty signing secret).')
  }
  // Belt and braces: the hosts parse these too, but a config that reached
  // here unparsed would mint 0 s tokens ("60") or 500 on every mint ("abc")
  // while readiness stayed green. Normalise once and mint from the result.
  const config: GatewayConfig = {
    ...opts.config,
    connectionTokenTtl: parseConnectionTokenTtl(opts.config.connectionTokenTtl),
    redisNamespace: parseRedisNamespace(opts.config.redisNamespace),
  }

  // SECURITY: default to a capability-verifying authorizer (fail closed). A caller
  // may override (tests), but production never gets allow-all: an absent override
  // still requires a valid, matching, unexpired room capability on every join.
  const roomAuthorizer: RoomJoinAuthorizer =
    authorizeRoomJoin ?? defaultRoomJoinAuthorizer(config.connectionTokenSecret)
  const ingressLimits: WebSocketIngressLimits = {
    ...DEFAULT_WEBSOCKET_INGRESS_LIMITS,
    ...opts.ingressLimits,
  }
  assertValidIngressLimits(ingressLimits)
  const relayBacklogLimits: WebSocketRelayBacklogLimits = {
    ...DEFAULT_WEBSOCKET_RELAY_BACKLOG_LIMITS,
    ...opts.relayBacklogLimits,
  }
  assertValidRelayBacklogLimits(relayBacklogLimits)
  const maxConnectionsPerUser =
    opts.maxConnectionsPerUser ?? config.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER
  if (
    !Number.isSafeInteger(maxConnectionsPerUser) ||
    maxConnectionsPerUser < 1 ||
    maxConnectionsPerUser > MAX_CONNECTIONS_PER_USER_CEILING
  ) {
    throw new Error(
      `Invalid WebSocket per-user connection limit: expected a positive safe integer no greater than ${MAX_CONNECTIONS_PER_USER_CEILING}.`,
    )
  }

  // C16. An explicit choice always wins; otherwise a configured Redis host
  // means the fleet-shared plane and its absence means the single-process one.
  // The absence used to mean "attach nothing at all" at the HOST level, which
  // is what left the single container with no realtime anything.
  const sharedState: 'redis' | 'in-process' = opts.sharedState ?? (config.redisHost ? 'redis' : 'in-process')
  if (sharedState === 'in-process' && opts.sync?.requireSharedState) {
    throw new Error(
      'WebSocket sync cannot require fleet-shared state on an in-process gateway: configure REDIS_HOST, or drop requireSharedState for this single-process deployment.',
    )
  }

  const syncOptions = opts.sync
  const syncAllowedOrigins = normalizeAllowedOrigins(syncOptions?.allowedOrigins ?? [])
  const syncAllowsSameOrigin = syncOptions?.allowSameOrigin === true
  const syncTickets = syncOptions?.tickets ?? new InMemorySyncAuthTicketStore()
  const syncLeases = syncOptions?.leases ?? new InMemorySyncCommandLeaseRegistry()
  const syncSocketBudget =
    syncOptions?.socketBudget ?? new InMemorySyncSocketBudget(syncOptions?.maxSocketsPerUser ?? 4)
  if (
    syncOptions?.requireSharedState &&
    (syncTickets.distribution !== 'shared' ||
      syncLeases.distribution !== 'shared' ||
      syncSocketBudget.distribution !== 'shared' ||
      syncOptions.inviteEvents?.distribution !== 'shared')
  ) {
    throw new Error(
      'WebSocket sync requires fleet-shared ticket, command-lease, socket-budget, and invite-event stores.',
    )
  }
  if (config.sqs?.queueUrl && syncOptions?.requireSharedState && !syncOptions.inviteEventDispatcher) {
    throw new Error('WebSocket sync requires the durable invite-event SQS dispatcher.')
  }
  // The other half of that condition, which was missing: a fleet-shared
  // composition with NO ingress at all. See `inviteEventIngressOwnedByHost`.
  // Per-capability, not fatal -- so it is computed once here and read where the
  // socket's operation list is built.
  const inviteEventIngress: 'sqs' | 'host' | 'none' =
    syncOptions?.inviteEventIngressOwnedByHost === true
      ? 'host'
      : config.sqs?.queueUrl && syncOptions?.inviteEventDispatcher
        ? 'sqs'
        : syncOptions?.requireSharedState === true
          ? 'none'
          : 'host'
  if (syncOptions?.inviteEvents && inviteEventIngress === 'none') {
    // One string, no metadata object: hosts bridge this variadic logger with
    // `args.map(String).join(' ')`, which renders an object as [object Object].
    // Deliberately NOT a new `SyncUnavailabilityReason`: that union is an
    // allowlisted, exhaustively-switched wire vocabulary shared with the admin
    // pane, and this is a per-capability waiver rather than a lane refusal.
    logger.warn(
      '[ws-sync] INVITE_EVENTS will not be advertised (invite-event-ingress-unavailable). ' +
        'This fleet-shared deployment has no invite-event ingress: set SQS_QUEUE_URL so the gateway consumes ' +
        'INVITE_REALTIME_INVALIDATION_REQUESTED, or declare inviteEventIngressOwnedByHost. ' +
        'Invites still reach clients over HTTP in the ordinary sync response, without a push.',
    )
  }
  const socketInviteEvents = inviteEventIngress === 'none' ? undefined : syncOptions?.inviteEvents
  if (syncOptions?.requireSharedState && !syncOptions.files && !syncOptions.filesUnsupported) {
    throw new Error('WebSocket sync requires a FILES_V1 storage adapter, or an explicit filesUnsupported declaration.')
  }
  const syncIngressLimits: WebSocketIngressLimits = {
    ...DEFAULT_SYNC_WEBSOCKET_INGRESS_LIMITS,
    ...syncOptions?.ingressLimits,
  }
  assertValidIngressLimits(syncIngressLimits)
  // The binary file plane has its own bucket. See
  // DEFAULT_SYNC_WEBSOCKET_FILE_INGRESS_LIMITS for why sharing one was a bug.
  const syncFileIngressLimits: WebSocketIngressLimits = {
    ...DEFAULT_SYNC_WEBSOCKET_FILE_INGRESS_LIMITS,
    ...syncOptions?.fileIngressLimits,
  }
  assertValidIngressLimits(syncFileIngressLimits)
  let stopping = false
  const ticketOperations = new Set<Promise<unknown>>()
  // One evaluation, one list of causes. `syncAvailable()` is derived from this
  // rather than the reverse, so the gate and its explanation can never disagree.
  const syncUnavailabilityReasons = (): readonly SyncUnavailabilityReason[] => {
    if (!syncOptions) {
      return ['sync-not-configured']
    }
    const reasons: SyncUnavailabilityReason[] = []
    if (stopping) {
      reasons.push('gateway-stopping')
    }
    if (!syncOptions.isEnabled()) {
      reasons.push('disabled-by-configuration')
    }
    if (syncAllowedOrigins.size === 0 && !syncAllowsSameOrigin) {
      reasons.push('no-allowed-origins')
    }
    if (!syncTickets.ready()) {
      reasons.push('ticket-store-unavailable')
    }
    if (!syncLeases.ready()) {
      reasons.push('command-lease-store-unavailable')
    }
    if (!syncSocketBudget.ready()) {
      reasons.push('socket-budget-store-unavailable')
    }
    if (!sessionAuthorizationReady(syncOptions.authorization)) {
      reasons.push('authorization-adapter-unavailable')
    }
    // Deliberately NOT here: `inviteEvents.ready()`. That bus gates the
    // INVITE_EVENTS operation per socket inside the command handler; it was
    // once a lane precondition, which turned every Redis reconnect window into
    // an HTTP-only session for whoever negotiated during it.
    return reasons
  }
  const syncAvailable = (): boolean => syncUnavailabilityReasons().length === 0
  /**
   * Non-fatal, per-capability. `SYNC_ITEMS` is withheld from the negotiated
   * operation list when this is false; the socket itself stays open and every
   * other capability negotiates normally.
   */
  const syncItemsAvailable = (): boolean => syncOptions?.backend.ready() === true
  // Once per attach, name the SYNC_ITEMS decision separately from the lane's.
  // Without this, a socket that comes up healthy but serves no sync is
  // indistinguishable in the log from one that serves everything -- and that
  // is precisely the state a deployment with no durable command port now runs
  // in permanently, so it must be stated rather than inferred.
  if (syncOptions && !syncItemsAvailable()) {
    // One string, no metadata object: hosts bridge this variadic logger with
    // `args.map(String).join(' ')`, which renders an object as [object Object].
    logger.warn(
      `[ws-sync] SYNC_ITEMS will not be advertised (${'durable-backend-unavailable' satisfies SyncUnavailabilityReason}). ` +
        'The socket still serves collaboration, API RPC, invite events and files; clients sync over HTTP.',
    )
  }
  // Refusals are what an operator needs to see and what a retrying client can
  // emit endlessly; one line per distinct cause per minute keeps both true.
  const logRefusal = createRefusalLogger(logger)
  const logSyncRefusal = (event: string, reasons: readonly SyncUnavailabilityReason[]): void => {
    logRefusal(
      `[ws-sync] ${event}: unmet preconditions ${reasons.join(', ') || 'none'}`,
      `${event}:${reasons.join()}`,
      {
        reasons,
      },
    )
  }
  // *** ADMISSION COUNTERS ***
  //
  // Closure-scoped, so they live as long as the ATTACH and not as long as any
  // socket: the whole point of counting a refusal is that the client it
  // refused is gone. Monotonic since attach, the same lifetime the existing
  // `pushesDispatched` already has and the one the panel's copy states. A
  // restart resets them, which is why the panel reads them beside the process
  // uptime the runtime block publishes.
  //
  // Counts only. There is no map keyed by client here and there must never be
  // one: a refusal is a count against a closed cause, never an identified
  // browser.
  let ticketsIssued = 0
  let ticketsRefused = 0
  let handshakeRejected = 0
  const admissionRejections: Record<SocketRejectionCounter, number> = {
    originNotAllowed: 0,
    queryStringNotPermitted: 0,
    unavailable: 0,
  }

  const sync: SyncGatewayAccess = {
    unavailabilityReasons: syncUnavailabilityReasons,
    capabilities: () => {
      const reasons = syncUnavailabilityReasons()
      if (reasons.length > 0) {
        logSyncRefusal('capability negotiation returned an empty list', reasons)
        return { capabilities: [] }
      }
      return {
        capabilities: [{ id: SYNC_CAPABILITY_ID, version: SYNC_PROTOCOL_VERSION, endpoint: SYNC_SOCKET_PATH }],
      }
    },
    issueTicket: async (identity) => {
      // Every mint that reaches this issuer lands in exactly one of the two
      // counters, decided by the OUTCOME rather than by the arm it took: a
      // precondition refusal, the shutdown race and a ticket store that threw
      // all produced no ticket, and a panel row that counted only the first
      // would read zero on the deployment whose store is the thing that broke.
      // The flag is set at the last statement before the return, so a mint that
      // never settles is counted as neither.
      let minted = false
      try {
        const reasons = syncUnavailabilityReasons()
        if (reasons.length > 0) {
          logSyncRefusal('ticket refused', reasons)
          throw new SyncUnavailableError(reasons)
        }
        const operation = syncTickets.issue(identity)
        ticketOperations.add(operation)
        try {
          const issued = await operation
          if (stopping) {
            throw new SyncUnavailableError(['gateway-stopping'], 'WebSocket sync is stopping.')
          }
          const response: SyncTicketResponse = {
            ticket: issued.ticket,
            expiresAt: issued.expiresAt,
            issuedAt: issued.issuedAt ?? Date.now(),
            endpoint: SYNC_SOCKET_PATH,
            capability: SYNC_CAPABILITY_ID,
            version: SYNC_PROTOCOL_VERSION,
          }
          minted = true

          return response
        } finally {
          ticketOperations.delete(operation)
        }
      } finally {
        if (minted) {
          ticketsIssued += 1
        } else {
          ticketsRefused += 1
        }
      }
    },
  }

  // Every push -- Redis bridge or SQS consumer -- fans out through
  // `pushToUser`, so counting here observes both transports without either
  // having to report back. Read by `health()`.
  let pushesDispatched = 0
  const registry = new (class extends ConnectionRegistry<WebSocket> {
    override pushToUser(userUuid: string, message: string, excludeSessionUuid?: string): number {
      pushesDispatched += 1
      return super.pushToUser(userUuid, message, excludeSessionUuid)
    }
  })()
  const rooms = new RoomRegistry<WebSocket>()
  const alive = new WeakMap<WebSocket, boolean>()
  const syncHandlers = new Set<SyncCommandHandler>()
  /** Sync sockets that spoke after shutdown began; closed 1013 rather than 1001. */
  const drainingRefusals = new Set<WebSocket>()

  const handleMintToken = buildMintTokenHandler(config, logger)
  if (app) {
    // Only the mint route. The gateway-native `/sockets/sync/tickets` and
    // `/sockets/sync/capabilities` handlers were deleted: neither host ever
    // passed `app`, both front doors 404'd them, and the ticket one would have
    // minted credential-less tickets from a bare body had it been reachable.
    // The hosts own those routes behind their session middleware.
    app.post('/sockets/tokens', handleMintToken)
  }

  // This is intentionally enforced by `ws`, before the application-level
  // `message` event and JSON parser can observe or retain an oversized frame.
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
    perMessageDeflate: false,
  })
  const collaborationBridgeOptions = {
    host: config.redisHost ?? '',
    port: config.redisPort,
    logger,
    ...(config.redisNamespace ? { keyPrefix: config.redisNamespace } : {}),
  }
  const collaborationPlane: CollaborationPlane<WebSocket> =
    sharedState === 'in-process'
      ? new InProcessCollaborationLifecycle<WebSocket>(rooms, logger)
      : startCollaborationRedisBridge(rooms, collaborationBridgeOptions)
  // The shared room state is the only place a rotated epoch lives, so the
  // plane is the default resolver; a composition root may supply its own.
  const collaborationRoomEpochResolver: NonNullable<SyncGatewayOptions['collaborationRoomEpochResolver']> =
    syncOptions?.collaborationRoomEpochResolver ??
    ((room, collaborationSecurityEpoch) => collaborationPlane.currentRoomEpoch(room, collaborationSecurityEpoch))

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === SYNC_SOCKET_PATH) {
      const originAllowed = admitsProbeOrigin(syncAllowedOrigins, syncAllowsSameOrigin, admissionProbeOf(req))
      const unavailability = syncUnavailabilityReasons()
      if (url.search.length > 0 || !originAllowed || unavailability.length > 0) {
        // Name the cause. "connection rejected" alone cannot tell an operator
        // whether a client sent a query string, arrived from an origin the
        // deployment never allowed, or hit a genuinely-down backend -- three
        // completely different fixes. The origin itself is NOT logged: it is
        // attacker-controlled input, and the boolean is the diagnostic.
        const rejection: SocketRejectionCode =
          url.search.length > 0 ? 'query-string-not-permitted' : !originAllowed ? 'origin-not-allowed' : 'unavailable'
        // Counted against the SAME closed cause the close reason names, through
        // the one map, so an operator reading the panel and a client reading a
        // 1008 are reading the same event. Nothing about WHICH client is kept.
        admissionRejections[SOCKET_REJECTION_COUNTERS[rejection]] += 1
        logRefusal(
          `[ws-sync] connection rejected: ${rejection}`,
          `connection:${rejection}:${unavailability.join()}`,
          unavailability.length > 0 ? { rejection, reasons: unavailability } : { rejection },
        )
        // The close reason names the cause too. One opaque 'sync unavailable'
        // for three different fixes left support unable to tell, from the
        // client side, an origin problem from a query string from a Redis
        // outage. Reason codes are stable identifiers, never input echoes.
        // A close reason is capped at 123 bytes by the protocol; every code
        // is ASCII, so a character slice is a byte slice.
        if (rejection === 'unavailable') {
          socket.close(1013, `sync-unavailable:${unavailability.join(',')}`.slice(0, 120))
        } else {
          socket.close(1008, rejection)
        }
        return
      }

      alive.set(socket, true)
      const ingressLimiter = new WebSocketIngressLimiter(syncIngressLimits)
      const fileIngressLimiter = new WebSocketIngressLimiter(syncFileIngressLimits)
      const handlerOptions = {
        socket,
        ownerId: randomUUID(),
        tickets: syncTickets,
        leases: syncLeases,
        socketBudget: syncSocketBudget,
        authorization: syncOptions!.authorization,
        backend: syncOptions!.backend,
        collaborationAuthorization: syncOptions!.collaborationAuthorization,
        collaborationRoomEpochResolver,
        // The handler's own refusals (a lease that outlived a crashed socket,
        // and whatever else it names) share the gateway's throttled logger;
        // without this they were computed and then dropped on the floor.
        logRefusal,
        // The one handshake outcome the gateway counts. The sink is the attach
        // closure, never this socket, so the count survives the reconnect it
        // exists to describe.
        onHandshakeRejected: (): void => {
          handshakeRejected += 1
        },
        apiRpc: syncOptions!.apiRpc,
        inviteEvents: socketInviteEvents,
        files: syncOptions!.files,
        requireSharedState: syncOptions!.requireSharedState,
        isEnabled: syncOptions!.isEnabled,
        metrics: syncOptions!.metrics,
        authDeadlineMs: syncOptions!.authDeadlineMs,
        backendTimeoutMs: syncOptions!.backendTimeoutMs,
        sessionRevalidationIntervalMs: syncOptions!.sessionRevalidationIntervalMs,
        socketMaxLifetimeMs: syncOptions!.socketMaxLifetimeMs,
        leaseRenewIntervalMs: syncOptions!.leaseRenewIntervalMs,
        socketBudgetRenewIntervalMs: syncOptions!.socketBudgetRenewIntervalMs,
      }
      const handler = new SyncCommandHandler(handlerOptions)
      syncHandlers.add(handler)

      const stopHandler = (): void => {
        handler.disconnect()
        void handler.stop().finally(() => syncHandlers.delete(handler))
      }

      socket.on('pong', () => {
        alive.set(socket, true)
      })
      socket.on('message', (data, isBinary) => {
        // Shutdown has begun: the command already in flight is being drained
        // and answered, but nothing new is admitted -- refusing here is what
        // bounds the drain. The socket is NOT closed on this path: closing runs
        // `stopHandler`, which aborts the very command the drain exists to
        // finish. The shutdown sweep closes it instead, with 1013 'draining'
        // rather than 1001 so this client knows to come back rather than that
        // the server is going away.
        if (stopping) {
          drainingRefusals.add(socket)
          return
        }
        const rawBytes = rawDataByteLength(data)
        const maxFrameBytes = isBinary ? MAX_FILE_BINARY_FRAME_BYTES : MAX_SYNC_FRAME_BYTES
        if (rawBytes > maxFrameBytes) {
          syncOptions!.metrics?.increment('protocol', 'FRAME_TOO_LARGE')
          stopHandler()
          socket.close(1009, isBinary ? 'file frame too large' : 'sync frame too large')
          return
        }
        // Two planes, two buckets. A 256 KiB file frame is bulk payload and must
        // not be charged to the command plane's 2 MiB/512 KiB-per-second budget,
        // which emptied after eight frames and killed the socket mid-upload. The
        // close reason and the metric code name WHICH plane overran, so an
        // operator reading the panel is not left guessing between a chatty client
        // and a file transfer.
        const planeLimiter = isBinary ? fileIngressLimiter : ingressLimiter
        if (!planeLimiter.tryConsume(rawBytes)) {
          syncOptions!.metrics?.increment('rate_limit', isBinary ? 'file_ingress' : 'ingress')
          stopHandler()
          // 1013, NOT 1008. A spent token bucket refills; the refusal is
          // TRANSIENT and the right client response is to back off and come
          // back. 1008 "policy violation" is what a generic client -- anything
          // that does not carry the reason string through, which is most
          // libraries and every browser devtools panel -- reads as a permanent
          // refusal of this credential or this origin, and the correct response
          // to that is to stop reconnecting. The bucket sizes themselves are
          // measured and tuned (`05eda115`/`8f5db2e3`/`1eb89820`); this is only
          // about what the close TELLS the client. The reason string is
          // unchanged, so the one consumer that does read it
          // (`syncCloseFallbackReason`, which keys 'rate limit' before it ever
          // looks at the code) classifies this exactly as it did before.
          socket.close(1013, isBinary ? 'file rate limit exceeded' : 'sync rate limit exceeded')
          return
        }
        alive.set(socket, true)
        if (isBinary) {
          handler.enqueueBinary(copyRawData(data), rawBytes)
        } else {
          handler.enqueue(data.toString(), rawBytes)
        }
      })
      socket.on('close', stopHandler)
      socket.on('error', (error) => {
        logger.warn('[ws-sync] socket error', safeErrorLogMetadata(error))
        stopHandler()
      })
      return
    }

    // Legacy client connects to: ws://host:PORT/sockets?authToken=<jwt>
    if (url.pathname !== LEGACY_SOCKET_PATH) {
      // The path is caller-controlled input and is not logged.
      logRefusal('[ws] connection rejected: unknown path', 'legacy:unknown-path')
      socket.close(1008, 'unknown path')
      return
    }
    const token = url.searchParams.get('authToken')

    // Every legacy refusal is throttled like the sync lane's: an
    // unauthenticated caller retrying in a loop must not drive log volume.
    if (!token) {
      logRefusal('[ws] connection rejected: missing authToken', 'legacy:missing-auth-token')
      socket.close(1008, 'missing authToken')
      return
    }

    let identity
    try {
      identity = verifyConnectionToken(token, config.connectionTokenSecret)
    } catch (err) {
      // `jwtError` is the stable cause: expired vs forged vs garbage were one
      // identical line before, because the redacted metadata collapses them.
      logRefusal('[ws] connection rejected: bad token', 'legacy:bad-token', {
        ...safeErrorLogMetadata(err),
        jwtError: classifyConnectionTokenError(err),
      })
      socket.close(1008, 'invalid authToken')
      return
    }

    if (registry.get(identity.userUuid).length >= maxConnectionsPerUser) {
      logRefusal('[ws] connection rejected: per-user limit', 'legacy:per-user-limit', {
        limit: maxConnectionsPerUser,
      })
      // 1013: a capacity refusal, not a policy one. This user holds as many
      // legacy connections as the deployment allows RIGHT NOW, and closing one
      // elsewhere makes the very same attempt succeed. The sync lane's twin
      // condition (`SOCKET_LIMIT`, 'Per-user sync socket limit exceeded.')
      // already closed 1013; the two lanes disagreeing about the same fact was
      // the whole defect.
      socket.close(1013, 'per-user connection limit exceeded')
      return
    }

    const conn: Conn<WebSocket> = {
      socket,
      userUuid: identity.userUuid,
      sessionUuid: identity.sessionUuid,
      connectionId: randomUUID(),
    }
    registry.add(identity.userUuid, conn)
    alive.set(socket, true)
    const ingressLimiter = new WebSocketIngressLimiter(ingressLimits)
    const relayBacklog = new WebSocketRelayBacklog(relayBacklogLimits)
    logger.info(`[ws] connect conn=${conn.connectionId} total=${registry.size()}`)

    let connectionClosed = false
    // Preserve frame order while async room authorization is in flight. Without
    // this queue, a yjs/comment frame arriving immediately after room-join could
    // race ahead of the authorization result, and a leave could race behind a
    // late successful join during provider teardown.
    let relayQueue = Promise.resolve()
    /**
     * Rooms this connection may still hold. `RoomRegistry` publishes no
     * per-connection room list, so track the rooms our own frames referenced
     * and confirm each against the registry before denying it. Pruned as every
     * frame settles, so it stays bounded by real membership plus the frames
     * still in flight.
     */
    const referencedRooms = new Set<string>()

    /**
     * Shed this connection's collaboration state without closing its socket
     * (R15). Each room it actually holds is denied with a stable reason, the
     * local memberships are dropped and the fleet-shared leases released, so
     * the client re-reserves deliberately instead of losing the whole socket --
     * which, on the legacy lane, is also its push, invite and MFA transport.
     */
    const evictRooms = (reason: RoomDeniedReason): void => {
      for (const room of referencedRooms) {
        if (!rooms.isMember(room, conn)) {
          continue
        }
        try {
          socket.send(JSON.stringify({ t: 'room-denied', room, reason }))
        } catch {
          /* socket unwritable; the membership is evicted regardless */
        }
      }
      referencedRooms.clear()
      rooms.leaveAll(conn)
      // A frame already queued may re-reserve behind us, so sweep again once
      // the backlog has drained -- the same two-phase shape `cleanup` uses.
      const release = (): Promise<void> => {
        rooms.leaveAll(conn)
        return collaborationPlane
          .releaseAll(conn)
          .catch((error) =>
            logger.warn('[ws] collaboration release after room eviction failed', safeErrorLogMetadata(error)),
          )
      }
      void release()
      void relayQueue.then(release, release)
    }

    const cleanup = (): void => {
      if (connectionClosed) {
        return
      }
      connectionClosed = true
      relayBacklog.clear()
      referencedRooms.clear()
      registry.remove(identity.userUuid, conn)
      rooms.leaveAll(conn)
      // A room authorizer may already be in flight. The handler observes the
      // closed flag and refuses the join; this final sweep is a second invariant
      // after every frame already queued for this connection has settled.
      void relayQueue.then(
        async () => {
          rooms.leaveAll(conn)
          await collaborationPlane.releaseAll(conn)
        },
        async () => {
          rooms.leaveAll(conn)
          await collaborationPlane.releaseAll(conn)
        },
      )
      logger.info(`[ws] disconnect conn=${conn.connectionId} total=${registry.size()}`)
    }

    socket.on('close', cleanup)
    socket.on('error', (err) => {
      logger.warn('[ws] socket error', safeErrorLogMetadata(err))
      cleanup()
    })

    socket.on('pong', () => {
      alive.set(socket, true)
    })

    socket.on('message', (data) => {
      if (connectionClosed) {
        return
      }
      const rawBytes = rawDataByteLength(data)
      if (!ingressLimiter.tryConsume(rawBytes)) {
        logRefusal('[ws] ingress rate exceeded', 'legacy:ingress-rate', { conn: conn.connectionId })
        cleanup()
        // 1013 for the same reason the sync lane's ingress limiter uses it: the
        // bucket refills, so this is "slow down and come back", never "this
        // client is refused".
        socket.close(1013, 'message rate limit exceeded')
        return
      }
      alive.set(socket, true)
      const raw = data.toString()
      if (raw === 'ping') {
        socket.send('pong')
        return
      }
      const frame = parseRelayFrame(raw)
      if (!frame) {
        // A frame the parser refused used to be dropped in total silence, so a
        // client blocked on `room-reserved`/`room-joined` spent its whole 10 s
        // timeout learning nothing -- which is how one protocol-version bump
        // cost two weeks of red CI (`cb0395ce`) and made the retry ladder
        // undiagnosable. Answer the two control frames a peer actually waits
        // on, and only those: `rejectedControlFrameIdentity` returns null for
        // the raw `'ping'` heartbeat, for JSON this lane does not own, and for
        // every relay type where a denial would be ignored or would tear down
        // a live room over one bad payload.
        const rejected = rejectedControlFrameIdentity(raw)
        if (rejected) {
          // The frame itself is attacker-controlled input and is NEVER logged
          // or echoed: not its bytes, not which field failed, not a parse
          // error. The reply carries the bounded room/requestId the client
          // correlates by (it ignores a denial that matches neither) plus one
          // code from the closed `RoomDeniedReason` set -- `'policy'`, the same
          // reason an `incompatible-protocol` lifecycle failure already maps to.
          // Reply volume is bounded by the ingress limiter consumed above.
          const reason: RoomDeniedReason = 'policy'
          logRefusal('[ws] malformed collaboration control frame denied', 'legacy:malformed-control-frame', {
            conn: conn.connectionId,
          })
          try {
            socket.send(
              JSON.stringify({
                t: 'room-denied',
                room: rejected.room,
                ...(rejected.requestId ? { requestId: rejected.requestId } : {}),
                reason,
              }),
            )
          } catch {
            /* socket unwritable; there is nothing left to tell this peer */
          }
        }
        return
      }
      if (!relayBacklog.tryEnqueue(rawBytes)) {
        logRefusal('[ws] relay backlog exceeded', 'legacy:relay-backlog', { conn: conn.connectionId })
        // R15: drop the frame and evict the rooms, but KEEP THE SOCKET. The
        // legacy socket also carries push, invite and MFA notifications, so
        // closing it over one collaboration burst took four unrelated lanes
        // down and left the client reconnecting with backoff. The backlog is
        // already >= the ingress burst, so reaching this is a genuinely
        // pathological producer, not a fast one.
        evictRooms('rate-limited')
        return
      }
      referencedRooms.add(frame.room)
      // handleRelayFrame is async (room-join may consult the membership
      // authorizer). Swallow rejections so a failing authorizer can never crash
      // the message handler / gateway; the authorizer itself already fails closed.
      relayQueue = relayQueue
        .then(() => {
          return connectionClosed
            ? 0
            : handleRelayFrame(rooms, conn, frame, roomAuthorizer, () => !connectionClosed, collaborationPlane)
        })
        .then(() => undefined)
        .catch((err) => {
          logger.warn('[ws] relay frame handling failed', safeErrorLogMetadata(err))
        })
        .finally(() => {
          relayBacklog.settle(rawBytes)
          if (!rooms.isMember(frame.room, conn)) {
            referencedRooms.delete(frame.room)
          }
        })
    })
  })

  // Periodic ping sweep: terminate sockets that didn't respond since last sweep.
  const heartbeat = setInterval(() => {
    for (const reservation of rooms.evictExpired()) {
      void collaborationPlane
        .releaseLease(reservation.conn, reservation.room, reservation.requestId)
        .catch((error) =>
          logger.warn('[ws] expired collaboration reservation cleanup failed', safeErrorLogMetadata(error)),
        )
    }
    void collaborationPlane.refreshLeases()
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        logger.warn('[ws] terminating dead socket')
        socket.terminate()
        continue
      }
      alive.set(socket, false)
      try {
        socket.ping()
      } catch {
        socket.terminate()
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  const pushBridgeOptions = {
    host: config.redisHost ?? '',
    port: config.redisPort,
    logger,
    ...(config.redisNamespace ? { channelPrefix: config.redisNamespace } : {}),
  }
  // No Redis client is opened in the in-process topology: the host publishes
  // by calling `dispatch` below, so subscribing to a channel nobody publishes
  // on would only produce reconnect noise and a permanently-unready bridge.
  const redis = sharedState === 'in-process' ? undefined : startRedisBridge(registry, pushBridgeOptions)

  let sqsHandle: SqsConsumerHandle | undefined
  if (config.sqs?.queueUrl) {
    sqsHandle = startSqsConsumer(registry, {
      queueUrl: config.sqs.queueUrl,
      endpoint: config.sqs.endpoint,
      region: config.sqs.region,
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
      logger,
      dedupStore: opts.sqsEventDedupStore,
      inviteRealtimeHandler: syncOptions?.inviteEventDispatcher
        ? new InviteRealtimeDomainEventHandler(syncOptions.inviteEventDispatcher)
        : undefined,
    })
  }

  const health = (): GatewayHealth => ({
    attached: true,
    // Honest rather than flattering: `'in-process'` is NOT `'redis'`, and the
    // admin diagnostics render the difference. `'none'` remains what an
    // attached gateway reports when it was pointed at the Redis plane with no
    // host to reach -- a real misconfiguration the panel raises a finding for.
    pushBridge: sharedState === 'in-process' ? 'in-process' : config.redisHost ? 'redis' : 'none',
    // An in-process bridge is ready by construction: delivery is a function
    // call into the same registry the Redis subscriber would have fed.
    pushBridgeReady: sharedState === 'in-process' || (redis as { status?: string } | undefined)?.status === 'ready',
    sqsConsumerRunning: sqsHandle?.running() ?? false,
    collaborationRelayHealthy: collaborationPlane.isRelayHealthy(),
    syncLane: syncAvailable() ? 'up' : 'down',
    pushesDispatched,
  })

  const admission = (probe: AdmissionProbe = {}): GatewayAdmission => ({
    // ABSENT IS NOT `false`. A caller that could not name an origin never
    // asked the question; this gateway answering "no" about a real one is a
    // conclusive fault with a finding behind it, and the two must not render
    // the same. An origin that is present but unparseable IS a no: that is
    // what the upgrade path does with it.
    ...(typeof probe.origin === 'string' && probe.origin.length > 0
      ? { originAdmitted: admitsProbeOrigin(syncAllowedOrigins, syncAllowsSameOrigin, probe) }
      : {}),
    // Rules, not list entries -- see `GatewayAdmission.allowedOriginCount`.
    // Combined here, once, beside the boolean that explains the extra rule, so
    // the count and the lane's own `no-allowed-origins` precondition cannot
    // drift into disagreeing about who is admitted.
    allowedOriginCount: boundedAdmissionCount(
      syncAllowedOrigins.size + (syncAllowsSameOrigin ? 1 : 0),
      MAX_REPORTED_ORIGIN_RULES,
    ),
    allowsSameOrigin: syncAllowsSameOrigin,
    liveSockets: boundedAdmissionCount(wss.clients.size, MAX_REPORTED_LIVE_SOCKETS),
    ticketsIssued: boundedAdmissionCount(ticketsIssued, MAX_REPORTED_ADMISSION_EVENTS),
    ticketsRefused: boundedAdmissionCount(ticketsRefused, MAX_REPORTED_ADMISSION_EVENTS),
    handshakeRejected: boundedAdmissionCount(handshakeRejected, MAX_REPORTED_ADMISSION_EVENTS),
    rejections: {
      originNotAllowed: boundedAdmissionCount(admissionRejections.originNotAllowed, MAX_REPORTED_ADMISSION_EVENTS),
      queryStringNotPermitted: boundedAdmissionCount(
        admissionRejections.queryStringNotPermitted,
        MAX_REPORTED_ADMISSION_EVENTS,
      ),
      unavailable: boundedAdmissionCount(admissionRejections.unavailable, MAX_REPORTED_ADMISSION_EVENTS),
    },
    // Asked fresh, from the handshake's own predicates. See the member's doc for
    // why a count and never the names, and why zero is the reading that matters.
    advertisableOperationCount: countAdvertisableOperations(syncOptions),
  })

  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise
    }
    stopPromise = (async () => {
      stopping = true
      clearInterval(heartbeat)
      sqsHandle?.stop()

      // R1: a command already accepted from a client is finished and ANSWERED
      // before its socket is closed. `handler.stop()` disconnects first, which
      // aborts the active command -- so shutting down mid-`SYNC_ITEMS` used to
      // drop the answer on the floor even though the write had committed, and
      // the client could only learn the outcome by replaying over HTTP. New
      // frames are already refused (`stopping` above), so this is bounded by
      // the backend timeout and by the drain deadline below.
      await settleWithin(
        Promise.allSettled([...syncHandlers].map((handler) => handler.drain())),
        syncOptions?.backendTimeoutMs ?? SYNC_BACKEND_TIMEOUT_MS,
      )

      const websocketClosed = new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(forceTerminate)
          clearTimeout(giveUp)
          resolve()
        }
        const forceTerminate = setTimeout(() => {
          for (const socket of wss.clients) {
            socket.terminate()
          }
        }, 250)
        const giveUp = setTimeout(() => {
          for (const socket of wss.clients) {
            socket.terminate()
          }
          finish()
        }, 2_000)
        forceTerminate.unref()
        giveUp.unref()
        try {
          wss.close(finish)
        } catch {
          finish()
        }
        for (const socket of wss.clients) {
          try {
            if (drainingRefusals.has(socket)) {
              socket.close(1013, 'draining')
            } else {
              socket.close(1001, 'server shutting down')
            }
          } catch {
            socket.terminate()
          }
        }
      })

      await settleWithin(
        Promise.allSettled([...ticketOperations, ...[...syncHandlers].map((handler) => handler.stop())]),
        2_000,
      )
      await settleWithin(Promise.resolve(syncTickets.clear?.()), 1_000)
      await websocketClosed

      if (redis && !(await settleWithin(redis.quit(), 1_500))) {
        redis.disconnect()
      }
      await settleWithin(collaborationPlane.stop(), 4_000)
      // The last window is the shutdown's own -- disconnects, refusals, the
      // drain's outcome. Aggregation must not be the reason it is never written.
      // Duck-typed: a composition root may pass any SyncCommandMetrics.
      ;(syncOptions?.metrics as Partial<AggregatingSyncCommandMetrics> | undefined)?.close?.()
    })()
    return stopPromise
  }

  return {
    registry,
    rooms,
    handleMintToken,
    dispatch: (message: DispatchMessage): number => dispatchToRegistry(registry, message),
    sync,
    health,
    admission,
    stop,
  }
}

export * from './syncProtocol.js'
export { createLogThrottle } from './logThrottle.js'
export type { LogThrottle, LogThrottleDecision, LogThrottleOptions } from './logThrottle.js'
export {
  createConsoleLogger,
  isLevelEnabled,
  resolveLogLevel,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  type ConsoleLoggerOptions,
  type ConsoleLoggerSink,
  type LogLevelName,
} from './logger.js'
export type { Logger } from './redisBridge.js'
// Standard Red Notes: the ONE stale/revoked classification, exported so every
// lane that revalidates a session credential (sync REAUTH, collaboration
// authorization, FILES_V1 authorization) shares a single table instead of
// growing its own.
export { classifyPresentedSessionCredential, credentialCanAuthenticateSession } from './syncCommandHandler.js'
// The periodic-revalidation bounds, exported so a host or a live probe can
// state the figure it is relying on instead of duplicating it.
export { SYNC_SESSION_REVALIDATION_INTERVAL_MS, SYNC_SOCKET_MAX_LIFETIME_MS } from './syncCommandHandler.js'
export type {
  PresentedSessionCredentialOutcome,
  SyncAuthorizationCode,
  SyncAuthorizationDecision,
  SyncAuthorizationInput,
  SyncBackendCommandInput,
  SyncBackendCommit,
  SyncBackendStatus,
  SyncCommandBackendAdapter,
  SyncApiRpcAdapter,
  SyncApiRpcRequest,
  SyncApiRpcResponse,
  SyncCollaborationAuthorizationAdapter,
  SyncCollaborationAuthorizationResult,
  SyncInviteEventsAdapter,
  SyncInviteEventReplay,
  SyncLiveAuthorizationAdapter,
  SyncSessionRefreshDecision,
} from './syncCommandHandler.js'
export type { SyncTicketIdentity } from './auth.js'
export {
  classifyConnectionTokenError,
  DEFAULT_CONNECTION_TOKEN_TTL,
  GatewayConfigurationError,
  MAX_CONNECTIONS_PER_USER_CEILING,
  parseConnectionTokenTtl,
  parseMaxConnectionsPerUser,
  parseRedisNamespace,
  isValidSyncTicketIdentity,
  SESSION_ACCESS_TOKEN_COOKIE_PREFIX,
  syncTicketIdentitySecretValues,
} from './auth.js'
export type { ConnectionTokenErrorClass } from './auth.js'
export {
  RedisSyncAuthTicketStore,
  RedisSyncCommandLeaseRegistry,
  RedisSyncSocketBudget,
  createRedisSyncState,
} from './syncRedisState.js'
export type { RedisSyncState, RedisSyncStateOptions, SyncRedisClient } from './syncRedisState.js'
export type { SyncAuthTicketStore } from './auth.js'
export type { SyncCommandLeaseRegistry, SyncSocketBudget } from './registry.js'
// The payload a host hands to `AttachedGateway.dispatch` (C16).
export type { Conn, DispatchMessage } from './registry.js'
export {
  InProcessCollaborationLifecycle,
  IN_PROCESS_ROOM_EPOCH_TOMBSTONE_TTL_MS,
  type CollaborationPlane,
  type InProcessCollaborationLifecycleOptions,
} from './inProcessCollaborationLifecycle.js'
export {
  createInProcessInviteEventComposition,
  InProcessInviteEventAvailabilityBus,
  InProcessInviteEventsAdapter,
  type InProcessInviteEventComposition,
} from './inProcessInviteEventAvailability.js'
export { InMemoryInviteEventStore, RedisInviteEventStore } from './inviteEventStore.js'
export type { InMemoryInviteEventStoreOptions } from './inviteEventStore.js'
export type { InviteEventStore, RedisInviteEventClient, RedisInviteEventStoreOptions } from './inviteEventStore.js'
export { RedisInviteEventAvailabilityBus, SharedInviteEventsAdapter } from './inviteEventAvailability.js'
export type {
  InviteEventAvailabilityBus,
  RedisInviteEventPublisher,
  RedisInviteEventSubscriber,
} from './inviteEventAvailability.js'
export { createSharedInviteEventComposition } from './inviteEventComposition.js'
export type { SharedInviteEventComposition } from './inviteEventComposition.js'
export { createSyncFilesTokenDecoder, SyncFilesSession } from './filesSession.js'
export type {
  SyncFilesAdapter,
  SyncFilesControlFrame,
  SyncFilesSessionOptions,
  SyncFilesSignedTokenDecoder,
} from './filesSession.js'
// Exported so a storage adapter's own package can drive the real file session
// with real wire frames, instead of asserting against the adapter interface in
// isolation and hoping the two halves meet.
export { decodeFileBinaryFrame, encodeFileBinaryFrame, sha256Hex, MAX_FILE_CHUNK_BYTES } from './filesProtocol.js'
export type { FileBinaryHeader, FileResourceReference } from './filesProtocol.js'
export {
  createInviteRealtimeDomainEventBridge,
  INVITE_REALTIME_DOMAIN_EVENT_TYPE,
  type InviteRealtimeDomainEventBridge,
  type InviteRealtimeSubscriberFactory,
} from './inviteEventDomainEventBridge.js'
export {
  createRedisSqsEventDedupStore,
  createInMemorySqsEventDedupStore,
  namespacedDedupPrefix,
  domainEventToDispatch,
  DEFAULT_SQS_DEDUP_KEY_PREFIX,
} from './sqsConsumer.js'
export type { SqsConsumerHandle, SqsConsumerOptions } from './sqsConsumer.js'
// One namespace rule for every host: derive channel and key names from these
// rather than mirroring the `<ns>:<original>` convention by hand.
export {
  applyRedisNamespace,
  namespacedPushChannel,
  REDIS_NAMESPACE_PATTERN,
  WEBSOCKET_MESSAGES_CHANNEL,
} from './redisBridge.js'
export type { PushDispatchedHook, RedisBridgeOptions } from './redisBridge.js'
export { InviteEventConfigurationError, inviteEventStoreKeyPrefix } from './inviteEventStore.js'
export { inviteAvailabilityChannelPrefix } from './inviteEventAvailability.js'
export type { RedisInviteEventAvailabilityBusOptions } from './inviteEventAvailability.js'
export type {
  InMemorySqsEventDedupOptions,
  RedisSqsEventDedupClient,
  RedisSqsEventDedupOptions,
  SqsEventDedupDecision,
  SqsEventDedupStore,
} from './sqsConsumer.js'
