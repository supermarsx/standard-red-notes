import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { mintConnectionToken, verifyConnectionToken } from './auth.js'
import { ConnectionRegistry, type Conn } from './registry.js'
import { startRedisBridge, type Logger } from './redisBridge.js'
import { startSqsConsumer } from './sqsConsumer.js'

// ---------------------------------------------------------------------------
// Environment / config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3106)
const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1'
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379)
const CONNECTION_TOKEN_SECRET = process.env.WEB_SOCKET_CONNECTION_TOKEN_SECRET ?? ''
const CONNECTION_TOKEN_TTL = process.env.WEB_SOCKET_CONNECTION_TOKEN_TTL ?? '60s'
// When set, POST /sockets/tokens requires header `x-internal-secret` to match.
// When unset (dev), the endpoint is open.
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? ''

// Heartbeat interval for dropping dead sockets.
const HEARTBEAT_MS = 30_000

const logger: Logger = {
  info: (...args) => console.log(new Date().toISOString(), '[info]', ...args),
  warn: (...args) => console.warn(new Date().toISOString(), '[warn]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[error]', ...args),
}

if (!CONNECTION_TOKEN_SECRET) {
  logger.warn(
    'WEB_SOCKET_CONNECTION_TOKEN_SECRET is unset — all connection tokens will fail to verify.',
  )
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const registry = new ConnectionRegistry<WebSocket>()

/** Tracks liveness per socket for the heartbeat sweep. */
const alive = new WeakMap<WebSocket, boolean>()

// ---------------------------------------------------------------------------
// HTTP server (health + token minting). The ws server attaches to this same
// http server and handles the upgrade itself.
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }

  if (req.method === 'POST' && url.pathname === '/sockets/tokens') {
    handleMintToken(req, res)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

/**
 * POST /sockets/tokens — mint a short-lived connection JWT.
 *
 * This is an internal/trusted endpoint: the api-gateway proxies to it to hand
 * a browser a WS token for an already-authenticated session. We guard it with
 * `x-internal-secret` when WEBSOCKET_GATEWAY_INTERNAL_SECRET is configured;
 * when it is unset (local dev) the endpoint is open. Exact api-gateway wiring
 * (e.g. forwarding the authenticated identity) is handled separately.
 */
function handleMintToken(req: IncomingMessage, res: ServerResponse): void {
  // Guard: if an internal secret is configured, require a matching header.
  if (INTERNAL_SECRET) {
    const provided = req.headers['x-internal-secret']
    if (provided !== INTERNAL_SECRET) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    // Cheap guard against oversized payloads.
    if (body.length > 16_384) {
      req.destroy()
    }
  })
  req.on('end', () => {
    let userUuid: unknown
    let sessionUuid: unknown
    try {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      userUuid = parsed.userUuid
      sessionUuid = parsed.sessionUuid
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json body' }))
      return
    }

    if (typeof userUuid !== 'string' || typeof sessionUuid !== 'string' || !userUuid || !sessionUuid) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'userUuid and sessionUuid are required' }))
      return
    }

    const token = mintConnectionToken(
      { userUuid, sessionUuid },
      CONNECTION_TOKEN_SECRET,
      CONNECTION_TOKEN_TTL,
    )
    logger.info(`[token] minted user=${userUuid} session=${sessionUuid}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token }))
  })
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

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
    identity = verifyConnectionToken(token, CONNECTION_TOKEN_SECRET)
  } catch (err) {
    logger.warn('[ws] connection rejected: bad token', err instanceof Error ? err.message : err)
    socket.close(1008, 'invalid authToken')
    return
  }

  const conn: Conn<WebSocket> = {
    socket,
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
    logger.info(
      `[ws] disconnect user=${identity.userUuid} conn=${conn.connectionId} total=${registry.size()}`,
    )
  }

  socket.on('close', cleanup)
  socket.on('error', (err) => {
    logger.warn('[ws] socket error', err instanceof Error ? err.message : err)
    cleanup()
  })

  // Protocol-level pong marks the socket alive for the heartbeat sweep.
  socket.on('pong', () => {
    alive.set(socket, true)
  })

  // Some clients send a `ping` text frame; reply with `pong` and stay alive.
  socket.on('message', (data) => {
    alive.set(socket, true)
    if (data.toString() === 'ping') {
      socket.send('pong')
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

// ---------------------------------------------------------------------------
// Redis bridge
// ---------------------------------------------------------------------------

const redis = startRedisBridge(registry, {
  host: REDIS_HOST,
  port: REDIS_PORT,
  logger,
})

// SQS consumer (multi-process / SNS+SQS deployment). Enabled when SQS_QUEUE_URL
// is set; consumes WEB_SOCKET_MESSAGE_REQUESTED from the syncing-server topic.
let stopSqs: (() => void) | undefined
if (process.env.SQS_QUEUE_URL) {
  stopSqs = startSqsConsumer(registry, {
    queueUrl: process.env.SQS_QUEUE_URL,
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.SQS_AWS_REGION,
    accessKeyId: process.env.SQS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SQS_SECRET_ACCESS_KEY,
    logger,
  })
}

// ---------------------------------------------------------------------------
// Boot + graceful shutdown
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  logger.info(`websocket-gateway listening on :${PORT} (redis ${REDIS_HOST}:${REDIS_PORT})`)
})

function shutdown(signal: string): void {
  logger.info(`[shutdown] received ${signal}, closing`)
  clearInterval(heartbeat)
  for (const socket of wss.clients) socket.close(1001, 'server shutting down')
  wss.close()
  stopSqs?.()
  redis.quit().catch(() => redis.disconnect())
  httpServer.close(() => process.exit(0))
  // Force-exit if something hangs.
  setTimeout(() => process.exit(0), 5_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
