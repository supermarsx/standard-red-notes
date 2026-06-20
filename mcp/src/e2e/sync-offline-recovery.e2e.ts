import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Integration e2e: OFFLINE-then-RECONNECT durability. A change authored while a
// client is "offline" (never synced) must persist locally, then upload and land
// on a second client once connectivity (sync) resumes. Also verifies a queued
// offline DELETE propagates.
//
//   Device 1 creates noteA + syncs. Device 2 pulls it.
//   Device 1 goes "offline": creates noteB and edits noteA WITHOUT syncing.
//   The offline edits are present locally + marked dirty (queued).
//   Device 1 "reconnects" (syncs) -> Device 2 converges on noteB + the edit.
//   Device 1 offline-deletes noteA, reconnects -> Device 2 sees it gone.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // Device 1.
  const A = await freshAccount()
  const appA = A.app.app
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const noteA = await clientA.createNote({ title: 'A', body: 'online base', tags: [] })
  await A.app.sync()

  // Device 2 — same account, second data dir — pulls the base state.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-offline-2-'))
  const app2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password: A.password, syncIntervalMs: 0 })
  await app2.signIn(A.email, A.password)
  await app2.sync()
  const client2 = new SnjsBackedClient(app2, { allowWrites: true, baseUrl: SERVER })
  check('device 2 pulled the base note', (await client2.listNotes(100)).notes.some((n) => n.uuid === noteA.uuid))

  // === Device 1 goes OFFLINE: author changes WITHOUT syncing ===
  // Use the mutator directly so nothing hits the network (SnjsBackedClient
  // auto-syncs). createItem(..., true) marks the item dirty (queued for upload).
  const offlineNote = await appA.mutator.createItem(
    (await import('@standardnotes/snjs')).default.ContentType.TYPES.Note,
    { title: 'B', body: 'authored offline', text: 'authored offline', references: [] },
    true,
  )
  const aNoteA = appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === noteA.uuid)
  await appA.mutator.changeItem(aNoteA, (m: { text: string }) => {
    m.text = 'edited offline'
  })

  // The offline work exists locally and is marked dirty (pending upload).
  const offlineLocal = appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === offlineNote.uuid)
  check('offline-authored note exists locally before reconnect', !!offlineLocal)
  const dirtyItems = appA.items.getDirtyItems?.() ?? []
  check('offline changes are queued (dirty) pending upload', dirtyItems.some((i: { uuid: string }) => i.uuid === offlineNote.uuid))

  // Device 2 must NOT have the offline note yet (device 1 hasn't synced).
  await app2.sync()
  const leakedEarly = (await client2.listNotes(200)).notes.some((n) => n.uuid === offlineNote.uuid)
  check('offline note has NOT reached device 2 before device 1 reconnects', !leakedEarly)

  // === Device 1 RECONNECTS (sync) ===
  await A.app.sync()

  // Device 2 converges: sees the new offline note AND the offline edit to noteA.
  const sawNew = await (async () => {
    for (let i = 0; i < 12; i++) {
      await app2.sync()
      if ((await client2.listNotes(200)).notes.some((n) => n.uuid === offlineNote.uuid)) return true
      await sleep(800)
    }
    return false
  })()
  check('after reconnect, device 2 receives the offline-authored note', sawNew)

  const sawEdit = await (async () => {
    for (let i = 0; i < 12; i++) {
      await app2.sync()
      const read = await client2.readNote(noteA.uuid).catch(() => undefined)
      if (read?.body === 'edited offline') return true
      await sleep(800)
    }
    return false
  })()
  check('after reconnect, device 2 receives the offline EDIT to the base note', sawEdit)

  // === Offline DELETE then reconnect ===
  const aNoteAForDelete = appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === noteA.uuid)
  await appA.mutator.setItemToBeDeleted(aNoteAForDelete) // queued offline
  await A.app.sync() // reconnect
  const sawDelete = await (async () => {
    for (let i = 0; i < 12; i++) {
      await app2.sync()
      if (!(await client2.listNotes(200)).notes.some((n) => n.uuid === noteA.uuid)) return true
      await sleep(800)
    }
    return false
  })()
  check('after reconnect, device 2 sees the offline DELETE of the base note', sawDelete)

  await cleanup(app2, dir2)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
