import { type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  decodeCrossServiceToken,
  InMemorySyncAuthTicketStore,
  mintConnectionToken,
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
import { MAX_SYNC_FRAME_BYTES, SYNC_PROTOCOL_VERSION, isSyncDeviceId } from './syncProtocol.js'

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
  /** Dynamic kill switch, checked during negotiation and before every frame. */
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
  | 'durable-backend-unavailable'
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
  get?(path: string, handler: (...args: any[]) => void): unknown
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

export interface AttachedGateway {
  registry: ConnectionRegistry<WebSocket>
  rooms: RoomRegistry<WebSocket>
  /** POST /sockets/tokens handler, exposed for callers that own their own http server. */
  handleMintToken(req: IncomingMessage, res: ServerResponse): void
  handleSyncTicket(req: IncomingMessage, res: ServerResponse): void
  handleSyncCapabilities(_req: IncomingMessage, res: ServerResponse): void
  sync: SyncGatewayAccess
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
      logger.info(`[token] minted (x-auth) user=${identity.userUuid}`)
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
  logger.info(`[token] minted user=${userUuid}`)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ token }))
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
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

function readBoundedJsonBody(
  req: IncomingMessage,
  maximumBytes = 16_384,
): Promise<Record<string, unknown> | undefined> {
  const parsedBody = (req as { body?: unknown }).body
  if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
    return Promise.resolve(parsedBody as Record<string, unknown>)
  }
  return new Promise((resolve) => {
    let bytes = 0
    let body = ''
    let settled = false
    req.on('data', (chunk: Buffer | string) => {
      if (settled) {
        return
      }
      bytes += Buffer.byteLength(chunk)
      if (bytes > maximumBytes) {
        settled = true
        resolve(undefined)
        return
      }
      body += chunk.toString()
    })
    req.on('end', () => {
      if (settled) {
        return
      }
      settled = true
      try {
        const parsed = body ? (JSON.parse(body) as unknown) : {}
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined,
        )
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => {
      if (!settled) {
        settled = true
        resolve(undefined)
      }
    })
  })
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
  const { httpServer, config, logger, app, authorizeRoomJoin } = opts

  if (!config.connectionTokenSecret) {
    throw new Error('WEB_SOCKET_CONNECTION_TOKEN_SECRET is required (refusing to attach with an empty signing secret).')
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
  if (!Number.isSafeInteger(maxConnectionsPerUser) || maxConnectionsPerUser < 1) {
    throw new Error('Invalid WebSocket per-user connection limit: expected a positive safe integer.')
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
    if (!syncOptions.authorization.ready()) {
      reasons.push('authorization-adapter-unavailable')
    }
    if (!syncOptions.backend.ready()) {
      reasons.push('durable-backend-unavailable')
    }
    if (syncOptions.requireSharedState && !syncOptions.inviteEvents?.ready()) {
      reasons.push('invite-event-store-unavailable')
    }
    return reasons
  }
  const syncAvailable = (): boolean => syncUnavailabilityReasons().length === 0
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
        throw new Error('WebSocket sync is unavailable.')
      }
      const operation = syncTickets.issue(identity)
      ticketOperations.add(operation)
      try {
        const issued = await operation
        if (stopping) {
          throw new Error('WebSocket sync is stopping.')
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

  const registry = new ConnectionRegistry<WebSocket>()
  const rooms = new RoomRegistry<WebSocket>()
  const alive = new WeakMap<WebSocket, boolean>()
  const syncHandlers = new Set<SyncCommandHandler>()

  const handleMintToken = buildMintTokenHandler(config, logger)
  const handleSyncCapabilities = (_req: IncomingMessage, res: ServerResponse): void => {
    writeJson(res, 200, sync.capabilities())
  }
  const handleSyncTicket = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const unavailability = syncUnavailabilityReasons()
      if (unavailability.length > 0) {
        logSyncRefusal('ticket refused', unavailability)
        writeJson(res, 503, { error: { code: 'SYNC_DISABLED' } })
        return
      }
      const body = await readBoundedJsonBody(req)
      if (!body || !isSyncDeviceId(body.deviceId)) {
        logRefusal('[ws-sync] ticket refused: unreadable body or invalid deviceId', 'ticket:invalid-device')
        writeJson(res, 400, { error: { code: 'INVALID_DEVICE' } })
        return
      }

      let identity: Omit<SyncTicketIdentity, 'deviceId'> | undefined
      const xAuthToken = req.headers['x-auth-token']
      if (typeof xAuthToken === 'string' && xAuthToken.length > 0 && config.authJwtSecret) {
        identity = decodeCrossServiceToken(xAuthToken, config.authJwtSecret)
      } else if (config.internalSecret && secretsMatch(req.headers['x-internal-secret'], config.internalSecret)) {
        if (
          typeof body.userUuid === 'string' &&
          body.userUuid.length > 0 &&
          typeof body.sessionUuid === 'string' &&
          body.sessionUuid.length > 0
        ) {
          identity = { userUuid: body.userUuid, sessionUuid: body.sessionUuid }
        }
      }
      if (!identity) {
        logRefusal(
          '[ws-sync] ticket refused: neither a decodable x-auth-token nor a matching internal secret with a body identity',
          'ticket:auth-rejected',
        )
        writeJson(res, 401, { error: { code: 'AUTH_REJECTED' } })
        return
      }
      try {
        writeJson(res, 200, await sync.issueTicket({ ...identity, deviceId: body.deviceId }))
      } catch (error) {
        // issueTicket already logged the precondition list when it refused; this
        // covers a ticket store that threw while otherwise reporting ready.
        logRefusal('[ws-sync] ticket issuance failed', 'ticket:issue-failed', safeErrorLogMetadata(error))
        writeJson(res, 503, { error: { code: 'SYNC_DISABLED' } })
      }
    })()
  }
  if (app) {
    app.post('/sockets/tokens', handleMintToken)
    app.post('/sockets/sync/tickets', handleSyncTicket)
    app.get?.('/sockets/sync/capabilities', handleSyncCapabilities)
  }

  // This is intentionally enforced by `ws`, before the application-level
  // `message` event and JSON parser can observe or retain an oversized frame.
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
    perMessageDeflate: false,
  })
  const collaborationRedis = startCollaborationRedisBridge(rooms, {
    host: config.redisHost,
    port: config.redisPort,
    logger,
  })

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
        socket.close(unavailability.length === 0 ? 1008 : 1013, 'sync unavailable')
        return
      }

      alive.set(socket, true)
      const ingressLimiter = new WebSocketIngressLimiter(syncIngressLimits)
      const handler = new SyncCommandHandler({
        socket,
        ownerId: randomUUID(),
        tickets: syncTickets,
        leases: syncLeases,
        socketBudget: syncSocketBudget,
        authorization: syncOptions!.authorization,
        backend: syncOptions!.backend,
        collaborationAuthorization: syncOptions!.collaborationAuthorization,
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
      })
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

    // Legacy client connects to: ws://host:PORT/?authToken=<jwt>
    const token = url.searchParams.get('authToken')

    if (!token) {
      logger.warn('[ws] connection rejected: missing authToken')
      socket.close(1008, 'missing authToken')
      return
    }

    let identity
    try {
      identity = verifyConnectionToken(token, config.connectionTokenSecret)
    } catch (err) {
      logger.warn('[ws] connection rejected: bad token', safeErrorLogMetadata(err))
      socket.close(1008, 'invalid authToken')
      return
    }

    if (registry.get(identity.userUuid).length >= maxConnectionsPerUser) {
      logger.warn(`[ws] connection rejected: per-user limit user=${identity.userUuid}`)
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
    logger.info(`[ws] connect user=${identity.userUuid} conn=${conn.connectionId} total=${registry.size()}`)

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
      logger.info(`[ws] disconnect user=${identity.userUuid} conn=${conn.connectionId} total=${registry.size()}`)
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
        logger.warn(`[ws] ingress rate exceeded user=${identity.userUuid} conn=${conn.connectionId}`)
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
          logger.warn(`[ws] relay backlog exceeded user=${identity.userUuid} conn=${conn.connectionId}`)
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

  const redis = startRedisBridge(registry, {
    host: config.redisHost,
    port: config.redisPort,
    logger,
  })

  let stopSqs: (() => void) | undefined
  if (config.sqs?.queueUrl) {
    stopSqs = startSqsConsumer(registry, {
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

  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise
    }
    stopPromise = (async () => {
      stopping = true
      clearInterval(heartbeat)
      stopSqs?.()

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

  return { registry, rooms, handleMintToken, handleSyncTicket, handleSyncCapabilities, sync, stop }
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
