import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

import { BlockEditorNodes } from '../SuperEditor/Lexical/Nodes/AllNodes'
import { SHARE_BLOCKED_NODE_TYPES, redactShareNodes } from './SharedNodePolicy'

/**
 * THE GATE BEHIND THE DENYLIST.
 *
 * `SHARE_BLOCKED_NODE_TYPES` is a list, and a list is not a trust boundary. The
 * boundary is here: every type in the registered node set must be classified,
 * and the classification of "needs an application" is DERIVED from each node
 * module's own import graph rather than asserted. A node added to the editor
 * whose component reaches `useApplication()` turns this red, naming the type —
 * which is exactly the failure that otherwise reaches a reader as a silent
 * "could not be displayed" box.
 */

const NODES_DIR = join(__dirname, '..', 'SuperEditor', 'Lexical', 'Nodes')
const ALL_NODES = join(NODES_DIR, 'AllNodes.ts')

/** Hooks that need a React context the public share page does not provide. */
const APPLICATION_HOOKS = /\buseApplication\b|\busePreference\b|\buseLocalPreference\b|\buseLinkingController\b/

/**
 * A node that only MENTIONS `useApplication` in its own documentation does not
 * call it. `SharedImageNode` exists precisely to avoid the hook and explains so
 * in its header; a naive grep classified it as unsafe for saying so.
 */
const stripComments = (source: string): string =>
  source
    .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])[/][/].*$/, '$1'))
    .join('\n')

const resolveModule = (fromFile: string, specifier: string): string | null => {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

const relativeImports = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((match) => match[1])

/** Every file reachable from `entry` by relative import that calls a hook. */
const hookOffenders = (entry: string): string[] => {
  const seen = new Set<string>()
  const queue = [entry]
  const offenders: string[] = []
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    const source = stripComments(readFileSync(file, 'utf8'))
    if (APPLICATION_HOOKS.test(source)) {
      offenders.push(relative(NODES_DIR, file).replace(/\\/g, '/'))
    }
    for (const specifier of relativeImports(source)) {
      const resolved = resolveModule(file, specifier)
      if (resolved !== null) {
        queue.push(resolved)
      }
    }
  }
  return offenders
}

/** symbol -> module file, for the node classes AllNodes imports from this tree. */
const nodeModules = (): Map<string, string> => {
  const source = readFileSync(ALL_NODES, 'utf8')
  const modules = new Map<string, string>()
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    const file = resolveModule(ALL_NODES, match[2])
    if (file === null) {
      continue
    }
    for (const part of match[1].split(',')) {
      const symbol = part.trim().split(/\s+as\s+/)[0]
      if (symbol.length > 0) {
        modules.set(symbol, file)
      }
    }
  }
  return modules
}

