/**
 * @jest-environment node
 *
 * The builder's operations against the real mermaid, inside the gate that
 * already runs.
 *
 * `MermaidFlowEdits.spec.ts` pins the exact text each operation writes, with
 * the builder's own reading standing in for mermaid's. That stand-in is the one
 * thing it cannot vouch for. `scripts/MermaidFlowEditsContract.mjs` tries every
 * kind of operation on every text of the corpus under plain Node, with the
 * INSTALLED library saying what each result means. This spec starts it as a
 * child process and reads three things: that it EXITED 0, that its summary
 * agrees, and that every check this file names ran — a check deleted from the
 * script must not pass by being absent — over a number of operations that has
 * not quietly gone to zero.
 *
 * The number that matters most is `operationsAltered`: operations whose result
 * mermaid rejected or read as something other than what was asked. It is zero,
 * and the script fails on anything else.
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')
const SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'MermaidFlowEditsContract.mjs')

type Check = { name: string; ok: boolean; detail: string }
type Summary = { ok: boolean; mermaid: string; node: string; checks: Check[]; counts: Record<string, number> }

/** Every check the script is expected to run, by the name it reports. */
const EXPECTED_CHECKS = [
  'every operation on every corpus text is judged by mermaid: accepted, or refused by name — never altered',
  'after an accepted operation mermaid reads what was asked and nothing else — said a second time, by other code',
  'an accepted operation changes only the lines it owns',
  'of the 37 common forms: every one edited, some with operations refused by name, none altered',
  'corruption 1 cannot happen: a slanted box or a trapezoid stays what it is through every operation',
  'corruption 2 cannot happen: a double circle stays a double circle labelled as it was',
  'corruption 3 cannot happen: a label given twice keeps the later one, and a relabel changes the one that counts',
  'corruption 4 cannot happen: renaming a box never passes through, or lands on, another box’s name',
  'a link that goes takes its number with it: every surviving link keeps the style it had, for every operation that removes links',
  'the defect is real in this mermaid: a linkStyle past the last link stops the diagram',
  'a text with configuration the app does not honour comes through every operation with those lines untouched',
  'every shape the builder can give a box is one mermaid draws, in the classic and the hand-drawn look',
  'the defect is real in this mermaid: it reads an ellipse and cannot draw it',
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
    timeout: 420_000,
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
}, 480_000)

/** The script's own per-check report, for a failure message that says which check and why. */
const report = (): string =>
  summary
    ? summary.checks
        .map((check) => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ' — ' + check.detail : ''}`)
        .join('\n')
    : `no summary on stdout.\n${stderr}`

describe('the builder’s operations, judged by the installed mermaid', () => {
  it('ran, and every check it made passed', () => {
    if (status !== 0 || !summary?.ok) {
      throw new Error(`scripts/MermaidFlowEditsContract.mjs exited ${status}\n${report()}`)
    }
    expect(summary.checks.filter((check) => !check.ok)).toEqual([])
  })

  it('made every check this gate relies on — none can pass by being absent', () => {
    const ran = (summary?.checks ?? []).map((check) => check.name)
    expect(ran).toEqual(EXPECTED_CHECKS)
  })

  it('altered nothing: no result that mermaid rejected or read as something other than what was asked', () => {
    expect(summary?.counts.operationsAltered).toBe(0)
    expect(summary?.counts.commonFormsAltered).toBe(0)
  })

  it('exercised what it claims to, in numbers', () => {
    const counts = summary?.counts ?? {}
    // All fifteen kinds of operation accepted somewhere, well over a thousand
    // accepted in all, and some refused — a run in which nothing is refused
    // has stopped trying the things the builder is supposed to refuse.
    expect(counts.operationKinds).toBe(15)
    expect(counts.operationsAccepted).toBeGreaterThanOrEqual(1500)
    expect(counts.operationsRefused).toBeGreaterThanOrEqual(10)
    expect(counts.operations).toBe(counts.operationsAccepted + counts.operationsRefused)
    // Every one of the 37 common forms edited; the ones with a refusal are the
    // forms that set a box's shape or text in `@{ … }`, or count their groups.
    expect(counts.commonFormsEdited).toBe(37)
    expect(counts.commonFormsWithARefusal).toBeLessThanOrEqual(4)
    expect(counts.styledRemovals).toBeGreaterThanOrEqual(25)
    expect(counts.lockedConfigOperations).toBeGreaterThanOrEqual(40)
    // Drawn, not only read: all fourteen shapes, each set on a box and given
    // to a new one, in both looks; and the one shape mermaid reads and cannot
    // draw, which the builder therefore never writes.
    expect(counts.shapesDrawn).toBe(14)
    expect(counts.shapeDrawings).toBe(14 * 2 * 2)
    expect(counts.shapesReadAndNotDrawn).toBe(1)
  })

  it('says which mermaid and which Node it judged', () => {
    expect(summary?.mermaid).toMatch(/^\d+\.\d+\.\d+/)
    expect(summary?.node).toBe(process.version)
  })
})
