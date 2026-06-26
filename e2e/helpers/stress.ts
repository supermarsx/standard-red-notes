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
  /** Peak `performance.memory.usedJSHeapSize` (MB) sampled DURING the seed, or null where unavailable. */
  peakSeedHeapMB: number | null
  /** Number of batches the seed was chunked into. */
  batches: number
  /** Seeding path actually used: 'emit+sync' (chunked emit) | 'device' (storage.savePayloads) | 'per-item' (fallback). */
  path: 'emit+sync' | 'device' | 'per-item'
}

/**
 * How many notes to construct + flush per batch. Peak memory during seeding is
 * ~ BATCH * sizeBytes (one batch resident), NOT count * sizeBytes. At 500KB
 * notes, BATCH=2000 => ~1GB transient working set per batch instead of the full
 * corpus (which would be 50GB at 100k). Tunable via STRESS_SEED_BATCH.
 */
const DEFAULT_SEED_BATCH = 2000

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
 * CHUNKED bulk-seed: create `count` notes of ~`sizeBytes` body via the live
 * in-page snjs application, in batches of `batch`, flushing each batch to
 * IndexedDB before building the next. Runs entirely in `page.evaluate` so we
 * never pay a per-note round-trip across the CDP boundary.
 *
 * WHY CHUNKED: the previous implementation built ALL `count` payloads into one
 * JS array, then did one `sync.sync()`. At large scales (e.g. 100k notes @
 * 500KB ≈ 50GB) that array is the entire corpus resident at once and the
 * seeding page OOMs. Here, for each batch we:
 *   1. build the batch's `batch` payloads via basePayload.copy(...),
 *   2. emitItemsFromPayloads(batch, LOCAL_INSERTED) to insert them DIRTY,
 *   3. sync.sync(...) to FLUSH that batch's dirty payloads to IndexedDB,
 *   4. DROP all refs to the batch array so GC can reclaim it before the next.
 * Peak construction memory is therefore ~one batch (`batch * sizeBytes`), not
 * the whole corpus. (The app's own item collection still retains inserted notes
 * in memory — that's expected and is the app behavior under measurement; the
 * fix here is to not ALSO hold every `count` payload object in a second array
 * simultaneously during construction.)
 *
 * Notes are created DIRTY (needsSync=true) so each batch's `sync.sync()` flushes
 * it to IndexedDB. With no account this "sync" is purely the local persistence
 * pass (nothing leaves the browser).
 *
 * A peak-heap guard samples `performance.memory.usedJSHeapSize` before/after
 * each batch and returns the peak (MB) so a run can PROVE the seed itself did
 * not blow up.
 */
