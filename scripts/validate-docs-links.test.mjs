import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildSearchIndex, renderSearchIndex } from './generate-docs-search-index.mjs'

import {
  assertDocsLinks,
  extractMarkdownAnchors,
  extractMarkdownTargets,
  extractNavigationUrls,
  extractSafetyAlerts,
  headingSlug,
  validateDocsLinks,
  validateFencedCodeBlocks,
  validateMarkdownStructure,
  validateSafetyAlerts,
  validateShippedCapabilityLanguage,
} from './validate-docs-links.mjs'

async function createFixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'srn-doc-links-'))
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, contents, 'utf8')
  }
  if (!Object.hasOwn(files, 'docs/assets/search-index.json')) {
    const searchIndexPath = path.join(root, 'docs', 'assets', 'search-index.json')
    await mkdir(path.dirname(searchIndexPath), { recursive: true })
    await writeFile(searchIndexPath, renderSearchIndex(buildSearchIndex(path.join(root, 'docs'))), 'utf8')
  }
  return root
}

test('extractNavigationUrls finds nested and quoted URL scalars with source lines', () => {
  assert.deepEqual(
    extractNavigationUrls(
      [
        '- title: Start',
        '  items:',
        '    - title: Home',
        '      url: "/"',
        '    - title: Guide',
        "      url: '/guide.html#setup'",
      ].join('\n'),
    ),
    [
      { file: 'docs/_data/navigation.yml', line: 4, url: '/' },
      { file: 'docs/_data/navigation.yml', line: 6, url: '/guide.html#setup' },
    ],
  )
})

test('heading extraction supports Kramdown slugs, duplicate headings, and explicit anchors', () => {
  const markdown = [
    '---',
    'title: Anchors',
    '---',
    '# 12. Café & sync',
    '## Same',
    '## Same',
    '<a id="manual"></a>',
    '## Custom heading {#custom}',
    '## Kramdown attribute heading',
    '{: .visually-hidden #kramdown-custom}',
    '```md',
    '# Not visible',
    '```',
  ].join('\n')

  assert.equal(headingSlug('12. Café & sync'), 'caf--sync')
  assert.deepEqual(
    [...extractMarkdownAnchors(markdown)].sort(),
    ['caf--sync', 'custom', 'kramdown-custom', 'manual', 'same', 'same-1'].sort(),
  )
  assert.equal(extractMarkdownAnchors(markdown).has('kramdown-attribute-heading'), false)
})

test('fenced code validation accepts matching backticks and tildes and rejects mismatched closers', () => {
  assert.deepEqual(
    validateFencedCodeBlocks(
      ['````shell', 'printf hello', '`````', '', '~~~json', '{"ok":true}', '~~~'].join('\n'),
      'docs/valid.md',
    ),
    [],
  )
  assert.deepEqual(validateFencedCodeBlocks(['````shell', 'printf hello', '```'].join('\n'), 'docs/broken.md'), [
    'docs/broken.md:1: unclosed code fence opened with 4 backticks; closing fence must use the same marker and at least the same length',
  ])
  assert.deepEqual(validateFencedCodeBlocks(['~~~shell', 'printf hello', '```'].join('\n'), 'docs/mixed.md'), [
    'docs/mixed.md:1: unclosed code fence opened with 3 tildes; closing fence must use the same marker and at least the same length',
  ])
})

test('Markdown structure validation ignores front matter, fenced examples, and Setext headings', () => {
  const markdown = [
    '---',
    'title: Structure',
    '---',
    '',
    '# Structure',
    '',
    '---',
    '',
    '## Next section',
    '',
    '* * *',
    '',
    '___',
    '',
    '```md',
    '---',
    '```',
    '',
    'Legacy section',
    '---',
  ].join('\n')

  assert.deepEqual(validateMarkdownStructure(markdown, 'docs/structure.md'), [
    'docs/structure.md:7: redundant Markdown horizontal rule; headings already provide section separation',
    'docs/structure.md:11: redundant Markdown horizontal rule; headings already provide section separation',
    'docs/structure.md:13: redundant Markdown horizontal rule; headings already provide section separation',
  ])
})

test('shipped capability language validation rejects roadmap wording but ignores code examples', () => {
  const markdown = [
    '---',
    'title: Runtime',
    '---',
    '# Runtime',
    'The OpenClaw plan is a design document.',
    'This planned feature is not yet executable.',
    '```md',
    'MCP_SUPPORT_PLAN.md',
    '```',
    'An MFA code controls future sign-ins.',
  ].join('\n')

  assert.deepEqual(validateShippedCapabilityLanguage(markdown, 'docs/runtime.md'), [
    'docs/runtime.md:5: shipped MCP and OpenClaw capabilities must link to their runtime guides, not a plan',
    'docs/runtime.md:6: shipped documentation must state the implemented or gated runtime status',
    'docs/runtime.md:6: state the current unsupported or inert boundary without roadmap wording',
  ])
  assert.deepEqual(validateShippedCapabilityLanguage('# Archived', 'docs/OLD_PLAN.md'), [
    'docs/OLD_PLAN.md:1: shipped capability documentation must not be published as a *_PLAN page',
  ])
})

