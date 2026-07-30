#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const defaultDocsDirectory = path.join(repositoryRoot, 'docs')
const defaultOutputPath = path.join(defaultDocsDirectory, 'assets', 'search-index.json')

function decodeEntities(value) {
  const entities = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  }
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => entities[name.toLowerCase()] ?? entity)
}

export function parseFrontMatter(source) {
  const normalized = source.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { attributes: {}, body: normalized }
  }

  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) {
    throw new Error('Unterminated YAML front matter')
  }

  const attributes = {}
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (!match) {
      continue
    }
    let value = match[2]
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    attributes[match[1]] = value
  }

  return { attributes, body: normalized.slice(end + 5) }
}

export function markdownToText(markdown) {
  return decodeEntities(
    markdown
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\{[{%][\s\S]*?[}%]\}/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*<a\s+[^>]*id=["'][^"']+["'][^>]*><\/a>\s*$/gim, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^\s*(```+|~~~+).*$/gm, ' ')
      .replace(/[`*~]/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}(?:>\s*|[-+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/^\s*\|?/gm, '')
      .replace(/\|?\s*$/gm, '')
      .replace(/\s*\|\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

export function headingAnchor(heading) {
  const cleaned = decodeEntities(markdownToText(heading))
    .replace(/^[^a-z]+/i, '')
    .replace(/[^a-z0-9 -]/gi, '')
    .replaceAll(' ', '-')
    .toLowerCase()
  return cleaned || 'section'
}

function pageUrl(relativePath) {
  return relativePath.replaceAll(path.sep, '/').replace(/\.md$/i, '.html')
}

function uniqueAnchor(anchor, anchorCounts) {
  const base = anchor || 'section'
  const count = anchorCounts.get(base) ?? 0
  anchorCounts.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

export function indexMarkdown(relativePath, source) {
  const { attributes, body } = parseFrontMatter(source)
  if (String(attributes.search).toLowerCase() === 'false') {
    return []
  }

  const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]
  const title = markdownToText(attributes.title || firstHeading || path.basename(relativePath, path.extname(relativePath)))
  const description = markdownToText(attributes.description || '')
  const url = pageUrl(relativePath)
  const lines = body.split('\n')
  const headings = []
  const sections = []
  const anchorCounts = new Map()
  let pendingAnchor = null
  let currentSection = null
  let codeFence = null

  const finishSection = () => {
    if (!currentSection) {
      return
    }
    const text = markdownToText(currentSection.lines.join('\n'))
    sections.push({
      id: `${relativePath}#${currentSection.anchor}`,
      title,
      section: currentSection.path.join(' › '),
      url: `${url}#${currentSection.anchor}`,
      text,
    })
    currentSection = null
  }

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (codeFence) {
      currentSection?.lines.push(line)
      if (fenceMatch && fenceMatch[1][0] === codeFence.marker && fenceMatch[1].length >= codeFence.length) {
        codeFence = null
      }
      continue
    }
    if (fenceMatch) {
      codeFence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }
      currentSection?.lines.push(line)
      continue
    }

    const anchorMatch = /^\s*<a\s+[^>]*id=["']([^"']+)["'][^>]*><\/a>\s*$/i.exec(line)
    if (anchorMatch) {
      pendingAnchor = anchorMatch[1]
      continue
    }

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!headingMatch) {
      currentSection?.lines.push(line)
      continue
    }

    finishSection()
    const level = headingMatch[1].length
    const heading = markdownToText(headingMatch[2])
    headings[level] = heading
    headings.length = level + 1

    if (level > 1) {
      const anchor = uniqueAnchor(pendingAnchor || headingAnchor(heading), anchorCounts)
      currentSection = {
        anchor,
        path: headings.slice(2, level + 1).filter(Boolean),
        lines: [],
      }
    }
    pendingAnchor = null
  }
  finishSection()

  const pageText = markdownToText([description, body].filter(Boolean).join('\n'))
  return [
    {
      id: relativePath,
      title,
      section: '',
      url,
      text: pageText,
    },
    ...sections,
  ]
}

export function listMarkdownFiles(directory) {
  const files = []
  const visit = (currentDirectory) => {
    const entries = fs.readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )
    for (const entry of entries) {
      if (entry.name.startsWith('_')) {
        continue
      }
      const absolutePath = path.join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        visit(absolutePath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(absolutePath)
      }
    }
  }
  visit(directory)
  return files
}

export function buildSearchIndex(docsDirectory = defaultDocsDirectory) {
  const documents = []
  for (const filePath of listMarkdownFiles(docsDirectory)) {
    const relativePath = path.relative(docsDirectory, filePath).replaceAll(path.sep, '/')
    documents.push(...indexMarkdown(relativePath, fs.readFileSync(filePath, 'utf8')))
  }
  return {
    version: 1,
    documents,
  }
}

export function renderSearchIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`
}

export function generateDocsSearchIndex({
  docsDirectory = defaultDocsDirectory,
  outputPath = defaultOutputPath,
  check = false,
} = {}) {
  const rendered = renderSearchIndex(buildSearchIndex(docsDirectory))
  if (check) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
    if (existing !== rendered) {
      throw new Error(
        `${path.relative(repositoryRoot, outputPath)} is out of date. Run node scripts/generate-docs-search-index.mjs.`,
      )
    }
    return { changed: false, rendered }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
  if (existing !== rendered) {
    fs.writeFileSync(outputPath, rendered)
    return { changed: true, rendered }
  }
  return { changed: false, rendered }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const check = process.argv.includes('--check')
    const result = generateDocsSearchIndex({ check })
    const relativeOutput = path.relative(repositoryRoot, defaultOutputPath)
    console.log(check ? `${relativeOutput} is up to date.` : `${result.changed ? 'Wrote' : 'Kept'} ${relativeOutput}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
