import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// SIGN-OUT WITH PENDING DIRTY items. UserService.signOut(force=false) does NOT
// flush before signing out — with unsynced dirty items it raises a confirm()
// warning ("...changes will be lost forever...") and, on confirm, calls
// storage.clearAllData(), DROPPING the unsynced edits. The headless
// NodeAlertService.confirm() returns true, so this spec proves the live contract:
//   1. the warning IS raised (confirm called) when dirty items exist,
//   2. after confirm=true the unsynced edit is DROPPED, not flushed — a fresh
//      device signing in sees the last SYNCED body, never the dropped edit, and
//   3. a NORMAL sign-out AFTER a clean sync raises no warning and loses nothing.
//
// This is by-design (warned) but is genuine data loss on confirm; the warning is
// the only guard. Reported as a contract confirmation, not a new bug.
async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // ===== Part 1: sign-out with a PENDING DIRTY (never-synced) edit =====
  const A = await freshAccount()
  const appA = A.app.app
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const note = await clientA.createNote({ title: 'Dirty', body: 'synced-base', tags: [] })
  await A.app.sync() // base body is now on the server

  // Make an edit and DO NOT sync — it stays dirty (queued, never uploaded).
  await appA.mutator.changeItem(
    appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === note.uuid),
    (m: { text: string }) => {
      m.text = 'UNSYNCED-edit-should-be-dropped'
    },
  )
  const dirty = appA.items.getDirtyItems?.() ?? []
  check('there is a pending dirty (unsynced) item before sign-out', dirty.some((i: { uuid: string }) => i.uuid === note.uuid))

  // Instrument the shared alert service to observe the warning path. (Dependencies
  // registers a single AlertService instance, so UserService.signOut sees this.)
  let confirmCalls = 0
  let lastConfirmText = ''
  const alerts = appA.alerts
  const origConfirm = alerts.confirm.bind(alerts)
  alerts.confirm = async (text?: string): Promise<boolean> => {
    confirmCalls += 1
    lastConfirmText = String(text ?? '')
    return origConfirm(text)
  }

  // Non-forced sign-out with dirty items -> warns, then (confirm=true) drops.
  await appA.user.signOut(false)
  check('sign-out with dirty items RAISED the data-loss warning (confirm called)', confirmCalls === 1)
  check('the warning text names the unsynced-change loss', /unsynced|lost forever/i.test(lastConfirmText))
  console.log('  info - warning text:', JSON.stringify(lastConfirmText))

  // signOut already cleared local storage + workspace keys; a manual deinit now
  // would double-tear-down (the headless app has no framework to auto-deinit on
  // the SignedOut event). Guard it — this teardown is not what's under test.
  await A.app.deinit().catch(() => {})
  await fs.rm(A.dataDir, { recursive: true, force: true })

  // Fresh device: the server must still hold the SYNCED base body; the dropped
  // unsynced edit must NOT be present (proving no pre-sign-out flush occurred).
  const dirF = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-signout-fresh-'))
  const appF = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirF, password: A.password, syncIntervalMs: 0 })
  await appF.signIn(A.email, A.password)
  let fresh: any
  for (let i = 0; i < 8; i++) {
    await appF.sync()
    fresh = appF.app.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === note.uuid)
    if (fresh) break
    await sleep(500)
  }
  check('fresh device still has the note (synced base survived)', !!fresh)
  check('fresh device shows the SYNCED base body — the unsynced edit was DROPPED, not flushed', fresh?.text === 'synced-base')
  if (fresh?.text === 'UNSYNCED-edit-should-be-dropped') {
    console.log('  info - NOTE: the unsynced edit was FLUSHED before sign-out (would contradict the source contract).')
  } else {
    console.log("  info - VERDICT: contract confirmed — snjs WARNS then DROPS unsynced dirty items on non-forced sign-out (no flush).")
  }
  await cleanup(appF, dirF)

  // ===== Part 2: NORMAL sign-out AFTER a clean sync loses nothing =====
  const B = await freshAccount()
  const clientB = new SnjsBackedClient(B.app, { allowWrites: true, baseUrl: SERVER })
  const clean = await clientB.createNote({ title: 'Clean', body: 'clean-synced-body', tags: [] })
  await B.app.sync()
  const noDirty = B.app.app.items.getDirtyItems?.() ?? []
  check('after a full sync there are no dirty items pending', noDirty.length === 0)

  let bConfirmCalls = 0
  const bAlerts = B.app.app.alerts
  const bOrig = bAlerts.confirm.bind(bAlerts)
  bAlerts.confirm = async (t?: string): Promise<boolean> => {
    bConfirmCalls += 1
    return bOrig(t)
  }
  await B.app.app.user.signOut(false)
  check('clean sign-out (no dirty items) raises NO data-loss warning', bConfirmCalls === 0)
  await B.app.deinit().catch(() => {})
  await fs.rm(B.dataDir, { recursive: true, force: true })

  const dirB2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-signout-clean-'))
  const appB2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirB2, password: B.password, syncIntervalMs: 0 })
  await appB2.signIn(B.email, B.password)
  let cleanFresh: any
  for (let i = 0; i < 8; i++) {
    await appB2.sync()
    cleanFresh = appB2.app.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === clean.uuid)
    if (cleanFresh) break
    await sleep(500)
  }
  check('after a clean sign-out + re-sign-in, the synced note is intact (no loss)', cleanFresh?.text === 'clean-synced-body')
  await cleanup(appB2, dirB2)

  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
