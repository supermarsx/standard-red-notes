import { test, expect } from '@playwright/test'
import {
  Account,
  createAndPushNote,
  dirtyCount,
  editNoteText,
  expectDrained,
  freshAccount,
  noteCount,
  noteTextsByTitle,
  openFreshContext,
  registerAccount,
  seedAndPush,
  signIn,
  syncNow,
  verifyNoteIntegrity,
  waitForApplicationReady,
} from '../helpers/sync'

/**
 * REAL client<->server SYNC stress + reliability harness.
 *
 * The existing stress harness (stress-notes.spec.ts) seeds notes with NO account,
 * so `sync.sync()` there is pure local IndexedDB persistence — it never touches
 * the server. THIS spec drives the in-page snjs app to register/sign-in against
 * the LOCAL docker server (api-gateway + syncing-server, proxied by the app's
 * nginx at /v1) and exercises the actual PUSH/PULL sync, conflict resolution, and
 * failure recovery.
 *
 * Scale is kept MODERATE (2k default, 5k ramp) so it never contends heavily with
 * any concurrent cold-load run. Override the headline scale with STRESS_SYNC_N.
 *
 * REQUIRES the docker stack up (app at http://localhost:3001 proxying /v1).
 * Chromium only: these are server-round-trip integration tests, not cross-engine
 * bootstrap smokes, so one engine keeps server load and runtime moderate.
 */

