/**
 * The gRPC->HTTP per-call degradation, the three transport states it has to
 * keep apart, and the SYNC_ITEMS verdict — measured on a LIVE stack through the
 * public front door and read back from `GET /v1/admin/sync-diagnostics`.
 *
 * WHY THIS EXISTS
 *
 * `GrpcTransportFallbackDiagnostics` documents three readings that used to be
 * two:
 *
 *   boundServiceProxy 'http' + degradedCalls 0   -> plain HTTP deployment
 *   boundServiceProxy 'grpc' + degradedCalls 0   -> gRPC, healthy
 *   boundServiceProxy 'grpc' + degradedCalls > 0 -> gRPC BOUND, HTTP SERVING
 *
 * Unit tests prove the recorder counts and that the controller serializes it.
 * Neither can show that a real gRPC listener going away produces the third
 * reading on a real deployment, that a READ survives it, that a
 * NON-IDEMPOTENT WRITE is refused rather than replayed onto a second transport,
 * or what the no-latch design costs in latency. This script measures all four
 * against whatever the caller has configured, and asserts the SYNC_ITEMS
 * verdict in the same payload at the same time.
 *
 * The admin endpoint is ROLE-GATED, which is why a previous live run could not
 * read any of this. `ADMIN_GRANT_COMMAND` is the documented way in:
 *
 *   ADMIN_GRANT_COMMAND='docker compose -p <project> exec -T server srn-admin roles grant {email} ADMIN_USER'
 *
 * `{email}` is replaced with the account this run registered. Without it the
 * endpoint answers 403 and every admin-payload row is reported NOT VERIFIED
 * rather than skipped quietly.
 *
 * CONTROLS. Every probe has a planted condition that must make it fail:
 *
 *   --self-test            the pure predicates against synthetic payloads,
 *                          including the negatives, with no stack.
 *   pre-grant 403          the admin payload is read BEFORE the role is
 *                          granted and must be refused. A 200 there would mean
 *                          the gate is not a gate and every "admin-only"
 *                          reading below is unauthenticated.
 *   forged bearer          the sync probes re-run with a corrupted credential
 *                          and must 401. A 200 would mean the sync rows were
 *                          measured without authentication.
 *   census/verdict agree   SYNC_ITEMS in the socket census must equal
 *                          `gate.syncItems.state === 'ADVERTISED'`. This is the
 *                          one assertion that can catch the gate claiming
 *                          ADVERTISED over a socket that refuses the lane, and
 *                          it is checked in BOTH directions.
 *
 * Usage (host, public front door):
 *   BASE=http://127.0.0.1:3061 \
 *   ADMIN_GRANT_COMMAND='...' \
 *   yarn node e2e/transport-fallback.e2e.mjs
 *   yarn node e2e/transport-fallback.e2e.mjs --self-test
 *
 * Env: BASE, WS_BASE, ORIGIN, ADMIN_GRANT_COMMAND, REPEAT (timed samples),
 *      EXPECT_BOUND_PROXY, EXPECT_OBSERVED (0|1), EXPECT_EVER_DEGRADED (0|1),
 *      EXPECT_SYNC_ITEMS_STATE, EXPECT_SYNC_ITEMS_CAUSE, EXPECT_SYNC_ITEMS_PROBE,
 *      EXPECT_OPERATIONS (comma-separated whole sorted census),
 *      EXPECT_READ_SYNC_OK (0|1), EXPECT_WRITE_SYNC_OK (0|1),
 *      EXPECT_ITEMS_DEGRADED_DELTA, EXPECT_ITEMS_REFUSED_DELTA,
 *      EXPECT_SESSION_DEGRADED_MIN, EXPECT_DEPLOYMENT (stamped|unstamped),
 *      EXPECT_REVISION (exact 40-hex), RESULT_JSON, LABEL.
 */
