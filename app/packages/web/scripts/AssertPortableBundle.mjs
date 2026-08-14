import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const bundleDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../dist/', import.meta.url))
const allowedFileUrls = new Set(['file:///C:/SheetJS/'])
const rawFileUrlPattern = /file:\/\/\/[^"'`\s)]*/gi
const encodedSchemePattern = /file%3a(?:\/|%2f){3}[^"'`\s)]*/gi
const encodedSlashPattern = /file:(?:\/|%2f){3}[^"'`\s)]*/gi
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf])
const requiredStandardRedTokens = [
  ['--sn-stylekit-theme-name', 'sn-standard-red'],
  ['--sn-stylekit-theme-type', 'dark'],
  ['--sn-stylekit-background-color', '#16090f'],
  ['--sn-stylekit-foreground-color', '#eadde0'],
  ['--sn-stylekit-info-color', '#e85f6d'],
]

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return javascriptFiles(entryPath)
      }
      return /\.(?:m?js)$/.test(entry.name) ? [entryPath] : []
    }),
  )
  return nested.flat()
}

async function stylesheetFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return stylesheetFiles(entryPath)
      }
      return path.extname(entry.name).toLowerCase() === '.css' ? [entryPath] : []
    }),
  )
  return nested.flat()
}

function declarationFor(rule, name) {
  let declaration

  for (const node of rule.nodes ?? []) {
    if (node.type !== 'decl' || node.prop !== name) {
      continue
    }

    if (!declaration?.important || node.important) {
      declaration = { value: node.value.trim(), important: node.important }
    }
  }

  return declaration
}

const leaks = []
for (const file of await javascriptFiles(bundleDirectory)) {
  const source = await readFile(file, 'utf8')
  const relativePath = path.relative(bundleDirectory, file)

  for (const match of source.matchAll(rawFileUrlPattern)) {
    if (!allowedFileUrls.has(match[0])) {
      leaks.push(`${relativePath}: forbidden file URL ${match[0]}`)
    }
  }
  for (const match of source.matchAll(encodedSchemePattern)) {
    leaks.push(`${relativePath}: percent-encoded file URL ${match[0]}`)
  }
  for (const match of source.matchAll(encodedSlashPattern)) {
    if (/%(?:3a|2f)/i.test(match[0])) {
      leaks.push(`${relativePath}: percent-encoded file URL ${match[0]}`)
    }
  }

  if (path.extname(file).toLowerCase() === '.js') {
    for (const match of source.matchAll(/\bimport\.meta\b/g)) {
      leaks.push(`${relativePath}: raw import.meta at byte ${match.index}`)
    }
  }
}

for (const file of await stylesheetFiles(bundleDirectory)) {
  const source = await readFile(file)
  const relativePath = path.relative(bundleDirectory, file)

  for (let offset = source.indexOf(utf8Bom); offset !== -1; offset = source.indexOf(utf8Bom, offset + 1)) {
    if (offset !== 0) {
      leaks.push(`${relativePath}: UTF-8 BOM in the middle of the stylesheet at byte ${offset}`)
    }
  }
}

const appStylesheetPath = path.join(bundleDirectory, 'app.css')
const appStylesheet = (await readFile(appStylesheetPath, 'utf8')).replace(/^\uFEFF/, '')
const parsedStylesheet = postcss.parse(appStylesheet, { from: appStylesheetPath })
const rootRules = parsedStylesheet.nodes.filter((node) => node.type === 'rule' && node.selectors.includes(':root'))
const standardRedRoot = rootRules.find(
  (rule) => declarationFor(rule, '--sn-stylekit-theme-name')?.value.toLowerCase() === 'sn-standard-red',
)

if (!standardRedRoot) {
  leaks.push('app.css: missing a valid Standard Red :root rule')
} else {
  for (const [name, expectedValue] of requiredStandardRedTokens) {
    const actualValue = declarationFor(standardRedRoot, name)?.value
    if (actualValue?.toLowerCase() !== expectedValue) {
      leaks.push(`app.css: Standard Red root token ${name} must be ${expectedValue}, found ${actualValue ?? 'missing'}`)
    }
  }
}

const effectiveRootTokens = new Map()
for (const rule of rootRules) {
  for (const [name] of requiredStandardRedTokens) {
    const declaration = declarationFor(rule, name)
    const effectiveDeclaration = effectiveRootTokens.get(name)
    if (declaration && (!effectiveDeclaration?.important || declaration.important)) {
      effectiveRootTokens.set(name, declaration)
    }
  }
}

for (const [name, expectedValue] of requiredStandardRedTokens) {
  const actualValue = effectiveRootTokens.get(name)?.value
  if (actualValue?.toLowerCase() !== expectedValue) {
    leaks.push(`app.css: effective root token ${name} must remain ${expectedValue}, found ${actualValue ?? 'missing'}`)
  }
}

if (leaks.length > 0) {
  throw new Error(`Production bundle validation failed:\n${leaks.slice(0, 20).join('\n')}`)
}

console.log(
  'Production bundle valid: no forbidden file URLs, classic-script import.meta, mid-file CSS BOM, or missing Standard Red root tokens.',
)