const HEADLINE_N = (() => {
  const v = parseInt(process.env.STRESS_SYNC_N ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 2000
})()

// These hit a real server + IndexedDB at thousands of items; give them room
// beyond the global 60s smoke cap (a 5k push/pull legitimately takes a while).
test.describe.configure({ mode: 'serial', timeout: 8 * 60_000 })

test.describe('Standard Red Notes — real client<->server sync stress + reliability', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'server round-trip suite runs on chromium only')

  test(`push/pull/conflict/resilience round-trip at N=${HEADLINE_N}`, async ({ page, browser, baseURL }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    const account: Account = freshAccount()
    const report: Record<string, unknown> = { N: HEADLINE_N, account: account.email }

    // ---------------------------------------------------------------------
    // 1. REGISTER a fresh account against the local server (+ implicit sign-in).
    // ---------------------------------------------------------------------
    await page.goto(baseURL ?? '/', { waitUntil: 'domcontentloaded' })
    await waitForApplicationReady(page)
    await registerAccount(page, account)
    expect(await dirtyCount(page), 'fresh account should start with a drained dirty set').toBeLessThanOrEqual(0 + 0)

    // ---------------------------------------------------------------------
    // 2. PUSH: seed N dirty notes, sync to the server, assert it accepted all
    //    (no error + dirty set drains to empty).
    // ---------------------------------------------------------------------
    const seed = await seedAndPush(page, HEADLINE_N, 256)
    report.push = { ...seed }
    expect(seed.created, 'all requested notes created').toBe(HEADLINE_N)
    expect(seed.noteCount, 'all notes resident in memory after seed').toBeGreaterThanOrEqual(HEADLINE_N)
    expect(
      seed.dirtyAfterPush,
      `dirty set MUST drain to 0 after push (server accepted all); residual=${seed.dirtyAfterPush}`,
    ).toBe(0)

    // ---------------------------------------------------------------------
    // 3. PULL INTEGRITY: a SECOND fresh context signs into the SAME account,
    //    pulls, and must receive ALL N notes intact (title + sampled body).
    // ---------------------------------------------------------------------
    const second = await openFreshContext(browser, baseURL ?? undefined)
    try {
      await signIn(second.page, account)
      // signIn awaits the initial sync; force one more to be certain pagination drained.
      const pull = await syncNow(second.page, 'stress-sync-pull')
      report.pull = { ...pull }

      const integrity = await verifyNoteIntegrity(second.page, HEADLINE_N)
      report.integrity = {
        found: integrity.found,
        missing: integrity.missing.length,
        corrupt: integrity.corrupt.length,
        duplicated: integrity.duplicated.length,
      }
      expect(integrity.missing, `notes DROPPED in round-trip: ${integrity.missing.slice(0, 10)}...`).toEqual([])
      expect(integrity.corrupt, `notes CORRUPTED in round-trip: ${integrity.corrupt.slice(0, 10)}...`).toEqual([])
      expect(integrity.duplicated, `notes DUPLICATED in round-trip: ${integrity.duplicated.slice(0, 10)}...`).toEqual([])
      expect(await noteCount(second.page), 'pulled note count matches').toBeGreaterThanOrEqual(HEADLINE_N)

      // -------------------------------------------------------------------
      // 4. CONFLICT: edit the SAME note differently from two signed-in
      //    contexts, sync both; assert NO DATA LOSS — both versions recoverable
      //    (snjs ConflictType creates a conflicted duplicate or keeps both).
      // -------------------------------------------------------------------
      const conflictTitle = `conflict-note-${Date.now()}`
      const sharedUuid = await createAndPushNote(page, conflictTitle, 'original')
      // Second context must learn about the shared note before it can conflict on it.
      await syncNow(second.page, 'stress-sync-conflict-pull')

      // Edit divergently in BOTH contexts (still local/dirty)...
      await editNoteText(page, sharedUuid, 'EDIT-FROM-CONTEXT-A')
      await editNoteText(second.page, sharedUuid, 'EDIT-FROM-CONTEXT-B')
      // Context A pushes first (becomes server truth), then B pushes and conflicts.
      await syncNow(page, 'stress-sync-conflict-push-A')
      await syncNow(second.page, 'stress-sync-conflict-push-B')
      // Re-sync both so each sees the resolved state.
      await syncNow(page, 'stress-sync-conflict-reconcile-A')
      await syncNow(second.page, 'stress-sync-conflict-reconcile-B')

      const textsA = await noteTextsByTitle(page, conflictTitle)
      const textsB = await noteTextsByTitle(second.page, conflictTitle)
      const union = new Set<string>([...textsA, ...textsB])
      report.conflict = { textsA, textsB, distinctVersions: union.size }

      // No data loss: BOTH divergent edits must survive somewhere (a conflicted
      // duplicate keeps the loser; a deterministic winner still leaves the other
      // edit recoverable as the duplicate). Assert both edit strings are present.
      expect(union.has('EDIT-FROM-CONTEXT-A'), 'context A edit must be recoverable after conflict').toBe(true)
      expect(union.has('EDIT-FROM-CONTEXT-B'), 'context B edit must be recoverable after conflict').toBe(true)
      // A conflict must have produced >=2 versions of the note across the corpus
      // (duplicate created), i.e. nothing was silently overwritten/lost.
      expect(
        Math.max(textsA.length, textsB.length),
        'conflict should yield a duplicate note (both versions present), not a silent overwrite',
      ).toBeGreaterThanOrEqual(2)
      // Both contexts converge to the same set of versions after reconciliation.
      expect(new Set(textsA), 'both contexts should converge to the same conflict versions').toEqual(new Set(textsB))

      // -------------------------------------------------------------------
      // 5. RESILIENCE: abort the NEXT /v1 sync request once, edit while the
      //    request is failing, then let the route recover and assert the
      //    client re-syncs with NO lost / duplicated items.
      // -------------------------------------------------------------------
      const resilienceTitle = `resilience-note-${Date.now()}`
      const resUuid = await createAndPushNote(page, resilienceTitle, 'resilience-original')
      await syncNow(second.page, 'stress-sync-resilience-pull')

      // Make context A's next sync fail at the network layer (one-shot abort).
      let aborted = 0
      const failRoute = async (route: import('@playwright/test').Route) => {
        aborted += 1
        await route.abort('failed')
      }
      await page.route('**/v1/items**', failRoute)

      // Dirty an edit, then attempt a sync that WILL fail — the item must stay dirty.
      await editNoteText(page, resUuid, 'resilience-EDITED-while-offline')
      const failedSync = await syncNow(page, 'stress-sync-resilience-fail').catch((e: Error) => ({
        error: e.message,
        syncMs: -1,
        noteCount: -1,
        dirty: -1,
      }))
      const dirtyAfterFail = await dirtyCount(page)
      report.resilience = { abortedRequests: aborted, dirtyAfterFail, failedSync }
      // The interrupted edit must NOT be dropped — it remains pending.
      expect(dirtyAfterFail, 'interrupted edit must remain dirty (never silently dropped)').toBeGreaterThanOrEqual(1)

      // Recover: remove the failure and sync again. The pending edit must land.
      await page.unroute('**/v1/items**', failRoute)
      const recovered = await syncNow(page, 'stress-sync-resilience-recover')
      ;(report.resilience as Record<string, unknown>).recovered = recovered
      expect(recovered.dirty, 'dirty set must drain after recovery (no lost edit)').toBe(0)

      // Pull from the second context: the recovered edit is present, exactly once
      // (no duplication from the failed-then-retried sync).
      await syncNow(second.page, 'stress-sync-resilience-verify')
      const recoveredTexts = await noteTextsByTitle(second.page, resilienceTitle)
      ;(report.resilience as Record<string, unknown>).recoveredTexts = recoveredTexts
      expect(
        recoveredTexts.includes('resilience-EDITED-while-offline'),
        'recovered edit must be visible to other context after retry',
      ).toBe(true)
      expect(
        recoveredTexts.filter((t) => t === 'resilience-EDITED-while-offline').length,
        'recovered edit must appear exactly once (no duplication from retry)',
      ).toBe(1)
    } finally {
      await second.context.close()
    }

    expect(pageErrors, `uncaught page errors during sync stress:\n${pageErrors.join('\n')}`).toEqual([])

    // eslint-disable-next-line no-console
    console.log('SYNC STRESS REPORT:', JSON.stringify(report, null, 2))
  })

  // ---------------------------------------------------------------------
  // 6. RAMP: characterize where push/pull degrades as N grows (2k, 5k).
  //    Separate fresh account per scale so timings are independent.
  // ---------------------------------------------------------------------
  for (const N of [2000, 5000]) {
    test(`ramp: push+pull timing at N=${N}`, async ({ page, browser, baseURL }) => {
      // The server's per-item push cost (~95-100ms/note: encrypt + revision +
      // DB write) makes a 5k push take ~8min on its own. Give the larger ramp
      // headroom so it CHARACTERIZES the degradation instead of timing out (the
      // degradation itself is the finding; see the spec header / report).
      test.setTimeout(N >= 5000 ? 20 * 60_000 : 8 * 60_000)
      const account = freshAccount()
      await page.goto(baseURL ?? '/', { waitUntil: 'domcontentloaded' })
      await waitForApplicationReady(page)
      await registerAccount(page, account)

      const seed = await seedAndPush(page, N, 256)
      expect(seed.dirtyAfterPush, `push drained at N=${N}`).toBe(0)

      const second = await openFreshContext(browser, baseURL ?? undefined)
      try {
        await signIn(second.page, account)
        const pull = await syncNow(second.page, `ramp-pull-${N}`)
        const integrity = await verifyNoteIntegrity(second.page, N)
        expect(integrity.missing.length, `no drops at N=${N}`).toBe(0)
        // eslint-disable-next-line no-console
        console.log(
          `RAMP N=${N}: seedMs=${Math.round(seed.seedMs)} pushMs=${Math.round(seed.pushMs)} ` +
            `pullMs=${Math.round(pull.syncMs)} pulledNotes=${pull.noteCount} ` +
            `pushPerNoteMs=${(seed.pushMs / N).toFixed(2)} pullPerNoteMs=${(pull.syncMs / N).toFixed(2)}`,
        )
      } finally {
        await second.context.close()
      }
    })
  }
})
