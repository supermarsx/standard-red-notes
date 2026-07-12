import snjs from '@standardnotes/snjs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, skip, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'

const { ContentType } = snjs as unknown as Record<string, any>
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// THE regression proof for commit 55785604 (t43 fix of the Critical silent
// data-loss). A dirty "local-only" item was filtered out of BOTH the upload set
// AND the local-persist set, so it was dropped from disk and lost on reload.
//
// This spec asserts the OBSERVABLE end state the pure-filter unit test never did:
//   (a) a second device signed into the SAME account NEVER receives the item
//       (it never left the device — server exclusion still holds), and
//   (b) after DEINIT + RE-BOOTSTRAP with the SAME on-disk dataDir, the note, its
//       LATEST edits, and the localOnly flag all SURVIVE the reload.
//
// HARNESS-VERSION GATE (honesty): the local-only/selective-sync feature AND its
// 55785604 fix live in the workspace snjs source (2.211.7). The node e2e harness
// bundles whatever `@standardnotes/snjs` resolves in node_modules. If that build
// predates the feature (e.g. 2.211.6, which has NO `localOnly` mutator at all),
// this scenario CANNOT be exercised here — we SKIP loudly with the reason rather
// than emit a misleading FAIL. Re-run after the harness snjs is bumped to a build
// that contains the fix and this becomes the live regression proof.
async function supportsLocalOnly(appA: any): Promise<boolean> {
  const probe = await appA.mutator.createItem(ContentType.TYPES.Note, { title: '__probe', text: 'x', references: [] }, false)
  await appA.mutator.changeItem(
    appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === probe.uuid),
    (m: any) => {
      m.localOnly = true
    },
  )
  const read = appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === probe.uuid)
  const ok = read?.localOnly === true
  await appA.mutator.setItemToBeDeleted(read)
  return ok
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const A = await freshAccount()
  const appA = A.app.app

  if (!(await supportsLocalOnly(appA))) {
    const version = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('@standardnotes/snjs/package.json').version
      } catch {
        return 'unknown'
      }
    })()
    skip(
      'local-only reload-survival (commit 55785604)',
      `the harness-resolved @standardnotes/snjs (${version}) has NO 'localOnly' mutator field — this build predates the selective-sync feature and its fix, so the regression cannot be exercised at integration level here. The fix is covered at source level by app/packages/snjs/lib/Services/Sync/SyncService.spec.ts (jest). Bump the harness snjs to a build containing 55785604 to enable this live proof.`,
    )
    await cleanup(A.app, A.dataDir)
    finish()
    return
  }

  // Create a note directly via the mutator (needsSync=true => dirty) and mark it
  // local-only BEFORE any sync, so it is never eligible for upload. Then edit it
  // several times, syncing between edits — every sync must persist it locally
  // while excluding it from the upload set.
  const note = await appA.mutator.createItem(
    ContentType.TYPES.Note,
    { title: 'LocalOnly', text: 'v0', references: [] },
    true,
  )
  const noteUuid: string = note.uuid
  await appA.mutator.changeItem(
    appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === noteUuid),
    (m: { localOnly: boolean }) => {
      m.localOnly = true
    },
  )
  await A.app.sync()

  for (const v of ['v1', 'v2', 'v3']) {
    await appA.mutator.changeItem(
      appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === noteUuid),
      (m: { text: string }) => {
        m.text = v
      },
    )
    await A.app.sync()
  }

  const localBeforeReload = appA.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === noteUuid)
  check('note exists locally after edits+syncs', !!localBeforeReload)
  check('local note carries the latest edit (v3) before reload', localBeforeReload?.text === 'v3')
  check('local note is flagged localOnly before reload', localBeforeReload?.localOnly === true)

  // (a) A SECOND device on the SAME account must NEVER receive the local-only note.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-localonly-2-'))
  const app2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password: A.password, syncIntervalMs: 0 })
  await app2.signIn(A.email, A.password)
  let leaked = false
  for (let i = 0; i < 6; i++) {
    await app2.sync()
    if (app2.app.items.getDisplayableNotes().some((n: { uuid: string }) => n.uuid === noteUuid)) {
      leaked = true
      break
    }
    await sleep(500)
  }
  check('local-only note NEVER reaches a second device (server never got it)', !leaked)

  // (b) RELOAD SURVIVAL: deinit the app (flushing writes) WITHOUT deleting the
  // dataDir, then re-bootstrap from the SAME on-disk store. The note + latest
  // edit + localOnly flag must load from disk.
  const dataDir = A.dataDir
  await A.app.deinit()
  const reloaded = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir, password: A.password, syncIntervalMs: 0 })
  const reloadedNote = reloaded.app.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === noteUuid)
  check('RELOAD: local-only note survives a deinit + fresh re-bootstrap from disk', !!reloadedNote)
  check('RELOAD: the note still carries its latest edit (v3)', reloadedNote?.text === 'v3')
  check('RELOAD: the note is still flagged localOnly', reloadedNote?.localOnly === true)

  await cleanup(app2, dir2)
  await cleanup(reloaded, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
