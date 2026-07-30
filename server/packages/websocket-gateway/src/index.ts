import { createServer } from 'node:http'
import { attachWebSocketGateway, type GatewayConfig } from './gateway.js'
import { type Logger } from './redisBridge.js'

// ---------------------------------------------------------------------------
// Standalone entry.
//
// This is the original process model: the gateway owns its own http server
// (serving GET /health + POST /sockets/tokens) and listens on :3106. The actual
// ws + registry + redis + sqs logic lives in `gateway.ts` (`attachWebSocketGateway`),
// which is ALSO used by the api-gateway to run the gateway in-process on :3000.
//
// In the merged deployment this entry is no longer started — the api-gateway
// attaches the gateway directly — but it is kept working so the package can run
// on its own and so the e2e/tests keep passing.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3106)
const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1'
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379)

const logger: Logger = {
  info: (...args) => console.log(new Date().toISOString(), '[info]', ...args),
  warn: (...args) => console.warn(new Date().toISOString(), '[warn]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[error]', ...args),
}

const config: GatewayConfig = {
  connectionTokenSecret: process.env.WEB_SOCKET_CONNECTION_TOKEN_SECRET ?? '',
  connectionTokenTtl: process.env.WEB_SOCKET_CONNECTION_TOKEN_TTL ?? '60s',
  internalSecret: process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? '',
  authJwtSecret: process.env.AUTH_JWT_SECRET ?? '',
  redisHost: REDIS_HOST,
  redisPort: REDIS_PORT,
  maxConnectionsPerUser:
    process.env.WEBSOCKET_MAX_CONNECTIONS_PER_USER === undefined
      ? undefined
      : Number(process.env.WEBSOCKET_MAX_CONNECTIONS_PER_USER),
  sqs: {
    queueUrl: process.env.SQS_QUEUE_URL,
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.SQS_AWS_REGION,
    accessKeyId: process.env.SQS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SQS_SECRET_ACCESS_KEY,
  },
}

// Fail CLOSED before opening a listener: an empty connection-token secret means
// tokens are signed/verified with an empty HS256 key — trivially forgeable.
if (!config.connectionTokenSecret) {
  logger.error('WEB_SOCKET_CONNECTION_TOKEN_SECRET is required (refusing to start with an empty signing secret).')
  process.exit(1)
}

// The standalone gateway owns its own http server: GET /health and the token
// endpoint. The ws upgrade + token-mint logic come from the shared module — we
// dispatch the token route into the gateway's mint handler.
const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }

  if (req.method === 'POST' && url.pathname === '/sockets/tokens') {
    gateway.handleMintToken(req, res)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

// Attach the ws server, registry, redis bridge and SQS consumer to our http
// server. No Express app is passed, so the token endpoint is dispatched manually
// above via `gateway.handleMintToken`.
const gateway = attachWebSocketGateway({ httpServer, config, logger })

httpServer.listen(PORT, () => {
  logger.info(`websocket-gateway listening on :${PORT} (redis ${REDIS_HOST}:${REDIS_PORT})`)
})

let shutdownStarted = false

async function stopGatewaySafely(): Promise<void> {
  try {
    await gateway.stop()
  } catch (error) {
    logger.error('[shutdown] gateway stop failed', error instanceof Error ? error.message : error)
  }
}

async function closeHttpServerSafely(): Promise<void> {
  await new Promise<void>((resolveClose) => {
    try {
      httpServer.close(() => resolveClose())
    } catch (error) {
      logger.error('[shutdown] http server close failed', error instanceof Error ? error.message : error)
      resolveClose()
    }
  })
}

function shutdown(signal: string): void {
  if (shutdownStarted) {
    logger.info(`[shutdown] ignoring ${signal}; shutdown already in progress`)
    return
  }
  shutdownStarted = true

  logger.info(`[shutdown] received ${signal}, closing`)
  const forceExitTimer = setTimeout(() => {
    logger.error('[shutdown] forcing process exit after 5000ms')
    process.exit(0)
  }, 5_000)
  forceExitTimer.unref()

  void Promise.all([stopGatewaySafely(), closeHttpServerSafely()])
    .then(() => {
      clearTimeout(forceExitTimer)
      process.exit(0)
    })
    .catch((error) => {
      logger.error('[shutdown] unexpected shutdown failure', error instanceof Error ? error.message : error)
      clearTimeout(forceExitTimer)
      process.exit(0)
    })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
