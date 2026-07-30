#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

function posixPath(value) {
  return value.replaceAll(path.sep, '/')
}

function displayPath(root, value) {
  const relative = path.relative(root, value)
  return relative && !relative.startsWith('..') ? posixPath(relative) : posixPath(value)
}

function decodeUrlPart(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isSkippedDestination(destination) {
  const value = destination.trim()
  return value.includes('{{') || value.includes('{%') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.length < 2) {
    return trimmed.replace(/\s+#.*$/, '').trim()
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed.replace(/\s+#.*$/, '').trim()
}

export function extractNavigationUrls(source, file = 'docs/_data/navigation.yml') {
  const entries = []
  for (const [index, line] of source.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const match = /^\s*(?:-\s*)?url:\s*(.*?)\s*$/.exec(line)
    if (!match) {
      continue
    }
    const url = unquoteYamlScalar(match[1])
    if (!url) {
      throw new Error(`${file}:${index + 1}: navigation url must not be empty`)
    }
    entries.push({ file, line: index + 1, url })
  }
  return entries
}

function removeFrontMatter(lines) {
  const result = [...lines]
  if (result[0]?.trim() !== '---') {
    return result
  }
  result[0] = ''
  for (let index = 1; index < result.length; index += 1) {
    const closing = result[index].trim()
    result[index] = ''
    if (closing === '---' || closing === '...') {
      break
    }
  }
  return result
}

function visibleMarkdownLines(source, { maskInlineCode = true } = {}) {
  const lines = removeFrontMatter(source.replace(/\r\n?/g, '\n').split('\n'))
  const visible = []
  let fence = null
  let inComment = false

  for (const originalLine of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(originalLine)
    if (fence) {
      visible.push('')
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        new RegExp(`^\\s{0,3}${fence.marker}{${fence.length},}\\s*$`).test(originalLine)
      ) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }
      visible.push('')
      continue
    }

    let line = originalLine
    let output = ''
    let cursor = 0
    while (cursor < line.length) {
      if (inComment) {
        const end = line.indexOf('-->', cursor)
        if (end === -1) {
          cursor = line.length
          break
        }
        cursor = end + 3
        inComment = false
        continue
      }
      const start = line.indexOf('<!--', cursor)
      if (start === -1) {
        output += line.slice(cursor)
        break
      }
      output += line.slice(cursor, start)
      cursor = start + 4
      inComment = true
    }

    line = maskInlineCode ? output.replace(/(`+)([\s\S]*?)\1/g, (match) => ' '.repeat(match.length)) : output
    visible.push(line)
  }

  return visible
}

export function validateMarkdownStructure(source, file = '<markdown>') {
  const lines = visibleMarkdownLines(source, { maskInlineCode: false })
  const diagnostics = []

  for (const [index, line] of lines.entries()) {
    if (line.trim() !== '---') {
      continue
    }

    // A hyphen line directly under text is a Setext heading underline, not a
    // thematic break. Front matter and fenced examples are already masked.
    if ((lines[index - 1] ?? '').trim()) {
      continue
    }

    diagnostics.push(
      `${file}:${index + 1}: redundant Markdown horizontal rule; headings already provide section separation`,
    )
  }

  return diagnostics
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' }
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity)
}

export function headingSlug(heading) {
  const plain = decodeEntities(
    heading
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(`+)(.*?)\1/g, '$2')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[`*_~]/g, ''),
  )
    .replace(/^[^a-z]+/i, '')
    .replace(/[^a-z\d -]/gi, '')
    .replaceAll(' ', '-')
    .toLowerCase()

  return plain || 'section'
}

export function extractMarkdownAnchors(source) {
  const lines = visibleMarkdownLines(source, { maskInlineCode: false })
  const anchors = new Set()
  const generatedCounts = new Map()
  let previousHeadingCandidate = null
  const attributeId = (line) => /^\s*\{:\s*[^}]*#([^\s.}]+)[^}]*}\s*$/.exec(line)?.[1]

  const addGenerated = (text) => {
    const base = headingSlug(text)
    const count = generatedCounts.get(base) ?? 0
    generatedCounts.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }

  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      anchors.add(match[1])
    }

    const attributeLineId = attributeId(line)
    if (attributeLineId) {
      anchors.add(attributeLineId)
      previousHeadingCandidate = null
      continue
    }

    const atx = /^\s{0,3}#{1,6}(?:\s+|$)(.*?)\s*#*\s*$/.exec(line)
    if (atx) {
      const custom = /\s*\{[^}]*#([^\s.}]+)[^}]*}\s*$/.exec(atx[1])
      const followingAttributeId = attributeId(lines[index + 1] ?? '')
      if (custom || followingAttributeId) {
        anchors.add(custom?.[1] ?? followingAttributeId)
      } else {
        addGenerated(atx[1])
      }
      previousHeadingCandidate = null
      continue
    }

    if (/^\s{0,3}(?:=+|-+)\s*$/.test(line) && previousHeadingCandidate) {
      const followingAttributeId = attributeId(lines[index + 1] ?? '')
      if (followingAttributeId) {
        anchors.add(followingAttributeId)
      } else {
        addGenerated(previousHeadingCandidate)
      }
      previousHeadingCandidate = null
      continue
    }

    previousHeadingCandidate = line.trim() ? line : null
  }

  return anchors
}

function fenceName(marker, length) {
  const name = marker === '`' ? 'backtick' : 'tilde'
  return `${length} ${name}${length === 1 ? '' : 's'}`
}

export function validateFencedCodeBlocks(source, file = '<markdown>') {
  const lines = removeFrontMatter(source.replace(/\r\n?/g, '\n').split('\n'))
  let fence = null

  for (const [index, line] of lines.entries()) {
    const candidate = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!candidate) {
      continue
    }

    if (!fence) {
      fence = {
        length: candidate[1].length,
        line: index + 1,
        marker: candidate[1][0],
      }
      continue
    }

    const isClosing =
      candidate[1][0] === fence.marker && candidate[1].length >= fence.length && candidate[2].trim() === ''
    if (isClosing) {
      fence = null
    }
  }

  if (!fence) {
    return []
  }
  return [
    `${file}:${fence.line}: unclosed code fence opened with ${fenceName(
      fence.marker,
      fence.length,
    )}; closing fence must use the same marker and at least the same length`,
  ]
}

function findClosingBracket(line, start) {
  let depth = 0
  for (let index = start + 1; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1
      continue
    }
    if (line[index] === '[') {
      depth += 1
    } else if (line[index] === ']') {
      if (depth === 0) {
        return index
      }
      depth -= 1
    }
  }
  return -1
}

function parseInlineDestination(line, openingParenthesis) {
  let cursor = openingParenthesis + 1
  while (/\s/.test(line[cursor] ?? '')) {
    cursor += 1
  }
  if (line[cursor] === ')') {
    return { destination: '', end: cursor }
  }
  if (line[cursor] === '<') {
    const end = line.indexOf('>', cursor + 1)
    return end === -1 ? null : { destination: line.slice(cursor + 1, end), end }
  }

  let destination = ''
  let nested = 0
  for (; cursor < line.length; cursor += 1) {
    const character = line[cursor]
    if (character === '\\' && cursor + 1 < line.length) {
      destination += line[cursor + 1]
      cursor += 1
      continue
    }
    if (character === '(') {
      nested += 1
      destination += character
      continue
    }
    if (character === ')') {
      if (nested === 0) {
        return { destination, end: cursor }
      }
      nested -= 1
      destination += character
      continue
    }
    if (/\s/.test(character) && nested === 0) {
      return { destination, end: cursor }
    }
    destination += character
  }
  return null
}

export function extractMarkdownTargets(source, file = '<markdown>') {
  const targets = []
  const lines = visibleMarkdownLines(source)

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const definition = /^\s{0,3}\[[^\]]+]:\s*(?:<([^>]+)>|(\S+))/.exec(line)
    if (definition) {
      targets.push({
        destination: definition[1] ?? definition[2],
        file,
        kind: 'link',
        line: lineNumber,
      })
    }

    for (const match of line.matchAll(/<(a|img)\b[^>]*?\b(href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      targets.push({
        destination: match[3],
        file,
        kind: match[1].toLowerCase() === 'img' ? 'image' : 'link',
        line: lineNumber,
      })
    }

    for (let cursor = 0; cursor < line.length; cursor += 1) {
      if (line[cursor] !== '[' || (cursor > 0 && line[cursor - 1] === '\\')) {
        continue
      }
      const closing = findClosingBracket(line, cursor)
      if (closing === -1) {
        continue
      }
      let parenthesis = closing + 1
      while (/\s/.test(line[parenthesis] ?? '')) {
        parenthesis += 1
      }
      if (line[parenthesis] !== '(') {
        continue
      }
      const parsed = parseInlineDestination(line, parenthesis)
      if (!parsed) {
        continue
      }
      targets.push({
        destination: parsed.destination,
        file,
        kind: cursor > 0 && line[cursor - 1] === '!' ? 'image' : 'link',
        line: lineNumber,
      })
    }
  }

  return targets
}

async function listMarkdownFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(absolute)))
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      files.push(absolute)
    }
  }
  return files.sort((left, right) => posixPath(left).localeCompare(posixPath(right)))
}

