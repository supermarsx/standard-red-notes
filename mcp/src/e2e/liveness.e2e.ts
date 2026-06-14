import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, GATEWAY_HTTP, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Liveness/health e2e: proves the STACK is reachable AND the bridge is genuinely
// live — authenticated, its first online sync completed (not silently stuck in
// offline/download-only mode, the bug that #74 fixed), writes leave no dirty
// residue, and the background sync loop actually keeps pulling remote changes.

const dirtyCount = (app: HeadlessApp): number => (app.app.items.getDirtyItems?.() ?? []).length

async function registerWithRetry(app: HeadlessApp, email: string, password: string): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < 3; i++) {
    try {
      await app.register(email, password)
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

async function main(): Promise<void> {
  // 1. Stack liveness — both self-hosted services answer their health endpoints.
  const serverHealthy = await serverUp()
  check('server /healthcheck is 200', serverHealthy)
  const gw = await fetch(`${GATEWAY_HTTP}/health`).then((r) => r.status).catch(() => 0)
  check('gateway /health is 200', gw === 200)
  if (!serverHealthy) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // 2. Bridge liveness — sign in, and confirm it is actually ONLINE (an online
  //    first-sync completed). If this is false the bridge is stuck offline and
  //    writes would never upload.
  const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-live-1-'))
  const stamp = Date.now() + '-' + Math.floor(performance.now())
  const email = `e2e-live-${stamp}@example.com`
  const password = `pw-${stamp}-correcthorse`
  const app1 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir1, password, syncIntervalMs: 1500 })
  await registerWithRetry(app1, email, password)

  check('bridge reports signed in', app1.isSignedIn())
  check('session layer is authenticated', app1.app.sessions.isSignedIn() === true)
  check('online download-first sync completed (not stuck offline)', app1.app.sync.completedOnlineDownloadFirstSync === true)

  // 3. A synced write leaves nothing dirty (the write truly uploaded).
  const c1 = new SnjsBackedClient(app1, { allowWrites: true, baseUrl: SERVER })
  await c1.createNote({ title: 'Liveness seed', body: 'x', tags: [] })
  check('no dirty items remain after a synced write', dirtyCount(app1) === 0)

  // 4. Background sync-loop liveness — a SECOND device creates a note; the bridge
  //    must pick it up via its polling loop WITHOUT us calling sync on it.
  app1.startSyncLoop()
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-live-2-'))
  const app2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password, syncIntervalMs: 0 })
  await app2.signIn(email, password)
  const c2 = new SnjsBackedClient(app2, { allowWrites: true, baseUrl: SERVER })
  const remote = await c2.createNote({ title: 'From device 2', body: 'pulled by loop', tags: [] })

  const deadline = Date.now() + 15000
  let pulled = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    // Read the local store directly — deliberately do NOT call app1.sync().
    if (app1.app.items.getDisplayableNotes().some((n: { uuid: string }) => n.uuid === remote.uuid)) {
      pulled = true
      break
    }
  }
  check('background sync loop pulled a remote note with no manual sync', pulled)

  // 5. After several loop cycles the bridge is still alive (no silent drop).
  check('bridge still signed in after loop cycles', app1.isSignedIn())
  check('session still authenticated after loop cycles', app1.app.sessions.isSignedIn() === true)
  check('no dirty residue accumulated during the loop', dirtyCount(app1) === 0)

  await cleanup(app2, dir2)
  await cleanup(app1, dir1)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
