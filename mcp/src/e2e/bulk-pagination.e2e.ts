import snjs from '@standardnotes/snjs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'

// BULK MULTI-PAGE SYNC integrity (t44-e4 #1).
//
// Data-assurance question: when an account holds enough notes to force the sync
// engine to DOWNLOAD across multiple server pages, does a fresh client converge
// to EXACTLY the authored set — no skipped item, no duplicated item — and does
// the sync-token stay coherent across pages (a second sync pulls nothing new)?
//
// This asserts the OBSERVABLE END STATE (exact uuid-set equality on a fresh
// device), not that a call returned. It then edits a slice and deletes a slice
// and re-verifies convergence, proving update/delete propagate at bulk scale.

const { ContentType } = snjs as unknown as Record<string, any>

// 400 notes is comfortably past the server's per-page sync download limit, so B's
// first sync genuinely paginates. Overridable for a heavier soak run.
const N = Number(process.env.E2E_BULK_COUNT ?? 400)
const EDIT_SLICE = 50
const DELETE_SLICE = 50

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const dirtyCount = (app: HeadlessApp): number => (app.app.items.getDirtyItems?.() ?? []).length

/** Set of uuids of the account's live (non-deleted) displayable notes. */
function noteUuids(app: HeadlessApp): string[] {
  return app.app.items.getDisplayableNotes().map((n: { uuid: string }) => n.uuid)
}

/** Pull until the live note count stops changing (auto-paginates internally). */
async function syncUntilStable(app: HeadlessApp, label: string): Promise<number> {
  let prev = -1
  for (let i = 0; i < 40; i++) {
    try {
      await app.sync()
    } catch (e) {
      console.log(`  ..  ${label} sync attempt ${i} errored: ${(e as Error).message}`)
    }
    const count = app.app.items.getDisplayableNotes().length
    if (count === prev && dirtyCount(app) === 0) {
      return count
    }
    prev = count
    await sleep(200)
  }
  return app.app.items.getDisplayableNotes().length
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // === Device A authors N notes and uploads them ===
  const A = await freshAccount()
  const appA = A.app.app
  console.log(`  ..  authoring ${N} notes on device A`)
  const createdUuids: string[] = []
  for (let i = 0; i < N; i++) {
    const note = await appA.mutator.createItem(
      ContentType.TYPES.Note,
      { title: `bulk-${i}`, text: `body ${i} :: ${A.email}`, references: [] },
      true, // dirty -> queued for upload
    )
    createdUuids.push(note.uuid)
  }
  check(`authored ${N} distinct notes locally`, new Set(createdUuids).size === N)

  // Upload everything (snjs batches the upload across requests within sync()).
  for (let i = 0; i < 60 && dirtyCount(A.app) > 0; i++) {
    await A.app.sync()
    await sleep(100)
  }
  check('device A uploaded all notes (nothing left dirty)', dirtyCount(A.app) === 0)

  const createdSet = new Set(createdUuids)

  // === Fresh device B pulls — forces a multi-page DOWNLOAD ===
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-bulk-B-'))
  const appB = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirB, password: A.password, syncIntervalMs: 0 })
  await appB.signIn(A.email, A.password)
  const bCount = await syncUntilStable(appB, 'B')

  const bUuids = noteUuids(appB)
  const bSet = new Set(bUuids)
  check(`device B downloaded EXACTLY ${N} notes (got ${bCount})`, bCount === N)
  check('device B has no DUPLICATE notes (set size == array length)', bSet.size === bUuids.length)
  const missing = createdUuids.filter((u) => !bSet.has(u))
  const extra = bUuids.filter((u) => !createdSet.has(u))
  check(`no note SKIPPED across pagination (missing=${missing.length})`, missing.length === 0)
  check(`no UNEXPECTED note appeared (extra=${extra.length})`, extra.length === 0)
  check('device B uuid-set EXACTLY equals device A authored set', bSet.size === createdSet.size && missing.length === 0 && extra.length === 0)

  // Sync-token integrity: an immediate second sync pulls nothing new / no dupes.
  await appB.sync()
  const bCount2 = appB.app.items.getDisplayableNotes().length
  check('a second sync is a no-op (sync-token coherent across pages)', bCount2 === N)

  // === Edit a slice on A, converge B ===
  const editUuids = createdUuids.slice(0, EDIT_SLICE)
  for (const uuid of editUuids) {
    const note = appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === uuid)
    await appA.mutator.changeItem(note, (m: { text: string }) => {
      m.text = `EDITED :: ${uuid}`
    })
  }
  for (let i = 0; i < 30 && dirtyCount(A.app) > 0; i++) {
    await A.app.sync()
    await sleep(100)
  }
  check('device A uploaded the edited slice (nothing dirty)', dirtyCount(A.app) === 0)

  let editsSeen = 0
  for (let i = 0; i < 30; i++) {
    await appB.sync()
    editsSeen = editUuids.filter((uuid) => {
      const n = appB.app.items.getDisplayableNotes().find((x: { uuid: string }) => x.uuid === uuid)
      return n?.text === `EDITED :: ${uuid}`
    }).length
    if (editsSeen === EDIT_SLICE) break
    await sleep(300)
  }
  check(`device B converged on all ${EDIT_SLICE} edits`, editsSeen === EDIT_SLICE)
  check(`device B still holds exactly ${N} notes after edits (no phantom loss/dup)`, appB.app.items.getDisplayableNotes().length === N)

  // === Delete a slice on A, converge B ===
  const deleteUuids = createdUuids.slice(N - DELETE_SLICE)
  for (const uuid of deleteUuids) {
    const note = appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === uuid)
    await appA.mutator.setItemToBeDeleted(note)
  }
  for (let i = 0; i < 30 && dirtyCount(A.app) > 0; i++) {
    await A.app.sync()
    await sleep(100)
  }

  let bAfterDelete = -1
  const deleteSet = new Set(deleteUuids)
  for (let i = 0; i < 30; i++) {
    await appB.sync()
    bAfterDelete = appB.app.items.getDisplayableNotes().length
    const anyDeletedStillPresent = noteUuids(appB).some((u) => deleteSet.has(u))
    if (bAfterDelete === N - DELETE_SLICE && !anyDeletedStillPresent) break
    await sleep(300)
  }
  const bUuidsFinal = new Set(noteUuids(appB))
  check(`device B converged to ${N - DELETE_SLICE} notes after delete (got ${bAfterDelete})`, bAfterDelete === N - DELETE_SLICE)
  check('none of the deleted notes remain on device B', !deleteUuids.some((u) => bUuidsFinal.has(u)))
  check('all still-live notes remain on device B (no collateral loss)', createdUuids.slice(0, N - DELETE_SLICE).every((u) => bUuidsFinal.has(u)))

  await cleanup(appB, dirB)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
