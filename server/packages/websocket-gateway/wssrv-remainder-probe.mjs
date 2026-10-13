/**
 * Live probe for the server-side remainder of the two websocket audits, run
 * against a REAL single-container deployment through its public front door.
 *
 * Build/tests green does not mean the server boots, and a boot does not mean a
 * lane works -- so each of the three claims below is measured on the wire, with
 * a control that must make it fail if the probe is not really looking:
 *
 *   ITEM 1  a rate-limited sync client is closed 1013 "try again later", not
 *           1008 "policy violation". CONTROL: the same socket, sending frames
 *           at a rate the bucket allows, must stay open -- otherwise the close
 *           proves only that sockets close.
 *
 *   ITEM 2  INVITE_SUBSCRIBE presents a credential, and a live socket whose
 *           session was signed out is ENDED instead of streaming invite
 *           invalidations for the rest of its life. CONTROLS: the subscribe
 *           works before the sign-out (so the refusal afterwards is the
 *           credential and not the lane), and a second socket on a LIVE session
 *           is still open at the end of the same window.
 *
 *   ITEM 4  a PING is answered while a durable SYNC_ITEMS command is still
 *           running. CONTROL: the command must actually be slow (the probe
 *           reports NOT VERIFIED rather than passing on a command that finished
 *           in a millisecond, where "PONG came first" would mean nothing).
 *
 * Usage:
 *   BASE=http://127.0.0.1:3750 yarn node wssrv-remainder-probe.mjs
 *
 * Env: BASE, WS_BASE, ORIGIN, REVALIDATION_WAIT_MS (default 90000; the
 *      gateway's SYNC_SESSION_REVALIDATION_INTERVAL_MS default is 60000).
 */
