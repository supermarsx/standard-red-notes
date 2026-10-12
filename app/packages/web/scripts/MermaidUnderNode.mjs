// The installed mermaid under plain Node, for scripts that have to ask the real
// library something: jsdom's globals (mermaid reads `window` while it loads),
// then the package itself, plus a resolver hook so the app's own `.ts` sources
// can be imported as they are through Node's type stripping.
//
// `MermaidContract.mjs` carries its own copy of this bootstrap; this module is
// the same recipe for the scripts that came after it. Nothing here draws:
// jsdom has no layout, so `mermaid.render` is only usable with the geometry
// stand-ins `installLayoutStandIns` provides, and what comes out of it is
// evidence about the STRUCTURE of the SVG (ids, classes, data attributes),
// never about where anything is.
import { createRequire, registerHooks } from 'node:module'

const require = createRequire(import.meta.url)

if (process.features.typescript !== 'strip' && process.features.typescript !== 'transform') {
  console.error(`This script needs a Node that strips TypeScript types; this is ${process.version}.`)
  process.exit(2)
}

// The app's sources import each other without an extension, as a bundler
// allows and Node does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    if (isRelative && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

// jsdom's globals BEFORE mermaid is imported.
const { JSDOM } = require('jsdom')
export const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
for (const name of [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'SVGElement',
  'Node',
  'DOMParser',
  'getComputedStyle',
  'CSSStyleSheet',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  if (!(name in globalThis) || name === 'navigator') {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
  }
}

export const mermaid = (await import('mermaid')).default
export const api = mermaid.mermaidAPI
export const mermaidVersion = require('mermaid/package.json').version

/** The directory the app's Mermaid sources live in, relative to this file. */
export const NODES = '../src/javascripts/Components/SuperEditor/Lexical/Nodes'

/**
 * Mermaid's own flowchart parser object: the generated jison parser, with its
 * lexer. Reached the only way the public API allows — through a parsed diagram.
 */
export async function flowParser() {
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
  const diagram = await api.getDiagramFromText('flowchart LR\n  A --> B')
  const parser = diagram?.parser?.parser
  if (!parser?.lexer?.rules || !parser.table || !parser.productions_ || !parser.symbols_) {
    throw new Error('mermaid no longer exposes its flowchart parser as diagram.parser.parser')
  }
  return parser
}

/**
 * Geometry stand-ins, so that `mermaid.render` runs to the end under jsdom.
 * Every box is the same size and every text the same length: the layout that
 * results is meaningless, the element tree is real.
 */
export function installLayoutStandIns() {
  const box = { x: 0, y: 0, width: 80, height: 24, top: 0, left: 0, right: 80, bottom: 24 }
  const prototypes = [dom.window.SVGElement.prototype, dom.window.HTMLElement.prototype, dom.window.Element.prototype]
  for (const prototype of prototypes) {
    if (!prototype.getBBox) {
      prototype.getBBox = () => ({ ...box })
    }
    if (!prototype.getComputedTextLength) {
      prototype.getComputedTextLength = () => 40
    }
    if (!prototype.getTotalLength) {
      prototype.getTotalLength = () => 100
    }
    if (!prototype.getPointAtLength) {
      prototype.getPointAtLength = () => ({ x: 0, y: 0 })
    }
  }
  dom.window.Element.prototype.getBoundingClientRect = () => ({ ...box, toJSON: () => box })
}
