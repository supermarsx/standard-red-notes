/**
 * Collaboration, end to end, on two REAL accounts.
 *
 * `collab-yjs.e2e.mjs` proves the relay: it mints its own connection tokens with
 * `x-internal-secret` and signs its own room capabilities with
 * `WEB_SOCKET_CONNECTION_TOKEN_SECRET`, for two user uuids that need not exist.
 * So it never enters `COLLABORATION_AUTHORIZE`, never reads
 * `shared_vault_users.permission`, and a green run of it says NOTHING about
 * whether anyone is allowed to collaborate. The multi-container denial that
 * `0a6897b3`/`DirectCallRequest` fixed -- every socket collaboration
 * authorization answered `{ authorized: false }` because a fabricated request
 * carried no `method` and axios defaulted it to GET -- was invisible to it, and
 * invisible to `capability-fallback.e2e.mjs` too, whose AUTHORIZE_COLLABORATION
 * row settles on "a COLLABORATION_AUTHORIZED frame, `authorized` either way"
 * against a note uuid it never created.
 *
 * This script measures the thing the question actually asks:
 *
 *   1. two real registrations, cookie sessions, a real shared vault, a real
 *      note in it, and a real invite accepted;
 *   2. `COLLABORATION_AUTHORIZE` answering a PRESENT `authorized: true` with a
 *      capability -- on the socket lane and on the HTTP fallback;
 *   3. two editors in the room with THOSE capabilities, converging, with the
 *      one-way latency measured in both directions, plus simultaneous edits in
 *      different paragraphs and in the same paragraph;
 *   4. read-only enforced SERVER-side (the save is refused, not hidden), write
 *      granted, and the member removed;
 *   5. the negative cases: a non-member reading a vault item directly, a grant
 *      replayed after removal, and the epoch-discovery challenge over HTTP.
 *
 * Every row is green on a present success. `authorized: false` is a FAILURE
 * wherever authorization is supposed to succeed, and a success wherever it is
 * supposed to be refused; no row anywhere settles on "not this one error".
 *
 *   REQUIRE_GATEWAY=1 BASE=http://localhost:3911 \
 *     yarn workspace @standard-red-notes/websocket-gateway node e2e/collab-end-to-end.e2e.mjs
 *
 * `--self-test` runs the pure predicates offline and needs no stack.
 */
import { WebSocket } from 'ws'
import { webcrypto as crypto, randomBytes, randomUUID, createHash } from 'node:crypto'
import * as Y from 'yjs'

const BASE = (process.env.BASE ?? 'http://localhost:3001').replace(/\/$/, '')
const WS_BASE = process.env.WS_BASE ?? BASE.replace(/^http/, 'ws')
const ORIGIN = process.env.ORIGIN ?? BASE
const REQUIRE_GATEWAY = process.env.REQUIRE_GATEWAY === '1'
const REGISTER_API = process.env.REGISTER_API ?? '20240226'
const TOPOLOGY = process.env.TOPOLOGY ?? 'unknown'
const SNJS_VERSION = process.env.SNJS_VERSION ?? '2.200.1'
const SELF_TEST = process.argv.includes('--self-test')

const COLLABORATION_PROTOCOL_VERSION = 3
/** Transaction origin for an edit this process MADE, as opposed to one it received. */
const LOCAL_EDIT = Symbol('collab-local-edit')
const COLLABORATION_HKDF_SALT = 'Standard Red Notes encrypted collaboration room key v1'
const CONVERGENCE_TIMEOUT_MS = Number(process.env.CONVERGENCE_TIMEOUT_MS ?? 20_000)
/** How long an HTTP-only collaborator is given to see a saved change by polling. */
const HTTP_PULL_TIMEOUT_MS = Number(process.env.HTTP_PULL_TIMEOUT_MS ?? 30_000)
const HTTP_PULL_INTERVAL_MS = Number(process.env.HTTP_PULL_INTERVAL_MS ?? 500)

let failures = 0
let controlFailures = 0
const results = { topology: TOPOLOGY, rows: {}, latencies: {}, notes: [] }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, condition, detail) {
  const ok = Boolean(condition)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  if (!ok) failures++
  return ok
}

function control(name, probeRejected, detail) {
  if (probeRejected) {
    console.log(`  ctrl - ${name} correctly failed on a planted break${detail ? ' ' + JSON.stringify(detail) : ''}`)
  } else {
    console.log(
      `  CONTROL-FAIL - ${name} PASSED on a planted break; this probe cannot detect a real failure${
        detail ? ' ' + JSON.stringify(detail) : ''
      }`,
    )
    controlFailures++
  }
  return Boolean(probeRejected)
}

function note(text) {
  results.notes.push(text)
  console.log(`  note - ${text}`)
}

function row(key, patch) {
  results.rows[key] = { ...(results.rows[key] ?? {}), ...patch }
}

// ---------------------------------------------------------------------------
// Predicates. Pure, so `--self-test` can prove each one can FAIL.
// ---------------------------------------------------------------------------

/**
 * A collaboration GRANT actually happened: a capability was issued, bound to
 * this room, this epoch pair and this lease, with a positive canonical
 * revision. `authorized: false` and a missing capability are both failures --
 * that is the whole point, because the multi-container defect produced exactly
 * a well-formed `{ authorized: false }` and nothing else.
 */
export function grantSucceeded(grant, { room, roomEpoch, leaseRequestId, bootstrapChallenge } = {}) {
  if (!grant || typeof grant !== 'object') return false
  if (grant.authorized === false) return false
  if (typeof grant.capability !== 'string' || grant.capability.length === 0) return false
  if (grant.collaborationProtocolVersion !== COLLABORATION_PROTOCOL_VERSION) return false
  if (!Number.isSafeInteger(grant.serverUpdatedAtTimestamp) || grant.serverUpdatedAtTimestamp <= 0) return false
  if (typeof grant.collaborationSecurityEpoch !== 'string' || grant.collaborationSecurityEpoch.length < 16) return false
  if (room !== undefined && grant.room !== room) return false
  if (roomEpoch !== undefined && grant.roomEpoch !== roomEpoch) return false
  if (leaseRequestId !== undefined && grant.leaseRequestId !== leaseRequestId) return false
  if (bootstrapChallenge !== undefined && grant.bootstrapChallenge !== bootstrapChallenge) return false
  return true
}

/** An epoch DISCOVERY actually happened: a well-formed epoch pair, no capability. */
export function discoverySucceeded(discovery, { room } = {}) {
  if (!discovery || typeof discovery !== 'object') return false
  if (discovery.epochDiscovery !== true) return false
  if (discovery.capability !== undefined) return false
  if (typeof discovery.roomEpoch !== 'string' || discovery.roomEpoch.length < 16) return false
  if (typeof discovery.collaborationSecurityEpoch !== 'string') return false
  if (!Number.isSafeInteger(discovery.serverUpdatedAtTimestamp) || discovery.serverUpdatedAtTimestamp <= 0) return false
  if (room !== undefined && discovery.room !== room) return false
  return true
}

/**
 * The server REFUSED a collaboration authorization, by deciding so. A transport
 * failure is not a refusal: `BACKEND_ERROR`, `BACKEND_TIMEOUT` and silence all
 * mean the lane broke, and reading those as "correctly denied" is how the
 * multi-container defect hid for as long as it did.
 */
export function authorizationRefused(answer) {
  if (!answer || typeof answer !== 'object') return false
  if (answer.kind === 'frame') {
    if (answer.type === 'COLLABORATION_AUTHORIZED') return answer.payload?.authorized === false
    if (answer.type === 'ERROR') return answer.payload?.code === 'NOT_AUTHORIZED'
    return false
  }
  if (answer.kind === 'http') return answer.status === 403 && answer.body?.error?.tag === 'collaboration-not-authorized'
  return false
}

/**
 * A shared-vault save was refused BY THE PERMISSION MODEL. The syncing server
 * answers a 200 whose `conflicts` carry the named type -- so "the request did
 * not error" is emphatically not the predicate, and neither is "the item is
 * absent from `saved_items`", which is also true of a request that never
 * reached the rule.
 */
export function saveRefusedByPermission(syncBody, itemUuid, expectedTypes) {
  if (!syncBody || typeof syncBody !== 'object') return false
  const conflicts = syncBody.conflicts
  if (!Array.isArray(conflicts)) return false
  const saved = Array.isArray(syncBody.saved_items) ? syncBody.saved_items : []
  if (saved.some((item) => item?.uuid === itemUuid)) return false
  return conflicts.some(
    (conflict) =>
      expectedTypes.includes(conflict?.type) &&
      (conflict?.unsaved_item?.uuid === itemUuid || conflict?.item?.uuid === itemUuid),
  )
}

/** A save LANDED: the item came back in `saved_items`, and in no conflict. */
export function saveLanded(syncBody, itemUuid) {
  if (!syncBody || typeof syncBody !== 'object') return false
  const saved = Array.isArray(syncBody.saved_items) ? syncBody.saved_items : []
  const conflicts = Array.isArray(syncBody.conflicts) ? syncBody.conflicts : []
  if (!saved.some((item) => item?.uuid === itemUuid)) return false
  return !conflicts.some((conflict) => conflict?.unsaved_item?.uuid === itemUuid || conflict?.item?.uuid === itemUuid)
}

/** The item is READABLE: it is present in a pull, with content. */
export function itemReadable(syncBody, itemUuid) {
  if (!syncBody || typeof syncBody !== 'object') return false
  const retrieved = Array.isArray(syncBody.retrieved_items) ? syncBody.retrieved_items : []
  return retrieved.some(
    (item) => item?.uuid === itemUuid && typeof item.content === 'string' && item.content.length > 0 && !item.deleted,
  )
}

