import { type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { decodeCrossServiceToken, mintConnectionToken, verifyConnectionToken, verifyRoomCapability } from './auth.js'
import { ConnectionRegistry, type Conn } from './registry.js'
import { RoomRegistry, parseRelayFrame, handleRelayFrame, type RoomJoinAuthorizer } from './rooms.js'
import { startRedisBridge, type Logger } from './redisBridge.js'
import { startSqsConsumer } from './sqsConsumer.js'

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  post(path: string, handler: (...args: any[]) => void): unknown
}

export interface AttachOptions {
  httpServer: HttpServer
  config: GatewayConfig
  logger: Logger
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
}

export interface AttachedGateway {
  registry: ConnectionRegistry<WebSocket>
  rooms: RoomRegistry<WebSocket>
  /** POST /sockets/tokens handler, exposed for callers that own their own http server. */
  handleMintToken(req: IncomingMessage, res: ServerResponse): void
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
  return function handleMintToken(req: IncomingMessage, res: ServerResponse): void {
    const xAuthToken = req.headers['x-auth-token']
    if (typeof xAuthToken === 'string' && xAuthToken.length > 0) {
      const identity = config.authJwtSecret
        ? decodeCrossServiceToken(xAuthToken, config.authJwtSecret)
        : undefined
      if (!identity) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid auth token' }))
        return
      }
      const token = mintConnectionToken(identity, config.connectionTokenSecret, config.connectionTokenTtl)
      logger.info(`[token] minted (x-auth) user=${identity.userUuid} session=${identity.sessionUuid}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token }))
      return
    }

    // Internal path: fail CLOSED when no internal secret is configured.
    if (!config.internalSecret) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal token minting is disabled (no internal secret configured)' }))
      return
    }
    const provided = req.headers['x-internal-secret']
    // Constant-time compare so the internal secret cannot be recovered byte by
    // byte via response-timing analysis. Fails closed for missing/array headers.
    if (!secretsMatch(provided, config.internalSecret)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }

    // The api-gateway parses JSON bodies before this handler runs, so prefer an
    // already-parsed body when present; otherwise read the raw stream (standalone).
    const parsedBody = (req as { body?: unknown }).body
    if (parsedBody && typeof parsedBody === 'object') {
      mintFromBody(parsedBody as Record<string, unknown>, config, logger, res)
      return
    }

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 16_384) {
        req.destroy()
      }
    })
    req.on('end', () => {
      let parsed: Record<string, unknown>
      try {
        parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid json body' }))
        return
      }
      mintFromBody(parsed, config, logger, res)
    })
  }
}

function mintFromBody(
  parsed: Record<string, unknown>,
  config: GatewayConfig,
  logger: Logger,
  res: ServerResponse,
): void {
  const userUuid = parsed.userUuid
  const sessionUuid = parsed.sessionUuid
  if (typeof userUuid !== 'string' || typeof sessionUuid !== 'string' || !userUuid || !sessionUuid) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'userUuid and sessionUuid are required' }))
    return
  }
  const token = mintConnectionToken({ userUuid, sessionUuid }, config.connectionTokenSecret, config.connectionTokenTtl)
  logger.info(`[token] minted user=${userUuid} session=${sessionUuid}`)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ token }))
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
  return (userUuid: string, room: string, capability?: string): boolean =>
    verifyRoomCapability(capability, connectionTokenSecret, userUuid, room)
}

export function attachWebSocketGateway(opts: AttachOptions): AttachedGateway {
  const { httpServer, config, logger, app, authorizeRoomJoin } = opts

  if (!config.connectionTokenSecret) {
    throw new Error(
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET is required (refusing to attach with an empty signing secret).',
    )
  }

  // SECURITY: default to a capability-verifying authorizer (fail closed). A caller
  // may override (tests), but production never gets allow-all: an absent override
  // still requires a valid, matching, unexpired room capability on every join.
  const roomAuthorizer: RoomJoinAuthorizer = authorizeRoomJoin ?? defaultRoomJoinAuthorizer(config.connectionTokenSecret)

  const registry = new ConnectionRegistry<WebSocket>()
  const rooms = new RoomRegistry<WebSocket>()
  const alive = new WeakMap<WebSocket, boolean>()

  const handleMintToken = buildMintTokenHandler(config, logger)
  if (app) {
    app.post('/sockets/tokens', handleMintToken)
  }

  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    // Client connects to: ws://host:PORT/?authToken=<jwt>
    const url = new URL(req.url ?? '/', 'http://localhost')
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
      logger.warn('[ws] connection rejected: bad token', err instanceof Error ? err.message : err)
      socket.close(1008, 'invalid authToken')
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
    logger.info(
      `[ws] connect user=${identity.userUuid} session=${identity.sessionUuid} ` +
        `conn=${conn.connectionId} total=${registry.size()}`,
    )

    const cleanup = (): void => {
      registry.remove(identity.userUuid, conn)
      rooms.leaveAll(conn)
      logger.info(
        `[ws] disconnect user=${identity.userUuid} conn=${conn.connectionId} total=${registry.size()}`,
      )
    }

    socket.on('close', cleanup)
    socket.on('error', (err) => {
      logger.warn('[ws] socket error', err instanceof Error ? err.message : err)
      cleanup()
    })

    socket.on('pong', () => {
      alive.set(socket, true)
    })

    socket.on('message', (data) => {
      alive.set(socket, true)
      const raw = data.toString()
      if (raw === 'ping') {
        socket.send('pong')
        return
      }
      const frame = parseRelayFrame(raw)
      if (frame) {
        // handleRelayFrame is async (room-join may consult the membership
        // authorizer). Swallow rejections so a failing authorizer can never crash
        // the message handler / gateway; the authorizer itself already fails closed.
        void handleRelayFrame(rooms, conn, frame, roomAuthorizer).catch((err) => {
          logger.warn('[ws] relay frame handling failed', err instanceof Error ? err.message : err)
        })
      }
    })
  })

  // Periodic ping sweep: terminate sockets that didn't respond since last sweep.
  const heartbeat = setInterval(() => {
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
    })
  }

  const stop = async (): Promise<void> => {
    clearInterval(heartbeat)
    for (const socket of wss.clients) socket.close(1001, 'server shutting down')
    wss.close()
    stopSqs?.()
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
  }

  return { registry, rooms, handleMintToken, stop }
}