function readBaseUrl(config) {
  const match = /^\s*baseurl:\s*(.*?)\s*$/m.exec(config)
  return match ? unquoteYamlScalar(match[1]).replace(/\/+$/, '') : ''
}

function splitDestination(destination) {
  const hashIndex = destination.indexOf('#')
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? '' : destination.slice(hashIndex + 1)
  const queryIndex = beforeHash.indexOf('?')
  return {
    fragment,
    pathname: queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex),
  }
}

function candidatePaths({ baseUrl, destinationPath, docsDirectory, sourceFile }) {
  let pathname = destinationPath
  const absoluteSitePath = pathname.startsWith('/')
  if (absoluteSitePath && baseUrl && (pathname === baseUrl || pathname.startsWith(`${baseUrl}/`))) {
    pathname = pathname.slice(baseUrl.length) || '/'
  }

  const decoded = decodeUrlPart(pathname)
  if (decoded === null || decoded.includes('\0')) {
    return { candidates: [], invalidEncoding: true }
  }
  if (decoded.includes('\\')) {
    return { candidates: [], invalidBackslash: true }
  }

  if (decoded === '') {
    return { candidates: [sourceFile] }
  }

  const base = absoluteSitePath ? docsDirectory : path.dirname(sourceFile)
  const relative = absoluteSitePath ? decoded.replace(/^\/+/, '') : decoded
  const initial = path.resolve(base, relative || '.')
  const candidates = []
  const add = (value) => {
    const resolved = path.resolve(value)
    if (!candidates.includes(resolved)) {
      candidates.push(resolved)
    }
  }

  if (absoluteSitePath && (decoded === '/' || decoded === baseUrl)) {
    add(path.join(docsDirectory, 'index.md'))
    return { candidates }
  }

  if (/\.html$/i.test(initial) && isInside(docsDirectory, initial)) {
    add(initial.replace(/\.html$/i, '.md'))
    add(initial)
  } else {
    add(initial)
  }

  if (isInside(docsDirectory, initial) && !path.extname(initial)) {
    add(`${initial}.md`)
    add(path.join(initial, 'index.md'))
  } else if (decoded.endsWith('/')) {
    add(path.join(initial, 'index.md'))
  }

  return { candidates }
}

