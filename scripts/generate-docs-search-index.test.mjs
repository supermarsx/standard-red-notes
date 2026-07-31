import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  buildSearchIndex,
  generateDocsSearchIndex,
  headingAnchor,
  indexMarkdown,
  markdownToText,
  parseFrontMatter,
  renderSearchIndex,
} from './generate-docs-search-index.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadClientSearchApi() {
  const context = {
    __SRN_DOCS_SEARCH_TEST__: {},
    console,
  }
  vm.runInNewContext(fs.readFileSync(path.join(repositoryRoot, 'docs', 'assets', 'docs-search.js'), 'utf8'), context)
  return context.__SRN_DOCS_SEARCH_TEST__
}

test('parseFrontMatter normalizes line endings and reads quoted scalars', () => {
  const parsed = parseFrontMatter("---\r\ntitle: 'Search me'\r\ndescription: A page.\r\n---\r\n# Body\r\n")
  assert.deepEqual(parsed.attributes, { title: 'Search me', description: 'A page.' })
  assert.equal(parsed.body, '# Body\n')
})

test('markdownToText retains useful words while removing presentation syntax', () => {
  assert.equal(
    markdownToText(
      "Use **encrypted** [notes](https://example.test) with `Ctrl K` and `FOO_BAR`.\n{% include search.html %}\n| Fast | Local |",
    ),
    'Use encrypted notes with Ctrl K and FOO_BAR. Fast Local',
  )
})

test('markdownToText keeps shared safety-alert guidance searchable', () => {
  assert.equal(
    markdownToText(
      [
        '{% include safety-alert.html',
        '  level="danger"',
        '  title="Readable backups leave the encrypted vault"',
        '  body="Protect &quot;plaintext&quot; exports."',
        '  link_url="/backups.html"',
        '  link_text="Review backup safety"',
        '%}',
      ].join('\n'),
    ),
    'Readable backups leave the encrypted vault Protect "plaintext" exports. Review backup safety',
  )
})

test('headingAnchor is deterministic and compatible with ordinary Kramdown heading ids', () => {
  assert.equal(headingAnchor('Backups & recovery'), 'backups--recovery')
  assert.equal(headingAnchor('Café sync -- setup!'), 'caf-sync----setup')
  assert.equal(headingAnchor('12. Another one 1 here'), 'another-one-1-here')
  assert.equal(headingAnchor('123456789'), 'section')
})

test('indexMarkdown emits a page record and hierarchical section records', () => {
  const records = indexMarkdown(
    'guides/start.md',
    `---
title: Start here
description: A short introduction.
---
# Start here

Welcome to the docs.

## Accounts

Sign in securely.

<a id="manual-sync"></a>
### Sync & recovery

Recover an offline copy.
`,
  )

  assert.deepEqual(
    records.map(({ id, title, section, url }) => ({ id, title, section, url })),
    [
      { id: 'guides/start.md', title: 'Start here', section: '', url: 'guides/start.html' },
      {
        id: 'guides/start.md#accounts',
        title: 'Start here',
        section: 'Accounts',
        url: 'guides/start.html#accounts',
      },
      {
        id: 'guides/start.md#manual-sync',
        title: 'Start here',
        section: 'Accounts › Sync & recovery',
        url: 'guides/start.html#manual-sync',
      },
    ],
  )
  assert.match(records[0].text, /A short introduction\. Start here Welcome to the docs\./)
  assert.equal(records[2].text, 'Recover an offline copy.')
})

test('indexMarkdown makes repeated generated anchors unique and respects search: false', () => {
  const records = indexMarkdown('repeat.md', '# Repeated\n## Same\nOne.\n## Same\nTwo.')
  assert.deepEqual(
    records.map(({ url }) => url),
    ['repeat.html', 'repeat.html#same', 'repeat.html#same-1'],
  )
  assert.deepEqual(indexMarkdown('private.md', '---\nsearch: false\n---\n# Private'), [])
})

test('indexMarkdown does not treat hash-prefixed lines inside code fences as headings', () => {
  const records = indexMarkdown(
    'commands.md',
    '# Commands\n\n## Example\n\n```shell\n# this is a shell comment\nprintf hello\n```\n',
  )
  assert.deepEqual(
    records.map(({ url }) => url),
    ['commands.html', 'commands.html#example'],
  )
  assert.match(records[1].text, /this is a shell comment printf hello/)
})