test('safety alerts enforce supported levels, paired local links, and required topic titles', () => {
  const source = [
    '{% include safety-alert.html',
    '  level="warning"',
    '  title="Different topic"',
    '  body="A concrete risk."',
    '  link_url="https://example.test/help"',
    '%}',
  ].join('\n')

  assert.deepEqual(extractSafetyAlerts(source, 'docs/risk.md'), [
    {
      attributes: {
        level: 'warning',
        title: 'Different topic',
        body: 'A concrete risk.',
        link_url: 'https://example.test/help',
      },
      duplicates: [],
      file: 'docs/risk.md',
      line: 1,
    },
  ])
  assert.deepEqual(validateSafetyAlerts(source, 'docs/risk.md', { requiredTitles: ['Required topic'] }), [
    'docs/risk.md:1: safety alert uses unsupported level "warning"; use danger, caution, trust, or info',
    'docs/risk.md:1: safety alert must provide link_url and link_text together',
    'docs/risk.md:1: safety alert link_url must be a local absolute documentation path',
    'docs/risk.md: required safety topic is missing its shared alert: "Required topic"',
  ])
})

test('critical safety pages reject legacy blockquotes and missing shared alert topics', () => {
  const source = [
    '> ⚠️ User deletion is irreversible.',
    '{% include safety-alert.html',
    '  level="caution"',
    '  title="Verbose logs can expose operational metadata"',
    '  body="Restrict access."',
    '%}',
  ].join('\n')
  const diagnostics = validateSafetyAlerts(source, 'docs/administration.md')
  assert.ok(diagnostics.includes('docs/administration.md: required safety topic is missing its shared alert: "User deletion is irreversible"'))
  assert.ok(diagnostics.includes('docs/administration.md: critical warnings must use the shared safety-alert component'))
})

test('target extraction ignores code and preserves link and image line numbers', () => {
  const targets = extractMarkdownTargets(
    [
      '# Links',
      '[Guide](guide.md#setup)',
      '![Screenshot](/assets/screenshot.png)',
      '<a href="../README.md">Repository</a>',
      '```md',
      '[Ignored](missing.md)',
      '```',
    ].join('\n'),
    'docs/index.md',
  )

  assert.deepEqual(targets, [
    {
      destination: 'guide.md#setup',
      file: 'docs/index.md',
      kind: 'link',
      line: 2,
    },
    {
      destination: '/assets/screenshot.png',
      file: 'docs/index.md',
      kind: 'image',
      line: 3,
    },
    {
      destination: '../README.md',
      file: 'docs/index.md',
      kind: 'link',
      line: 4,
    },
  ])
})