function createExactPathInspector(root) {
  const directoryCache = new Map()

  return async (candidate) => {
    const resolved = path.resolve(candidate)
    if (!isInside(root, resolved)) {
      return { exists: false, outsideRoot: true, path: resolved }
    }
    const relative = path.relative(root, resolved)
    if (!relative) {
      return { exists: true, path: root, type: 'directory' }
    }

    let current = root
    for (const segment of relative.split(path.sep)) {
      let entries = directoryCache.get(current)
      if (!entries) {
        try {
          entries = await readdir(current, { withFileTypes: true })
        } catch {
          return { exists: false, path: resolved }
        }
        directoryCache.set(current, entries)
      }
      const entry = entries.find((candidateEntry) => candidateEntry.name === segment)
      if (!entry) {
        return { exists: false, path: resolved }
      }
      current = path.join(current, entry.name)
    }

    const details = await stat(current)
    return {
      exists: true,
      path: current,
      type: details.isDirectory() ? 'directory' : details.isFile() ? 'file' : 'other',
    }
  }
}

async function resolveDestination(options, inspectPath) {
  const result = candidatePaths(options)
  if (result.invalidEncoding || result.invalidBackslash) {
    return result
  }

  for (const candidate of result.candidates) {
    const inspected = await inspectPath(candidate)
    if (inspected.exists) {
      return { ...result, ...inspected }
    }
    if (inspected.outsideRoot) {
      return { ...result, ...inspected }
    }
  }
  return { ...result, exists: false, path: result.candidates[0] }
}

function describeTarget(root, target) {
  return target ? displayPath(root, target) : '<invalid URL>'
}

