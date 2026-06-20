/**
 * Stress / benchmark harness for the note/file LIST display pipeline (the path
 * the ItemListController + ContentList/ContentTableView drive on every reload).
 *
 * This is NOT a correctness test. It synthesizes a large (10k) library and
 * MEASURES + REPORTS the cost of the operations the live list performs on every
 * `reloadItems`, so we can reason about responsiveness at scale:
 *
 *   1. Build the displayed list: filter (display-options + substring query) then
 *      sort (pinned-first, field compare — the same shape as the model's
 *      `notesAndFilesMatchingOptions` + `sortTwoItems`) over 10k items.
 *   2. Compute the rendered WINDOW: `items.slice(0, notesToDisplay)`, i.e. the
 *      paginated subset `ContentList`/`Table` actually render. This is what keeps
 *      the DOM small regardless of library size.
 *   3. Apply a filter/sort CHANGE over 10k (the cost of a keystroke in search and
 *      of toggling the sort field) — the user-perceived latency.
 *   4. A file-heavy variant of (1)-(2) (Files smart view / table view path).
 *   5. An "import 10k" simulation: allocate 10k template-shaped items and run the
 *      full build+window pipeline, modelling the post-import first render.
 *
 * The display pipeline is reproduced here over plain item-shaped objects rather
 * than real `SNNote`/collection instances: constructing 10k decrypted snjs items
 * + a reference-lookup collection is heavyweight and lives in the off-limits
 * models package. The operations measured (Array.prototype.filter with the same
 * predicate chain, Array.prototype.sort with the same comparator incl.
 * `localeCompare`, lowercase substring match, and `slice`) are the actual
 * algorithmic work; modelling them over POJOs gives a faithful, deterministic,
 * web-reachable lower bound on the list's per-reload cost.
 *
 * Everything is deterministic (seeded mulberry32 — no Math.random / Date.now),
 * so runs are reproducible. Timings are logged; the few assertions are
 * deliberately SOFT (very generous ceilings) so this can sit in CI without
 * flaking on a slow/contended machine or under jsdom.
 *
 * Run just this file with:
 *   yarn jest --config jest.config.js ItemListDisplay.bench
 */
import { CollectionSort } from '@standardnotes/snjs'

type CollectionSortValue = (typeof CollectionSort)[keyof typeof CollectionSort]

// ---------------------------------------------------------------------------
// Deterministic pseudo-random generator (mulberry32). Seeded so the dataset is
// byte-for-byte reproducible across runs/machines.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TITLE_WORDS = [
  'note', 'meeting', 'project', 'idea', 'task', 'plan', 'review', 'budget', 'design', 'client',
  'recipe', 'travel', 'invoice', 'payment', 'summary', 'report', 'analysis', 'research', 'draft', 'final',
  'team', 'sprint', 'feature', 'bug', 'release', 'roadmap', 'metric', 'growth', 'revenue', 'garden',
]

/**
 * Minimal shape the display pipeline reads. Mirrors the fields `sortTwoItems` and
 * the display-options filters touch on a real SNNote/FileItem.
 */
interface BenchItem {
  uuid: string
  title: string
  text: string
  content_type: 'Note' | 'File'
  created_at: Date
  updated_at: Date
  pinned: boolean
  archived: boolean
  trashed: boolean
  protected: boolean
  conflictOf?: string
}

function makeTitle(rng: () => number, wordCount: number): string {
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(TITLE_WORDS[Math.floor(rng() * TITLE_WORDS.length)])
  }
  return words.join(' ')
}

function makeText(rng: () => number, wordCount: number): string {
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(TITLE_WORDS[Math.floor(rng() * TITLE_WORDS.length)])
  }
  return words.join(' ') + '.'
}

/**
 * Generate `count` note/file items. Distribution is a deterministic mix so the
 * 10k set resembles a real account: a sprinkle of pinned/archived/trashed and an
 * optional fraction of files. Seeded entirely by `seed` + index.
 */
