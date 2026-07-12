import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// DELETE-vs-EDIT RACE. Device A deletes a synced note while device B (stale,
// "offline") edits the same note from its old base; both sync. This asserts the
// snjs contract is DETERMINISTIC and there is no split-brain — both devices must
// converge to the SAME final set. We then REPORT which side won (delete wins vs.
// B's edit resurrected as a conflict copy) so the data-loss profile is explicit.
async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // Device A creates + syncs a note.
  const A = await freshAccount()
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const created = await clientA.createNote({ title: 'Race', body: 'base', tags: [] })
  await A.app.sync()

  // Device B signs in and pulls the base version.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-delrace-2-'))
  const appB = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password: A.password, syncIntervalMs: 0 })
  await appB.signIn(A.email, A.password)
  await appB.sync()
  const bBase = appB.app.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === created.uuid)
  check('device B pulled the base note', !!bBase)

  // Device A deletes the note and syncs FIRST — the server marks it deleted.
  await clientA.deleteNote(created.uuid)
  await A.app.sync()

  // Device B, still holding the STALE non-deleted copy, edits it (without pulling
  // A's delete first) and syncs — this is the race.
  await appB.app.mutator.changeItem(bBase, (m: { text: string }) => {
    m.text = 'edited by B after A deleted'
  })
  await appB.sync()

  // Let both sides fully converge.
  for (let i = 0; i < 8; i++) {
    await appB.sync()
    await A.app.sync()
    await sleep(600)
  }

  // Compare the final LIVE (non-deleted) note sets on both devices.
  const liveA = A.app.app.items
    .getDisplayableNotes()
    .filter((n: { uuid: string; conflictOf?: string }) => n.uuid === created.uuid || n.conflictOf === created.uuid)
    .map((n: { uuid: string; text?: string }) => ({ uuid: n.uuid, text: n.text ?? '' }))
    .sort((a: { uuid: string }, b: { uuid: string }) => a.uuid.localeCompare(b.uuid))
  const liveB = appB.app.items
    .getDisplayableNotes()
    .filter((n: { uuid: string; conflictOf?: string }) => n.uuid === created.uuid || n.conflictOf === created.uuid)
    .map((n: { uuid: string; text?: string }) => ({ uuid: n.uuid, text: n.text ?? '' }))
    .sort((a: { uuid: string }, b: { uuid: string }) => a.uuid.localeCompare(b.uuid))

  console.log('  info - device A final set:', JSON.stringify(liveA))
  console.log('  info - device B final set:', JSON.stringify(liveB))

  // The load-bearing data-assurance property: both devices agree (no split-brain).
  check('devices A and B CONVERGE to the same final set (no split-brain)', JSON.stringify(liveA) === JSON.stringify(liveB))

  const editSurvived = liveA.some((n: { text: string }) => n.text === 'edited by B after A deleted')
  const deleteWon = liveA.length === 0
  check('outcome is deterministic (either delete wins OR edit resurrected — not a partial/torn state)', deleteWon || editSurvived)
  if (deleteWon) {
    console.log("  info - VERDICT: delete-wins — B's edit did NOT resurrect (last-writer=delete). No split-brain.")
  } else if (editSurvived) {
    console.log("  info - VERDICT: edit-resurrected — B's edit survived as a live note (no silent loss). No split-brain.")
  }

  await cleanup(appB, dir2)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
