/**
 * In-place session-credential refresh (REAUTH) and the stale/revoked split,
 * measured on a LIVE stack through the public front door.
 *
 * WHY THIS EXISTS
 *
 * A socket authenticates once and then replays the credential captured at
 * ticket mint for its whole life. `53fd0129` + `f5d4733b` let a live socket
 * adopt a current credential; `2d3a6eac` made the stale/revoked verdict a single
 * classification shared by sync, collaboration and both files authorizers, keyed
 * on auth's STATUS and never on its error TAG.
 *
 * That last point is the one that cannot be proven in a unit test alone. A plain
 * sign-out deletes the session row and writes NO `revoked_session` record, so
 * LOGOUT ANSWERS 401 `invalid-auth`, not 401 `revoked-session`. A classifier
 * keyed on the tag would read a logout as a refreshable stale token and leave a
 * live authenticated socket behind. This script plants a real logout against a
 * real socket and requires the lane to END.
 *
 * It also pins `357487cb`: a forbidden RPC path answers its own
 * `RPC_PATH_FORBIDDEN`, not the `BACKEND_ERROR` a dead backend reports, and does
 * not echo the path it refused.
 *
 * THE THREE CREDENTIAL WINDOWS, and why all three are measured
 *
 *   fresh                         200 -> adopted
 *   rotated, inside auth's
 *   COOLDOWN_SESSION_TOKENS_TTL   498 `expired-access-token` -> STALE
 *   rotated, cooldown expired     401 `invalid-auth`         -> REVOKED
 *   signed out                    401 `invalid-auth`         -> REVOKED
 *
 * The sync lane is deliberately LENIENT and reports SESSION_STALE on both 401
 * and 498 (`validate()`'s recovery hint), while collaboration and files use the
 * SESSION verdict and so answer SESSION_STALE only on 498 and keep the
 * unqualified NOT_AUTHORIZED on 401. The script measures the disagreement
 * instead of assuming it, which is why it holds a second socket that never
 * refreshes.
 *
 * CONTROLS. Every probe has a planted condition that must make it fail:
 *
 *   --self-test           pure predicates, negatives included, no stack.
 *   cookie half           a bearer with no cookie must not mint a ticket, so a
 *                         cookie session's cookie half is load-bearing in this
 *                         run and nothing below was really measured on a bearer.
 *   REAUTH positive       the SAME socket, the SAME frame shape, a LIVE session:
 *                         must answer REAUTHENTICATED and stay open. Without
 *                         this the sign-out row could pass on a socket that
 *                         closes for any reason at all.
 *   allowed RPC route     an allowed path answers RPC_RESPONSE 200 and an
 *                         allowed-but-missing path answers RPC_RESPONSE 404 —
 *                         so RPC_PATH_FORBIDDEN is specific to the block list
 *                         and not what this lane says about everything.
 *   genuine denial        the collaboration denial on a note the account does
 *                         not own is captured BEFORE any rotation and compared
 *                         byte-for-byte afterwards.
 *   ws open is not a pass closes are read after a settle delay, never from the
 *                         `open` event: `ws` resolves `open` at the HTTP 101,
 *                         before a 1008 close frame can arrive.
 *
 * Usage (host, public front door):
 *   BASE=http://127.0.0.1:3061 yarn node e2e/session-reauth.e2e.mjs
 *   yarn node e2e/session-reauth.e2e.mjs --self-test
 *
 * Env: BASE, WS_BASE, ORIGIN, COOLDOWN_WAIT_MS (default 125000; auth's
 *      COOLDOWN_SESSION_TOKENS_TTL defaults to 120 s), SKIP_COOLDOWN=1 to skip
 *      the post-cooldown window (it is then reported NOT VERIFIED, never
 *      silently dropped), RESULT_JSON.
 */
import { WebSocket } from 'ws'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3001'
const WS_BASE = process.env.WS_BASE ?? BASE.replace(/^http/u, 'ws')
const ORIGIN = process.env.ORIGIN ?? BASE
const COOLDOWN_WAIT_MS = Number(process.env.COOLDOWN_WAIT_MS ?? '125000')
const SKIP_COOLDOWN = process.env.SKIP_COOLDOWN === '1'
const RESULT_JSON = process.env.RESULT_JSON ?? ''
const API = '20200115'
const CLOSE_SETTLE_MS = 2000

const sleep = (t) => new Promise((r) => setTimeout(r, t))
let failures = 0
let controlFailures = 0
const unverified = []
const result = { base: BASE }

