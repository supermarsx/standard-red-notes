/**
 * Cross-device realtime push ROUND TRIP against the LIVE stack.
 *
 * This is the t90 `probe-g` pattern promoted to a real e2e: register an
 * account, open a SECOND session's legacy socket, make 20 spaced saves from
 * the first session, and prove every save produced a push on the other
 * device's socket. It is the only test that walks the whole chain —
 *
 *   save -> syncing-server -> WEB_SOCKET_MESSAGE_REQUESTED -> SNS/SQS
 *        -> gateway worker -> legacy socket on the other device
 *
 * — so a broken queue, a filtered subscription, a dead worker or a swallowed
 * event all show up here and nowhere else in CI.
 *
 * PUSH PAYLOAD MODES. `WEBSOCKET_SYNC_PUSH_ENABLED` now defaults to OFF, so a
 * push carries a bare `ITEMS_CHANGED_ON_SERVER` notification with no items.
 * That is the default expectation. When the flag is the exact string `true`
 * the server inlines `SYNC_ITEMS_PUSHED` payloads instead, and this script
 * then accounts by item uuid, which is strictly stronger. It detects which
 * mode it is in from the frames themselves rather than reading the flag, so it
 * is correct on either side of the switch.
 *
 * Usage (host, against the public front door):
 *   REQUIRE_GATEWAY=1 yarn node e2e/push-roundtrip.e2e.mjs
 *
 * Usage (inside the server container):
 *   docker compose exec -T -e REQUIRE_GATEWAY=1 \
 *     -e BASE=http://127.0.0.1:3000 -e WS_BASE=ws://127.0.0.1:3000 \
 *     server yarn node packages/websocket-gateway/e2e/push-roundtrip.e2e.mjs
 *
 * Offline self-check of the parsing and accounting (no stack, no Docker):
 *   yarn node e2e/push-roundtrip.e2e.mjs --self-test
 *
 * Env: BASE, WS_BASE, ORIGIN, REQUIRE_GATEWAY, GATEWAY_HEALTH_PATH,
 *      PUSH_SAVES, PUSH_SAVE_INTERVAL_MS, PUSH_SETTLE_MS, PUSH_LATE_SETTLE_MS.
 */
