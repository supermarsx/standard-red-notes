#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = fileURLToPath(import.meta.url)
const rootDir = path.resolve(__dirname, '..')
const sourcePath = path.join(
  rootDir,
  'app',
  'packages',
  'web',
  'src',
  'javascripts',
  'Components',
  'Preferences',
  'Panes',
  'Documentation',
  'content.ts',
)
const outputPath = path.join(rootDir, 'docs', 'app-guide.md')
const checkOnly = process.argv.includes('--check')

export function findMatchingBracket(source, startIndex) {
  let depth = 0
  let quote = null
  let escaping = false
  let lineComment = false
  let blockComment = false

  for (let index = startIndex; index < source.length; index++) {
    const current = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (current === '\n') {
        lineComment = false
      }
      continue
    }

    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }

    if (quote) {
      if (escaping) {
        escaping = false
      } else if (current === '\\') {
        escaping = true
      } else if (current === quote) {
        quote = null
      }
      continue
    }

    if (current === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }

    if (current === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }

    if (current === "'" || current === '"' || current === '`') {
      quote = current
      continue
    }

    if (current === '[') {
      depth++
    } else if (current === ']') {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }

  throw new Error('Could not find the end of DOC_CATEGORIES')
}

export function loadDocCategories() {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const marker = 'export const DOC_CATEGORIES: DocCategory[] ='
  const markerIndex = source.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error(`Could not find ${marker} in ${sourcePath}`)
  }

  const arrayStart = source.indexOf('[', markerIndex + marker.length)
  if (arrayStart === -1) {
    throw new Error('Could not find DOC_CATEGORIES array start')
  }

  const arrayEnd = findMatchingBracket(source, arrayStart)
  const arrayText = source.slice(arrayStart, arrayEnd + 1)
  return vm.runInNewContext(`(${arrayText})`, Object.create(null), {
    timeout: 1_000,
    displayErrors: true,
  })
}

export function assertValidDocs(categories) {
  const pageIds = new Set()
  for (const category of categories) {
    if (!category.id || !category.title || !Array.isArray(category.pages)) {
      throw new Error(`Invalid category shape: ${JSON.stringify(category)}`)
    }
    for (const page of category.pages) {
      if (!page.id || !page.title || !page.summary || !Array.isArray(page.blocks)) {
        throw new Error(`Invalid page shape in ${category.id}: ${JSON.stringify(page)}`)
      }
      if (pageIds.has(page.id)) {
        throw new Error(`Duplicate documentation page id: ${page.id}`)
      }
      pageIds.add(page.id)
    }
  }

  for (const category of categories) {
    for (const page of category.pages) {
      for (const related of page.related ?? []) {
        if (!pageIds.has(related)) {
          throw new Error(`Page ${page.id} references missing related page ${related}`)
        }
      }
    }
  }
}

export function escapeMarkdownTableCell(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

export function pageAnchor(id) {
  return id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

export function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return `#### ${block.text}\n`
    case 'paragraph':
      return `${block.text}\n`
    case 'list':
      return `${block.items.map((item) => `- ${item}`).join('\n')}\n`
    case 'steps':
      return `${block.items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`
    case 'code':
      return `\`\`\`\n${block.code}\n\`\`\`\n`
    case 'callout': {
      const labels = {
        info: 'Info',
        tip: 'Tip',
        warning: 'Warning',
      }
      return `> **${labels[block.variant]}.** ${block.text}\n`
    }
    case 'table': {
      const rows = block.rows.map(([left, right]) => `| ${escapeMarkdownTableCell(left)} | ${escapeMarkdownTableCell(right)} |`)
      return ['| Topic | Details |', '| --- | --- |', ...rows].join('\n') + '\n'
    }
    default:
      throw new Error(`Unsupported block type: ${block.type}`)
  }
}

export function renderMarkdown(categories) {
  const lines = [
    '---',
    'title: In-app guide',
    'description: Complete mirror of the offline documentation bundled in the Standard Red Notes app.',
    '---',
    '',
    '<!-- This file is generated by scripts/export-app-docs-to-pages.mjs from app/packages/web/src/javascripts/Components/Preferences/Panes/Documentation/content.ts. -->',
    '',
    '# In-app guide',
    '',
    'This page mirrors the documentation bundled inside the Standard Red Notes app under Preferences -> Documentation. It is generated from the same source data so the online docs stay aligned with the offline, searchable in-app guide.',
    '',
    '## Contents',
    '',
  ]

  for (const category of categories) {
    lines.push(`- [${category.title}](#${pageAnchor(category.id)})`)
    for (const page of category.pages) {
      lines.push(`  - [${page.title}](#${pageAnchor(page.id)})`)
    }
  }

  for (const category of categories) {
    lines.push('', `<a id="${pageAnchor(category.id)}"></a>`, `## ${category.title}`, '', category.description, '')

    for (const page of category.pages) {
      lines.push(
        `<a id="${pageAnchor(page.id)}"></a>`,
        `### ${page.title}`,
        '',
        page.summary,
        '',
      )

      for (const block of page.blocks) {
        lines.push(renderBlock(block))
      }

      if (page.related?.length) {
        const related = page.related.map((id) => `[${id}](#${pageAnchor(id)})`).join(', ')
        lines.push(`Related: ${related}`, '')
      }
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

export function exportAppDocs() {
  const categories = loadDocCategories()
  assertValidDocs(categories)

  const rendered = renderMarkdown(categories)
  if (checkOnly) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
    if (existing !== rendered) {
      console.error(`${path.relative(rootDir, outputPath)} is out of date. Run node scripts/export-app-docs-to-pages.mjs.`)
      process.exit(1)
    }
    console.log(`${path.relative(rootDir, outputPath)} is up to date.`)
  } else {
    fs.writeFileSync(outputPath, rendered)
    console.log(`Wrote ${path.relative(rootDir, outputPath)} from ${path.relative(rootDir, sourcePath)}.`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  exportAppDocs()
}
