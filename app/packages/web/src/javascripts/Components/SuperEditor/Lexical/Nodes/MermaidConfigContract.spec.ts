/**
 * @jest-environment node
 *
 * The real mermaid, asked what a diagram's own configuration means — inside the
 * gate that already runs.
 *
 * MermaidSourceConfig.ts makes two kinds of claim about the library: "this text
 * sets the theme to forest" (the toolbar shows it), and "after this patch
 * mermaid will read the value that was chosen" (every Customise control).
 * MermaidConfigCatalog.ts adds a third: "this is a key, a default and a choice
 * mermaid has", for every option the panel offers. A
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
import { spawn } from 'node:child_process'
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
  'every catalogue key and sample value is written, and read back by mermaid as written',
  'every default the catalogue quotes is the one mermaid ships',
  'the line styles, looks and themes offered are the library’s own',
  'every sample diagram is one mermaid accepts, of the kind the app takes it for',
  'every control and every preset, on every kind, leaves a diagram mermaid reads as chosen',
  'still true of this mermaid: the class renderer takes its spacing from the state group',
  'still true of this mermaid: the sequence renderer ignores messageMargin and its own three font sizes',
  'a string is written so that mermaid reads the identical string back, however awkward',
  'still true of this mermaid: a bare true, number or null is NOT a string to it',
  'the characters mermaid keeps in a theme variable are exactly the ones this app says it keeps',
  'still true of this mermaid: an angle bracket or a data URL in ANY option’s value deletes the option',
]

let status: number | null = null
let stderr = ''
let summary: Summary | undefined

beforeAll(async () => {
  // `process.execPath` is the Node running jest, so the script is judged by the
  // same Node the suite is — 26 on CI, whatever is installed locally.
  //
  // Started WITHOUT blocking, unlike its sibling: this script takes about three
  // times as long (it has mermaid parse some eight hundred texts), and a jest
  // worker that sits inside `spawnSync` for that long cannot answer its parent,
  // which then force-exits it and warns about leaking tests.
  let stdout = ''
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: PACKAGE_ROOT })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => {
      stderr = `${String(error)}\n${stderr}`
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      status = code
      resolve()
    })
  })
  const lastLine = stdout.trim().split('\n').pop() ?? ''
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
    // The catalogue: every key the panel writes, each sample of each read back
    // three times over, every default compared, every kind of diagram, and
    // every control and preset applied to each kind that takes it.
    expect(counts.catalogueKeys).toBeGreaterThanOrEqual(23)
    expect(counts.catalogueReadBack).toBeGreaterThanOrEqual(204)
    expect(counts.catalogueDefaults).toBeGreaterThanOrEqual(22)
    expect(counts.lineStyles).toBe(13)
    expect(counts.sampleKinds).toBe(18)
    expect(counts.controlsApplied).toBeGreaterThanOrEqual(176)
    expect(counts.controlsUnavailable).toBeGreaterThan(0)
    // Every awkward spelling of a string, for every string-typed key: read back
    // identical, or refused because mermaid would discard it — and SOME written
    // bare, or the check would only show that quoting works.
    expect(counts.awkwardStrings).toBeGreaterThanOrEqual(71)
    expect(counts.awkwardReadBack).toBeGreaterThanOrEqual(394)
    expect(counts.awkwardRefused).toBeGreaterThan(0)
    expect(counts.writtenBare).toBeGreaterThanOrEqual(12)
    // The theme-variable filter, one character at a time: some kept, some not.
    expect(counts.themeCharactersProbed).toBeGreaterThanOrEqual(101)
    expect(counts.themeCharactersKept).toBeGreaterThan(60)
    expect(counts.themeCharactersKept).toBeLessThan(counts.themeCharactersProbed)
  })

  it('says which mermaid and which Node it judged', () => {
    expect(summary?.mermaid).toMatch(/^\d+\.\d+\.\d+/)
    expect(summary?.node).toBe(process.version)
  })
})
