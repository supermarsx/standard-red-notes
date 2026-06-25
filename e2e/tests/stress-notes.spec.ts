import { test, expect, type Page } from '@playwright/test'
import {
  seedNotes,
  waitForApplicationReady,
  inMemoryNoteCount,
  readJsHeapMB,
  type LoadMeasurement,
} from '../helpers/stress'

/**
 * SCALING stress-characterization harness for the notes list.
 *
 * GOAL: this is NOT a pass/fail "100k works" test — we KNOW the app is not
 * built for huge datasets (the notes list infinite-appends DOM without
 * recycling, every item is decrypted into memory, IndexedDB holds everything).
 * Instead this harness SEEDS notes at ramping counts and MEASURES where the app
 * degrades or breaks, so we can document the real ceiling and later prove a fix.
 * Honesty over green checkmarks: we only HARD-ASSERT basic sanity at the small
 * default count (so CI stays green); at larger counts we RECORD the outcome
 * (ok / degraded / failed) without failing the test.
 *
 * SEEDING: via the live in-page snjs application exposed on
 * `window.mainApplicationGroup.primaryApplication` — see helpers/stress.ts for
 * the full rationale and the source references that prove the handle exists.
 *
 * ENV PARAMETERS:
 *   STRESS_NOTE_COUNT      total notes to seed per scale (default 500, CI-safe).
 *   STRESS_NOTE_SIZE_BYTES note body size in bytes        (default 5120 = 5 KiB).
 *   STRESS_RAMP            comma list of counts, e.g. "500,2000,10000" — runs
 *                          each scale in one go (overrides STRESS_NOTE_COUNT).
 *
 * On a capable machine STRESS_RAMP can be pushed toward "...,50000,100000" to
 * find the actual ceiling; expect long seed + load times (hence the generous
 * per-test timeout below). Each scale runs in a FRESH browser context so seeded
 * IndexedDB does not leak between scales.
 */

const APP_SHELL = '.main-ui-view, #footer-bar'
const ROW_SELECTOR = '.content-list-item'
const SCROLL_CONTAINER = '#notes-scrollable'

const DEFAULT_COUNT = 500
const DEFAULT_SIZE = 5120

function parseRamp(): number[] {
  const ramp = process.env.STRESS_RAMP?.trim()
  if (ramp) {
    return ramp
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  }
  const single = parseInt(process.env.STRESS_NOTE_COUNT ?? '', 10)
  return [Number.isFinite(single) && single > 0 ? single : DEFAULT_COUNT]
}

const SIZE_BYTES = (() => {
  const v = parseInt(process.env.STRESS_NOTE_SIZE_BYTES ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SIZE
})()

const RAMP = parseRamp()
const SMALLEST = Math.min(...RAMP)

// Generous: seeding + cold load at high counts is slow. 10 min per scale.
test.setTimeout(10 * 60_000)

/** Open the app shell, measuring time-to-visible. Returns ms or null on timeout. */
async function openAppShell(page: Page, timeoutMs: number): Promise<number | null> {
  const start = Date.now()
  try {
    await page.locator(APP_SHELL).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return Date.now() - start
  } catch {
    return null
  }
}

/**
 * Scroll-to-bottom responsiveness probe. Drives the infinite-scroll container
 * to the bottom in steps and re-measures; if the main thread stays responsive
 * the round-trip evaluates quickly. Returns {responsive, ms} or null if the
 * container isn't present.
 */
async function scrollProbe(
  page: Page,
  timeoutMs = 20_000,
): Promise<{ responsive: boolean; ms: number } | null> {
  const exists = await page.locator(SCROLL_CONTAINER).count()
  if (!exists) {
    return null
  }
  const start = Date.now()
  try {
    // Several scroll bumps to trigger pagination/append work, each gated on a
    // round-trip evaluate (a frozen main thread can't answer -> we time out).
    for (let i = 0; i < 6; i += 1) {
      await page.evaluate(
        (sel) => {
          const el = document.querySelector(sel as string) as HTMLElement | null
          if (el) {
            el.scrollTop = el.scrollHeight
          }
        },
        SCROLL_CONTAINER,
      )
      // A small responsiveness ping: rAF resolves only if the main thread runs.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        undefined,
      )
    }
    const ms = Date.now() - start
    return { responsive: ms < timeoutMs, ms }
  } catch {
    return { responsive: false, ms: Date.now() - start }
  }
}

const results: LoadMeasurement[] = []

