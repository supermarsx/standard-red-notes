import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Proves notes actually persist SERVER-SIDE: create on one device, then sign in
// fresh on a SECOND device and confirm the note downloads. (Regression guard for
// the cookie-jar / downloadFirstSync fix — bridge writes were previously
// local-only and never uploaded.)
async function main() {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app: app1, email, password, dataDir: dir1 } = await freshAccount()
  const c1 = new SnjsBackedClient(app1, { allowWrites: true, baseUrl: SERVER })
  const created = await c1.createNote({ title: 'Persisted', body: 'survives relogin', tags: ['t'] })
  check('created + synced', !!created.uuid)
  await cleanup(app1, dir1)

  // Fresh device: a brand-new data dir, sign in, the note must download.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-e2e-2-'))
  const app2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password, syncIntervalMs: 0 })
  await app2.signIn(email, password)
  const c2 = new SnjsBackedClient(app2, { allowWrites: true, baseUrl: SERVER })
  const list = await c2.listNotes(50)
  const found = list.notes.find((n) => n.uuid === created.uuid)
  check('note downloaded on a fresh device (server-side persistence)', !!found)
  check('downloaded note has the right title', found?.title === 'Persisted')
  await cleanup(app2, dir2)

  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