import { WebSocket } from 'ws'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3750'
const WS_BASE = process.env.WS_BASE ?? BASE.replace(/^http/u, 'ws')
const ORIGIN = process.env.ORIGIN ?? BASE
const REVALIDATION_WAIT_MS = Number(process.env.REVALIDATION_WAIT_MS ?? '90000')
const API = '20200115'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
let controlFailures = 0
const unverified = []

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  } else {
    console.log(`  FAIL - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
    failures += 1
  }
  return Boolean(condition)
}

function control(name, rejected, detail) {
  if (rejected) {
    console.log(`  ctrl ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  } else {
    console.log(`  CTRL FAIL - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
    controlFailures += 1
  }
}

function notVerified(what, why) {
  unverified.push({ what, why })
  console.log(`  ----  NOT VERIFIED - ${what}: ${why}`)
}

async function raw(method, path, { body, token, cookie } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const envelope = parsed && typeof parsed === 'object' && 'data' in parsed && 'meta' in parsed
  return {
    status: response.status,
    json: envelope ? parsed.data : parsed,
    text,
    setCookie: response.headers.getSetCookie?.() ?? [],
  }
}

const cookieHeaderFrom = (setCookie) =>
  setCookie
    .map((entry) => entry.split(';', 1)[0].trim())
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ')

async function register(tag) {
  const email = `wssrv-${tag}-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
  const password = randomBytes(32).toString('hex')
  const registered = await raw('POST', '/v1/users', {
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
  if (registered.status !== 200 || !registered.json?.session?.access_token) {
    throw new Error(`register failed: ${registered.status} ${registered.text.slice(0, 300)}`)
  }
  return {
    email,
    token: registered.json.session.access_token,
    cookie: cookieHeaderFrom(registered.setCookie),
  }
}

function canonicalSyncJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalSyncJson).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(value[key])}`).join(',')}}`
}
const commandDigest = (body) => createHash('sha256').update(canonicalSyncJson(body), 'utf8').digest('hex')

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

function makeNote(bytes = 1024) {
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

function openSyncSocket(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/sockets/sync`, { origin: ORIGIN, ...(cookie ? { headers: { cookie } } : {}) })
    const state = { ws, frames: [], close: undefined }
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString())
        frame.__at = Date.now()
        state.frames.push(frame)
      } catch {
        state.frames.push({ type: 'UNPARSEABLE', __at: Date.now() })
      }
    })
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString(), at: Date.now() }
    })
    ws.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
    // `open` fires at the HTTP 101, BEFORE any close frame the gateway is about
    // to send, so it is never evidence the socket was accepted.
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
    await sleep(20)
  }
  return undefined
}

async function waitForClose(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (state.close) return state.close
    await sleep(200)
  }
  return undefined
}

async function authenticatedSocket(credential, deviceId) {
  const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
    token: credential.token,
    cookie: credential.cookie || undefined,
    body: { deviceId },
  })
  if (ticket.status !== 200 || typeof ticket.json?.ticket !== 'string') {
    throw new Error(`ticket mint failed: ${ticket.status} ${ticket.text.slice(0, 200)}`)
  }
  const socket = await openSyncSocket(credential.cookie || undefined)
  socket.ws.send(JSON.stringify(syncFrame('AUTH', { ticket: ticket.json.ticket, deviceId }, { sequence: 0 })))
  const authenticated = await waitForFrame(socket, (frame) => frame.type === 'AUTHENTICATED' || frame.type === 'ERROR')
  if (authenticated?.type !== 'AUTHENTICATED') {
    throw new Error(`socket did not authenticate: ${JSON.stringify(authenticated ?? socket.close)}`)
  }
  return { socket, sequence: 1, operations: authenticated.payload?.operations ?? [] }
}

// ---------------------------------------------------------------------------
// ITEM 1 -- the close code a rate-limited client actually receives
// ---------------------------------------------------------------------------
async function probeRateLimitCloseCode() {
  console.log('\nITEM 1 -- the close code a rate-limited sync client receives')
  const credential = await register('rate')

  // CONTROL first: a socket that paces itself inside the frame bucket (32
  // burst, 16/s refill) must stay open and be answered. Without this, the 1013
  // below would only prove that some socket closed.
  const paced = await authenticatedSocket(credential, `device-paced-${randomUUID()}`)
  for (let index = 0; index < 8; index += 1) {
    paced.socket.ws.send(JSON.stringify(syncFrame('PING', {}, { sequence: paced.sequence++ })))
    await sleep(120)
  }
  const pacedPongs = paced.socket.frames.filter((frame) => frame.type === 'PONG').length
  control('a paced client is answered and stays open', pacedPongs === 8 && paced.socket.close === undefined, {
    pongs: pacedPongs,
    close: paced.socket.close,
  })
  paced.socket.ws.close()

  const flooded = await authenticatedSocket(credential, `device-flood-${randomUUID()}`)
  // PACED, not blasted, and the pacing is load-bearing. The gateway has TWO
  // independent guards in front of the handler and they close with the same
  // 1013 for different reasons: the per-socket ingress token bucket (32 frames
  // of burst, 16/s) and the handler's own ingress QUEUE depth
  // (MAX_SYNC_QUEUED_FRAMES = 8, 'Sync command queue is full.'). Writing 60
  // frames in one tick fills the queue long before it empties the bucket, so it
  // would measure backpressure and report it as a rate limit. A few
  // milliseconds between frames keeps the queue at a depth of one -- a PONG is
  // answered synchronously -- while the bucket, which refills at 16/s, still
  // runs out at around the 34th frame.
  for (let index = 0; index < 60 && flooded.socket.close === undefined; index += 1) {
    flooded.socket.ws.send(JSON.stringify(syncFrame('PING', {}, { sequence: flooded.sequence++ })))
    await sleep(3)
  }
  const close = await waitForClose(flooded.socket, 15_000)
  check('a flooded sync socket is closed at all', close !== undefined, { close })
  check(
    'the close code is 1013 "try again later", not 1008 "policy violation"',
    close?.code === 1013,
    { code: close?.code, reason: close?.reason },
  )
  check('the close reason still names the cause', close?.reason === 'sync rate limit exceeded', {
    reason: close?.reason,
  })
  try {
    flooded.socket.ws.terminate()
  } catch {
    /* already closed */
  }
  return { code: close?.code, reason: close?.reason }
}

// ---------------------------------------------------------------------------
// ITEM 2 -- a revoked session's invite stream stops
// ---------------------------------------------------------------------------
async function probeInviteCredential() {
  console.log('\nITEM 2 -- INVITE_EVENTS presents a credential, and a revoked session loses the socket')
  const victim = await register('invite')
  const bystander = await register('bystander')

  const session = await authenticatedSocket(victim, `device-invite-${randomUUID()}`)
  check('the socket advertises INVITE_EVENTS', session.operations.includes('INVITE_EVENTS'), {
    operations: session.operations,
  })
  const controlSession = await authenticatedSocket(bystander, `device-control-${randomUUID()}`)

  const subscribe = async (state, cursor) => {
    const requestId = `req-${randomUUID()}`
    state.socket.ws.send(
      JSON.stringify(
        syncFrame(
          'INVITE_SUBSCRIBE',
          { ...(cursor === undefined ? {} : { cursor }), limit: 20 },
          { sequence: state.sequence++, requestId, commandId: requestId },
        ),
      ),
    )
    return waitForFrame(
      state.socket,
      (frame) =>
        frame.requestId === requestId &&
        (frame.type === 'INVITE_RECONCILE' || frame.type === 'INVITE_READY' || frame.type === 'ERROR'),
      20_000,
    )
  }

  // CONTROL: the lane works for this credential BEFORE the sign-out, so the
  // refusal afterwards is about the credential and not about the lane.
  const bootstrap = await subscribe(session)
  control('INVITE_SUBSCRIBE is served while the session is live', bootstrap?.type === 'INVITE_RECONCILE', {
    frame: bootstrap?.type,
    payload: bootstrap?.payload,
  })
  const cursor = bootstrap?.payload?.cursor
  const ready = cursor === undefined ? undefined : await subscribe(session, cursor)
  control('a cursored INVITE_SUBSCRIBE reaches INVITE_READY', ready?.type === 'INVITE_READY', { frame: ready?.type })

  const controlBootstrap = await subscribe(controlSession)
  control('the bystander socket also subscribes', controlBootstrap?.type === 'INVITE_RECONCILE', {
    frame: controlBootstrap?.type,
  })

  const logout = await raw('POST', '/v1/logout', { token: victim.token, cookie: victim.cookie || undefined })
  check('the session is signed out over HTTP', logout.status === 200 || logout.status === 204, {
    status: logout.status,
    body: logout.text.slice(0, 160),
  })

  // THE DIRECT PROOF that the lane presents a credential: the socket is still
  // open and still authenticated as far as it knows, and a fresh subscribe on
  // it is refused. Before the fix this answered INVITE_RECONCILE.
  //
  // EITHER session code is a pass, and which one arrives is recorded rather
  // than asserted. The per-operation refusal comes from `authorize`, whose
  // `kind` is the SYNC lane's deliberately lenient recovery hint -- a 401 is
  // reported as the retryable SESSION_STALE so a client whose token merely
  // rotated can re-ticket. The strict session verdict belongs to the
  // revalidation below, which is what actually ends the socket. Asserting one
  // specific code here would be asserting a classification this lane does not
  // own; what matters is that the lane ASKED and refused.
  const afterLogout = await subscribe(session, cursor)
  check(
    'INVITE_SUBSCRIBE on a signed-out session is refused',
    afterLogout?.type === 'ERROR' &&
      (afterLogout.payload?.code === 'NOT_AUTHORIZED' || afterLogout.payload?.code === 'SESSION_STALE'),
    { frame: afterLogout?.type, payload: afterLogout?.payload, close: session.socket.close },
  )

  // AND the socket itself must go: a revoked session may not keep a live
  // authenticated socket, its invite subscription or its per-user socket slot.
  const closed = await waitForClose(session.socket, REVALIDATION_WAIT_MS)
  check('the revoked session loses its socket', closed !== undefined, { close: closed })
  check(
    'the close names the revocation',
    closed?.code === 1008 && closed?.reason === 'Sync session is no longer authorized.',
    { code: closed?.code, reason: closed?.reason },
  )

  // CONTROL: the bystander, whose session was never touched, is still open at
  // the end of the SAME window. Without this, "the socket closed" could be any
  // periodic teardown at all.
  control('a live session keeps its socket across the same window', controlSession.socket.close === undefined, {
    close: controlSession.socket.close,
  })
  try {
    controlSession.socket.ws.close()
    session.socket.ws.terminate()
  } catch {
    /* already closed */
  }
  return { refusal: afterLogout?.payload?.code, close: closed }
}

// ---------------------------------------------------------------------------
// ITEM 4 -- a slow command does not delay a PONG
// ---------------------------------------------------------------------------
async function probePongUnderSlowCommand() {
  console.log('\nITEM 4 -- a PING answered while a durable SYNC_ITEMS command is running')
  const credential = await register('lanes')
  const session = await authenticatedSocket(credential, `device-lanes-${randomUUID()}`)
  if (!session.operations.includes('SYNC_ITEMS')) {
    notVerified('the PONG-under-command measurement', `the socket advertised ${JSON.stringify(session.operations)}`)
    return {}
  }

  // A real durable write, sized so it takes measurable time on the deployment's
  // own storage while staying well under MAX_SYNC_FRAME_BYTES (512 KiB).
  const items = Array.from({ length: 120 }, () => makeNote(1024))
  const body = { api: API, items }
  const digest = commandDigest(body)
  const commandRequestId = `req-${randomUUID()}`
  const command = syncFrame(
    'COMMAND',
    { command: 'SYNC_ITEMS', body },
    { sequence: session.sequence++, requestId: commandRequestId, commandId: `cmd-${randomUUID()}`, digest },
  )
  const commandBytes = Buffer.byteLength(JSON.stringify(command), 'utf8')
  check('the COMMAND frame stays under the frame cap', commandBytes < 512 * 1024, { commandBytes })

  const pingRequestId = `req-${randomUUID()}`
  const sentAt = Date.now()
  session.socket.ws.send(JSON.stringify(command))
  session.socket.ws.send(
    JSON.stringify(syncFrame('PING', {}, { sequence: session.sequence++, requestId: pingRequestId, commandId: pingRequestId })),
  )

  const pong = await waitForFrame(session.socket, (frame) => frame.requestId === pingRequestId, 40_000)
  const terminal = await waitForFrame(
    session.socket,
    (frame) =>
      frame.requestId === commandRequestId && (frame.type === 'COMMITTED' || frame.type === 'STATUS' || frame.type === 'ERROR'),
    60_000,
  )
  const pongMs = pong === undefined ? undefined : pong.__at - sentAt
  const commandMs = terminal === undefined ? undefined : terminal.__at - sentAt

  check('the PING was answered', pong?.type === 'PONG', { frame: pong?.type, pongMs })
  check('the command was answered', terminal !== undefined, { frame: terminal?.type, commandMs })
  check('the PONG arrived BEFORE the command settled', pongMs !== undefined && commandMs !== undefined && pongMs < commandMs, {
    pongMs,
    commandMs,
  })
  // The control for this measurement: a command that finishes instantly makes
  // "the PONG came first" vacuous, so the probe refuses to call it proven.
  if (commandMs !== undefined && commandMs < 150) {
    notVerified(
      'the PONG-before-command ordering as a MEANINGFUL measurement',
      `the command settled in ${commandMs} ms, too fast for the ordering to say anything`,
    )
  } else {
    control(
      'the command really was slow enough for the ordering to mean something',
      commandMs !== undefined && commandMs >= 150,
      { commandMs, pongMs },
    )
  }
  check(
    'the socket survived the command (no heartbeat terminate)',
    session.socket.close === undefined,
    { close: session.socket.close },
  )

  // SECOND MEASUREMENT: how far ahead of a PING the durable work may pile up.
  // One command is enough to show the lanes are separate; a QUEUE of them shows
  // what the old single chain made a PING wait for, because the wait was the
  // SUM of everything ahead of it. The ingress queue admits
  // MAX_SYNC_QUEUED_FRAMES = 8 frames, so seven commands plus the ping is the
  // deepest a client can legitimately make it -- and each of those commands is
  // bounded only by the backend timeout, which is where the heartbeat deadline
  // comes into reach.
  const queued = []
  const deepStart = Date.now()
  for (let index = 0; index < 7; index += 1) {
    const requestId = `req-${randomUUID()}`
    const queuedBody = { api: API, items: Array.from({ length: 120 }, () => makeNote(1024)) }
    queued.push(requestId)
    session.socket.ws.send(
      JSON.stringify(
        syncFrame(
          'COMMAND',
          { command: 'SYNC_ITEMS', body: queuedBody },
          {
            sequence: session.sequence++,
            requestId,
            commandId: `cmd-${randomUUID()}`,
            digest: commandDigest(queuedBody),
          },
        ),
      ),
    )
  }
  const deepPingRequestId = `req-${randomUUID()}`
  session.socket.ws.send(
    JSON.stringify(
      syncFrame('PING', {}, { sequence: session.sequence++, requestId: deepPingRequestId, commandId: deepPingRequestId }),
    ),
  )
  const deepPong = await waitForFrame(session.socket, (frame) => frame.requestId === deepPingRequestId, 60_000)
  const deepPongMs = deepPong === undefined ? undefined : deepPong.__at - deepStart
  const committedAfterPong =
    deepPong === undefined
      ? undefined
      : queued.filter((requestId) =>
          session.socket.frames.some(
            (frame) => frame.requestId === requestId && frame.type === 'COMMITTED' && frame.__at <= deepPong.__at,
          ),
        ).length
  let lastCommandMs
  for (const requestId of queued) {
    const settled = await waitForFrame(
      session.socket,
      (frame) => frame.requestId === requestId && (frame.type === 'COMMITTED' || frame.type === 'ERROR'),
      120_000,
    )
    if (settled !== undefined) {
      lastCommandMs = settled.__at - deepStart
    }
  }
  check('the PING behind seven durable commands was answered', deepPong?.type === 'PONG', {
    frame: deepPong?.type,
    deepPongMs,
  })

  // DISCRIMINATOR: eight tiny frames on the same socket, with nothing durable
  // in front of them. If those round-trip in milliseconds then neither the
  // 1.4 MiB of command bytes nor the socket itself is what delayed the PING
  // above, and what remains is the only other candidate: the deployment's
  // event loop.
  const tinyStart = Date.now()
  let lastTinyRequestId = ''
  for (let index = 0; index < 8; index += 1) {
    lastTinyRequestId = `req-${randomUUID()}`
    session.socket.ws.send(
      JSON.stringify(
        syncFrame('PING', {}, { sequence: session.sequence++, requestId: lastTinyRequestId, commandId: lastTinyRequestId }),
      ),
    )
  }
  const lastTiny = await waitForFrame(session.socket, (frame) => frame.requestId === lastTinyRequestId, 30_000)
  const tinyMs = lastTiny === undefined ? undefined : lastTiny.__at - tinyStart
  control('eight pipelined PINGs with nothing durable ahead of them round-trip promptly', tinyMs !== undefined && tinyMs < 250, {
    tinyMs,
  })

  // NOT a check. The frame lanes decide what WAITS FOR WHAT inside the handler;
  // they cannot decide whether the process gets a turn. This deployment is a
  // single Node process whose storage binding (better-sqlite3) is SYNCHRONOUS,
  // so a durable write occupies the event loop outright -- and a frame that has
  // not been read off the socket has not reached a lane. The one-command
  // measurement above is the live proof the lanes are separate; the depth at
  // which that stops mattering is a property of the topology, measured here and
  // reported rather than claimed either way.
  notVerified(
    'a PING behind SEVEN queued durable commands being unaffected on THIS topology',
    `the PONG landed at ${deepPongMs} ms with ${committedAfterPong} of 7 commands already committed and the last at ` +
      `${lastCommandMs} ms; the single container runs one Node process over a synchronous sqlite binding, so queued ` +
      'durable work starves the event loop no matter how the handler orders frames. A gRPC durable port (the ' +
      'multi-container topology) awaits off-loop and is not measured here.',
  )
  check('the socket still survived the queue', session.socket.close === undefined, { close: session.socket.close })

  session.socket.ws.close()
  return { pongMs, commandMs, deepPongMs, lastCommandMs, committedAfterPong, tinyMs }
}

async function main() {
  console.log(`wssrv remainder probe against ${BASE}`)
  const readiness = await raw('GET', '/healthcheck/readiness')
  check('the deployment answers readiness', readiness.status === 200, { status: readiness.status })

  const results = {}
  results.item1 = await probeRateLimitCloseCode()
  results.item4 = await probePongUnderSlowCommand()
  results.item2 = await probeInviteCredential()

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(results, null, 2))
  console.log(`failures=${failures} controlFailures=${controlFailures} notVerified=${unverified.length}`)
  for (const entry of unverified) {
    console.log(`  NOT VERIFIED: ${entry.what} -- ${entry.why}`)
  }
  process.exit(failures + controlFailures > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('Probe crashed: websocket acceptance did not complete')
  process.exit(2)
})
