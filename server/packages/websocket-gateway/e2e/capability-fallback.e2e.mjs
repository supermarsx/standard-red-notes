/**
 * Socket capability census and FALLBACK matrix, run against the LIVE stack
 * through the public front door.
 *
 * Every socket capability is optional. The gateway advertises the subset whose
 * adapters composed on the `AUTHENTICATED` frame, and each withheld one is
 * supposed to leave the client on a documented HTTP path instead of broken.
 * Those claims had never been measured; this script measures them.
 *
 * For every row it records three things, as data rather than prose:
 *
 *   advertised   did `AUTHENTICATED.operations` carry it
 *   lane         does the capability actually WORK over the socket right now
 *   fallback     does the documented HTTP path produce the same outcome
 *
 * The fallback leg runs on EVERY run, advertised or not. That is deliberate:
 * the HTTP path is what a client uses whenever the lane is withheld, the socket
 * is closed, or a frame fails, so it must be proven on the same stack and the
 * same account in the same run. A run with a capability withheld (the stack
 * reconfigured by the caller) then differs only in the `lane` column, which is
 * exactly the comparison the matrix needs.
 *
 * WHAT "works" MEANS. A lane row is green only on a PRESENT SUCCESS: a frame
 * the gateway emits only after it actually did the work, or an ERROR whose code
 * names a policy the server decided (`LANE_POLICY_CODES`). It is deliberately
 * never "any answer that is not OPERATION_UNAVAILABLE". That predicate recorded
 * `FILES_V1 lane: works` against an image on which EVERY cookie-session file
 * operation was refused `FILE_ACCESS_DENIED` -- it is not a gate, because the
 * one error code it names is not the one a broken lane produces. The FILES_V1
 * row now carries a real file: OPEN accepted, every chunk ACKed, FINISH
 * completed on the client's digest, downloaded back and compared byte for byte.
 *
 * CONTROLS. Every probe here has a planted condition that must make it FAIL, so
 * a green row cannot be a probe that is incapable of going red:
 *
 *   --self-test   runs the pure predicates against synthetic frames, including
 *                 the negative cases, with no stack and no Docker.
 *   CONTROL=1     on a LIVE run, re-runs each fallback leg against a
 *                 deliberately broken input (a revoked token, a nonexistent
 *                 path, a corrupted digest) and requires it to fail. If a
 *                 control passes, the probe is declared worthless and the whole
 *                 script exits non-zero even when every real row was green.
 *
 * SESSION TYPE. The stack issues COOKIE sessions unless `E2E_TESTING=true`
 * forces legacy header sessions, and several lanes carry a session credential
 * whose cookie half is invisible under that flag. This script CONFIRMS which
 * kind it got (`2:` access-token prefix = cookie session) and records it, so a
 * green matrix taken on legacy sessions cannot be mistaken for one taken on the
 * sessions production issues.
 *
 * Usage (host, public front door):
 *   REQUIRE_GATEWAY=1 yarn node e2e/capability-fallback.e2e.mjs
 *   CONTROL=1 REQUIRE_GATEWAY=1 yarn node e2e/capability-fallback.e2e.mjs
 *   yarn node e2e/capability-fallback.e2e.mjs --self-test
 *
 * Env: BASE, WS_BASE, ORIGIN, REQUIRE_GATEWAY, REQUIRE_SYNC_ITEMS,
 *      EXPECT_OPERATIONS (comma-separated; fails when the census differs),
 *      EXPECT_WITHHELD (comma-separated; fails when any IS advertised),
 *      EXPECT_SESSION (`cookie` | `legacy`; fails on the other kind),
 *      EXPECT_NO_TICKET=1 (the lane is deliberately off: the ticket endpoint
 *        must refuse 503 SYNC_DISABLED, and that is the pass),
 *      REGISTER_API (20240226 => cookie session, 20200115 => legacy),
 *      RPC_PATH, INVITE_HTTP_PATH,
 *      CONTROL, MATRIX_JSON (path to write the machine-readable matrix to),
 *      FILE_PROBE_BYTES (size of the file the FILES_V1 round trip carries).
 */
import { WebSocket } from 'ws'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3001'
const WS_BASE = process.env.WS_BASE ?? 'ws://localhost:3001'
const ORIGIN = process.env.ORIGIN ?? BASE
const HEALTH_PATH = process.env.GATEWAY_HEALTH_PATH ?? '/healthcheck/readiness'
const REQUIRE_GATEWAY = process.env.REQUIRE_GATEWAY === '1'
const REQUIRE_SYNC_ITEMS = process.env.REQUIRE_SYNC_ITEMS === '1'
const CONTROL = process.env.CONTROL === '1'
const MATRIX_JSON = process.env.MATRIX_JSON ?? ''
const API = '20200115'
// Registration api version decides the SESSION KIND, which is what decides
// whether a lane's cookie half is exercised at all:
// `SessionService.shouldOperateOnCookieBasedSessions` issues a cookie session
// only at exactly 20240226, and only while `forceLegacySessions`
// (`E2E_TESTING === 'true'`) is off. Default to the cookie version so the
// matrix is taken on the sessions production issues; set REGISTER_API=20200115
// to re-take it on legacy header sessions and diff the two.
const REGISTER_API = process.env.REGISTER_API ?? '20240226'
const EXPECT_SESSION = process.env.EXPECT_SESSION ?? ''
// For a run against a deployment whose lane is deliberately OFF: the ticket
// endpoint must refuse 503 SYNC_DISABLED rather than issue one, and that is a
// pass, not a failure.
const EXPECT_NO_TICKET = process.env.EXPECT_NO_TICKET === '1'
const DEVICE_ID = 'e2e-capfall-' + randomUUID()

// GET paths the API_RPC lane may actually carry. `/v1/sessions`, `/v1/items`,
// `/v1/users/*`, `/v1/login-params`, `/v1/sockets/*` and `/sockets` are on
// `FORBIDDEN_RPC_ROUTE_FAMILIES` in LoopbackSyncApiRpcAdapter and are refused
// by the ADAPTER. That refusal now answers its own non-retryable
// `RPC_PATH_FORBIDDEN` code, so it is no longer indistinguishable from the
// BACKEND_ERROR a dead backend reports — but it is still an ERROR frame rather
// than a 200, so `isRpcOk` reads it as a broken lane either way. Probing one of
// those measures the block list, not the lane.
const RPC_PATH = process.env.RPC_PATH ?? '/v1/shared-vaults/invites'
const INVITE_HTTP_PATH = process.env.INVITE_HTTP_PATH ?? '/v1/shared-vaults/invites'

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
const matrix = {}
const notes = []

function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  else {
    console.log(`  FAIL - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
    failures++
  }
  return Boolean(cond)
}

/**
 * A control asserts that a probe CAN fail. `brokenOutcome` is what the probe
 * returned for a deliberately broken input; it must NOT look like success.
 */
function control(name, probeRejected, detail) {
  if (probeRejected)
    console.log(
      `  ctrl - ${name} correctly failed on a planted break${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`,
    )
  else {
    console.log(
      `  CONTROL-FAIL - ${name} PASSED on a planted break; this probe cannot detect a real failure${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`,
    )
    controlFailures++
  }
  return Boolean(probeRejected)
}

function note(text) {
  notes.push(text)
  console.log(`  note - ${text}`)
}

function row(operation, patch) {
  matrix[operation] = { ...(matrix[operation] ?? {}), ...patch }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function raw(method, path, { body, token, headers, cookie } = {}) {
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
  const json = parsed && typeof parsed === 'object' && 'data' in parsed && 'meta' in parsed ? parsed.data : parsed
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  return { status: res.status, json, text, setCookie, headers: res.headers }
}

/** The `name=value` pairs from a Set-Cookie list, as one Cookie header. */
function cookieHeaderFrom(setCookie) {
  const pairs = setCookie
    .map((entry) => entry.split(';', 1)[0].trim())
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
  return pairs.length > 0 ? pairs.join('; ') : ''
}

async function register() {
  const email = `e2e-capfall-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
  const password = randomBytes(32).toString('hex')
  const r = await raw('POST', '/v1/users', {
    body: {
      email,
      password,
      api: REGISTER_API,
      version: '004',
      pw_nonce: randomBytes(32).toString('hex'),
      origination: 'registration',
      created: String(Date.now()),
      ephemeral: false,
    },
  })
  if (r.status !== 200 || !r.json?.session?.access_token) {
    throw new Error(`register failed: ${r.status} ${r.text.slice(0, 400)}`)
  }
  return {
    email,
    password,
    session: r.json.session,
    user: r.json.user,
    cookie: cookieHeaderFrom(r.setCookie),
    setCookieCount: r.setCookie.length,
  }
}

// ---------------------------------------------------------------------------
// Protocol-v1 canonical JSON + digest. Same algorithm as
// websocket-gateway/src/syncProtocol.ts `canonicalSyncJson`/`digestSyncCommandBody`
// and syncing-server's `computeSyncCommandDigest`; the published cross-transport
// vector is asserted in --self-test so this cannot drift.
// ---------------------------------------------------------------------------
function canonicalSyncJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalSyncJson).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(value[key])}`).join(',')}}`
}
function commandDigest(body) {
  return createHash('sha256').update(canonicalSyncJson(body), 'utf8').digest('hex')
}
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

function makeNote(bytes = 512) {
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
// FILES_V1 binary wire format, byte-for-byte the same as
// websocket-gateway/src/filesProtocol.ts: an 8-byte prefix (ASCII magic `SRNF`,
// uint8 version, uint8 kind, BE uint16 header length), the JSON header, then
// the payload. --self-test round-trips these against each other so a drift here
// shows up with no stack.
// ---------------------------------------------------------------------------
const FILE_BINARY_MAGIC = Buffer.from('SRNF', 'ascii')
const FILE_BINARY_PREFIX_BYTES = 8
const FILES_PROTOCOL_VERSION = 1
const FILE_PROBE_BYTES = Number(process.env.FILE_PROBE_BYTES ?? 3000)

export function encodeFileChunkFrame(header, bytes) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const frame = Buffer.allocUnsafe(FILE_BINARY_PREFIX_BYTES + headerBytes.byteLength + bytes.byteLength)
  FILE_BINARY_MAGIC.copy(frame, 0)
  frame.writeUInt8(FILES_PROTOCOL_VERSION, 4)
  frame.writeUInt8(header.kind === 'UPLOAD_CHUNK' ? 1 : 2, 5)
  frame.writeUInt16BE(headerBytes.byteLength, 6)
  headerBytes.copy(frame, FILE_BINARY_PREFIX_BYTES)
  Buffer.from(bytes).copy(frame, FILE_BINARY_PREFIX_BYTES + headerBytes.byteLength)
  return frame
}

/** Returns undefined for anything that is not a well-formed file chunk frame. */
export function decodeFileChunkFrame(raw) {
  const frame = Buffer.from(raw)
  if (frame.byteLength < FILE_BINARY_PREFIX_BYTES) return undefined
  if (!frame.subarray(0, FILE_BINARY_MAGIC.byteLength).equals(FILE_BINARY_MAGIC)) return undefined
  if (frame.readUInt8(4) !== FILES_PROTOCOL_VERSION) return undefined
  const headerLength = frame.readUInt16BE(6)
  if (FILE_BINARY_PREFIX_BYTES + headerLength > frame.byteLength) return undefined
  let header
  try {
    header = JSON.parse(
      frame.subarray(FILE_BINARY_PREFIX_BYTES, FILE_BINARY_PREFIX_BYTES + headerLength).toString('utf8'),
    )
  } catch {
    return undefined
  }
  const bytes = frame.subarray(FILE_BINARY_PREFIX_BYTES + headerLength)
  if (!header || typeof header !== 'object' || header.byteLength !== bytes.byteLength) return undefined
  if (createHash('sha256').update(bytes).digest('hex') !== header.sha256) return undefined
  return { header, bytes }
}

// ---------------------------------------------------------------------------
// Pure predicates, exercised by BOTH the live run and --self-test so the
// pass/fail rule cannot drift between them.
// ---------------------------------------------------------------------------
export function censusFrom(authenticatedFrame) {
  const operations = authenticatedFrame?.payload?.operations
  const seen = Array.isArray(operations) ? operations.filter((entry) => typeof entry === 'string') : []
  const result = {}
  for (const operation of ALL_OPERATIONS) result[operation] = seen.includes(operation)
  return { seen, advertised: result }
}

