/**
 * End-to-end CRDT convergence through the LIVE gateway relay, with REAL AES-GCM
 * encryption — exercising the exact wire path the web EncryptedYjsProvider uses,
 * but cross-process so it proves the whole transport+crypto stack:
 *   two yjs docs, each on its own real WebSocket to the gateway, in the same
 *   room, exchanging HKDF-derived AES-256-GCM-encrypted yjs updates. Edits on one
 *   converge to the other, and the bytes on the wire are ciphertext (the gateway
 *   never sees plaintext).
 *
 * Mirrors src/.../Collaboration/{EncryptedYjsProvider,RoomCrypto}.ts. Usage:
 *   node e2e/collab-yjs.e2e.mjs   (requires the gateway up)
 */
import { WebSocket } from 'ws'
import { webcrypto as crypto } from 'node:crypto'
import * as Y from 'yjs'

const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3106'
const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3106'
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'

let failures = 0
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// --- crypto (mirrors RoomCrypto.ts) ---------------------------------------
const b64 = (u) => Buffer.from(u).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))

async function deriveRoomKey(secret, room) {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('srn-collab-v1'), info: enc.encode(room) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  const joined = new Uint8Array(iv.length + ct.length)
  joined.set(iv, 0)
  joined.set(ct, iv.length)
  return b64(joined)
}
async function decrypt(key, payload) {
  const joined = unb64(payload)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: joined.subarray(0, 12) }, key, joined.subarray(12))
  return new Uint8Array(pt)
}

async function mint(userUuid, sessionUuid) {
  const res = await fetch(`${GATEWAY_HTTP}/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ userUuid, sessionUuid }),
  })
  return (await res.json()).token
}

// A minimal provider mirroring EncryptedYjsProvider over a real socket.
function makeProvider(ws, doc, room, key, seenCiphertexts) {
  doc.on('update', async (update, origin) => {
    if (origin === 'remote') return
    const payload = await encrypt(key, update)
    ws.send(JSON.stringify({ t: 'yjs', room, payload }))
  })
  ws.on('message', async (data) => {
    const raw = data.toString()
    if (raw === 'pong') return
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.room !== room) return
    if (frame.t === 'room-sync') {
      ws.send(JSON.stringify({ t: 'yjs', room, payload: await encrypt(key, Y.encodeStateAsUpdate(doc)) }))
    } else if (frame.t === 'yjs') {
      seenCiphertexts.push(frame.payload)
      Y.applyUpdate(doc, await decrypt(key, frame.payload), 'remote')
    }
  })
  ws.send(JSON.stringify({ t: 'room-join', room }))
}

function open(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS}/?authToken=${token}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('open timeout')), 8000)
  })
}

async function main() {
  const health = await fetch(`${GATEWAY_HTTP}/health`).then((r) => r.status).catch(() => 0)
  if (health !== 200) {
    console.log('SKIP: gateway not reachable on', GATEWAY_HTTP)
    process.exit(0)
  }

  const room = 'note-' + Date.now()
  const secret = 'shared-vault-secret'
  const keyA = await deriveRoomKey(secret, room)
  const keyB = await deriveRoomKey(secret, room)

  const wsA = await open(await mint('yjs-a-' + Date.now(), 'sa'))
  const docA = new Y.Doc()
  const seenA = []
  makeProvider(wsA, docA, room, keyA, seenA)
  await wait(300)

  // B joins after A already has content -> must converge via room-sync.
  docA.getText('content').insert(0, 'Alice was here. ')
  await wait(300)

  const wsB = await open(await mint('yjs-b-' + Date.now(), 'sb'))
  const docB = new Y.Doc()
  const seenB = []
  makeProvider(wsB, docB, room, keyB, seenB)
  await wait(700)

  check('late joiner converged to existing content', docB.getText('content').toString() === 'Alice was here. ')

  // Concurrent edits from both sides merge.
  docA.getText('content').insert(docA.getText('content').length, '[A2]')
  docB.getText('content').insert(0, '[B1]')
  await wait(900)

  const a = docA.getText('content').toString()
  const b = docB.getText('content').toString()
  check('both docs converged to an identical string', a === b)
  check('merged text contains all three edits', a.includes('Alice was here.') && a.includes('[A2]') && a.includes('[B1]'))

  // Confidentiality: what crossed the wire was ciphertext, not the plaintext.
  const wirePayloads = [...seenA, ...seenB]
  const anyPlaintextLeaked = wirePayloads.some((p) => {
    try {
      return Buffer.from(p, 'base64').toString('utf8').includes('Alice was here')
    } catch {
      return false
    }
  })
  check('relayed payloads are encrypted (no plaintext on the wire)', wirePayloads.length > 0 && !anyPlaintextLeaked)

  wsA.close()
  wsB.close()
  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
