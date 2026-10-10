// Guard against a specific, already-shipped regression: Tailwind CSS v4
// repurposed the v3 "reference a CSS custom property as an arbitrary value"
// bracket shorthand (`bg-[--my-var]`) for LITERAL arbitrary values instead.
// The old bracket form still compiles under v4 — it just silently emits the
// bare custom-property name with no `var(...)` wrapper (e.g.
// `background-color: --my-var;`), which every browser drops as invalid.
// Tailwind v4's replacement syntax uses parentheses instead: `bg-(--my-var)`.
//
// This exact bug shipped to production across 19 components (36 call sites)
// before anyone noticed — Tailwind doesn't warn on the malformed arbitrary
// value, and nothing else in this repo's toolchain looks inside className
// strings. See .orchestration/logs/t99/t99-e4.md for the incident writeup.
//
// This script fails the build if the v3 bracket form reappears anywhere in
// our own TS/TSX source. It intentionally does NOT touch
// `src/components/assets/**` (pre-built third-party component bundles) —
// those are vendor code we don't control and don't want this gate reporting
// on.
//
// A LATER INCIDENT, and why the second check below exists: this gate reads only
// `src/**/*.ts(x)`, so it never read THIS FILE — and Tailwind v4's automatic
// source detection did. The examples in the comment above were harvested as
// candidates and compiled into two live rules in `app.css` whose declarations
// every browser drops, which is exactly the bug this file documents. The
// `content` array in `tailwind.config.js` now excludes `scripts/**` (and the
// `*.spec.tsx` fixtures, whose row ids compiled to an invalid `grid-row`), so
// the comment above is inert again. The second check asserts those exclusions
// are still there, because nothing else in the toolchain notices when a
// compiled rule is dropped by the parser.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const excludedDirectories = new Set(['assets'])

// Matches a Tailwind arbitrary-value bracket group whose content is an
// (optional) CSS type hint followed by a bare `--custom-property` reference,
// e.g. `[--popover-border-color]` or `[length:--font-size]`. Deliberately
// requires the bracket to close immediately after the property name, so it
// does not match legitimate arbitrary-property syntax like
// `[--my-color:red]` (a definition) or `[backdrop-filter:var(--x)]` (a
// correctly var()-wrapped reference).
const bracketCssVarPattern = /\[[a-z-]*:?(--[a-zA-Z][a-zA-Z0-9-]*)\]/g

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return excludedDirectories.has(entry.name) ? [] : sourceFiles(entryPath)
      }
      return /\.tsx?$/.test(entry.name) ? [entryPath] : []
    }),
  )
  return nested.flat()
}

function findViolations(filePath, contents) {
  const violations = []
  const lines = contents.split('\n')
  lines.forEach((line, index) => {
    for (const match of line.matchAll(bracketCssVarPattern)) {
      violations.push({ filePath, line: index + 1, column: match.index + 1, snippet: match[0], variable: match[1] })
    }
  })
  return violations
}

const files = await sourceFiles(sourceRoot)
const allViolations = (
  await Promise.all(
    files.map(async (filePath) => {
      const contents = await readFile(filePath, 'utf8')
      return findViolations(filePath, contents)
    }),
  )
).flat()

if (allViolations.length > 0) {
  console.error('Found Tailwind v4 bracket CSS-variable arbitrary values (silently drop the declaration):\n')
  for (const violation of allViolations) {
    const relativePath = path.relative(fileURLToPath(new URL('../../../..', import.meta.url)), violation.filePath)
    console.error(
      `  ${relativePath}:${violation.line}:${violation.column} — \`${violation.snippet}\` should be \`(${violation.variable})\``,
    )
  }
  console.error(
    `\n${allViolations.length} occurrence(s). Tailwind v4 uses parentheses, not brackets, to reference a CSS ` +
      'custom property as an arbitrary value: rewrite `<utility>-[--my-var]` to `<utility>-(--my-var)` (and ' +
      '`<utility>-[type:--my-var]` to `<utility>-(type:--my-var)`). See .orchestration/logs/t99/t99-e4.md.',
  )
  process.exit(1)
}

