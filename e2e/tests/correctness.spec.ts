import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import path from 'node:path'
import { waitForApplicationReady, waitForNoteCountSettled } from '../helpers/stress'
import {
  seedStructuredVault,
  assertTagsAndReferences,
  assertTagFilter,
  assertSearch,
  editAndPersistNote,
  assertEditedNoteText,
  itemCounts,
} from '../helpers/correctness'

/**
 * CORRECTNESS-AT-SCALE GATE — separate from the perf stress harness.
 *
 * The perf stress spec (stress-notes.spec.ts) measures open/scroll/heap and would
 * let a DATA-INTEGRITY regression pass green. This spec is the gate that catches
 * one: it seeds a vault with STRUCTURE (tags attached to known notes, notes
 * carrying a unique search token, an edit-roundtrip target) and HARD-ASSERTS that
 * the structure SURVIVES a cold reload from IndexedDB:
 *   1. Tags & references resolve (getSortedTagsForItem + tag membership).
 *   2. Tag filter returns exactly the seeded members (getDisplayableNotes scoped to a tag).
 *   3. Search for a unique token matches exactly the seeded token notes.
 *   4. Edit -> save -> reload round-trip preserves the new text.
 *
 * It is deliberately a SEPARATE, fast/standalone spec so it can run on its own and
 * gate a windowed-materialization change without paying the multi-minute perf ramp.
 *
 * SCALE: default 5000 notes (override with CORRECTNESS_NOTE_COUNT). Unlike the
 * perf harness these are HARD assertions at the configured scale — a refs/tags/
 * search/edit regression FAILS the suite (that's the point).
 *
 * REUSE: honors STRESS_REUSE_DIR (a persistent profile per scale) so the seed can
 * be skipped on re-runs; a fresh ephemeral context (fresh seed) is the default.
 */

const REUSE_DIR = process.env.STRESS_REUSE_DIR?.trim()
const APP_BASE_URL = process.env.APP_URL?.trim() || 'http://localhost:3001'