/** A room join was DENIED, with the reason named. */
export function roomDenied(frames, requestId, reasons) {
  return frames.some((f) => f?.t === 'room-denied' && f.requestId === requestId && reasons.includes(f.reason))
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function raw(method, path, { body, token, cookie, headers } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-snjs-version': SNJS_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers ?? {}),
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
  const unwrapped = parsed && typeof parsed === 'object' && 'data' in parsed && 'meta' in parsed ? parsed.data : parsed
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  return { status: response.status, json: unwrapped, raw: parsed, text, setCookie }
}

function cookieHeaderFrom(setCookie) {
  const pairs = setCookie
    .map((entry) => entry.split(';', 1)[0].trim())
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
  return pairs.length > 0 ? pairs.join('; ') : ''
}

class Account {
  constructor(label) {
    this.label = label
    this.email = `collab-${label}-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
    this.password = randomBytes(32).toString('hex')
  }

  get auth() {
    return { token: this.accessToken, cookie: this.cookie || undefined }
  }

  async register() {
    const response = await raw('POST', '/v1/users', {
      body: {
        email: this.email,
        password: this.password,
        api: REGISTER_API,
        version: '004',
        pw_nonce: randomBytes(32).toString('hex'),
        origination: 'registration',
        created: String(Date.now()),
        ephemeral: false,
      },
    })
    if (response.status !== 200 || typeof response.json?.session?.access_token !== 'string') {
      throw new Error(`register ${this.label} failed: ${response.status} ${response.text.slice(0, 300)}`)
    }
    this.accessToken = response.json.session.access_token
    this.refreshToken = response.json.session.refresh_token
    this.cookie = cookieHeaderFrom(response.setCookie)
    this.uuid = response.json.user?.uuid
    this.cookieSession = this.accessToken.startsWith('2:')
    return this
  }

  /** The real session-refresh the client performs; `c0fe0ccc`'s premise. */
  async rotateSession() {
    const response = await raw('POST', '/v1/sessions/refresh', {
      ...this.auth,
      body: { access_token: this.accessToken, refresh_token: this.refreshToken, api: REGISTER_API },
    })
    if (response.status !== 200 || typeof response.json?.session?.access_token !== 'string') {
      return { rotated: false, status: response.status, body: response.text.slice(0, 300) }
    }
    const previousToken = this.accessToken
    const previousCookie = this.cookie
    this.accessToken = response.json.session.access_token
    this.refreshToken = response.json.session.refresh_token
    const freshCookie = cookieHeaderFrom(response.setCookie)
    if (freshCookie) this.cookie = freshCookie
    // On a COOKIE session the bearer half can legitimately come back unchanged
    // while the credential that actually authenticates -- the cookie -- rotates.
    // Scoring rotation on the bearer alone reports "did not rotate" over a
    // session that did.
    return {
      rotated: this.accessToken !== previousToken || this.cookie !== previousCookie,
      tokenChanged: this.accessToken !== previousToken,
      cookieChanged: this.cookie !== previousCookie,
      status: response.status,
    }
  }

  sync(body) {
    return raw('POST', '/v1/items', { ...this.auth, body: { api: '20200115', ...body } })
  }
}

// ---------------------------------------------------------------------------
// The sync lane (`/sockets/sync`): where COLLABORATION_AUTHORIZE lives.
// ---------------------------------------------------------------------------
function syncFrame(type, payload, { sequence, requestId, commandId } = {}) {
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

function openWebSocket(url, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: ORIGIN, ...(cookie ? { headers: { cookie } } : {}) })
    const state = { ws, frames: [], close: undefined, upgradeStatus: undefined }
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      try {
        state.frames.push(JSON.parse(data.toString()))
      } catch {
        state.frames.push({ unparseable: data.toString().slice(0, 200) })
      }
    })
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString() }
    })
    ws.on('unexpected-response', (_request, response) => {
      state.upgradeStatus = response.statusCode
      reject(new Error(`upgrade refused: HTTP ${response.statusCode}`))
    })
    ws.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
    ws.once('open', () => resolve(state))
    setTimeout(() => reject(new Error('websocket open timeout')), 15_000)
  })
}

async function waitForFrame(state, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let cursor = 0
  while (Date.now() < deadline) {
    while (cursor < state.frames.length) {
      const frame = state.frames[cursor++]
      if (predicate(frame)) return frame
    }
    if (state.close) return undefined
    await sleep(15)
  }
  return undefined
}

/** The authenticated sync lane for one account, carrying COLLABORATION_AUTHORIZE. */
class SyncLane {
  constructor(account) {
    this.account = account
    this.deviceId = `collab-${account.label}-${randomBytes(4).toString('hex')}`
    this.sequence = 0
  }

  async open() {
    const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
      ...this.account.auth,
      body: { deviceId: this.deviceId },
    })
    if (ticket.status !== 200 || typeof ticket.json?.ticket !== 'string') {
      return { opened: false, reason: `ticket ${ticket.status} ${ticket.text.slice(0, 200)}` }
    }
    this.state = await openWebSocket(`${WS_BASE}/sockets/sync`, { cookie: this.account.cookie || undefined })
    this.state.ws.send(
      JSON.stringify(syncFrame('AUTH', { ticket: ticket.json.ticket, deviceId: this.deviceId }, { sequence: 0 })),
    )
    const authenticated = await waitForFrame(
      this.state,
      (f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR',
      20_000,
    )
    if (authenticated?.type !== 'AUTHENTICATED') {
      return { opened: false, reason: `auth ${authenticated?.type ?? 'silence'}`, close: this.state.close }
    }
    this.sequence = 1
    this.operations = authenticated.payload?.operations ?? authenticated.payload?.capabilities ?? []
    return { opened: true, operations: this.operations }
  }

  /** One COLLABORATION_AUTHORIZE round trip. Returns a normalized answer. */
  async authorize(payload, timeoutMs = 25_000) {
    const requestId = `req-${randomUUID()}`
    this.state.ws.send(
      JSON.stringify(syncFrame('COLLABORATION_AUTHORIZE', payload, { sequence: this.sequence++, requestId })),
    )
    const frame = await waitForFrame(
      this.state,
      (f) => f.requestId === requestId && (f.type === 'COLLABORATION_AUTHORIZED' || f.type === 'ERROR'),
      timeoutMs,
    )
    return { kind: 'frame', type: frame?.type, payload: frame?.payload, requestId, close: this.state.close }
  }

  /**
   * What a real client does when the gateway answers `SESSION_STALE`: mint a
   * fresh ticket and present it in a `REAUTH` frame ON THE SOCKET IT ALREADY
   * HOLDS, then resume. The gateway added `SESSION_STALE` precisely so this is
   * possible, and `c0fe0ccc` is the client half -- park and resume with a fresh
   * commandId rather than tear the socket down. A REAUTH is a mid-stream frame
   * and is refused at sequence 0, so it can never stand in for admission.
   */
  async reauth() {
    const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
      ...this.account.auth,
      body: { deviceId: this.deviceId },
    })
    if (ticket.status !== 200 || typeof ticket.json?.ticket !== 'string') {
      return { reauthenticated: false, reason: `ticket ${ticket.status}` }
    }
    const commandId = `cmd-${randomUUID()}`
    this.state.ws.send(
      JSON.stringify(
        syncFrame(
          'REAUTH',
          { ticket: ticket.json.ticket, deviceId: this.deviceId },
          { sequence: this.sequence++, requestId: commandId, commandId },
        ),
      ),
    )
    const answer = await waitForFrame(
      this.state,
      (f) => f.commandId === commandId && (f.type === 'REAUTHENTICATED' || f.type === 'ERROR'),
      20_000,
    )
    return {
      reauthenticated: answer?.type === 'REAUTHENTICATED',
      type: answer?.type,
      code: answer?.payload?.code,
      close: this.state.close,
    }
  }

  close() {
    try {
      this.state?.ws.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * The full two-leg authorization a real client performs, over the SOCKET lane:
 * discovery (which issues a one-use `epochDiscoveryChallenge`) then the grant
 * that consumes it. `bootstrapChallenge` is omitted on the reserve grant --
 * `room-reserve` rejects a capability that carries one -- and present on the
 * join grant.
 */
async function authorizeOverSocket(lane, noteUuid, { leaseRequestId, bootstrapChallenge } = {}) {
  // EVERY grant gets its OWN discovery. The challenge is one-use: the gateway
  // stores a single `collaborationEpochDiscovery` per connection and consumes it
  // on the grant, so replaying one answers `ERROR CHALLENGE_EXPIRED`. The real
  // client is built the same way -- `SyncTransportWorkerRuntime` opens every
  // collaboration authorization at `phase: 'discovery'` and even re-discovers
  // once on `CHALLENGE_EXPIRED` -- and a harness that reuses a spent challenge
  // measures its own bug instead of the lane. The reserve and join legs are two
  // separate authorizations, so they are two separate discoveries.
  const discovery = await lane.authorize({
    noteUuid,
    collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
    epochDiscovery: true,
  })
  if (discovery.type !== 'COLLABORATION_AUTHORIZED' || discovery.payload?.authorized === false) {
    return { ...discovery, stage: 'discovery' }
  }
  // The gateway owns a room's epoch from its first reservation (contract C4
  // resolves the CURRENT one here), so the discovered epoch wins over anything
  // the caller remembered.
  const epoch = discovery.payload.roomEpoch
  const grant = await lane.authorize({
    noteUuid,
    collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
    expectedRoomEpoch: epoch,
    epochDiscoveryChallenge: discovery.payload.epochDiscoveryChallenge,
    epochDiscoveryRequestId: discovery.payload.epochDiscoveryRequestId,
    ...(leaseRequestId ? { leaseRequestId } : {}),
    ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
  })
  return { ...grant, stage: 'grant', discovery: discovery.payload, roomEpoch: epoch }
}

/** The same two legs over the documented HTTP fallback. */
async function authorizeOverHttp(account, noteUuid, { leaseRequestId, bootstrapChallenge, roomEpoch } = {}) {
  let epoch = roomEpoch
  let discovery
  if (epoch === undefined) {
    discovery = await raw('POST', '/v1/collaboration/authorize', {
      ...account.auth,
      body: { noteUuid, collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION, epochDiscovery: true },
    })
    if (discovery.status !== 200) {
      return { kind: 'http', status: discovery.status, body: discovery.json, stage: 'discovery' }
    }
    epoch = discovery.json?.roomEpoch
  }
  const grant = await raw('POST', '/v1/collaboration/authorize', {
    ...account.auth,
    body: {
      noteUuid,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: epoch,
      ...(leaseRequestId ? { leaseRequestId } : {}),
      ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
    },
  })
  return {
    kind: 'http',
    status: grant.status,
    body: grant.json,
    stage: 'grant',
    discovery: discovery?.json,
    roomEpoch: epoch,
  }
}

// ---------------------------------------------------------------------------
// The collaboration room plane, on the legacy `/sockets` connection.
// ---------------------------------------------------------------------------
const b64 = (value) => Buffer.from(value).toString('base64')
const unb64 = (value) => new Uint8Array(Buffer.from(value, 'base64'))

async function deriveRoomKey(secret, noteUuid) {
  const encoder = new TextEncoder()
  const source = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(COLLABORATION_HKDF_SALT),
      info: encoder.encode(`scope=shared-vault\u0000note=${noteUuid}`),
    },
    source,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const frameAdditionalData = (room, frameType, transferId, stateRequestId) =>
  new TextEncoder().encode(
    JSON.stringify([
      'standard-red-notes:collaboration-frame:v2',
      COLLABORATION_PROTOCOL_VERSION,
      room,
      frameType,
      transferId ?? null,
      stateRequestId ?? null,
    ]),
  )

async function encryptPayload(key, plaintext, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext),
  )
  const joined = new Uint8Array(iv.length + ciphertext.length)
  joined.set(iv, 0)
  joined.set(ciphertext, iv.length)
  return b64(joined)
}

async function decryptPayload(key, payload, additionalData) {
  const joined = unb64(payload)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: joined.subarray(0, 12), additionalData },
    key,
    joined.subarray(12),
  )
  return new Uint8Array(plaintext)
}

/**
 * One collaborating editor: a legacy `/sockets` connection carrying the room
 * plane, a Y.Doc, and capabilities obtained from the REAL authorizer through
 * whichever transport `authorize` is given.
 */
class Editor {
  constructor({ account, noteUuid, key, authorize, label }) {
    this.account = account
    this.room = noteUuid
    this.key = key
    this.authorize = authorize
    this.label = label ?? account.label
    this.doc = new Y.Doc()
    this.joined = false
    this.stateServingReady = false
    this.inbound = []
    this.pending = new Set()
    this.pendingResponseClaims = new Set()
    this.awaitingStateRequestId = undefined
    this.lastError = undefined
    this.doc.on('update', (update, origin) => {
      // Inbound updates are applied with `this` as the origin, so `this` is the
      // ONE origin that must never be relayed back out. A LOCAL edit therefore
      // has to carry a different origin (`LOCAL_EDIT`): passing the editor
      // itself as a transact origin silently suppresses the send, and the probe
      // then measures its own filter instead of the relay.
      if (origin === this || !this.joined || !this.stateServingReady || !this.state) return
      this.track(this.sendUpdate(update))
    })
  }

  track(promise) {
    const tracked = promise
      .catch((error) => {
        this.lastError = error
      })
      .finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
  }

  async flush() {
    const deadline = Date.now() + 10_000
    while (this.pending.size > 0 && Date.now() < deadline) {
      await Promise.all([...this.pending])
    }
  }

  get text() {
    return this.doc.getText('content').toString()
  }

  async connect() {
    const minted = await raw('POST', '/v1/sockets/tokens', this.account.auth)
    if (minted.status !== 200 || typeof minted.json?.token !== 'string') {
      return { connected: false, reason: `token mint ${minted.status} ${minted.text.slice(0, 200)}` }
    }
    this.state = await openWebSocket(`${WS_BASE}/sockets?authToken=${encodeURIComponent(minted.json.token)}`, {
      cookie: this.account.cookie || undefined,
    })
    this.state.ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      if (frame?.room !== this.room) return
      this.onRoomFrame(frame)
    })
    return { connected: true }
  }

  /**
   * The state-serving handshake, which a late joiner CANNOT skip. A peer that
   * joins with `bootstrap: false` holds an empty Y.Doc, and an incremental
   * update from another editor references structs it has never seen -- Yjs
   * buffers such an update as pending and applies nothing, so the joiner's text
   * stays empty and a probe that only watches the text reads "no delivery" over
   * a relay that is working fine.
   *
   * So: the joiner sends `yjs-retry`; the gateway forwards it; a peer holding
   * state answers `yjs-response-claim`; the gateway GRANTS exactly one claimant
   * `yjs-response-granted`; that peer sends its full state tagged with the
   * `stateRequestId`; the joiner applies it and only then starts serving.
   */
  onRoomFrame(frame) {
    if (frame.t === 'yjs') {
      this.track(this.applyInbound(frame))
      return
    }
    if (frame.t === 'room-sync') {
      this.track(this.broadcastFullState())
      return
    }
    if (
      frame.t === 'yjs-retry' &&
      this.joined &&
      this.stateServingReady &&
      frame.requesterClientId !== this.doc.clientID &&
      !this.pendingResponseClaims.has(frame.requestId)
    ) {
      this.pendingResponseClaims.add(frame.requestId)
      this.state.ws.send(
        JSON.stringify({
          t: 'yjs-response-claim',
          room: this.room,
          stateRequestId: frame.requestId,
          leaseRequestId: this.leaseRequestId,
        }),
      )
      return
    }
    if (
      frame.t === 'yjs-response-granted' &&
      frame.leaseRequestId === this.leaseRequestId &&
      this.pendingResponseClaims.delete(frame.stateRequestId)
    ) {
      this.track(this.sendUpdate(Y.encodeStateAsUpdate(this.doc), frame.stateRequestId))
    }
  }

  async broadcastFullState() {
    if (!this.joined || this.state?.ws.readyState !== WebSocket.OPEN) return
    await this.sendUpdate(Y.encodeStateAsUpdate(this.doc))
  }

  async applyInbound(frame) {
    const update = await decryptPayload(
      this.key,
      frame.payload,
      frameAdditionalData(this.room, 'yjs', frame.transferId, frame.stateRequestId),
    )
    // A state answer is only believed while this peer is actually awaiting one,
    // and correlated by the id it asked with.
    if (frame.stateRequestId !== undefined && frame.stateRequestId !== this.awaitingStateRequestId) return
    this.inbound.push({ at: Date.now(), bytes: update.byteLength })
    Y.applyUpdate(this.doc, update, this)
    if (frame.stateRequestId !== undefined && frame.stateRequestId === this.awaitingStateRequestId) {
      this.awaitingStateRequestId = undefined
      this.stateServingReady = true
    }
  }

  async sendUpdate(update, stateRequestId) {
    const payload = await encryptPayload(
      this.key,
      update,
      frameAdditionalData(this.room, 'yjs', undefined, stateRequestId),
    )
    if (this.state?.ws.readyState === WebSocket.OPEN) {
      this.state.ws.send(
        JSON.stringify({ t: 'yjs', room: this.room, payload, ...(stateRequestId ? { stateRequestId } : {}) }),
      )
    }
  }

  /**
   * Reserve then activate, both on real capabilities. Adopts a
   * `room-denied { reason: 'epoch-mismatch', roomEpoch }` exactly as the client
   * does, because the gateway owns a room's epoch from its first reservation.
   */
  async join({ attempts = 3 } = {}) {
    let roomEpoch
    for (let attempt = 0; attempt < attempts; attempt++) {
      const leaseRequestId = `lease-${randomUUID()}`
      const reserveGrant = await this.authorize(this.room, { leaseRequestId, roomEpoch })
      const reserveCapability = capabilityOf(reserveGrant)
      if (!reserveCapability) {
        return { joined: false, stage: 'reserve-authorize', answer: reserveGrant }
      }
      roomEpoch = epochOf(reserveGrant)
      const before = this.state.frames.length
      this.state.ws.send(
        JSON.stringify({
          t: 'room-reserve',
          room: this.room,
          cap: reserveCapability,
          requestId: leaseRequestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: roomEpoch,
        }),
      )
      const answer = await waitForFrame(
        this.state,
        (f) => (f?.t === 'room-reserved' || f?.t === 'room-denied') && f.requestId === leaseRequestId,
        15_000,
      )
      if (answer?.t !== 'room-reserved') {
        if (answer?.reason === 'epoch-mismatch' && typeof answer.roomEpoch === 'string') {
          roomEpoch = answer.roomEpoch
          continue
        }
        return { joined: false, stage: 'reserve', answer, frames: this.state.frames.slice(before) }
      }
      const joinGrant = await this.authorize(this.room, {
        leaseRequestId,
        roomEpoch,
        ...(answer.bootstrap && answer.bootstrapChallenge ? { bootstrapChallenge: answer.bootstrapChallenge } : {}),
      })
      const joinCapability = capabilityOf(joinGrant)
      if (!joinCapability) {
        return { joined: false, stage: 'join-authorize', answer: joinGrant }
      }
      this.state.ws.send(
        JSON.stringify({
          t: 'room-join',
          room: this.room,
          cap: joinCapability,
          requestId: leaseRequestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: roomEpoch,
        }),
      )
      const joined = await waitForFrame(
        this.state,
        (f) => (f?.t === 'room-joined' || f?.t === 'room-denied') && f.requestId === leaseRequestId,
        15_000,
      )
      if (joined?.t !== 'room-joined') {
        if (joined?.reason === 'epoch-mismatch' && typeof joined.roomEpoch === 'string') {
          roomEpoch = joined.roomEpoch
          continue
        }
        return { joined: false, stage: 'join', answer: joined }
      }
      this.joined = true
      this.roomEpoch = roomEpoch
      this.leaseRequestId = leaseRequestId
      const serving = await this.establishStateServing(answer.bootstrap)
      return { joined: true, roomEpoch, bootstrap: answer.bootstrap, serving }
    }
    return { joined: false, stage: 'epoch-adoption-exhausted' }
  }

  /**
   * A peer told to bootstrap owns the room's initial state and may serve at
   * once. Any other peer must first RECEIVE the state it asked for; until then
   * it neither serves nor has anything to apply an increment onto.
   */
  async establishStateServing(bootstrap) {
    if (bootstrap === true) {
      this.stateServingReady = true
      return { bootstrapped: true }
    }
    const stateRequestId = `state-${randomUUID()}`
    this.awaitingStateRequestId = stateRequestId
    this.state.ws.send(
      JSON.stringify({
        t: 'yjs-retry',
        room: this.room,
        requestId: stateRequestId,
        requesterClientId: this.doc.clientID,
      }),
    )
    const served = await waitUntil(() => this.stateServingReady, CONVERGENCE_TIMEOUT_MS)
    if (!served) {
      // No peer served the state. Nothing can be measured against an empty doc,
      // so say so rather than letting a later row read as "no delivery".
      this.stateServingReady = true
      return { bootstrapped: false, served: false }
    }
    return { bootstrapped: false, served: true }
  }

  async leave() {
    try {
      this.state?.ws.send(JSON.stringify({ t: 'room-leave', room: this.room }))
    } catch {
      /* already gone */
    }
  }

  close() {
    this.joined = false
    this.stateServingReady = false
    try {
      this.state?.ws.close()
    } catch {
      /* already gone */
    }
  }
}

function capabilityOf(answer) {
  if (!answer) return undefined
  if (answer.kind === 'frame') {
    return answer.type === 'COLLABORATION_AUTHORIZED' && typeof answer.payload?.capability === 'string'
      ? answer.payload.capability
      : undefined
  }
  if (answer.kind === 'http') {
    return answer.status === 200 && typeof answer.body?.capability === 'string' ? answer.body.capability : undefined
  }
  return undefined
}

function epochOf(answer) {
  if (!answer) return undefined
  if (answer.kind === 'frame') return answer.payload?.roomEpoch
  if (answer.kind === 'http') return answer.body?.roomEpoch
  return undefined
}

function grantPayloadOf(answer) {
  if (!answer) return undefined
  return answer.kind === 'frame' ? answer.payload : answer.body
}

/**
 * A one-way convergence measurement: mutate at `writer`, wait for `reader` to
 * hold the result, return the elapsed milliseconds. A timeout returns
 * `undefined` so the caller reports a MISSING latency rather than a large one.
 */
async function measureOneWay(writer, reader, mutate, expected, timeoutMs = CONVERGENCE_TIMEOUT_MS) {
  const started = Date.now()
  writer.doc.transact(() => mutate(writer.doc.getText('content')), LOCAL_EDIT)
  await writer.flush()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    if (expected(reader.text)) return Date.now() - started
    await sleep(5)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
function noteHash({ uuid, content, sharedVaultUuid, keySystemIdentifier, updatedAtTimestamp }) {
  const now = Date.now() * 1_000
  // `TimeDifferenceFilter` runs BEFORE `SharedVaultFilter` and demands
  // `updated_at_timestamp` equal the server's to the microsecond. A save that
  // guesses it is refused as `sync_conflict` by the time rule and never reaches
  // the permission rule -- so a probe that omits it proves nothing about
  // permissions, whichever way the save goes.
  const updatedAt = updatedAtTimestamp ?? now
  return {
    uuid,
    content,
    content_type: 'Note',
    deleted: false,
    created_at_timestamp: now,
    updated_at_timestamp: updatedAt,
    created_at: new Date().toISOString(),
    updated_at: new Date(Math.floor(updatedAt / 1_000)).toISOString(),
    ...(sharedVaultUuid ? { shared_vault_uuid: sharedVaultUuid } : {}),
    ...(keySystemIdentifier ? { key_system_identifier: keySystemIdentifier } : {}),
  }
}

async function pullVault(account, sharedVaultUuid) {
  return account.sync({ sync_token: null, limit: 150, shared_vault_uuids: [sharedVaultUuid] })
}

/** The server's CURRENT microsecond revision for an item, as this account sees it. */
async function serverTimestamp(account, sharedVaultUuid, itemUuid) {
  const pull = await pullVault(account, sharedVaultUuid)
  const item = (pull.json?.retrieved_items ?? []).find((candidate) => candidate.uuid === itemUuid)
  if (item?.updated_at_timestamp !== undefined) return item.updated_at_timestamp
  const direct = await raw('GET', `/v1/items/${itemUuid}`, account.auth)
  return direct.json?.item?.updated_at_timestamp
}

/**
 * Save the note as `account`, echoing the revision THIS account can read, so the
 * save reaches the shared-vault permission rule instead of dying on the time
 * rule. `updatedAtTimestamp: null` deliberately sends a guessed revision.
 */
async function saveNote(account, { sharedVaultUuid, keySystemIdentifier, noteUuid, content }) {
  const updatedAtTimestamp = await serverTimestamp(account, sharedVaultUuid, noteUuid)
  return account.sync({
    items: [noteHash({ uuid: noteUuid, content, sharedVaultUuid, keySystemIdentifier, updatedAtTimestamp })],
  })
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------
function selfTest() {
  console.log('[self-test] the predicates can fail')
  const grant = {
    authorized: true,
    capability: 'cap',
    collaborationProtocolVersion: 3,
    serverUpdatedAtTimestamp: 5,
    collaborationSecurityEpoch: 'x'.repeat(32),
    room: 'r',
    roomEpoch: 'e'.repeat(32),
    leaseRequestId: 'l',
  }
  check('grantSucceeded accepts a real grant', grantSucceeded(grant, { room: 'r', leaseRequestId: 'l' }))
  check('grantSucceeded REJECTS { authorized: false }', !grantSucceeded({ authorized: false }))
  check('grantSucceeded REJECTS a grant with no capability', !grantSucceeded({ ...grant, capability: undefined }))
  check('grantSucceeded REJECTS a grant for another room', !grantSucceeded(grant, { room: 'other' }))
  check('grantSucceeded REJECTS a grant bound to another lease', !grantSucceeded(grant, { leaseRequestId: 'other' }))
  check('grantSucceeded REJECTS a zero canonical revision', !grantSucceeded({ ...grant, serverUpdatedAtTimestamp: 0 }))
  check(
    'discoverySucceeded REJECTS a discovery answer that smuggles a capability',
    !discoverySucceeded({ epochDiscovery: true, capability: 'c', roomEpoch: 'e'.repeat(32) }),
  )
  check(
    'authorizationRefused accepts a decided refusal',
    authorizationRefused({ kind: 'frame', type: 'COLLABORATION_AUTHORIZED', payload: { authorized: false } }) &&
      authorizationRefused({ kind: 'frame', type: 'ERROR', payload: { code: 'NOT_AUTHORIZED' } }) &&
      authorizationRefused({ kind: 'http', status: 403, body: { error: { tag: 'collaboration-not-authorized' } } }),
  )
  check(
    'authorizationRefused REJECTS a broken lane read as a refusal',
    !authorizationRefused({ kind: 'frame', type: 'ERROR', payload: { code: 'BACKEND_ERROR' } }) &&
      !authorizationRefused({ kind: 'frame', type: 'ERROR', payload: { code: 'BACKEND_TIMEOUT' } }) &&
      !authorizationRefused({ kind: 'frame', type: undefined }) &&
      !authorizationRefused({ kind: 'http', status: 502 }),
  )
  const refusal = {
    saved_items: [],
    conflicts: [{ type: 'sharedVaultInsufficientPermissionsError', unsaved_item: { uuid: 'n1' } }],
  }
  check(
    'saveRefusedByPermission accepts a named permission conflict',
    saveRefusedByPermission(refusal, 'n1', ['sharedVaultInsufficientPermissionsError']),
  )
  check(
    'saveRefusedByPermission REJECTS an empty 200 with no conflict at all',
    !saveRefusedByPermission({ saved_items: [], conflicts: [] }, 'n1', ['sharedVaultInsufficientPermissionsError']),
  )
  check(
    'saveRefusedByPermission REJECTS a save that actually landed',
    !saveRefusedByPermission({ saved_items: [{ uuid: 'n1' }], conflicts: [] }, 'n1', [
      'sharedVaultInsufficientPermissionsError',
    ]),
  )
  check(
    'saveRefusedByPermission REJECTS a conflict of an unrelated type',
    !saveRefusedByPermission(
      { saved_items: [], conflicts: [{ type: 'uuid_conflict', unsaved_item: { uuid: 'n1' } }] },
      'n1',
      ['sharedVaultInsufficientPermissionsError'],
    ),
  )
  check('saveLanded accepts a landed save', saveLanded({ saved_items: [{ uuid: 'n1' }], conflicts: [] }, 'n1'))
  check('saveLanded REJECTS a refused save', !saveLanded(refusal, 'n1'))
  check('itemReadable accepts a present item', itemReadable({ retrieved_items: [{ uuid: 'n1', content: 'c' }] }, 'n1'))
  check('itemReadable REJECTS an absent item', !itemReadable({ retrieved_items: [] }, 'n1'))
  check(
    'itemReadable REJECTS a tombstone with no content',
    !itemReadable({ retrieved_items: [{ uuid: 'n1', content: '', deleted: true }] }, 'n1'),
  )
  check(
    'roomDenied accepts the named reason only',
    roomDenied([{ t: 'room-denied', requestId: 'r', reason: 'capability-invalid' }], 'r', ['capability-invalid']) &&
      !roomDenied([{ t: 'room-denied', requestId: 'r', reason: 'rate-limited' }], 'r', ['capability-invalid']),
  )
  console.log(`\n[self-test] ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  return failures === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[collab-end-to-end] BASE=${BASE} topology=${TOPOLOGY} registerApi=${REGISTER_API}`)

  const readiness = await raw('GET', '/healthcheck/readiness').catch(() => ({ status: 0 }))
  if (readiness.status !== 200) {
    const message = `gateway readiness ${readiness.status}`
    if (REQUIRE_GATEWAY) {
      check(message, false)
      return 1
    }
    console.log(`  skip - ${message}`)
    return 0
  }
  check('the stack is ready through the front door', true)

  // -- accounts --------------------------------------------------------------
  console.log('\n[accounts]')
  const alice = await new Account('a').register()
  const bob = await new Account('b').register()
  check('two real accounts register', Boolean(alice.uuid && bob.uuid), { a: alice.uuid, b: bob.uuid })
  const cookieSessions = alice.cookieSession && bob.cookieSession
  check('both sessions are COOKIE sessions (a `2:` access token)', cookieSessions, {
    a: alice.accessToken.slice(0, 2),
    b: bob.accessToken.slice(0, 2),
  })
  if (REGISTER_API === '20240226' && !cookieSessions) {
    note(
      'registered at api 20240226 and got a legacy `1:` token: this stack forces legacy header sessions (E2E_TESTING=true), so every row below says nothing about cookie sessions',
    )
  }
  row('session', { kind: cookieSessions ? 'cookie' : 'legacy' })

  // -- a real shared vault with a real note ----------------------------------
  console.log('\n[shared vault]')
  const vault = await raw('POST', '/v1/shared-vaults', { ...alice.auth, body: {} })
  const sharedVaultUuid = vault.json?.sharedVault?.uuid
  check('A creates a shared vault', vault.status === 200 && typeof sharedVaultUuid === 'string', {
    status: vault.status,
    body: vault.text.slice(0, 200),
  })
  if (!sharedVaultUuid) return 1
  check("the creator's own membership is admin", vault.json?.sharedVaultUser?.permission === 'admin', {
    permission: vault.json?.sharedVaultUser?.permission,
  })

  const keySystemIdentifier = randomUUID()
  const noteUuid = randomUUID()
  const created = await alice.sync({
    items: [
      noteHash({
        uuid: noteUuid,
        content: '004:alice-initial',
        sharedVaultUuid,
        keySystemIdentifier,
      }),
    ],
  })
  check('A saves a note into the shared vault', saveLanded(created.json, noteUuid), {
    status: created.status,
    conflicts: created.json?.conflicts?.map((c) => c.type),
  })
  if (!saveLanded(created.json, noteUuid)) {
    note(`shared-vault note save body: ${created.text.slice(0, 400)}`)
    return 1
  }

  // -- NEGATIVE: a non-member reading the vault item directly ----------------
  console.log('\n[negative: non-member direct read]')
  const strangerGet = await raw('GET', `/v1/items/${noteUuid}`, bob.auth)
  check(
    'a non-member GET /v1/items/:uuid on a vault item does NOT return the item',
    strangerGet.status !== 200 || strangerGet.json?.item?.uuid !== noteUuid,
    { status: strangerGet.status, body: strangerGet.text.slice(0, 200) },
  )
  const strangerPull = await pullVault(bob, sharedVaultUuid)
  check("a non-member's vault pull does NOT contain the item", !itemReadable(strangerPull.json, noteUuid), {
    status: strangerPull.status,
    retrieved: strangerPull.json?.retrieved_items?.length,
  })
  const strangerAuthorize = await authorizeOverHttp(bob, noteUuid)
  check(
    'a non-member is REFUSED a collaboration capability (a decided 403, not a transport failure)',
    authorizationRefused({
      kind: 'http',
      status: strangerAuthorize.status,
      body: { error: strangerAuthorize.body?.error },
    }),
    { stage: strangerAuthorize.stage, status: strangerAuthorize.status },
  )
  row('negative', {
    nonMemberRead: strangerGet.status,
    nonMemberPullHasItem: itemReadable(strangerPull.json, noteUuid),
    nonMemberAuthorize: strangerAuthorize.status,
  })

  // -- membership: invite B as READ ------------------------------------------
  console.log('\n[membership: read-only]')
  const invited = await inviteAndAccept(alice, bob, sharedVaultUuid, 'read')
  check('B is invited read-only and accepts', invited.accepted, invited)
  if (!invited.accepted) return 1

  const bobPullRead = await pullVault(bob, sharedVaultUuid)
  check('a read-only member CAN read the vault item', itemReadable(bobPullRead.json, noteUuid), {
    status: bobPullRead.status,
  })

  const bobWriteAttempt = await saveNote(bob, {
    sharedVaultUuid,
    keySystemIdentifier,
    noteUuid,
    content: '004:bob-should-not-land',
  })
  const readOnlyEnforced = saveRefusedByPermission(bobWriteAttempt.json, noteUuid, [
    'sharedVaultInsufficientPermissionsError',
    'shared_vault_insufficient_permissions_error',
  ])
  check("a read-only member's save is REFUSED SERVER-SIDE with the named permission conflict", readOnlyEnforced, {
    status: bobWriteAttempt.status,
    conflicts: bobWriteAttempt.json?.conflicts?.map((c) => c.type),
    saved: bobWriteAttempt.json?.saved_items?.map((i) => i.uuid),
  })
  // The refusal must be real, not merely reported: read the item back as the
  // OWNER and require the content to be unchanged.
  const afterReadOnlyWrite = await pullVault(alice, sharedVaultUuid)
  const ownerView = (afterReadOnlyWrite.json?.retrieved_items ?? []).find((item) => item.uuid === noteUuid)
  check(
    "the read-only member's content never reached the server (the owner still reads the original)",
    ownerView?.content === '004:alice-initial',
    { content: ownerView?.content },
  )

  const bobReadOnlySocketLane = new SyncLane(bob)
  const bobLaneOpen = await bobReadOnlySocketLane.open()
  check('B can open the sync lane while read-only', bobLaneOpen.opened, bobLaneOpen)
  let readOnlyCollabRefusal
  if (bobLaneOpen.opened) {
    readOnlyCollabRefusal = await bobReadOnlySocketLane.authorize({
      noteUuid,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      epochDiscovery: true,
    })
    check(
      'a read-only member is REFUSED a collaboration capability on the socket lane (decided, not a broken lane)',
      authorizationRefused(readOnlyCollabRefusal),
      { type: readOnlyCollabRefusal.type, payload: readOnlyCollabRefusal.payload },
    )
  }
  const readOnlyHttpRefusal = await authorizeOverHttp(bob, noteUuid)
  check(
    'a read-only member is REFUSED a collaboration capability on the HTTP fallback',
    authorizationRefused({ kind: 'http', status: readOnlyHttpRefusal.status, body: readOnlyHttpRefusal.body }),
    { stage: readOnlyHttpRefusal.stage, status: readOnlyHttpRefusal.status },
  )
  bobReadOnlySocketLane.close()
  row('readOnly', {
    canRead: itemReadable(bobPullRead.json, noteUuid),
    saveRefusedServerSide: readOnlyEnforced,
    contentUnchanged: ownerView?.content === '004:alice-initial',
    socketAuthorizeRefused: readOnlyCollabRefusal ? authorizationRefused(readOnlyCollabRefusal) : 'untested',
    httpAuthorizeRefused: authorizationRefused({
      kind: 'http',
      status: readOnlyHttpRefusal.status,
      body: readOnlyHttpRefusal.body,
    }),
  })

  // -- promote B to WRITE ----------------------------------------------------
  console.log('\n[membership: promote to write]')
  const promoted = await promoteToWrite(alice, bob, sharedVaultUuid)
  check('B ends up a WRITE member of the vault', promoted.permission === 'write', promoted)
  if (promoted.permission !== 'write') return 1
  if (promoted.requiredRemoval) {
    note(
      'there is no endpoint that changes an existing shared-vault member permission: AddUserToSharedVault fails "User is already a member", and the only API path from read to write is DELETE the member then re-invite and re-accept',
    )
  }
  row('membership', { promoteRequiredRemoval: promoted.requiredRemoval === true })

  const bobWriteLanded = await saveNote(bob, {
    sharedVaultUuid,
    keySystemIdentifier,
    noteUuid,
    content: '004:bob-write-landed',
  })
  check("a write member's save LANDS", saveLanded(bobWriteLanded.json, noteUuid), {
    status: bobWriteLanded.status,
    conflicts: bobWriteLanded.json?.conflicts?.map((c) => c.type),
  })
  row('write', { saveLands: saveLanded(bobWriteLanded.json, noteUuid) })

  // -- COLLABORATION_AUTHORIZE, present success, both transports -------------
  console.log('\n[COLLABORATION_AUTHORIZE: a present success]')
  const aliceLane = new SyncLane(alice)
  const aliceLaneOpen = await aliceLane.open()
  check('A opens the sync lane', aliceLaneOpen.opened, aliceLaneOpen)
  const bobLane = new SyncLane(bob)
  const bobLaneOpen2 = await bobLane.open()
  check('B opens the sync lane', bobLaneOpen2.opened, bobLaneOpen2)
  if (!aliceLaneOpen.opened || !bobLaneOpen2.opened) return 1

  const aliceDiscovery = await aliceLane.authorize({
    noteUuid,
    collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
    epochDiscovery: true,
  })
  const aliceDiscoveryOk = check(
    'SOCKET: epoch discovery answers a present success for the owner',
    aliceDiscovery.type === 'COLLABORATION_AUTHORIZED' &&
      discoverySucceeded(aliceDiscovery.payload, { room: noteUuid }),
    { type: aliceDiscovery.type, authorized: aliceDiscovery.payload?.authorized },
  )
  if (aliceDiscoveryOk) {
    aliceLane.lastDiscovery = aliceDiscovery.payload
    check(
      'SOCKET: discovery issues a one-use epoch-discovery challenge (which the HTTP lane does not)',
      typeof aliceDiscovery.payload?.epochDiscoveryChallenge === 'string' &&
        aliceDiscovery.payload.epochDiscoveryChallenge.length >= 32,
      { hasChallenge: typeof aliceDiscovery.payload?.epochDiscoveryChallenge },
    )
  }
  const aliceLeaseProbe = `lease-${randomUUID()}`
  const aliceGrant = await authorizeOverSocket(aliceLane, noteUuid, {
    leaseRequestId: aliceLeaseProbe,
    roomEpoch: aliceDiscovery.payload?.roomEpoch,
  })
  const socketGrantOk = check(
    'SOCKET: COLLABORATION_AUTHORIZE issues a real capability for the OWNER (authorized: true + capability)',
    grantSucceeded(grantPayloadOf(aliceGrant), { room: noteUuid, leaseRequestId: aliceLeaseProbe }),
    { type: aliceGrant.type, authorized: aliceGrant.payload?.authorized, code: aliceGrant.payload?.code },
  )
  const bobGrant = await authorizeOverSocket(bobLane, noteUuid, { leaseRequestId: `lease-${randomUUID()}` })
  const socketGrantBobOk = check(
    'SOCKET: COLLABORATION_AUTHORIZE issues a real capability for the WRITE COLLABORATOR',
    grantSucceeded(grantPayloadOf(bobGrant), { room: noteUuid }),
    { type: bobGrant.type, authorized: bobGrant.payload?.authorized, code: bobGrant.payload?.code },
  )
  const httpGrant = await authorizeOverHttp(alice, noteUuid, { leaseRequestId: `lease-${randomUUID()}` })
  const httpGrantOk = check(
    'HTTP FALLBACK: POST /v1/collaboration/authorize issues a real capability',
    httpGrant.status === 200 && grantSucceeded(httpGrant.body, { room: noteUuid }),
    { stage: httpGrant.stage, status: httpGrant.status },
  )
  row('authorize', {
    socketOwner: socketGrantOk,
    socketCollaborator: socketGrantBobOk,
    httpFallback: httpGrantOk,
    socketIssuesDiscoveryChallenge: typeof aliceDiscovery.payload?.epochDiscoveryChallenge === 'string',
    httpIssuesDiscoveryChallenge: typeof httpGrant.discovery?.epochDiscoveryChallenge === 'string',
  })
  check(
    'HTTP FALLBACK: its discovery leg issues NO challenge, so its grant leg is not bound to a discovery (recorded asymmetry)',
    httpGrant.discovery === undefined || httpGrant.discovery?.epochDiscoveryChallenge === undefined,
    { httpDiscoveryKeys: httpGrant.discovery ? Object.keys(httpGrant.discovery) : undefined },
  )

  // -- co-editing, socket lane ----------------------------------------------
  console.log('\n[co-editing: socket lane]')
  const roomSecret = randomBytes(32).toString('hex')
  const roomKey = await deriveRoomKey(roomSecret, noteUuid)
  const aliceEditor = new Editor({
    account: alice,
    noteUuid,
    key: roomKey,
    label: 'A/socket',
    authorize: (room, options) => authorizeOverSocket(aliceLane, room, options),
  })
  const bobEditor = new Editor({
    account: bob,
    noteUuid,
    key: roomKey,
    label: 'B/socket',
    authorize: (room, options) => authorizeOverSocket(bobLane, room, options),
  })
  const aliceConnected = await aliceEditor.connect()
  const bobConnected = await bobEditor.connect()
  check('both editors hold a legacy /sockets connection', aliceConnected.connected && bobConnected.connected, {
    a: aliceConnected,
    b: bobConnected,
  })
  const aliceJoined = await aliceEditor.join()
  check('A joins the collaboration room on a REAL capability', aliceJoined.joined, aliceJoined)
  const bobJoined = await bobEditor.join()
  check('B joins the collaboration room on a REAL capability', bobJoined.joined, bobJoined)

  if (aliceJoined.joined && bobJoined.joined) {
    await sleep(300)
    const aToB = await measureOneWay(
      aliceEditor,
      bobEditor,
      (text) => text.insert(text.length, 'alpha-from-A\n'),
      (value) => value.includes('alpha-from-A'),
    )
    check('A -> B: B sees A’s text with NO reload', aToB !== undefined, { ms: aToB })
    const bToA = await measureOneWay(
      bobEditor,
      aliceEditor,
      (text) => text.insert(text.length, 'beta-from-B\n'),
      (value) => value.includes('beta-from-B'),
    )
    check('B -> A: A sees B’s text with NO reload', bToA !== undefined, { ms: bToA })
    results.latencies.socketAToB = aToB
    results.latencies.socketBToA = bToA

    // Simultaneous, DIFFERENT paragraphs: both must survive.
    const aMarker = `sim-A-${randomBytes(2).toString('hex')}`
    const bMarker = `sim-B-${randomBytes(2).toString('hex')}`
    aliceEditor.doc.transact(() => aliceEditor.doc.getText('content').insert(0, `${aMarker}\n`), LOCAL_EDIT)
    bobEditor.doc.transact(() => {
      const text = bobEditor.doc.getText('content')
      text.insert(text.length, `${bMarker}\n`)
    }, LOCAL_EDIT)
    await Promise.all([aliceEditor.flush(), bobEditor.flush()])
    const bothSurvive = await waitUntil(
      () =>
        aliceEditor.text.includes(aMarker) &&
        aliceEditor.text.includes(bMarker) &&
        bobEditor.text.includes(aMarker) &&
        bobEditor.text.includes(bMarker),
      CONVERGENCE_TIMEOUT_MS,
    )
    check('simultaneous edits in DIFFERENT paragraphs: both survive on both sides', bothSurvive, {
      a: aliceEditor.text.replace(/\n/g, '¶').slice(0, 120),
      b: bobEditor.text.replace(/\n/g, '¶').slice(0, 120),
    })
    check('the two editors converge to the IDENTICAL document', aliceEditor.text === bobEditor.text, {
      equal: aliceEditor.text === bobEditor.text,
    })

    // Simultaneous, SAME paragraph: say what the resolution IS.
    aliceEditor.doc.transact(() => {
      const text = aliceEditor.doc.getText('content')
      text.insert(text.length, 'AAAA')
    }, LOCAL_EDIT)
    bobEditor.doc.transact(() => {
      const text = bobEditor.doc.getText('content')
      text.insert(text.length, 'BBBB')
    }, LOCAL_EDIT)
    await Promise.all([aliceEditor.flush(), bobEditor.flush()])
    const sameParagraphConverged = await waitUntil(
      () =>
        aliceEditor.text === bobEditor.text && aliceEditor.text.includes('AAAA') && aliceEditor.text.includes('BBBB'),
      CONVERGENCE_TIMEOUT_MS,
    )
    check(
      'simultaneous edits in the SAME paragraph: both survive and both sides agree (CRDT interleave, no loss, no conflict copy)',
      sameParagraphConverged,
      {
        converged: aliceEditor.text === bobEditor.text,
        tail: aliceEditor.text.slice(-24),
      },
    )
    results.rows.sameParagraphResolution = {
      converged: aliceEditor.text === bobEditor.text,
      bothPresent: aliceEditor.text.includes('AAAA') && aliceEditor.text.includes('BBBB'),
      tail: aliceEditor.text.slice(-24),
    }
    row('coEditSocket', {
      aToBMs: aToB,
      bToAMs: bToA,
      differentParagraphs: bothSurvive,
      sameParagraph: sameParagraphConverged,
    })

    // -- credential rotation mid-session ----------------------------------
    console.log('\n[credential rotation mid-session]')
    const rotation = await alice.rotateSession()
    check('A’s session rotates while the note is open and co-edited', rotation.rotated, rotation)
    const socketSurvived = aliceEditor.state.close === undefined && aliceEditor.state.ws.readyState === WebSocket.OPEN
    check('the collaboration socket is NOT torn down by the rotation', socketSurvived, {
      close: aliceEditor.state.close,
    })
    const afterRotation = await measureOneWay(
      aliceEditor,
      bobEditor,
      (text) => text.insert(text.length, '\nafter-rotation-A'),
      (value) => value.includes('after-rotation-A'),
    )
    check('co-editing CONTINUES after the rotation, on the same socket', afterRotation !== undefined, {
      ms: afterRotation,
    })
    // The credential the sync lane presented is now the OLD one, so the gateway
    // is SUPPOSED to answer SESSION_STALE here. That is the signal, not the
    // defect: the defect would be tearing the socket down. Assert the signal,
    // then repair with a REAUTH on the same socket and require the authorization
    // to succeed afterwards -- which is the whole of `c0fe0ccc`'s claim.
    const staleAfterRotation = await aliceLane.authorize({
      noteUuid,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      epochDiscovery: true,
    })
    const signalledStale = staleAfterRotation.type === 'ERROR' && staleAfterRotation.payload?.code === 'SESSION_STALE'
    const authorizedWithoutRepair =
      staleAfterRotation.type === 'COLLABORATION_AUTHORIZED' &&
      discoverySucceeded(staleAfterRotation.payload, { room: noteUuid })
    check(
      'after the rotation the lane either still authorizes or says SESSION_STALE -- it does NOT close and does NOT answer a generic failure',
      (signalledStale || authorizedWithoutRepair) && aliceLane.state.close === undefined,
      {
        type: staleAfterRotation.type,
        code: staleAfterRotation.payload?.code,
        close: aliceLane.state.close,
      },
    )
    let repair
    let laneRepaired = authorizedWithoutRepair
    if (signalledStale) {
      repair = await aliceLane.reauth()
      check('SESSION_STALE is repaired by a REAUTH on the SAME socket (no reconnect)', repair.reauthenticated, repair)
      const resumed = await aliceLane.authorize({
        noteUuid,
        collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
        epochDiscovery: true,
      })
      laneRepaired =
        resumed.type === 'COLLABORATION_AUTHORIZED' && discoverySucceeded(resumed.payload, { room: noteUuid })
      check('the parked collaboration authorization RESUMES after the repair, on the same socket', laneRepaired, {
        type: resumed.type,
        code: resumed.payload?.code,
      })
    }
    check(
      'the sync lane authorizes collaboration again after the rotation (it repaired in place rather than tearing down)',
      laneRepaired && aliceLane.state.close === undefined,
      { laneRepaired, close: aliceLane.state.close },
    )
    row('rotation', {
      rotated: rotation.rotated,
      socketSurvived,
      coEditContinuedMs: afterRotation,
      signalledSessionStale: signalledStale,
      reauthRepaired: repair?.reauthenticated,
      laneAuthorizesAfterRepair: laneRepaired,
      socketNeverClosed: aliceLane.state.close === undefined,
    })
  } else {
    row('coEditSocket', { joined: false, a: aliceJoined, b: bobJoined })
  }

  // -- co-editing with the collaborator authorizing over HTTP ---------------
  console.log('\n[co-editing: HTTP-authorized collaborator]')
  const httpEditor = new Editor({
    account: bob,
    noteUuid,
    key: roomKey,
    label: 'B/http',
    authorize: (room, options) => authorizeOverHttp(bob, room, options),
  })
  const httpConnected = await httpEditor.connect()
  let httpJoined = { joined: false }
  if (httpConnected.connected) {
    httpJoined = await httpEditor.join()
    check('a collaborator authorized ONLY over the HTTP fallback can join the room', httpJoined.joined, httpJoined)
  }
  if (httpJoined.joined && aliceEditor.joined) {
    await sleep(300)
    const toHttp = await measureOneWay(
      aliceEditor,
      httpEditor,
      (text) => text.insert(text.length, '\nhttp-lane-sees-this'),
      (value) => value.includes('http-lane-sees-this'),
    )
    check('A -> HTTP-authorized collaborator: the change arrives live', toHttp !== undefined, { ms: toHttp })
    results.latencies.httpAuthorizedAToB = toHttp
    row('coEditHttpAuthorized', { joined: true, aToBMs: toHttp })
  } else {
    row('coEditHttpAuthorized', { joined: httpJoined.joined, detail: httpJoined })
  }
  httpEditor.close()

  // -- a collaborator with NO socket at all: HTTP pull only -----------------
  console.log('\n[degraded: a collaborator with no socket, pulling over HTTP]')
  const degradedMarker = `degraded-${randomBytes(3).toString('hex')}`
  const degradedSave = await saveNote(alice, {
    sharedVaultUuid,
    keySystemIdentifier,
    noteUuid,
    content: `004:${degradedMarker}`,
  })
  check(
    'A saves the note so a socketless collaborator has something to pull',
    saveLanded(degradedSave.json, noteUuid),
    {
      conflicts: degradedSave.json?.conflicts?.map((c) => c.type),
    },
  )
  const pullStarted = Date.now()
  let pulledAfterMs
  while (Date.now() - pullStarted < HTTP_PULL_TIMEOUT_MS) {
    const pull = await pullVault(bob, sharedVaultUuid)
    const item = (pull.json?.retrieved_items ?? []).find((candidate) => candidate.uuid === noteUuid)
    if (item?.content === `004:${degradedMarker}`) {
      pulledAfterMs = Date.now() - pullStarted
      break
    }
    await sleep(HTTP_PULL_INTERVAL_MS)
  }
  check(
    'a collaborator with NO socket still sees the change over an HTTP pull, eventually',
    pulledAfterMs !== undefined,
    { ms: pulledAfterMs, budgetMs: HTTP_PULL_TIMEOUT_MS },
  )
  results.latencies.httpPullOnly = pulledAfterMs
  row('degradedHttpPull', { sawChangeMs: pulledAfterMs, intervalMs: HTTP_PULL_INTERVAL_MS })

  // -- member removal -------------------------------------------------------
  console.log('\n[member removal]')
  // Keep a grant minted BEFORE removal, to replay after it.
  const staleGrant = await authorizeOverSocket(bobLane, noteUuid, { leaseRequestId: `lease-${randomUUID()}` })
  const staleCapability = capabilityOf(staleGrant)
  const staleEpoch = epochOf(staleGrant)
  check('a pre-removal grant is in hand, to replay after removal', typeof staleCapability === 'string')
  // Also capture the revision B can still read WHILE a member. After removal B
  // cannot read the item at all, so a post-removal save would otherwise guess
  // the revision and die on the time rule before the membership rule ever ran --
  // and "refused" would then say nothing about membership. This is also the real
  // shape of the case: a client that holds the note, then loses access.
  const preRemovalTimestamp = await serverTimestamp(bob, sharedVaultUuid, noteUuid)
  check('B can still read the item revision while a member', preRemovalTimestamp !== undefined, {
    revision: preRemovalTimestamp,
  })

  const removed = await raw('DELETE', `/v1/shared-vaults/${sharedVaultUuid}/users/${bob.uuid}`, alice.auth)
  check('A removes B from the shared vault', removed.status === 200, {
    status: removed.status,
    body: removed.text.slice(0, 200),
  })

  const removedAuthorize = await bobLane.authorize({
    noteUuid,
    collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
    epochDiscovery: true,
  })
  check(
    'a removed member is REFUSED a collaboration capability IMMEDIATELY (decided refusal)',
    authorizationRefused(removedAuthorize),
    { type: removedAuthorize.type, payload: removedAuthorize.payload },
  )
  const removedHttpAuthorize = await authorizeOverHttp(bob, noteUuid)
  check(
    'a removed member is REFUSED on the HTTP fallback too',
    authorizationRefused({ kind: 'http', status: removedHttpAuthorize.status, body: removedHttpAuthorize.body }),
    { status: removedHttpAuthorize.status },
  )

  const removedWrite = await bob.sync({
    items: [
      noteHash({
        uuid: noteUuid,
        content: '004:bob-after-removal',
        sharedVaultUuid,
        keySystemIdentifier,
        updatedAtTimestamp: preRemovalTimestamp,
      }),
    ],
  })
  const removedWriteRefused = saveRefusedByPermission(removedWrite.json, noteUuid, [
    'sharedVaultNotMemberError',
    'shared_vault_not_member_error',
    'sharedVaultInsufficientPermissionsError',
  ])
  check("a removed member's save is REFUSED", removedWriteRefused, {
    conflicts: removedWrite.json?.conflicts?.map((c) => c.type),
  })

  // The readable-but-unsavable question: is the row still READABLE after removal?
  const removedPull = await pullVault(bob, sharedVaultUuid)
  const removedCanStillRead = itemReadable(removedPull.json, noteUuid)
  const removedGet = await raw('GET', `/v1/items/${noteUuid}`, bob.auth)
  const removedCanStillGet = removedGet.status === 200 && removedGet.json?.item?.uuid === noteUuid
  note(
    `after removal, B's vault pull ${removedCanStillRead ? 'STILL RETURNS' : 'no longer returns'} the item and GET /v1/items/:uuid answers ${removedGet.status}`,
  )
  check(
    'after removal the item is no longer served to the ex-member on EITHER read path (if this fails, the readable-but-unsavable state is a real stale-read)',
    !removedCanStillRead && !removedCanStillGet,
    { vaultPull: removedCanStillRead, directGet: removedGet.status },
  )
  row('removal', {
    authorizeRefusedSocket: authorizationRefused(removedAuthorize),
    authorizeRefusedHttp: authorizationRefused({
      kind: 'http',
      status: removedHttpAuthorize.status,
      body: removedHttpAuthorize.body,
    }),
    saveRefused: removedWriteRefused,
    stillReadableViaVaultPull: removedCanStillRead,
    stillReadableViaDirectGet: removedCanStillGet,
    directGetStatus: removedGet.status,
  })

  // -- NEGATIVE: replay the stale grant after removal -----------------------
  console.log('\n[negative: stale grant replayed after removal]')
  if (staleCapability && staleEpoch) {
    const replayRequestId = `lease-${randomUUID()}`
    const replayEditor = new Editor({
      account: bob,
      noteUuid,
      key: roomKey,
      label: 'B/replay',
      authorize: async () => undefined,
    })
    const replayConnected = await replayEditor.connect()
    if (replayConnected.connected) {
      replayEditor.state.ws.send(
        JSON.stringify({
          t: 'room-reserve',
          room: noteUuid,
          cap: staleCapability,
          requestId: replayRequestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: staleEpoch,
        }),
      )
      const replayAnswer = await waitForFrame(
        replayEditor.state,
        (f) => (f?.t === 'room-reserved' || f?.t === 'room-denied') && f.requestId === replayRequestId,
        12_000,
      )
      check(
        'a grant minted BEFORE removal is REFUSED when replayed after it (the capability is not a bearer pass for the room)',
        replayAnswer?.t === 'room-denied',
        { answer: replayAnswer?.t, reason: replayAnswer?.reason },
      )
      row('negative', { staleGrantReplay: replayAnswer?.t, staleGrantReason: replayAnswer?.reason })
      // CONTROL: the same reserve with a mangled capability must ALSO be denied,
      // which is what proves the probe above is not simply always-denied.
      const controlRequestId = `lease-${randomUUID()}`
      replayEditor.state.ws.send(
        JSON.stringify({
          t: 'room-reserve',
          room: noteUuid,
          cap: `${staleCapability.slice(0, -4)}AAAA`,
          requestId: controlRequestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: staleEpoch,
        }),
      )
      const controlAnswer = await waitForFrame(
        replayEditor.state,
        (f) => (f?.t === 'room-reserved' || f?.t === 'room-denied') && f.requestId === controlRequestId,
        12_000,
      )
      control('the room reserve probe', controlAnswer?.t !== 'room-reserved', { answer: controlAnswer?.t })
      replayEditor.close()
    }
  }

  // -- NEGATIVE: the epoch-discovery challenge presented over HTTP ----------
  console.log('\n[negative: the epoch challenge over HTTP]')
  const ownerDiscovery = await aliceLane.authorize({
    noteUuid,
    collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
    epochDiscovery: true,
  })
  const socketChallenge = ownerDiscovery.payload?.epochDiscoveryChallenge
  const httpWithSocketChallenge = await raw('POST', '/v1/collaboration/authorize', {
    ...alice.auth,
    body: {
      noteUuid,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: ownerDiscovery.payload?.roomEpoch,
      leaseRequestId: `lease-${randomUUID()}`,
      epochDiscoveryChallenge: socketChallenge,
      epochDiscoveryRequestId: ownerDiscovery.payload?.epochDiscoveryRequestId,
    },
  })
  note(
    `presenting the socket lane's one-use epoch-discovery challenge to the HTTP endpoint answers ${httpWithSocketChallenge.status}; the HTTP endpoint accepts an arbitrary expectedRoomEpoch with no challenge at all, so its grant leg is NOT bound to a discovery`,
  )
  // Whether the HTTP lane binds the challenge or ignores it, what must NOT
  // happen is an unauthorized grant. Prove the authorization decision itself is
  // still the gate by asking for an epoch nobody ever discovered.
  const inventedEpoch = randomBytes(16).toString('hex')
  const httpInventedEpoch = await raw('POST', '/v1/collaboration/authorize', {
    ...alice.auth,
    body: {
      noteUuid,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: inventedEpoch,
      leaseRequestId: `lease-${randomUUID()}`,
    },
  })
  const inventedSigned = httpInventedEpoch.status === 200 && httpInventedEpoch.json?.roomEpoch === inventedEpoch
  note(
    `the HTTP endpoint ${inventedSigned ? 'SIGNS' : 'refuses'} a capability for an epoch the client invented (status ${httpInventedEpoch.status})`,
  )
  check(
    'an invented room epoch cannot be USED, whatever the authorize endpoint signs: the gateway denies the reserve',
    await inventedEpochIsUnusable(alice, noteUuid, httpInventedEpoch.json, roomKey),
    { signed: inventedSigned },
  )
  // And the security epoch must never be client-chosen.
  const httpForgedSecurityEpoch = await raw('POST', '/v1/collaboration/authorize', {
    ...alice.auth,
    body: {
      noteUuid,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: ownerDiscovery.payload?.roomEpoch,
      leaseRequestId: `lease-${randomUUID()}`,
      collaborationSecurityEpoch: randomBytes(16).toString('hex'),
    },
  })
  check(
    'the collaboration SECURITY epoch is never taken from client input (the server’s own value is returned)',
    httpForgedSecurityEpoch.status !== 200 ||
      httpForgedSecurityEpoch.json?.collaborationSecurityEpoch === ownerDiscovery.payload?.collaborationSecurityEpoch,
    {
      status: httpForgedSecurityEpoch.status,
      returned: httpForgedSecurityEpoch.json?.collaborationSecurityEpoch?.slice(0, 12),
      expected: ownerDiscovery.payload?.collaborationSecurityEpoch?.slice(0, 12),
    },
  )
  row('epochChallenge', {
    socketIssuesChallenge: typeof socketChallenge === 'string',
    httpAcceptsSocketChallenge: httpWithSocketChallenge.status,
    httpSignsInventedEpoch: inventedSigned,
    securityEpochClientChoosable:
      httpForgedSecurityEpoch.status === 200 &&
      httpForgedSecurityEpoch.json?.collaborationSecurityEpoch !== ownerDiscovery.payload?.collaborationSecurityEpoch,
  })

  aliceEditor.close()
  bobEditor.close()
  aliceLane.close()
  bobLane.close()

  console.log(`\n[matrix] ${JSON.stringify(results, null, 2)}`)
  console.log(
    `\n[collab-end-to-end] ${failures === 0 && controlFailures === 0 ? 'PASS' : `FAIL failures=${failures} controlFailures=${controlFailures}`}`,
  )
  return failures === 0 && controlFailures === 0 ? 0 : 1
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

/**
 * Take a capability the HTTP endpoint signed for an epoch nobody discovered and
 * try to actually RESERVE with it. The question is not what the endpoint
 * returns, it is whether the room can be entered on it.
 */
async function inventedEpochIsUnusable(account, noteUuid, grant, roomKey) {
  if (!grant || typeof grant.capability !== 'string') return true
  const probe = new Editor({ account, noteUuid, key: roomKey, label: 'invented', authorize: async () => undefined })
  const connected = await probe.connect()
  if (!connected.connected) return true
  const requestId = grant.leaseRequestId ?? `lease-${randomUUID()}`
  probe.state.ws.send(
    JSON.stringify({
      t: 'room-reserve',
      room: noteUuid,
      cap: grant.capability,
      requestId,
      role: 'editor',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: grant.roomEpoch,
    }),
  )
  const answer = await waitForFrame(
    probe.state,
    (f) => (f?.t === 'room-reserved' || f?.t === 'room-denied') && f.requestId === requestId,
    12_000,
  )
  probe.close()
  return answer?.t !== 'room-reserved'
}

/** Invite + accept, the real membership path. */
async function inviteAndAccept(owner, recipient, sharedVaultUuid, permission) {
  const invite = await raw('POST', `/v1/shared-vaults/${sharedVaultUuid}/invites`, {
    ...owner.auth,
    body: {
      recipient_uuid: recipient.uuid,
      encrypted_message: `collab-probe-${randomBytes(8).toString('hex')}`,
      permission,
    },
  })
  const inviteUuid = invite.json?.invite?.uuid ?? invite.json?.uuid
  if (invite.status !== 200 || typeof inviteUuid !== 'string') {
    return { accepted: false, stage: 'invite', status: invite.status, body: invite.text.slice(0, 300) }
  }
  const accepted = await raw(
    'POST',
    `/v1/shared-vaults/${sharedVaultUuid}/invites/${inviteUuid}/accept`,
    recipient.auth,
  )
  if (accepted.status !== 200) {
    return { accepted: false, stage: 'accept', status: accepted.status, body: accepted.text.slice(0, 300) }
  }
  return { accepted: true, inviteUuid, permission }
}

async function memberPermission(owner, sharedVaultUuid, userUuid) {
  const users = await raw('GET', `/v1/shared-vaults/${sharedVaultUuid}/users`, owner.auth)
  const list = users.json?.users ?? users.json?.sharedVaultUsers ?? []
  const found = list.find((user) => (user.user_uuid ?? user.userUuid) === userUuid)
  return found?.permission
}

/**
 * Get B from read to write. There is no endpoint that changes an existing
 * member's permission, so this reports WHICH path worked.
 */
async function promoteToWrite(owner, recipient, sharedVaultUuid) {
  const reinvite = await inviteAndAccept(owner, recipient, sharedVaultUuid, 'write')
  if (reinvite.accepted) {
    const permission = await memberPermission(owner, sharedVaultUuid, recipient.uuid)
    if (permission === 'write') return { permission, requiredRemoval: false, via: 're-invite' }
  }
  const removed = await raw('DELETE', `/v1/shared-vaults/${sharedVaultUuid}/users/${recipient.uuid}`, owner.auth)
  if (removed.status !== 200) {
    return { permission: undefined, stage: 'remove', status: removed.status, body: removed.text.slice(0, 200) }
  }
  const again = await inviteAndAccept(owner, recipient, sharedVaultUuid, 'write')
  if (!again.accepted) return { permission: undefined, stage: 'reinvite-after-remove', detail: again }
  const permission = await memberPermission(owner, sharedVaultUuid, recipient.uuid)
  return { permission, requiredRemoval: true, via: 'remove + re-invite', reinviteAttempt: reinvite }
}

const exitCode = SELF_TEST
  ? selfTest()
  : await main().catch((error) => {
      console.error(`  FAIL - unhandled: ${error?.stack ?? error}`)
      return 1
    })
process.exit(exitCode)
