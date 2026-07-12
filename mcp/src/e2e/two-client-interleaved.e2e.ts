import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// N-NOTE INTERLEAVED CONFLICT. Two devices edit overlapping sets of notes from
// the same base, with A syncing first (moving the server ahead) so B's stale
// edits to the overlap collide. Asserts: every edit survives (conflict copies
// where the sets overlap), NO note vanishes, and a THIRD fresh download
// reconciles to the EXACT expected final count.
//
// Layout of 5 base notes n0..n4:
//   n0 — edited by A only        -> clean, 1 copy
//   n1 — edited by A then B       -> CONFLICT, 2 copies
//   n2 — edited by A then B       -> CONFLICT, 2 copies
//   n3 — edited by B only         -> clean upload, 1 copy
//   n4 — untouched                -> 1 copy
// Expected final live-note count = 5 originals + 2 conflict copies = 7.
async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const A = await freshAccount()
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const appA = A.app.app

  const uuids: string[] = []
  for (let i = 0; i < 5; i++) {
    const n = await clientA.createNote({ title: `n${i}`, body: `base-${i}`, tags: [] })
    uuids.push(n.uuid)
  }
  await A.app.sync()

  // Device B pulls all 5 at base.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-interleave-2-'))
  const appB = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password: A.password, syncIntervalMs: 0 })
  await appB.signIn(A.email, A.password)
  await appB.sync()
  const pulled = uuids.filter((u) => appB.app.items.getDisplayableNotes().some((n: { uuid: string }) => n.uuid === u))
  check('device B pulled all 5 base notes', pulled.length === 5)

  const editOn = async (app: any, uuid: string, text: string): Promise<void> => {
    const note = app.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === uuid)
    await app.mutator.changeItem(note, (m: { text: string }) => {
      m.text = text
    })
  }

  // A edits n0,n1,n2 and syncs FIRST — server now ahead on those three.
  await editOn(appA, uuids[0], 'A-edit-0')
  await editOn(appA, uuids[1], 'A-edit-1')
  await editOn(appA, uuids[2], 'A-edit-2')
  await A.app.sync()

  // B, from its STALE base, edits n1,n2 (overlap => conflict) and n3 (clean), syncs.
  await editOn(appB.app, uuids[1], 'B-edit-1')
  await editOn(appB.app, uuids[2], 'B-edit-2')
  await editOn(appB.app, uuids[3], 'B-edit-3')
  await appB.sync()

  // Converge both devices.
  for (let i = 0; i < 10; i++) {
    await appB.sync()
    await A.app.sync()
    await sleep(600)
  }

  // THIRD fresh device: the authoritative reconciliation surface.
  const dir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-interleave-3-'))
  const appC = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir3, password: A.password, syncIntervalMs: 0 })
  await appC.signIn(A.email, A.password)
  let notesC: any[] = []
  for (let i = 0; i < 10; i++) {
    await appC.sync()
    notesC = appC.app.items.getDisplayableNotes()
    if (notesC.length >= 7) break
    await sleep(700)
  }

  const originalsPresent = uuids.filter((u) => notesC.some((n) => n.uuid === u))
  check('third device: all 5 original notes still present (none vanished)', originalsPresent.length === 5)

  const conflictCopies = notesC.filter((n) => n.conflictOf === uuids[1] || n.conflictOf === uuids[2])
  check('third device: exactly 2 conflict copies materialized (for the 2 overlapping edits)', conflictCopies.length === 2)

  check('third device: EXACT final count reconciles to 7 (5 originals + 2 conflict copies)', notesC.length === 7)

  const bodies = notesC.map((n) => n.text ?? '')
  const allEdits = ['A-edit-0', 'A-edit-1', 'A-edit-2', 'B-edit-1', 'B-edit-2', 'B-edit-3']
  const missing = allEdits.filter((t) => !bodies.includes(t))
  console.log('  info - third-device bodies:', JSON.stringify(bodies.slice().sort()))
  check('third device: every edit from BOTH devices survives (no lost edit)', missing.length === 0)
  if (missing.length) {
    console.log('  info - MISSING edits:', JSON.stringify(missing))
  }

  await cleanup(appC, dir3)
  await cleanup(appB, dir2)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