function generateItems(count: number, fileFraction = 0, seed = 4242): BenchItem[] {
  const items: BenchItem[] = new Array(count)
  // A fixed epoch so created/updated are deterministic (no Date.now()).
  const epoch = Date.UTC(2020, 0, 1)
  for (let i = 0; i < count; i++) {
    const rng = mulberry32(seed + i)
    const isFile = rng() < fileFraction
    // Spread timestamps over ~2 years so the date sort is meaningfully exercised
    // and ties are rare.
    const createdOffset = Math.floor(rng() * 63_000_000_000)
    const updatedOffset = createdOffset + Math.floor(rng() * 1_000_000_000)
    items[i] = {
      uuid: `item-${i}`,
      title: makeTitle(rng, 2 + Math.floor(rng() * 4)),
      text: isFile ? '' : makeText(rng, 8 + Math.floor(rng() * 40)),
      content_type: isFile ? 'File' : 'Note',
      created_at: new Date(epoch + createdOffset),
      updated_at: new Date(epoch + updatedOffset),
      // ~3% pinned, ~4% archived, ~2% trashed, ~2% protected.
      pinned: rng() < 0.03,
      archived: rng() < 0.04,
      trashed: rng() < 0.02,
      protected: rng() < 0.02,
      conflictOf: undefined,
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Display pipeline — faithful reproduction of the operations the live list runs.
// ---------------------------------------------------------------------------

interface DisplayOptions {
  sortBy: CollectionSortValue
  sortDirection: 'asc' | 'dsc'
  includePinned: boolean
  includeArchived: boolean
  includeTrashed: boolean
  includeProtected: boolean
  query: string
}

/**
 * Mirror of `computeFiltersForDisplayOptions` + `itemMatchesQuery` (substring on
 * title/text) — the predicate chain `notesAndFilesMatchingOptions` applies.
 */
function filterItems(items: BenchItem[], options: DisplayOptions): BenchItem[] {
  const query = options.query.toLowerCase()
  const hasQuery = query.length > 0
  return items.filter((item) => {
    if (!options.includePinned && item.pinned) {
      return false
    }
    if (!options.includeProtected && item.protected) {
      return false
    }
    if (!options.includeTrashed && item.trashed) {
      return false
    }
    if (!options.includeArchived && item.archived) {
      return false
    }
    if (item.conflictOf) {
      return false
    }
    if (hasQuery) {
      // Substring match over title + text, the existing default search behavior.
      if (item.title.toLowerCase().indexOf(query) === -1 && item.text.toLowerCase().indexOf(query) === -1) {
        return false
      }
    }
    return true
  })
}

const SortLeftFirst = -1
const SortRightFirst = 1
const KeepSameOrder = 0

/** Mirror of the model's `sortTwoItems` (pinned-first, field compare). */
function sortTwoItems(a: BenchItem, b: BenchItem, sortBy: CollectionSortValue, sortDirection: 'asc' | 'dsc'): number {
  if (a.pinned && b.pinned) {
    // fall through to field compare
  } else if (a.pinned) {
    return SortLeftFirst
  } else if (b.pinned) {
    return SortRightFirst
  }

  const key =
    sortBy === CollectionSort.Title
      ? 'title'
      : sortBy === CollectionSort.UpdatedAt
        ? 'updated_at'
        : 'created_at'

  const aValue = (a as unknown as Record<string, unknown>)[key] ?? ''
  const bValue = (b as unknown as Record<string, unknown>)[key] ?? ''
  const smallerNaturallyComesFirst = sortDirection === 'asc'

  let compareResult = KeepSameOrder
  if (sortBy === CollectionSort.Title && typeof aValue === 'string' && typeof bValue === 'string') {
    if (aValue.length > 0 && bValue.length > 0) {
      compareResult = aValue.localeCompare(bValue, 'en', { numeric: true })
    }
  } else if (aValue > bValue) {
    compareResult = SortRightFirst
  } else if (aValue < bValue) {
    compareResult = SortLeftFirst
  }

  if (compareResult === SortLeftFirst) {
    return smallerNaturallyComesFirst ? SortLeftFirst : SortRightFirst
  }
  if (compareResult === SortRightFirst) {
    return smallerNaturallyComesFirst ? SortRightFirst : SortLeftFirst
  }
  return KeepSameOrder
}

/** Filter + sort: the full displayed-list construction (`items` in the controller). */
function buildDisplayedList(items: BenchItem[], options: DisplayOptions): BenchItem[] {
  const filtered = filterItems(items, options)
  filtered.sort((a, b) => sortTwoItems(a, b, options.sortBy, options.sortDirection))
  return filtered
}

/** The render window the list actually mounts: `items.slice(0, notesToDisplay)`. */
function computeRenderWindow(items: BenchItem[], notesToDisplay: number): BenchItem[] {
  return items.slice(0, notesToDisplay)
}

// ---------------------------------------------------------------------------
// Timing helpers (identical style to SearchIndex.bench.spec.ts).
// ---------------------------------------------------------------------------
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()

function ms(value: number): string {
  return `${value.toFixed(2)} ms`
}

interface LatencyStats {
  p50: number
  p95: number
  max: number
  mean: number
  runs: number
}

function measure(fn: () => void, runs: number): LatencyStats {
  const samples: number[] = new Array(runs)
  for (let i = 0; i < runs; i++) {
    const start = now()
    fn()
    samples[i] = now() - start
  }
  samples.sort((a, b) => a - b)
  const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length
  return { p50: pct(50), p95: pct(95), max: samples[samples.length - 1], mean, runs }
}

function logStats(label: string, stats: LatencyStats): void {
  // eslint-disable-next-line no-console
  console.log(
    `  ${label.padEnd(40)} p50=${ms(stats.p50).padStart(10)}  p95=${ms(stats.p95).padStart(10)}  ` +
      `max=${ms(stats.max).padStart(10)}  mean=${ms(stats.mean).padStart(10)}  (n=${stats.runs})`,
  )
}

// Generous CI ceilings (multiples of expected so a slow/contended box won't flake).
const CEILING_BUILD_10K_MS = 5_000
const CEILING_WINDOW_MS = 200
const CEILING_FILTER_CHANGE_MS = 5_000
const CEILING_IMPORT_10K_MS = 10_000

describe('Item list display benchmark', () => {
  const ITEM_COUNT = 10_000
  // Typical viewport page size: clientHeight / MinNoteCellHeight (51px). The live
  // list starts here and grows by this on scroll (see ItemListController.resetPagination).
  const NOTES_TO_DISPLAY = 20

  const baseOptions: DisplayOptions = {
    sortBy: CollectionSort.CreatedAt,
    sortDirection: 'dsc',
    includePinned: true,
    includeArchived: false,
    includeTrashed: false,
    includeProtected: true,
    query: '',
  }

  let notes: BenchItem[]
  let fileHeavy: BenchItem[]

  beforeAll(() => {
    notes = generateItems(ITEM_COUNT, 0)
    fileHeavy = generateItems(ITEM_COUNT, 0.6)
  })

  it('1) builds the displayed list (filter + sort) for 10k notes', () => {
    // eslint-disable-next-line no-console
    console.log(`\n[Displayed-list build] ${ITEM_COUNT} notes (filter + pinned-first sort)`)

    for (const sortBy of [CollectionSort.CreatedAt, CollectionSort.UpdatedAt, CollectionSort.Title]) {
      const options = { ...baseOptions, sortBy }
      let built: BenchItem[] = []
      const stats = measure(() => {
        built = buildDisplayedList(notes, options)
      }, 50)
      logStats(`build (sortBy=${sortBy})`, stats)
      expect(built.length).toBeGreaterThan(0)
      expect(stats.p95).toBeLessThan(CEILING_BUILD_10K_MS)
    }
  })

  it('2) computes the rendered window (slice) over the 10k displayed list', () => {
    const built = buildDisplayedList(notes, baseOptions)
    // eslint-disable-next-line no-console
    console.log(`\n[Render window] slice(0, notesToDisplay) over ${built.length} displayed items`)

    for (const display of [NOTES_TO_DISPLAY, 100, 500]) {
      let windowed: BenchItem[] = []
      const stats = measure(() => {
        windowed = computeRenderWindow(built, display)
      }, 1000)
      logStats(`window (notesToDisplay=${display})`, stats)
      expect(windowed.length).toBe(Math.min(display, built.length))
      expect(stats.p95).toBeLessThan(CEILING_WINDOW_MS)
    }

    // eslint-disable-next-line no-console
    console.log(
      `  -> live list renders ${Math.min(NOTES_TO_DISPLAY, built.length)} of ${built.length} rows initially ` +
        `(${((Math.min(NOTES_TO_DISPLAY, built.length) / built.length) * 100).toFixed(2)}%); grows on scroll.`,
    )
  })

  it('3) applies a filter/sort change over 10k (keystroke + sort-toggle latency)', () => {
    // eslint-disable-next-line no-console
    console.log('\n[Filter/sort change over 10k] (user-perceived latency)')

    // Search keystroke: substring filter + re-sort + re-window. This is the full
    // work `handleFilterTextChanged -> reloadItems` does on every character.
    for (const query of ['p', 'project', 'meeting project']) {
      const options = { ...baseOptions, query }
      let result = 0
      const stats = measure(() => {
        const built = buildDisplayedList(notes, options)
        result = computeRenderWindow(built, NOTES_TO_DISPLAY).length
      }, 50)
      logStats(`search keystroke query="${query}"`, stats)
      expect(stats.p95).toBeLessThan(CEILING_FILTER_CHANGE_MS)
      expect(result).toBeGreaterThanOrEqual(0)
    }

    // Sort-field toggle: re-sort + re-window with no query.
    const toggleStats = measure(() => {
      const built = buildDisplayedList(notes, { ...baseOptions, sortBy: CollectionSort.Title })
      computeRenderWindow(built, NOTES_TO_DISPLAY)
    }, 50)
    logStats('sort-field toggle -> Title', toggleStats)
    expect(toggleStats.p95).toBeLessThan(CEILING_FILTER_CHANGE_MS)
  })

  it('4) builds + windows a file-heavy 10k library (table view path)', () => {
    // eslint-disable-next-line no-console
    console.log(`\n[File-heavy library] ${ITEM_COUNT} items (~60% files)`)

    let built: BenchItem[] = []
    const buildStats = measure(() => {
      built = buildDisplayedList(fileHeavy, { ...baseOptions, sortBy: CollectionSort.CreatedAt })
    }, 50)
    logStats('build (file-heavy)', buildStats)
    expect(built.length).toBeGreaterThan(0)
    expect(buildStats.p95).toBeLessThan(CEILING_BUILD_10K_MS)

    // The table view (ContentTableView/Table) also paginates: rows.slice(0, rowsToDisplay).
    const windowStats = measure(() => {
      computeRenderWindow(built, NOTES_TO_DISPLAY)
    }, 1000)
    logStats('table render window', windowStats)
    expect(windowStats.p95).toBeLessThan(CEILING_WINDOW_MS)

    const fileCount = built.filter((i) => i.content_type === 'File').length
    // eslint-disable-next-line no-console
    console.log(`  displayed ${built.length} items (${fileCount} files); table renders first ${NOTES_TO_DISPLAY}.`)
  })

  it('5) simulates importing 10k items (allocate + first build/window)', () => {
    // eslint-disable-next-line no-console
    console.log('\n[Import 10k simulation] allocate template-shaped items + first display build')

    let imported: BenchItem[] = []
    const allocStats = measure(() => {
      // Fresh deterministic generation each run models the import producing 10k
      // brand-new items (distinct seed offset so it is not the cached dataset).
      imported = generateItems(ITEM_COUNT, 0, 99_000)
    }, 10)
    logStats('allocate 10k items', allocStats)
    expect(imported.length).toBe(ITEM_COUNT)

    // First render after import: full build + initial window.
    const firstRenderStats = measure(() => {
      const built = buildDisplayedList(imported, baseOptions)
      computeRenderWindow(built, NOTES_TO_DISPLAY)
    }, 20)
    logStats('first display build + window', firstRenderStats)
    expect(firstRenderStats.p95).toBeLessThan(CEILING_IMPORT_10K_MS)
  })
})
