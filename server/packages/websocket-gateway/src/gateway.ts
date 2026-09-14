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
  type Conn,
  type SyncCommandLeaseRegistry,
  type SyncSocketBudget,
} from './registry.js'
import { RoomRegistry, parseRelayFrame, handleRelayFrame, type RoomJoinAuthorizer } from './rooms.js'
import { startRedisBridge, type Logger } from './redisBridge.js'
import { startCollaborationRedisBridge } from './collaborationRedisBridge.js'
import { createLogThrottle, type LogThrottle } from './logThrottle.js'
import { safeErrorLogMetadata } from './safeLog.js'
import { startSqsConsumer, type SqsEventDedupStore } from './sqsConsumer.js'
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
import { MAX_SYNC_FRAME_BYTES, SYNC_PROTOCOL_VERSION } from './syncProtocol.js'

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
  authDeadlineMs?: number
  backendTimeoutMs?: number
  leaseRenewIntervalMs?: number
  socketBudgetRenewIntervalMs?: number
}

/**
 * Production-safe sync telemetry adapter. Keeping the payload as one compact
 * JSON value preserves its fields through the minimal variadic logger bridge
 * used by both api-gateway and home-server.
 */
export function createLoggerSyncCommandMetrics(logger: Pick<Logger, 'info'>): SyncCommandMetrics {
  return {
    increment(event, code) {
      logger.info('[ws-sync-metric]', JSON.stringify(code === undefined ? { event } : { event, code }))
    },
  }
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
  frameCapacity: 128,
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
  redisHost: string
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
  sync: SyncGatewayAccess
  /** A point-in-time, side-effect-free snapshot; cheap enough to call per readiness probe. */
  health(): GatewayHealth
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
 */
function isSameOriginUpgrade(request: IncomingMessage, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  const rawHost = request.headers.host
  if (typeof rawHost !== 'string' || rawHost.length === 0) {
    return false
  }
  const forwarded = request.headers['x-forwarded-proto']
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded
  let effectiveProtocol: 'http:' | 'https:'
  if (forwardedValue !== undefined) {
    const forwardedProtocols = forwardedValue.split(',').map((value) => value.trim().toLowerCase())
    if (forwardedProtocols.length !== 1 || (forwardedProtocols[0] !== 'http' && forwardedProtocols[0] !== 'https')) {
      return false
    }
    effectiveProtocol = `${forwardedProtocols[0]}:`
  } else {
    effectiveProtocol = (request.socket as { encrypted?: boolean }).encrypted === true ? 'https:' : 'http:'
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
  return parsed.origin === target.origin
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
  if (syncOptions?.requireSharedState && !syncOptions.files && !syncOptions.filesUnsupported) {
    throw new Error('WebSocket sync requires a FILES_V1 storage adapter, or an explicit filesUnsupported declaration.')
  }
  const syncIngressLimits: WebSocketIngressLimits = {
    ...DEFAULT_SYNC_WEBSOCKET_INGRESS_LIMITS,
    ...syncOptions?.ingressLimits,
  }
  assertValidIngressLimits(syncIngressLimits)
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
        return {
          ticket: issued.ticket,
          expiresAt: issued.expiresAt,
          endpoint: SYNC_SOCKET_PATH,
          capability: SYNC_CAPABILITY_ID,
          version: SYNC_PROTOCOL_VERSION,
        }
      } finally {
        ticketOperations.delete(operation)
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
    host: config.redisHost,
    port: config.redisPort,
    logger,
    ...(config.redisNamespace ? { keyPrefix: `${config.redisNamespace}:` } : {}),
  }
  const collaborationRedis = startCollaborationRedisBridge(rooms, collaborationBridgeOptions)
  // The fleet-shared room state is the only place a rotated epoch lives, so
  // the bridge is the default resolver. Guarded structurally: the method is
  // added to the bridge in this same wave, and until then (or on a test
  // double without it) discovery keeps answering the initial epoch.
  const bridgeEpochs = collaborationRedis as unknown as {
    currentRoomEpoch?: (room: string, collaborationSecurityEpoch: string) => Promise<string | undefined>
  }
  const collaborationRoomEpochResolver: SyncGatewayOptions['collaborationRoomEpochResolver'] =
    syncOptions?.collaborationRoomEpochResolver ??
    (typeof bridgeEpochs.currentRoomEpoch === 'function'
      ? (room, collaborationSecurityEpoch) => bridgeEpochs.currentRoomEpoch!(room, collaborationSecurityEpoch)
      : undefined)

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === SYNC_SOCKET_PATH) {
      const origin = req.headers.origin
      const originAllowed =
        typeof origin === 'string' &&
        (syncAllowedOrigins.has(origin) || (syncAllowsSameOrigin && isSameOriginUpgrade(req, origin)))
      const unavailability = syncUnavailabilityReasons()
      if (url.search.length > 0 || !originAllowed || unavailability.length > 0) {
        // Name the cause. "connection rejected" alone cannot tell an operator
        // whether a client sent a query string, arrived from an origin the
        // deployment never allowed, or hit a genuinely-down backend -- three
        // completely different fixes. The origin itself is NOT logged: it is
        // attacker-controlled input, and the boolean is the diagnostic.
        const rejection =
          url.search.length > 0 ? 'query-string-not-permitted' : !originAllowed ? 'origin-not-allowed' : 'unavailable'
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
        apiRpc: syncOptions!.apiRpc,
        inviteEvents: syncOptions!.inviteEvents,
        files: syncOptions!.files,
        requireSharedState: syncOptions!.requireSharedState,
        isEnabled: syncOptions!.isEnabled,
        metrics: syncOptions!.metrics,
        authDeadlineMs: syncOptions!.authDeadlineMs,
        backendTimeoutMs: syncOptions!.backendTimeoutMs,
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
        const rawBytes = rawDataByteLength(data)
        const maxFrameBytes = isBinary ? MAX_FILE_BINARY_FRAME_BYTES : MAX_SYNC_FRAME_BYTES
        if (rawBytes > maxFrameBytes) {
          syncOptions!.metrics?.increment('protocol', 'FRAME_TOO_LARGE')
          stopHandler()
          socket.close(1009, isBinary ? 'file frame too large' : 'sync frame too large')
          return
        }
        if (!ingressLimiter.tryConsume(rawBytes)) {
          syncOptions!.metrics?.increment('rate_limit', 'ingress')
          stopHandler()
          socket.close(1008, 'sync rate limit exceeded')
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
      socket.close(1008, 'per-user connection limit exceeded')
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

    const cleanup = (): void => {
      if (connectionClosed) {
        return
      }
      connectionClosed = true
      relayBacklog.clear()
      registry.remove(identity.userUuid, conn)
      rooms.leaveAll(conn)
      // A room authorizer may already be in flight. The handler observes the
      // closed flag and refuses the join; this final sweep is a second invariant
      // after every frame already queued for this connection has settled.
      void relayQueue.then(
        async () => {
          rooms.leaveAll(conn)
          await collaborationRedis.releaseAll(conn)
        },
        async () => {
          rooms.leaveAll(conn)
          await collaborationRedis.releaseAll(conn)
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
        socket.close(1008, 'message rate limit exceeded')
        return
      }
      alive.set(socket, true)
      const raw = data.toString()
      if (raw === 'ping') {
        socket.send('pong')
        return
      }
      const frame = parseRelayFrame(raw)
      if (frame) {
        if (!relayBacklog.tryEnqueue(rawBytes)) {
          logRefusal('[ws] relay backlog exceeded', 'legacy:relay-backlog', { conn: conn.connectionId })
          cleanup()
          try {
            socket.close(1008, 'relay backlog exceeded')
          } catch {
            /* cleanup already removed all connection state */
          }
          return
        }
        // handleRelayFrame is async (room-join may consult the membership
        // authorizer). Swallow rejections so a failing authorizer can never crash
        // the message handler / gateway; the authorizer itself already fails closed.
        relayQueue = relayQueue
          .then(() => {
            return connectionClosed
              ? 0
              : handleRelayFrame(rooms, conn, frame, roomAuthorizer, () => !connectionClosed, collaborationRedis)
          })
          .then(() => undefined)
          .catch((err) => {
            logger.warn('[ws] relay frame handling failed', safeErrorLogMetadata(err))
          })
          .finally(() => {
            relayBacklog.settle(rawBytes)
          })
      }
    })
  })

  // Periodic ping sweep: terminate sockets that didn't respond since last sweep.
  const heartbeat = setInterval(() => {
    for (const reservation of rooms.evictExpired()) {
      void collaborationRedis
        .releaseLease(reservation.conn, reservation.room, reservation.requestId)
        .catch((error) =>
          logger.warn('[ws] expired collaboration reservation cleanup failed', safeErrorLogMetadata(error)),
        )
    }
    void collaborationRedis.refreshLeases()
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
    host: config.redisHost,
    port: config.redisPort,
    logger,
    ...(config.redisNamespace ? { channelPrefix: `${config.redisNamespace}:` } : {}),
  }
  const redis = startRedisBridge(registry, pushBridgeOptions)

  // The consumer's stop handle is either the bare stop function or, once it
  // reports its own state, `{ stop, running }`; both shapes are honoured.
  let sqsHandle: unknown
  const sqsConsumerRunning = (): boolean => {
    if (sqsHandle === undefined) {
      return false
    }
    const handle = sqsHandle as { running?: () => boolean }
    return typeof handle.running === 'function' ? handle.running() : !stopping
  }
  const stopSqs = (): void => {
    const handle = sqsHandle as (() => void) | { stop(): void } | undefined
    if (typeof handle === 'function') {
      handle()
    } else {
      handle?.stop()
    }
  }
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

  const health = (): GatewayHealth => {
    const relay = collaborationRedis as unknown as { isRelayHealthy?: () => boolean }
    return {
      attached: true,
      pushBridge: config.redisHost ? 'redis' : 'none',
      pushBridgeReady: (redis as { status?: string }).status === 'ready',
      sqsConsumerRunning: sqsConsumerRunning(),
      collaborationRelayHealthy: typeof relay.isRelayHealthy === 'function' ? relay.isRelayHealthy() : false,
      syncLane: syncAvailable() ? 'up' : 'down',
      pushesDispatched,
    }
  }

  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise
    }
    stopPromise = (async () => {
      stopping = true
      clearInterval(heartbeat)
      stopSqs()

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
            socket.close(1001, 'server shutting down')
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

      if (!(await settleWithin(redis.quit(), 1_500))) {
        redis.disconnect()
      }
      await settleWithin(collaborationRedis.stop(), 4_000)
    })()
    return stopPromise
  }

  return { registry, rooms, handleMintToken, sync, health, stop }
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
export type {
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
} from './syncCommandHandler.js'
export type { SyncTicketIdentity } from './auth.js'
export {
  classifyConnectionTokenError,
  DEFAULT_CONNECTION_TOKEN_TTL,
  MAX_CONNECTIONS_PER_USER_CEILING,
  parseConnectionTokenTtl,
  parseMaxConnectionsPerUser,
  parseRedisNamespace,
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
export { RedisInviteEventStore } from './inviteEventStore.js'
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
export { createRedisSqsEventDedupStore, createInMemorySqsEventDedupStore } from './sqsConsumer.js'
export type {
  InMemorySqsEventDedupOptions,
  RedisSqsEventDedupClient,
  RedisSqsEventDedupOptions,
  SqsEventDedupDecision,
  SqsEventDedupStore,
} from './sqsConsumer.js'
