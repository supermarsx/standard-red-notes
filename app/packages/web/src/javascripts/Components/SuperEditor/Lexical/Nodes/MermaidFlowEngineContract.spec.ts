/**
 * @jest-environment node
 *
 * The visual builder's engine against the real mermaid, inside the gate that
 * already runs.
 *
 * The engine finds the characters to edit with mermaid's own flowchart grammar,
 * copied into MermaidFlowGrammar.ts as data. No spec here can load mermaid (jest
 * does not transform ESM in node_modules), so none of them can say whether that
 * copy is still the installed library's, or whether the engine reads a diagram
 * the way the library does. `scripts/MermaidFlowEngineContract.mjs` can: it
 * runs under plain Node, loads the installed package, and drives the app's own
 * sources against it. This spec starts it as a child process and reads three
 * things: that it EXITED 0, that its summary agrees, and that every check this
 * file names ran — a check deleted from the script must not pass by being
 * absent — over a number of texts that has not quietly gone to zero.
 *
 * THE DRIFT GUARD. MermaidFlowGrammar.ts is generated from one mermaid version
 * and committed; the script's first check regenerates it from the INSTALLED
 * mermaid and compares. If this spec fails after a mermaid upgrade with "was
 * generated from mermaid …": that is the guard working. Run
 * `node scripts/GenerateMermaidFlowGrammar.mjs --write` in app/packages/web,
 * commit the file, and the remaining checks then say whether the builder still
 * reads diagrams the way the new version does.
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')
const SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'MermaidFlowEngineContract.mjs')

type Check = { name: string; ok: boolean; detail: string }
type Summary = { ok: boolean; mermaid: string; node: string; checks: Check[]; counts: Record<string, number> }

/** Every check the script is expected to run, by the name it reports. */
const EXPECTED_CHECKS = [
  'the grammar the builder runs is the installed mermaid’s, rule for rule and state for state',
  'every production of that grammar has a meaning in the document',
  'the builder hands its lexer exactly the text mermaid hands its own parser',
  'the builder’s tokens are mermaid’s tokens, name for name and character for character',
  'printing every text gives it back, byte for byte',
  'mermaid’s flowchart database is the shape the builder’s one adapter reads',
  'every corpus text reads the same to the builder and to mermaid',
  'one character short of a corpus text, the builder never reads something mermaid does not',
  'a text the builder reads and mermaid rejects is not editable',
]

let status: number | null = null
let stderr = ''
let summary: Summary | undefined

beforeAll(() => {
  // `process.execPath` is the Node running jest, so the script is judged by the
  // same Node the suite is — 26 on CI, whatever is installed locally.
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  status = run.status
  stderr = `${run.error ? String(run.error) + '\n' : ''}${run.stderr ?? ''}`
  const lastLine = (run.stdout ?? '').trim().split('\n').pop() ?? ''
  try {
    summary = JSON.parse(lastLine) as Summary
  } catch {
    summary = undefined
  }
}, 300_000)

/** The script's own per-check report, for a failure message that says which check and why. */
const report = (): string =>
  summary
    ? summary.checks
        .map((check) => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ' — ' + check.detail : ''}`)
        .join('\n')
    : `no summary on stdout.\n${stderr}`

describe('the builder’s engine, checked against the installed mermaid', () => {
  it('ran, and every check it made passed', () => {
    if (status !== 0 || !summary?.ok) {
      throw new Error(`scripts/MermaidFlowEngineContract.mjs exited ${status}\n${report()}`)
    }
    expect(summary.checks.filter((check) => !check.ok)).toEqual([])
  })

  it('made every check this gate relies on — none can pass by being absent', () => {
    const ran = (summary?.checks ?? []).map((check) => check.name)
    expect(ran).toEqual(EXPECTED_CHECKS)
  })

  it('exercised what it claims to, in numbers', () => {
    const counts = summary?.counts ?? {}
    // The whole corpus with its 37 common forms; a couple of thousand texts
    // one character short of a corpus entry, of which mermaid still parses a
    // good half; and the grammar's own size, so that an empty table cannot
    // compare equal to an empty table.
    expect(counts.commonForms).toBe(37)
    expect(counts.corpus).toBeGreaterThanOrEqual(70)
    expect(counts.texts).toBeGreaterThanOrEqual(2000)
    expect(counts.preprocessed).toBeGreaterThanOrEqual(1000)
    expect(counts.lexed).toBeGreaterThanOrEqual(1500)
    expect(counts.tokens).toBeGreaterThanOrEqual(100_000)
    expect(counts.lexRules).toBeGreaterThanOrEqual(100)
    expect(counts.parserStates).toBeGreaterThanOrEqual(200)
    // Every corpus text read by both and read the same — all 37 common forms
    // among them — and, of the damaged texts, a thousand still read by both
    // and hundreds refused by both. The few mermaid alone refuses are YAML the
    // document does not parse; the script fails on any other.
    expect(counts.corpusRead).toBe(counts.corpus)
    expect(counts.commonFormsRead).toBe(37)
    expect(counts.deletionsSameReading).toBeGreaterThanOrEqual(1000)
    expect(counts.deletionsBothRefuse).toBeGreaterThanOrEqual(500)
    expect(counts.deletionsMermaidRefusesYaml).toBeLessThanOrEqual(40)
    // Every one of those, and three written for the purpose, offered to the
    // builder: refused before any operation ran.
    expect(counts.rejectedNotEditable).toBeGreaterThanOrEqual(3 + counts.deletionsMermaidRefusesYaml)
  })

  it('says which mermaid and which Node it judged', () => {
    expect(summary?.mermaid).toMatch(/^\d+\.\d+\.\d+/)
    expect(summary?.node).toBe(process.version)
  })
})