// --- second check: Tailwind must not scan non-markup files -------------------
// Tailwind v4 compiles a rule for ANY utility-shaped text it finds, so build
// scripts and test fixtures must stay out of its source set. Negated `content`
// entries are the exclusion that takes effect; `@source not` in the CSS entry
// was measured to apply only to whole-directory patterns, not file patterns.
//
// The config is EVALUATED, not string-matched: the checks below read the real
// `content` array that the real file produces, so deleting or commenting out a
// negated entry reddens them, and a `!./scripts/**/*` written inside a comment
// does not satisfy them.
//
// It cannot be `require`d, though. This gate is deliberately the first thing CI
// runs, BEFORE any install step, so that a failing install cannot skip it — and
// `tailwind.config.js` opens with `require('tailwindcss/plugin')`, which is not
// resolvable when nothing is installed. `require`-ing it made this step die with
// MODULE_NOT_FOUND on a clean checkout, which marked it failed and skipped every
// step after it: install, build, typecheck, lint, format:check and the whole test
// suite never ran on CI for the 11 consecutive runs on main from 2026-10-04 to
// 2026-10-09 — every run since the config-loading check was added. The last run
// in which `yarn check` actually executed was 37232316801.
//
// So the config is evaluated as the CommonJS module it is, with `require`
// replaced by a stub that absorbs any call, construction or property access.
// Only `content` is read, `plugins` is never invoked by anything here, and
// nothing outside node: builtins is loaded — which is what keeps this step
// honestly independent of `yarn install`.
const configPath = fileURLToPath(new URL('../tailwind.config.js', import.meta.url))
const configSource = await readFile(configPath, 'utf8')

// Only the `apply` trap is exercised by the config as it stands today, and
// mutation-testing confirms it: deleting `construct`, `get`, or the `exports`
// initialiser below leaves this script still exiting 0, because nothing in
// `tailwind.config.js` currently constructs a required value, reads a property
// off one, or assigns to `exports` rather than `module.exports`. They are kept
// anyway, and that is a deliberate choice rather than an oversight: the failure
// this script exists to not repeat is dying before `yarn install`, and the next
// `require` added to that config is not something this file gets to predict.
// Robustness here is the requirement, so these branches are unreachable on
// purpose.
const absorbAnything = new Proxy(function absorb() {}, {
  apply: () => absorbAnything,
  construct: () => absorbAnything,
  get: () => absorbAnything,
})

const configModule = { exports: {} }
new Function('module', 'exports', 'require', '__filename', '__dirname', configSource)(
  configModule,
  configModule.exports,
  () => absorbAnything,
  configPath,
  path.dirname(configPath),
)

const tailwindContent = configModule.exports.content
const negations = (Array.isArray(tailwindContent) ? tailwindContent : []).filter(
  (entry) => typeof entry === 'string' && entry.startsWith('!'),
)
const missingExclusions = [
  negations.some((entry) => /(^|\/)scripts\//.test(entry.slice(1))) ? null : 'the scripts/ directory (build tooling)',
  negations.some((entry) => /\.spec\.[jt]sx?$/.test(entry)) ? null : 'the *.spec.tsx test fixtures',
].filter(Boolean)

if (missingExclusions.length > 0) {
  console.error(
    'tailwind.config.js `content` no longer excludes ' +
      missingExclusions.join(' and ') +
      '.\nTailwind v4 scans every non-gitignored file in this package and compiles any utility-shaped\n' +
      'text into a real CSS rule, so without those negated entries app.css ships rules whose\n' +
      'declarations the browser drops (3 of them did). Restore the `!`-prefixed entries.',
  )
  process.exit(1)
}

console.log(
  'No Tailwind v4 bracket CSS-variable arbitrary values found; tailwind.config.js still excludes scripts/ and *.spec.tsx.',
)