export async function validateDocsLinks({
  root = repositoryRoot,
  docsDirectory = path.join(root, 'docs'),
  navigationPath = path.join(docsDirectory, '_data', 'navigation.yml'),
} = {}) {
  root = path.resolve(root)
  docsDirectory = path.resolve(docsDirectory)
  navigationPath = path.resolve(navigationPath)

  const diagnostics = []
  const docsFiles = await listMarkdownFiles(docsDirectory)
  const topLevelPages = docsFiles.filter((file) => path.dirname(file) === docsDirectory)
  const navigationDisplayPath = displayPath(root, navigationPath)
  const navigationSource = await readFile(navigationPath, 'utf8')
  const navigationEntries = extractNavigationUrls(navigationSource, navigationDisplayPath)
  let baseUrl = ''
  try {
    baseUrl = readBaseUrl(await readFile(path.join(docsDirectory, '_config.yml'), 'utf8'))
  } catch {
    // A fixture or non-Jekyll docs tree does not need a config file.
  }

  const inspectPath = createExactPathInspector(root)
  const anchorCache = new Map()
  const anchorsFor = async (file) => {
    const absolute = path.resolve(file)
    if (!anchorCache.has(absolute)) {
      anchorCache.set(absolute, extractMarkdownAnchors(await readFile(absolute, 'utf8')))
    }
    return anchorCache.get(absolute)
  }
  const navigationPages = new Set()

  for (const entry of navigationEntries) {
    if (isSkippedDestination(entry.url)) {
      continue
    }
    const { fragment, pathname } = splitDestination(entry.url)
    const resolution = await resolveDestination(
      {
        baseUrl,
        destinationPath: pathname || '/',
        docsDirectory,
        sourceFile: path.join(docsDirectory, 'index.md'),
      },
      inspectPath,
    )
    const prefix = `${entry.file}:${entry.line}: navigation URL "${entry.url}"`

    if (resolution.invalidEncoding) {
      diagnostics.push(`${prefix} has invalid percent encoding`)
      continue
    }
    if (resolution.invalidBackslash) {
      diagnostics.push(`${prefix} uses a backslash; URLs must use forward slashes`)
      continue
    }
    if (resolution.outsideRoot) {
      diagnostics.push(`${prefix} resolves outside the repository`)
      continue
    }
    if (!resolution.exists) {
      diagnostics.push(`${prefix} does not exist (resolved to ${describeTarget(root, resolution.path)})`)
      continue
    }
    if (
      resolution.type !== 'file' ||
      !isInside(docsDirectory, resolution.path) ||
      path.extname(resolution.path).toLowerCase() !== '.md'
    ) {
      diagnostics.push(`${prefix} must resolve to a Markdown page under docs/`)
      continue
    }

    navigationPages.add(path.resolve(resolution.path))
    if (fragment) {
      const decodedFragment = decodeUrlPart(fragment)
      if (decodedFragment === null) {
        diagnostics.push(`${prefix} has invalid fragment percent encoding`)
      } else if (!(await anchorsFor(resolution.path)).has(decodedFragment)) {
        diagnostics.push(
          `${prefix} references missing anchor "#${decodedFragment}" in ${displayPath(root, resolution.path)}`,
        )
      }
    }
  }

  for (const page of topLevelPages) {
    if (!navigationPages.has(path.resolve(page))) {
      diagnostics.push(
        `${displayPath(root, page)}:1: page is missing from ${navigationDisplayPath} (anchor variants count as one page)`,
      )
    }
  }

  for (const file of docsFiles) {
    const source = await readFile(file, 'utf8')
    const sourceDisplayPath = displayPath(root, file)
    diagnostics.push(...validateMarkdownStructure(source, sourceDisplayPath))
    diagnostics.push(...validateFencedCodeBlocks(source, sourceDisplayPath))
    for (const target of extractMarkdownTargets(source, sourceDisplayPath)) {
      const destination = target.destination.trim()
      if (isSkippedDestination(destination)) {
        continue
      }
      const { fragment, pathname } = splitDestination(destination)
      const resolution = await resolveDestination(
        {
          baseUrl,
          destinationPath: pathname,
          docsDirectory,
          sourceFile: file,
        },
        inspectPath,
      )
      const prefix = `${target.file}:${target.line}: ${target.kind} "${destination}"`

      if (resolution.invalidEncoding) {
        diagnostics.push(`${prefix} has invalid percent encoding`)
        continue
      }
      if (resolution.invalidBackslash) {
        diagnostics.push(`${prefix} uses a backslash; URLs must use forward slashes`)
        continue
      }
      if (resolution.outsideRoot) {
        diagnostics.push(`${prefix} resolves outside the repository`)
        continue
      }
      if (!resolution.exists) {
        diagnostics.push(`${prefix} does not exist (resolved to ${describeTarget(root, resolution.path)})`)
        continue
      }

      if (
        target.kind === 'link' &&
        fragment &&
        resolution.type === 'file' &&
        path.extname(resolution.path).toLowerCase() === '.md'
      ) {
        const decodedFragment = decodeUrlPart(fragment)
        if (decodedFragment === null) {
          diagnostics.push(`${prefix} has invalid fragment percent encoding`)
        } else if (!(await anchorsFor(resolution.path)).has(decodedFragment)) {
          diagnostics.push(
            `${prefix} references missing anchor "#${decodedFragment}" in ${displayPath(root, resolution.path)}`,
          )
        }
      }
    }
  }

  return [...new Set(diagnostics)].sort((left, right) => left.localeCompare(right))
}

export async function assertDocsLinks(options) {
  const diagnostics = await validateDocsLinks(options)
  if (diagnostics.length > 0) {
    throw new Error(`Documentation integrity check found ${diagnostics.length} error(s):\n${diagnostics.join('\n')}`)
  }
  return diagnostics
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await assertDocsLinks()
    console.log('Documentation structure, navigation, links, images, and anchors are valid.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
