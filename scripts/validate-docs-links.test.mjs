import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertDocsLinks,
  extractMarkdownAnchors,
  extractMarkdownTargets,
  extractNavigationUrls,
  headingSlug,
  validateDocsLinks,
  validateFencedCodeBlocks,
} from './validate-docs-links.mjs'

async function createFixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'srn-doc-links-'))
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, contents, 'utf8')
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
    assert.equal(diagnostics.length, 3)
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
    assert.equal(diagnostics.length, 4)
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
