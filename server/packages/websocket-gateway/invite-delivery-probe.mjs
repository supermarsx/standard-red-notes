/**
 * Live invite-delivery probe. Measures, on a real deployment through its front
 * door, whether an invite REACHES its recipient and grants real access.
 *
 * Every capability is scored on a PRESENT SUCCESS, never on the absence of an
 * error, and every claim carries the evidence that produced it.
 *
 * Usage: BASE=http://127.0.0.1:3870 TOPOLOGY=single node invite-probe.mjs
 */
import { WebSocket } from 'ws'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3870'
const WS_BASE = process.env.WS_BASE ?? BASE.replace(/^http/u, 'ws')
const ORIGIN = process.env.ORIGIN ?? BASE
const TOPOLOGY = process.env.TOPOLOGY ?? 'unknown'
const TAG = process.env.TAG ?? randomBytes(3).toString('hex')
const API = '20200115'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function record(name, verdict, evidence) {
  results.push({ name, verdict, evidence })
  const mark = verdict === 'YES' ? 'YES ' : verdict === 'NO' ? 'NO  ' : verdict === 'ctrl' ? 'ctrl' : 'info'
  console.log(`  [${mark}] ${name} ${evidence === undefined ? '' : JSON.stringify(evidence)}`)
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
    .map((e) => e.split(';', 1)[0].trim())
    .filter((p) => p.includes('=') && !p.endsWith('='))
    .join('; ')

async function register(label) {
  const email = `invite-${TAG}-${label}-${Date.now()}@example.com`
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
    throw new Error(`register ${label} failed: ${registered.status} ${registered.text.slice(0, 300)}`)
  }
  return {
    label,
    email,
    password,
    uuid: registered.json.user?.uuid,
    token: registered.json.session.access_token,
    cookie: cookieHeaderFrom(registered.setCookie),
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

function openSyncSocket(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/sockets/sync`, { origin: ORIGIN, ...(cookie ? { headers: { cookie } } : {}) })
    const state = { ws, frames: [], close: undefined }
    ws.on('message', (d) => {
      try {
        const f = JSON.parse(d.toString())
        f.__at = Date.now()
        state.frames.push(f)
      } catch {
        state.frames.push({ type: 'UNPARSEABLE', __at: Date.now() })
      }
    })
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString(), at: Date.now() }
    })
    ws.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('sync socket open timeout')), 15_000)
  })
}

async function waitForFrame(state, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = state.frames.find(predicate)
    if (found) return found
    if (state.close) return undefined
    await sleep(5)
  }
  return undefined
}

async function authenticatedSocket(cred, deviceId, { cookieOnly = false } = {}) {
  const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
    token: cookieOnly ? undefined : cred.token,
    cookie: cred.cookie || undefined,
    body: { deviceId },
  })
  if (ticket.status !== 200 || typeof ticket.json?.ticket !== 'string') {
    throw new Error(
      `ticket mint failed (${cred.label}, cookieOnly=${cookieOnly}): ${ticket.status} ${ticket.text.slice(0, 250)}`,
    )
  }
  const socket = await openSyncSocket(cred.cookie || undefined)
  socket.ws.send(JSON.stringify(syncFrame('AUTH', { ticket: ticket.json.ticket, deviceId }, { sequence: 0 })))
  const authed = await waitForFrame(socket, (f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR')
  if (authed?.type !== 'AUTHENTICATED') {
    throw new Error(`socket did not authenticate (${cred.label}): ${JSON.stringify(authed ?? socket.close)}`)
  }
  return { socket, sequence: 1, operations: authed.payload?.operations ?? [], cred }
}

/** Subscribe and leave a LIVE cursored subscription armed for pushes. */
async function armInviteSubscription(session) {
  const send = (payload) => {
    const requestId = `req-${randomUUID()}`
    session.socket.ws.send(
      JSON.stringify(
        syncFrame('INVITE_SUBSCRIBE', payload, { sequence: session.sequence++, requestId, commandId: requestId }),
      ),
    )
    return { requestId }
  }
  const b = send({ limit: 20 })
  const bootstrap = await waitForFrame(session.socket, (f) =>
    f.requestId === b.requestId && ['INVITE_RECONCILE', 'INVITE_READY', 'ERROR'].includes(f.type),
  )
  if (bootstrap?.type !== 'INVITE_RECONCILE') return { bootstrap }
  const cursor = bootstrap.payload?.cursor
  const c = send({ cursor, limit: 20 })
  const ready = await waitForFrame(session.socket, (f) =>
    f.requestId === c.requestId && ['INVITE_READY', 'INVITE_BATCH', 'ERROR'].includes(f.type),
  )
  return { bootstrap, cursor, ready, requestId: c.requestId, commandId: c.requestId }
}

/** Wait for the next INVITE_BATCH after `since` and ACK it so the stream keeps flowing. */
async function nextInviteBatch(session, armed, since, timeoutMs = 20_000) {
  const batch = await waitForFrame(session.socket, (f) => f.type === 'INVITE_BATCH' && f.__at >= since, timeoutMs)
  if (!batch) return undefined
  const next = batch.payload?.nextCursor
  if (next) {
    session.socket.ws.send(
      JSON.stringify(
        syncFrame('INVITE_ACK', { cursor: next }, {
          sequence: session.sequence++,
          requestId: armed.requestId,
          commandId: armed.commandId,
        }),
      ),
    )
  }
  return batch
}

function makeItem(extra = {}) {
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
    ...extra,
  }
}

async function httpSync(cred, body, { cookieOnly = false } = {}) {
  return raw('POST', '/v1/items', {
    token: cookieOnly ? undefined : cred.token,
    cookie: cred.cookie || undefined,
    body: { api: API, sync_token: null, limit: 150, compute_integrity: false, ...body },
  })
}

// ===========================================================================
async function main() {
  console.log(`\n=== INVITE DELIVERY PROBE - topology=${TOPOLOGY} base=${BASE} tag=${TAG} ===`)

  const A = await register('inviter')
  const B = await register('recipient')
  const C = await register('outsider')
  console.log('  Created three disposable probe accounts')

  // ---------------------------------------------------------------- lane state
  const sessionB = await authenticatedSocket(B, `dev-b-${randomUUID()}`)
  record(
    'the recipient socket advertises INVITE_EVENTS',
    sessionB.operations.includes('INVITE_EVENTS') ? 'YES' : 'NO',
    { operations: sessionB.operations },
  )
  const armedB = await armInviteSubscription(sessionB)
  record(
    'a cursored invite subscription is live for the recipient',
    armedB.ready?.type === 'INVITE_READY' ? 'YES' : 'NO',
    {
      bootstrap: armedB.bootstrap?.type,
      ready: armedB.ready?.type,
      detail: armedB.ready?.payload ?? armedB.bootstrap?.payload,
    },
  )

  // ================================================== 1. SUBSCRIPTION INVITES
  console.log('\n-- subscription invites (auth invite_event_outbox producer) --')
  const t0sub = Date.now()
  const subInvite = await raw('POST', '/v1/subscription-invites', {
    token: A.token,
    cookie: A.cookie || undefined,
    body: { identifier: B.email },
  })
  const subInviteWorked = subInvite.status === 200 && subInvite.json?.success === true
  record('A can create a subscription invite for B', subInviteWorked ? 'YES' : 'NO', {
    status: subInvite.status,
    body: subInvite.text.slice(0, 300),
  })
  if (subInviteWorked) {
    const batch = await nextInviteBatch(sessionB, armedB, t0sub, 15_000)
    record('B is pushed the subscription invite over INVITE_EVENTS', batch ? 'YES' : 'NO', {
      latencyMs: batch ? batch.__at - t0sub : null,
      kinds: batch?.payload?.events?.map((e) => `${e.kind}/${e.action}`),
    })
  }
  const subListA = await raw('GET', '/v1/subscription-invites', { token: A.token, cookie: A.cookie || undefined })
  record('the inviter outbound subscription-invite list', 'info', {
    status: subListA.status,
    count: subListA.json?.invitations?.length,
    body: subListA.text.slice(0, 250),
  })
  const subListB = await raw('GET', '/v1/subscription-invites', { token: B.token, cookie: B.cookie || undefined })
  record('the recipient subscription-invite list contains what it received', (subListB.json?.invitations?.length ?? 0) > 0 ? 'YES' : 'NO', {
    status: subListB.status,
    count: subListB.json?.invitations?.length,
  })

  // ================================================== 2. SHARED-VAULT INVITES
  console.log('\n-- shared-vault invites (syncing-server producer) --')
  const vault = await raw('POST', '/v1/shared-vaults', { token: A.token, cookie: A.cookie || undefined, body: {} })
  const vaultUuid = vault.json?.sharedVault?.uuid
  record('A can create a shared vault', typeof vaultUuid === 'string' ? 'YES' : 'NO', {
    status: vault.status,
    body: vault.text.slice(0, 300),
  })
  if (!vaultUuid) {
    summarize()
    return
  }

  const t0inv = Date.now()
  const invite = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites`, {
    token: A.token,
    cookie: A.cookie || undefined,
    body: {
      recipient_uuid: B.uuid,
      encrypted_message: '004:' + randomBytes(64).toString('base64'),
      permission: 'write',
    },
  })
  const inviteUuid = invite.json?.invite?.uuid
  record('A can invite B to the shared vault', typeof inviteUuid === 'string' ? 'YES' : 'NO', {
    status: invite.status,
    body: invite.text.slice(0, 300),
  })

  const pushed = inviteUuid ? await nextInviteBatch(sessionB, armedB, t0inv, 20_000) : undefined
  record('B is pushed the shared-vault invite over INVITE_EVENTS, with no reload', pushed ? 'YES' : 'NO', {
    latencyMs: pushed ? pushed.__at - t0inv : null,
    events: pushed?.payload?.events?.map((e) => ({ kind: e.kind, action: e.action, inviteUuid: e.inviteUuid })),
  })

  const inboundB = await raw('GET', '/v1/shared-vaults/invites', { token: B.token, cookie: B.cookie || undefined })
  const inboundList = inboundB.json?.invites ?? []
  record('the recipient in-app inbound invite list contains the invite', inboundList.some((i) => i.uuid === inviteUuid) ? 'YES' : 'NO', {
    status: inboundB.status,
    count: inboundList.length,
    body: inboundList.length ? undefined : inboundB.text.slice(0, 300),
  })

  // -------- negative: an outsider must not see or accept the invite
  const inboundC = await raw('GET', '/v1/shared-vaults/invites', { token: C.token, cookie: C.cookie || undefined })
  const cList = inboundC.json?.invites ?? []
  record('an unrelated account does NOT see the invite (control)', !cList.some((i) => i.uuid === inviteUuid) ? 'ctrl' : 'NO', {
    count: cList.length,
  })
  const acceptByC = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites/${inviteUuid}/accept`, {
    token: C.token,
    cookie: C.cookie || undefined,
    body: {},
  })
  record('an unrelated account cannot accept the invite', acceptByC.status >= 400 ? 'ctrl' : 'NO', {
    status: acceptByC.status,
    body: acceptByC.text.slice(0, 200),
  })

  // -------- acceptance grants real access
  const t0acc = Date.now()
  const accept = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites/${inviteUuid}/accept`, {
    token: B.token,
    cookie: B.cookie || undefined,
    body: {},
  })
  record('B can accept the invite', accept.status === 200 ? 'YES' : 'NO', {
    status: accept.status,
    body: accept.text.slice(0, 250),
  })
  const accPush = await nextInviteBatch(sessionB, armedB, t0acc, 15_000)
  record('B is pushed the acceptance/membership event', accPush ? 'YES' : 'NO', {
    latencyMs: accPush ? accPush.__at - t0acc : null,
    events: accPush?.payload?.events?.map((e) => `${e.kind}/${e.action}`),
  })

  const vaultsB = await raw('GET', '/v1/shared-vaults', { token: B.token, cookie: B.cookie || undefined })
  const vaultsBList = vaultsB.json?.sharedVaults ?? []
  record('B now lists the shared vault as a member', vaultsBList.some((v) => v.uuid === vaultUuid) ? 'YES' : 'NO', {
    status: vaultsB.status,
    body: vaultsBList.length ? undefined : vaultsB.text.slice(0, 250),
  })

  const item = makeItem({ shared_vault_uuid: vaultUuid, key_system_identifier: randomUUID() })
  const write = await httpSync(B, { items: [item] })
  const saved = write.json?.saved_items ?? []
  record('B can WRITE an item into the vault after accepting', saved.some((i) => i.uuid === item.uuid) ? 'YES' : 'NO', {
    status: write.status,
    saved: saved.length,
    conflicts: (write.json?.conflicts ?? []).length,
    conflictTypes: (write.json?.conflicts ?? []).map((c) => c.type),
    body: saved.length ? undefined : write.text.slice(0, 400),
  })
  const readA = await httpSync(A, { items: [] })
  const seenByA = (readA.json?.retrieved_items ?? []).some((i) => i.uuid === item.uuid)
  record('the vault owner can READ the item the member wrote', seenByA ? 'YES' : 'NO', {
    status: readA.status,
    retrieved: (readA.json?.retrieved_items ?? []).length,
  })

  // ========================================================= 3. NEGATIVE CASES
  console.log('\n-- negative cases --')
  const dup = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites`, {
    token: A.token,
    cookie: A.cookie || undefined,
    body: {
      recipient_uuid: B.uuid,
      encrypted_message: '004:' + randomBytes(64).toString('base64'),
      permission: 'write',
    },
  })
  record('a duplicate invite to an already-accepted member is refused', dup.status >= 400 ? 'ctrl' : 'NO', {
    status: dup.status,
    body: dup.text.slice(0, 250),
  })

  const acceptTwice = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites/${inviteUuid}/accept`, {
    token: B.token,
    cookie: B.cookie || undefined,
    body: {},
  })
  record('accepting the same invite twice is refused', acceptTwice.status >= 400 ? 'ctrl' : 'NO', {
    status: acceptTwice.status,
    body: acceptTwice.text.slice(0, 250),
  })

  const ghost = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites`, {
    token: A.token,
    cookie: A.cookie || undefined,
    body: {
      recipient_uuid: randomUUID(),
      encrypted_message: '004:' + randomBytes(64).toString('base64'),
      permission: 'write',
    },
  })
  record('an invite to a non-existent account is refused', ghost.status >= 400 ? 'ctrl' : 'NO', {
    status: ghost.status,
    body: ghost.text.slice(0, 250),
  })

  const subGhost = await raw('POST', '/v1/subscription-invites', {
    token: A.token,
    cookie: A.cookie || undefined,
    body: { identifier: `nobody-${randomUUID()}@example.com` },
  })
  record('a subscription invite to a non-existent address', 'info', {
    status: subGhost.status,
    body: subGhost.text.slice(0, 250),
  })

  // ================================================== 4. REVOCATION BEFORE ACCEPT
  console.log('\n-- revocation before acceptance --')
  const vault2 = await raw('POST', '/v1/shared-vaults', { token: A.token, cookie: A.cookie || undefined, body: {} })
  const vault2Uuid = vault2.json?.sharedVault?.uuid
  const inv2 = await raw('POST', `/v1/shared-vaults/${vault2Uuid}/invites`, {
    token: A.token,
    cookie: A.cookie || undefined,
    body: {
      recipient_uuid: C.uuid,
      encrypted_message: '004:' + randomBytes(64).toString('base64'),
      permission: 'read',
    },
  })
  const inv2Uuid = inv2.json?.invite?.uuid
  record('A can invite C to a second vault (setup)', typeof inv2Uuid === 'string' ? 'YES' : 'NO', {
    status: inv2.status,
    body: inv2.text.slice(0, 200),
  })

  const sessionC = await authenticatedSocket(C, `dev-c-${randomUUID()}`)
  const armedC = await armInviteSubscription(sessionC)
  record('C holds a live invite subscription (setup)', armedC.ready?.type === 'INVITE_READY' ? 'ctrl' : 'NO', {
    ready: armedC.ready?.type,
  })
  const inboundCBefore = await raw('GET', '/v1/shared-vaults/invites', { token: C.token, cookie: C.cookie || undefined })
  record('the pending invite IS in C list before revocation (control)', (inboundCBefore.json?.invites ?? []).some((i) => i.uuid === inv2Uuid) ? 'ctrl' : 'NO', {
    count: (inboundCBefore.json?.invites ?? []).length,
  })

  const t0rev = Date.now()
  const revoke = await raw('DELETE', `/v1/shared-vaults/${vault2Uuid}/invites/${inv2Uuid}`, {
    token: A.token,
    cookie: A.cookie || undefined,
  })
  record('A can revoke the pending invite', revoke.status === 200 ? 'YES' : 'NO', {
    status: revoke.status,
    body: revoke.text.slice(0, 200),
  })
  const revPush = await nextInviteBatch(sessionC, armedC, t0rev, 15_000)
  record('the recipient client learns about the revocation over INVITE_EVENTS', revPush ? 'YES' : 'NO', {
    latencyMs: revPush ? revPush.__at - t0rev : null,
    events: revPush?.payload?.events?.map((e) => `${e.kind}/${e.action}`),
  })
  const inboundCAfter = await raw('GET', '/v1/shared-vaults/invites', { token: C.token, cookie: C.cookie || undefined })
  const cAfter = inboundCAfter.json?.invites ?? []
  record('the revoked invite is gone from the recipient list', !cAfter.some((i) => i.uuid === inv2Uuid) ? 'YES' : 'NO', {
    count: cAfter.length,
  })
  const acceptRevoked = await raw('POST', `/v1/shared-vaults/${vault2Uuid}/invites/${inv2Uuid}/accept`, {
    token: C.token,
    cookie: C.cookie || undefined,
    body: {},
  })
  record('accepting a revoked invite FAILS CLOSED', acceptRevoked.status >= 400 ? 'YES' : 'NO', {
    status: acceptRevoked.status,
    body: acceptRevoked.text.slice(0, 250),
  })
  const vaultsCAfter = await raw('GET', '/v1/shared-vaults', { token: C.token, cookie: C.cookie || undefined })
  record('C did NOT gain access to the vault (present-success control)', !(vaultsCAfter.json?.sharedVaults ?? []).some((v) => v.uuid === vault2Uuid) ? 'YES' : 'NO', {
    status: vaultsCAfter.status,
  })

  // ================= 5. COOKIE SESSION (the default here; E2E_TESTING unset)
  // Everything above already ran on a cookie session if the issued token is a
  // v2 one -- `2:<privateIdentifier>` is meaningless without the matching
  // `access_token_<sessionUuid>` cookie. Prove BOTH halves rather than assume:
  // the session version, and that removing the cookie actually breaks it.
  console.log('\n-- cookie session (default; E2E_TESTING unset) --')
  const isCookieSession = typeof B.token === 'string' && B.token.startsWith('2:')
  record('the session this deployment issues is a COOKIE session (v2), not a legacy header one', isCookieSession ? 'YES' : 'NO', {
    tokenVersion: String(B.token).split(':', 1)[0],
    cookieNames: B.cookie.split('; ').map((c) => c.split('=', 1)[0]),
  })
  const noCookieTicket = await raw('POST', '/v1/sockets/sync/ticket', {
    token: B.token,
    body: { deviceId: `dev-b-nocookie-${randomUUID()}` },
  })
  record('the cookie is load-bearing: the same bearer WITHOUT it is refused (control)', noCookieTicket.status === 401 ? 'ctrl' : 'NO', {
    status: noCookieTicket.status,
    body: noCookieTicket.text.slice(0, 160),
  })
  const withCookieTicket = await raw('POST', '/v1/sockets/sync/ticket', {
    token: B.token,
    cookie: B.cookie,
    body: { deviceId: `dev-b-withcookie-${randomUUID()}` },
  })
  record('the same bearer WITH the cookie mints a socket ticket', withCookieTicket.status === 200 && typeof withCookieTicket.json?.ticket === 'string' ? 'YES' : 'NO', {
    status: withCookieTicket.status,
  })

  // ======================= 6. HTTP fallback: a client with NO socket at all
  // A non-owner tab parks its invite subscription, so its only route is the
  // ordinary HTTP sync. Measure that route carries the invite.
  console.log('\n-- HTTP fallback: a recipient with NO socket open --')
  const D = await register('fallback')
  const vaultF = await raw('POST', '/v1/shared-vaults', { token: A.token, cookie: A.cookie || undefined, body: {} })
  const vaultFUuid = vaultF.json?.sharedVault?.uuid
  const t0f = Date.now()
  const invF = await raw('POST', `/v1/shared-vaults/${vaultFUuid}/invites`, {
    token: A.token,
    cookie: A.cookie || undefined,
    body: {
      recipient_uuid: D.uuid,
      encrypted_message: '004:' + randomBytes(64).toString('base64'),
      permission: 'read',
    },
  })
  const invFUuid = invF.json?.invite?.uuid
  record('A can invite a socket-less recipient (setup)', typeof invFUuid === 'string' ? 'ctrl' : 'NO', { status: invF.status })
  const fallbackSync = await httpSync(D, { items: [] })
  const fallbackInvites = fallbackSync.json?.shared_vault_invites ?? []
  record('the invite reaches a socket-less client in the ordinary HTTP sync response', fallbackInvites.some((i) => i.uuid === invFUuid) ? 'YES' : 'NO', {
    status: fallbackSync.status,
    elapsedMs: Date.now() - t0f,
    count: Array.isArray(fallbackInvites) ? fallbackInvites.length : null,
    keys: Object.keys(fallbackSync.json ?? {}).slice(0, 12),
  })
  const fallbackList = await raw('GET', '/v1/shared-vaults/invites', { token: D.token, cookie: D.cookie || undefined })
  record('the socket-less client can also list it over HTTP', (fallbackList.json?.invites ?? []).some((i) => i.uuid === invFUuid) ? 'YES' : 'NO', {
    status: fallbackList.status,
    count: (fallbackList.json?.invites ?? []).length,
  })

  console.log('\n-- extra socket tickets for the same account (socket budget / non-owner) --')
  try {
    const attempts = []
    for (let i = 0; i < 4; i++) {
      const t = await raw('POST', '/v1/sockets/sync/ticket', {
        token: B.token,
        cookie: B.cookie || undefined,
        body: { deviceId: `dev-b-extra-${i}-${randomUUID()}` },
      })
      attempts.push({ status: t.status, reason: t.json?.reason ?? t.json?.error?.message })
    }
    record('extra ticket mints for the same account', 'info', { attempts })
  } catch (error) {
    record('second-socket ticket probe', 'NO', { error: String(error).slice(0, 200) })
  }

  try {
    sessionB.socket.ws.close()
    sessionC.socket.ws.close()
  } catch {
    /* already closed */
  }
  summarize()
}

function summarize() {
  const no = results.filter((r) => r.verdict === 'NO')
  console.log(
    `\n=== SUMMARY topology=${TOPOLOGY}: ${results.filter((r) => r.verdict === 'YES').length} YES, ${no.length} NO ===`,
  )
  for (const r of no) console.log(`  NO: ${r.name} ${JSON.stringify(r.evidence)}`)
  console.log(`\nJSON_RESULTS=${JSON.stringify({ topology: TOPOLOGY, tag: TAG, results })}`)
}

main().catch((error) => {
  console.error('PROBE CRASHED: invite delivery did not complete')
  summarize()
  process.exitCode = 1
})