import { WebSocket } from 'ws'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3001'
const WS_BASE = process.env.WS_BASE ?? BASE.replace(/^http/u, 'ws')
const ORIGIN = process.env.ORIGIN ?? BASE
const ADMIN_GRANT_COMMAND = process.env.ADMIN_GRANT_COMMAND ?? ''
const REPEAT = Number(process.env.REPEAT ?? '5')
const RESULT_JSON = process.env.RESULT_JSON ?? ''
const LABEL = process.env.LABEL ?? 'unlabelled'
const DEVICE_ID = 't107-transport-' + randomUUID()

const ALL_OPERATIONS = [
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  'FILES_V1',
]

const sleep = (t) => new Promise((r) => setTimeout(r, t))
let failures = 0
let controlFailures = 0
const unverified = []
const result = { label: LABEL, base: BASE }

function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  else {
    console.log(`  FAIL - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
    failures++
  }
  return Boolean(cond)
}

/** A control PASSES when the probe it re-runs went red. */
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
  const startedAt = Date.now()
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
    elapsedMs: Date.now() - startedAt,
  }
}

const cookieHeaderFrom = (setCookie) =>
  setCookie
    .map((entry) => entry.split(';', 1)[0].trim())
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ')

async function register() {
  const email = `t107-tf-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
  const password = randomBytes(32).toString('hex')
  const r = await raw('POST', '/v1/users', {
    body: {
      email,
      password,
      // Exactly 20240226 is the ONLY version SessionService issues a cookie
      // session for, and a cookie session is what production issues. A run on
      // 20200115 silently measures legacy header sessions instead.
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
    token: r.json.session.access_token,
    cookie: cookieHeaderFrom(r.setCookie),
    userUuid: r.json.user?.uuid,
  }
}

// ---------------------------------------------------------------------------
// Pure predicates, shared by the live run and --self-test.
// ---------------------------------------------------------------------------

/** The three transport readings, from the two independent fields that name them. */
export function transportStateOf(deployment, transportFallback) {
  const bound = deployment?.boundServiceProxy
  const degraded =
    Number(transportFallback?.lanes?.['items-sync']?.degradedCalls ?? 0) +
    Number(transportFallback?.lanes?.['session-validation']?.degradedCalls ?? 0)
  if (bound !== 'grpc') return 'http-by-configuration'
  return degraded > 0 ? 'grpc-bound-serving-http' : 'grpc-healthy'
}

/**
 * The gate may never claim ADVERTISED over a socket that did not negotiate the
 * operation, and may never withhold one the socket did negotiate. Both
 * directions, because one of them is the bug the verdict rewrite exists for.
 */
export function verdictAgreesWithCensus(syncItemsState, censusHasSyncItems) {
  if (syncItemsState === 'ADVERTISED') return censusHasSyncItems === true
  if (syncItemsState === 'WITHHELD') return censusHasSyncItems === false
  return true
}

/** Counters only ever move forwards, and a delta is exact, never "at least". */
export function laneDelta(before, after, lane) {
  const b = before?.lanes?.[lane] ?? { degradedCalls: 0, refusedCalls: 0 }
  const a = after?.lanes?.[lane] ?? { degradedCalls: 0, refusedCalls: 0 }
  return { degraded: a.degradedCalls - b.degradedCalls, refused: a.refusedCalls - b.refusedCalls }
}

function percentiles(samples) {
  const sorted = [...samples].sort((x, y) => x - y)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
  return { n: sorted.length, min: sorted[0], p50: at(0.5), max: sorted[sorted.length - 1] }
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
// Socket census (the independent witness for the SYNC_ITEMS verdict)
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
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('sync socket open timeout')), 15_000)
  })
}

function syncFrame(type, payload, sequence) {
  return {
    version: 1,
    channel: 'sync',
    type,
    requestId: `req-${randomUUID()}`,
    commandId: `cmd-${randomUUID()}`,
    sequence,
    payloadLength: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    payload,
  }
}

async function waitForFrame(state, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = state.frames.find(predicate)
    if (found) return found
    if (state.close) return undefined
    await sleep(25)
  }
  return undefined
}

