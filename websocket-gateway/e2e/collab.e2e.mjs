/**
 * End-to-end test for the collaborative-editing (yjs) RELAY path, run against
 * the LIVE gateway (:3106). Proves the Tier-3 transport:
 *   1. Two clients that join the same room exchange yjs frames (A -> B).
 *   2. Awareness frames relay the same way.
 *   3. A client in a DIFFERENT room does NOT receive the frames (isolation).
 *   4. The sender never receives its own frame (no echo).
 *   5. Joining a room asks existing members to re-sync (room-sync handshake).
 *
 * The gateway relays opaque base64 payloads; in production those are
 * E2E-encrypted yjs updates the gateway cannot read. Here we use a plain marker.
 *
 * Usage: node e2e/collab.e2e.mjs   (requires the gateway up)
 */
import { WebSocket } from 'ws'

const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3106'
const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3106'
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok   - ${name}`)
  else {
    console.log(`  FAIL - ${name}`)
    failures++
  }
}

async function mint(userUuid, sessionUuid) {
  const res = await fetch(`${GATEWAY_HTTP}/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ userUuid, sessionUuid }),
  })
  return (await res.json()).token
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS}/?authToken=${token}`)
    const received = []
    ws.on('message', (d) => received.push(String(d)))
    ws.on('open', () => resolve({ ws, received }))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ws open timeout')), 8000)
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const health = await fetch(`${GATEWAY_HTTP}/health`).then((r) => r.status).catch(() => 0)
  if (health !== 200) {
    console.log('SKIP: gateway not reachable on', GATEWAY_HTTP, '(start the stack first)')
    process.exit(0)
  }

  // Two collaborators (different users) editing the same note, plus a bystander
  // in another room.
  const ta = await mint('collab-a-' + Date.now(), 'sa')
  const tb = await mint('collab-b-' + Date.now(), 'sb')
  const tc = await mint('collab-c-' + Date.now(), 'sc')
  const A = await connect(ta)
  const B = await connect(tb)
  const C = await connect(tc)
  await wait(300)

  const ROOM = 'note-' + Date.now()
  A.ws.send(JSON.stringify({ t: 'room-join', room: ROOM }))
  await wait(150)
  B.ws.send(JSON.stringify({ t: 'room-join', room: ROOM }))
  await wait(250)
  C.ws.send(JSON.stringify({ t: 'room-join', room: 'other-room' }))
  await wait(250)

  // 5. B joining should have prompted A to re-sync.
  check('existing member is asked to re-sync on join', A.received.some((m) => m.includes('"t":"room-sync"')))

  // 1. A sends a yjs update; B receives it, A does not, C does not.
  const bBefore = B.received.length
  const aBefore = A.received.length
  const cBefore = C.received.length
  A.ws.send(JSON.stringify({ t: 'yjs', room: ROOM, payload: 'WUpTLVVQREFURQ==' }))
  await wait(500)
  check('peer in the same room receives the yjs frame', B.received.some((m) => m.includes('WUpTLVVQREFURQ==')))
  check('sender does not receive its own frame', A.received.length === aBefore)
  check('client in a different room is isolated', C.received.length === cBefore)
  void bBefore

  // 2. Awareness relays too (B -> A).
  B.ws.send(JSON.stringify({ t: 'awareness', room: ROOM, payload: 'Q1VSU09S' }))
  await wait(500)
  check('awareness frame relays to peer', A.received.some((m) => m.includes('Q1VSU09S')))

  // 3. After A leaves, B's update reaches nobody (A no longer in room).
  A.ws.send(JSON.stringify({ t: 'room-leave', room: ROOM }))
  await wait(200)
  const aAfterLeave = A.received.length
  B.ws.send(JSON.stringify({ t: 'yjs', room: ROOM, payload: 'QUZURVJMRUFWRQ==' }))
  await wait(400)
  check('left member no longer receives room frames', A.received.length === aAfterLeave)

  A.ws.close()
  B.ws.close()
  C.ws.close()

  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