describe('the registered node set, classified for a public share page', () => {
  const modules = nodeModules()

  /**
   * Every registered node CLASS, paired with its own module when it has one.
   *
   * `BlockEditorNodes` is not a flat list of classes: `STYLED_BLOCK_NODE_OVERRIDES`
   * contributes `{ replace, with, withKlass }` replacement configs as well, and
   * reading `.name`/`.getType()` off one of those yields undefined. The
   * replacement classes themselves are listed separately, so the configs are
   * unwrapped to `withKlass` rather than skipped.
   */
  const registered = BlockEditorNodes.map((entry) => {
    const config = entry as unknown as { withKlass?: unknown }
    const klass = (typeof config.withKlass === 'function' ? config.withKlass : entry) as unknown as {
      getType?: () => string
      name?: string
    }
    const name = typeof klass.name === 'string' && klass.name.length > 0 ? klass.name : '(anonymous)'
    const type = typeof klass.getType === 'function' ? klass.getType() : undefined
    return { name, type, file: modules.get(name) }
  })

  it('has a type for every registered node', () => {
    expect(registered.filter((node) => node.type === undefined)).toEqual([])
  })

  it('blocks exactly the node types whose component needs an application', () => {
    // Derived, not declared: whichever node modules actually reach the hook.
    const needsApplication = registered
      .filter((node) => node.file !== undefined && hookOffenders(node.file as string).length > 0)
      .map((node) => node.type as string)
      .sort()

    const blocked = Object.keys(SHARE_BLOCKED_NODE_TYPES).sort()
    const unclassified = needsApplication.filter((type) => !blocked.includes(type))

    // A new node whose component needs an application would otherwise reach a
    // reader as a generic "could not be displayed" box with nothing to act on.
    expect(unclassified).toEqual([])
  })

  it('classifies the five node types this page cannot mount for lack of an application', () => {
    const needsApplication = registered
      .filter((node) => node.file !== undefined && hookOffenders(node.file as string).length > 0)
      .map((node) => node.type as string)
      .sort()

    // Pinned so a node LOSING its application dependency is noticed too — that
    // one is good news and should let the block be removed.
    expect(needsApplication).toEqual(['clock-widget', 'inline-file', 'snbubble', 'snfile', 'unencrypted-image'])
  })

  it('does not block the share image node, which exists to be mountable here', () => {
    expect(SHARE_BLOCKED_NODE_TYPES['shared-image']).toBeUndefined()
    const sharedImage = registered.find((node) => node.type === 'shared-image')
    expect(sharedImage).toBeDefined()
    expect(hookOffenders(sharedImage?.file as string)).toEqual([])
  })

  it('blocks every node type that mounts a third-party iframe with no interaction', () => {
    // Checked by reading each component: these four insert an <iframe> at an
    // external origin as soon as they render, so merely opening a share link
    // would tell that origin who the reader is.
    for (const type of ['youtube', 'embed', 'tradingview', 'stock-chart']) {
      expect(SHARE_BLOCKED_NODE_TYPES[type]?.reason).toBe('remote-subresource')
    }
  })

  it('every blocked type is a type the registry actually has', () => {
    // A stale entry here is a rule that can never fire.
    const types = new Set(registered.map((node) => node.type))
    expect(Object.keys(SHARE_BLOCKED_NODE_TYPES).filter((type) => !types.has(type))).toEqual([])
  })

  it('gives every blocked type a sentence a reader can act on', () => {
    for (const blocked of Object.values(SHARE_BLOCKED_NODE_TYPES)) {
      // A bracketed sentence, long enough to say what is missing and why —
      // not a slug, and not the node type spelled at the reader.
      expect(blocked.message).toMatch(/^\[.+\]$/)
      expect(blocked.message.split(' ').length).toBeGreaterThan(8)
    }
  })
})

describe('redactShareNodes', () => {
  const stateWith = (children: unknown[]) =>
    JSON.stringify({
      root: { children, direction: null, format: '', indent: 0, type: 'root', version: 1 },
    })

  const paragraph = (text: string) => ({
    children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
    direction: null,
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  })

  it('replaces a YouTube embed with a visible sentence and no url', () => {
    const result = redactShareNodes(
      stateWith([paragraph('BEFORE'), { type: 'youtube', videoID: 'dQw4w9WgXcQ', version: 1 }, paragraph('AFTER')]),
    )
    expect(result.redacted).toEqual([{ type: 'youtube', reason: 'remote-subresource' }])
    expect(result.text).not.toContain('dQw4w9WgXcQ')
    expect(result.text).toContain('YouTube video')
    expect(result.text).toContain('BEFORE')
    expect(result.text).toContain('AFTER')
  })

  it('redacts a blocked node nested inside another block', () => {
    const result = redactShareNodes(
      stateWith([
        {
          children: [{ type: 'snfile', fileUuid: 'deadbeef', version: 1 }],
          direction: null,
          format: '',
          indent: 0,
          type: 'collapsible-content',
          version: 1,
        },
      ]),
    )
    expect(result.redacted).toEqual([{ type: 'snfile', reason: 'needs-application' }])
    expect(result.text).not.toContain('deadbeef')
  })

  it('reports every redaction, so nothing is removed without an account of it', () => {
    const result = redactShareNodes(
      stateWith([
        { type: 'youtube', videoID: 'a', version: 1 },
        { type: 'tradingview', version: 1 },
        { type: 'snbubble', version: 1 },
      ]),
    )
    expect(result.redacted.map((entry) => entry.type)).toEqual(['youtube', 'tradingview', 'snbubble'])
  })

  it('returns the original string untouched when nothing is blocked', () => {
    const original = stateWith([paragraph('ONLY TEXT')])
    const result = redactShareNodes(original)
    expect(result.text).toBe(original)
    expect(result.redacted).toEqual([])
  })

  it('leaves non-JSON text alone rather than throwing', () => {
    expect(redactShareNodes('# a markdown note')).toEqual({ text: '# a markdown note', redacted: [] })
    expect(redactShareNodes('')).toEqual({ text: '', redacted: [] })
  })
})
