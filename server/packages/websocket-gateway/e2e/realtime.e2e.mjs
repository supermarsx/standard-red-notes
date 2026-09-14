/**
 * End-to-end test for the realtime push path, run against the LIVE stack.
 *
 * Defaults target the PUBLIC front door (the app nginx on :3001) — the same
 * origin a browser uses — not the gateway's own port, which is not published.
 * Proves:
 *   1. `/healthcheck/readiness` answers through the front door.
 *   2. An internal (`x-internal-secret`) mint through the FRONT DOOR is
 *      REFUSED. nginx blanks `X-Internal-Secret` on `/sockets` and the gateway
 *      refuses an internal mint whenever `x-forwarded-for` is present or the
 *      peer is not loopback, so the internet-facing credential is inert.
 *   3. The same internal mint SUCCEEDS from loopback (inside the container).
 *   4. `POST /sockets/tokens` mints via the X-AUTH-TOKEN cross-service path
 *      (signing a CrossServiceTokenData JWT with AUTH_JWT_SECRET, exactly as
 *      the api-gateway forwards for the web client), and rejects a bad token.
 *   5. A client that connects to `/sockets?authToken=` RECEIVES a push
 *      published to the Redis `websocket-messages` channel for its user (the
 *      same channel the home-server bridge uses; SQS is structurally
 *      identical).
 *   6. The originating session is excluded from its own push, and a push for
 *      another user is not delivered here.
 *
 * The legacy lane only upgrades on the exact pathname `/sockets` (contract
 * C13); any other path is closed with 1008 `unknown path`.
 *
 * Usage (inside the server container, which is the only place the loopback
 * mint legs can run):
 *   docker compose exec -T \
 *     -e REQUIRE_GATEWAY=1 \
 *     -e GATEWAY_HTTP=http://127.0.0.1:3000 \
 *     -e GATEWAY_WS=ws://127.0.0.1:3000/sockets \
 *     -e GATEWAY_INTERNAL_HTTP=http://127.0.0.1:3106 \
 *     -e REDIS_HOST=cache \
 *     server yarn node packages/websocket-gateway/e2e/realtime.e2e.mjs
 *
 * From the host (front-door legs only; the loopback mint legs report `skip`):
 *   REQUIRE_GATEWAY=1 REDIS_VIA_COMPOSE=1 node e2e/realtime.e2e.mjs
 *
 * Env: GATEWAY_HTTP, GATEWAY_WS, GATEWAY_INTERNAL_HTTP, GATEWAY_HEALTH_PATH,
 *      REQUIRE_GATEWAY, REDIS_HOST, REDIS_PORT, REDIS_VIA_COMPOSE,
 *      REDIS_COMPOSE_SERVICE, WEBSOCKET_GATEWAY_INTERNAL_SECRET,
 *      AUTH_JWT_SECRET.
 */
import { WebSocket } from 'ws'
import { execFileSync } from 'node:child_process'
import jwt from 'jsonwebtoken'
import Redis from 'ioredis'

const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3001'
const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3001/sockets'
const GATEWAY_HEALTH_PATH = process.env.GATEWAY_HEALTH_PATH ?? '/healthcheck/readiness'
// The internal mint only answers a loopback peer with no `x-forwarded-for`, so
// it is reachable from inside the container and nowhere else. Unset => the
// loopback legs are skipped rather than failed.
const GATEWAY_INTERNAL_HTTP = process.env.GATEWAY_INTERNAL_HTTP ?? ''
const REQUIRE_GATEWAY = process.env.REQUIRE_GATEWAY === '1'
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? 'dev-auth-jwt-secret-change-me'
// Redis (`cache`) is not published to the host. Inside the container the
// service name resolves; from the host set REDIS_VIA_COMPOSE=1 to publish
// through `docker compose exec` instead.
const REDIS_HOST = process.env.REDIS_HOST ?? 'cache'
const REDIS_PORT = Number(process.env.REDIS_PORT ?? '6379')
const REDIS_VIA_COMPOSE = process.env.REDIS_VIA_COMPOSE === '1'
const REDIS_COMPOSE_SERVICE = process.env.REDIS_COMPOSE_SERVICE ?? 'cache'

let redisClient
async function redisPublish(channel, payload) {
  if (REDIS_VIA_COMPOSE) {
    execFileSync('docker', ['compose', 'exec', '-T', REDIS_COMPOSE_SERVICE, 'redis-cli', 'publish', channel, payload], {
      stdio: 'ignore',
    })
    return
  }
  redisClient ??= new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 })
  if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') await redisClient.connect()
  await redisClient.publish(channel, payload)
}

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok   - ${name}`)
  else {
    console.log(`  FAIL - ${name}`)
    failures++
  }
}
function skip(name, reason) {
  console.log(`  skip - ${name} (${reason})`)
}

function connect(token) {
  return new Promise((resolve, reject) => {
    // C13: the legacy lane upgrades on the exact pathname `/sockets` only.
    const ws = new WebSocket(`${GATEWAY_WS}?authToken=${token}`)
    const received = []
    ws.on('message', (d) => received.push(String(d)))
    ws.on('open', () => resolve({ ws, received }))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ws open timeout')), 8000)
  })
}

async function mint(origin, headers, body) {
  const response = await fetch(`${origin}/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body }),
  })
  const parsed = await response.json().catch(() => ({}))
  return { status: response.status, body: parsed }
}

