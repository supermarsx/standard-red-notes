import { type Page } from '@playwright/test'

/**
 * Seeding + measurement helpers for the notes stress-characterization harness.
 *
 * SEEDING PATH (chosen after reading the app source):
 * The web app exposes its live snjs application group on `window`:
 *   - `app/packages/web/.../ApplicationGroupView.tsx`  ->  `window.mainApplicationGroup = this.group`
 *   - `app/packages/snjs/.../ApplicationGroup.ts`       ->  `public primaryApplication`
 * The primary application (snjs `Application`) exposes public getters
 * `mutator`, `items`, `sync` (see `app/packages/snjs/lib/Application/Application.ts`).
 * `mutator.createItem(contentType, content, needsSync)` inserts a decrypted
 * payload straight into the payload/item managers; created with needsSync=true
 * the payload is marked DIRTY, and a single `sync.sync()` then persists every
 * dirty payload to IndexedDB (local-only, no account). That is the
 * fastest realistic path: we drive the exact same code the app uses to create
 * notes, so the seeded items are byte-for-byte real notes (decrypted into
 * memory, written to IndexedDB) — precisely the data path whose ceiling we
 * want to characterize. No need to hand-shape IndexedDB payloads.
 *
 * ContentType.TYPES.Note === 'Note' (verified in
 * `@standardnotes/domain-core` dist). Note content shape is `{ title, text }`.
 */

export type SeedResult = {
  requested: number
  created: number
  seedMs: number
  syncMs: number
  totalItems: number
}

/**
 * Wait until the snjs primary application is launched and reachable on
 * `window.mainApplicationGroup`. Returns when the app is ready to accept
 * mutator calls.
 */
export async function waitForApplicationReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const group = (window as unknown as { mainApplicationGroup?: { primaryApplication?: { isLaunched?: () => boolean } } })
        .mainApplicationGroup
      const app = group?.primaryApplication
      return Boolean(app && typeof app.isLaunched === 'function' && app.isLaunched())
    },
    undefined,
    { timeout: timeoutMs },
  )
}

/**
 * Bulk-seed `count` notes of approximately `sizeBytes` body size via the live
 * in-page snjs application, then persist with a single sync. Runs entirely in
 * `page.evaluate` so we never pay the per-note round-trip cost across the CDP
 * boundary. Notes are created DIRTY (needsSync=true) so the single trailing
 * `sync.sync()` flushes them all to IndexedDB. With no account this "sync" is
 * purely the local persistence pass (nothing leaves the browser).
 */
export async function seedNotes(page: Page, count: number, sizeBytes: number): Promise<SeedResult> {
  return page.evaluate(
    async ({ count, sizeBytes }) => {
      const app = (window as unknown as {
        mainApplicationGroup?: {
          primaryApplication?: {
            mutator: {
              createItem: (ct: string, content: unknown, needsSync?: boolean) => Promise<{ payload: unknown }>
              emitItemsFromPayloads?: (payloads: unknown[], emitSource: number) => Promise<unknown[]>
            }
            sync: { sync: (opts?: unknown) => Promise<unknown> }
            items: { getItems: (ct: string) => unknown[] }
          }
        }
      }).mainApplicationGroup?.primaryApplication
      if (!app) {
        throw new Error('window.mainApplicationGroup.primaryApplication not available')
      }

      // Build a body of ~sizeBytes. ASCII so 1 char ~= 1 byte.
      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
      const reps = Math.max(1, Math.ceil(sizeBytes / filler.length))
      const body = filler.repeat(reps).slice(0, Math.max(0, sizeBytes))

      const seedStart = performance.now()
      let created = 0

      // FAST PATH: create one real note to obtain a genuine DecryptedPayload,
      // then clone it `count` times via payload.copy() (fresh uuid + per-note
      // content, all dirty) and emit them in ONE batched pass. createItem
      // one-at-a-time re-sorts the display controller per insert (O(n^2) total,
      // ~9 min for 15k); a single emitItemsFromPayloads re-sorts once. The base
      // note is created needsSync=false so it is never persisted and vanishes on
      // reload, leaving exactly `count` notes loaded from IndexedDB.
      // PayloadEmitSource.LocalInserted === 3.
      const LOCAL_INSERTED = 3
      const base = await app.mutator.createItem('Note', { title: 'seed-base', text: body }, false)
      const basePayload = base.payload as {
        copy: (override: Record<string, unknown>) => unknown
        content: Record<string, unknown>
      }

      if (typeof app.mutator.emitItemsFromPayloads === 'function') {
        const payloads: unknown[] = []
        for (let i = 0; i < count; i += 1) {
          payloads.push(
            basePayload.copy({
              uuid: crypto.randomUUID(),
              content: { ...basePayload.content, title: `Stress note ${i + 1}`, text: `${i + 1} ${body}` },
              dirty: true,
            }),
          )
        }
        await app.mutator.emitItemsFromPayloads(payloads, LOCAL_INSERTED)
        created = count
      } else {
        // Fallback: per-item create (slow, but correct) if the bulk method is absent.
        for (let i = 0; i < count; i += 1) {
          await app.mutator.createItem('Note', { title: `Stress note ${i + 1}`, text: `${i + 1} ${body}` }, true)
          created += 1
        }
      }
      const seedMs = performance.now() - seedStart

      const syncStart = performance.now()
      await app.sync.sync({ sourceDescription: 'stress-seed' })
      const syncMs = performance.now() - syncStart

      const totalItems = app.items.getItems('Note').length

      return { requested: count, created, seedMs, syncMs, totalItems }
    },
    { count, sizeBytes },
  )
}