async function census(account) {
  const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
    token: account.token,
    cookie: account.cookie,
    body: { deviceId: DEVICE_ID },
  })
  if (ticket.status !== 200 || typeof ticket.json?.ticket !== 'string') {
    return { ticketStatus: ticket.status, seen: undefined }
  }
  const socket = await openSyncSocket(account.cookie).catch(() => undefined)
  if (!socket) return { ticketStatus: ticket.status, seen: undefined }
  socket.ws.send(JSON.stringify(syncFrame('AUTH', { ticket: ticket.json.ticket, deviceId: DEVICE_ID }, 0)))
  const authenticated = await waitForFrame(socket, (f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR')
  const seen =
    authenticated?.type === 'AUTHENTICATED' && Array.isArray(authenticated.payload?.operations)
      ? authenticated.payload.operations.filter((o) => typeof o === 'string')
      : undefined
  socket.ws.close()
  return { ticketStatus: ticket.status, seen, close: socket.close }
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------
function selfTest() {
  console.log('self-test: pure predicates (negatives included)')
  const lanes = (itemsDegraded, sessionDegraded) => ({
    lanes: {
      'items-sync': { degradedCalls: itemsDegraded, refusedCalls: 0 },
      'session-validation': { degradedCalls: sessionDegraded, refusedCalls: 0 },
    },
  })
  check(
    'http config reads http-by-configuration',
    transportStateOf({ boundServiceProxy: 'http' }, lanes(0, 0)) === 'http-by-configuration',
  )
  check(
    'http config with counts STILL reads http-by-configuration',
    transportStateOf({ boundServiceProxy: 'http' }, lanes(9, 9)) === 'http-by-configuration',
  )
  check(
    'grpc with no counts reads grpc-healthy',
    transportStateOf({ boundServiceProxy: 'grpc' }, lanes(0, 0)) === 'grpc-healthy',
  )
  check(
    'grpc with an items count reads grpc-bound-serving-http',
    transportStateOf({ boundServiceProxy: 'grpc' }, lanes(1, 0)) === 'grpc-bound-serving-http',
  )
  check(
    'grpc with a session count reads grpc-bound-serving-http',
    transportStateOf({ boundServiceProxy: 'grpc' }, lanes(0, 1)) === 'grpc-bound-serving-http',
  )
  check(
    'a refusal alone does NOT make it serving-http',
    transportStateOf(
      { boundServiceProxy: 'grpc' },
      {
        lanes: {
          'items-sync': { degradedCalls: 0, refusedCalls: 4 },
          'session-validation': { degradedCalls: 0, refusedCalls: 0 },
        },
      },
    ) === 'grpc-healthy',
  )

  check('ADVERTISED + census hit agrees', verdictAgreesWithCensus('ADVERTISED', true) === true)
  check('ADVERTISED + census MISS disagrees', verdictAgreesWithCensus('ADVERTISED', false) === false)
  check('WITHHELD + census miss agrees', verdictAgreesWithCensus('WITHHELD', false) === true)
  check('WITHHELD + census HIT disagrees', verdictAgreesWithCensus('WITHHELD', true) === false)
  check(
    'NOT_OBSERVED makes no claim either way',
    verdictAgreesWithCensus('NOT_OBSERVED', true) && verdictAgreesWithCensus('NOT_OBSERVED', false),
  )

  const before = { lanes: { 'items-sync': { degradedCalls: 2, refusedCalls: 1 } } }
  const after = { lanes: { 'items-sync': { degradedCalls: 5, refusedCalls: 3 } } }
  const delta = laneDelta(before, after, 'items-sync')
  check('laneDelta is exact', delta.degraded === 3 && delta.refused === 2, delta)
  check(
    'laneDelta on an absent lane is zero',
    JSON.stringify(laneDelta({}, {}, 'items-sync')) === '{"degraded":0,"refused":0}',
  )

  const p = percentiles([10, 100, 20, 30, 40])
  check('percentiles sort before indexing', p.min === 10 && p.max === 100 && p.p50 === 30, p)

  console.log(`\nself-test: ${failures} failures`)
  return failures === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== transport fallback + SYNC_ITEMS verdict (${LABEL}) against ${BASE} ===\n`)

  // --- deployment identity ------------------------------------------------
  const readiness = await raw('GET', '/healthcheck/readiness')
  const deploymentIdentity = readiness.json?.deployment ?? null
  result.readiness = { status: readiness.status, deployment: deploymentIdentity }
  check('readiness answers 200', readiness.status === 200, { status: readiness.status })
  console.log(`  [identity] ${JSON.stringify(deploymentIdentity)}`)
  if (process.env.EXPECT_DEPLOYMENT === 'stamped') {
    check(
      'the deployment identity is published (revision AND version non-null)',
      typeof deploymentIdentity?.revision === 'string' &&
        /^[0-9a-f]{40}$/u.test(deploymentIdentity.revision) &&
        typeof deploymentIdentity?.version === 'string' &&
        deploymentIdentity.version.length > 0,
      deploymentIdentity,
    )
  } else if (process.env.EXPECT_DEPLOYMENT === 'unstamped') {
    check(
      'the deployment identity is suppressed to {null,null}',
      deploymentIdentity !== null && deploymentIdentity.revision === null && deploymentIdentity.version === null,
      deploymentIdentity,
    )
  }
  if (process.env.EXPECT_REVISION) {
    check('the published revision is the expected one', deploymentIdentity?.revision === process.env.EXPECT_REVISION, {
      expected: process.env.EXPECT_REVISION,
      got: deploymentIdentity?.revision ?? null,
    })
  }

  // --- account ------------------------------------------------------------
  const account = await register()
  check('the session is a COOKIE session (2: prefix)', String(account.token).startsWith('2:'), {
    prefix: String(account.token).slice(0, 2),
  })
  result.account = { email: account.email, tokenPrefix: String(account.token).slice(0, 2) }

  // CONTROL: the admin payload must be refused BEFORE the grant.
  const preGrant = await raw('GET', '/v1/admin/sync-diagnostics', { token: account.token, cookie: account.cookie })
  control('the admin diagnostics gate refuses a non-admin', preGrant.status === 403, {
    status: preGrant.status,
    body: preGrant.text.slice(0, 120),
  })

  let diagnostics
  if (ADMIN_GRANT_COMMAND) {
    const command = ADMIN_GRANT_COMMAND.replaceAll('{email}', account.email)
    let grantOutput = ''
    let grantFailed = false
    try {
      grantOutput = execFileSync('sh', ['-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      grantFailed = true
      grantOutput = String(error.stdout ?? '') + String(error.stderr ?? '')
    }
    check('the ADMIN_USER grant succeeds', !grantFailed, { tail: grantOutput.trim().split('\n').slice(-1)[0] })
    const afterGrant = await raw('GET', '/v1/admin/sync-diagnostics', { token: account.token, cookie: account.cookie })
    check('the admin diagnostics endpoint answers 200 after the grant', afterGrant.status === 200, {
      status: afterGrant.status,
      body: afterGrant.text.slice(0, 160),
    })
    if (afterGrant.status === 200) diagnostics = afterGrant.json
  } else {
    notVerified('the admin sync-diagnostics payload', 'ADMIN_GRANT_COMMAND was not provided, so the endpoint stays 403')
  }

  if (diagnostics) {
    result.before = {
      boundServiceProxy: diagnostics.deployment?.boundServiceProxy,
      serviceProxySetting: diagnostics.deployment?.serviceProxySetting,
      syncItems: diagnostics.gate?.syncItems,
      syncItemsAdvertisedPresent: Object.prototype.hasOwnProperty.call(diagnostics.gate ?? {}, 'syncItemsAdvertised'),
      syncItemsAdvertised: diagnostics.gate?.syncItemsAdvertised,
      // Recorded beside the verdict because the two can disagree: the cause is a
      // single enum chosen from the probe, while `unmetCodes` is the lane's own
      // list. A deployment whose durable proxy is UNBOUND shows
      // SYNCING_SERVER_GRPC_UNBOUND here, and a cause that says the port is
      // bound-but-unready is then contradicted by this field.
      unmetCodes: [...(diagnostics.gate?.unmetCodes ?? [])].sort(),
      transportFallback: diagnostics.transportFallback,
    }
    console.log(
      `  [state] boundServiceProxy=${diagnostics.deployment?.boundServiceProxy} syncItems=${JSON.stringify(diagnostics.gate?.syncItems)}`,
    )
    console.log(`  [state] transportFallback=${JSON.stringify(diagnostics.transportFallback)}`)
    if (process.env.EXPECT_BOUND_PROXY) {
      check(
        'boundServiceProxy is as expected',
        diagnostics.deployment?.boundServiceProxy === process.env.EXPECT_BOUND_PROXY,
        {
          expected: process.env.EXPECT_BOUND_PROXY,
          got: diagnostics.deployment?.boundServiceProxy,
        },
      )
    }
    if (process.env.EXPECT_SYNC_ITEMS_STATE) {
      check(
        'gate.syncItems.state is as expected',
        diagnostics.gate?.syncItems?.state === process.env.EXPECT_SYNC_ITEMS_STATE,
        {
          expected: process.env.EXPECT_SYNC_ITEMS_STATE,
          got: diagnostics.gate?.syncItems?.state,
        },
      )
    }
    if (process.env.EXPECT_SYNC_ITEMS_CAUSE !== undefined) {
      const expected = process.env.EXPECT_SYNC_ITEMS_CAUSE === '' ? null : process.env.EXPECT_SYNC_ITEMS_CAUSE
      check('gate.syncItems.cause is as expected', (diagnostics.gate?.syncItems?.cause ?? null) === expected, {
        expected,
        got: diagnostics.gate?.syncItems?.cause ?? null,
      })
    }
    if (process.env.EXPECT_SYNC_ITEMS_PROBE) {
      check(
        'gate.syncItems.probe is as expected',
        diagnostics.gate?.syncItems?.probe === process.env.EXPECT_SYNC_ITEMS_PROBE,
        {
          expected: process.env.EXPECT_SYNC_ITEMS_PROBE,
          got: diagnostics.gate?.syncItems?.probe,
        },
      )
    }
    if (process.env.EXPECT_OBSERVED !== undefined) {
      check(
        'transportFallback.observed is as expected',
        diagnostics.transportFallback?.observed === (process.env.EXPECT_OBSERVED === '1'),
        {
          expected: process.env.EXPECT_OBSERVED === '1',
          got: diagnostics.transportFallback?.observed,
        },
      )
    }
  }

  // --- the socket census, the independent witness -------------------------
  const taken = await census(account)
  const seen = taken.seen
  result.census = { ticketStatus: taken.ticketStatus, seen: seen === undefined ? null : [...seen].sort() }
  console.log(
    `  [census] ticket=${taken.ticketStatus} advertised=${seen === undefined ? '(no socket)' : '[' + seen.join(', ') + ']'}`,
  )
  if (process.env.EXPECT_OPERATIONS !== undefined) {
    const expected = process.env.EXPECT_OPERATIONS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort()
    check(
      'the whole sorted census matches EXPECT_OPERATIONS',
      JSON.stringify([...(seen ?? [])].sort()) === JSON.stringify(expected),
      {
        expected,
        got: seen === undefined ? null : [...seen].sort(),
      },
    )
  }
  if (diagnostics && seen !== undefined) {
    check(
      'the SYNC_ITEMS verdict agrees with what the socket actually negotiated',
      verdictAgreesWithCensus(diagnostics.gate?.syncItems?.state, seen.includes('SYNC_ITEMS')),
      { verdict: diagnostics.gate?.syncItems, censusHasSyncItems: seen.includes('SYNC_ITEMS') },
    )
    check(
      'every operation in the census is one this build knows how to negotiate',
      seen.every((op) => ALL_OPERATIONS.includes(op)),
      { seen },
    )
  } else if (diagnostics) {
    notVerified('the verdict/census agreement', 'no authenticated socket was established on this configuration')
  }

  // --- the READ: must degrade and keep serving ----------------------------
  // Every key is on `READ_ONLY_SYNC_BODY_KEYS` and `items` is empty, so
  // `syncPayloadWritesNothing` reports it as a read and the fallback is
  // eligible. Timed REPEAT times: with no sticky latch, EVERY call pays the
  // failed gRPC attempt, so the cost is a per-call property, not a one-off.
  const readSamples = []
  let readStatus
  for (let i = 0; i < Math.max(1, REPEAT); i++) {
    const r = await raw('POST', '/v1/items', {
      token: account.token,
      cookie: account.cookie,
      body: { api: '20200115', items: [], compute_integrity: false, limit: 150 },
    })
    readSamples.push(r.elapsedMs)
    readStatus = r.status
  }
  const readTiming = percentiles(readSamples)
  result.read = { status: readStatus, timing: readTiming }
  console.log(`  [read ] POST /v1/items items:[] -> ${readStatus}  ms ${JSON.stringify(readTiming)}`)
  if (process.env.EXPECT_READ_SYNC_OK !== undefined) {
    check('the read sync behaves as expected', (readStatus === 200) === (process.env.EXPECT_READ_SYNC_OK === '1'), {
      expected: process.env.EXPECT_READ_SYNC_OK === '1' ? 200 : 'non-200',
      got: readStatus,
    })
  }

  // --- the WRITE: must NOT be replayed across transports ------------------
  // One item, no durable command id/digest => `non-idempotent-mutation`, for
  // which `GRPC_FALLBACK_ELIGIBILITY` is the empty set. On a healthy gRPC lane
  // this is an ordinary 200; on a broken one it must FAIL rather than be
  // re-delivered over HTTP, and the note must not appear twice.
  const note = makeNote()
  const write = await raw('POST', '/v1/items', {
    token: account.token,
    cookie: account.cookie,
    body: { api: '20200115', items: [note] },
  })
  result.write = { status: write.status, elapsedMs: write.elapsedMs, body: write.text.slice(0, 200) }
  console.log(`  [write] POST /v1/items items:[1] -> ${write.status}  ${write.elapsedMs} ms`)
  if (process.env.EXPECT_WRITE_SYNC_OK !== undefined) {
    check(
      'the non-idempotent write behaves as expected',
      (write.status === 200) === (process.env.EXPECT_WRITE_SYNC_OK === '1'),
      {
        expected: process.env.EXPECT_WRITE_SYNC_OK === '1' ? 200 : 'non-200',
        got: write.status,
        body: write.text.slice(0, 200),
      },
    )
  }

  // How many copies of that uuid exist, whatever the write answered. A refusal
  // that silently replayed onto a second transport would show up here as a
  // duplicate or a conflict, which is the whole reason the refusal exists.
  const pull = await raw('POST', '/v1/items', {
    token: account.token,
    cookie: account.cookie,
    body: { api: '20200115', items: [], limit: 150 },
  })
  const retrieved = Array.isArray(pull.json?.retrieved_items) ? pull.json.retrieved_items : []
  const copies = retrieved.filter((item) => item?.uuid === note.uuid).length
  const conflicts = Array.isArray(pull.json?.conflicts) ? pull.json.conflicts.length : 0
  result.write.copiesAfter = copies
  result.write.conflictsAfter = conflicts
  console.log(`  [write] copies of the written uuid after the attempt = ${copies}, conflicts = ${conflicts}`)
  check('the written note exists at most once (never duplicated by a cross-transport replay)', copies <= 1, {
    copies,
    conflicts,
  })
  if (write.status === 200) {
    check('a successful write produced exactly one copy', copies === 1, { copies })
  }

  // --- counters -----------------------------------------------------------
  if (diagnostics) {
    const after = await raw('GET', '/v1/admin/sync-diagnostics', { token: account.token, cookie: account.cookie })
    if (after.status !== 200) {
      notVerified('the counter deltas', `the second diagnostics read answered ${after.status}`)
    } else {
      const items = laneDelta(diagnostics.transportFallback, after.json.transportFallback, 'items-sync')
      const session = laneDelta(diagnostics.transportFallback, after.json.transportFallback, 'session-validation')
      result.after = { transportFallback: after.json.transportFallback, delta: { items, session } }
      console.log(
        `  [count] items-sync delta ${JSON.stringify(items)}  session-validation delta ${JSON.stringify(session)}`,
      )
      console.log(`  [count] after = ${JSON.stringify(after.json.transportFallback)}`)
      console.log(
        `  [state] transport state = ${transportStateOf(after.json.deployment, after.json.transportFallback)}`,
      )
      result.after.transportState = transportStateOf(after.json.deployment, after.json.transportFallback)
      if (process.env.EXPECT_ITEMS_DEGRADED_DELTA !== undefined) {
        check(
          'the items-sync degradedCalls delta is exact',
          items.degraded === Number(process.env.EXPECT_ITEMS_DEGRADED_DELTA),
          {
            expected: Number(process.env.EXPECT_ITEMS_DEGRADED_DELTA),
            got: items.degraded,
          },
        )
      }
      if (process.env.EXPECT_ITEMS_REFUSED_DELTA !== undefined) {
        check(
          'the items-sync refusedCalls delta is exact',
          items.refused === Number(process.env.EXPECT_ITEMS_REFUSED_DELTA),
          {
            expected: Number(process.env.EXPECT_ITEMS_REFUSED_DELTA),
            got: items.refused,
          },
        )
      }
      if (process.env.EXPECT_SESSION_DEGRADED_MIN !== undefined) {
        check(
          'the session-validation degradedCalls moved at least as expected',
          session.degraded >= Number(process.env.EXPECT_SESSION_DEGRADED_MIN),
          {
            atLeast: Number(process.env.EXPECT_SESSION_DEGRADED_MIN),
            got: session.degraded,
          },
        )
      }
      if (process.env.EXPECT_EVER_DEGRADED !== undefined) {
        check(
          'transportFallback.everDegraded is as expected',
          after.json.transportFallback?.everDegraded === (process.env.EXPECT_EVER_DEGRADED === '1'),
          {
            expected: process.env.EXPECT_EVER_DEGRADED === '1',
            got: after.json.transportFallback?.everDegraded,
          },
        )
      }
      // The payload must stay inside its secrecy contract: counts, durations
      // and closed enums only. A URL, a host or a secret appearing here would
      // be a leak, so the serialized lane report is scanned for the shapes.
      const serialized = JSON.stringify(after.json.transportFallback)
      control(
        'the transportFallback payload carries no URL, host or path',
        !/https?:|localhost|0\.0\.0\.0|\/opt\/|SECRET/iu.test(serialized),
        { serialized: serialized.slice(0, 200) },
      )
    }
  }

  // --- CONTROL: a forged credential must not reach the sync lane ----------
  const forged = await raw('POST', '/v1/items', {
    token: String(account.token).slice(0, -4) + 'dead',
    cookie: account.cookie,
    body: { api: '20200115', items: [], limit: 150 },
  })
  control('a forged bearer cannot drive the sync probe', forged.status !== 200, {
    status: forged.status,
    body: forged.text.slice(0, 120),
  })
  const noCredential = await raw('POST', '/v1/items', { body: { api: '20200115', items: [], limit: 150 } })
  control('no credential at all cannot drive the sync probe', noCredential.status !== 200, {
    status: noCredential.status,
  })

  console.log(
    `\n[${LABEL}] ${failures} failures, ${controlFailures} control failures, ${unverified.length} not verified`,
  )
  if (RESULT_JSON) {
    result.failures = failures
    result.controlFailures = controlFailures
    result.unverified = unverified
    writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2))
    console.log(`[${LABEL}] wrote ${RESULT_JSON}`)
  }
  return failures === 0 && controlFailures === 0 ? 0 : 1
}

const code = process.argv.includes('--self-test') ? selfTest() : await main()
process.exitCode = code
