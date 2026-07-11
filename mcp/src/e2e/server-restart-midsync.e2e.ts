import snjs from '@standardnotes/snjs'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'

// SERVER KILL / RESTART MID-SYNC (t44-e4 #2).
//
// Data-assurance question: if the sync server is restarted WHILE a client is
// mid-flight, does the client lose or duplicate data? We inject a real crash
// (`docker restart` of THIS executor's OWN isolated @3011 container — never the
// shared @3001 stack) and assert:
//   Phase 1 (UPLOAD): dirty items are retained through the crash and, on retry
//     after recovery, ALL land on the server EXACTLY ONCE (a fresh device sees
//     the full set, no dup, no loss).
//   Phase 2 (DOWNLOAD): a client interrupted mid-download must NOT report a
//     partial load as a completed/clean download; on retry it converges to the
//     full set. (Cold-load completeness guard.)
//
// This spec only runs when SERVER points at the isolated stack; restarting a
// shared server would corrupt sibling executors, so it SKIPs otherwise.

const { ContentType } = snjs as unknown as Record<string, any>

// Only self-manage a container we own. Default to the e4 isolated container; the
// guard below refuses to run against anything but the isolated @3011 origin.
const CONTAINER = process.env.E2E_RESTART_CONTAINER ?? 'srn-t44-e4-app-1'
const N = Number(process.env.E2E_RESTART_COUNT ?? 300)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const dirtyCount = (app: HeadlessApp): number => (app.app.items.getDirtyItems?.() ?? []).length
const liveNotes = (app: HeadlessApp): string[] => app.app.items.getDisplayableNotes().map((n: { uuid: string }) => n.uuid)

function dockerRestart(): void {
  console.log(`  ..  docker restart ${CONTAINER}`)
  execFileSync('docker', ['restart', '-t', '2', CONTAINER], { stdio: 'ignore' })
}

async function waitHealthy(label: string, timeoutMs = 90000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await serverUp()) return true
    await sleep(500)
  }
  console.log(`  ..  ${label}: server did NOT return healthy within ${timeoutMs}ms`)
  return false
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }
  // Safety: never restart a shared server. Require the isolated origin explicitly.
  if (!/localhost:3011$/.test(new URL(SERVER).host) && !process.env.E2E_RESTART_FORCE) {
    console.log(`SKIP: refusing to restart a non-isolated server (${SERVER}); set E2E_RESTART_FORCE to override`)
    process.exit(0)
  }
  // Confirm we can actually control the container; if not, skip cleanly.
  try {
    execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER], { stdio: 'ignore' })
  } catch {
    console.log(`SKIP: container ${CONTAINER} not controllable from this spec`)
    process.exit(0)
  }

  // === Device A authors N notes, all dirty ===
  const A = await freshAccount()
  const appA = A.app.app
  console.log(`  ..  authoring ${N} notes on device A`)
  const createdUuids: string[] = []
  for (let i = 0; i < N; i++) {
    const note = await appA.mutator.createItem(
      ContentType.TYPES.Note,
      { title: `restart-${i}`, text: `body ${i}`, references: [] },
      true,
    )
    createdUuids.push(note.uuid)
  }
  const createdSet = new Set(createdUuids)

  // === PHASE 1: crash mid-UPLOAD ===
  // Kick off the upload without awaiting, then crash the server underneath it.
  console.log('  ..  starting upload, then crashing server mid-flight')
  const uploadPromise = A.app.sync().catch((e: Error) => {
    console.log(`  ..  upload sync rejected (expected): ${e.message}`)
  })
  await sleep(400) // let some batches go out
  dockerRestart()
  await uploadPromise

  // Some notes may have uploaded before the crash; the rest are still dirty
  // (retained, not silently dropped). The load-bearing proof is the exact-set
  // reconciliation on device B below; this is an observability note.
  const dirtyAfterCrash = dirtyCount(A.app)
  const uploadedBeforeCrash = N - dirtyAfterCrash
  console.log(`  ..  after mid-upload crash: ${dirtyAfterCrash} dirty, ~${uploadedBeforeCrash} already uploaded`)

  check('server recovered healthy after restart', await waitHealthy('phase1'))

  // Retry until fully uploaded.
  for (let i = 0; i < 80 && dirtyCount(A.app) > 0; i++) {
    try { await A.app.sync() } catch { /* keep retrying through reconnect */ }
    await sleep(250)
  }
  check('after recovery device A uploaded everything (nothing dirty)', dirtyCount(A.app) === 0)

  // Fresh device B downloads: EXACT set, no loss, no dup.
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-restart-B-'))
  const appB = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirB, password: A.password, syncIntervalMs: 0 })
  await appB.signIn(A.email, A.password)
  let bUuids: string[] = []
  for (let i = 0; i < 60; i++) {
    try { await appB.sync() } catch { /* retry */ }
    bUuids = liveNotes(appB)
    if (bUuids.length >= N && dirtyCount(appB) === 0) break
    await sleep(250)
  }
  const bSet = new Set(bUuids)
  check(`device B has EXACTLY ${N} notes after upload-crash recovery (got ${bUuids.length})`, bUuids.length === N)
  check('device B has NO duplicate notes (set size == array length)', bSet.size === bUuids.length)
  check('device B lost NO authored note', createdUuids.every((u) => bSet.has(u)))
  check('device B has NO note the author never created', bUuids.every((u) => createdSet.has(u)))

  // === PHASE 2: crash mid-DOWNLOAD (cold-load completeness) ===
  const dirC = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-restart-C-'))
  const appC = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirC, password: A.password, syncIntervalMs: 0 })
  console.log('  ..  signing in device C, then crashing server mid-download')
  // signIn triggers the download-first sync; crash underneath it.
  const signInPromise = appC.signIn(A.email, A.password).catch((e: Error) => {
    console.log(`  ..  device C sign-in rejected (expected if crash landed mid-flight): ${e.message}`)
  })
  await sleep(350) // let the download start and page a bit
  dockerRestart()
  await signInPromise

  const cPartial = liveNotes(appC).length
  const completedFlag = appC.app.sync.completedOnlineDownloadFirstSync === true
  console.log(`  ..  device C after interrupted download: ${cPartial} notes, completedOnlineDownloadFirstSync=${completedFlag}`)
  // THE product-bug detector: a partial download must never be reported as a
  // completed clean download. Completed==true is only acceptable if C actually
  // has the full set already.
  check('interrupted download NOT falsely reported complete (no partial-as-clean)', !(completedFlag && cPartial < N))

  check('server recovered healthy after phase-2 restart', await waitHealthy('phase2'))

  // Retry: C must converge to the full set, exactly once each.
  let cUuids: string[] = []
  for (let i = 0; i < 80; i++) {
    try { await appC.sync() } catch { /* retry through reconnect */ }
    cUuids = liveNotes(appC)
    if (cUuids.length >= N && appC.app.sync.completedOnlineDownloadFirstSync === true) break
    await sleep(250)
  }
  const cSet = new Set(cUuids)
  check(`device C converged to EXACTLY ${N} notes after download-crash (got ${cUuids.length})`, cUuids.length === N)
  check('device C has NO duplicate notes', cSet.size === cUuids.length)
  check('device C lost NO note', createdUuids.every((u) => cSet.has(u)))
  check('device C download-first sync is now genuinely complete', appC.app.sync.completedOnlineDownloadFirstSync === true)

  await cleanup(appC, dirC)
  await cleanup(appB, dirB)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
