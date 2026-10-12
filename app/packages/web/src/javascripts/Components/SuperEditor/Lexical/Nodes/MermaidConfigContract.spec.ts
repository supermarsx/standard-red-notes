/**
 * @jest-environment node
 *
 * The real mermaid, asked what a diagram's own configuration means — inside the
 * gate that already runs.
 *
 * MermaidSourceConfig.ts makes two kinds of claim about the library: "this text
 * sets the theme to forest" (the toolbar shows it), and "after this patch
 * mermaid will read the value that was chosen" (every Customise control). A
 * jest spec cannot check either, because jest here does not transform ESM in
 * node_modules and every mermaid spec therefore fakes the library.
 *
 * `scripts/MermaidConfigContract.mjs` asks the installed library directly,
 * under Node with jsdom's globals, driving the app's own sources. This spec
 * starts it as a child process, exactly as MermaidContract.spec.ts starts its
 * sibling, and reads three things: that it EXITED 0, that its summary says so
 * too, and that the checks this file names all ran — a check deleted from the
 * script must not be able to pass by being absent.
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')
const SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'MermaidConfigContract.mjs')

type Check = { name: string; ok: boolean; detail: string }
type Summary = { ok: boolean; mermaid: string; node: string; checks: Check[]; counts: Record<string, number> }

/** Every check the script is expected to run, by the name it reports. */
const EXPECTED_CHECKS = [
  'the small reader and mermaid read every text the same way',
  'a text the reader is sure of sets what the reader says, key for key',
  'an option written into any frontmatter is the option mermaid reads, and no other moves',
  'the reason a change is refused under a directive is real: mermaid would have ignored it',
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

describe('the installed mermaid, asked what a diagram’s own configuration means', () => {
  it('ran, and every check it made passed', () => {
    if (status !== 0 || !summary?.ok) {
      throw new Error(`scripts/MermaidConfigContract.mjs exited ${status}\n${report()}`)
    }
    expect(summary.checks.filter((check) => !check.ok)).toEqual([])
  })

  it('made every check this gate relies on — none can pass by being absent', () => {
    const ran = (summary?.checks ?? []).map((check) => check.name)
    expect(ran).toEqual(EXPECTED_CHECKS)
  })

  it('exercised what it claims to, in numbers', () => {
    const counts = summary?.counts ?? {}
    // A corpus that shrinks to nothing still says "ok". These are floors: the
    // texts the reader must answer for, the ones it must refuse to, the single
    // claims compared with the library, and the patches read back by it.
    expect(counts.readingTexts).toBeGreaterThanOrEqual(79)
    expect(counts.readingSure).toBeGreaterThanOrEqual(41)
    expect(counts.readingUnsure).toBeGreaterThanOrEqual(33)
    expect(counts.readingClaims).toBeGreaterThanOrEqual(440)
    expect(counts.listedTexts).toBeGreaterThanOrEqual(25)
    expect(counts.patchesReadBack).toBeGreaterThanOrEqual(195)
  })

  it('says which mermaid and which Node it judged', () => {
    expect(summary?.mermaid).toMatch(/^\d+\.\d+\.\d+/)
    expect(summary?.node).toBe(process.version)
  })
})