async function main() {
  // Pre-flight: the front door must be up.
  const health = await fetch(`${GATEWAY_HTTP}${GATEWAY_HEALTH_PATH}`)
    .then((r) => r.status)
    .catch(() => 0)
  if (health !== 200) {
    if (REQUIRE_GATEWAY) {
      console.error(`REQUIRED: gateway not reachable on ${GATEWAY_HTTP}${GATEWAY_HEALTH_PATH} (status ${health})`)
      process.exit(1)
    }
    console.log('SKIP: gateway not reachable on', GATEWAY_HTTP, '(start the stack first)')
    process.exit(0)
  }
  check('readiness answers through the front door', health === 200)

  const userUuid = 'e2e-user-' + Date.now()
  const listenerSession = 'e2e-listener'
  const originatingSession = 'e2e-origin'

  // 1. The internet-facing internal-secret mint must be refused at the front
  //    door: nginx blanks the header and the gateway refuses proxied peers.
  const frontDoor = await mint(
    GATEWAY_HTTP,
    { 'x-internal-secret': INTERNAL_SECRET },
    JSON.stringify({ userUuid, sessionUuid: listenerSession }),
  )
  check(
    `internal mint through the front door is refused (got ${frontDoor.status})`,
    frontDoor.status !== 200 && typeof frontDoor.body.token !== 'string',
  )

  if (!GATEWAY_INTERNAL_HTTP) {
    skip('loopback internal + cross-service mints', 'GATEWAY_INTERNAL_HTTP unset; run inside the container')
    console.log(failures === 0 ? '\nE2E PASSED (front-door legs only)' : `\nE2E FAILED (${failures})`)
    await redisClient?.quit().catch(() => {})
    process.exit(failures === 0 ? 0 : 1)
  }

  // 2. Loopback internal mint.
  const internal = await mint(
    GATEWAY_INTERNAL_HTTP,
    { 'x-internal-secret': INTERNAL_SECRET },
    JSON.stringify({ userUuid, sessionUuid: listenerSession }),
  )
  check('loopback internal mint returns 200 + token', internal.status === 200 && typeof internal.body.token === 'string')

  // 3. X-auth (cross-service) path mint — what the api-gateway does for the web client.
  const crossServiceToken = jwt.sign(
    { user: { uuid: userUuid, email: 'e2e@x.com' }, roles: [], session: { uuid: originatingSession } },
    AUTH_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '60s' },
  )
  const web = await mint(GATEWAY_INTERNAL_HTTP, { 'x-auth-token': crossServiceToken })
  check('x-auth mint returns 200 + token (web flow)', web.status === 200 && typeof web.body.token === 'string')

  const bad = await mint(GATEWAY_INTERNAL_HTTP, { 'x-auth-token': 'garbage' })
  check('x-auth mint rejects invalid token (401)', bad.status === 401)

  if (typeof internal.body.token !== 'string') {
    console.log(`\nE2E FAILED (${failures})`)
    await redisClient?.quit().catch(() => {})
    process.exit(1)
  }

  // 4. Connect through the front door with the minted token and assert push delivery.
  const { ws, received } = await connect(internal.body.token)
  await new Promise((r) => setTimeout(r, 500)) // let the registry register

  const message = JSON.stringify({ type: 'ITEMS_CHANGED_ON_SERVER', payload: { userUuid } })

  // 4a. push for this user (no originating exclusion) -> should arrive.
  await redisPublish('websocket-messages', JSON.stringify({ userUuid, message }))
  await new Promise((r) => setTimeout(r, 800))
  check('connected socket receives the push', received.some((m) => m.includes('ITEMS_CHANGED_ON_SERVER')))

  // 4b. push excluding THIS session -> should NOT arrive.
  const before = received.length
  await redisPublish(
    'websocket-messages',
    JSON.stringify({ userUuid, message, originatingSessionUuid: listenerSession }),
  )
  await new Promise((r) => setTimeout(r, 800))
  check('push excluding the listener session is suppressed', received.length === before)

  // 4c. push for a DIFFERENT user -> should NOT arrive.
  await redisPublish('websocket-messages', JSON.stringify({ userUuid: 'someone-else', message }))
  await new Promise((r) => setTimeout(r, 600))
  check('push for another user is not delivered here', received.length === before)

  ws.close()
  await redisClient?.quit().catch(() => {})

  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