const COUNT = (() => {
  const v = parseInt(process.env.CORRECTNESS_NOTE_COUNT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 5000
})()
const SIZE_BYTES = (() => {
  const v = parseInt(process.env.CORRECTNESS_NOTE_SIZE_BYTES ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 512
})()

const TAG_COUNT = 5
const NOTES_PER_TAG = 8
const TOKEN_NOTE_COUNT = 4

const APP_SHELL = '.main-ui-view, #footer-bar'

// Seeding 5k + structure + a cold reload is well under the perf-ramp budget, but
// give generous headroom for slow CI.
test.setTimeout(8 * 60_000)

// Run on Chromium only: this is a data-integrity gate, not a cross-engine
// bootstrap smoke (those live in app-opens.spec.ts). Keeping it single-engine
// keeps the gate fast and avoids re-seeding 5k notes three times.
test.describe('@chromium', () => {
  test(`correctness gate: structure survives cold reload @ ${COUNT} notes`, async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'correctness gate runs on chromium only')

    let context: BrowserContext
    if (REUSE_DIR) {
      context = await chromium.launchPersistentContext(path.join(REUSE_DIR, `correctness-c${COUNT}-s${SIZE_BYTES}`), {
        baseURL: APP_BASE_URL,
        headless: true,
      })
    } else {
      context = await browser.newContext()
    }
    const page = context.pages()[0] ?? (await context.newPage())

    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    try {
      // 1) Load fresh, wait for the snjs app, then seed STRUCTURE.
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.locator(APP_SHELL).first().waitFor({ state: 'visible', timeout: 60_000 })
      await waitForApplicationReady(page, 60_000)

      const seed = await seedStructuredVault(page, {
        count: COUNT,
        sizeBytes: SIZE_BYTES,
        tagCount: TAG_COUNT,
        notesPerTag: NOTES_PER_TAG,
        tokenNoteCount: TOKEN_NOTE_COUNT,
      })
      console.log(
        `[correctness seed] notes=${seed.notesCreated} tags=${seed.tagsCreated} ` +
          `taggedNotes=${Object.keys(seed.taggedNotes).length} tokenNotes=${seed.tokenNoteUuids.length} ` +
          `token=${seed.searchToken} editTarget=${seed.editNoteUuid} seedMs=${Math.round(seed.seedMs)}`,
      )

      // 2) Edit the round-trip note BEFORE the reload, persist locally.
      const edit = await editAndPersistNote(page, seed.editNoteUuid)
      console.log(`[correctness edit] uuid=${edit.uuid} wasLite=${edit.wasLite} newText="${edit.newText}"`)

      // 3) COLD RELOAD: the app must rebuild every note+tag+reference from IndexedDB.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator(APP_SHELL).first().waitFor({ state: 'visible', timeout: 2 * 60_000 })
      await waitForApplicationReady(page, 2 * 60_000)
      const settled = await waitForNoteCountSettled(page, { timeoutMs: 4 * 60_000 })
      const counts = await itemCounts(page)
      console.log(
        `[correctness cold-load] settledNotes=${settled.count} inMemNotes=${counts.notes} ` +
          `inMemTags=${counts.tags} loadMs=${settled.loadCompleteMs}${settled.timedOut ? '(TIMEOUT)' : ''}`,
      )
      expect(settled.count, 'all seeded notes should reload from IndexedDB').toBeGreaterThanOrEqual(COUNT)
      expect(counts.tags, 'all seeded tags should reload from IndexedDB').toBeGreaterThanOrEqual(TAG_COUNT)

      // CHECK 1 — tags & references.
      const refs = await assertTagsAndReferences(page, seed)
      console.log(
        `[check1 tags+refs] notesChecked=${refs.notesChecked} noteTagMismatches=${refs.noteTagMismatches.length} ` +
          `tagsChecked=${refs.tagsChecked} membershipMismatches=${refs.membershipMismatches.length}`,
      )
      if (refs.noteTagMismatches.length) console.log('  noteTag sample:', JSON.stringify(refs.noteTagMismatches.slice(0, 3)))
      if (refs.membershipMismatches.length) console.log('  membership sample:', JSON.stringify(refs.membershipMismatches.slice(0, 3)))

      // CHECK 2 — tag filter.
      const filter = await assertTagFilter(page, seed)
      console.log(`[check2 tag-filter] tagsChecked=${Object.keys(seed.tagMembership).length} mismatches=${filter.length}`)
      if (filter.length) console.log('  filter sample:', JSON.stringify(filter.slice(0, 3)))

      // CHECK 3 — search.
      const search = await assertSearch(page, seed)
      console.log(
        `[check3 search] query=${search.query} expected=${search.expected} matched=${search.matched} ` +
          `missing=${search.missing.length} extra=${search.extra.length} ` +
          `bodyTokenConfirmed=${search.bodyTokenConfirmed} liteEncountered=${search.liteEncountered}`,
      )

      // CHECK 4 — edit -> save -> reload round-trip.
      const edited = await assertEditedNoteText(page, edit.uuid, edit.newText)
      console.log(
        `[check4 edit-roundtrip] found=${edited.found} matches=${edited.matches} wasLite=${edited.wasLite} got="${edited.got}"`,
      )

      // No uncaught page errors during the whole flow.
      expect(pageErrors, `no uncaught page errors\n${pageErrors.join('\n')}`).toEqual([])

      // ---- HARD ASSERTIONS (the gate) ----
      expect(refs.noteTagMismatches, 'CHECK1: every tagged note must resolve its exact seeded tags after cold reload').toEqual([])
      expect(refs.membershipMismatches, 'CHECK1: every tag must resolve its exact seeded note membership after cold reload').toEqual([])
      expect(filter, 'CHECK2: tag filter (getDisplayableNotes scoped to a tag) must return exactly the seeded members').toEqual([])
      expect(search.matched, 'CHECK3: search must match exactly the seeded token notes (count)').toBe(search.expected)
      expect(search.missing, 'CHECK3: no seeded token note may be missing from search results').toEqual([])
      expect(search.extra, 'CHECK3: no unexpected note may appear in search results').toEqual([])
      expect(
        search.bodyTokenConfirmed,
        'CHECK3: every matched token note must carry the token in its (re-hydrated) full body',
      ).toBe(search.expected)
      expect(edited.found, 'CHECK4: edited note must still exist after reload').toBe(true)
      expect(edited.matches, 'CHECK4: edited note text must persist across reload (re-hydrating if lite)').toBe(true)
    } finally {
      await context.close()
    }
  })
})
