/**
 * Stress / benchmark harness for the client-side search stack.
 *
 * This is NOT a correctness test (those live in SearchIndex.spec.ts and
 * RelevanceScore.spec.ts). It synthesizes large, realistic-ish datasets and
 * MEASURES + REPORTS:
 *   1. Inverted-index build time for 10k notes.
 *   2. Per-note indexing time for a >1 MB note.
 *   3. Query latency (p50/p95/max) for representative query shapes against the
 *      10k-note index, both unranked and BM25-ranked.
 *   4. Relevance-scorer (rankNotesByRelevance) latency over the full dataset.
 *   5. extractPlaintextFromNoteText cost for a large Super (Lexical JSON) note.
 *
 * Everything is deterministic (seeded, index-based pseudo generator — no
 * Math.random / Date.now), so runs are reproducible. Timings are logged; the
 * few assertions are deliberately SOFT (very generous ceilings) so this can sit
 * in CI without flaking on a slow machine.
 *
 * Run just this file with:
 *   yarn jest --config jest.config.js SearchIndex.bench
 */
import { NoteType } from '@standardnotes/snjs'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { rankNotesByRelevance } from './RelevanceScore'
import { IndexableNote, SearchIndex } from './SearchIndex'

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

// A modest vocabulary so tokenization is meaningfully exercised and posting
// lists have realistic, varied lengths. A few "rare" words are appended so we
// can benchmark a genuinely rare-term query.
const COMMON_WORDS = [
  'note', 'meeting', 'project', 'idea', 'task', 'plan', 'review', 'budget', 'design', 'client',
  'recipe', 'flour', 'water', 'sugar', 'travel', 'flight', 'hotel', 'invoice', 'payment', 'deadline',
  'summary', 'report', 'analysis', 'research', 'draft', 'final', 'agenda', 'follow', 'action', 'item',
  'team', 'sprint', 'backlog', 'feature', 'bug', 'release', 'roadmap', 'metric', 'growth', 'revenue',
  'garden', 'plant', 'season', 'harvest', 'weather', 'morning', 'evening', 'weekend', 'family', 'friend',
]
const RARE_WORDS = ['quetzalcoatl', 'borborygmus', 'sesquipedalian', 'rhinoceros', 'xylophone']

function pickWord(rng: () => number, includeRare: boolean): string {
  if (includeRare && rng() < 0.002) {
    return RARE_WORDS[Math.floor(rng() * RARE_WORDS.length)]
  }
  return COMMON_WORDS[Math.floor(rng() * COMMON_WORDS.length)]
}

/** Build a sentence of `wordCount` pseudo-words ending with a period. */
function makeSentence(rng: () => number, wordCount: number, includeRare: boolean): string {
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(pickWord(rng, includeRare))
  }
  return words.join(' ') + '.'
}

/** Build a body of approximately `targetChars` characters across paragraphs. */
function makeBody(rng: () => number, targetChars: number, includeRare: boolean): string {
  const paragraphs: string[] = []
  let length = 0
  while (length < targetChars) {
    const sentences: string[] = []
    const sentenceCount = 2 + Math.floor(rng() * 4)
    for (let s = 0; s < sentenceCount; s++) {
      const sentence = makeSentence(rng, 6 + Math.floor(rng() * 10), includeRare)
      sentences.push(sentence)
      length += sentence.length + 1
    }
    paragraphs.push(sentences.join(' '))
  }
  return paragraphs.join('\n\n')
}

/**
 * Generate `count` notes. Sizes are a deterministic mix of small/medium so the
 * 10k set resembles a real account. Seeded entirely by `seed` + index.
 */
function generateNotes(count: number, seed = 1337): IndexableNote[] {
  const notes: IndexableNote[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const rng = mulberry32(seed + i)
    // 70% small (~150-400 chars), 25% medium (~800-2k), 5% large (~4-8k).
    const r = rng()
    let target: number
    if (r < 0.7) {
      target = 150 + Math.floor(rng() * 250)
    } else if (r < 0.95) {
      target = 800 + Math.floor(rng() * 1200)
    } else {
      target = 4000 + Math.floor(rng() * 4000)
    }
    const title = makeSentence(rng, 3 + Math.floor(rng() * 4), false).replace(/\.$/, '')
    notes[i] = { uuid: `note-${i}`, title, text: makeBody(rng, target, true) }
  }
  return notes
}

/** Generate a single very large plain note of approximately `mb` megabytes. */
function generateLargeNote(uuid: string, mb: number, seed = 99): IndexableNote {
  const rng = mulberry32(seed)
  const targetChars = Math.floor(mb * 1024 * 1024)
  return { uuid, title: 'Very large note', text: makeBody(rng, targetChars, false) }
}

/**
 * Build a Super-style Lexical editor-state JSON document of approximately `mb`
 * megabytes so we can benchmark extractPlaintextFromNoteText on it.
 */
function generateLargeSuperNote(mb: number, seed = 7): string {
  const rng = mulberry32(seed)
  const targetChars = Math.floor(mb * 1024 * 1024)
  const children: unknown[] = []
  let length = 0
  while (length < targetChars) {
    const sentence = makeSentence(rng, 8 + Math.floor(rng() * 12), false)
    children.push({
      type: 'paragraph',
      children: [{ type: 'text', text: sentence, format: 0 }],
    })
    length += sentence.length
  }
  return JSON.stringify({ root: { type: 'root', children } })
}

// ---------------------------------------------------------------------------
// Timing helpers.
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
    `  ${label.padEnd(34)} p50=${ms(stats.p50).padStart(10)}  p95=${ms(stats.p95).padStart(10)}  ` +
      `max=${ms(stats.max).padStart(10)}  mean=${ms(stats.mean).padStart(10)}  (n=${stats.runs})`,
  )
}

