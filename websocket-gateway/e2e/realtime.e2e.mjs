/**
 * End-to-end test for the realtime push path, run against the LIVE docker stack
 * (websocket-gateway on :3106 + redis). Proves:
 *   1. POST /sockets/tokens mints a connection token via the INTERNAL path.
 *   2. POST /sockets/tokens mints via the X-AUTH-TOKEN cross-service path
 *      (signing a CrossServiceTokenData JWT with AUTH_JWT_SECRET, exactly as the
 *      api-gateway forwards for the web client).
 *   3. A client that connects with a minted token RECEIVES a push published to
 *      the Redis `websocket-messages` channel for its user (the same channel the
 *      home-server bridge uses; the SQS path is structurally identical).
 *   4. The originating session is excluded from its own push.
 *
 * Usage: node e2e/realtime.e2e.mjs   (requires the stack to be up)
 * Env: GATEWAY_HTTP, GATEWAY_WS, REDIS_HOST, REDIS_PORT,
 *      WEBSOCKET_GATEWAY_INTERNAL_SECRET, AUTH_JWT_SECRET
 */
import { WebSocket } from 'ws'
import { execFileSync } from 'node:child_process'
import jwt from 'jsonwebtoken'

const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3106'
const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3106'
// Redis (`cache`) isn't exposed to the host, so publish via the container.
const REDIS_CONTAINER = process.env.REDIS_CONTAINER ?? 'standard-red-notes-cache-1'
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? 'dev-auth-jwt-secret-change-me'

function redisPublish(channel, payload) {
  execFileSync('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'publish', channel, payload], {
    stdio: 'ignore',
  })
}

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok   - ${name}`)
  else {
    console.log(`  FAIL - ${name}`)
    failures++
  }
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS}/?authToken=${token}`)
    const received = []
    ws.on('message', (d) => received.push(String(d)))
    ws.on('open', () => resolve({ ws, received }))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ws open timeout')), 8000)
  })
}

async function main() {
  // Pre-flight: gateway must be up.
  const health = await fetch(`${GATEWAY_HTTP}/health`).then((r) => r.status).catch(() => 0)
  if (health !== 200) {
    console.log('SKIP: gateway not reachable on', GATEWAY_HTTP, '(start the stack first)')
    process.exit(0)
  }

  const userUuid = 'e2e-user-' + Date.now()
  const listenerSession = 'e2e-listener'
  const originatingSession = 'e2e-origin'

  // 1. Internal-path mint.
  const internalRes = await fetch(`${GATEWAY_HTTP}/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ userUuid, sessionUuid: listenerSession }),
  })
  const internalBody = await internalRes.json()
  check('internal mint returns 200 + token', internalRes.status === 200 && typeof internalBody.token === 'string')

  // 2. X-auth (cross-service) path mint — what the api-gateway does for the web client.
  const crossServiceToken = jwt.sign(
    { user: { uuid: userUuid, email: 'e2e@x.com' }, roles: [], session: { uuid: originatingSession } },
    AUTH_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '60s' },
  )
  const webRes = await fetch(`${GATEWAY_HTTP}/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': crossServiceToken },
  })
  const webBody = await webRes.json()
  check('x-auth mint returns 200 + token (web flow)', webRes.status === 200 && typeof webBody.token === 'string')

  const badRes = await fetch(`${GATEWAY_HTTP}/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': 'garbage' },
  })
  check('x-auth mint rejects invalid token (401)', badRes.status === 401)

  // 3. Connect with the minted token and assert push delivery.
  const { ws, received } = await connect(internalBody.token)
  await new Promise((r) => setTimeout(r, 500)) // let the registry register

  const message = JSON.stringify({ type: 'ITEMS_CHANGED_ON_SERVER', payload: { userUuid } })

  // 3a. push for this user (no originating exclusion) -> should arrive.
  redisPublish('websocket-messages', JSON.stringify({ userUuid, message }))
  await new Promise((r) => setTimeout(r, 800))
  check('connected socket receives the push', received.some((m) => m.includes('ITEMS_CHANGED_ON_SERVER')))

  // 3b. push excluding THIS session -> should NOT arrive.
  const before = received.length
  redisPublish('websocket-messages', JSON.stringify({ userUuid, message, originatingSessionUuid: listenerSession }))
  await new Promise((r) => setTimeout(r, 800))
  check('push excluding the listener session is suppressed', received.length === before)

  // 3c. push for a DIFFERENT user -> should NOT arrive.
  redisPublish('websocket-messages', JSON.stringify({ userUuid: 'someone-else', message }))
  await new Promise((r) => setTimeout(r, 600))
  check('push for another user is not delivered here', received.length === before)

  ws.close()

  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
