import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertValidDocs,
  escapeMarkdownTableCell,
  findMatchingBracket,
  loadDocCategories,
  pageAnchor,
  renderBlock,
  renderMarkdown,
} from './export-app-docs-to-pages.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function category(overrides = {}) {
  return {
    id: 'basics',
    title: 'Basics',
    description: 'How to start.',
    pages: [page()],
    ...overrides,
  }
}

function page(overrides = {}) {
  return {
    id: 'first-note',
    title: 'First note',
    summary: 'Write your first note.',
    blocks: [{ type: 'paragraph', text: 'Press new.' }],
    ...overrides,
  }
}

test('findMatchingBracket returns the index of the balanced closing bracket', () => {
  const source = '[1, [2, 3], 4] trailing'
  assert.equal(findMatchingBracket(source, 0), 13)
  assert.equal(source[13], ']')
})

test('findMatchingBracket ignores brackets inside strings and template literals', () => {
  for (const quote of ["'", '"', '`']) {
    const source = `[${quote}]]]${quote}, 1]`
    const end = findMatchingBracket(source, 0)
    assert.equal(source[end], ']')
    assert.equal(end, source.length - 1, `unbalanced for quote ${quote}`)
  }
})

test('findMatchingBracket honours backslash escapes inside strings', () => {
  // The \' does not close the string, so the ] inside it must not count.
  const source = "['a\\']', 1]"
  assert.equal(findMatchingBracket(source, 0), source.length - 1)
})

test('findMatchingBracket ignores brackets inside line and block comments', () => {
  const lineCommented = '[1, // ]]]\n2]'
  assert.equal(findMatchingBracket(lineCommented, 0), lineCommented.length - 1)

  const blockCommented = '[1, /* ]]] */ 2]'
  assert.equal(findMatchingBracket(blockCommented, 0), blockCommented.length - 1)
})

test('findMatchingBracket throws when the array is never closed', () => {
  assert.throws(() => findMatchingBracket('[1, 2', 0), /Could not find the end of DOC_CATEGORIES/)
})

test('pageAnchor lowercases, collapses non-alphanumerics and trims separators', () => {
  assert.equal(pageAnchor('Getting Started'), 'getting-started')
  assert.equal(pageAnchor('Notes & Tags!!'), 'notes-tags')
  assert.equal(pageAnchor('__edge__'), 'edge')
  assert.equal(pageAnchor('already-fine'), 'already-fine')
})

test('escapeMarkdownTableCell escapes backslashes before pipes and folds newlines', () => {
  assert.equal(escapeMarkdownTableCell('a\\b'), 'a\\\\b')
  assert.equal(escapeMarkdownTableCell('a|b'), 'a\\|b')
  assert.equal(escapeMarkdownTableCell('line1\nline2'), 'line1<br>line2')
  // Backslash-escaping must run first, otherwise the pipe escape gets neutered.
  assert.equal(escapeMarkdownTableCell('a\\|b'), 'a\\\\\\|b')
  assert.equal(escapeMarkdownTableCell(42), '42')
})

test('renderBlock renders every supported block type', () => {
  assert.equal(renderBlock({ type: 'heading', text: 'Sync' }), '#### Sync\n')
  assert.equal(renderBlock({ type: 'paragraph', text: 'Body.' }), 'Body.\n')
  assert.equal(renderBlock({ type: 'list', items: ['a', 'b'] }), '- a\n- b\n')
  assert.equal(renderBlock({ type: 'steps', items: ['a', 'b'] }), '1. a\n2. b\n')
  assert.equal(renderBlock({ type: 'code', code: 'yarn test' }), '```\nyarn test\n```\n')
  assert.equal(renderBlock({ type: 'callout', variant: 'warning', text: 'Careful.' }), '> **Warning.** Careful.\n')
  assert.equal(renderBlock({ type: 'callout', variant: 'info', text: 'Note.' }), '> **Info.** Note.\n')
  assert.equal(renderBlock({ type: 'callout', variant: 'tip', text: 'Try.' }), '> **Tip.** Try.\n')
})

