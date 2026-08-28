/**
 * Every `<Icon type="…">` name used in production code must resolve to a real glyph.
 *
 * `Icon` looks `type` up in IconNameToSvgMapping / LexicalIconNameToSvgMapping and,
 * on a miss, falls back to the emoji path — rendering the name itself inside a
 * <label> (Icon.tsx). Because `VectorIconNameOrEmoji` is `EmojiString | IconType`
 * where `EmojiString = Omit<string, IconType>` — i.e. any string — a name that does
 * not exist typechecks cleanly and ships as visible text next to the button label.
 *
 * tsc cannot catch this, and component specs cannot either: the Files/Notes specs
 * all stub Icon to null. It has now shipped three times ("files" on the All-files
 * chip, "unlock" on the Unprotect button, "chat-bubble" on the Comments header), so
 * rather than pin one component this sweeps the whole source tree and asserts every
 * statically-known name resolves.
 *
 * Dynamic `type={expr}` values that are not string literals cannot be checked here;
 * those remain covered only by render specs such as FilesFolderBar.icon.spec.tsx.
 */
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import { IconNameToSvgMapping } from './IconNameToSvgMapping'
import { LexicalIconNameToSvgMapping } from './LexicalIcons'

const JAVASCRIPTS_ROOT = join(__dirname, '..', '..')

const knownIconNames = new Set([...Object.keys(IconNameToSvgMapping), ...Object.keys(LexicalIconNameToSvgMapping)])

const sourceFiles = (dir: string): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (/\.tsx$/.test(entry.name) && !/\.(spec|test)\.tsx$/.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

/** A whole `<Icon …>` opening tag, which may span several lines. */
const ICON_TAG = /<Icon\b[^>]*?\/?>/gs
const TYPE_STRING_LITERAL = /\btype=(?:"([^"]*)"|'([^']*)'|\{'([^']*)'\}|\{"([^"]*)"\})/

type Usage = { name: string; location: string }

const collectLiteralIconTypes = (): Usage[] => {
  const usages: Usage[] = []

  for (const file of sourceFiles(JAVASCRIPTS_ROOT)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('<Icon')) {
      continue
    }

    for (const match of source.matchAll(ICON_TAG)) {
      const literal = match[0].match(TYPE_STRING_LITERAL)
      if (!literal) {
        continue
      }
      const name = literal[1] ?? literal[2] ?? literal[3] ?? literal[4]
      const line = source.slice(0, match.index).split('\n').length
      usages.push({ name, location: `${relative(JAVASCRIPTS_ROOT, file).replace(/\\/g, '/')}:${line}` })
    }
  }

  return usages
}

describe('Icon name coverage', () => {
  const usages = collectLiteralIconTypes()

  it('finds Icon usages to check, so a broken sweep cannot pass vacuously', () => {
    expect(usages.length).toBeGreaterThan(100)
  })

  it('resolves every literal <Icon type="…"> in production code to a real glyph', () => {
    const unresolved = usages
      .filter((usage) => !knownIconNames.has(usage.name))
      .map((usage) => `${usage.location}  type="${usage.name}"`)

    expect(unresolved).toEqual([])
  })
})