test('a complete fixture validates nested navigation, anchors, images, and repository-relative links', async () => {
  const root = await createFixture({
    '.github/workflows/ci.yml': 'name: CI\n',
    'docs/_config.yml': 'baseurl: "/standard-red-notes"\n',
    'docs/_data/navigation.yml': [
      '- title: Start',
      '  items:',
      '    - title: Home',
      '      url: /',
      '    - title: Setup',
      '      url: /guide.html#setup',
      '    - title: First repeated heading',
      '      url: /guide.html#same',
      '    - title: Repeated heading',
      '      url: /guide.html#same-1',
      '    - title: Explicit anchor',
      '      url: /reference.html#manual',
    ].join('\n'),
    'docs/assets/screenshot.png': 'png',
    'docs/guide.md': [
      '---',
      'title: Guide',
      '---',
      '# Guide',
      '## Setup',
      '## Same',
      '## Same',
      '[Reference](reference.html#manual)',
      '[Workflow](../.github/workflows/ci.yml)',
    ].join('\n'),
    'docs/index.md': [
      '# Home',
      '[Guide](guide.md#setup)',
      '![Screenshot](/assets/screenshot.png)',
      '[Published guide](/standard-red-notes/guide.html#setup)',
      '[External](https://example.test)',
      '[Email](mailto:docs@example.test)',
      "[Liquid]({{ '/generated.html' | relative_url }})",
    ].join('\n'),
    'docs/reference.md': '# Reference\n\n<a id="manual"></a>\n\nDetails.\n',
  })

  try {
    assert.deepEqual(await validateDocsLinks({ root }), [])
    await assert.doesNotReject(assertDocsLinks({ root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('docs validation reports redundant Markdown horizontal rules outside front matter', async () => {
  const root = await createFixture({
    'docs/_data/navigation.yml': ['- title: Start', '  items:', '    - title: Home', '      url: /'].join('\n'),
    'docs/index.md': ['---', 'title: Home', '---', '', '# Home', '', '---', '', '## Details'].join('\n'),
  })

  try {
    assert.deepEqual(await validateDocsLinks({ root }), [
      'docs/_data/navigation.yml: indexed documentation section "index.html#details" is missing from navigation',
      'docs/index.md:7: redundant Markdown horizontal rule; headings already provide section separation',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('broken navigation reports missing pages, fragments, and unlisted top-level pages', async () => {
  const root = await createFixture({
    'docs/_data/navigation.yml': [
      '- title: Start',
      '  items:',
      '    - title: Home',
      '      url: /',
      '    - title: Missing page',
      '      url: /missing.html',
      '    - title: Missing fragment',
      '      url: /guide.html#not-here',
    ].join('\n'),
    'docs/guide.md': '# Guide\n\n## Present\n',
    'docs/index.md': '# Home\n',
    'docs/unlisted.md': '# Unlisted\n',
  })

  try {
    const diagnostics = await validateDocsLinks({ root })
    assert.equal(diagnostics.length, 4)
    assert.ok(
      diagnostics.some((message) =>
        message.includes('docs/_data/navigation.yml:6: navigation URL "/missing.html" does not exist'),
      ),
    )
    assert.ok(
      diagnostics.some((message) =>
        message.includes(
          'docs/_data/navigation.yml:8: navigation URL "/guide.html#not-here" references missing anchor "#not-here"',
        ),
      ),
    )
    assert.ok(
      diagnostics.some((message) =>
        message.includes('docs/unlisted.md:1: page is missing from docs/_data/navigation.yml'),
      ),
    )
    assert.ok(
      diagnostics.some((message) =>
        message.includes('indexed documentation section "guide.html#present" is missing from navigation'),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('broken Markdown reports link, image, repository target, and anchor errors at source lines', async () => {
  const root = await createFixture({
    'docs/_data/navigation.yml': [
      '- title: Start',
      '  items:',
      '    - title: Home',
      '      url: /',
      '    - title: Guide',
      '      url: /guide.html',
    ].join('\n'),
    'docs/guide.md': '# Guide\n\n## Existing\n',
    'docs/index.md': [
      '# Home',
      '[Missing page](missing.md)',
      '![Missing image](/assets/missing.png)',
      '[Missing source](../server/not-here.ts)',
      '[Missing anchor](guide.html#not-here)',
    ].join('\n'),
  })

  try {
    const diagnostics = await validateDocsLinks({ root })
    assert.equal(diagnostics.length, 5)
    assert.ok(diagnostics.some((message) => message.includes('docs/index.md:2: link "missing.md" does not exist')))
    assert.ok(
      diagnostics.some((message) => message.includes('docs/index.md:3: image "/assets/missing.png" does not exist')),
    )
    assert.ok(
      diagnostics.some((message) => message.includes('docs/index.md:4: link "../server/not-here.ts" does not exist')),
    )
    assert.ok(
      diagnostics.some((message) =>
        message.includes('docs/index.md:5: link "guide.html#not-here" references missing anchor "#not-here"'),
      ),
    )
    assert.ok(
      diagnostics.some((message) =>
        message.includes('indexed documentation section "guide.html#existing" is missing from navigation'),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('navigation and the generated search index must cover every current Markdown section', async () => {
  const root = await createFixture({
    'docs/_data/navigation.yml': ['- title: Start', '  items:', '    - title: Home', '      url: /'].join('\n'),
    'docs/index.md': '# Home\n\n## Recovery drill\n',
    'docs/assets/search-index.json': JSON.stringify({
      version: 1,
      documents: [
        { id: 'index.md', title: 'Home', section: '', url: 'index.html', text: 'Home' },
        { id: 'index.md#stale', title: 'Home', section: 'Stale', url: 'index.html#stale', text: 'Old' },
      ],
    }),
  })

  try {
    const diagnostics = await validateDocsLinks({ root })
    assert.ok(
      diagnostics.some((message) =>
        message.includes('indexed documentation section "index.html#recovery-drill" is missing from navigation'),
      ),
    )
    assert.ok(
      diagnostics.some((message) =>
        message.includes('current Markdown section "index.html#recovery-drill" is missing'),
      ),
    )
    assert.ok(
      diagnostics.some((message) => message.includes('stale or unknown section "index.html#stale" is indexed')),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shared safety-alert links are resolved like local Markdown links', async () => {
  const root = await createFixture({
    'docs/_data/navigation.yml': ['- title: Start', '  items:', '    - title: Home', '      url: /'].join('\n'),
    'docs/index.md': [
      '# Home',
      '{% include safety-alert.html',
      '  level="danger"',
      '  title="Delete carefully"',
      '  body="Keep a backup."',
      '  link_url="/missing.html#restore"',
      '  link_text="Restore safely"',
      '%}',
    ].join('\n'),
  })

  try {
    const diagnostics = await validateDocsLinks({ root })
    assert.ok(
      diagnostics.some((message) =>
        message.includes('docs/index.md:2: link "/missing.html#restore" does not exist'),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