export async function seedNotes(
  page: Page,
  count: number,
  sizeBytes: number,
  batchSize?: number,
): Promise<SeedResult> {
  const batch =
    batchSize && batchSize > 0
      ? batchSize
      : (() => {
          const v = parseInt(process.env.STRESS_SEED_BATCH ?? '', 10)
          return Number.isFinite(v) && v > 0 ? v : DEFAULT_SEED_BATCH
        })()

  return page.evaluate(
    async ({ count, sizeBytes, batch }) => {
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

      // Heap sampler (Chromium only). Returns usedJSHeapSize in bytes or null.
      const sampleHeapBytes = (): number | null => {
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        return mem ? mem.usedJSHeapSize : null
      }
      let peakHeapBytes = sampleHeapBytes() ?? 0
      let heapSeen = sampleHeapBytes() !== null
      const observeHeap = (): void => {
        const b = sampleHeapBytes()
        if (b !== null) {
          heapSeen = true
          if (b > peakHeapBytes) {
            peakHeapBytes = b
          }
        }
      }

      // Build a body of ~sizeBytes. ASCII so 1 char ~= 1 byte. Verified to work
      // at sizeBytes=512000 (500KB): reps = ceil(512000/57) repeats then slice.
      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
      const reps = Math.max(1, Math.ceil(sizeBytes / filler.length))
      const body = filler.repeat(reps).slice(0, Math.max(0, sizeBytes))

      const seedStart = performance.now()
      let created = 0
      let syncMs = 0
      let batches = 0
      let path: 'emit+sync' | 'per-item' = 'emit+sync'

      // FAST PATH base: create one real note to obtain a genuine DecryptedPayload,
      // then clone it per batch via payload.copy() (fresh uuid + per-note content,
      // all dirty). The base note is created needsSync=false so it is never
      // persisted and vanishes on reload, leaving exactly `count` notes in
      // IndexedDB. PayloadEmitSource.LocalInserted === 3.
      const LOCAL_INSERTED = 3
      const base = await app.mutator.createItem('Note', { title: 'seed-base', text: body }, false)
      const basePayload = base.payload as {
        copy: (override: Record<string, unknown>) => unknown
        content: Record<string, unknown>
      }

      if (typeof app.mutator.emitItemsFromPayloads === 'function') {
        for (let start = 0; start < count; start += batch) {
          const end = Math.min(start + batch, count)
          // Build ONLY this batch's payloads. `payloads` goes out of scope (set
          // to null) after flush so the GC can reclaim it before the next batch.
          let payloads: unknown[] | null = []
          for (let i = start; i < end; i += 1) {
            payloads.push(
              basePayload.copy({
                uuid: crypto.randomUUID(),
                content: { ...basePayload.content, title: `Stress note ${i + 1}`, text: `${i + 1} ${body}` },
                dirty: true,
              }),
            )
          }
          observeHeap() // peak is typically right after building the batch...
          await app.mutator.emitItemsFromPayloads(payloads, LOCAL_INSERTED)
          // FLUSH this batch's dirty payloads to IndexedDB before the next batch.
          const syncStart = performance.now()
          await app.sync.sync({ sourceDescription: 'stress-seed' })
          syncMs += performance.now() - syncStart
          observeHeap() // ...or after the sync writes them out.
          created += end - start
          batches += 1
          // DISCARD the batch from memory: drop the only ref we hold so the
          // constructed payload array can be collected before we build the next.
          payloads = null
        }
      } else {
        // Fallback: per-item create (slow, but correct) if the bulk method is
        // absent. Still chunk the sync so we never accumulate the whole corpus
        // of dirty payloads before a single flush.
        path = 'per-item'
        for (let start = 0; start < count; start += batch) {
          const end = Math.min(start + batch, count)
          for (let i = start; i < end; i += 1) {
            await app.mutator.createItem('Note', { title: `Stress note ${i + 1}`, text: `${i + 1} ${body}` }, true)
            created += 1
          }
          observeHeap()
          const syncStart = performance.now()
          await app.sync.sync({ sourceDescription: 'stress-seed' })
          syncMs += performance.now() - syncStart
          observeHeap()
          batches += 1
        }
      }
      // seedMs covers the whole chunked build+flush loop; syncMs is the portion
      // spent in the per-batch flushes.
      const seedMs = performance.now() - seedStart

      observeHeap()
      const totalItems = app.items.getItems('Note').length
      const peakSeedHeapMB = heapSeen ? Math.round(peakHeapBytes / (1024 * 1024)) : null

      return { requested: count, created, seedMs, syncMs, totalItems, peakSeedHeapMB, batches, path }
    },
    { count, sizeBytes, batch },
  )
}

/**
 * BONUS device-bypass variant for the very largest scales. Instead of inserting
 * each batch into the in-memory item collections (which the app retains) and
 * then syncing, this builds a batch of decrypted payloads and writes them
 * STRAIGHT to IndexedDB via `app.storage.savePayloads(...)`. `DiskStorageService`
 * encrypts the batch and calls the device interface (`device.saveDatabaseEntries`)
 * under the hood, so this is the device path the task describes, reached cleanly
 * from the public in-page application handle (`app.storage`). Because we never
 * call `emitItemsFromPayloads`, the app's item collection does NOT accumulate
 * the seeded notes during seeding — peak memory is ~one batch. The notes load
 * normally from IndexedDB on the next reload.
 *
 * If `app.storage.savePayloads` is not reachable, this throws so the caller can
 * fall back to `seedNotes` (the required deliverable).
 */
