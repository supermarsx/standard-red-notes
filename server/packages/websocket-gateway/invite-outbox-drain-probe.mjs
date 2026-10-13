/**
 * Measures whether a row in auth's `invite_event_outbox` is actually drained on
 * THIS topology and whether the invalidation reaches the recipient's socket.
 *
 * No production producer reaches that table on a default self-hosted deployment
 * (subscription invites are refused for want of a `user_subscriptions` row), so
 * the row is PLANTED by an external command and this probe measures the rest of
 * the path: dispatcher -> domain event -> gateway -> socket.
 *
 * Usage: BASE=... TOPOLOGY=... PLANT="<shell command taking the user uuid>" node invite-outbox-drain-probe.mjs
 */
import { WebSocket } from 'ws'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3870'
const WS_BASE = process.env.WS_BASE ?? BASE.replace(/^http/u, 'ws')
const ORIGIN = process.env.ORIGIN ?? BASE
const TOPOLOGY = process.env.TOPOLOGY ?? 'unknown'
const PLANT = process.env.PLANT
const READ = process.env.READ

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function raw(method, path, { body, token, cookie } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const cookieHeaderFrom = (s) =>
  s.map((e) => e.split(';', 1)[0].trim()).filter((p) => p.includes('=') && !p.endsWith('=')).join('; ')

async function register(label) {
  const email = `invite-drain-${label}-${Date.now()}-${randomBytes(2).toString('hex')}@example.com`
  const r = await raw('POST', '/v1/users', {
    body: {
      email,
      password: randomBytes(32).toString('hex'),
      api: '20240226',
      version: '004',
      pw_nonce: randomBytes(32).toString('hex'),
      origination: 'registration',
      created: String(Date.now()),
      ephemeral: false,
    },
  })
  if (r.status !== 200) throw new Error(`register failed ${r.status} ${r.text.slice(0, 200)}`)
  return { email, uuid: r.json.user.uuid, token: r.json.session.access_token, cookie: cookieHeaderFrom(r.setCookie) }
}

function frame(type, payload, { sequence, requestId, commandId } = {}) {
  return {
    version: 1,
    channel: 'sync',
    type,
    requestId: requestId ?? `req-${randomUUID()}`,
    commandId: commandId ?? `cmd-${randomUUID()}`,
    sequence: sequence ?? 0,
    payloadLength: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    payload,
  }
}

function open(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/sockets/sync`, { origin: ORIGIN, ...(cookie ? { headers: { cookie } } : {}) })
    const state = { ws, frames: [], close: undefined }
    ws.on('message', (d) => {
      try {
        const f = JSON.parse(d.toString())
        f.__at = Date.now()
        state.frames.push(f)
      } catch {
        /* ignore */
      }
    })
    ws.on('close', (c, r) => (state.close = { code: c, reason: r.toString() }))
    ws.on('error', (e) => reject(e))
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('open timeout')), 15_000)
  })
}

async function waitFor(state, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = state.frames.find(predicate)
    if (f) return f
    if (state.close) return undefined
    await sleep(5)
  }
  return undefined
}

async function main() {
  console.log(`\n=== AUTH INVITE OUTBOX DRAIN PROBE - topology=${TOPOLOGY} base=${BASE} ===`)
  const user = await register('recipient')
  const deviceId = `drain-${randomUUID()}`
  const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
    token: user.token,
    cookie: user.cookie,
    body: { deviceId },
  })
  const socket = await open(user.cookie)
  socket.ws.send(JSON.stringify(frame('AUTH', { ticket: ticket.json.ticket, deviceId }, { sequence: 0 })))
  const authed = await waitFor(socket, (f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR')
  if (authed?.type !== 'AUTHENTICATED') throw new Error(`no AUTHENTICATED: ${JSON.stringify(authed ?? socket.close)}`)
  let sequence = 1

  const r1 = `req-${randomUUID()}`
  socket.ws.send(JSON.stringify(frame('INVITE_SUBSCRIBE', { limit: 20 }, { sequence: sequence++, requestId: r1, commandId: r1 })))
  const bootstrap = await waitFor(socket, (f) => f.requestId === r1)
  if (bootstrap?.type !== 'INVITE_RECONCILE') throw new Error(`no bootstrap: ${JSON.stringify(bootstrap)}`)
  const r2 = `req-${randomUUID()}`
  socket.ws.send(
    JSON.stringify(
      frame('INVITE_SUBSCRIBE', { cursor: bootstrap.payload.cursor, limit: 20 }, { sequence: sequence++, requestId: r2, commandId: r2 }),
    ),
  )
  const ready = await waitFor(socket, (f) => f.requestId === r2)
  console.log(`  armed: ${ready?.type} (control: a live cursored subscription exists before the row is planted)`)

  const t0 = Date.now()
  const planted = execFileSync('bash', ['-lc', `${PLANT} ${user.uuid}`], { encoding: 'utf8' }).trim()
  console.log(`  ${planted}`)

  const batch = await waitFor(socket, (f) => f.type === 'INVITE_BATCH' && f.__at >= t0, 25_000)
  console.log(
    `  [${batch ? 'YES ' : 'NO  '}] the planted auth outbox row reached the recipient socket ${JSON.stringify({
      latencyMs: batch ? batch.__at - t0 : null,
      events: batch?.payload?.events?.map((e) => `${e.kind}/${e.action}`),
    })}`,
  )
  if (READ) {
    await sleep(1500)
    console.log('  --- invite_event_outbox after the drain ---')
    console.log(execFileSync('bash', ['-lc', READ], { encoding: 'utf8' }).trim())
  }
  try {
    socket.ws.close()
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error('PROBE CRASHED: invite outbox drain did not complete')
  process.exitCode = 1
})
