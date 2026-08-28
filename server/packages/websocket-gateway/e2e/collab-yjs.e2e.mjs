/**
 * Required-capable encrypted Yjs convergence test for the integrated gateway.
 *
 * Defaults target the api-gateway process used by the production Compose stack:
 *
 *   REQUIRE_GATEWAY=1 \
 *   GATEWAY_HTTP=http://127.0.0.1:3000 \
 *   GATEWAY_WS=ws://127.0.0.1:3000/sockets \
 *   node e2e/collab-yjs.e2e.mjs
 *
 * With REQUIRE_GATEWAY=1 an unreachable gateway is a failure, never a skip.
 */
import { WebSocket } from 'ws'
import { webcrypto as crypto, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import * as Y from 'yjs'

const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3000'
const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3000/sockets'
const GATEWAY_HEALTH_PATH = process.env.GATEWAY_HEALTH_PATH ?? '/healthcheck/readiness'
const REQUIRE_GATEWAY = process.env.REQUIRE_GATEWAY === '1'
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'
const CONNECTION_TOKEN_SECRET =
  process.env.WEB_SOCKET_CONNECTION_TOKEN_SECRET ?? 'dev-ws-connection-token-secret-change-me'
const COLLABORATION_HKDF_SALT = 'Standard Red Notes encrypted collaboration room key v1'
const COLLABORATION_PROTOCOL_VERSION = 3

// Protocol v3 binds every room membership to a room epoch and a security epoch
// (`586bcbb7`): `room-reserve`/`room-join` must carry `expectedRoomEpoch`, and
// the capability must pin the identical pair. Real clients learn the pair from
// the one-use COLLABORATION_AUTHORIZATION epoch-discovery handshake; this
// harness already mints its own capability with the connection-token secret
// (exactly what `defaultRoomJoinAuthorizer` verifies), so it seeds the pair
// itself. These are only the OPENING values: the room's epoch is owned by the
// gateway from the first reservation onwards, and `connect()` below adopts
// whatever epoch the gateway reports back.
//
// Hex, not base64url, for the same reason the discovery challenge is hex
// (`f34e333e`): epochs are echoed through identifier validation, and a leading
// `-`/`_` would make a fraction of runs fail while the rest passed.
const epoch = () => randomBytes(16).toString('hex')
const ROOM_EPOCH = epoch()
const COLLABORATION_SECURITY_EPOCH = epoch()

const YJS_CHUNK_PLAINTEXT_BYTES = 128 * 1024
const MAX_YJS_TRANSFER_BYTES = 4 * 1024 * 1024
const PEER_FLUSH_TIMEOUT_MS = 10_000

let failures = 0
const check = (name, condition) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} - ${name}`)
  if (!condition) failures++
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, description, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(25)
  }
  throw new Error(`timeout waiting for ${description}`)
}

const b64 = (value) => Buffer.from(value).toString('base64')
const unb64 = (value) => new Uint8Array(Buffer.from(value, 'base64'))

async function deriveRoomKey(secret, keyScope, noteUuid) {
  const encoder = new TextEncoder()
  const secretBytes = encoder.encode(secret)
  try {
    const source = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(COLLABORATION_HKDF_SALT),
        info: encoder.encode(`scope=${keyScope}\u0000note=${noteUuid}`),
      },
      source,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    secretBytes.fill(0)
  }
}

const chunkAdditionalData = ({ room, transferId, index, count, totalBytes, stateRequestId }) =>
  new TextEncoder().encode(
    JSON.stringify([
      'standard-red-notes:yjs-chunk:v2',
      COLLABORATION_PROTOCOL_VERSION,
      room,
      transferId,
      index,
      count,
      totalBytes,
      stateRequestId ?? null,
    ]),
  )

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

async function encrypt(key, plaintext, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(additionalData ? { additionalData } : {}) }, key, plaintext),
  )
  const joined = new Uint8Array(iv.length + ciphertext.length)
  joined.set(iv, 0)
  joined.set(ciphertext, iv.length)
  return b64(joined)
}

async function decrypt(key, payload, additionalData) {
  const joined = unb64(payload)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: joined.subarray(0, 12), ...(additionalData ? { additionalData } : {}) },
    key,
    joined.subarray(12),
  )
  return new Uint8Array(plaintext)
}

function roomCapability(userUuid, room, leaseRequestId, roomEpoch, bootstrapChallenge) {
  return jwt.sign(
    {
      purpose: 'collab-room',
      userUuid,
      room,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      collaborationAuthorizationIssuedAt: 1,
      serverUpdatedAtTimestamp: 1,
      roomEpoch,
      collaborationSecurityEpoch: COLLABORATION_SECURITY_EPOCH,
      leaseRequestId,
      ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
    },
    CONNECTION_TOKEN_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: 300,
    },
  )
}

async function mint(userUuid, sessionUuid) {
  const response = await fetch(new URL('/sockets/tokens', GATEWAY_HTTP), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ userUuid, sessionUuid }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) {
    throw new Error(`token mint returned ${response.status}`)
  }
  const body = await response.json()
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('token mint returned no token')
  }
  return body.token
}

function open(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(GATEWAY_WS)
    url.searchParams.set('authToken', token)
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.terminate()
      reject(new Error('websocket open timeout'))
    }, 8_000)
    socket.once('open', () => {
      clearTimeout(timeout)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

class EncryptedPeer {
  constructor(userUuid, room, key) {
    this.userUuid = userUuid
    this.room = room
    this.key = key
    this.doc = new Y.Doc()
    this.seenCiphertexts = []
    this.socket = undefined
    this.joined = false
    this.stateServingReady = false
    this.requestId = undefined
    this.reservation = undefined
    this.denied = false
    this.deniedRoomEpoch = undefined
    this.roomEpoch = ROOM_EPOCH
    this.awaitingStateRequestId = undefined
    this.pendingResponseClaims = new Set()
    this.awaitingAcceptances = new Set()
    this.acceptedTransfers = new Set()
    this.pending = new Set()
    this.pendingError = undefined
    this.doc.on('update', (update, origin) => {
      if (origin === this || !this.joined || !this.stateServingReady || !this.socket) return
      this.track(this.sendUpdate(update))
    })
    this.inboundTransfers = new Map()
  }

  async connect(sessionUuid) {
    const socket = await open(await mint(this.userUuid, sessionUuid))
    this.socket = socket
    this.joined = false
    this.stateServingReady = false
    this.denied = false
    this.awaitingStateRequestId = undefined
    this.pendingResponseClaims.clear()
    this.awaitingAcceptances.clear()
    this.acceptedTransfers.clear()
    this.requestId = `e2e-${sessionUuid}-${crypto.randomUUID()}`
    this.reservation = undefined
    socket.on('close', () => {
      if (this.socket === socket) {
        this.joined = false
        this.stateServingReady = false
        this.socket = undefined
      }
    })
    socket.on('message', (data) => this.onMessage(socket, data.toString()))

    // The gateway rotates a room's epoch as soon as its last editor lease is
    // released (RELEASE_LEASE_SCRIPT rewrites the room-state key once SCARD
    // hits 0), so the epoch this peer used before an offline round is stale by
    // the time it reconnects. That is deliberate: a stale reservation is denied
    // with `room-denied` carrying the room's current epoch, exactly so the
    // client can adopt it and re-reserve. Production does the same thing by
    // re-running epoch discovery for every activation, which yields whatever
    // epoch the room currently has. Mirror that here rather than pinning one
    // epoch for the process lifetime.
    for (let attempt = 0; attempt < 3 && !this.reservation; attempt++) {
      this.denied = false
      this.deniedRoomEpoch = undefined
      this.requestId = `e2e-${sessionUuid}-${crypto.randomUUID()}`
      socket.send(
        JSON.stringify({
          t: 'room-reserve',
          room: this.room,
          cap: roomCapability(this.userUuid, this.room, this.requestId, this.roomEpoch),
          requestId: this.requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: this.roomEpoch,
        }),
      )
      await waitFor(() => this.reservation || this.denied, `${this.userUuid} room reservation`)
      if (this.denied && this.deniedRoomEpoch && this.deniedRoomEpoch !== this.roomEpoch) {
        this.roomEpoch = this.deniedRoomEpoch
      }
    }

    const shouldBootstrap = this.reservation?.bootstrap
    const challengeIsValid =
      shouldBootstrap === true
        ? typeof this.reservation?.bootstrapChallenge === 'string' && this.reservation.bootstrapChallenge.length > 0
        : shouldBootstrap === false && this.reservation?.bootstrapChallenge === undefined
    if (
      !this.reservation ||
      this.reservation?.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
      this.reservation?.maxTransferBytes !== MAX_YJS_TRANSFER_BYTES ||
      this.reservation?.roomEpoch !== this.roomEpoch ||
      typeof shouldBootstrap !== 'boolean' ||
      !challengeIsValid
    ) {
      throw new Error(`${this.userUuid} received an invalid room reservation`)
    }
    this.denied = false
    socket.send(
      JSON.stringify({
        t: 'room-join',
        room: this.room,
        cap: roomCapability(
          this.userUuid,
          this.room,
          this.requestId,
          this.roomEpoch,
          this.reservation.bootstrapChallenge,
        ),
        requestId: this.requestId,
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: this.roomEpoch,
      }),
    )
    await waitFor(() => this.joined || this.denied, `${this.userUuid} room join`)
    if (!this.joined || this.denied) {
      throw new Error(`${this.userUuid} room activation was denied`)
    }
    if (this.stateServingReady) {
      return
    }
    const stateRequestId = `state-${crypto.randomUUID()}`
    this.awaitingStateRequestId = stateRequestId
    socket.send(
      JSON.stringify({
        t: 'yjs-retry',
        room: this.room,
        requestId: stateRequestId,
        requesterClientId: this.doc.clientID,
      }),
    )
    await waitFor(() => this.stateServingReady, `${this.userUuid} correlated state establishment`, 15_000)
  }

  async disconnect() {
    const socket = this.socket
    this.joined = false
    this.stateServingReady = false
    this.awaitingStateRequestId = undefined
    this.pendingResponseClaims.clear()
    this.awaitingAcceptances.clear()
    this.acceptedTransfers.clear()
    this.socket = undefined
    if (!socket || socket.readyState === WebSocket.CLOSED) return
    const closed = new Promise((resolve) => socket.once('close', resolve))
    socket.close()
    await Promise.race([closed, wait(2_000)])
  }

  async flush() {
    const deadline = Date.now() + PEER_FLUSH_TIMEOUT_MS
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`${this.userUuid} pending encrypted work did not settle`)
      }
      let timeout
      try {
        await Promise.race([
          Promise.all([...this.pending]),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`${this.userUuid} pending encrypted work timed out`)),
              remaining,
            )
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    }
    if (this.pendingError) {
      const error = this.pendingError
      this.pendingError = undefined
      throw error
    }
  }

  async broadcastFullState() {
    if (!this.joined || this.socket?.readyState !== WebSocket.OPEN) return
    await this.sendUpdate(Y.encodeStateAsUpdate(this.doc))
  }

  async sendUpdate(update, stateRequestId, awaitAcceptance = false) {
    if (update.byteLength > MAX_YJS_TRANSFER_BYTES) {
      throw new Error('test update exceeds bounded transfer protocol')
    }
    const transferId =
      awaitAcceptance || update.byteLength > YJS_CHUNK_PLAINTEXT_BYTES ? crypto.randomUUID() : undefined
    if (awaitAcceptance && transferId) {
      this.awaitingAcceptances.add(transferId)
    }
    if (update.byteLength <= YJS_CHUNK_PLAINTEXT_BYTES) {
      const payload = await encrypt(this.key, update, frameAdditionalData(this.room, 'yjs', transferId, stateRequestId))
      if (this.joined && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            t: 'yjs',
            room: this.room,
            payload,
            ...(transferId ? { transferId } : {}),
            ...(stateRequestId ? { stateRequestId } : {}),
          }),
        )
      }
    } else {
      const count = Math.ceil(update.byteLength / YJS_CHUNK_PLAINTEXT_BYTES)
      for (let index = 0; index < count; index++) {
        const start = index * YJS_CHUNK_PLAINTEXT_BYTES
        const metadata = {
          room: this.room,
          transferId,
          index,
          count,
          totalBytes: update.byteLength,
          ...(stateRequestId ? { stateRequestId } : {}),
        }
        const payload = await encrypt(
          this.key,
          update.subarray(start, start + YJS_CHUNK_PLAINTEXT_BYTES),
          chunkAdditionalData(metadata),
        )
        if (this.joined && this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(
            JSON.stringify({
              t: 'yjs-chunk',
              room: this.room,
              transferId,
              index,
              count,
              totalBytes: update.byteLength,
              payload,
              ...(stateRequestId ? { stateRequestId } : {}),
            }),
          )
        }
      }
    }
    if (awaitAcceptance && transferId) {
      try {
        await waitFor(
          () => this.acceptedTransfers.delete(transferId),
          `${this.userUuid} accepted transfer ${transferId}`,
          10_000,
        )
      } finally {
        this.awaitingAcceptances.delete(transferId)
        this.acceptedTransfers.delete(transferId)
      }
    }
  }

  async applyReceivedUpdate(update, stateRequestId) {
    if (!this.joined) return
    Y.applyUpdate(this.doc, update, this)
    if (!stateRequestId || stateRequestId !== this.awaitingStateRequestId) return
    this.awaitingStateRequestId = undefined
    await this.sendUpdate(Y.encodeStateAsUpdate(this.doc), undefined, true)
    if (this.joined) {
      this.stateServingReady = true
    }
  }

  onMessage(socket, raw) {
    if (socket !== this.socket || raw === 'pong') return
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.room !== this.room) return
    if (frame.t === 'room-reserved' && frame.requestId === this.requestId) {
      this.reservation = frame
    } else if (frame.t === 'room-denied' && frame.requestId === this.requestId) {
      this.denied = true
      // Carries the room's current epoch when the denial was an epoch mismatch.
      if (typeof frame.roomEpoch === 'string' && frame.roomEpoch.length > 0) {
        this.deniedRoomEpoch = frame.roomEpoch
      }
    } else if (
      frame.t === 'room-joined' &&
      frame.requestId === this.requestId &&
      frame.protocolVersion === COLLABORATION_PROTOCOL_VERSION &&
      frame.maxTransferBytes === MAX_YJS_TRANSFER_BYTES &&
      frame.bootstrap === this.reservation?.bootstrap
    ) {
      this.joined = true
      this.stateServingReady = frame.bootstrap === true
    } else if (frame.t === 'room-sync') {
      this.track(this.broadcastFullState())
    } else if (
      frame.t === 'yjs-retry' &&
      this.joined &&
      this.stateServingReady &&
      frame.requesterClientId !== this.doc.clientID &&
      !this.pendingResponseClaims.has(frame.requestId)
    ) {
      this.pendingResponseClaims.add(frame.requestId)
      this.socket?.send(
        JSON.stringify({
          t: 'yjs-response-claim',
          room: this.room,
          stateRequestId: frame.requestId,
          leaseRequestId: this.requestId,
        }),
      )
    } else if (
      frame.t === 'yjs-response-granted' &&
      frame.protocolVersion === COLLABORATION_PROTOCOL_VERSION &&
      frame.leaseRequestId === this.requestId &&
      this.pendingResponseClaims.delete(frame.stateRequestId)
    ) {
      this.track(this.sendUpdate(Y.encodeStateAsUpdate(this.doc), frame.stateRequestId, true))
    } else if (
      frame.t === 'yjs-accepted' &&
      frame.protocolVersion === COLLABORATION_PROTOCOL_VERSION &&
      this.awaitingAcceptances.has(frame.transferId)
    ) {
      this.acceptedTransfers.add(frame.transferId)
    } else if (frame.t === 'yjs' && this.joined) {
      this.seenCiphertexts.push(frame.payload)
      this.track(
        decrypt(
          this.key,
          frame.payload,
          frameAdditionalData(this.room, 'yjs', frame.transferId, frame.stateRequestId),
        ).then((update) => this.applyReceivedUpdate(update, frame.stateRequestId)),
      )
    } else if (frame.t === 'yjs-chunk' && this.joined) {
      this.seenCiphertexts.push(frame.payload)
      this.track(this.receiveChunk(frame))
    }
  }

  async receiveChunk(frame) {
    let transfer = this.inboundTransfers.get(frame.transferId)
    if (!transfer) {
      transfer = {
        count: frame.count,
        totalBytes: frame.totalBytes,
        stateRequestId: frame.stateRequestId,
        chunks: new Map(),
      }
      this.inboundTransfers.set(frame.transferId, transfer)
    }
    if (
      transfer.count !== frame.count ||
      transfer.totalBytes !== frame.totalBytes ||
      transfer.stateRequestId !== frame.stateRequestId ||
      transfer.chunks.has(frame.index)
    ) {
      throw new Error('invalid chunk metadata in live e2e')
    }
    transfer.chunks.set(frame.index, await decrypt(this.key, frame.payload, chunkAdditionalData(frame)))
    if (transfer.chunks.size !== transfer.count) {
      return
    }
    const update = new Uint8Array(transfer.totalBytes)
    for (let index = 0; index < transfer.count; index++) {
      const chunk = transfer.chunks.get(index)
      if (!chunk) {
        throw new Error('missing chunk in live e2e')
      }
      update.set(chunk, index * YJS_CHUNK_PLAINTEXT_BYTES)
    }
    this.inboundTransfers.delete(frame.transferId)
    await this.applyReceivedUpdate(update, transfer.stateRequestId)
  }

  track(promise) {
    const settled = promise
      .catch((error) => {
        this.pendingError ??= error
      })
      .finally(() => this.pending.delete(settled))
    this.pending.add(settled)
  }
}

async function settle(...peers) {
  for (let round = 0; round < 8; round++) {
    await Promise.all(peers.map((peer) => peer.flush()))
    await wait(25)
  }
}

async function main() {
  const healthUrl = new URL(GATEWAY_HEALTH_PATH, GATEWAY_HTTP)
  const health = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) })
    .then((response) => response.status)
    .catch(() => 0)
  if (health !== 200) {
    const message = `gateway not reachable at ${healthUrl} (status ${health})`
    if (REQUIRE_GATEWAY) throw new Error(message)
    console.log(`SKIP: ${message}`)
    return
  }

  const room = `note-${Date.now()}`
  const secret = 'client-only-shared-vault-secret'
  const keyScope = 'shared-vault:e2e-vault'
  const peerA = new EncryptedPeer(`yjs-a-${Date.now()}`, room, await deriveRoomKey(secret, keyScope, room))
  const peerB = new EncryptedPeer(`yjs-b-${Date.now()}`, room, await deriveRoomKey(secret, keyScope, room))
  try {
    console.log('phase: initial encrypted convergence')
    await peerA.connect('session-a-1')
    peerA.doc.getText('content').insert(0, 'Alice was here. ')
    await settle(peerA)
    await peerB.connect('session-b-1')
    await settle(peerA, peerB)
    check('late joiner converged to existing content', peerB.doc.getText('content').toString() === 'Alice was here. ')

    console.log('phase: concurrent online edits')
    peerA.doc.getText('content').insert(peerA.doc.getText('content').length, '[A2]')
    peerB.doc.getText('content').insert(0, '[B1]')
    await settle(peerA, peerB)
    let textA = peerA.doc.getText('content').toString()
    let textB = peerB.doc.getText('content').toString()
    check('concurrent online edits converge', textA === textB)
    check(
      'online merge contains every edit',
      textA.includes('Alice was here.') && textA.includes('[A2]') && textA.includes('[B1]'),
    )

    console.log('phase: encrypted chunk transfer')
    const largeBody = Array.from({ length: 700_000 }, (_, index) => String.fromCharCode(33 + (index % 80))).join('')
    peerA.doc.getText('large-content').insert(0, largeBody)
    await settle(peerA, peerB)
    check(
      'state larger than the legacy 512 KiB frame cap converges through encrypted chunks',
      peerB.doc.getText('large-content').toString() === largeBody,
    )

    console.log('phase: offline edits and reconnect')
    await Promise.all([peerA.disconnect(), peerB.disconnect()])
    peerA.doc.getText('content').insert(peerA.doc.getText('content').length, '[A-offline]')
    peerB.doc.getText('content').insert(0, '[B-offline]')
    check(
      'offline edits remain local before reconnect',
      peerA.doc.getText('content').toString() !== peerB.doc.getText('content').toString(),
    )

    await Promise.all([peerA.connect('session-a-2'), peerB.connect('session-b-2')])
    await settle(peerA, peerB)
    textA = peerA.doc.getText('content').toString()
    textB = peerB.doc.getText('content').toString()
    check('reconnected editors converge', textA === textB)
    check(
      'reconnect merge preserves both offline edits',
      textA.includes('[A-offline]') && textA.includes('[B-offline]'),
    )

    const wirePayloads = [...peerA.seenCiphertexts, ...peerB.seenCiphertexts]
    const plaintextLeaked = wirePayloads.some((payload) => {
      try {
        const decoded = Buffer.from(payload, 'base64').toString('utf8')
        return decoded.includes('Alice was here') || decoded.includes('offline')
      } catch {
        return false
      }
    })
    check('wire payloads are ciphertext, never note plaintext', wirePayloads.length > 0 && !plaintextLeaked)

    console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await Promise.allSettled([peerA.disconnect(), peerB.disconnect()])
    peerA.doc.destroy()
    peerB.doc.destroy()
  }
}

main().catch((error) => {
  console.error('E2E ERROR:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
