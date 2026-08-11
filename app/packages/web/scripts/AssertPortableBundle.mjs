import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../dist/', import.meta.url))
const allowedFileUrls = new Set(['file:///C:/SheetJS/'])
const rawFileUrlPattern = /file:\/\/\/[^"'`\s)]*/gi
const encodedSchemePattern = /file%3a(?:\/|%2f){3}[^"'`\s)]*/gi
const encodedSlashPattern = /file:(?:\/|%2f){3}[^"'`\s)]*/gi

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

if (leaks.length > 0) {
  throw new Error(`Production bundle is not browser-portable:\n${leaks.slice(0, 20).join('\n')}`)
}

console.log('Production bundle portability valid: no forbidden file URLs or classic-script import.meta.')
