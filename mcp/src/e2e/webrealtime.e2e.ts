import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, GATEWAY_WS, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// WHOLE-SYSTEM web realtime path — the exact chain a browser uses, which the
// other realtime tests bypass by minting at the gateway's internal endpoint:
//
//   authenticated client --POST /v1/sockets/tokens--> api-gateway
//     -> (auth middleware reads the session) -> DirectCallServiceProxy
//     -> (x-internal-secret) -> websocket-gateway mints a connection token
//   client --ws authToken--> websocket-gateway  (token verified)
//   client saves a note -> syncing-server emits -> SNS/SQS -> gateway -> push
//
// Proves the api-gateway proxy, the cookie session auth, the cross-service
// internal-secret alignment, AND the gateway push, all together.
async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // "Browser" session: registering populates the polyfill cookie jar with this
  // session's cookies, so the token request below carries them like a logged-in
  // browser would.
  const { app, email, password, dataDir } = await freshAccount()

  // The browser authenticates with the bearer access token AND the session
  // cookies (the server requires both for a cookie-based session — see #74). The
  // cookie jar adds the cookies; supply the bearer token from the live session.
  const session = app.app.sessions.getSession?.()
  const accessToken: string | undefined = session?.accessToken?.value ?? session?.accessToken
  check('bridge has a live session access token', typeof accessToken === 'string' && accessToken.length > 0)

  const res = await fetch(`${SERVER}/v1/sockets/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: '{}',
  })
  const body = (await res.json().catch(() => ({}))) as { token?: string; data?: { token?: string } }
  const token = body.token ?? body.data?.token
  check(
    'api-gateway /v1/sockets/tokens mints a token for an authenticated session',
    res.status === 200 && typeof token === 'string' && token.length > 0,
  )

  // A SECOND device on the same account makes the change. (The browser session is
  // correctly excluded from pushes for its OWN edits, so the writer must be a
  // different session — exactly the cross-device case the push path exists for.)
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-webrt-2-'))
  const app2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password, syncIntervalMs: 0 })
  await app2.signIn(email, password)
  const writer = new SnjsBackedClient(app2, { allowWrites: true, baseUrl: SERVER })

  const pushed = await new Promise<string | null>((resolve) => {
    const ws = new WebSocket(`${GATEWAY_WS}/?authToken=${token}`)
    ws.onopen = async () => {
      await new Promise((r) => setTimeout(r, 1000))
      await writer.createNote({ title: 'Web realtime', body: 'via api-gateway token', tags: [] })
    }
    ws.onmessage = (ev: MessageEvent) => resolve(String(ev.data))
    ws.onerror = () => resolve(null)
    setTimeout(() => resolve(null), 40000)
  })
  check(
    'browser socket (api-gateway token) receives a push for another device\'s edit',
    !!pushed && pushed.includes('ITEMS_CHANGED_ON_SERVER'),
  )

  await cleanup(app2, dir2)
  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
