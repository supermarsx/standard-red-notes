/**
 * Oversized `SYNC_ITEMS` result over the worker sync lane (finding B5,
 * contract C5), run against the LIVE stack through the public front door.
 *
 * A committed sync result can be far larger than one frame. The gateway must
 * NOT try to inline it and must NOT fail the command: when the COMMITTED
 * answer would exceed MAX_SYNC_FRAME_BYTES (512 KiB) it sends a payload-less
 *
 *   STATUS { status: 'COMMITTED', code: 'RESULT_TOO_LARGE' }   (no `result`)
 *
 * carrying the same requestId/commandId/digest, and the client replays the
 * SAME command over HTTP with `x-sync-command-id` / `x-sync-command-digest`,
 * which returns the JOURNALED result idempotently — the items are committed
 * exactly once whichever leg delivers them. `ERROR RESULT_TOO_LARGE` stays
 * reserved for oversized INGRESS and must not appear here.
 *
 * The lane only carries `SYNC_ITEMS` when the api-gateway talks gRPC to the
 * syncing-server, so this script is the proof for `SERVICE_PROXY_TYPE=grpc`
 * (decision vii). Without it the ticket negotiates no `SYNC_ITEMS` operation
 * and the script reports SKIP (or fails under REQUIRE_SYNC_ITEMS=1).
 *
 * Usage (host, against the public front door):
 *   REQUIRE_GATEWAY=1 REQUIRE_SYNC_ITEMS=1 yarn node e2e/sync-items-oversized.e2e.mjs
 *
 * Env: BASE, WS_BASE, ORIGIN, REQUIRE_GATEWAY, REQUIRE_SYNC_ITEMS,
 *      GATEWAY_HEALTH_PATH, OVERSIZED_ITEMS, OVERSIZED_ITEM_BYTES.
 */
import { WebSocket } from 'ws'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://localhost:3001'
const WS_BASE = process.env.WS_BASE ?? 'ws://localhost:3001'
const ORIGIN = process.env.ORIGIN ?? BASE
const GATEWAY_HEALTH_PATH = process.env.GATEWAY_HEALTH_PATH ?? '/healthcheck/readiness'
const REQUIRE_GATEWAY = process.env.REQUIRE_GATEWAY === '1'
const REQUIRE_SYNC_ITEMS = process.env.REQUIRE_SYNC_ITEMS === '1'
const API = '20200115'
const DEVICE_ID = 'e2e-oversized-' + randomUUID()

const MAX_SYNC_FRAME_BYTES = 512 * 1024
// Enough committed items that the result cannot fit one frame. Each note body
// is opaque ciphertext to the server, so size is the only thing that matters.
const ITEM_BYTES = Number(process.env.OVERSIZED_ITEM_BYTES ?? '32768')
const ITEM_COUNT = Number(process.env.OVERSIZED_ITEMS ?? '24')