for (const count of RAMP) {
  const isSmallest = count === SMALLEST

  test(`stress: ${count} notes @ ${SIZE_BYTES}B`, async ({ browser }) => {
    // Fresh, isolated context per scale so IndexedDB doesn't carry over.
    const context = await browser.newContext()
    const page = await context.newPage()

    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    const measurement: LoadMeasurement = {
      count,
      openMs: null,
      rootHasChildren: false,
      renderedRows: 0,
      inMemoryNotes: -1,
      scrollResponsive: null,
      scrollProbeMs: null,
      jsHeapMB: null,
      pageErrors,
      verdict: 'failed',
      notes: '',
    }

    try {
      // 1) Load fresh, wait for the snjs app to launch, then seed.
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.locator(APP_SHELL).first().waitFor({ state: 'visible', timeout: 60_000 })
      await waitForApplicationReady(page, 60_000)

      const seed = await seedNotes(page, count, SIZE_BYTES)
      console.log(
        `[seed] count=${count} created=${seed.created} seedMs=${Math.round(seed.seedMs)} ` +
          `syncMs=${Math.round(seed.syncMs)} totalNoteItems=${seed.totalItems}`,
      )

      // 2) Reload FRESH so the app must boot from IndexedDB with all notes —
      // this is the cold-open path whose ceiling we care about.
      await page.reload({ waitUntil: 'domcontentloaded' })
      measurement.openMs = await openAppShell(page, 5 * 60_000)
      await waitForApplicationReady(page, 5 * 60_000).catch(() => {})

      // 3) Measure render + memory + responsiveness.
      measurement.rootHasChildren = await page.evaluate(() => {
        const root = document.getElementById('app-group-root')
        return Boolean(root && root.childElementCount > 0)
      })

      // Give the list a moment to render its first page of rows.
      await page
        .locator(ROW_SELECTOR)
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 })
        .catch(() => {})
      measurement.renderedRows = await page.locator(ROW_SELECTOR).count()
      measurement.inMemoryNotes = await inMemoryNoteCount(page)

      const probe = await scrollProbe(page)
      measurement.scrollResponsive = probe ? probe.responsive : null
      measurement.scrollProbeMs = probe ? probe.ms : null
      // rows may grow after scroll-driven pagination
      measurement.renderedRows = Math.max(measurement.renderedRows, await page.locator(ROW_SELECTOR).count())

      measurement.jsHeapMB = await readJsHeapMB(page)

      // 4) Verdict — descriptive, not pass/fail.
      const fatalErrors = pageErrors.length > 0
      if (measurement.openMs === null || !measurement.rootHasChildren) {
        measurement.verdict = 'failed'
        measurement.notes = measurement.openMs === null ? 'app shell never became visible' : 'app-group-root empty'
      } else if (
        fatalErrors ||
        measurement.scrollResponsive === false ||
        (measurement.openMs ?? 0) > 30_000 ||
        measurement.renderedRows === 0
      ) {
        measurement.verdict = 'degraded'
        measurement.notes = [
          fatalErrors ? `pageerrors=${pageErrors.length}` : '',
          measurement.scrollResponsive === false ? 'scroll unresponsive' : '',
          (measurement.openMs ?? 0) > 30_000 ? `slow open (${measurement.openMs}ms)` : '',
          measurement.renderedRows === 0 ? 'no rows rendered' : '',
        ]
          .filter(Boolean)
          .join('; ')
      } else {
        measurement.verdict = 'ok'
      }
    } catch (err) {
      measurement.verdict = 'failed'
      measurement.notes = `exception: ${(err as Error).message}`
    } finally {
      results.push(measurement)

      // Playwright annotations for the report artifact.
      test.info().annotations.push(
        { type: `stress:count`, description: String(count) },
        { type: `stress:openMs`, description: String(measurement.openMs) },
        { type: `stress:renderedRows`, description: String(measurement.renderedRows) },
        { type: `stress:inMemoryNotes`, description: String(measurement.inMemoryNotes) },
        { type: `stress:scrollResponsive`, description: String(measurement.scrollResponsive) },
        { type: `stress:jsHeapMB`, description: String(measurement.jsHeapMB) },
        { type: `stress:pageErrors`, description: String(pageErrors.length) },
        { type: `stress:verdict`, description: `${measurement.verdict} ${measurement.notes}`.trim() },
      )

      console.log(
        `[measure] count=${count} verdict=${measurement.verdict} openMs=${measurement.openMs} ` +
          `rows=${measurement.renderedRows} inMemNotes=${measurement.inMemoryNotes} ` +
          `scrollResponsive=${measurement.scrollResponsive} scrollMs=${measurement.scrollProbeMs} ` +
          `heapMB=${measurement.jsHeapMB} pageErrors=${pageErrors.length}` +
          (measurement.notes ? ` notes="${measurement.notes}"` : ''),
      )

      await context.close()
    }

    // HARD ASSERTIONS only at the smallest (CI-safe default) scale, so the
    // suite is green by default while still genuinely exercising seeding+load.
    if (isSmallest) {
      expect(measurement.openMs, 'small-scale: app shell should open').not.toBeNull()
      expect(measurement.rootHasChildren, 'small-scale: app-group-root should have children').toBe(true)
      expect(measurement.inMemoryNotes, 'small-scale: seeded notes should be loaded from IndexedDB').toBeGreaterThanOrEqual(
        count,
      )
      expect(measurement.renderedRows, 'small-scale: at least some rows should render').toBeGreaterThan(0)
      expect(measurement.pageErrors, `small-scale: no uncaught page errors\n${pageErrors.join('\n')}`).toEqual([])
    }
    // Larger scales: intentionally NO hard assertions — we record, not fail.
  })
}

test.afterAll(() => {
  // Clear summary table (count -> open ms, rows, errors, verdict).
  const header = '\n================ STRESS CHARACTERIZATION SUMMARY ================'
  const cols = `${'count'.padStart(8)} | ${'openMs'.padStart(8)} | ${'rows'.padStart(6)} | ${'inMemNotes'.padStart(
    10,
  )} | ${'heapMB'.padStart(7)} | ${'scroll'.padStart(8)} | ${'errs'.padStart(4)} | verdict`
  const lines = results
    .sort((a, b) => a.count - b.count)
    .map((r) => {
      const scroll = r.scrollResponsive === null ? 'n/a' : r.scrollResponsive ? 'ok' : 'STUCK'
      return (
        `${String(r.count).padStart(8)} | ${String(r.openMs ?? 'TIMEOUT').padStart(8)} | ` +
        `${String(r.renderedRows).padStart(6)} | ${String(r.inMemoryNotes).padStart(10)} | ` +
        `${String(r.jsHeapMB ?? 'n/a').padStart(7)} | ${scroll.padStart(8)} | ` +
        `${String(r.pageErrors.length).padStart(4)} | ${r.verdict}${r.notes ? ` (${r.notes})` : ''}`
      )
    })
  console.log([header, cols, '-'.repeat(cols.length), ...lines, '='.repeat(64)].join('\n'))
})
