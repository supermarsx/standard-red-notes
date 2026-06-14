import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Data-integrity integration e2e: when two devices edit the SAME note from the
// same base version, syncing must not silently lose an edit — the server detects
// the conflict and snjs materializes a conflict copy so BOTH versions survive.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // Device 1 creates a note and syncs it.
  const A = await freshAccount()
  const appA = A.app.app
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const created = await clientA.createNote({ title: 'Conflict', body: 'base version', tags: [] })
  await A.app.sync()

  // Device 2 (same account) signs in and pulls the note at its base version.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-conflict-2-'))
  const app2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password: A.password, syncIntervalMs: 0 })
  await app2.signIn(A.email, A.password)
  await app2.sync()
  const note2 = app2.app.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === created.uuid)
  check('device 2 pulled the base note', !!note2)

  // Device 1 edits and syncs FIRST — the server's version now moves ahead.
  await clientA.updateNote(created.uuid, { body: 'edited by device 1' })
  await A.app.sync()

  // Device 2 edits its STALE copy and syncs WITHOUT first pulling device 1's edit
  // — this is the concurrent-edit case. (Edit the item directly so we don't pull
  // first, which SnjsBackedClient.updateNote would do via its internal sync.)
  await app2.app.mutator.changeItem(note2, (m: { text: string }) => {
    m.text = 'edited by device 2'
  })
  await app2.sync()
  // Give the conflict round-trip a moment to settle into a second item.
  await sleep(1500)
  await app2.sync()

  const notesOnD2 = app2.app.items.getDisplayableNotes().filter((n: { uuid: string }) => n.uuid === created.uuid || n.conflictOf === created.uuid)
  check('device 2 now has two copies of the note (conflict materialized)', notesOnD2.length >= 2)

  const bodies = notesOnD2.map((n: { text?: string }) => n.text ?? '')
  check('both edited versions survive (no data loss)', bodies.includes('edited by device 1') && bodies.includes('edited by device 2'))
  const hasConflictLink = notesOnD2.some((n: { conflictOf?: string }) => n.conflictOf === created.uuid)
  check('the conflict copy is linked to the original via conflict_of', hasConflictLink)

  // The conflict also propagates back: device 1 sees both versions after syncing.
  await A.app.sync()
  await sleep(1000)
  await A.app.sync()
  const notesOnD1 = appA.items.getDisplayableNotes().filter((n: { uuid: string; conflictOf?: string }) => n.uuid === created.uuid || n.conflictOf === created.uuid)
  check('device 1 also converges to both versions', notesOnD1.length >= 2)

  await cleanup(app2, dir2)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