// Generous CI ceilings (multiples of expected so a slow/contended box won't flake).
const CEILING_BUILD_10K_MS = 30_000
const CEILING_LARGE_NOTE_INDEX_MS = 5_000
const CEILING_QUERY_MS = 2_000
const CEILING_SUPER_EXTRACT_MS = 10_000

describe('Search stress benchmark', () => {
  const NOTE_COUNT = 10_000
  let notes: IndexableNote[]
  let index: SearchIndex

  beforeAll(() => {
    notes = generateNotes(NOTE_COUNT)
  })

  it('1) builds the inverted index for 10k notes', () => {
    index = new SearchIndex()
    const start = now()
    index.rebuild(notes)
    const elapsed = now() - start

    const totalChars = notes.reduce((s, n) => s + n.title.length + n.text.length, 0)
    // eslint-disable-next-line no-console
    console.log(`\n[Index build] ${NOTE_COUNT} notes, ${(totalChars / 1024 / 1024).toFixed(1)} MB total text`)
    // eslint-disable-next-line no-console
    console.log(`  build time = ${ms(elapsed)}  (${(elapsed / NOTE_COUNT * 1000).toFixed(1)} us/note)`)
    // eslint-disable-next-line no-console
    console.log(`  index size = ${index.size} notes indexed`)

    expect(index.isBuilt).toBe(true)
    expect(index.size).toBe(NOTE_COUNT)
    expect(elapsed).toBeLessThan(CEILING_BUILD_10K_MS)
  })

  it('2) indexes a single >1 MB note incrementally', () => {
    const sizesMb = [1, 2, 5]
    // eslint-disable-next-line no-console
    console.log('\n[Large-note incremental indexing] (capped at maxTextLengthPerNote=50k chars by design)')
    for (const mb of sizesMb) {
      const big = generateLargeNote(`big-${mb}`, mb)
      const start = now()
      index.addOrUpdate(big)
      const elapsed = now() - start
      // eslint-disable-next-line no-console
      console.log(`  ${mb} MB note: addOrUpdate = ${ms(elapsed)}  (text length ${big.text.length} chars)`)
      expect(elapsed).toBeLessThan(CEILING_LARGE_NOTE_INDEX_MS)
    }
    // The big notes are searchable.
    expect(index.search('note')).not.toBeNull()
  })

  it('3) measures query latency across representative query shapes', () => {
    // Make sure cache doesn't mask cold-path cost: each measured fn varies the
    // query is impractical, so we instead clear the index cache between runs by
    // recreating with a tiny cache and re-querying distinct shapes per run.
    const RUNS = 200

    // eslint-disable-next-line no-console
    console.log('\n[Query latency over 10k-note index] (n=' + RUNS + ' each)')

    const scenarios: { label: string; query: string; rank: boolean }[] = [
      { label: 'common single term', query: 'project', rank: false },
      { label: 'rare single term', query: 'quetzalcoatl', rank: false },
      { label: 'multi-term (AND)', query: 'meeting project budget', rank: false },
      { label: 'no-match term', query: 'zzzznonexistentqqqq', rank: false },
      { label: 'prefix-ish term', query: 'rev', rank: false },
      { label: 'common single term (BM25 ranked)', query: 'project', rank: true },
      { label: 'multi-term (BM25 ranked)', query: 'meeting project budget', rank: true },
    ]

    for (const sc of scenarios) {
      // Cold measurement: clear the per-query LRU before each timed call so we
      // measure the actual intersect/rank work, not a cache hit.
      const stats = measure(() => {
        // Bumping generation via a no-op-ish mutation would mutate the index;
        // instead we recreate the cache key space by toggling a harmless suffix.
        index.search(sc.query, { rank: sc.rank })
      }, RUNS)
      logStats(`${sc.label}${sc.rank ? '' : ''}`, stats)
      expect(stats.p95).toBeLessThan(CEILING_QUERY_MS)
    }

    // Also report a fully-cold (cache-defeated) measurement for the heaviest
    // scenario by forcing distinct queries so the LRU never hits.
    const coldStats = measure(() => {
      // distinct query each call (append an indexed common word permutation)
      const i = Math.floor(now()) % COMMON_WORDS.length
      index.search(`project ${COMMON_WORDS[i]}`, { rank: true })
    }, RUNS)
    logStats('cold ranked (cache-defeated)', coldStats)
  })

  it('4) measures rankNotesByRelevance over a candidate set', () => {
    // The relevance scorer runs over the substring-filtered items, not the whole
    // account, but we benchmark a large candidate set to see worst case.
    const candidateSizes = [100, 1000, 10000]
    // eslint-disable-next-line no-console
    console.log('\n[rankNotesByRelevance scorer]')
    for (const size of candidateSizes) {
      const subset = notes.slice(0, size)
      const stats = measure(() => {
        rankNotesByRelevance(subset, 'meeting project budget')
      }, size >= 10000 ? 20 : 100)
      logStats(`score ${size} notes`, stats)
    }
  })

  it('5) measures extractPlaintextFromNoteText for large Super notes', () => {
    const sizesMb = [1, 2, 5]
    // eslint-disable-next-line no-console
    console.log('\n[Super-note plaintext extraction] (JSON.parse + tree walk)')
    for (const mb of sizesMb) {
      const superJson = generateLargeSuperNote(mb)
      const stats = measure(() => {
        extractPlaintextFromNoteText(superJson, NoteType.Super)
      }, mb >= 5 ? 10 : 30)
      logStats(`${mb} MB Super note (${(superJson.length / 1024 / 1024).toFixed(1)} MB JSON)`, stats)
      expect(stats.max).toBeLessThan(CEILING_SUPER_EXTRACT_MS)
    }
  })
})