import { WebSocket, WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://localhost:3001'
const WS_BASE = process.env.WS_BASE ?? 'ws://localhost:3001'
const ORIGIN = process.env.ORIGIN ?? BASE
// The single origin every HTTP call goes through. It is a binding rather than a
// constant only so --self-test can point the same code at an in-process
// stand-in; the live path never reassigns it.
let activeBase = BASE
const GATEWAY_HEALTH_PATH = process.env.GATEWAY_HEALTH_PATH ?? '/healthcheck/readiness'
const REQUIRE_GATEWAY = process.env.REQUIRE_GATEWAY === '1'
const API = '20200115'

const SAVES = Number(process.env.PUSH_SAVES ?? '20')
const SAVE_INTERVAL_MS = Number(process.env.PUSH_SAVE_INTERVAL_MS ?? '1000')
// The first window is the one the assertion is about; the second only exists so
// stragglers can be REPORTED (lateArrivals) instead of silently passing.
const SETTLE_MS = Number(process.env.PUSH_SETTLE_MS ?? '10000')
const LATE_SETTLE_MS = Number(process.env.PUSH_LATE_SETTLE_MS ?? '20000')

const nowMs = () => Number(process.hrtime.bigint()) / 1e6
const sleep = (t) => new Promise((r) => setTimeout(r, t))
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

let failures = 0
export function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  else {
    console.log(`  FAIL - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
    failures++
  }
}

// ---------------------------------------------------------------------------
// Parsing and accounting. Pure, and exercised directly by --self-test.
// ---------------------------------------------------------------------------

/** Parse one collected frame record; undefined when it is not JSON. */
export function parseFrame(frame) {
  try {
    return JSON.parse(frame.raw)
  } catch {
    return undefined
  }
}

const PUSH_TYPES = new Set(['ITEMS_CHANGED_ON_SERVER', 'SYNC_ITEMS_PUSHED'])

/**
 * Reduce the frames observed on the listening socket to what was actually
 * pushed. In payload mode a push names the items it covers, so accounting is by
 * uuid and duplicate deliveries collapse. In notification mode the frame is
 * bare, so a push is worth exactly one unit and nothing can be de-duplicated.
 */
export function tally(frames) {
  const types = new Set()
  const uuids = new Set()
  let pushFrames = 0
  let payloadFrames = 0
  for (const frame of frames) {
    const parsed = parseFrame(frame)
    if (!parsed || typeof parsed.type !== 'string') continue
    types.add(parsed.type)
    if (!PUSH_TYPES.has(parsed.type)) continue
    pushFrames++
    const items = parsed.payload?.items
    if (Array.isArray(items) && items.length > 0) {
      payloadFrames++
      for (const item of items) {
        if (item && typeof item.uuid === 'string') uuids.add(item.uuid)
      }
    }
  }
  const mode = payloadFrames > 0 ? 'payload' : 'notification'
  return {
    mode,
    types: [...types].sort(),
    pushFrames,
    uuids,
    // What the run is allowed to count as "arrived".
    observed: mode === 'payload' ? uuids.size : pushFrames,
  }
}

/**
 * Build the run record. `framesAt10s`/`framesAt30s` are cumulative slices taken
 * from the same socket, so `lateArrivals` is what only the wider window caught.
 */
export function summarize(saves, framesAtSettle, framesAtLate) {
  const early = tally(framesAtSettle)
  const late = tally(framesAtLate)
  const missingAtLate =
    late.mode === 'payload' ? saves.filter((s) => !late.uuids.has(s.uuid)).map((s) => s.uuid) : []
  return {
    sent: saves.length,
    httpStatuses: [...new Set(saves.map((s) => s.status))].sort(),
    mode: late.mode,
    types: late.types,
    receivedAtSettle: early.observed,
    receivedAtLate: late.observed,
    lateArrivals: late.observed - early.observed,
    missingAtLate,
  }
}

/** The pass/fail rule, separated so the self-test can assert it directly. */
export function verdict(summary, expected) {
  return {
    allSavesAccepted: summary.httpStatuses.length === 1 && summary.httpStatuses[0] === 200,
    everySavePushedInWindow: summary.receivedAtSettle >= expected,
    noLateArrivals: summary.lateArrivals === 0,
    nothingMissing: summary.missingAtLate.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Live HTTP + socket plumbing
// ---------------------------------------------------------------------------

async function api(method, path, { body, token, headers } = {}) {
  const res = await fetch(activeBase + path, {
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
  // api 20200115 answers `{ meta, data }`; unwrap so callers read the payload.
  const json = raw && typeof raw === 'object' && 'data' in raw && 'meta' in raw ? raw.data : raw
  return { status: res.status, json, text }
}

function newAccount() {
  return {
    email: `e2e-push-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`,
    // The server only ever sees the derived server password, so any opaque
    // string works for a raw-HTTP probe.
    password: randomBytes(32).toString('hex'),
  }
}

async function register({ email, password }) {
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
  return r.json
}

async function login({ email, password }) {
  const verifier = randomBytes(32).toString('hex')
  // auth SignIn hashes to a HEX STRING first, so the challenge is base64url
  // over that hex text, not over the raw digest bytes.
  const challenge = b64url(Buffer.from(createHash('sha256').update(verifier).digest('hex'), 'utf8'))
  const params = await api('POST', '/v2/login-params', { body: { email, code_challenge: challenge, api: API } })
  if (params.status !== 200) throw new Error(`login-params failed: ${params.status}`)
  const r = await api('POST', '/v1/login', {
    body: { email, password, code_verifier: verifier, api: API, ephemeral: false },
  })
  if (r.status !== 200 || !r.json?.session?.access_token) {
    throw new Error(`login failed: ${r.status} ${r.text.slice(0, 300)}`)
  }
  return r.json
}

async function mintLegacyToken(accessToken) {
  const r = await api('POST', '/v1/sockets/tokens', { token: accessToken, body: {} })
  const token = r.json?.token ?? r.json?.data?.token
  if (r.status !== 200 || typeof token !== 'string') {
    throw new Error(`mint failed: ${r.status} ${r.text.slice(0, 300)}`)
  }
  return token
}

/** Open the legacy socket. Contract C13 pins the lane to the exact `/sockets`. */
function connectLegacy(wsBase, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/sockets?authToken=${encodeURIComponent(token)}`, { origin: ORIGIN })
    const state = { ws, frames: [], close: undefined }
    ws.on('message', (data) => state.frames.push({ at: nowMs(), raw: data.toString() }))
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString() }
    })
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)))
    ws.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('ws open timeout')), 10_000)
  })
}

