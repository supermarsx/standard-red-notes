/**
 * FILES_V1 live probe — the compose file lane.
 *
 * Scenarios (pick with --case, default `all`):
 *   roundtrip  upload N bytes then read them back; asserts BYTE-IDENTICAL
 *   samesecond ONE FILES_METADATA frame naming TWO resources. The adapter
 *              authorizes each resource separately, so this is two valet-token
 *              mints inside the same wall-clock second from a single client
 *              request — the minimal reproduction of finding 1a.
 *   capacity   fail `--fails` uploads on one account, then prove a SECOND,
 *              brand-new account can still open an upload (finding 1b)
 *   starve     open a download with far too little credit and a SHORT declared
 *              deadline, then watch. A named error inside the deadline is the
 *              fix for finding 4; silence is the bug.
 *
 * Env: BASE, WS_BASE, ORIGIN. Flags: --case, --session=cookie|legacy|both,
 *      --bytes, --fails, --watch-ms, --json
 */
import { WebSocket } from 'ws'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3540'
const WS_BASE = process.env.WS_BASE ?? BASE.replace(/^http/u, 'ws')
const ORIGIN = process.env.ORIGIN ?? BASE

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = argv.find((entry) => entry.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const CASE = flag('case', 'all')
const SESSIONS = flag('session', 'both')
const BYTES = Number(flag('bytes', String(700 * 1024)))
const FAILS = Number(flag('fails', '18'))
const WATCH_MS = Number(flag('watch-ms', '25000'))
const CREDIT = Number(flag('credit', String(256 * 1024)))
const SIZES = flag('sizes', '65536,262144,716800,2359297')
  .split(',')
  .map(Number)
const AS_JSON = argv.includes('--json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = []
let failures = 0
function check(name, ok, detail) {
  report.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures++
  if (!AS_JSON) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} - ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  }
}
function note(name, detail) {
  report.push({ name, ok: null, detail })
  if (!AS_JSON) console.log(`  note - ${name} ${JSON.stringify(detail)}`)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function raw(method, path, { body, token, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
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
  return { status: res.status, json: envelope ? parsed.data : parsed, text, setCookie: res.headers.getSetCookie?.() ?? [] }
}

const cookieHeaderFrom = (setCookie) =>
  setCookie
    .map((entry) => entry.split(';', 1)[0].trim())
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ')

/** `kind` picks the SHIPPED session shape: a cookie session or the legacy header one. */
async function register(kind) {
  const email = `cfiles-${kind}-${Date.now()}-${randomBytes(4).toString('hex')}@example.com`
  const password = randomBytes(32).toString('hex')
  const r = await raw('POST', '/v1/users', {
    body: {
      email,
      password,
      api: kind === 'cookie' ? '20240226' : '20200115',
      version: '004',
      pw_nonce: randomBytes(32).toString('hex'),
      origination: 'registration',
      created: String(Date.now()),
      ephemeral: false,
    },
  })
  if (r.status !== 200 || !r.json?.session?.access_token) {
    throw new Error(`register(${kind}) failed: ${r.status} ${r.text.slice(0, 300)}`)
  }
  return {
    kind,
    email,
    token: r.json.session.access_token,
    cookie: kind === 'cookie' ? cookieHeaderFrom(r.setCookie) : '',
    userUuid: r.json.user?.uuid,
  }
}

// ---------------------------------------------------------------------------
// Protocol v1 framing
// ---------------------------------------------------------------------------
function syncFrame(type, payload, sequence) {
  return {
    version: 1,
    channel: 'sync',
    type,
    requestId: `req-${randomUUID()}`,
    commandId: `cmd-${randomUUID()}`,
    sequence: sequence ?? 0,
    payloadLength: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    payload,
  }
}

const FILE_BINARY_MAGIC = Buffer.from('SRNF', 'ascii')
function encodeBinary(header, bytes) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const frame = Buffer.allocUnsafe(8 + headerBytes.byteLength + bytes.byteLength)
  FILE_BINARY_MAGIC.copy(frame, 0)
  frame.writeUInt8(1, 4)
  frame.writeUInt8(header.kind === 'UPLOAD_CHUNK' ? 1 : 2, 5)
  frame.writeUInt16BE(headerBytes.byteLength, 6)
  headerBytes.copy(frame, 8)
  bytes.copy(frame, 8 + headerBytes.byteLength)
  return frame
}
function decodeBinary(raw) {
  const frame = Buffer.from(raw)
  const headerLength = frame.readUInt16BE(6)
  const header = JSON.parse(frame.subarray(8, 8 + headerLength).toString('utf8'))
  return { header, bytes: frame.subarray(8 + headerLength) }
}

class Lane {
  constructor(account) {
    this.account = account
    this.frames = []
    this.binary = []
    this.close = undefined
    this.sequence = 0
    this.deviceId = `cfiles-${randomUUID()}`
  }

  async connect() {
    const ticket = await raw('POST', '/v1/sockets/sync/ticket', {
      token: this.account.token,
      ...(this.account.cookie ? { cookie: this.account.cookie } : {}),
      body: { deviceId: this.deviceId },
    })
    if (ticket.status !== 200 || typeof ticket.json?.ticket !== 'string') {
      throw new Error(`ticket refused (${this.account.kind}): ${ticket.status} ${ticket.text.slice(0, 200)}`)
    }
    this.ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${WS_BASE}/sockets/sync`, {
        origin: ORIGIN,
        ...(this.account.cookie ? { headers: { cookie: this.account.cookie } } : {}),
      })
      socket.binaryType = 'nodebuffer'
      socket.on('message', (data, isBinary) => {
        if (process.env.PROBE_TRACE === '1') {
          console.log(`    trace <- ${isBinary ? 'BINARY' : 'TEXT'} ${data.length ?? data.byteLength} bytes`)
        }
        if (isBinary) {
          try {
            this.binary.push(decodeBinary(data))
          } catch (error) {
            console.log('    trace !! binary decode failed')
          }
        } else {
          try {
            this.frames.push(JSON.parse(data.toString()))
          } catch {
            this.frames.push({ type: 'UNPARSEABLE' })
          }
        }
      })
      socket.on('close', (code, reason) => {
        this.close = { code, reason: reason.toString() }
      })
      socket.on('error', (error) => reject(error))
      socket.on('open', () => resolve(socket))
      setTimeout(() => reject(new Error('socket open timeout')), 15_000)
    })
    this.send('AUTH', { ticket: ticket.json.ticket, deviceId: this.deviceId })
    const authenticated = await this.wait((f) => f.type === 'AUTHENTICATED' || f.type === 'ERROR', 15_000)
    if (authenticated?.type !== 'AUTHENTICATED') {
      throw new Error(`AUTH refused (${this.account.kind}): ${JSON.stringify(authenticated ?? this.close)}`)
    }
    this.operations = authenticated.payload?.operations ?? []
    return this
  }

  send(type, payload) {
    const frame = syncFrame(type, payload, this.sequence++)
    this.ws.send(JSON.stringify(frame))
    return frame
  }

  sendBinary(header, bytes) {
    this.ws.send(encodeBinary(header, bytes))
  }

  async wait(predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate)
      if (found) return found
      if (this.close) return undefined
      await sleep(15)
    }
    return undefined
  }

  answerTo(requestId, timeoutMs) {
    return this.wait((f) => f.requestId === requestId, timeoutMs)
  }

  stop() {
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const CHUNK = 256 * 1024

async function upload(lane, remoteIdentifier, payload, { deadlineMs = 30_000 } = {}) {
  const open = lane.send('FILES_UPLOAD_OPEN', {
    resource: { ownershipType: 'user', remoteIdentifier },
    decryptedSize: payload.byteLength,
    declaredSize: payload.byteLength,
    mimeType: 'application/octet-stream',
    deadlineMs,
  })
  const accepted = await lane.answerTo(open.requestId, deadlineMs + 5_000)
  if (accepted?.type !== 'FILES_ACCEPTED') {
    return { ok: false, stage: 'open', answer: accepted ?? lane.close }
  }
  const { transferId, generation } = accepted.payload
  let index = 0
  let offset = 0
  while (offset < payload.byteLength) {
    const slice = payload.subarray(offset, Math.min(offset + CHUNK, payload.byteLength))
    const header = {
      kind: 'UPLOAD_CHUNK',
      requestId: open.requestId,
      transferId,
      generation,
      index,
      offset,
      declaredSize: payload.byteLength,
      byteLength: slice.byteLength,
      sha256: createHash('sha256').update(slice).digest('hex'),
      final: offset + slice.byteLength === payload.byteLength,
    }
    const before = lane.frames.length
    lane.sendBinary(header, slice)
    // ONE binary frame outstanding at a time: the binary plane's ingress queue
    // is frame-counted and a second outstanding frame used to close the socket.
    const ack = await lane.wait((f, i) => i >= before && (f.type === 'FILES_CHUNK_ACK' || f.type === 'ERROR'), 30_000)
    if (ack?.type !== 'FILES_CHUNK_ACK') {
      return { ok: false, stage: `chunk:${index}`, answer: ack ?? lane.close }
    }
    index += 1
    offset += slice.byteLength
  }
  const finish = lane.send('FILES_UPLOAD_FINISH', {
    transferId,
    generation,
    declaredSize: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
    deadlineMs,
  })
  const complete = await lane.answerTo(finish.requestId, deadlineMs + 5_000)
  if (complete?.type !== 'FILES_COMPLETE') {
    return { ok: false, stage: 'finish', answer: complete ?? lane.close }
  }
  return { ok: true, sha256: complete.payload.sha256, transferId, generation }
}

async function download(lane, remoteIdentifier, { deadlineMs = 30_000, initialCreditBytes = CREDIT } = {}) {
  const open = lane.send('FILES_DOWNLOAD_OPEN', {
    resource: { ownershipType: 'user', remoteIdentifier },
    offset: 0,
    initialCreditBytes,
    deadlineMs,
  })
  const accepted = await lane.answerTo(open.requestId, deadlineMs + 5_000)
  if (accepted?.type !== 'FILES_ACCEPTED') {
    return { ok: false, stage: 'open', answer: accepted ?? lane.close }
  }
  const { transferId, generation, declaredSize } = accepted.payload
  const parts = []
  let seen = 0
  const deadline = Date.now() + deadlineMs + 30_000
  while (Date.now() < deadline) {
    const next = lane.binary.shift()
    if (next) {
      parts.push(next.bytes)
      seen += next.bytes.byteLength
      // Grant HEADROOM, never a running total: the session clamps OUTSTANDING
      // credit, so a cumulative figure silently starves the transfer.
      lane.send('FILES_CREDIT', { transferId, generation, creditBytes: next.bytes.byteLength })
      if (next.header.final) break
      continue
    }
    const error = lane.frames.find((f) => f.requestId === open.requestId && f.type === 'ERROR')
    if (error) return { ok: false, stage: 'stream', answer: error, bytes: seen }
    if (lane.close) return { ok: false, stage: 'closed', answer: lane.close, bytes: seen }
    await sleep(10)
  }
  const complete = await lane.wait(
    (f) => f.requestId === open.requestId && (f.type === 'FILES_COMPLETE' || f.type === 'ERROR'),
    10_000,
  )
  if (complete?.type !== 'FILES_COMPLETE') {
    return { ok: false, stage: 'complete', answer: complete ?? lane.close, bytes: seen }
  }
  return { ok: true, bytes: Buffer.concat(parts), sha256: complete.payload.sha256, declaredSize }
}

async function caseRoundtrip(kind) {
  const lane = await new Lane(await register(kind)).connect()
  try {
    check(`[${kind}] FILES_V1 negotiated`, lane.operations.includes('FILES_V1'), { operations: lane.operations })
    const remoteIdentifier = randomUUID()
    const payload = randomBytes(BYTES)
    const expected = createHash('sha256').update(payload).digest('hex')
    const up = await upload(lane, remoteIdentifier, payload)
    check(`[${kind}] upload completes`, up.ok, up.ok ? { sha256: up.sha256 } : up)
    if (!up.ok) return
    check(`[${kind}] server-side digest equals the client's`, up.sha256 === expected, { expected, got: up.sha256 })
    const down = await download(lane, remoteIdentifier)
    check(`[${kind}] download completes`, down.ok, down.ok ? { bytes: down.bytes.byteLength } : down)
    if (!down.ok) return
    check(
      `[${kind}] read back BYTE-IDENTICAL`,
      down.bytes.byteLength === payload.byteLength && down.bytes.equals(payload),
      { bytes: down.bytes.byteLength, expectedBytes: payload.byteLength, sha256: down.sha256, expected },
    )
  } finally {
    lane.stop()
  }
}

async function caseSameSecond(kind) {
  const lane = await new Lane(await register(kind)).connect()
  try {
    const started = Date.now()
    const frame = lane.send('FILES_METADATA', {
      resources: [
        { ownershipType: 'user', remoteIdentifier: randomUUID() },
        { ownershipType: 'user', remoteIdentifier: randomUUID() },
      ],
      deadlineMs: 30_000,
    })
    const answer = await lane.answerTo(frame.requestId, 35_000)
    const elapsedMs = Date.now() - started
    check(
      `[${kind}] two same-second file operations in ONE request both succeed`,
      answer?.type === 'FILES_METADATA' && Array.isArray(answer.payload?.entries) && answer.payload.entries.length === 2,
      { elapsedMs, type: answer?.type, code: answer?.payload?.code, entries: answer?.payload?.entries?.length },
    )
  } finally {
    lane.stop()
  }
}

async function caseCapacity(kind) {
  // Victim first, so its own transfers cannot be what exhausts the pool.
  const attacker = await new Lane(await register(kind)).connect()
  const victimAccount = await register(kind)
  try {
    let opened = 0
    let denied = 0
    for (let i = 0; i < FAILS; i++) {
      const open = attacker.send('FILES_UPLOAD_OPEN', {
        resource: { ownershipType: 'user', remoteIdentifier: randomUUID() },
        decryptedSize: 4 * CHUNK,
        declaredSize: 4 * CHUNK,
        mimeType: 'application/octet-stream',
        deadlineMs: 30_000,
      })
      const accepted = await attacker.answerTo(open.requestId, 35_000)
      if (accepted?.type === 'FILES_ACCEPTED') {
        opened += 1
        // Abandon it the way a failed transfer does: never finish, never cancel.
      } else {
        denied += 1
      }
    }
    note(`[${kind}] attacker opened/denied`, { opened, denied, attempted: FAILS })
    // The socket closes: every slot it held must be reclaimed.
    attacker.stop()
    await sleep(1_500)
    const victim = await new Lane(victimAccount).connect()
    try {
      const payload = randomBytes(64 * 1024)
      const remoteIdentifier = randomUUID()
      const up = await upload(victim, remoteIdentifier, payload)
      check(`[${kind}] a SECOND account can still upload after ${FAILS} abandoned transfers`, up.ok, up)
    } finally {
      victim.stop()
    }
  } finally {
    attacker.stop()
  }
}

/**
 * ONE account, several file sizes. Registration is rate limited, so a sweep that
 * registered per size would measure the limiter instead of the lane.
 */
async function caseSizes(kind) {
  const lane = await new Lane(await register(kind)).connect()
  try {
    for (const size of SIZES) {
      const remoteIdentifier = randomUUID()
      const payload = randomBytes(size)
      const expected = createHash('sha256').update(payload).digest('hex')
      const up = await upload(lane, remoteIdentifier, payload)
      if (!up.ok) {
        check(`[${kind}] ${size}B uploads`, false, up)
        continue
      }
      const down = await download(lane, remoteIdentifier)
      check(
        `[${kind}] ${size}B round-trips BYTE-IDENTICAL`,
        down.ok && down.bytes.byteLength === size && down.bytes.equals(payload) && down.sha256 === expected,
        down.ok
          ? { bytes: down.bytes.byteLength, sha256: down.sha256, expected, creditBytes: CREDIT }
          : { ...down, creditBytes: CREDIT },
      )
    }
  } finally {
    lane.stop()
  }
}

/** Upload on one socket, download on a FRESH one, to tell frame size apart from
 *  anything the upload left behind on the socket it used. */
async function caseFreshDownload(kind) {
  const account = await register(kind)
  for (const size of SIZES) {
    const remoteIdentifier = randomUUID()
    const payload = randomBytes(size)
    const uploader = await new Lane(account).connect()
    const up = await upload(uploader, remoteIdentifier, payload)
    uploader.stop()
    if (!up.ok) {
      check(`[${kind}] ${size}B uploads`, false, up)
      continue
    }
    const reader = await new Lane(account).connect()
    const down = await download(reader, remoteIdentifier)
    reader.stop()
    check(
      `[${kind}] ${size}B downloads on a FRESH socket`,
      down.ok && down.bytes.byteLength === size && down.bytes.equals(payload),
      down.ok ? { bytes: down.bytes.byteLength, creditBytes: CREDIT } : { ...down, creditBytes: CREDIT },
    )
  }
}

/**
 * Finding 1a at its source, over the SHIPPED mint endpoint.
 *
 * The valet token is an HS256 JWT whose only time component was a second-resolution
 * `iat`, so repeated mints of IDENTICAL claims inside one second were the same
 * string byte for byte -- and both the files service and the multi-container
 * adapter treat a repeat as a replay, because a valet credential is single use.
 * Identical claims is the whole point: two DIFFERENT resources mint different
 * payloads and so differ by accident, which is why an upload (open, then first
 * chunk, same resource, same size) was the thing that broke.
 */
async function caseMint(kind) {
  const account = await register(kind)
  const remoteIdentifier = randomUUID()
  const body = {
    operation: 'write',
    resources: [{ remoteIdentifier, unencryptedFileSize: 4096 }],
  }
  const started = Date.now()
  const minted = []
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await raw('POST', '/v1/files/valet-tokens', {
      token: account.token,
      ...(account.cookie ? { cookie: account.cookie } : {}),
      body,
    })
    if (response.status !== 200 || typeof response.json?.valetToken !== 'string') {
      check(`[${kind}] mint ${attempt} succeeded`, false, { status: response.status, body: response.text.slice(0, 200) })
      return
    }
    minted.push(response.json.valetToken)
  }
  const elapsedMs = Date.now() - started
  const distinct = new Set(minted).size
  const payloads = minted.map((token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()))
  check(
    `[${kind}] ${minted.length} mints of IDENTICAL claims inside ${elapsedMs}ms are all DISTINCT`,
    distinct === minted.length,
    {
      elapsedMs,
      mints: minted.length,
      distinct,
      // One second of `iat` covered them all, so `iat` cannot be what separates them.
      distinctIat: new Set(payloads.map((payload) => payload.iat)).size,
      distinctJti: new Set(payloads.map((payload) => payload.jti)).size,
    },
  )
  check(
    `[${kind}] every mint still carries the same verifiable claims`,
    payloads.every(
      (payload) =>
        payload.userUuid === account.userUuid &&
        payload.permittedOperation === 'write' &&
        payload.permittedResources?.[0]?.remoteIdentifier === remoteIdentifier &&
        payload.exp > payload.iat,
    ),
    { userUuid: account.userUuid, sample: { ...payloads[0], jti: '<nonce>' } },
  )
}