test('renderBlock uses a longer fence when code contains a fenced example', () => {
  assert.equal(
    renderBlock({ type: 'code', code: '```mermaid\nflowchart LR\n  A --> B\n```' }),
    '````\n```mermaid\nflowchart LR\n  A --> B\n```\n````\n',
  )
})

test('renderBlock renders tables with a header and escaped cells', () => {
  const rendered = renderBlock({
    type: 'table',
    rows: [
      ['Key', 'Value|with pipe'],
      ['Other', 'plain'],
    ],
  })
  assert.equal(
    rendered,
    '| Topic | Details |\n| --- | --- |\n| Key | Value\\|with pipe |\n| Other | plain |\n',
  )
})

test('renderBlock rejects unknown block types instead of silently dropping them', () => {
  assert.throws(() => renderBlock({ type: 'video', src: 'x' }), /Unsupported block type: video/)
})

test('assertValidDocs accepts a well-formed catalogue', () => {
  assert.doesNotThrow(() => assertValidDocs([category()]))
})

test('assertValidDocs rejects a category missing required fields', () => {
  assert.throws(() => assertValidDocs([category({ title: undefined })]), /Invalid category shape/)
  assert.throws(() => assertValidDocs([category({ pages: 'nope' })]), /Invalid category shape/)
})

test('assertValidDocs rejects a page missing a summary', () => {
  assert.throws(
    () => assertValidDocs([category({ pages: [page({ summary: '' })] })]),
    /Invalid page shape in basics/,
  )
})

test('assertValidDocs rejects duplicate page ids across categories', () => {
  assert.throws(
    () => assertValidDocs([category(), category({ id: 'advanced' })]),
    /Duplicate documentation page id: first-note/,
  )
})

test('assertValidDocs rejects a related link pointing at a missing page', () => {
  assert.throws(
    () => assertValidDocs([category({ pages: [page({ related: ['ghost-page'] })] })]),
    /Page first-note references missing related page ghost-page/,
  )
})

test('assertValidDocs allows related links that resolve to a later category', () => {
  const first = category({ pages: [page({ related: ['sync-basics'] })] })
  const second = category({ id: 'sync', pages: [page({ id: 'sync-basics', title: 'Sync' })] })
  assert.doesNotThrow(() => assertValidDocs([first, second]))
})

test('renderMarkdown emits front matter, a table of contents and anchored sections', () => {
  const markdown = renderMarkdown([
    category({
      pages: [page({ related: ['first-note'] }), page({ id: 'second-note', title: 'Second note' })],
    }),
  ])

  assert.match(markdown, /^---\ntitle: In-app guide\n/)
  assert.match(markdown, /<!-- This file is generated by scripts\/export-app-docs-to-pages\.mjs/)
  assert.ok(markdown.includes('- [Basics](#basics)'), 'category TOC entry missing')
  assert.ok(markdown.includes('  - [First note](#first-note)'), 'page TOC entry missing')
  assert.ok(markdown.includes('<a id="basics"></a>\n## Basics'), 'category anchor missing')
  assert.ok(markdown.includes('<a id="second-note"></a>\n### Second note'), 'page anchor missing')
  assert.ok(markdown.includes('Related: [first-note](#first-note)'), 'related line missing')
  assert.ok(markdown.endsWith('\n'), 'output must end with a newline')
})

test('renderMarkdown omits the Related line when a page has no related pages', () => {
  assert.ok(!renderMarkdown([category()]).includes('Related:'))
})

test('renderMarkdown collapses runs of blank lines to at most one', () => {
  const markdown = renderMarkdown([category({ description: '', pages: [page({ summary: ' ' })] })])
  assert.ok(!/\n{3,}/.test(markdown), 'found three or more consecutive newlines')
})

test('the committed docs/app-guide.md matches what the exporter renders today', () => {
  const categories = loadDocCategories()
  assert.ok(Array.isArray(categories) && categories.length > 0, 'DOC_CATEGORIES did not parse')
  assertValidDocs(categories)

  const existing = fs.readFileSync(path.join(repositoryRoot, 'docs', 'app-guide.md'), 'utf8')
  assert.equal(
    renderMarkdown(categories),
    existing,
    'docs/app-guide.md is stale; run node scripts/export-app-docs-to-pages.mjs',
  )
})