test('buildSearchIndex walks markdown files in deterministic path order and skips Jekyll internals', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'srn-doc-search-'))
  try {
    fs.mkdirSync(path.join(temporaryDirectory, '_drafts'))
    fs.mkdirSync(path.join(temporaryDirectory, 'guides'))
    fs.writeFileSync(path.join(temporaryDirectory, 'z.md'), '---\ntitle: Zed\n---\n# Zed')
    fs.writeFileSync(path.join(temporaryDirectory, 'guides', 'a.md'), '---\ntitle: Alpha\n---\n# Alpha')
    fs.writeFileSync(path.join(temporaryDirectory, '_drafts', 'hidden.md'), '# Hidden')

    const index = buildSearchIndex(temporaryDirectory)
    assert.deepEqual(
      index.documents.map(({ id }) => id),
      ['guides/a.md', 'z.md'],
    )
    assert.equal(index.version, 1)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('generateDocsSearchIndex writes deterministic JSON and check detects stale output', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'srn-doc-search-'))
  try {
    const docsDirectory = path.join(temporaryDirectory, 'docs')
    const outputPath = path.join(docsDirectory, 'assets', 'search-index.json')
    fs.mkdirSync(docsDirectory)
    fs.writeFileSync(path.join(docsDirectory, 'index.md'), '---\ntitle: Home\n---\n# Home\n\nLocal search.')

    assert.equal(generateDocsSearchIndex({ docsDirectory, outputPath }).changed, true)
    assert.equal(generateDocsSearchIndex({ docsDirectory, outputPath }).changed, false)
    assert.doesNotThrow(() => generateDocsSearchIndex({ docsDirectory, outputPath, check: true }))

    fs.appendFileSync(path.join(docsDirectory, 'index.md'), '\nNew text.')
    assert.throws(
      () => generateDocsSearchIndex({ docsDirectory, outputPath, check: true }),
      /search-index\.json is out of date/,
    )
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('client ranking requires every term and prioritizes matching section headings', () => {
  const { rankDocuments } = loadClientSearchApi()
  const documents = [
    { title: 'Overview', section: '', text: 'Backups and account recovery live here.', url: 'index.html' },
    { title: 'Operations', section: 'Backup recovery', text: 'Restore a snapshot.', url: 'ops.html#backup-recovery' },
    { title: 'Operations', section: 'Monitoring', text: 'Backup metrics only.', url: 'ops.html#monitoring' },
  ]

  const ranked = rankDocuments(documents, 'backup recovery')
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].document.url, 'ops.html#backup-recovery')
  assert.equal(ranked[1].document.url, 'index.html')
})

test('client ranking keeps broad queries from being crowded by one page', () => {
  const { rankDocuments } = loadClientSearchApi()
  const documents = [
    ...Array.from({ length: 6 }, (_, index) => ({
      title: 'Backups',
      section: `Backup recovery ${index + 1}`,
      text: 'Restore an encrypted backup.',
      url: `backups.html#section-${index + 1}`,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      title: `Operations ${index + 1}`,
      section: 'Backup recovery',
      text: 'Recover another service.',
      url: `operations-${index + 1}.html#recovery`,
    })),
  ]

  const ranked = rankDocuments(documents, 'backup recovery', 6)
  assert.equal(ranked.length, 6)
  assert.equal(
    ranked.filter(({ document }) => document.url.startsWith('backups.html')).length,
    3,
  )
  assert.equal(new Set(ranked.map(({ document }) => document.url.split('#')[0])).size, 4)
})

test('client ranking finds underscore-separated configuration identifiers', () => {
  const { rankDocuments } = loadClientSearchApi()
  const document = {
    title: 'Configuration',
    section: 'Environment',
    text: markdownToText('Set `STANDARD_RED_NOTES_ALLOW_WRITES=1` to opt in.'),
    url: 'configuration.html#environment',
  }

  assert.equal(rankDocuments([document], 'STANDARD_RED_NOTES_ALLOW_WRITES')[0]?.document.url, document.url)
})

test('client snippets center the earliest match and mark clipped edges', () => {
  const { snippetFor } = loadClientSearchApi()
  const snippet = snippetFor(`${'prefix '.repeat(30)}encrypted backup${' suffix'.repeat(30)}`, 'encrypted')
  assert.match(snippet, /^…/)
  assert.match(snippet, /encrypted backup/)
  assert.match(snippet, /…$/)
  assert.ok(snippet.length <= 192)
})

test('client snippets and highlights preserve accented source text for unaccented queries', () => {
  const { matchingRanges, snippetFor } = loadClientSearchApi()
  const text = `${'prefix '.repeat(30)}Café recovery keeps résumé details.${' suffix'.repeat(30)}`
  const snippet = snippetFor(text, 'cafe recovery')
  const ranges = matchingRanges('Café recovery', ['cafe', 'recovery'])
  const decomposed = `Cafe\u0301 recovery`
  const decomposedRanges = matchingRanges(decomposed, ['', 'cafe'])

  assert.match(snippet, /Café recovery/)
  assert.deepEqual(
    Array.from(ranges, ({ start, end }) => 'Café recovery'.slice(start, end)),
    ['Café', 'recovery'],
  )
  assert.deepEqual(
    Array.from(decomposedRanges, ({ start, end }) => decomposed.slice(start, end)),
    [`Cafe\u0301`],
  )
})

test('the committed search index exactly matches every current docs markdown page', () => {
  const docsDirectory = path.join(repositoryRoot, 'docs')
  const committed = fs.readFileSync(path.join(docsDirectory, 'assets', 'search-index.json'), 'utf8')
  assert.equal(committed, renderSearchIndex(buildSearchIndex(docsDirectory)))
})