const sleep = (t) => new Promise((r) => setTimeout(r, t))
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  else {
    console.log(`  FAIL - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
    failures++
  }
}
function skip(name, reason) {
  console.log(`  skip - ${name} (${reason})`)
}

async function api(method, path, { body, token, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    raw = undefined
  }
  const json = raw && typeof raw === 'object' && 'data' in raw && 'meta' in raw ? raw.data : raw
  return { status: res.status, json, raw, text }
}

async function register() {
  const email = `e2e-oversized-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
  const password = randomBytes(32).toString('hex')
  const r = await api('POST', '/v1/users', {
    body: {
      email,
      password,
      api: API,
      version: '004',
      pw_nonce: randomBytes(32).toString('hex'),
      origination: 'registration',
      created: String(Date.now()),
      ephemeral: false,
    },
  })
  if (r.status !== 200 || !r.json?.session?.access_token) {
    throw new Error(`register failed: ${r.status} ${r.text.slice(0, 300)}`)
  }
  return { email, password, session: r.json.session, user: r.json.user }
}

function makeNote() {
  const iso = new Date().toISOString()
  return {
    uuid: randomUUID(),
    content_type: 'Note',
    content: '004:' + randomBytes(ITEM_BYTES).toString('base64'),
    enc_item_key: '004:' + randomBytes(72).toString('base64'),
    items_key_id: '00000000-0000-4000-8000-00000000abcd',
    created_at: iso,
    updated_at: iso,
    deleted: false,
  }
}

function syncFrame(type, payload, { sequence, requestId, commandId, digest } = {}) {
  const frame = {
    version: 1,
    channel: 'sync',
    type,
    requestId: requestId ?? `req-${randomUUID()}`,
    commandId: commandId ?? `cmd-${randomUUID()}`,
    sequence: sequence ?? 0,
    payloadLength: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    payload,
  }
  if (digest !== undefined) frame.digest = digest
  return frame
}

/** The command digest the journal keys on: sha256 over the canonical body. */
function commandDigest(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function openSyncSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/sockets/sync`, { origin: ORIGIN })
    const state = { ws, frames: [], close: undefined }
    ws.on('message', (data) => {
      try {
        state.frames.push(JSON.parse(data.toString()))
      } catch {
        state.frames.push({ type: 'UNPARSEABLE', raw: data.toString() })
      }
    })
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString() }
    })
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)))
    ws.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('sync socket open timeout')), 10_000)
  })
}

async function waitForFrame(state, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = state.frames.find(predicate)
    if (found) return found
    if (state.close) return undefined
    await sleep(25)
  }
  return undefined
}

async function main() {
  const health = await fetch(`${BASE}${GATEWAY_HEALTH_PATH}`)
    .then((r) => r.status)
    .catch(() => 0)
  if (health !== 200) {
    if (REQUIRE_GATEWAY) {
      console.error(`REQUIRED: stack not reachable on ${BASE}${GATEWAY_HEALTH_PATH} (status ${health})`)
      process.exit(1)
    }
    console.log('SKIP: stack not reachable on', BASE)
    process.exit(0)
  }

  const account = await register()
  const accessToken = account.session.access_token

  // 1. Ticket through the front door. Its negotiated operations say whether
  //    SYNC_ITEMS is carried at all (it is only with SERVICE_PROXY_TYPE=grpc).
  const ticketResponse = await api('POST', '/v1/sockets/sync/ticket', {
    token: accessToken,
    body: { deviceId: DEVICE_ID },
  })
  if (ticketResponse.status !== 200 || typeof ticketResponse.json?.ticket !== 'string') {
    const message = `ticket refused: ${ticketResponse.status} ${ticketResponse.text.slice(0, 200)}`
    if (REQUIRE_SYNC_ITEMS) {
      console.error('REQUIRED: ' + message)
      process.exit(1)
    }
    console.log('SKIP:', message)
    process.exit(0)
  }
  const ticket = ticketResponse.json
  const operations = Array.isArray(ticket.operations) ? ticket.operations : []
  check('ticket issued through the front door', typeof ticket.ticket === 'string')

  if (!operations.includes('SYNC_ITEMS')) {
    const reason = `ticket negotiated [${operations.join(', ')}]; set SERVICE_PROXY_TYPE=grpc to enable SYNC_ITEMS`
    if (REQUIRE_SYNC_ITEMS) {
      console.error('REQUIRED: SYNC_ITEMS not negotiated — ' + reason)
      process.exit(1)
    }
    skip('oversized SYNC_ITEMS result', reason)
    console.log(failures === 0 ? '\nE2E PASSED (SYNC_ITEMS not negotiated)' : `\nE2E FAILED (${failures})`)
    process.exit(failures === 0 ? 0 : 1)
  }

  // 2. Authenticate the lane.
  const socket = await openSyncSocket()
  socket.ws.send(JSON.stringify(syncFrame('AUTH', { ticket: ticket.ticket, deviceId: DEVICE_ID }, { sequence: 0 })))
  const authenticated = await waitForFrame(socket, (f) => f.type === 'AUTHENTICATED', 10_000)
  check('sync lane authenticates', authenticated !== undefined, socket.close)
  if (!authenticated) {
    console.log(`\nE2E FAILED (${failures})`)
    process.exit(1)
  }

  // 3. A SYNC_ITEMS command whose COMMITTED result cannot fit one frame.
  const items = Array.from({ length: ITEM_COUNT }, () => makeNote())
  const body = { api: API, items, limit: 150, compute_integrity: false }
  const digest = commandDigest(body)
  const requestId = `req-${randomUUID()}`
  const commandId = `cmd-${randomUUID()}`
  const command = syncFrame(
    'COMMAND',
    { command: 'SYNC_ITEMS', body },
    { sequence: 1, requestId, commandId, digest },
  )
  const requestBytes = Buffer.byteLength(JSON.stringify(command), 'utf8')
  check(
    'the committed result is large enough to exceed one frame',
    requestBytes > MAX_SYNC_FRAME_BYTES,
    { requestBytes, MAX_SYNC_FRAME_BYTES },
  )
  socket.ws.send(JSON.stringify(command))

  const answer = await waitForFrame(
    socket,
    (f) => f.requestId === requestId && (f.type === 'STATUS' || f.type === 'COMMITTED' || f.type === 'ERROR'),
    40_000,
  )
  check('the command is answered', answer !== undefined, socket.close)
  if (!answer) {
    console.log(`\nE2E FAILED (${failures})`)
    process.exit(1)
  }
  console.log('  answer:', JSON.stringify({ type: answer.type, payload: { ...answer.payload, result: undefined } }))

  // C5: the oversized COMMITTED answer is a payload-less STATUS, never an ERROR.
  check('the oversized answer is not an ERROR frame', answer.type !== 'ERROR', answer.payload?.code)
  check('the answer reports COMMITTED', answer.payload?.status === 'COMMITTED', answer.payload?.status)
  check('the answer carries code RESULT_TOO_LARGE', answer.payload?.code === 'RESULT_TOO_LARGE', answer.payload?.code)
  check('the answer omits the result entirely', answer.payload?.result === undefined)
  check('the answer keeps the command identity', answer.commandId === commandId && answer.digest === digest, {
    commandId: answer.commandId,
    digest: answer.digest,
  })
  // The socket stays usable: an oversized RESULT is not a transport failure.
  check('the socket stays open after an oversized result', socket.close === undefined, socket.close)

  // 4. HTTP replay of the SAME command returns the journaled result.
  const replay = await api('POST', '/v1/items', {
    token: accessToken,
    body,
    headers: { 'x-sync-command-id': commandId, 'x-sync-command-digest': digest },
  })
  check('HTTP replay of the journaled command succeeds', replay.status === 200, replay.status)
  const saved = replay.json?.saved_items ?? []
  check('HTTP replay returns the committed items', saved.length === ITEM_COUNT, {
    returned: saved.length,
    expected: ITEM_COUNT,
  })
  const savedUuids = new Set(saved.map((item) => item.uuid))
  check(
    'every item committed over the lane is present in the replay',
    items.every((item) => savedUuids.has(item.uuid)),
  )
  // Idempotent: the journal answers the second replay with the same result and
  // does not double-commit.
  const again = await api('POST', '/v1/items', {
    token: accessToken,
    body,
    headers: { 'x-sync-command-id': commandId, 'x-sync-command-digest': digest },
  })
  check('the replay is idempotent', again.status === 200 && (again.json?.saved_items ?? []).length === ITEM_COUNT, {
    status: again.status,
    returned: (again.json?.saved_items ?? []).length,
  })

  socket.ws.close(1000)
  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