/** Number of note items currently held in memory by the app (verifies persistence). */
export async function inMemoryNoteCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const group = (window as unknown as {
      mainApplicationGroup?: { primaryApplication?: { items?: { getItems: (ct: string) => unknown[] } } }
    }).mainApplicationGroup
    const app = group?.primaryApplication
    return app?.items ? app.items.getItems('Note').length : -1
  })
}

/**
 * Wait for the cold-load to actually FINISH, then report the settled count.
 *
 * `app.isLaunched()` flips true while `SyncService.loadDatabasePayloads` is still
 * emitting decrypted notes in sleep-paced batches — so sampling `getItems('Note')`
 * right after "ready" catches the load mid-flight and UNDER-reports (this is why a
 * naive measurement showed ~4900/5000: a sampling artifact, not a hard ceiling).
 *
 * Here we poll the in-memory note count until it stops growing for
 * `stableForMs` (the incremental load has drained), or until `timeoutMs`. We
 * return both the final settled count and the wall-clock from call-start to the
 * moment the count last increased — i.e. the true cold-load completion time.
 */
export async function waitForNoteCountSettled(
  page: Page,
  opts: { timeoutMs?: number; pollMs?: number; stableForMs?: number } = {},
): Promise<{ count: number; loadCompleteMs: number; timedOut: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const pollMs = opts.pollMs ?? 250
  const stableForMs = opts.stableForMs ?? 2_000

  const start = Date.now()
  let lastCount = -1
  let lastIncreaseAt = start
  let timedOut = false

  for (;;) {
    const current = await inMemoryNoteCount(page)
    const now = Date.now()

    if (current > lastCount) {
      lastCount = current
      lastIncreaseAt = now
    }

    // Settled: count hasn't grown for stableForMs and we've actually loaded
    // something (lastCount > 0 guards against measuring a not-yet-started load).
    if (lastCount > 0 && now - lastIncreaseAt >= stableForMs) {
      break
    }

    if (now - start >= timeoutMs) {
      timedOut = true
      break
    }

    await page.waitForTimeout(pollMs)
  }

  return { count: lastCount, loadCompleteMs: lastIncreaseAt - start, timedOut }
}

export type LoadMeasurement = {
  count: number
  openMs: number | null
  rootHasChildren: boolean
  renderedRows: number
  inMemoryNotes: number
  loadCompleteMs: number | null
  loadTimedOut: boolean
  scrollResponsive: boolean | null
  scrollProbeMs: number | null
  jsHeapMB: number | null
  pageErrors: string[]
  verdict: 'ok' | 'degraded' | 'failed'
  notes: string
}

/** Read JS heap (Chromium only) in MB, or null where unavailable. */
export async function readJsHeapMB(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : null
  })
}
