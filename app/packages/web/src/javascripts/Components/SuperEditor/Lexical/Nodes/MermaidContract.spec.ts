/**
 * @jest-environment node
 *
 * The real mermaid, inside the gate that already runs.
 *
 * Every other mermaid spec here fakes the library: jest does not transform ESM
 * in node_modules, so the installed package cannot be imported into a spec. A
 * fake pins the order the app calls mermaid in. It cannot say what mermaid does
 * with those calls — and three defects lived exactly there: a bad colour in one
 * diagram that made every later `initialize` throw, the application's palette
 * forced into a diagram that names its own theme, and a builder that changed
 * what a diagram means to mermaid's own parser.
 *
 * `scripts/MermaidContract.mjs` asks the installed library directly, under Node
 * with jsdom's globals, driving the app's own MermaidRuntime, MermaidSettings
 * and MermaidGraphBuilder sources. This spec starts it as a child process, so it
 * runs wherever `yarn test` runs, and reads three things: that it EXITED 0, that
 * its summary says so too, and that the checks this file names all ran — a
 * check deleted from the script must not be able to pass by being absent.
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')
const SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'MermaidContract.mjs')

type Check = { name: string; ok: boolean; detail: string }
type Summary = { ok: boolean; mermaid: string; node: string; checks: Check[]; counts: Record<string, number> }

/** Every check the script is expected to run, by the name it reports. */
const EXPECTED_CHECKS = [
  'the defect is real in this mermaid: a bad colour makes the NEXT initialize throw',
  'through the runtime, a healthy diagram renders after a poisoned one',
  'several renders started together each get their own block theme',
  'the theme list matches the library, name for name',
  'each theme’s surface and polarity are the ones mermaid computes',
  'the defect is real in this mermaid: the app palette is forced into a named theme',
  'through the runtime, every theme mermaid ships is drawn clean, base included',
  'the defect is real in this mermaid: under `theme: base` the app’s text lands on the diagram’s own fill',
  'through the runtime, `theme: base` with its own fill gets mermaid’s text colour, not the app’s',
  'a name mermaid does not know, and variables with no theme key, leave the app palette in place',
  'a page the text sets is kept as written by every theme, and comes back as a colour or not at all',
  'a block pinned to a theme reports the theme its text draws instead',
  'no text mermaid finds config in is turned away by the pre-check',
  'a theme named with an escaped key is honoured, which is why the pre-check is not a word search',
  'a key is refused exactly when it is in MERMAID_APP_SECURE_KEYS',
  'every key in the list is one mermaid has, and none gets through by any spelling',
  'what a text cannot set whatever the list says: the sanitiser’s config, and keys mermaid has no default for',
  'mermaid unions the app’s list with its own, so adding a key locks it',
  'a no-op round trip through the builder preserves mermaid’s reading of every source it accepts',
  'the four silent corruptions: refused, or read as mermaid reads them',
  'removing a link leaves every surviving link with the style it had',
  'the defect is real in this mermaid: a linkStyle past the end stops the diagram',
  'every template is a diagram mermaid accepts',
]

let status: number | null = null
let stderr = ''
let summary: Summary | undefined

beforeAll(() => {
  // `process.execPath` is the Node running jest, so the script is judged by the
  // same Node the suite is — 26 on CI, whatever is installed locally.
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 120_000 })
  status = run.status
  stderr = `${run.error ? String(run.error) + '\n' : ''}${run.stderr ?? ''}`
  const lastLine = (run.stdout ?? '').trim().split('\n').pop() ?? ''
  try {
    summary = JSON.parse(lastLine) as Summary
  } catch {
    summary = undefined
  }
}, 150_000)

/** The script's own per-check report, for a failure message that says which check and why. */
const report = (): string =>
  summary
    ? summary.checks
        .map((check) => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ' — ' + check.detail : ''}`)
        .join('\n')
    : `no summary on stdout.\n${stderr}`

describe('the installed mermaid, asked directly', () => {
  it('ran, and every check it made passed', () => {
    if (status !== 0 || !summary?.ok) {
      throw new Error(`scripts/MermaidContract.mjs exited ${status}\n${report()}`)
    }
    expect(summary.checks.filter((check) => !check.ok)).toEqual([])
  })

  it('made every check this gate relies on — none can pass by being absent', () => {
    const ran = (summary?.checks ?? []).map((check) => check.name)
    expect(ran).toEqual(EXPECTED_CHECKS)
  })

  it('exercised what it claims to, in numbers', () => {
    const counts = summary?.counts ?? {}
    // All eleven themes, each named two ways; a round-trip corpus the builder
    // mostly accepts; every removal over the styled diagrams. A count that
    // drops to zero is a check that still says "ok" over nothing.
    expect(counts.themes).toBe(11)
    expect(counts.ownThemeRenders).toBe(22)
    expect(counts.ownPages).toBe(11)
    expect(counts.preCheckTexts).toBeGreaterThanOrEqual(15)
    expect(counts.secureProbes).toBeGreaterThanOrEqual(12)
    expect(counts.lockedKeys).toBeGreaterThanOrEqual(6)
    expect(counts.roundTripModelled).toBeGreaterThanOrEqual(25)
    expect(counts.roundTripRefused).toBeGreaterThanOrEqual(15)
    expect(counts.styledRemovals).toBeGreaterThanOrEqual(19)
  })

  it('says which mermaid and which Node it judged', () => {
    expect(summary?.mermaid).toMatch(/^\d+\.\d+\.\d+/)
    expect(summary?.node).toBe(process.version)
  })
})
