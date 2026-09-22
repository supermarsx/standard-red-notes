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
 * which returns the JOURNALED result idempotently -- the items are committed
 * exactly once whichever leg delivers them.
 *
 * The gateway enforces a SYMMETRIC 512 KiB cap on ingress AND egress frames
 * (gateway.ts: `rawBytes > maxFrameBytes` closes the socket 1009 before a
 * frame is even parsed). A large SAVE therefore trips the INGRESS cap and
 * never reaches command execution at all -- it cannot be this script's
 * trigger. The trigger here is a large RESULT instead: a corpus is
 * pre-populated over plain HTTP (uncapped) BEFORE the socket opens, then a
 * tiny `SYNC_ITEMS` PULL command (`items: []`, no `sync_token`) asks for it
 * all back. The command frame sent is small; only the COMMITTED answer is
 * oversized, so this reaches the egress path (syncCommandHandler.ts `send()`)
 * and nothing else.
 *
 * The command digest is NOT `JSON.stringify(body)`. The gateway validates it
 * against `digestSyncCommandBody` (websocket-gateway/src/syncProtocol.ts) and
 * the syncing server separately re-asserts it via `computeSyncCommandDigest`
 * (syncing-server/src/Domain/SyncCommand/SyncCommandTypes.ts) -- both hash a
 * CANONICAL form with object keys sorted recursively, not declaration order.
 * A plain `JSON.stringify` digest disagrees with both and the command is
 * refused `INVALID_DIGEST` before authentication of the body ever happens.
 * `--self-test` proves this script's canonicalization against the published
 * cross-transport vectors so this cannot regress silently again.
 *
 * The lane only carries `SYNC_ITEMS` when a durable command port is bound:
 * the single-container/home-server build binds one (`DirectCallSyncCommandPort`)
 * unconditionally, while the multi-container api-gateway binds one only under
 * `SERVICE_PROXY_TYPE=grpc` (decision vii). The negotiated operations are
 * announced on the WebSocket `AUTHENTICATED` frame's payload -- NEVER on the
 * HTTP ticket response, which carries no `operations` field at all. Reading
 * it from the ticket always reports "not negotiated", on every topology,
 * regardless of configuration; this script reads it from `AUTHENTICATED`
 * instead. Without it negotiated, the script reports SKIP (or fails under
 * REQUIRE_SYNC_ITEMS=1), naming the operations it actually saw.
 *
 * Usage (host, against the public front door):
 *   REQUIRE_GATEWAY=1 REQUIRE_SYNC_ITEMS=1 yarn node e2e/sync-items-oversized.e2e.mjs
 *
 * Offline self-check of the canonicalization, negotiation and answer-shape
 * logic (no stack, no Docker):
 *   yarn node e2e/sync-items-oversized.e2e.mjs --self-test
 *
 * Env: BASE, WS_BASE, ORIGIN, REQUIRE_GATEWAY, REQUIRE_SYNC_ITEMS,
 *      GATEWAY_HEALTH_PATH, OVERSIZED_ITEMS, OVERSIZED_ITEM_BYTES.
 *      OVERSIZED_ITEMS/OVERSIZED_ITEM_BYTES size the corpus pre-populated
 *      over HTTP before the pull -- NOT the WebSocket command, which stays
 *      small on purpose.
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
// Enough pre-existing items that pulling them ALL back in one PULL command
// cannot fit one frame. Each note body is opaque ciphertext to the server, so
// size is the only thing that matters. Well under the server's default
// per-sync page size (300 items) and content-transfer budget (10 MB), so
// nothing else clamps the pull short of the real trigger.
const ITEM_BYTES = Number(process.env.OVERSIZED_ITEM_BYTES ?? '32768')
const ITEM_COUNT = Number(process.env.OVERSIZED_ITEMS ?? '24')
// The PULL command's requested page size. Comfortably above ITEM_COUNT so the
// whole corpus comes back in the one page this script inspects, and well
// under the server's default 300-item ceiling (GetItems clamps a larger ask
// down to that ceiling itself).
const PULL_LIMIT = Math.max(ITEM_COUNT, 200)

const sleep = (t) => new Promise((r) => setTimeout(r, t))

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

