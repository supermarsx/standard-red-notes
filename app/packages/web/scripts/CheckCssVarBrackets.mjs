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
      "custom property as an arbitrary value: rewrite `<utility>-[--my-var]` to `<utility>-(--my-var)` (and " +
      '`<utility>-[type:--my-var]` to `<utility>-(type:--my-var)`). See .orchestration/logs/t99/t99-e4.md.',
  )
  process.exit(1)
}

console.log('No Tailwind v4 bracket CSS-variable arbitrary values found.')