/** A cookie session's access token is version-prefixed `2:`; legacy is `1:`. */
export function isCookieSessionToken(accessToken) {
  return typeof accessToken === 'string' && accessToken.startsWith('2:')
}

export const isCommitted = (frame) =>
  frame?.type !== 'ERROR' && (frame?.payload?.status === 'COMMITTED' || frame?.type === 'COMMITTED')
export const isRpcOk = (frame) => frame?.type === 'RPC_RESPONSE' && frame?.payload?.status === 200
export const isOperationUnavailable = (frame) =>
  frame?.type === 'ERROR' && frame?.payload?.code === 'OPERATION_UNAVAILABLE'

/**
 * ERROR codes that are a DECISION the lane carried, not a failure of the lane.
 *
 * Closed on purpose, and deliberately short. Every code the gateway emits for a
 * transport, session, availability, quota or backend failure is ABSENT, so a
 * new failure code added upstream cannot silently widen what counts as "the
 * lane worked" -- it lands outside the list and reads as broken, which is the
 * safe direction. Compare `SyncAuthorizationCode` in syncCommandHandler.ts;
 * SESSION_STALE and SESSION_REVOKED are public there but are NOT policy here:
 * they mean the credential this lane carries stopped working.
 */
export const LANE_POLICY_CODES = Object.freeze([
  'NOT_AUTHORIZED',
  'READ_ONLY',
  'CONTENT_LIMIT',
  'SHARED_VAULT_FORBIDDEN',
  'LIVE_SYNC_DISABLED',
  'CHALLENGE_EXPIRED',
])

/**
 * Did the lane CARRY this request?
 *
 * The rule is a PRESENT SUCCESS: one of the frame types the handler emits only
 * after it has actually done the work, or an ERROR whose code names a policy
 * the server decided. It is deliberately NOT "any answer that is not
 * OPERATION_UNAVAILABLE".
 *
 * That older predicate was not a gate. It reported `FILES_V1 lane: works`
 * against the pre-`efa5b985` image, on which every cookie-session file
 * operation answered `ERROR FILE_ACCESS_DENIED` -- an error, just not the one
 * error it happened to name. A dead backend (BACKEND_ERROR / BACKEND_TIMEOUT),
 * a refused credential (SESSION_STALE / SESSION_REVOKED), an unavailable store
 * (INVITE_STORE_UNAVAILABLE) all read as a working lane under it, and only
 * exactly one code could ever turn a row red.
 */
export function laneCarried(answer, successTypes, policyCodes = []) {
  if (!answer || typeof answer.type !== 'string') return false
  if (successTypes.includes(answer.type)) return true
  if (answer.type !== 'ERROR') return false
  return policyCodes.includes(answer?.payload?.code)
}

/**
 * The FILES_V1 lane verdict: a file actually made the round trip.
 *
 * OPEN accepted, every chunk ACKed, FINISH completed on the digest the client
 * computed, the download accepted and completed on that same digest, and the
 * bytes that came back identical to the bytes that went out -- which is exactly
 * the round trip `efa5b985` ran by hand to prove the fix. Every field must be
 * PRESENT and positive; an absent stage is a failure, so a trip that died at
 * FILES_UPLOAD_OPEN (what the broken build does) cannot read as success.
 */
export function fileRoundTripSucceeded(trip) {
  if (!trip || typeof trip !== 'object') return false
  const expected = trip.expectedSha256
  return (
    trip.metadataAnswered === true &&
    trip.uploadAccepted === true &&
    Number.isInteger(trip.chunksSent) &&
    trip.chunksSent > 0 &&
    trip.chunksAcked === trip.chunksSent &&
    trip.finishCompleted === true &&
    typeof expected === 'string' &&
    /^[a-f0-9]{64}$/u.test(expected) &&
    trip.uploadSha256 === expected &&
    trip.downloadAccepted === true &&
    trip.downloadCompleted === true &&
    trip.downloadSha256 === expected &&
    trip.bytesIdentical === true
  )
}

// ---------------------------------------------------------------------------
// AUTHORIZE_COLLABORATION.
//
// The row this replaces was the SIXTH form of a gate that is not a gate: a
// predicate whose success case is unreachable BY CONSTRUCTION. It probed
// `collabNoteUuid = randomUUID()` -- a note it never created -- and settled on
// "a COLLABORATION_AUTHORIZED frame, or an ERROR naming a policy". For a note
// that does not exist `ERROR NOT_AUTHORIZED` is the CORRECT answer, so the row
// could only ever take the policy branch, on a healthy stack and on a broken
// one alike. Booted side by side, the broken and fixed single-container images
// printed `lane: "works"`, `laneDetail {"type":"ERROR","code":"NOT_AUTHORIZED"}`
// and `failures: 0` BYTE-IDENTICALLY across a defect that denied 100 % of
// collaboration, for every note, including a personal note owned by the caller
// (`6e18e3a5`: `DirectCallServiceProxy.callSyncingServer` declared three
// parameters against a four-parameter interface and discarded `payload`, the
// only place `{ itemUuid }` existed).
//
// So the rule here is the same one `2f02b73b` applied to the other rows, and it
// takes a note the account is ENTITLED to edit to state it:
//
//   a present GRANT   -- discovery answers an epoch pair for THIS room, and the
//                        grant that consumes its one-use challenge answers a
//                        CAPABILITY bound to this room, this epoch pair, this
//                        lease and a positive canonical revision;
//   plus a REFUSAL    -- the same two legs against a note that does not exist
//                        must be DECIDED (`ERROR NOT_AUTHORIZED` / 403
//                        `collaboration-not-authorized`), never a grant.
//
// Both halves are required, in both transports. The grant alone could pass on
// an authorizer that says yes to everything; the refusal alone is what the old
// row measured. `BACKEND_ERROR`, `BACKEND_TIMEOUT`, `SESSION_STALE` and silence
// are a broken lane in either half, never a refusal.
// ---------------------------------------------------------------------------

/** base64url epoch (`CollaborationAuthorizationService`) or hex (the gateway's rotated one). */
const COLLABORATION_EPOCH_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u

/**
 * An epoch DISCOVERY actually happened: an epoch pair for THIS room, a positive
 * canonical revision, and the one-use challenge the grant leg must consume. No
 * capability -- discovery does not mint one, and a payload that carries one
 * came from somewhere else.
 */
export function collaborationDiscoverySucceeded(answer, { room } = {}) {
  if (answer?.type !== 'COLLABORATION_AUTHORIZED') return false
  const payload = answer.payload
  if (!payload || typeof payload !== 'object') return false
  if (payload.authorized === false) return false
  if (payload.epochDiscovery !== true) return false
  if (payload.capability !== undefined) return false
  if (payload.collaborationProtocolVersion !== 3) return false
  if (!COLLABORATION_EPOCH_PATTERN.test(String(payload.roomEpoch))) return false
  if (!COLLABORATION_EPOCH_PATTERN.test(String(payload.collaborationSecurityEpoch))) return false
  if (!Number.isSafeInteger(payload.serverUpdatedAtTimestamp) || payload.serverUpdatedAtTimestamp <= 0) return false
  if (typeof payload.epochDiscoveryChallenge !== 'string' || payload.epochDiscoveryChallenge.length < 32) return false
  if (typeof payload.epochDiscoveryRequestId !== 'string' || payload.epochDiscoveryRequestId.length === 0) return false
  if (room !== undefined && payload.room !== room) return false
  return true
}

/**
 * A collaboration GRANT actually happened: a capability was ISSUED and it is
 * bound to the room, the epoch pair and the lease that were asked for. A
 * well-formed `{ authorized: false }` is exactly what both halves of this
 * defect produced, so it is a failure here and not a decision.
 */
export function collaborationGrantSucceeded(answer, { room, roomEpoch, collaborationSecurityEpoch, lease } = {}) {
  if (answer?.type !== 'COLLABORATION_AUTHORIZED') return false
  const payload = answer.payload
  if (!payload || typeof payload !== 'object') return false
  if (payload.authorized === false) return false
  if (payload.epochDiscovery === true) return false
  if (payload.collaborationProtocolVersion !== 3) return false
  if (!Number.isSafeInteger(payload.expiresIn) || payload.expiresIn <= 0) return false
  if (!Number.isSafeInteger(payload.serverUpdatedAtTimestamp) || payload.serverUpdatedAtTimestamp <= 0) return false
  if (room !== undefined && payload.room !== room) return false
  if (roomEpoch !== undefined && payload.roomEpoch !== roomEpoch) return false
  if (collaborationSecurityEpoch !== undefined && payload.collaborationSecurityEpoch !== collaborationSecurityEpoch) {
    return false
  }
  if (lease !== undefined && payload.leaseRequestId !== lease) return false
  // The capability is an HS256 JWT signed with a secret this script does not
  // hold, so it is DECODED, never verified: the point is that the claims the
  // gateway's room authorizer checks are present and bound, not that we can
  // re-sign them. A capability whose claims name another room or another epoch
  // would be refused at `room-reserve`, so a grant carrying one is not a grant.
  // `decodeJwtClaims` returns undefined for a missing, non-string or
  // non-three-segment capability, so THIS is the presence check as well as the
  // binding check. An extra `typeof payload.capability === 'string'` guard
  // above it was an inert branch -- no input could make the two disagree, so no
  // test could kill a mutation of it, and an unkillable branch in a predicate
  // is the thing this file exists to avoid.
  const claims = decodeJwtClaims(payload.capability)
  if (!claims || claims.purpose !== 'collab-room') return false
  if (claims.room !== payload.room) return false
  if (claims.roomEpoch !== payload.roomEpoch) return false
  if (claims.collaborationSecurityEpoch !== payload.collaborationSecurityEpoch) return false
  if (claims.serverUpdatedAtTimestamp !== payload.serverUpdatedAtTimestamp) return false
  if (typeof claims.userUuid !== 'string' || claims.userUuid.length === 0) return false
  if (lease !== undefined && claims.leaseRequestId !== lease) return false
  return true
}

/** Decode a JWT's claim set without verifying it. `undefined` for anything else. */
export function decodeJwtClaims(token) {
  if (typeof token !== 'string') return undefined
  const segments = token.split('.')
  if (segments.length !== 3) return undefined
  try {
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' ? claims : undefined
  } catch {
    return undefined
  }
}

/**
 * The server REFUSED, by DECIDING to. A transport failure is not a refusal:
 * reading `BACKEND_ERROR`, `BACKEND_TIMEOUT` or silence as "correctly denied"
 * is the mistake that kept both halves of this defect invisible.
 */
export function collaborationRefusalDecided(answer) {
  if (answer?.type === 'COLLABORATION_AUTHORIZED') return answer.payload?.authorized === false
  if (answer?.type !== 'ERROR') return false
  return answer.payload?.code === 'NOT_AUTHORIZED'
}

/** The HTTP fallback's grant: a 200 carrying the same bound capability. */
export function collaborationHttpGrantSucceeded(result, bindings = {}) {
  if (result?.status !== 200) return false
  return collaborationGrantSucceeded({ type: 'COLLABORATION_AUTHORIZED', payload: result.json }, bindings)
}

/**
 * The HTTP fallback's discovery: a 200 carrying an epoch pair, no challenge.
 *
 * `CollaborationController` DESTRUCTURES `authorized` out of the grant before
 * it answers (`const { authorized: _authorized, ...responseBody }`), so the
 * 200 itself is the affirmative and requiring the key would fail over a
 * working deployment. The epoch pair and the revision are what has to be
 * present; `authorized: false` is still rejected, for a deployment that ever
 * stops stripping it.
 */
export function collaborationHttpDiscoverySucceeded(result, { room } = {}) {
  if (result?.status !== 200) return false
  const body = result.json
  if (!body || typeof body !== 'object') return false
  if (body.authorized === false) return false
  if (body.epochDiscovery !== true) return false
  if (body.capability !== undefined) return false
  if (!COLLABORATION_EPOCH_PATTERN.test(String(body.roomEpoch))) return false
  if (!COLLABORATION_EPOCH_PATTERN.test(String(body.collaborationSecurityEpoch))) return false
  if (!Number.isSafeInteger(body.serverUpdatedAtTimestamp) || body.serverUpdatedAtTimestamp <= 0) return false
  if (room !== undefined && body.room !== room) return false
  return true
}