function makeNote() {
  const iso = new Date().toISOString()
  return {
    uuid: randomUUID(),
    content_type: 'Note',
    content: '004:' + randomBytes(256).toString('base64'),
    enc_item_key: '004:' + randomBytes(72).toString('base64'),
    items_key_id: '00000000-0000-4000-8000-00000000abcd',
    created_at: iso,
    updated_at: iso,
    deleted: false,
  }
}

async function saveNote(accessToken, note, syncToken) {
  const r = await api('POST', '/v1/items', {
    token: accessToken,
    body: { api: API, items: [note], sync_token: syncToken, limit: 150, compute_integrity: false },
  })
  return r
}

/**
 * The round trip itself, parameterised so --self-test can drive it against an
 * in-process stand-in with the same call shapes.
 */
export async function runRoundTrip({ wsBase, saves, saveIntervalMs, settleMs, lateSettleMs }) {
  const account = newAccount()
  const registration = await register(account)
  const second = await login(account)
  const writerToken = registration.session.access_token
  const listenerToken = second.session.access_token

  const socket = await connectLegacy(wsBase, await mintLegacyToken(listenerToken))
  // Let the gateway finish registering the connection before the first save.
  await sleep(500)
  const before = socket.frames.length

  const performed = []
  let syncToken
  for (let i = 0; i < saves; i++) {
    const note = makeNote()
    const r = await saveNote(writerToken, note, syncToken)
    syncToken = r.json?.sync_token ?? syncToken
    performed.push({ i, uuid: note.uuid, status: r.status })
    if (i < saves - 1) await sleep(saveIntervalMs)
  }

  await sleep(settleMs)
  const framesAtSettle = socket.frames.slice(before)
  await sleep(lateSettleMs)
  const framesAtLate = socket.frames.slice(before)

  socket.ws.close(1000)
  return { summary: summarize(performed, framesAtSettle, framesAtLate), userUuid: registration.user?.uuid }
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

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

  const { summary } = await runRoundTrip({
    wsBase: WS_BASE,
    saves: SAVES,
    saveIntervalMs: SAVE_INTERVAL_MS,
    settleMs: SETTLE_MS,
    lateSettleMs: LATE_SETTLE_MS,
  })
  console.log('  push mode:', summary.mode, '| frame types:', JSON.stringify(summary.types))
  console.log('  lateArrivals:', summary.lateArrivals)

  const v = verdict(summary, SAVES)
  check('every save was accepted', v.allSavesAccepted, { httpStatuses: summary.httpStatuses })
  check(`all ${SAVES} saves pushed within ${SETTLE_MS} ms`, v.everySavePushedInWindow, {
    receivedAtSettle: summary.receivedAtSettle,
    expected: SAVES,
  })
  check('no push arrived only after the window', v.noLateArrivals, { lateArrivals: summary.lateArrivals })
  check('no save went unpushed', v.nothingMissing, { missing: summary.missingAtLate.length })

  console.log('RESULTS_JSON ' + JSON.stringify(summary))
  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// --self-test: offline proof that the parser, the accounting and the socket
// plumbing behave, with no stack and no Docker.
// ---------------------------------------------------------------------------

const frame = (value) => ({ at: 0, raw: typeof value === 'string' ? value : JSON.stringify(value) })
const notification = () => frame({ type: 'ITEMS_CHANGED_ON_SERVER', payload: {} })
const payloadPush = (...uuids) => frame({ type: 'SYNC_ITEMS_PUSHED', payload: { items: uuids.map((uuid) => ({ uuid })) } })

function selfTestAccounting() {
  // Notification mode: bare frames, one unit each, nothing de-duplicated.
  const notif = tally([notification(), notification(), frame('not json'), frame({ type: 'PING' })])
  check('notification mode counts push frames', notif.mode === 'notification' && notif.observed === 2, notif.observed)
  check('unparseable frames are ignored', notif.types.includes('PING') && !notif.types.includes('undefined'))

  // Payload mode: accounting by uuid, so a redelivery collapses.
  const payload = tally([payloadPush('a', 'b'), payloadPush('b')])
  check('payload mode counts distinct uuids', payload.mode === 'payload' && payload.observed === 2, payload.observed)

  // A payload push and a bare notification in the same run stay in payload mode.
  const mixed = tally([notification(), payloadPush('a')])
  check('any payload frame selects payload mode', mixed.mode === 'payload' && mixed.observed === 1)

  // Late arrival: the wider window saw one more than the narrow one.
  const saves = [{ uuid: 'a', status: 200 }, { uuid: 'b', status: 200 }]
  const late = summarize(saves, [notification()], [notification(), notification()])
  check('lateArrivals is the window difference', late.lateArrivals === 1, late.lateArrivals)
  check('a late arrival fails the verdict', verdict(late, 2).noLateArrivals === false)
  check('a short window fails the verdict', verdict(late, 2).everySavePushedInWindow === false)

  // Clean run: both windows saw everything.
  const clean = summarize(saves, [notification(), notification()], [notification(), notification()])
  const cleanVerdict = verdict(clean, 2)
  check(
    'a complete run passes every rule',
    cleanVerdict.allSavesAccepted &&
      cleanVerdict.everySavePushedInWindow &&
      cleanVerdict.noLateArrivals &&
      cleanVerdict.nothingMissing,
  )

  // Payload mode names what never arrived; notification mode cannot and must
  // not pretend it can.
  const dropped = summarize(saves, [payloadPush('a')], [payloadPush('a')])
  check('payload mode names the missing item', dropped.missingAtLate.join(',') === 'b', dropped.missingAtLate)
  check('notification mode claims no named misses', clean.missingAtLate.length === 0)

  // A rejected save must fail the run even when every push arrived.
  const rejected = summarize([{ uuid: 'a', status: 500 }], [notification()], [notification()])
  check('a non-200 save fails the verdict', verdict(rejected, 1).allSavesAccepted === false)
}

/** Minimal in-process stand-in for the front door: enough surface to drive runRoundTrip. */
function startStandInStack({ pushMode, lateFrames = 0 }) {
  const sockets = new Set()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const session = { access_token: 'tok-' + randomUUID() }
      if (req.url === '/healthcheck/readiness') return send(200, { status: 'ok' })
      if (req.url === '/v1/users') return send(200, { meta: {}, data: { user: { uuid: 'u1' }, session } })
      if (req.url === '/v2/login-params') return send(200, { meta: {}, data: { key_params: {} } })
      if (req.url === '/v1/login') return send(200, { meta: {}, data: { user: { uuid: 'u1' }, session } })
      if (req.url === '/v1/sockets/tokens') return send(200, { meta: {}, data: { token: 'conn-' + randomUUID() } })
      if (req.url === '/v1/items') {
        const parsed = JSON.parse(body)
        const uuid = parsed.items[0].uuid
        // The stand-in pushes the way the real gateway would in each mode.
        const payload = pushMode === 'payload' ? { items: [{ uuid }] } : {}
        const type = pushMode === 'payload' ? 'SYNC_ITEMS_PUSHED' : 'ITEMS_CHANGED_ON_SERVER'
        for (const socket of sockets) socket.send(JSON.stringify({ type, payload }))
        return send(200, { meta: {}, data: { sync_token: 'st-1' } })
      }
      send(404, {})
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    // Enforce the same C13 pin the real lane does, so a regression in the
    // script's URL construction is caught here rather than only in CI.
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/sockets' || !url.searchParams.get('authToken')) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
    })
  })
  return {
    server,
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    emitLate: () => {
      for (let i = 0; i < lateFrames; i++) {
        for (const socket of sockets) socket.send(JSON.stringify({ type: 'ITEMS_CHANGED_ON_SERVER', payload: {} }))
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function selfTestRoundTrip(pushMode) {
  const stack = startStandInStack({ pushMode })
  const port = await stack.listen()
  // Point the module's single HTTP base at the stand-in for the duration.
  const restore = rebindBase(`http://127.0.0.1:${port}`)
  try {
    const { summary } = await runRoundTrip({
      wsBase: `ws://127.0.0.1:${port}`,
      saves: 3,
      saveIntervalMs: 5,
      settleMs: 250,
      lateSettleMs: 250,
    })
    const v = verdict(summary, 3)
    check(
      `round trip through the stand-in passes in ${pushMode} mode`,
      v.allSavesAccepted && v.everySavePushedInWindow && v.noLateArrivals && v.nothingMissing,
      summary,
    )
    check(`stand-in run reports ${pushMode} mode`, summary.mode === pushMode, summary.mode)
  } finally {
    restore()
    await stack.close()
  }
}

function rebindBase(next) {
  const previous = activeBase
  activeBase = next
  return () => {
    activeBase = previous
  }
}

async function selfTest() {
  console.log('push-roundtrip --self-test')
  selfTestAccounting()
  await selfTestRoundTrip('notification')
  await selfTestRoundTrip('payload')
  console.log(failures === 0 ? '\nSELF-TEST PASSED' : `\nSELF-TEST FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) {
  await selfTest()
} else {
  main().catch((e) => {
    console.error('E2E ERROR:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
