import { check, cleanup, finish, freshAccount, GATEWAY_HTTP, GATEWAY_WS, INTERNAL_SECRET, SERVER, serverUp } from './helpers.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// FULL realtime chain: a note saved through the bridge → server emits
// WEB_SOCKET_MESSAGE_REQUESTED → SNS/SQS → gateway → push delivered to a
// connected WebSocket. Requires the stack (server + gateway) up.
async function main() {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }
  const gwUp = await fetch(`${GATEWAY_HTTP}/health`).then((r) => r.status).catch(() => 0)
  if (gwUp !== 200) {
    console.log('SKIP: gateway not reachable on', GATEWAY_HTTP)
    process.exit(0)
  }

  const { app, dataDir } = await freshAccount()
  const userUuid: string = (app.app as { sessions: { getSureUser(): { uuid: string } } }).sessions.getSureUser().uuid

  const mint = await fetch(`${GATEWAY_HTTP}/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ userUuid, sessionUuid: 'e2e-listener' }),
  })
  const { token } = (await mint.json()) as { token: string }
  check('connection token minted', typeof token === 'string')

  const pushed = await new Promise<string | null>((resolve) => {
    const ws = new WebSocket(`${GATEWAY_WS}/?authToken=${token}`)
    ws.onopen = async () => {
      await new Promise((r) => setTimeout(r, 1500))
      const client = new SnjsBackedClient(app, { allowWrites: true, baseUrl: SERVER })
      await client.createNote({ title: 'Realtime', body: 'push me', tags: [] })
    }
    ws.onmessage = (ev: MessageEvent) => resolve(String(ev.data))
    ws.onerror = () => resolve(null)
    setTimeout(() => resolve(null), 40000)
  })

  check('realtime push delivered (save -> emit -> SNS/SQS -> gateway -> socket)', !!pushed && pushed.includes('ITEMS_CHANGED_ON_SERVER'))

  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