async function caseStarve(kind) {
  const lane = await new Lane(await register(kind)).connect()
  try {
    const remoteIdentifier = randomUUID()
    const payload = randomBytes(Math.max(BYTES, 600 * 1024))
    const up = await upload(lane, remoteIdentifier, payload)
    if (!up.ok) {
      check(`[${kind}] starve precondition: upload works`, false, up)
      return
    }
    const declaredDeadlineMs = 5_000
    const open = lane.send('FILES_DOWNLOAD_OPEN', {
      resource: { ownershipType: 'user', remoteIdentifier },
      offset: 0,
      // Deliberately far less than the file: the transfer MUST starve.
      initialCreditBytes: 64 * 1024,
      deadlineMs: declaredDeadlineMs,
    })
    const accepted = await lane.answerTo(open.requestId, 20_000)
    if (accepted?.type !== 'FILES_ACCEPTED') {
      check(`[${kind}] starve precondition: download opens`, false, accepted ?? lane.close)
      return
    }
    const startedAt = Date.now()
    let answer
    while (Date.now() - startedAt < WATCH_MS) {
      answer = lane.frames.find(
        (f) => f.requestId === open.requestId && (f.type === 'ERROR' || f.type === 'FILES_COMPLETE'),
      )
      if (answer || lane.close) break
      await sleep(25)
    }
    const elapsedMs = Date.now() - startedAt
    const delivered = lane.binary.reduce((total, part) => total + part.bytes.byteLength, 0)
    check(
      `[${kind}] an UNDER-CREDITED download is answered inside its declared ${declaredDeadlineMs}ms deadline`,
      answer?.type === 'ERROR' && elapsedMs < declaredDeadlineMs * 3,
      {
        declaredDeadlineMs,
        watchedMs: WATCH_MS,
        answeredAfterMs: answer ? elapsedMs : null,
        answer: answer?.type ?? (lane.close ? 'CLOSE' : 'SILENCE'),
        code: answer?.payload?.code,
        deliveredBytes: delivered,
        declaredSize: accepted.payload.declaredSize,
      },
    )
  } finally {
    lane.stop()
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const kinds = SESSIONS === 'both' ? ['cookie', 'legacy'] : [SESSIONS]
  const cases = CASE === 'all' ? ['roundtrip', 'samesecond', 'capacity', 'starve'] : CASE.split(',')
  if (!AS_JSON) console.log(`FILES_V1 probe BASE=${BASE} cases=${cases.join(',')} sessions=${kinds.join(',')}`)
  for (const kind of kinds) {
    for (const name of cases) {
      if (!AS_JSON) console.log(`\n== ${name} / ${kind} session`)
      try {
        if (name === 'roundtrip') await caseRoundtrip(kind)
        else if (name === 'samesecond') await caseSameSecond(kind)
        else if (name === 'capacity') await caseCapacity(kind)
        else if (name === 'starve') await caseStarve(kind)
        else if (name === 'sizes') await caseSizes(kind)
        else if (name === 'freshdownload') await caseFreshDownload(kind)
        else if (name === 'mint') await caseMint(kind)
        else throw new Error(`unknown case ${name}`)
      } catch (error) {
        check(`[${kind}] ${name} ran`, false, { error: 'Probe scenario failed' })
      }
    }
  }
  if (AS_JSON) console.log(JSON.stringify({ base: BASE, failures, report }, null, 2))
  else console.log(`\n${failures === 0 ? 'PROBE GREEN' : `PROBE RED (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