function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  else {
    console.log(`  FAIL - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
    failures++
  }
  return Boolean(cond)
}

function control(name, probeRejected, detail) {
  if (probeRejected) console.log(`  ctrl ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  else {
    console.log(
      `  CTRL FAIL - ${name} (the probe could not detect the planted break)${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`,
    )
    controlFailures++
  }
}

function notVerified(what, why) {
  unverified.push({ what, why })
  console.log(`  ----  NOT VERIFIED - ${what}: ${why}`)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function raw(method, path, { body, token, cookie, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const envelope = parsed && typeof parsed === 'object' && 'data' in parsed && 'meta' in parsed
  return {
    status: res.status,
    json: envelope ? parsed.data : parsed,
    text,
    setCookie: res.headers.getSetCookie?.() ?? [],
  }
}

const cookieHeaderFrom = (setCookie) =>
  setCookie
    .map((entry) => entry.split(';', 1)[0].trim())
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ')

async function register() {
  const email = `t107-reauth-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
  const password = randomBytes(32).toString('hex')
  const r = await raw('POST', '/v1/users', {
    body: {
      email,
      password,
      api: '20240226',
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
  return {
    email,
    password,
    token: r.json.session.access_token,
    refresh: r.json.session.refresh_token,
    cookie: cookieHeaderFrom(r.setCookie),
    cookieCount: r.setCookie.length,
  }
}

// ---------------------------------------------------------------------------
// Protocol v1
// ---------------------------------------------------------------------------
function canonicalSyncJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalSyncJson).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(value[key])}`).join(',')}}`
}
const commandDigest = (body) => createHash('sha256').update(canonicalSyncJson(body), 'utf8').digest('hex')
const SYNC_COMMAND_DIGEST_TEST_VECTOR = Object.freeze({
  body: {
    api: '20200115',
    items: [{ uuid: 'note-1', content: 'ciphertext', content_type: 'Note', deleted: false }],
    sync_token: 'token',
  },
  digest: 'e4c8512aab76dd9aca235be947afc7829b5ea652db89f93f672f69648a5e885e',
})

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

function makeNote(bytes = 256) {
  const iso = new Date().toISOString()
  return {
    uuid: randomUUID(),
    content_type: 'Note',
    content: '004:' + randomBytes(bytes).toString('base64'),
    enc_item_key: '004:' + randomBytes(72).toString('base64'),
    items_key_id: '00000000-0000-4000-8000-00000000abcd',
    created_at: iso,
    updated_at: iso,
    deleted: false,
  }
}

// ---------------------------------------------------------------------------
// Pure predicates, shared by the live run and --self-test.
// ---------------------------------------------------------------------------

/**
 * A refusal frame reduced to the parts a client branches on, with the volatile
 * correlation ids dropped, so two refusals can be compared BYTE FOR BYTE across
 * phases. Used for "a genuine policy denial is identical to before".
 */
export function refusalFingerprint(frame) {
  if (frame === undefined) return 'NO_FRAME'
  const payload = { ...(frame.payload ?? {}) }
  return JSON.stringify({ type: frame.type, payload })
}

/** The error code on a frame, or a stable token when there is no code at all. */
export function errorCodeOf(frame) {
  if (frame === undefined) return 'NO_FRAME'
  if (frame.type !== 'ERROR') return `NOT_AN_ERROR:${frame.type}`
  return typeof frame.payload?.code === 'string' ? frame.payload.code : 'NO_CODE'
}

/**
 * Whether a serialized frame leaks the path it refused. `RPC_PATH_FORBIDDEN`
 * must name a policy and never the request that tripped it, and the path comes
 * off a client frame — so neither the code, the message nor a stack may carry
 * it. Checked against the whole serialized frame, not just `payload.message`.
 */
export function framePathLeak(frame, path) {
  const serialized = JSON.stringify(frame ?? null)
  const segments = path.split('/').filter(Boolean)
  const leaked = [path, ...segments].filter((needle) => needle.length > 2 && serialized.includes(needle))
  return leaked
}

/** "Not lost and not applied twice": exactly one row for that uuid, no conflict. */
export function appliedExactlyOnce(retrievedItems, uuid, conflicts) {
  const copies = (Array.isArray(retrievedItems) ? retrievedItems : []).filter((item) => item?.uuid === uuid).length
  return { copies, conflicts, exactlyOnce: copies === 1 && conflicts === 0 }
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------
function openSyncSocket(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/sockets/sync`, { origin: ORIGIN, ...(cookie ? { headers: { cookie } } : {}) })
    const state = { ws, frames: [], close: undefined }
    ws.on('message', (data) => {
      try {
        state.frames.push(JSON.parse(data.toString()))
      } catch {
        state.frames.push({ type: 'UNPARSEABLE' })
      }
    })
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString() }
    })
    ws.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    // NOTE: `open` fires at the HTTP 101, BEFORE any close frame the gateway is
    // about to send. It is resolved here only so the AUTH frame can be written;
    // never treat it as evidence the socket was accepted.
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('sync socket open timeout')), 15_000)
  })
}

async function waitForFrame(state, predicate, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = state.frames.find(predicate)
    if (found) return found
    if (state.close) return undefined
    await sleep(25)
  }
  return undefined
}

async function mintTicket(credential, deviceId) {
  return raw('POST', '/v1/sockets/sync/ticket', {
    token: credential.token,
    cookie: credential.cookie || undefined,
    body: { deviceId },
  })
}