// ---------------------------------------------------------------------------
// Protocol-v1 canonical JSON and command digest. Byte-for-byte the same
// algorithm as `canonicalSyncJson`/`digestSyncCommandBody` in
// websocket-gateway/src/syncProtocol.ts (which the gateway validates the
// COMMAND frame against) AND `canonicalJson`/`computeSyncCommandDigest` in
// syncing-server/src/Domain/SyncCommand/SyncCommandTypes.ts (which the
// durable command re-asserts independently) -- both must agree with
// whatever digest this script sends. Checked against the published
// cross-transport vectors in --self-test.
// ---------------------------------------------------------------------------
function canonicalSyncJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSyncJson(entry)).join(',')}]`
  }
  const object = value
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(object[key])}`).join(',')}}`
}

/** The command digest the journal keys on: sha256 over the CANONICAL body. */
function commandDigest(body) {
  return createHash('sha256').update(canonicalSyncJson(body), 'utf8').digest('hex')
}

/** Published cross-transport vector (websocket-gateway/src/syncProtocol.ts). */
const SYNC_COMMAND_DIGEST_TEST_VECTOR = Object.freeze({
  body: {
    api: '20200115',
    items: [{ uuid: 'note-1', content: 'ciphertext', content_type: 'Note', deleted: false }],
    sync_token: 'token',
  },
  canonical:
    '{"api":"20200115","items":[{"content":"ciphertext","content_type":"Note","deleted":false,"uuid":"note-1"}],"sync_token":"token"}',
  digest: 'e4c8512aab76dd9aca235be947afc7829b5ea652db89f93f672f69648a5e885e',
})

/** Current JSON-wire fixture, same source. */
const CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR = Object.freeze({
  body: {
    api: '20240226',
    items: [
      {
        uuid: 'note-1',
        content: 'ciphertext',
        content_type: 'Note',
        deleted: false,
        created_at: '2026-08-18T12:34:56.789Z',
        updated_at_timestamp: 1_787_056_496_789,
      },
    ],
    sync_token: 'token',
    limit: 150,
    shared_vault_uuids: ['vault-1'],
  },
  canonical:
    '{"api":"20240226","items":[{"content":"ciphertext","content_type":"Note","created_at":"2026-08-18T12:34:56.789Z","deleted":false,"updated_at_timestamp":1787056496789,"uuid":"note-1"}],"limit":150,"shared_vault_uuids":["vault-1"],"sync_token":"token"}',
  digest: 'ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61',
})

// ---------------------------------------------------------------------------
// Pure predicates the live run and --self-test both exercise, so a change to
// the pass/fail rule cannot drift between the two.
// ---------------------------------------------------------------------------

/** Defect fix: operations are negotiated on AUTHENTICATED, never the ticket. */
function operationsIncludeSyncItems(operations) {
  return Array.isArray(operations) && operations.includes('SYNC_ITEMS')
}

const isCommittedStatusAnswer = (frame) => frame.type !== 'ERROR' && frame.payload?.status === 'COMMITTED'
const hasResultTooLargeCode = (frame) => frame.payload?.code === 'RESULT_TOO_LARGE'
const omitsResultEntirely = (frame) => frame.payload?.result === undefined
const matchesCommandIdentity = (frame, commandId, digest) => frame.commandId === commandId && frame.digest === digest

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

/**
 * Pre-populate the account over plain HTTP -- no `x-sync-command-id`/
 * `-digest` headers, so this is NOT the durable-command path and is not
 * subject to the WebSocket lane's 512 KiB cap at all. This is what makes the
 * corpus possible: a real account with years of notes, or a bulk import,
 * looks exactly like this before it ever opens a realtime socket.
 */
async function seedExistingItems(accessToken, count) {
  const items = Array.from({ length: count }, () => makeNote())
  const r = await api('POST', '/v1/items', {
    token: accessToken,
    body: { api: API, items, compute_integrity: false },
  })
  if (r.status !== 200) {
    throw new Error(`seed sync failed: ${r.status} ${r.text.slice(0, 300)}`)
  }
  const saved = r.json?.saved_items ?? []
  check('the pre-populating HTTP sync saves every seed item', saved.length === count, {
    saved: saved.length,
    expected: count,
  })
  return items
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

  // 1. Ticket through the front door. It authenticates the lane; it carries
  //    NO `operations` field (see the docstring) so it is not consulted for
  //    negotiation.
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
  check('ticket issued through the front door', typeof ticket.ticket === 'string')

  // 2. Authenticate the lane, then read the NEGOTIATED operations off the
  //    AUTHENTICATED frame -- the fix for defect 1.
  const socket = await openSyncSocket()
  socket.ws.send(JSON.stringify(syncFrame('AUTH', { ticket: ticket.ticket, deviceId: DEVICE_ID }, { sequence: 0 })))
  const authenticated = await waitForFrame(socket, (f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR', 10_000)
  check('sync lane authenticates', authenticated?.type === 'AUTHENTICATED', authenticated ?? socket.close)
  if (authenticated?.type !== 'AUTHENTICATED') {
    console.log(`\nE2E FAILED (${failures})`)
    process.exit(1)
  }

  const operations = Array.isArray(authenticated.payload?.operations) ? authenticated.payload.operations : []
  if (!operationsIncludeSyncItems(operations)) {
    const reason =
      `AUTHENTICATED advertised operations [${operations.join(', ')}]; SYNC_ITEMS needs a bound durable ` +
      'command port -- SERVICE_PROXY_TYPE=grpc (+SYNCING_SERVER_GRPC_URL) for the api-gateway topology, or ' +
      'the single-container/home-server build, which binds it unconditionally'
    socket.ws.close(1000)
    if (REQUIRE_SYNC_ITEMS) {
      console.error('REQUIRED: SYNC_ITEMS not negotiated -- ' + reason)
      process.exit(1)
    }
    skip('oversized SYNC_ITEMS result', reason)
    console.log(failures === 0 ? '\nE2E PASSED (SYNC_ITEMS not negotiated)' : `\nE2E FAILED (${failures})`)
    process.exit(failures === 0 ? 0 : 1)
  }

  // 3. Pre-populate a corpus over HTTP large enough that pulling it all back
  //    cannot fit in one frame. This is the actual trigger for an oversized
  //    RESULT -- an oversized REQUEST would hit the (separate, symmetric)
  //    INGRESS cap and never reach this code at all.
  const seedItems = await seedExistingItems(accessToken, ITEM_COUNT)
  const seedContentBytes = seedItems.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0)
  check(
    'the pre-populated corpus is large enough that pulling it back cannot fit one frame',
    seedContentBytes > MAX_SYNC_FRAME_BYTES,
    { seedContentBytes, MAX_SYNC_FRAME_BYTES },
  )

  // 4. A SMALL `SYNC_ITEMS` PULL command (`items: []`, no `sync_token`) whose
  //    COMMITTED result -- the whole corpus pulled back -- cannot fit one
  //    frame.
  const pullBody = { api: API, items: [], limit: PULL_LIMIT, compute_integrity: false }
  const digest = commandDigest(pullBody)
  const requestId = `req-${randomUUID()}`
  const commandId = `cmd-${randomUUID()}`
  const command = syncFrame(
    'COMMAND',
    { command: 'SYNC_ITEMS', body: pullBody },
    { sequence: 1, requestId, commandId, digest },
  )
  const commandBytes = Buffer.byteLength(JSON.stringify(command), 'utf8')
  check(
    'the triggering COMMAND frame stays well under the ingress cap (the trigger is an oversized RESULT, not an oversized REQUEST)',
    commandBytes < MAX_SYNC_FRAME_BYTES,
    { commandBytes, MAX_SYNC_FRAME_BYTES },
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

  // C5: the oversized COMMITTED answer is a payload-less STATUS, never an
  // ERROR (an ERROR RESULT_TOO_LARGE is reserved for a large non-COMMITTED
  // egress frame; an oversized INGRESS frame never reaches an app-level
  // frame at all -- the raw socket message is rejected and the connection is
  // closed 1009 before parsing).
  check('the oversized answer is not an ERROR frame', answer.type !== 'ERROR', answer.payload?.code)
  check('the answer reports COMMITTED', isCommittedStatusAnswer(answer), answer.payload?.status)
  check('the answer carries code RESULT_TOO_LARGE', hasResultTooLargeCode(answer), answer.payload?.code)
  check('the answer omits the result entirely', omitsResultEntirely(answer))
  check('the answer keeps the command identity', matchesCommandIdentity(answer, commandId, digest), {
    commandId: answer.commandId,
    digest: answer.digest,
  })
  // The socket stays usable: an oversized RESULT is not a transport failure.
  check('the socket stays open after an oversized result', socket.close === undefined, socket.close)

  // 5. HTTP replay of the SAME command returns the journaled result.
  const replay = await api('POST', '/v1/items', {
    token: accessToken,
    body: pullBody,
    headers: { 'x-sync-command-id': commandId, 'x-sync-command-digest': digest },
  })
  check('HTTP replay of the journaled command succeeds', replay.status === 200, replay.status)
  const replayBytes = Buffer.byteLength(replay.text, 'utf8')
  check(
    'the journaled result actually exceeds the socket frame cap (the trigger really was oversized, not just reported so)',
    replayBytes > MAX_SYNC_FRAME_BYTES,
    { replayBytes, MAX_SYNC_FRAME_BYTES },
  )
  check('the replay is served from the durable command journal', replay.json?.command?.status === 'committed', {
    command: replay.json?.command,
  })
  const retrieved = replay.json?.retrieved_items ?? []
  check('HTTP replay returns the whole pulled corpus', retrieved.length === ITEM_COUNT, {
    returned: retrieved.length,
    expected: ITEM_COUNT,
  })
  const retrievedUuids = new Set(retrieved.map((item) => item.uuid))
  check(
    'every item pulled over the lane is present in the replay',
    seedItems.every((item) => retrievedUuids.has(item.uuid)),
  )
  // Idempotent: the journal answers the second replay with the same result.
  const again = await api('POST', '/v1/items', {
    token: accessToken,
    body: pullBody,
    headers: { 'x-sync-command-id': commandId, 'x-sync-command-digest': digest },
  })
  check('the replay is idempotent', again.status === 200 && (again.json?.retrieved_items ?? []).length === ITEM_COUNT, {
    status: again.status,
    returned: (again.json?.retrieved_items ?? []).length,
  })

  socket.ws.close(1000)
  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// --self-test: offline proof that the canonicalization, the negotiation
// check and the oversized-answer shape rule all accept a GOOD fixture and
// reject the corresponding BAD ones, with no stack and no Docker.
// ---------------------------------------------------------------------------

function selfTestCommandDigest() {
  for (const vector of [SYNC_COMMAND_DIGEST_TEST_VECTOR, CURRENT_SYNC_COMMAND_DIGEST_TEST_VECTOR]) {
    check(
      `canonical JSON matches the published vector (api ${vector.body.api})`,
      canonicalSyncJson(vector.body) === vector.canonical,
    )
    check(`digest matches the published vector (api ${vector.body.api})`, commandDigest(vector.body) === vector.digest)
  }
  // The exact regression class this script itself had: a plain
  // JSON.stringify digest (declaration order) disagrees with the canonical
  // (sorted-key) digest the gateway and the syncing server both assert.
  const reordered = { b: 1, a: 2 }
  check(
    'canonicalization sorts keys where JSON.stringify would not',
    canonicalSyncJson(reordered) === '{"a":2,"b":1}' && JSON.stringify(reordered) !== canonicalSyncJson(reordered),
  )
}

function selfTestOperationsNegotiated() {
  check(
    'good AUTHENTICATED (SYNC_ITEMS present) is read as negotiated',
    operationsIncludeSyncItems(['SYNC_ITEMS', 'FILES_V1']),
  )
  check(
    'bad AUTHENTICATED (SYNC_ITEMS absent) is read as NOT negotiated',
    !operationsIncludeSyncItems(['FILES_V1', 'INVITE_EVENTS']),
  )
  check(
    'bad AUTHENTICATED (no operations field at all) is read as NOT negotiated',
    !operationsIncludeSyncItems(undefined),
  )
  // The exact regression this script had: a ticket response carries no
  // `operations` field, so reading it there must never be mistaken for a
  // legitimate "negotiated" answer.
  check(
    'a ticket-shaped object (no operations field) is read as NOT negotiated',
    !operationsIncludeSyncItems({}.operations),
  )
}

function selfTestOversizedAnswerShape() {
  const commandId = 'cmd-1'
  const digest = 'a'.repeat(64)
  const good = { type: 'STATUS', commandId, digest, payload: { status: 'COMMITTED', code: 'RESULT_TOO_LARGE' } }
  check('good frame: reports COMMITTED', isCommittedStatusAnswer(good))
  check('good frame: carries code RESULT_TOO_LARGE', hasResultTooLargeCode(good))
  check('good frame: omits the result entirely', omitsResultEntirely(good))
  check('good frame: matches the command identity', matchesCommandIdentity(good, commandId, digest))

  const badError = { type: 'ERROR', commandId, digest, payload: { code: 'RESULT_TOO_LARGE' } }
  check('bad frame (ERROR type) is rejected as a COMMITTED answer', !isCommittedStatusAnswer(badError))

  const badHasResult = {
    type: 'STATUS',
    commandId,
    digest,
    payload: { status: 'COMMITTED', code: 'RESULT_TOO_LARGE', result: { retrieved_items: [] } },
  }
  check('bad frame (result key present) is rejected', !omitsResultEntirely(badHasResult))

  const badCode = { type: 'STATUS', commandId, digest, payload: { status: 'COMMITTED', code: 'SOMETHING_ELSE' } }
  check('bad frame (wrong code) is rejected', !hasResultTooLargeCode(badCode))

  const badStatus = { type: 'STATUS', commandId, digest, payload: { status: 'ACCEPTED', code: 'RESULT_TOO_LARGE' } }
  check('bad frame (wrong status) is rejected', !isCommittedStatusAnswer(badStatus))

  const badIdentity = {
    type: 'STATUS',
    commandId: 'cmd-2',
    digest: 'b'.repeat(64),
    payload: { status: 'COMMITTED', code: 'RESULT_TOO_LARGE' },
  }
  check('bad frame (wrong command identity) is rejected', !matchesCommandIdentity(badIdentity, commandId, digest))
}

function selfTest() {
  console.log('sync-items-oversized --self-test')
  selfTestCommandDigest()
  selfTestOperationsNegotiated()
  selfTestOversizedAnswerShape()
  console.log(failures === 0 ? '\nSELF-TEST PASSED' : `\nSELF-TEST FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  main().catch((e) => {
    console.error('E2E ERROR:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