/** The HTTP fallback's refusal: the named 403 the controller produces. */
export function collaborationHttpRefusalDecided(result) {
  return result?.status === 403 && result?.json?.error?.tag === 'collaboration-not-authorized'
}

/**
 * The AUTHORIZE_COLLABORATION verdict, per transport. Every stage must be
 * PRESENT and positive, and the refusal control must have REFUSED -- an
 * always-grant authorizer and an always-deny one both fail.
 */
export function collaborationLaneSucceeded(trip) {
  if (!trip || typeof trip !== 'object') return false
  return (
    trip.ownedNoteExists === true &&
    trip.discovered === true &&
    trip.granted === true &&
    trip.absentNoteRefused === true
  )
}

/** The fallback verdict: an HTTP leg counts only on a 2xx that carried data. */
export function httpFallbackSucceeded(result) {
  return result?.status === 200 && result?.json !== undefined && result?.json !== null
}

/**
 * The weaker REACHABILITY bar, for the legs where a 200 is a deployment choice
 * rather than a contract (an assistant with no provider configured, a
 * collaboration authorize that legitimately refuses).
 *
 * Reachable means the ROUTE answered: a 2xx, or a 4xx the handler itself
 * produced. 404/405 mean there is no route; a 3xx means the route is somewhere
 * else; a 5xx means the route exists but nothing behind it answered. A client
 * cannot fall back onto any of those, so none of them is reachability. The old
 * `status !== 404 && status !== 405` called a 502 a working fallback.
 */
export function httpFallbackReachable(result) {
  const status = result?.status
  if (!Number.isInteger(status)) return false
  if (status === 404 || status === 405) return false
  return (status >= 200 && status < 300) || (status >= 400 && status < 500)
}

/** Tri-state so the matrix word means something: works > reachable > broken. */
export function httpFallbackVerdict(result) {
  if (httpFallbackSucceeded(result)) return 'works'
  return httpFallbackReachable(result) ? 'reachable' : 'broken'
}

/**
 * The legacy /sockets lane verdict.
 *
 * `ws` resolves `open` the moment the HTTP 101 lands, and "no close event yet"
 * is an absence, not a success -- the same shape as the FILES_V1 false green.
 * A lane counts as usable when the SERVER ANSWERED something we asked it for: a
 * control pong on the live connection, with no close.
 */
export function legacyLaneUsable(probe) {
  return probe?.pong === true && probe?.closed === false
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------
function openSyncSocket({ cookie } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/sockets/sync`, {
      origin: ORIGIN,
      ...(cookie ? { headers: { cookie } } : {}),
    })
    const state = { ws, frames: [], binaries: [], close: undefined, upgradeStatus: undefined }
    ws.on('message', (data, isBinary) => {
      // FILES_V1 download chunks arrive as BINARY frames, never as JSON. The
      // old handler ran them through JSON.parse and filed the result as
      // `UNPARSEABLE`, which no predicate ever read -- so a download could not
      // be measured at all, only its absence.
      if (isBinary) {
        state.binaries.push(Buffer.from(data))
        return
      }
      try {
        state.frames.push(JSON.parse(data.toString()))
      } catch {
        state.frames.push({ type: 'UNPARSEABLE', raw: data.toString().slice(0, 200) })
      }
    })
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString() }
    })
    ws.on('unexpected-response', (_req, res) => {
      state.upgradeStatus = res.statusCode
      reject(new Error(`upgrade refused: HTTP ${res.statusCode}`))
    })
    ws.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('sync socket open timeout')), 15_000)
  })
}

function openLegacySocket(authToken) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/sockets?authToken=${encodeURIComponent(authToken)}`, { origin: ORIGIN })
    const state = { ws, messages: [], close: undefined, upgradeStatus: undefined }
    ws.on('message', (data) => state.messages.push(data.toString()))
    ws.on('close', (code, reason) => {
      state.close = { code, reason: reason.toString() }
    })
    ws.on('unexpected-response', (_req, res) => {
      state.upgradeStatus = res.statusCode
      reject(new Error(`legacy upgrade refused: HTTP ${res.statusCode}`))
    })
    ws.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    ws.on('open', () => resolve(state))
    setTimeout(() => reject(new Error('legacy socket open timeout')), 15_000)
  })
}

/**
 * Ask a live legacy socket for a control pong. A websocket server answers a
 * ping frame per RFC 6455, so a pong is evidence the connection is ALIVE and
 * the server is still servicing it — which "we have not seen a close event" is
 * not. A socket already closed, or one whose peer never answers, reports
 * `pong: false` and the lane reads broken.
 */