/** An authenticated socket, plus the census it negotiated. Sequence 0 is AUTH. */
async function authenticatedSocket(credential, deviceId) {
  const ticket = await mintTicket(credential, deviceId)
  if (ticket.status !== 200 || typeof ticket.json?.ticket !== 'string') {
    return { ticketStatus: ticket.status, socket: undefined }
  }
  const socket = await openSyncSocket(credential.cookie || undefined).catch(() => undefined)
  if (!socket) return { ticketStatus: ticket.status, socket: undefined }
  socket.ws.send(JSON.stringify(syncFrame('AUTH', { ticket: ticket.json.ticket, deviceId }, { sequence: 0 })))
  const authenticated = await waitForFrame(socket, (f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR', 20_000)
  if (authenticated?.type !== 'AUTHENTICATED') {
    return { ticketStatus: ticket.status, socket: undefined, authenticated }
  }
  return {
    ticketStatus: ticket.status,
    socket,
    seen: (authenticated.payload?.operations ?? []).filter((o) => typeof o === 'string'),
    sequence: 1,
  }
}

async function sendAndAwait(session, type, payload, matcher, { digest, timeoutMs = 25_000 } = {}) {
  const requestId = `req-${randomUUID()}`
  const commandId = `cmd-${randomUUID()}`
  session.socket.ws.send(
    JSON.stringify(syncFrame(type, payload, { sequence: session.sequence++, requestId, commandId, digest })),
  )
  const frame = await waitForFrame(session.socket, (f) => f.requestId === requestId && matcher(f), timeoutMs)
  return { frame, requestId, commandId }
}

const rpcMatcher = (f) => f.type === 'RPC_RESPONSE' || f.type === 'RPC_END' || f.type === 'ERROR'

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------
function selfTest() {
  console.log('session-reauth self-test (no stack)')

  check(
    'the published digest vector reproduces',
    commandDigest(SYNC_COMMAND_DIGEST_TEST_VECTOR.body) === SYNC_COMMAND_DIGEST_TEST_VECTOR.digest,
  )
  control(
    'the digest probe',
    commandDigest({ ...SYNC_COMMAND_DIGEST_TEST_VECTOR.body, sync_token: 'x' }) !==
      SYNC_COMMAND_DIGEST_TEST_VECTOR.digest,
  )

  check(
    'errorCodeOf reads a code',
    errorCodeOf({ type: 'ERROR', payload: { code: 'SESSION_STALE' } }) === 'SESSION_STALE',
  )
  check('errorCodeOf flags a non-error', errorCodeOf({ type: 'REAUTHENTICATED' }) === 'NOT_AN_ERROR:REAUTHENTICATED')
  check('errorCodeOf flags an absent frame', errorCodeOf(undefined) === 'NO_FRAME')
  check('errorCodeOf flags a codeless error', errorCodeOf({ type: 'ERROR', payload: {} }) === 'NO_CODE')

  const denial = {
    type: 'ERROR',
    requestId: 'req-a',
    commandId: 'cmd-a',
    payload: { code: 'NOT_AUTHORIZED', retryable: false },
  }
  const sameDenialLater = {
    type: 'ERROR',
    requestId: 'req-b',
    commandId: 'cmd-b',
    payload: { code: 'NOT_AUTHORIZED', retryable: false },
  }
  check(
    'a denial fingerprint ignores the correlation ids',
    refusalFingerprint(denial) === refusalFingerprint(sameDenialLater),
  )
  control(
    'the fingerprint probe sees a changed payload',
    refusalFingerprint(denial) !==
      refusalFingerprint({ ...denial, payload: { code: 'SESSION_STALE', retryable: true } }),
  )
  control(
    'the fingerprint probe sees an added payload field',
    refusalFingerprint(denial) !==
      refusalFingerprint({ ...denial, payload: { ...denial.payload, reason: 'read-only' } }),
  )

  check(
    'a clean refusal leaks no path',
    framePathLeak({ type: 'ERROR', payload: { code: 'RPC_PATH_FORBIDDEN' } }, '/v1/sessions').length === 0,
  )
  control(
    'the leak probe sees the whole path',
    framePathLeak({ type: 'ERROR', payload: { code: 'X', message: 'blocked /v1/sessions' } }, '/v1/sessions').length >
      0,
  )
  control(
    'the leak probe sees a single segment',
    framePathLeak({ type: 'ERROR', payload: { code: 'X', stack: 'at sessions handler' } }, '/v1/sessions').includes(
      'sessions',
    ),
  )

  const once = appliedExactlyOnce([{ uuid: 'a' }, { uuid: 'b' }], 'a', 0)
  check('exactly-once reads one copy', once.exactlyOnce === true && once.copies === 1)
  control(
    'the exactly-once probe sees a duplicate',
    appliedExactlyOnce([{ uuid: 'a' }, { uuid: 'a' }], 'a', 0).exactlyOnce === false,
  )
  control('the exactly-once probe sees a conflict', appliedExactlyOnce([{ uuid: 'a' }], 'a', 1).exactlyOnce === false)
  control('the exactly-once probe sees a lost write', appliedExactlyOnce([], 'a', 0).exactlyOnce === false)

  console.log(`\nself-test: ${failures} failures, ${controlFailures} control failures`)
  return failures === 0 && controlFailures === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== session-credential refresh + RPC_PATH_FORBIDDEN against ${BASE} ===\n`)

  const account = await register()
  const original = { token: account.token, cookie: account.cookie }
  check('the session is a COOKIE session (2: prefix)', String(account.token).startsWith('2:'), {
    prefix: String(account.token).slice(0, 2),
    cookies: account.cookieCount,
  })
  // CONTROL: without this, every row below could have been measured on the
  // bearer alone and would say nothing about a cookie session.
  const bearerOnly = await raw('POST', '/v1/sockets/sync/ticket', {
    token: account.token,
    body: { deviceId: 'ctrl-' + randomUUID() },
  })
  control('the cookie half is load-bearing (a bearer with no cookie cannot mint a ticket)', bearerOnly.status !== 200, {
    status: bearerOnly.status,
  })

  const deviceA = 't107-reauth-A-' + randomUUID()
  const deviceB = 't107-reauth-B-' + randomUUID()
  const deviceC = 't107-reauth-C-' + randomUUID()

  const a = await authenticatedSocket(original, deviceA)
  if (!a.socket) {
    check('socket A authenticates', false, { ticketStatus: a.ticketStatus, authenticated: a.authenticated })
    return 1
  }
  check('socket A authenticates', true, { census: [...a.seen].sort() })
  result.census = [...a.seen].sort()
  const hasSyncItems = a.seen.includes('SYNC_ITEMS')
  if (!hasSyncItems) notVerified('the SYNC_ITEMS rows', 'the lane did not negotiate SYNC_ITEMS on this configuration')

  // =======================================================================
  // RPC_PATH_FORBIDDEN (357487cb)
  // =======================================================================
  console.log('\n[RPC_PATH_FORBIDDEN]')
  result.rpc = {}
  for (const path of ['/v1/sessions', '/v1/items', '/v1/users/me']) {
    const { frame } = await sendAndAwait(
      a,
      'RPC_REQUEST',
      { method: 'GET', path, deadlineMs: 20_000, initialCreditBytes: 262_144, stream: false },
      rpcMatcher,
    )
    const code = errorCodeOf(frame)
    const leaks = framePathLeak(frame, path)
    result.rpc[path] = { code, leaks, frame: frame ?? null }
    check(`a forbidden RPC path ${path} answers RPC_PATH_FORBIDDEN, not BACKEND_ERROR`, code === 'RPC_PATH_FORBIDDEN', {
      code,
      frame: frame?.payload,
    })
    check(`the refusal for ${path} does not echo the path`, leaks.length === 0, { leaks })
  }

  // CONTROL: the lane itself works, and an allowed-but-missing route is NOT a
  // refusal. Without these, RPC_PATH_FORBIDDEN could be what this lane says
  // about everything.
  const allowed = await sendAndAwait(
    a,
    'RPC_REQUEST',
    {
      method: 'GET',
      path: '/v1/shared-vaults/invites',
      deadlineMs: 20_000,
      initialCreditBytes: 262_144,
      stream: false,
    },
    rpcMatcher,
  )
  control(
    'an ALLOWED RPC route is answered 200 (so the refusals above are not a dead lane)',
    allowed.frame?.type === 'RPC_RESPONSE' && allowed.frame.payload?.status === 200,
    { type: allowed.frame?.type, status: allowed.frame?.payload?.status, code: errorCodeOf(allowed.frame) },
  )
  const missing = await sendAndAwait(
    a,
    'RPC_REQUEST',
    {
      method: 'GET',
      path: '/v1/shared-vaults/invites-nope',
      deadlineMs: 20_000,
      initialCreditBytes: 262_144,
      stream: false,
    },
    rpcMatcher,
  )
  control(
    'an allowed-but-missing route answers 404 over the lane, NOT RPC_PATH_FORBIDDEN',
    missing.frame?.type === 'RPC_RESPONSE' && errorCodeOf(missing.frame) !== 'RPC_PATH_FORBIDDEN',
    { type: missing.frame?.type, status: missing.frame?.payload?.status, code: errorCodeOf(missing.frame) },
  )
  result.rpc.controls = {
    allowed: { type: allowed.frame?.type, status: allowed.frame?.payload?.status },
    missing: { type: missing.frame?.type, status: missing.frame?.payload?.status },
  }

  // =======================================================================
  // The genuine policy denial, captured on a FRESH credential.
  // =======================================================================
  console.log('\n[baseline denials on a fresh credential]')
  const foreignNote = randomUUID()
  // One FIXED resource id for every files probe. A fresh uuid per call would make
  // the before/after comparison differ on the id alone and prove nothing.
  const foreignFile = randomUUID()
  const freshCollab = await sendAndAwait(
    a,
    'COLLABORATION_AUTHORIZE',
    { noteUuid: foreignNote, collaborationProtocolVersion: 3, epochDiscovery: true },
    (f) => f.type === 'COLLABORATION_AUTHORIZED' || f.type === 'ERROR',
  )
  const freshFiles = await sendAndAwait(
    a,
    'FILES_METADATA',
    { resources: [{ ownershipType: 'user', remoteIdentifier: foreignFile }], deadlineMs: 20_000 },
    (f) => f.type === 'FILES_METADATA' || f.type === 'ERROR',
  )
  const denialBaseline = {
    collaboration: refusalFingerprint(freshCollab.frame),
    files: refusalFingerprint(freshFiles.frame),
  }
  result.denialBaseline = denialBaseline
  console.log(`  [baseline] collaboration = ${denialBaseline.collaboration}`)
  console.log(`  [baseline] files         = ${denialBaseline.files}`)

  // Socket B is opened on the SAME (still fresh) credential and never refreshes.
  // It is what makes the post-cooldown window observable.
  const b = await authenticatedSocket(original, deviceB)
  check('socket B authenticates on the same session', b.socket !== undefined, { ticketStatus: b.ticketStatus })

  // =======================================================================
  // Rotate the session.
  // =======================================================================
  console.log('\n[rotate]')
  const refreshed = await raw('POST', '/v1/sessions/refresh', {
    token: account.token,
    cookie: account.cookie,
    body: { access_token: account.token, refresh_token: account.refresh, api: '20240226' },
  })
  check(
    'POST /v1/sessions/refresh rotates the session',
    refreshed.status === 200 && Boolean(refreshed.json?.session?.access_token),
    {
      status: refreshed.status,
      setCookie: refreshed.setCookie.length,
    },
  )
  const current = {
    token: refreshed.json?.session?.access_token ?? account.token,
    cookie: cookieHeaderFrom(refreshed.setCookie) || account.cookie,
  }
  // MEASURED, not assumed: on a COOKIE session the bearer half is
  // `2:<privateIdentifier>` and `privateIdentifier` is NOT regenerated by a
  // refresh, so the access token a client holds is BYTE-IDENTICAL before and
  // after a rotation. The whole rotation lives in the two HttpOnly cookies.
  // Asserting a changed bearer would therefore fail on correct behaviour, and a
  // client that re-presents only the bearer has rotated nothing at all.
  const bearerChanged = current.token !== account.token
  const cookieChanged = current.cookie !== account.cookie
  check('the rotation replaced the COOKIE half of the credential', cookieChanged, {
    bearerChanged,
    cookieChanged,
    bearerPrefix: String(current.token).slice(0, 2),
  })
  result.rotationShape = { bearerChanged, cookieChanged }

  // Auth's own verdict on the OLD credential, read directly, so the socket
  // codes below are explained by a measured status rather than an assumption.
  const oldOverHttp = await raw('POST', '/v1/items', {
    token: account.token,
    cookie: account.cookie,
    body: { api: API, items: [], limit: 150 },
  })
  const newOverHttp = await raw('POST', '/v1/items', {
    token: current.token,
    cookie: current.cookie,
    body: { api: API, items: [], limit: 150 },
  })
  result.rotation = {
    oldCredentialHttpStatus: oldOverHttp.status,
    oldCredentialBody: oldOverHttp.text.slice(0, 160),
    newCredentialHttpStatus: newOverHttp.status,
  }
  console.log(`  [auth] the OLD credential over HTTP -> ${oldOverHttp.status} ${oldOverHttp.text.slice(0, 120)}`)
  check('the ROTATED credential works over HTTP', newOverHttp.status === 200, { status: newOverHttp.status })
  control('the OLD credential no longer works over HTTP', oldOverHttp.status !== 200, { status: oldOverHttp.status })

  // =======================================================================
  // The stale window: socket A still replays the old credential.
  // =======================================================================
  console.log('\n[stale window — socket A still holds the rotated-away credential]')
  const note = makeNote()
  let staleSync
  if (hasSyncItems) {
    const body = { api: API, items: [note], compute_integrity: false }
    staleSync = await sendAndAwait(
      a,
      'COMMAND',
      { command: 'SYNC_ITEMS', body },
      (f) => f.type === 'ERROR' || f.payload?.status === 'COMMITTED',
      { digest: commandDigest(body), timeoutMs: 40_000 },
    )
    const code = errorCodeOf(staleSync.frame)
    result.stale = { syncCode: code, syncFrame: staleSync.frame ?? null }
    check(
      'a SYNC_ITEMS command on a stale credential is refused SESSION_STALE (recoverable, not fatal)',
      code === 'SESSION_STALE',
      {
        code,
        frame: staleSync.frame?.payload,
      },
    )
    check('the stale refusal is marked retryable', staleSync.frame?.payload?.retryable === true, {
      retryable: staleSync.frame?.payload?.retryable,
    })
    const pull = await raw('POST', '/v1/items', {
      token: current.token,
      cookie: current.cookie,
      body: { api: API, items: [], limit: 150 },
    })
    const applied = appliedExactlyOnce(pull.json?.retrieved_items, note.uuid, (pull.json?.conflicts ?? []).length)
    check('the refused command was NOT applied', applied.copies === 0, applied)
    result.stale.copiesAfterRefusal = applied.copies
  }

  const staleCollab = await sendAndAwait(
    a,
    'COLLABORATION_AUTHORIZE',
    { noteUuid: foreignNote, collaborationProtocolVersion: 3, epochDiscovery: true },
    (f) => f.type === 'COLLABORATION_AUTHORIZED' || f.type === 'ERROR',
  )
  const staleFiles = await sendAndAwait(
    a,
    'FILES_METADATA',
    { resources: [{ ownershipType: 'user', remoteIdentifier: foreignFile }], deadlineMs: 20_000 },
    (f) => f.type === 'FILES_METADATA' || f.type === 'ERROR',
  )
  result.stale = {
    ...(result.stale ?? {}),
    collaborationCode: errorCodeOf(staleCollab.frame),
    filesCode: errorCodeOf(staleFiles.frame),
    collaborationFingerprint: refusalFingerprint(staleCollab.frame),
    filesFingerprint: refusalFingerprint(staleFiles.frame),
  }
  console.log(
    `  [stale] collaboration -> ${errorCodeOf(staleCollab.frame)}   files -> ${errorCodeOf(staleFiles.frame)}`,
  )
  check(
    'collaboration reports SESSION_STALE for a stale credential',
    errorCodeOf(staleCollab.frame) === 'SESSION_STALE',
    {
      code: errorCodeOf(staleCollab.frame),
    },
  )
  check('files reports SESSION_STALE for a stale credential', errorCodeOf(staleFiles.frame) === 'SESSION_STALE', {
    code: errorCodeOf(staleFiles.frame),
  })
  // A stale credential must NOT terminate the lane. Read after a settle delay,
  // never from the absence of a close event at this instant.
  await sleep(CLOSE_SETTLE_MS)
  check('a stale credential does NOT close the socket', a.socket.close === undefined, { close: a.socket.close })

  // =======================================================================
  // REAUTH on the live socket (f5d4733b): resume IN PLACE.
  // =======================================================================
  console.log('\n[REAUTH]')
  const framesBefore = a.socket.frames.length
  const t2 = await mintTicket(current, deviceA)
  check('a ticket mints on the rotated credential', t2.status === 200 && typeof t2.json?.ticket === 'string', {
    status: t2.status,
  })
  const reauth = await sendAndAwait(
    a,
    'REAUTH',
    { ticket: t2.json?.ticket ?? 'absent', deviceId: deviceA },
    (f) => f.type === 'REAUTHENTICATED' || f.type === 'ERROR',
  )
  check('the live socket adopts the current credential (REAUTHENTICATED)', reauth.frame?.type === 'REAUTHENTICATED', {
    type: reauth.frame?.type,
    code: errorCodeOf(reauth.frame),
  })
  await sleep(CLOSE_SETTLE_MS)
  check('the REAUTH did not close the socket (resumed in place)', a.socket.close === undefined, {
    close: a.socket.close,
  })
  const reNegotiated = a.socket.frames.slice(framesBefore).some((f) => f.type === 'AUTHENTICATED')
  check('the REAUTH did not re-handshake (no second AUTHENTICATED frame)', reNegotiated === false)
  result.reauth = { type: reauth.frame?.type ?? null, reNegotiated, closedAfter: a.socket.close ?? null }

  if (hasSyncItems) {
    const body = { api: API, items: [note], compute_integrity: false }
    const retry = await sendAndAwait(
      a,
      'COMMAND',
      { command: 'SYNC_ITEMS', body },
      (f) => f.type === 'ERROR' || f.payload?.status === 'COMMITTED',
      { digest: commandDigest(body), timeoutMs: 40_000 },
    )
    check('the same operation succeeds after the REAUTH (not lost)', retry.frame?.payload?.status === 'COMMITTED', {
      type: retry.frame?.type,
      status: retry.frame?.payload?.status,
      code: errorCodeOf(retry.frame),
    })
    const pull = await raw('POST', '/v1/items', {
      token: current.token,
      cookie: current.cookie,
      body: { api: API, items: [], limit: 150 },
    })
    const applied = appliedExactlyOnce(pull.json?.retrieved_items, note.uuid, (pull.json?.conflicts ?? []).length)
    check('the operation was applied EXACTLY ONCE (not lost, not applied twice)', applied.exactlyOnce, applied)
    result.reauth.applied = applied
  }

  const afterCollab = await sendAndAwait(
    a,
    'COLLABORATION_AUTHORIZE',
    { noteUuid: foreignNote, collaborationProtocolVersion: 3, epochDiscovery: true },
    (f) => f.type === 'COLLABORATION_AUTHORIZED' || f.type === 'ERROR',
  )
  const afterFiles = await sendAndAwait(
    a,
    'FILES_METADATA',
    { resources: [{ ownershipType: 'user', remoteIdentifier: foreignFile }], deadlineMs: 20_000 },
    (f) => f.type === 'FILES_METADATA' || f.type === 'ERROR',
  )
  check(
    'after the REAUTH a genuine collaboration denial is BYTE-IDENTICAL to the pre-rotation one',
    refusalFingerprint(afterCollab.frame) === denialBaseline.collaboration,
    { before: denialBaseline.collaboration, after: refusalFingerprint(afterCollab.frame) },
  )
  // The files row is an ANSWER, not a denial: a `user`-owned resource that does
  // not exist answers `FILES_METADATA { exists: false }`, which is the correct
  // non-committal reply and is exactly what must be restored unchanged. A real
  // files POLICY denial needs a shared-vault resource owned by somebody else,
  // which this single-account run cannot construct, so that case is reported as
  // not verified rather than claimed here.
  check(
    'after the REAUTH the files answer is BYTE-IDENTICAL to the pre-rotation one',
    refusalFingerprint(afterFiles.frame) === denialBaseline.files,
    { before: denialBaseline.files, after: refusalFingerprint(afterFiles.frame) },
  )
  if (freshFiles.frame?.type !== 'ERROR') {
    notVerified(
      'a files POLICY denial being byte-identical',
      'a user-owned missing resource answers FILES_METADATA {exists:false}, not a denial; a real denial needs a shared-vault resource owned by another account',
    )
  }
  // The stale codes above must therefore be DIFFERENT from the genuine denial,
  // or "collaboration now reports SESSION_STALE" would be unfalsifiable.
  control(
    'the stale collaboration refusal differs from the genuine denial',
    result.stale.collaborationFingerprint !== denialBaseline.collaboration,
    { stale: result.stale.collaborationFingerprint, denial: denialBaseline.collaboration },
  )
  control(
    'the stale files refusal differs from the genuine denial',
    result.stale.filesFingerprint !== denialBaseline.files,
    { stale: result.stale.filesFingerprint, denial: denialBaseline.files },
  )

  // =======================================================================
  // The post-cooldown window on socket B, which never refreshed.
  // =======================================================================
  if (SKIP_COOLDOWN) {
    notVerified('the post-cooldown (401) window', 'SKIP_COOLDOWN=1')
  } else if (!b.socket) {
    notVerified('the post-cooldown (401) window', 'socket B did not authenticate')
  } else {
    console.log(`\n[post-cooldown — waiting ${COOLDOWN_WAIT_MS} ms for auth's token cooldown to expire]`)
    await sleep(COOLDOWN_WAIT_MS)
    const oldAfterCooldown = await raw('POST', '/v1/items', {
      token: account.token,
      cookie: account.cookie,
      body: { api: API, items: [], limit: 150 },
    })
    console.log(
      `  [auth] the OLD credential after the cooldown -> ${oldAfterCooldown.status} ${oldAfterCooldown.text.slice(0, 120)}`,
    )
    const bCollab = await sendAndAwait(
      b,
      'COLLABORATION_AUTHORIZE',
      { noteUuid: foreignNote, collaborationProtocolVersion: 3, epochDiscovery: true },
      (f) => f.type === 'COLLABORATION_AUTHORIZED' || f.type === 'ERROR',
    )
    let bSyncCode = 'NOT_RUN'
    if (hasSyncItems) {
      const body = { api: API, items: [makeNote()], compute_integrity: false }
      const bSync = await sendAndAwait(
        b,
        'COMMAND',
        { command: 'SYNC_ITEMS', body },
        (f) => f.type === 'ERROR' || f.payload?.status === 'COMMITTED',
        { digest: commandDigest(body), timeoutMs: 40_000 },
      )
      bSyncCode = errorCodeOf(bSync.frame)
    }
    result.postCooldown = {
      oldCredentialHttpStatus: oldAfterCooldown.status,
      oldCredentialBody: oldAfterCooldown.text.slice(0, 160),
      syncCode: bSyncCode,
      collaborationCode: errorCodeOf(bCollab.frame),
      collaborationFingerprint: refusalFingerprint(bCollab.frame),
    }
    console.log(`  [post-cooldown] sync -> ${bSyncCode}   collaboration -> ${errorCodeOf(bCollab.frame)}`)
    check(
      'after the cooldown the sync lane still reports the RECOVERABLE SESSION_STALE (it must not close every socket)',
      bSyncCode === 'SESSION_STALE' || bSyncCode === 'NOT_RUN',
      { code: bSyncCode },
    )
    check(
      'after the cooldown collaboration collapses to the unqualified NOT_AUTHORIZED (a 401 is a revocation, not staleness)',
      errorCodeOf(bCollab.frame) === 'NOT_AUTHORIZED',
      { code: errorCodeOf(bCollab.frame) },
    )
  }

  // =======================================================================
  // THE CRITICAL ONE: a genuine sign-out must TERMINATE the lane.
  // =======================================================================
  console.log('\n[sign-out]')
  const c = await authenticatedSocket(current, deviceC)
  if (!c.socket) {
    check('socket C authenticates on the current credential', false, { ticketStatus: c.ticketStatus })
  } else {
    check('socket C authenticates on the current credential', true)
    // CONTROL (positive): the same socket, the same frame, a LIVE session.
    // Without it, the close below could be a socket that closes on any REAUTH.
    const live = await mintTicket(current, deviceC)
    const liveReauth = await sendAndAwait(
      c,
      'REAUTH',
      { ticket: live.json?.ticket ?? 'absent', deviceId: deviceC },
      (f) => f.type === 'REAUTHENTICATED' || f.type === 'ERROR',
    )
    await sleep(CLOSE_SETTLE_MS)
    control(
      'a REAUTH on a LIVE session is accepted and leaves socket C open',
      liveReauth.frame?.type === 'REAUTHENTICATED' && c.socket.close === undefined,
      { type: liveReauth.frame?.type, close: c.socket.close },
    )

    // Mint the ticket the REAUTH will present BEFORE signing out: after the
    // sign-out the credential is dead and no ticket could be minted at all, so
    // the probe would measure nothing. The gateway's ticket store still holds it, bound
    // to the same user, session and device, which is exactly the privilege the
    // session plane has to refuse.
    const held = await mintTicket(current, deviceC)
    check('a ticket is held across the sign-out', held.status === 200 && typeof held.json?.ticket === 'string', {
      status: held.status,
    })
    const logout = await raw('POST', '/v1/logout', { token: current.token, cookie: current.cookie })
    check('POST /v1/logout signs the session out', logout.status === 200 || logout.status === 204, {
      status: logout.status,
      body: logout.text.slice(0, 160),
    })
    const afterLogoutHttp = await raw('POST', '/v1/items', {
      token: current.token,
      cookie: current.cookie,
      body: { api: API, items: [], limit: 150 },
    })
    console.log(
      `  [auth] the signed-out credential over HTTP -> ${afterLogoutHttp.status} ${afterLogoutHttp.text.slice(0, 140)}`,
    )
    control('the signed-out credential no longer works over HTTP', afterLogoutHttp.status !== 200, {
      status: afterLogoutHttp.status,
    })

    const signedOutReauth = await sendAndAwait(
      c,
      'REAUTH',
      { ticket: held.json?.ticket ?? 'absent', deviceId: deviceC },
      (f) => f.type === 'REAUTHENTICATED' || f.type === 'ERROR',
    )
    await sleep(CLOSE_SETTLE_MS)
    result.signOut = {
      logoutStatus: logout.status,
      httpAfterLogout: afterLogoutHttp.status,
      reauthFrame: signedOutReauth.frame ?? null,
      close: c.socket.close ?? null,
      frameCode: errorCodeOf(signedOutReauth.frame),
    }
    console.log(
      `  [sign-out] REAUTH answer = ${JSON.stringify(signedOutReauth.frame?.payload ?? null)}  close = ${JSON.stringify(c.socket.close)}`,
    )
    check(
      'a signed-out session is NOT re-credentialled (no REAUTHENTICATED)',
      signedOutReauth.frame?.type !== 'REAUTHENTICATED',
      {
        type: signedOutReauth.frame?.type,
      },
    )
    check('a sign-out TERMINATES the lane (the socket is closed)', c.socket.close !== undefined, {
      close: c.socket.close,
    })
    check(
      'the sign-out refusal is NOT the recoverable SESSION_STALE (that would leave a live authenticated socket)',
      errorCodeOf(signedOutReauth.frame) !== 'SESSION_STALE',
      { code: errorCodeOf(signedOutReauth.frame) },
    )
  }

  // Close every socket this run opened. They are the only handles keeping the
  // event loop alive, so without this the process never exits even though the
  // run is complete — and `process.exit()` with an open `ws` handle aborts the
  // Node runtime on Windows instead of exiting.
  for (const session of [a, b, c]) {
    try {
      session?.socket?.ws.close()
    } catch {
      /* already closed by the gateway */
    }
  }

  console.log(`\n${failures} failures, ${controlFailures} control failures, ${unverified.length} not verified`)
  if (RESULT_JSON) {
    result.failures = failures
    result.controlFailures = controlFailures
    result.unverified = unverified
    writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2))
    console.log(`wrote ${RESULT_JSON}`)
  }
  return failures === 0 && controlFailures === 0 ? 0 : 1
}

const code = process.argv.includes('--self-test') ? selfTest() : await main()
process.exitCode = code
// A graceful ws.close() waits on the peer's close frame, and undici keeps its
// connections alive, so a completed run can sit with a live event loop for
// minutes after the last assertion. The timer is unref'd: it cannot keep the
// process alive by itself, it only fires when something else already is. Every
// socket is closed before this point, so the exit has no open ws handle to abort
// on (process.exit() with one aborts the Node runtime on Windows).
setTimeout(() => process.exit(code), 1500).unref()