export async function seedNotesViaDevice(
  page: Page,
  count: number,
  sizeBytes: number,
  batchSize?: number,
): Promise<SeedResult> {
  const batch =
    batchSize && batchSize > 0
      ? batchSize
      : (() => {
          const v = parseInt(process.env.STRESS_SEED_BATCH ?? '', 10)
          return Number.isFinite(v) && v > 0 ? v : DEFAULT_SEED_BATCH
        })()

  return page.evaluate(
    async ({ count, sizeBytes, batch }) => {
      const app = (window as unknown as {
        mainApplicationGroup?: {
          primaryApplication?: {
            mutator: { createItem: (ct: string, content: unknown, needsSync?: boolean) => Promise<{ payload: unknown }> }
            storage?: { savePayloads?: (payloads: unknown[]) => Promise<void> }
            items: { getItems: (ct: string) => unknown[] }
          }
        }
      }).mainApplicationGroup?.primaryApplication
      if (!app) {
        throw new Error('window.mainApplicationGroup.primaryApplication not available')
      }
      if (!app.storage || typeof app.storage.savePayloads !== 'function') {
        throw new Error('app.storage.savePayloads not reachable — use seedNotes() instead')
      }
      const savePayloads = app.storage.savePayloads.bind(app.storage)

      const sampleHeapBytes = (): number | null => {
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        return mem ? mem.usedJSHeapSize : null
      }
      let peakHeapBytes = sampleHeapBytes() ?? 0
      let heapSeen = sampleHeapBytes() !== null
      const observeHeap = (): void => {
        const b = sampleHeapBytes()
        if (b !== null) {
          heapSeen = true
          if (b > peakHeapBytes) {
            peakHeapBytes = b
          }
        }
      }

      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
      const reps = Math.max(1, Math.ceil(sizeBytes / filler.length))
      const body = filler.repeat(reps).slice(0, Math.max(0, sizeBytes))

      const seedStart = performance.now()
      let created = 0
      let syncMs = 0
      let batches = 0

      // Base decrypted payload to clone (needsSync=false: never enters sync queue).
      const base = await app.mutator.createItem('Note', { title: 'seed-base', text: body }, false)
      const basePayload = base.payload as {
        copy: (override: Record<string, unknown>) => unknown
        content: Record<string, unknown>
      }

      for (let start = 0; start < count; start += batch) {
        const end = Math.min(start + batch, count)
        let payloads: unknown[] | null = []
        for (let i = start; i < end; i += 1) {
          payloads.push(
            basePayload.copy({
              uuid: crypto.randomUUID(),
              content: { ...basePayload.content, title: `Stress note ${i + 1}`, text: `${i + 1} ${body}` },
              dirty: false,
            }),
          )
        }
        observeHeap()
        const writeStart = performance.now()
        // Encrypts the batch + writes straight to IndexedDB via device.saveDatabaseEntries.
        await savePayloads(payloads)
        syncMs += performance.now() - writeStart
        observeHeap()
        created += end - start
        batches += 1
        payloads = null // DISCARD batch before building the next.
      }
      const seedMs = performance.now() - seedStart

      observeHeap()
      // Not emitted into the collection, so getItems('Note') only sees the base.
      const totalItems = app.items.getItems('Note').length
      const peakSeedHeapMB = heapSeen ? Math.round(peakHeapBytes / (1024 * 1024)) : null

      return {
        requested: count,
        created,
        seedMs,
        syncMs,
        totalItems,
        peakSeedHeapMB,
        batches,
        path: 'device' as const,
      }
    },
    { count, sizeBytes, batch },
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