function legacyLaneProbe(state, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (state.close !== undefined || state.ws.readyState !== 1) {
      resolve({ pong: false, closed: true })
      return
    }
    let settled = false
    const done = (pong) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ pong, closed: state.close !== undefined })
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    state.ws.once('pong', () => done(true))
    try {
      state.ws.ping(randomBytes(8))
    } catch {
      done(false)
    }
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

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------
function selfTest() {
  console.log('capability-fallback self-test (no stack)')

  check(
    'the published digest vector reproduces',
    commandDigest(SYNC_COMMAND_DIGEST_TEST_VECTOR.body) === SYNC_COMMAND_DIGEST_TEST_VECTOR.digest,
  )
  control(
    'the digest probe',
    commandDigest({ ...SYNC_COMMAND_DIGEST_TEST_VECTOR.body, sync_token: 'tampered' }) !==
      SYNC_COMMAND_DIGEST_TEST_VECTOR.digest,
  )

  const full = censusFrom({ payload: { operations: ALL_OPERATIONS } })
  check(
    'a full operations list reads as all advertised',
    ALL_OPERATIONS.every((op) => full.advertised[op] === true),
  )
  const partial = censusFrom({ payload: { operations: ['API_RPC', 'STREAM_ASSISTANT'] } })
  check(
    'a partial list reads SYNC_ITEMS as withheld',
    partial.advertised.SYNC_ITEMS === false && partial.advertised.API_RPC === true,
  )
  const missing = censusFrom({ payload: {} })
  check(
    'a frame with no operations field reads as nothing advertised',
    ALL_OPERATIONS.every((op) => missing.advertised[op] === false),
  )
  control('the census probe', censusFrom({ payload: { operations: [] } }).advertised.SYNC_ITEMS === false)

  check('a 2: access token is a cookie session', isCookieSessionToken('2:abc'))
  check('a 1: access token is NOT a cookie session', !isCookieSessionToken('1:abc'))
  control('the session-type probe', !isCookieSessionToken('1:abc'))

  check('a COMMITTED status answer is committed', isCommitted({ type: 'STATUS', payload: { status: 'COMMITTED' } }))
  check('an ERROR frame is not committed', !isCommitted({ type: 'ERROR', payload: { code: 'X' } }))
  check('an ACCEPTED status answer is not committed', !isCommitted({ type: 'STATUS', payload: { status: 'ACCEPTED' } }))
  control('the committed probe', !isCommitted({ type: 'ERROR', payload: { status: 'COMMITTED' } }))

  check('a 200 RPC_RESPONSE is ok', isRpcOk({ type: 'RPC_RESPONSE', payload: { status: 200 } }))
  check('a 401 RPC_RESPONSE is not ok', !isRpcOk({ type: 'RPC_RESPONSE', payload: { status: 401 } }))
  control('the rpc probe', !isRpcOk({ type: 'RPC_RESPONSE', payload: { status: 500 } }))

  check(
    'OPERATION_UNAVAILABLE is recognised',
    isOperationUnavailable({ type: 'ERROR', payload: { code: 'OPERATION_UNAVAILABLE' } }),
  )
  control('the unavailable probe', !isOperationUnavailable({ type: 'ERROR', payload: { code: 'INVALID_DIGEST' } }))

  // laneCarried: a PRESENT success, or a named policy decision. The regression
  // this replaces is the last case: the exact frame the pre-efa5b985 build
  // answered, which the old `!isOperationUnavailable` predicate called `works`.
  check(
    'a success frame is carried',
    laneCarried({ type: 'INVITE_RECONCILE' }, ['INVITE_RECONCILE'], LANE_POLICY_CODES),
  )
  check(
    'a named policy refusal is carried',
    laneCarried(
      { type: 'ERROR', payload: { code: 'NOT_AUTHORIZED' } },
      ['COLLABORATION_AUTHORIZED'],
      LANE_POLICY_CODES,
    ),
  )
  check(
    'a backend failure is NOT carried',
    !laneCarried({ type: 'ERROR', payload: { code: 'BACKEND_ERROR' } }, ['RPC_RESPONSE'], LANE_POLICY_CODES),
  )
  check(
    'a stale session is NOT carried',
    !laneCarried({ type: 'ERROR', payload: { code: 'SESSION_STALE' } }, ['FILES_METADATA'], LANE_POLICY_CODES),
  )
  check('no answer at all is NOT carried', !laneCarried(undefined, ['FILES_METADATA'], LANE_POLICY_CODES))
  check(
    'REGRESSION (efa5b985): FILE_ACCESS_DENIED is NOT a working files lane',
    !laneCarried({ type: 'ERROR', payload: { code: 'FILE_ACCESS_DENIED' } }, ['FILES_METADATA'], LANE_POLICY_CODES),
  )
  control(
    'the lane-carried probe',
    !laneCarried({ type: 'ERROR', payload: { code: 'FILE_ACCESS_DENIED' } }, ['FILES_METADATA'], LANE_POLICY_CODES),
  )

  // The files binary wire format, against itself.
  const probeBytes = randomBytes(64)
  const probeHeader = {
    kind: 'UPLOAD_CHUNK',
    requestId: 'req-selftest',
    transferId: 'transfer-selftest',
    generation: 1,
    index: 0,
    offset: 0,
    declaredSize: probeBytes.byteLength,
    byteLength: probeBytes.byteLength,
    sha256: createHash('sha256').update(probeBytes).digest('hex'),
    final: true,
  }
  const encoded = encodeFileChunkFrame(probeHeader, probeBytes)
  const decoded = decodeFileChunkFrame(encoded)
  check(
    'a file chunk frame round-trips through the wire format',
    decoded !== undefined && Buffer.from(decoded.bytes).equals(probeBytes) && decoded.header.index === 0,
  )
  const tampered = Buffer.from(encoded)
  tampered[tampered.byteLength - 1] ^= 0xff
  control('the file chunk decoder', decodeFileChunkFrame(tampered) === undefined)

  // fileRoundTripSucceeded: EVERY stage must be present. Each negative below is
  // one stage knocked out of an otherwise complete trip.
  const digestA = createHash('sha256').update(Buffer.from('a')).digest('hex')
  const completeTrip = {
    metadataAnswered: true,
    uploadAccepted: true,
    chunksSent: 2,
    chunksAcked: 2,
    finishCompleted: true,
    uploadSha256: digestA,
    downloadAccepted: true,
    downloadCompleted: true,
    downloadSha256: digestA,
    bytesIdentical: true,
    expectedSha256: digestA,
  }
  check('a complete file round trip succeeds', fileRoundTripSucceeded(completeTrip))
  for (const [label, patch] of [
    ['the metadata answer', { metadataAnswered: false }],
    ['the upload OPEN', { uploadAccepted: false }],
    ['a chunk ACK', { chunksAcked: 1 }],
    ['every chunk', { chunksSent: 0, chunksAcked: 0 }],
    ['the FINISH', { finishCompleted: false }],
    ['the finish digest', { uploadSha256: 'f'.repeat(64) }],
    ['the download OPEN', { downloadAccepted: false }],
    ['the download completion', { downloadCompleted: false }],
    ['the download digest', { downloadSha256: 'f'.repeat(64) }],
    ['the byte comparison', { bytesIdentical: false }],
  ]) {
    check(`a file round trip missing ${label} FAILS`, !fileRoundTripSucceeded({ ...completeTrip, ...patch }))
  }
  check('an empty file round trip FAILS', !fileRoundTripSucceeded({}))
  check('an absent file round trip FAILS', !fileRoundTripSucceeded(undefined))
  // The exact shape the broken build produces: OPEN refused, nothing after it.
  check(
    'REGRESSION (efa5b985): a trip that died at FILES_UPLOAD_OPEN FAILS',
    !fileRoundTripSucceeded({
      metadataAnswered: true,
      uploadAccepted: false,
      chunksSent: 0,
      chunksAcked: 0,
      finishCompleted: false,
      downloadAccepted: false,
      downloadCompleted: false,
      bytesIdentical: false,
      expectedSha256: digestA,
      lastError: 'FILE_ACCESS_DENIED',
    }),
  )
  control('the file round-trip verdict', !fileRoundTripSucceeded({ ...completeTrip, bytesIdentical: false }))

  check('a 200 with a body is a reachable fallback', httpFallbackReachable({ status: 200 }))
  check('a 403 the handler produced is reachable', httpFallbackReachable({ status: 403 }))
  check('a 404 is NOT reachable', !httpFallbackReachable({ status: 404 }))
  check('a 405 is NOT reachable', !httpFallbackReachable({ status: 405 }))
  check('a 502 is NOT reachable (the old predicate called this one green)', !httpFallbackReachable({ status: 502 }))
  check('a 301 is NOT reachable', !httpFallbackReachable({ status: 301 }))
  check('a fetch that never answered is NOT reachable', !httpFallbackReachable({ status: 0 }))
  check(
    'the tri-state verdict ranks works over reachable',
    httpFallbackVerdict({ status: 200, json: { a: 1 } }) === 'works',
  )
  check('a 403 verdict is reachable', httpFallbackVerdict({ status: 403, json: { error: {} } }) === 'reachable')
  check('a 503 verdict is broken', httpFallbackVerdict({ status: 503, json: { error: {} } }) === 'broken')
  control('the reachability probe', !httpFallbackReachable({ status: 503 }))

  check('a legacy lane that answered a ping is usable', legacyLaneUsable({ pong: true, closed: false }))
  check('a legacy lane that never ponged is NOT usable', !legacyLaneUsable({ pong: false, closed: false }))
  check('a legacy lane that closed is NOT usable', !legacyLaneUsable({ pong: true, closed: true }))
  control('the legacy lane probe', !legacyLaneUsable({ pong: false, closed: false }))

  check('a 200 with a body is a successful fallback', httpFallbackSucceeded({ status: 200, json: { a: 1 } }))
  check('a 401 is not a successful fallback', !httpFallbackSucceeded({ status: 401, json: { error: {} } }))
  check(
    'a 200 with no parseable body is not a successful fallback',
    !httpFallbackSucceeded({ status: 200, json: undefined }),
  )
  control('the fallback verdict', !httpFallbackSucceeded({ status: 503, json: { error: {} } }))

  // -------------------------------------------------------------------------
  // AUTHORIZE_COLLABORATION. The regression cases below are the exact frames
  // the broken single-container image answered: the old row called them
  // `lane: "works"`.
  // -------------------------------------------------------------------------
  const probeRoom = '11111111-1111-4111-8111-111111111111'
  const probeRoomEpoch = 'a'.repeat(32)
  const probeSecurityEpoch = 'b'.repeat(43)
  const probeRevision = 1_700_000_000_000_000
  const probeLease = 'lease-probe'
  const probeCapability = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        purpose: 'collab-room',
        userUuid: '22222222-2222-4222-8222-222222222222',
        room: probeRoom,
        collaborationProtocolVersion: 3,
        roomEpoch: probeRoomEpoch,
        collaborationSecurityEpoch: probeSecurityEpoch,
        serverUpdatedAtTimestamp: probeRevision,
        leaseRequestId: probeLease,
      }),
      'utf8',
    ).toString('base64url'),
    'not-a-real-signature',
  ].join('.')
  const discoveryFrame = {
    type: 'COLLABORATION_AUTHORIZED',
    payload: {
      epochDiscovery: true,
      room: probeRoom,
      serverUpdatedAtTimestamp: probeRevision,
      collaborationProtocolVersion: 3,
      roomEpoch: probeRoomEpoch,
      collaborationSecurityEpoch: probeSecurityEpoch,
      epochDiscoveryChallenge: 'c'.repeat(64),
      epochDiscoveryRequestId: 'req-probe',
      challengeExpiresAt: Date.now() + 10_000,
    },
  }
  const grantFrame = {
    type: 'COLLABORATION_AUTHORIZED',
    payload: {
      capability: probeCapability,
      room: probeRoom,
      expiresIn: 300,
      serverUpdatedAtTimestamp: probeRevision,
      collaborationProtocolVersion: 3,
      roomEpoch: probeRoomEpoch,
      collaborationSecurityEpoch: probeSecurityEpoch,
      leaseRequestId: probeLease,
    },
  }
  const grantBindings = {
    room: probeRoom,
    roomEpoch: probeRoomEpoch,
    collaborationSecurityEpoch: probeSecurityEpoch,
    lease: probeLease,
  }

  check('a real epoch discovery succeeds', collaborationDiscoverySucceeded(discoveryFrame, { room: probeRoom }))
  check(
    'a discovery for ANOTHER room FAILS',
    !collaborationDiscoverySucceeded(discoveryFrame, { room: '33333333-3333-4333-8333-333333333333' }),
  )
  for (const [label, patch] of [
    ['the epochDiscovery flag', { epochDiscovery: false }],
    ['the room epoch', { roomEpoch: 'short' }],
    ['the security epoch', { collaborationSecurityEpoch: undefined }],
    ['the canonical revision', { serverUpdatedAtTimestamp: 0 }],
    ['the one-use challenge', { epochDiscoveryChallenge: undefined }],
    ['the challenge request id', { epochDiscoveryRequestId: '' }],
    ['the protocol version', { collaborationProtocolVersion: 2 }],
  ]) {
    check(
      `a discovery missing ${label} FAILS`,
      !collaborationDiscoverySucceeded(
        { ...discoveryFrame, payload: { ...discoveryFrame.payload, ...patch } },
        { room: probeRoom },
      ),
    )
  }
  check(
    'REGRESSION (6e18e3a5): ERROR NOT_AUTHORIZED is NOT a successful discovery',
    !collaborationDiscoverySucceeded({ type: 'ERROR', payload: { code: 'NOT_AUTHORIZED' } }, { room: probeRoom }),
  )
  check('no answer at all is NOT a successful discovery', !collaborationDiscoverySucceeded(undefined))
  control(
    'the discovery probe',
    !collaborationDiscoverySucceeded({ type: 'ERROR', payload: { code: 'NOT_AUTHORIZED' } }, { room: probeRoom }),
  )

  check('a real bound grant succeeds', collaborationGrantSucceeded(grantFrame, grantBindings))
  check(
    'REGRESSION (6e18e3a5): a well-formed { authorized: false } is NOT a grant',
    !collaborationGrantSucceeded({ type: 'COLLABORATION_AUTHORIZED', payload: { authorized: false } }, grantBindings),
  )
  check(
    'REGRESSION (6e18e3a5): ERROR NOT_AUTHORIZED is NOT a grant (the OLD row called this `works`)',
    !collaborationGrantSucceeded({ type: 'ERROR', payload: { code: 'NOT_AUTHORIZED' } }, grantBindings),
  )
  check(
    'REGRESSION (0a6897b3): BACKEND_ERROR is NOT a grant',
    !collaborationGrantSucceeded({ type: 'ERROR', payload: { code: 'BACKEND_ERROR' } }, grantBindings),
  )
  for (const [label, patch] of [
    ['the capability', { capability: undefined }],
    ['a non-empty capability', { capability: '' }],
    ['the ttl', { expiresIn: 0 }],
    ['the canonical revision', { serverUpdatedAtTimestamp: 0 }],
    ['the protocol version', { collaborationProtocolVersion: 2 }],
  ]) {
    check(
      `a grant missing ${label} FAILS`,
      !collaborationGrantSucceeded({ ...grantFrame, payload: { ...grantFrame.payload, ...patch } }, grantBindings),
    )
  }
  check(
    'a grant for ANOTHER room FAILS',
    !collaborationGrantSucceeded(grantFrame, { ...grantBindings, room: '44444444-4444-4444-8444-444444444444' }),
  )
  check(
    'a grant for ANOTHER epoch FAILS',
    !collaborationGrantSucceeded(grantFrame, { ...grantBindings, roomEpoch: 'd'.repeat(32) }),
  )
  check(
    'a grant bound to ANOTHER lease FAILS',
    !collaborationGrantSucceeded(grantFrame, { ...grantBindings, lease: 'lease-other' }),
  )
  check(
    'a grant whose CAPABILITY names another room FAILS (the binding is read, not assumed)',
    !collaborationGrantSucceeded(
      {
        ...grantFrame,
        payload: {
          ...grantFrame.payload,
          capability: probeCapability.replace(
            probeCapability.split('.')[1],
            Buffer.from(
              JSON.stringify({
                purpose: 'collab-room',
                userUuid: '22222222-2222-4222-8222-222222222222',
                room: '55555555-5555-4555-8555-555555555555',
                collaborationProtocolVersion: 3,
                roomEpoch: probeRoomEpoch,
                collaborationSecurityEpoch: probeSecurityEpoch,
                serverUpdatedAtTimestamp: probeRevision,
                leaseRequestId: probeLease,
              }),
              'utf8',
            ).toString('base64url'),
          ),
        },
      },
      grantBindings,
    ),
  )
  check(
    'a grant whose capability is not a JWT FAILS',
    !collaborationGrantSucceeded(
      { ...grantFrame, payload: { ...grantFrame.payload, capability: 'not-a-jwt' } },
      grantBindings,
    ),
  )
  control('the grant probe', !collaborationGrantSucceeded({ type: 'ERROR', payload: { code: 'NOT_AUTHORIZED' } }))

  check('a decoded JWT yields its claims', decodeJwtClaims(probeCapability)?.purpose === 'collab-room')
  check('a non-JWT decodes to undefined', decodeJwtClaims('a.b') === undefined)
  check('a JWT with unparseable claims decodes to undefined', decodeJwtClaims('a.!!!.c') === undefined)
  control('the jwt decoder', decodeJwtClaims(undefined) === undefined)

  check(
    'ERROR NOT_AUTHORIZED is a DECIDED refusal',
    collaborationRefusalDecided({ type: 'ERROR', payload: { code: 'NOT_AUTHORIZED' } }),
  )
  check(
    'a { authorized: false } frame is a DECIDED refusal',
    collaborationRefusalDecided({ type: 'COLLABORATION_AUTHORIZED', payload: { authorized: false } }),
  )
  check(
    'BACKEND_ERROR is NOT a refusal (a broken lane is not a decision)',
    !collaborationRefusalDecided({ type: 'ERROR', payload: { code: 'BACKEND_ERROR' } }),
  )
  check(
    'BACKEND_TIMEOUT is NOT a refusal',
    !collaborationRefusalDecided({ type: 'ERROR', payload: { code: 'BACKEND_TIMEOUT' } }),
  )
  check(
    'SESSION_STALE is NOT a refusal',
    !collaborationRefusalDecided({ type: 'ERROR', payload: { code: 'SESSION_STALE' } }),
  )
  check(
    'OPERATION_UNAVAILABLE is NOT a refusal',
    !collaborationRefusalDecided({ type: 'ERROR', payload: { code: 'OPERATION_UNAVAILABLE' } }),
  )
  check('silence is NOT a refusal', !collaborationRefusalDecided(undefined))
  check('a real GRANT is NOT a refusal', !collaborationRefusalDecided(grantFrame))
  control('the refusal probe', !collaborationRefusalDecided({ type: 'ERROR', payload: { code: 'BACKEND_ERROR' } }))

  check(
    'the HTTP discovery leg succeeds on a 200 carrying an epoch pair',
    collaborationHttpDiscoverySucceeded(
      { status: 200, json: { authorized: true, ...discoveryFrame.payload } },
      { room: probeRoom },
    ),
  )
  check(
    'the HTTP discovery leg FAILS on a 403',
    !collaborationHttpDiscoverySucceeded({ status: 403, json: { error: { tag: 'collaboration-not-authorized' } } }),
  )
  check(
    'the HTTP discovery leg FAILS on a 200 that only says authorized: false',
    !collaborationHttpDiscoverySucceeded({ status: 200, json: { authorized: false } }),
  )
  check(
    'the HTTP discovery leg succeeds on the body the controller actually sends (no `authorized` key)',
    collaborationHttpDiscoverySucceeded({ status: 200, json: discoveryFrame.payload }, { room: probeRoom }),
  )
  check(
    'the HTTP discovery leg FAILS on a 200 with no epoch pair',
    !collaborationHttpDiscoverySucceeded({ status: 200, json: { epochDiscovery: true, room: probeRoom } }),
  )
  check(
    'the HTTP grant leg succeeds on a 200 carrying a bound capability',
    collaborationHttpGrantSucceeded({ status: 200, json: { authorized: true, ...grantFrame.payload } }, grantBindings),
  )
  check(
    'REGRESSION: the HTTP grant leg FAILS on the 403 the broken build returned',
    !collaborationHttpGrantSucceeded(
      { status: 403, json: { error: { tag: 'collaboration-not-authorized' } } },
      grantBindings,
    ),
  )
  check(
    'the HTTP refusal control recognises the named 403',
    collaborationHttpRefusalDecided({ status: 403, json: { error: { tag: 'collaboration-not-authorized' } } }),
  )
  check(
    'the HTTP refusal control REJECTS a 502 (a dead route is not a refusal)',
    !collaborationHttpRefusalDecided({ status: 502, json: {} }),
  )
  check(
    'the HTTP refusal control REJECTS a 403 with another tag',
    !collaborationHttpRefusalDecided({ status: 403, json: { error: { tag: 'something-else' } } }),
  )
  control('the http grant probe', !collaborationHttpGrantSucceeded({ status: 403, json: {} }, grantBindings))

  const completeCollabTrip = { ownedNoteExists: true, discovered: true, granted: true, absentNoteRefused: true }
  check('a complete collaboration trip succeeds', collaborationLaneSucceeded(completeCollabTrip))
  for (const [label, patch] of [
    ['the owned note', { ownedNoteExists: false }],
    ['the discovery', { discovered: false }],
    ['the grant', { granted: false }],
    ['the refusal control', { absentNoteRefused: false }],
  ]) {
    check(
      `a collaboration trip missing ${label} FAILS`,
      !collaborationLaneSucceeded({ ...completeCollabTrip, ...patch }),
    )
  }
  check('an empty collaboration trip FAILS', !collaborationLaneSucceeded({}))
  // The EXACT shape the broken single-container image produced: the lane
  // answered, the refusal control refused, and nothing was ever granted.
  check(
    'REGRESSION (6e18e3a5): a trip where every authorization was denied FAILS',
    !collaborationLaneSucceeded({
      ownedNoteExists: true,
      discovered: false,
      granted: false,
      absentNoteRefused: true,
      discoveryDetail: { type: 'ERROR', code: 'NOT_AUTHORIZED' },
    }),
  )
  // And the other direction: an authorizer that grants EVERYTHING, including a
  // note that does not exist, is not a working lane either.
  check(
    'an always-grant authorizer FAILS (the refusal control is load-bearing)',
    !collaborationLaneSucceeded({
      ownedNoteExists: true,
      discovered: true,
      granted: true,
      absentNoteRefused: false,
    }),
  )
  control('the collaboration lane verdict', !collaborationLaneSucceeded({ ...completeCollabTrip, granted: false }))

  console.log(`\nself-test: ${failures} failures, ${controlFailures} control failures`)
  process.exit(failures === 0 && controlFailures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------
async function main() {
  const health = await fetch(`${BASE}${HEALTH_PATH}`)
    .then((r) => r.status)
    .catch(() => 0)
  if (health !== 200) {
    if (REQUIRE_GATEWAY) {
      console.error(`REQUIRED: stack not reachable on ${BASE}${HEALTH_PATH} (status ${health})`)
      process.exit(1)
    }
    console.log('SKIP: stack not reachable on', BASE)
    process.exit(0)
  }

  // --- account + session type -------------------------------------------
  const account = await register()
  const token = account.session.access_token
  const cookieSession = isCookieSessionToken(token)
  console.log(
    `\n[session] type=${cookieSession ? 'cookie(2:)' : 'legacy(1:)'} setCookieHeaders=${account.setCookieCount} cookieHeaderBytes=${account.cookie.length}`,
  )
  check('the stack issued a session this script can classify', typeof token === 'string' && token.length > 2, {
    prefix: String(token).slice(0, 2),
  })
  if (CONTROL && cookieSession) {
    // The cookie half must be LOAD-BEARING in this run. A cookie session's
    // `2:` access token is only half the credential; the other half is in the
    // HttpOnly cookie. If the bearer alone were accepted, every "measured on a
    // cookie session" claim below would actually have been measured on the
    // bearer and would prove nothing about the cookie path.
    const bearerOnly = await raw('POST', '/v1/sockets/sync/ticket', { token, body: { deviceId: DEVICE_ID + '-ctrl' } })
    control('the cookie half is load-bearing (bearer alone must not mint a ticket)', bearerOnly.status !== 200, {
      status: bearerOnly.status,
      body: bearerOnly.text.slice(0, 160),
    })
    const cookieOnly = await raw('POST', '/v1/sockets/sync/ticket', {
      cookie: account.cookie || undefined,
      body: { deviceId: DEVICE_ID + '-ctrl2' },
    })
    note(`cookie-only ticket mint (no Authorization header) status=${cookieOnly.status}`)
  }
  if (REGISTER_API === '20240226' && !cookieSession) {
    // Registered at the cookie api and got a `1:` token back: the stack has
    // `E2E_TESTING=true` (auth binds `forceLegacySessions` to it) or an
    // equivalent override. EVERY row below is then measured on a header
    // session, which is the one configuration in which a cookie-session defect
    // -- the FILES_V1 defect efa5b985 fixed, among others -- cannot occur.
    note(
      'this run registered at api 20240226 and still got a LEGACY (1:) session, so the stack forces legacy sessions (E2E_TESTING=true): every row below says nothing about cookie sessions',
    )
  }
  if (EXPECT_SESSION) {
    // Asserted, never assumed. Both kinds return a `session` object and set
    // both HttpOnly cookies at api 20240226, so the version prefix is the only
    // discriminator — a stack that quietly reverted to legacy header sessions
    // must fail here rather than pass and prove nothing about the cookie half.
    check(`the session is ${EXPECT_SESSION} as required`, (EXPECT_SESSION === 'cookie') === cookieSession, {
      expected: EXPECT_SESSION,
      got: cookieSession ? 'cookie' : 'legacy',
      prefix: String(token).slice(0, 2),
      registerApi: REGISTER_API,
    })
  }

  // --- capability census -------------------------------------------------
  // Every section gets a LIVE authenticated socket. A frame the gateway judges
  // malformed closes the socket (1008/1009), and a probe that then reads
  // "no answer" on the NEXT capability would blame the wrong row — so the
  // socket is re-established per section when the previous one closed, with a
  // fresh ticket (tickets are single-use).
  let socket
  let sequence = 1
  let census = { seen: [], advertised: Object.fromEntries(ALL_OPERATIONS.map((o) => [o, false])) }
  let censusTaken = false
  let ticketAvailable = false
  let reopens = 0

  async function ensureSocket() {
    if (socket && socket.close === undefined && socket.ws.readyState === 1) return socket
    if (socket !== undefined) {
      reopens += 1
      note(`re-establishing the sync socket (previous close: ${JSON.stringify(socket.close)})`)
    }
    socket = undefined
    const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
      token,
      cookie: account.cookie || undefined,
      body: { deviceId: DEVICE_ID },
    })
    const issued = ticket.status === 200 && typeof ticket.json?.ticket === 'string'
    if (!censusTaken) {
      ticketAvailable = issued
      if (EXPECT_NO_TICKET) {
        // A deployment with the lane deliberately off must refuse with the
        // NAMED code, not with a 500 and not by handing out a ticket for a
        // lane that will then close. Asserting the code (not merely "not 200")
        // is what keeps this row from passing on an unrelated failure.
        check(
          'the sync ticket endpoint refuses with 503 SYNC_DISABLED as expected',
          ticket.status === 503 && ticket.json?.error?.code === 'SYNC_DISABLED',
          {
            status: ticket.status,
            body: ticket.text.slice(0, 200),
          },
        )
      } else {
        check('the sync ticket endpoint issues a ticket', issued, {
          status: ticket.status,
          body: ticket.text.slice(0, 200),
        })
      }
    }
    if (!issued) return undefined
    const opened = await openSyncSocket({ cookie: account.cookie || undefined }).catch((error) => {
      if (!censusTaken) check('the sync socket upgrades', false, { error: error.message })
      return undefined
    })
    if (!opened) return undefined
    opened.ws.send(
      JSON.stringify(syncFrame('AUTH', { ticket: ticket.json.ticket, deviceId: DEVICE_ID }, { sequence: 0 })),
    )
    const authenticated = await waitForFrame(opened, (f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR', 20_000)
    if (authenticated?.type !== 'AUTHENTICATED') {
      if (!censusTaken)
        check('the socket authenticates', false, { got: authenticated?.type ?? 'none', close: opened.close })
      return undefined
    }
    const taken = censusFrom(authenticated)
    if (!censusTaken) {
      check('the socket authenticates', true)
      census = taken
      censusTaken = true
    } else {
      // The census must not drift between sockets on one stack; if it does, the
      // matrix rows were measured against different configurations.
      check(
        'the census is stable across socket re-establishment',
        JSON.stringify([...taken.seen].sort()) === JSON.stringify([...census.seen].sort()),
        {
          first: [...census.seen].sort(),
          now: [...taken.seen].sort(),
        },
      )
    }
    socket = opened
    sequence = 1
    return socket
  }

  await ensureSocket()
  if (!ticketAvailable) {
    note('no ticket: the whole sync lane is withheld, so every row is measured on its HTTP fallback only')
  }
  console.log(`\n[census] advertised = [${census.seen.join(', ')}]`)
  for (const operation of ALL_OPERATIONS) row(operation, { advertised: census.advertised[operation] })

  if (process.env.EXPECT_OPERATIONS !== undefined) {
    const expected = process.env.EXPECT_OPERATIONS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort()
    check(
      'the census matches EXPECT_OPERATIONS',
      JSON.stringify([...census.seen].sort()) === JSON.stringify(expected),
      {
        expected,
        got: [...census.seen].sort(),
      },
    )
  }
  if (process.env.EXPECT_WITHHELD !== undefined) {
    const withheld = process.env.EXPECT_WITHHELD.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const operation of withheld) {
      check(`${operation} is withheld as expected`, census.advertised[operation] === false, { seen: census.seen })
    }
  }
  if (REQUIRE_SYNC_ITEMS) {
    check('SYNC_ITEMS is negotiated (REQUIRE_SYNC_ITEMS=1)', census.advertised.SYNC_ITEMS === true, {
      seen: census.seen,
    })
  }

  // =====================================================================
  // SYNC_ITEMS
  // =====================================================================
  console.log('\n[SYNC_ITEMS]')
  const laneNote = makeNote()
  if (census.advertised.SYNC_ITEMS && (await ensureSocket())) {
    const body = { api: API, items: [laneNote], compute_integrity: false }
    const digest = commandDigest(body)
    const commandId = `cmd-${randomUUID()}`
    const requestId = `req-${randomUUID()}`
    socket.ws.send(
      JSON.stringify(
        syncFrame('COMMAND', { command: 'SYNC_ITEMS', body }, { sequence: sequence++, requestId, commandId, digest }),
      ),
    )
    const answer = await waitForFrame(
      socket,
      (f) => f.commandId === commandId && (f.type === 'ERROR' || f.payload?.status === 'COMMITTED'),
      40_000,
    )
    const laneOk = check('a SYNC_ITEMS save commits over the socket', isCommitted(answer), {
      type: answer?.type,
      status: answer?.payload?.status,
      code: answer?.payload?.code,
    })
    // Durability, not just an answer frame: pull it back over HTTP.
    const pull = await raw('POST', '/v1/items', {
      token,
      cookie: account.cookie || undefined,
      body: { api: API, limit: 200 },
    })
    const persisted = (pull.json?.retrieved_items ?? []).some((item) => item.uuid === laneNote.uuid)
    check('the socket-saved note is durably persisted (read back over HTTP)', persisted, { status: pull.status })
    row('SYNC_ITEMS', {
      lane: laneOk && persisted ? 'works' : 'broken',
      laneDetail: { answer: answer?.type, status: answer?.payload?.status },
    })
  } else {
    row('SYNC_ITEMS', { lane: census.advertised.SYNC_ITEMS ? 'untested' : 'withheld' })
    note('SYNC_ITEMS not negotiated: the lane leg is skipped and only the HTTP fallback is measured')
  }

  // Fallback: the documented claim is that note sync "transparently falls back
  // to HTTP". Measured on the same account, every run.
  const fallbackNote = makeNote()
  const httpSave = await raw('POST', '/v1/items', {
    token,
    cookie: account.cookie || undefined,
    body: { api: API, items: [fallbackNote], compute_integrity: false },
  })
  const savedOverHttp = (httpSave.json?.saved_items ?? []).some((item) => item.uuid === fallbackNote.uuid)
  const httpPull = await raw('POST', '/v1/items', {
    token,
    cookie: account.cookie || undefined,
    body: { api: API, limit: 200 },
  })
  const pulledOverHttp = (httpPull.json?.retrieved_items ?? []).some((item) => item.uuid === fallbackNote.uuid)
  const syncFallbackOk = check(
    'FALLBACK: a note saves and reads back over plain HTTP /v1/items',
    savedOverHttp && pulledOverHttp,
    { saveStatus: httpSave.status, pullStatus: httpPull.status, saved: savedOverHttp, pulled: pulledOverHttp },
  )
  row('SYNC_ITEMS', { fallback: syncFallbackOk ? 'works' : 'broken', fallbackPath: 'POST /v1/items' })

  if (CONTROL) {
    const brokenSave = await raw('POST', '/v1/items', {
      token: 'not-a-real-token-' + randomBytes(8).toString('hex'),
      body: { api: API, items: [makeNote()], compute_integrity: false },
    })
    control(
      'the SYNC_ITEMS HTTP fallback probe',
      !httpFallbackSucceeded(brokenSave) || (brokenSave.json?.saved_items ?? []).length === 0,
      {
        status: brokenSave.status,
      },
    )
  }

  // =====================================================================
  // API_RPC  (and STREAM_ASSISTANT, which rides the same frame)
  // =====================================================================
  console.log('\n[API_RPC]')
  if (census.advertised.API_RPC && (await ensureSocket())) {
    const requestId = `req-${randomUUID()}`
    socket.ws.send(
      JSON.stringify(
        syncFrame(
          'RPC_REQUEST',
          { method: 'GET', path: RPC_PATH, deadlineMs: 30_000, initialCreditBytes: 262_144, stream: false },
          { sequence: sequence++, requestId },
        ),
      ),
    )
    const answer = await waitForFrame(
      socket,
      (f) => f.requestId === requestId && (f.type === 'RPC_RESPONSE' || f.type === 'ERROR'),
      30_000,
    )
    const ok = check(`an API_RPC GET ${RPC_PATH} answers 200 over the socket`, isRpcOk(answer), {
      type: answer?.type,
      status: answer?.payload?.status,
      code: answer?.payload?.code,
    })
    row('API_RPC', {
      lane: ok ? 'works' : 'broken',
      laneDetail: { type: answer?.type, status: answer?.payload?.status },
    })
    if (!ok && answer?.payload?.status === 401) {
      note(
        'DEFECT CANDIDATE: API_RPC answered 401 — the socket identity did not carry the session credential this session type needs',
      )
    }
  } else {
    row('API_RPC', { lane: census.advertised.API_RPC ? 'untested' : 'withheld' })
  }
  const rpcFallback = await raw('GET', RPC_PATH, { token, cookie: account.cookie || undefined })
  const rpcFallbackOk = check(`FALLBACK: GET ${RPC_PATH} answers over plain HTTP`, httpFallbackSucceeded(rpcFallback), {
    status: rpcFallback.status,
  })
  row('API_RPC', { fallback: rpcFallbackOk ? 'works' : 'broken', fallbackPath: `GET ${RPC_PATH}` })
  if (CONTROL) {
    const broken = await raw('GET', RPC_PATH, { token: 'bogus-' + randomBytes(8).toString('hex') })
    control('the API_RPC HTTP fallback probe', !httpFallbackSucceeded(broken), { status: broken.status })
  }

  // =====================================================================
  // STREAM_ASSISTANT
  // =====================================================================
  console.log('\n[STREAM_ASSISTANT]')
  const ASSISTANT_PATH = '/v1/assistant/stream'
  let assistantLane
  if (census.advertised.STREAM_ASSISTANT && census.advertised.API_RPC && (await ensureSocket())) {
    const requestId = `req-${randomUUID()}`
    socket.ws.send(
      JSON.stringify(
        syncFrame(
          'RPC_REQUEST',
          {
            method: 'POST',
            path: ASSISTANT_PATH,
            body: { messages: [{ role: 'user', content: 'ping' }] },
            deadlineMs: 20_000,
            initialCreditBytes: 262_144,
            stream: true,
            idempotencyKey: randomUUID(),
          },
          { sequence: sequence++, requestId },
        ),
      ),
    )
    const answer = await waitForFrame(
      socket,
      (f) =>
        f.requestId === requestId && ['RPC_ACCEPTED', 'RPC_RESPONSE', 'RPC_CHUNK', 'RPC_END', 'ERROR'].includes(f.type),
      25_000,
    )
    assistantLane = answer
    // A stack with no assistant provider configured still ACCEPTS the RPC and
    // reports the provider error in-band on the stream, so the bar here is an
    // `RPC_*` frame -- a type the gateway emits only once it has handed the
    // call to the backend -- or a named policy refusal. An ERROR frame of any
    // other code (BACKEND_ERROR, SESSION_STALE, OPERATION_UNAVAILABLE) means
    // the lane did not carry it.
    const carried = check(
      'a STREAM_ASSISTANT RPC is CARRIED by the lane (an RPC_* answer, or a named policy refusal)',
      laneCarried(answer, ['RPC_ACCEPTED', 'RPC_RESPONSE', 'RPC_CHUNK', 'RPC_END'], LANE_POLICY_CODES),
      { type: answer?.type, status: answer?.payload?.status, code: answer?.payload?.code },
    )
    row('STREAM_ASSISTANT', {
      lane: carried ? 'works' : 'broken',
      laneDetail: { type: answer?.type, status: answer?.payload?.status, code: answer?.payload?.code },
    })
  } else {
    row('STREAM_ASSISTANT', { lane: census.advertised.STREAM_ASSISTANT ? 'untested' : 'withheld' })
  }
  const assistantFallback = await raw('POST', ASSISTANT_PATH, {
    token,
    cookie: account.cookie || undefined,
    body: { messages: [{ role: 'user', content: 'ping' }] },
  })
  // The fallback bar here is REACHABILITY, not a 200: an unconfigured provider
  // is a deployment choice, while a 404 would mean the route does not exist and
  // the socket is the only way in. Reachability is a CLOSED set of statuses
  // (see httpFallbackReachable): the old `!== 404 && !== 405` called a 502 a
  // working fallback.
  const assistantVerdict = httpFallbackVerdict(assistantFallback)
  check(
    `FALLBACK: POST ${ASSISTANT_PATH} ANSWERS over plain HTTP (2xx, or a 4xx the handler produced)`,
    assistantVerdict !== 'broken',
    { status: assistantFallback.status, verdict: assistantVerdict, body: assistantFallback.text.slice(0, 160) },
  )
  row('STREAM_ASSISTANT', {
    fallback: assistantVerdict,
    fallbackPath: `POST ${ASSISTANT_PATH}`,
    fallbackStatus: assistantFallback.status,
  })
  if (CONTROL) {
    const broken = await raw('POST', '/v1/assistant/stream-does-not-exist', { token, body: {} })
    control('the assistant reachability probe', httpFallbackVerdict(broken) === 'broken', {
      status: broken.status,
    })
  }

  // =====================================================================
  // AUTHORIZE_COLLABORATION
  // =====================================================================
  console.log('\n[AUTHORIZE_COLLABORATION]')
  // A note THIS ACCOUNT OWNS, saved over plain HTTP so the authorization legs
  // do not inherit the socket lane's verdict. `AuthorizeCollaborationAccess`
  // authorizes the owner of a personal note, so a grant here is the minimum
  // the capability has to be able to produce -- and it is exactly what the
  // single-container defect refused. The old row probed `randomUUID()`, for
  // which a refusal is CORRECT, so it could never observe the difference.
  const collabNote = makeNote(256)
  const collabNoteSave = await raw('POST', '/v1/items', {
    token,
    cookie: account.cookie || undefined,
    body: { api: API, items: [collabNote], compute_integrity: false },
  })
  const collabNoteUuid = collabNote.uuid
  const ownedNoteExists = check(
    'a note THIS ACCOUNT OWNS exists to authorize against (the row cannot be measured without one)',
    (collabNoteSave.json?.saved_items ?? []).some((item) => item.uuid === collabNoteUuid),
    { status: collabNoteSave.status, body: collabNoteSave.text.slice(0, 160) },
  )
  // The refusal control, on every run and in both transports: a note that was
  // never created must be DECIDED against. Without it a grant row would also
  // be green on an authorizer that says yes to everything.
  const absentNoteUuid = randomUUID()
  const collabLease = `lease-${randomUUID()}`

  /** One COLLABORATION_AUTHORIZE round trip on the live socket. */
  const authorizeOverSocket = async (payload) => {
    const requestId = `req-${randomUUID()}`
    socket.ws.send(JSON.stringify(syncFrame('COLLABORATION_AUTHORIZE', payload, { sequence: sequence++, requestId })))
    return waitForFrame(
      socket,
      (f) => f.requestId === requestId && (f.type === 'COLLABORATION_AUTHORIZED' || f.type === 'ERROR'),
      25_000,
    )
  }

  const collabTrip = { ownedNoteExists, discovered: false, granted: false, absentNoteRefused: false }
  if (census.advertised.AUTHORIZE_COLLABORATION && (await ensureSocket())) {
    // Leg 1 -- DISCOVERY on the owned note. Answers the room's epoch pair plus
    // a one-use challenge; the gateway stores exactly one per connection.
    const discovery = await authorizeOverSocket({
      noteUuid: collabNoteUuid,
      collaborationProtocolVersion: 3,
      epochDiscovery: true,
    })
    collabTrip.discovered = check(
      'LANE: epoch DISCOVERY for a note this account owns answers an epoch pair for THIS room (a present success, not a refusal)',
      collaborationDiscoverySucceeded(discovery, { room: collabNoteUuid }),
      {
        type: discovery?.type,
        code: discovery?.payload?.code,
        room: discovery?.payload?.room,
        hasChallenge: typeof discovery?.payload?.epochDiscoveryChallenge === 'string',
      },
    )
    collabTrip.discoveryDetail = { type: discovery?.type, code: discovery?.payload?.code }

    // Leg 2 -- the GRANT that consumes that challenge. This is the leg a client
    // cannot collaborate without, and the leg both defects killed.
    if (collabTrip.discovered) {
      const grant = await authorizeOverSocket({
        noteUuid: collabNoteUuid,
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: discovery.payload.roomEpoch,
        epochDiscoveryChallenge: discovery.payload.epochDiscoveryChallenge,
        epochDiscoveryRequestId: discovery.payload.epochDiscoveryRequestId,
        leaseRequestId: collabLease,
      })
      collabTrip.granted = check(
        'LANE: the GRANT leg issues a CAPABILITY bound to this room, this epoch pair and this lease',
        collaborationGrantSucceeded(grant, {
          room: collabNoteUuid,
          roomEpoch: discovery.payload.roomEpoch,
          collaborationSecurityEpoch: discovery.payload.collaborationSecurityEpoch,
          lease: collabLease,
        }),
        {
          type: grant?.type,
          code: grant?.payload?.code,
          authorized: grant?.payload?.authorized,
          hasCapability: typeof grant?.payload?.capability === 'string',
          room: grant?.payload?.room,
        },
      )
      collabTrip.grantDetail = { type: grant?.type, code: grant?.payload?.code }
    } else {
      check('LANE: the GRANT leg issues a CAPABILITY (not reached: discovery did not succeed)', false, {
        stoppedAt: 'discovery',
      })
    }

    // The refusal control, on the SAME socket and the same account.
    const absent = await authorizeOverSocket({
      noteUuid: absentNoteUuid,
      collaborationProtocolVersion: 3,
      epochDiscovery: true,
    })
    collabTrip.absentNoteRefused = check(
      'LANE: a note that was never created is REFUSED, and the refusal is DECIDED (so the row is not always-green)',
      collaborationRefusalDecided(absent),
      { type: absent?.type, code: absent?.payload?.code },
    )
    row('AUTHORIZE_COLLABORATION', {
      lane: collaborationLaneSucceeded(collabTrip) ? 'works' : 'broken',
      laneDetail: collabTrip,
    })
  } else {
    row('AUTHORIZE_COLLABORATION', { lane: census.advertised.AUTHORIZE_COLLABORATION ? 'untested' : 'withheld' })
  }

  // FALLBACK: the documented HTTP path, same account, same run. The bar is a
  // PRESENT grant, not reachability: a 403 is the right answer only for the
  // note nobody created, and that case is measured separately below. The HTTP
  // discovery leg issues NO challenge (only the socket lane does), so its
  // grant leg carries the epoch alone.
  const collabHttpDiscovery = await raw('POST', '/v1/collaboration/authorize', {
    token,
    cookie: account.cookie || undefined,
    headers: { 'idempotency-key': randomUUID() },
    body: { noteUuid: collabNoteUuid, collaborationProtocolVersion: 3, epochDiscovery: true },
  })
  const httpDiscovered = check(
    'FALLBACK: POST /v1/collaboration/authorize DISCOVERS an epoch pair for a note this account owns',
    collaborationHttpDiscoverySucceeded(collabHttpDiscovery, { room: collabNoteUuid }),
    { status: collabHttpDiscovery.status, body: collabHttpDiscovery.text.slice(0, 200) },
  )
  let collabHttpGrant
  let httpGranted = false
  if (httpDiscovered) {
    collabHttpGrant = await raw('POST', '/v1/collaboration/authorize', {
      token,
      cookie: account.cookie || undefined,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        noteUuid: collabNoteUuid,
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: collabHttpDiscovery.json.roomEpoch,
        leaseRequestId: collabLease,
      },
    })
    httpGranted = check(
      'FALLBACK: the HTTP grant leg issues a CAPABILITY bound to this room, this epoch pair and this lease',
      collaborationHttpGrantSucceeded(collabHttpGrant, {
        room: collabNoteUuid,
        roomEpoch: collabHttpDiscovery.json.roomEpoch,
        collaborationSecurityEpoch: collabHttpDiscovery.json.collaborationSecurityEpoch,
        lease: collabLease,
      }),
      { status: collabHttpGrant.status, body: collabHttpGrant.text.slice(0, 200) },
    )
  } else {
    check('FALLBACK: the HTTP grant leg issues a CAPABILITY (not reached: discovery did not succeed)', false, {
      stoppedAt: 'discovery',
    })
  }
  const collabAbsentHttp = await raw('POST', '/v1/collaboration/authorize', {
    token,
    cookie: account.cookie || undefined,
    headers: { 'idempotency-key': randomUUID() },
    body: { noteUuid: absentNoteUuid, collaborationProtocolVersion: 3, epochDiscovery: true },
  })
  const httpAbsentRefused = check(
    'FALLBACK: a note that was never created is refused 403 collaboration-not-authorized',
    collaborationHttpRefusalDecided(collabAbsentHttp),
    { status: collabAbsentHttp.status, body: collabAbsentHttp.text.slice(0, 160) },
  )
  row('AUTHORIZE_COLLABORATION', {
    fallback: httpDiscovered && httpGranted && httpAbsentRefused ? 'works' : 'broken',
    fallbackPath: 'POST /v1/collaboration/authorize',
    fallbackStatus: collabHttpGrant?.status ?? collabHttpDiscovery.status,
    fallbackDetail: { discovered: httpDiscovered, granted: httpGranted, absentNoteRefused: httpAbsentRefused },
  })
  if (CONTROL) {
    const broken = await raw('POST', '/v1/collaboration/authorize-nope', { token, body: {} })
    control('the collaboration reachability probe', httpFallbackVerdict(broken) === 'broken', {
      status: broken.status,
    })
    // A revoked credential must not mint a capability for a note the account
    // really owns -- otherwise the grant above could be coming from anywhere.
    const noCredential = await raw('POST', '/v1/collaboration/authorize', {
      token: 'not-a-real-token-' + randomBytes(8).toString('hex'),
      body: { noteUuid: collabNoteUuid, collaborationProtocolVersion: 3, epochDiscovery: true },
    })
    control('the collaboration grant probe (a bad credential must not be granted)', noCredential.status !== 200, {
      status: noCredential.status,
    })
  }

  // =====================================================================
  // INVITE_EVENTS
  // =====================================================================
  console.log('\n[INVITE_EVENTS]')
  if (census.advertised.INVITE_EVENTS && (await ensureSocket())) {
    const requestId = `req-${randomUUID()}`
    socket.ws.send(JSON.stringify(syncFrame('INVITE_SUBSCRIBE', { limit: 10 }, { sequence: sequence++, requestId })))
    const answer = await waitForFrame(
      socket,
      (f) =>
        f.requestId === requestId && ['INVITE_READY', 'INVITE_BATCH', 'INVITE_RECONCILE', 'ERROR'].includes(f.type),
      25_000,
    )
    // INVITE_STORE_UNAVAILABLE is the gateway saying the invite store is down.
    // Under the old predicate that was a working lane; it is not one.
    const carried = check(
      'an INVITE_SUBSCRIBE is answered by the lane (INVITE_READY/BATCH/RECONCILE, or a named policy refusal)',
      laneCarried(answer, ['INVITE_READY', 'INVITE_BATCH', 'INVITE_RECONCILE'], LANE_POLICY_CODES),
      {
        type: answer?.type,
        code: answer?.payload?.code,
      },
    )
    row('INVITE_EVENTS', {
      lane: carried ? 'works' : 'broken',
      laneDetail: { type: answer?.type, code: answer?.payload?.code },
    })
  } else {
    row('INVITE_EVENTS', { lane: census.advertised.INVITE_EVENTS ? 'untested' : 'withheld' })
  }
  // The documented fallback for invite push is HTTP polling of the invite list.
  const inviteFallback = await raw('GET', INVITE_HTTP_PATH, { token, cookie: account.cookie || undefined })
  const inviteVerdict = httpFallbackVerdict(inviteFallback)
  check(
    'FALLBACK: the invite list ANSWERS over plain HTTP (2xx with data, or a 4xx the handler produced)',
    inviteVerdict !== 'broken',
    { status: inviteFallback.status, verdict: inviteVerdict, body: inviteFallback.text.slice(0, 160) },
  )
  row('INVITE_EVENTS', {
    fallback: inviteVerdict,
    fallbackPath: 'GET ' + INVITE_HTTP_PATH,
    fallbackStatus: inviteFallback.status,
  })
  if (CONTROL) {
    const broken = await raw('GET', INVITE_HTTP_PATH + '-nope', { token })
    control('the invite reachability probe', httpFallbackVerdict(broken) === 'broken', { status: broken.status })
  }

  // =====================================================================
  // FILES_V1
  // =====================================================================
  console.log('\n[FILES_V1]')

  /**
   * ONE COMPLETE FILES_V1 ROUND TRIP over the live socket, recorded stage by
   * stage. Nothing here is inferred from the absence of an error: every field
   * is set only when the gateway sent the frame that stage actually produces,
   * and the last field is a byte comparison of what came back.
   *
   * This replaces a probe that sent one FILES_METADATA frame and called the
   * lane `works` on any answer that was not OPERATION_UNAVAILABLE — which is
   * how `FILES_V1 lane: works` was recorded against a build where every
   * cookie-session file operation answered ERROR FILE_ACCESS_DENIED
   * (efa5b985). The metadata frame is kept as the FIRST stage, now asserted
   * positively: a `user`-owned resource that does not exist yet must answer a
   * FILES_METADATA frame with an `entries` array, never a denial.
   *
   * `corruptFinishDigest` is the planted break for CONTROL=1: the bytes go up
   * correctly and the FINISH names a digest they do not have, which the
   * adapter must refuse (FILE_INTEGRITY_MISMATCH).
   */
  async function fileRoundTrip({ corruptFinishDigest = false } = {}) {
    const trip = {
      metadataAnswered: false,
      uploadAccepted: false,
      chunksSent: 0,
      chunksAcked: 0,
      finishCompleted: false,
      uploadSha256: undefined,
      downloadAccepted: false,
      downloadCompleted: false,
      downloadSha256: undefined,
      bytesIdentical: false,
      expectedSha256: undefined,
      declaredSize: 0,
      receivedBytes: 0,
      stoppedAt: 'start',
      lastError: undefined,
    }
    if (!(await ensureSocket())) {
      trip.stoppedAt = 'no-socket'
      return trip
    }
    const live = socket
    const stop = (stage, answer) => {
      trip.stoppedAt = stage
      trip.lastError =
        answer === undefined
          ? 'no-answer'
          : `${answer.type}${answer.payload?.code === undefined ? '' : ':' + answer.payload.code}`
      return trip
    }

    const remoteIdentifier = randomUUID()
    const bytes = randomBytes(Math.max(2, FILE_PROBE_BYTES))
    const declaredSize = bytes.byteLength
    trip.declaredSize = declaredSize
    trip.expectedSha256 = createHash('sha256').update(bytes).digest('hex')

    // 1. METADATA. `isFileResourceReference` (filesProtocol.ts) requires
    //    ownershipType 'user' | 'shared-vault' and refuses any sharedVault*
    //    field on a 'user' reference; a malformed reference closes the socket
    //    on an invalid envelope rather than answering, so the reference below
    //    is the exact legal shape.
    const metaFrame = syncFrame(
      'FILES_METADATA',
      { resources: [{ ownershipType: 'user', remoteIdentifier }], deadlineMs: 20_000 },
      { sequence: sequence++ },
    )
    live.ws.send(JSON.stringify(metaFrame))
    const meta = await waitForFrame(
      live,
      (f) => f.commandId === metaFrame.commandId && (f.type === 'FILES_METADATA' || f.type === 'ERROR'),
      25_000,
    )
    if (meta?.type !== 'FILES_METADATA' || !Array.isArray(meta.payload?.entries)) return stop('metadata', meta)
    trip.metadataAnswered = true

    // 2. UPLOAD OPEN.
    const openFrame = syncFrame(
      'FILES_UPLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier },
        decryptedSize: declaredSize,
        declaredSize,
        mimeType: 'application/octet-stream',
        deadlineMs: 30_000,
      },
      { sequence: sequence++ },
    )
    live.ws.send(JSON.stringify(openFrame))
    const opened = await waitForFrame(
      live,
      (f) => f.commandId === openFrame.commandId && (f.type === 'FILES_ACCEPTED' || f.type === 'ERROR'),
      30_000,
    )
    if (opened?.type !== 'FILES_ACCEPTED' || opened.payload?.mode !== 'upload') return stop('upload-open', opened)
    const transferId = opened.payload.transferId
    const generation = opened.payload.generation
    if (typeof transferId !== 'string' || !Number.isInteger(generation)) return stop('upload-open', opened)
    trip.uploadAccepted = true

    // 3. CHUNKS, deliberately more than one so the gateway's index/offset
    //    accounting is exercised rather than a single all-in-one write.
    const split = Math.floor(declaredSize / 2)
    const ranges =
      split > 0 && split < declaredSize
        ? [
            [0, split],
            [split, declaredSize],
          ]
        : [[0, declaredSize]]
    for (let index = 0; index < ranges.length; index += 1) {
      const [start, end] = ranges[index]
      const slice = bytes.subarray(start, end)
      const chunkRequestId = `req-chunk${index}-${randomUUID()}`
      live.ws.send(
        encodeFileChunkFrame(
          {
            kind: 'UPLOAD_CHUNK',
            requestId: chunkRequestId,
            transferId,
            generation,
            index,
            offset: start,
            declaredSize,
            byteLength: slice.byteLength,
            sha256: createHash('sha256').update(slice).digest('hex'),
            final: end === declaredSize,
          },
          slice,
        ),
      )
      trip.chunksSent += 1
      const ack = await waitForFrame(
        live,
        (f) => f.requestId === chunkRequestId && (f.type === 'FILES_CHUNK_ACK' || f.type === 'ERROR'),
        30_000,
      )
      if (ack?.type !== 'FILES_CHUNK_ACK' || ack.payload?.index !== index || ack.payload?.nextOffset !== end) {
        return stop(`chunk-${index}`, ack)
      }
      trip.chunksAcked += 1
    }

    // 4. FINISH, on the digest of the bytes the client sent.
    const finishDigest = corruptFinishDigest
      ? createHash('sha256').update(randomBytes(32)).digest('hex')
      : trip.expectedSha256
    const finishFrame = syncFrame(
      'FILES_UPLOAD_FINISH',
      { transferId, generation, declaredSize, sha256: finishDigest, deadlineMs: 30_000 },
      { sequence: sequence++ },
    )
    live.ws.send(JSON.stringify(finishFrame))
    const completed = await waitForFrame(
      live,
      (f) => f.commandId === finishFrame.commandId && (f.type === 'FILES_COMPLETE' || f.type === 'ERROR'),
      40_000,
    )
    if (completed?.type !== 'FILES_COMPLETE' || completed.payload?.mode !== 'upload') return stop('finish', completed)
    trip.finishCompleted = true
    trip.uploadSha256 = completed.payload?.sha256

    // 5. DOWNLOAD the same resource back. Chunks arrive as BINARY frames, so
    //    the cursor below is where this trip's bytes start in the socket's
    //    binary buffer.
    const binaryCursor = live.binaries.length
    const downloadFrame = syncFrame(
      'FILES_DOWNLOAD_OPEN',
      {
        resource: { ownershipType: 'user', remoteIdentifier },
        offset: 0,
        initialCreditBytes: 524_288,
        deadlineMs: 30_000,
      },
      { sequence: sequence++ },
    )
    live.ws.send(JSON.stringify(downloadFrame))
    const downloadOpened = await waitForFrame(
      live,
      (f) => f.commandId === downloadFrame.commandId && (f.type === 'FILES_ACCEPTED' || f.type === 'ERROR'),
      30_000,
    )
    if (downloadOpened?.type !== 'FILES_ACCEPTED' || downloadOpened.payload?.mode !== 'download') {
      return stop('download-open', downloadOpened)
    }
    trip.downloadAccepted = true
    const downloadComplete = await waitForFrame(
      live,
      (f) => f.commandId === downloadFrame.commandId && (f.type === 'FILES_COMPLETE' || f.type === 'ERROR'),
      40_000,
    )
    if (downloadComplete?.type !== 'FILES_COMPLETE' || downloadComplete.payload?.mode !== 'download') {
      return stop('download', downloadComplete)
    }
    trip.downloadCompleted = true
    trip.downloadSha256 = downloadComplete.payload?.sha256

    // 6. The bytes themselves.
    const received = []
    for (const raw of live.binaries.slice(binaryCursor)) {
      const chunk = decodeFileChunkFrame(raw)
      if (chunk?.header?.kind === 'DOWNLOAD_CHUNK') received.push(Buffer.from(chunk.bytes))
    }
    const assembled = Buffer.concat(received)
    trip.receivedBytes = assembled.byteLength
    trip.bytesIdentical = assembled.byteLength === declaredSize && assembled.equals(bytes)
    trip.stoppedAt = trip.bytesIdentical ? 'complete' : 'bytes'
    return trip
  }

  if (census.advertised.FILES_V1 && (await ensureSocket())) {
    const trip = await fileRoundTrip()
    const works = check(
      'a file makes a COMPLETE FILES_V1 round trip over the socket (metadata -> open -> chunks -> finish -> download -> byte-identical)',
      fileRoundTripSucceeded(trip),
      {
        stoppedAt: trip.stoppedAt,
        lastError: trip.lastError,
        chunks: `${trip.chunksAcked}/${trip.chunksSent}`,
        bytes: `${trip.receivedBytes}/${trip.declaredSize}`,
        bytesIdentical: trip.bytesIdentical,
      },
    )
    row('FILES_V1', { lane: works ? 'works' : 'broken', laneDetail: trip })
    if (!works && String(trip.lastError).includes('FILE_ACCESS_DENIED')) {
      note(
        'DEFECT CANDIDATE: FILES_V1 answered FILE_ACCESS_DENIED for the account that OWNS the resource — the lane is not carrying this session kind (the defect efa5b985 fixed for cookie sessions on a single container)',
      )
    }
    if (CONTROL) {
      const planted = await fileRoundTrip({ corruptFinishDigest: true })
      control(
        'the FILES_V1 round-trip probe (a FINISH naming the wrong digest must not complete)',
        !fileRoundTripSucceeded(planted),
        { stoppedAt: planted.stoppedAt, lastError: planted.lastError },
      )
    }
  } else {
    row('FILES_V1', { lane: census.advertised.FILES_V1 ? 'untested' : 'withheld' })
  }
  // Fallback: the HTTP valet-token flow the web client uses when FILES_V1 is
  // not negotiated. Reachability of the mint is the gate; a 200 with a token
  // means the whole HTTP file path is open.
  const valet = await raw('POST', '/v1/files/valet-tokens', {
    token,
    cookie: account.cookie || undefined,
    body: { operation: 'write', resources: [{ remoteIdentifier: randomUUID(), unencryptedFileSize: 1024 }] },
  })
  const valetVerdict = httpFallbackVerdict(valet)
  check(
    'FALLBACK: the HTTP valet-token mint ANSWERS (2xx with data, or a 4xx the handler produced)',
    valetVerdict !== 'broken',
    {
      status: valet.status,
      verdict: valetVerdict,
      body: valet.text.slice(0, 200),
    },
  )
  row('FILES_V1', {
    fallback: valetVerdict,
    fallbackPath: 'POST /v1/files/valet-tokens',
    fallbackStatus: valet.status,
  })
  if (CONTROL) {
    const broken = await raw('POST', '/v1/files/valet-tokens-nope', { token, body: {} })
    control('the files reachability probe', httpFallbackVerdict(broken) === 'broken', { status: broken.status })
  }

  // =====================================================================
  // Legacy push lane on /sockets
  // =====================================================================
  console.log('\n[LEGACY /sockets]')
  const wsToken = await raw('POST', '/v1/sockets/tokens', { token, cookie: account.cookie || undefined })
  const mintOk = check(
    'the legacy websocket token mints',
    wsToken.status === 200 && typeof wsToken.json?.token === 'string',
    {
      status: wsToken.status,
      body: wsToken.text.slice(0, 200),
    },
  )
  let legacyLane = 'withheld'
  if (mintOk) {
    const legacy = await openLegacySocket(wsToken.json.token).catch((error) => {
      check('the legacy /sockets lane upgrades', false, { error: error.message })
      return undefined
    })
    if (legacy) {
      await sleep(600)
      // A PRESENT success, not the absence of a close frame: ask the server
      // something on the live connection and require it to answer. `ws`
      // resolves `open` on the HTTP 101, so "no close event yet" proves only
      // that nothing has happened yet — the same shape as the FILES_V1 false
      // green this script was built to stop producing.
      const probe = await legacyLaneProbe(legacy)
      const open = check(
        'the legacy /sockets lane answers a control ping on the live connection (and did not close)',
        legacyLaneUsable(probe),
        { ...probe, close: legacy.close },
      )
      legacyLane = open ? 'works' : 'broken'
      // Pin the path: any other pathname must be refused 1008/HTTP, which is
      // what proves the probe is really testing the pinned lane.
      legacy.ws.close()
    }
  }
  row('LEGACY_PUSH', { advertised: mintOk, lane: legacyLane })
  // The documented fallback for no push at all is a periodic HTTP pull, which
  // is the same /v1/items read already proven above.
  row('LEGACY_PUSH', { fallback: syncFallbackOk ? 'works' : 'broken', fallbackPath: 'periodic POST /v1/items pull' })
  if (CONTROL) {
    // A bogus authToken must NOT yield a USABLE lane. `ws` resolves `open` the
    // moment the HTTP 101 lands, so "it opened" is not the question — the
    // question is whether it is still open a moment later. An earlier version
    // of this control treated the open event alone as a pass and therefore
    // could never fail; it is now settled against the close frame.
    const bogus = await openLegacySocket('bogus-' + randomBytes(16).toString('hex')).catch((error) => ({ error }))
    let rejected
    let detail
    if (bogus.error) {
      rejected = true
      detail = { upgradeRefused: bogus.error.message }
    } else {
      await sleep(1500)
      // Settled by the SAME predicate the real row uses, so the control cannot
      // pass under a rule the row does not live by.
      const probe = await legacyLaneProbe(bogus)
      rejected = !legacyLaneUsable(probe)
      detail = { ...probe, close: bogus.close, messages: bogus.messages.length }
      try {
        bogus.ws.close()
      } catch {}
    }
    control('the legacy lane probe (bogus authToken)', rejected, detail)
    if (!rejected) {
      note('DEFECT CANDIDATE: the legacy /sockets lane accepted a forged authToken and stayed open')
    }
    const wrongPath = await new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/sockets-not-a-lane`, { origin: ORIGIN })
      const done = (v) => resolve(v)
      ws.on('open', () => {
        ws.on('close', (code) => done({ opened: true, code }))
        setTimeout(() => {
          try {
            ws.close()
          } catch {}
          done({ opened: true, code: undefined })
        }, 1500)
      })
      ws.on('unexpected-response', (_r, res) => done({ opened: false, httpStatus: res.statusCode }))
      ws.on('error', (err) => done({ opened: false, error: err.message }))
      setTimeout(() => done({ opened: false, error: 'timeout' }), 8000)
    })
    control(
      'the legacy path pin (a non-/sockets path must not serve the lane)',
      wrongPath.opened !== true || wrongPath.code === 1008,
      wrongPath,
    )
  }

  if (socket && !socket.close) socket.ws.close()

  // --- matrix ------------------------------------------------------------
  console.log('\n================ FALLBACK MATRIX ================')
  const header = ['capability', 'advertised', 'lane', 'fallback', 'fallback path']
  const rows = Object.entries(matrix).map(([capability, value]) => [
    capability,
    String(value.advertised ?? '-'),
    String(value.lane ?? '-'),
    String(value.fallback ?? '-'),
    String(value.fallbackPath ?? '-'),
  ])
  const widths = header.map((_, i) => Math.max(header[i].length, ...rows.map((r) => r[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(line(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r))
  console.log('=================================================')

  const payload = {
    capturedAt: new Date().toISOString(),
    base: BASE,
    wsBase: WS_BASE,
    sessionType: cookieSession ? 'cookie' : 'legacy',
    setCookieHeaders: account.setCookieCount,
    ticketAvailable,
    census: census.seen,
    matrix,
    notes,
    failures,
    controlFailures,
    controlsRun: CONTROL,
  }
  if (MATRIX_JSON) {
    writeFileSync(MATRIX_JSON, JSON.stringify(payload, null, 2))
    console.log(`matrix written to ${MATRIX_JSON}`)
  } else {
    console.log('MATRIX_JSON=' + JSON.stringify(payload))
  }

  console.log(`\n${failures} failures, ${controlFailures} control failures`)
  if (controlFailures > 0) {
    console.error('CONTROL FAILURE: at least one probe passed on a planted break, so its green result proves nothing.')
  }
  process.exit(failures === 0 && controlFailures === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  main().catch((error) => {
    console.error('fatal:', error)
    process.exit(1)
  })
}
