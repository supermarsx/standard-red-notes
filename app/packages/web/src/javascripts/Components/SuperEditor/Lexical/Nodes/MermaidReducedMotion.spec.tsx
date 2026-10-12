/**
 * @jest-environment jsdom
 *
 * "node scattered really badly" — "only sequence diagram look fine, anything
 * else looks wrong" — in Firefox, with reduced motion on.
 *
 * The global reduced-motion clamp in stylesheets/_animation.scss leaves every
 * element with a 0.001ms transition on `all`, and a transition makes a
 * same-task read return the OLD value. Mermaid lays a diagram out from such
 * reads. Measured in stock Firefox 157 with `ui.prefersReducedMotion = 1`, same
 * build, same note, same 1600x1100 window:
 *
 *   the user's flowchart   viewBox 3199 x 4285   edge ends up to 991 units from a node
 *   with the exception     viewBox  260 x  362   edge ends 4 units from a node (mermaid's own inset)
 *
 * and by hand in the running app, with each selector alone and then together:
 *
 *   no exception           node box 2000 x 2000, label measured 57.55 x 22.5 (15px)
 *   `<svg>` only           node box 2000 x 2000, label measured 57.55 x 22.5 (15px)
 *   descendants only       node box right,       label measured 57.55 x 22.5 (15px)
 *   `<svg>` + descendants  node box right,       label measured 61.35 x 24   (16px)
 *
 * and under `document.body`, where a rule keyed on the block's measuring host
 * cannot reach: node box 2000 x 2000 with such a rule, right with this one.
 *
 * jsdom has no layout engine and no transitions, so nothing here can observe
 * that. What it pins instead is what DECIDES it: that the exception exists
 * beside the clamp, that it says `transition-property: none !important`, and
 * that both of its selectors really match the elements mermaid measures — built
 * with the id the real MermaidNode handed to `mermaid.render`, in both places
 * mermaid can build them. The numbers above are the browser's.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $getRoot } from 'lexical'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, MermaidNode } from './MermaidNode'
import { MERMAID_RENDER_ID_PREFIX } from './MermaidSettings'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** Every id the real component handed to `mermaid.render`, in call order. */
const renderedIds: string[] = []

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    mermaidAPI: { reset: () => undefined },
    initialize: () => undefined,
    render: async (id: string) => {
      renderedIds.push(id)
      return {
        svg: `<svg id="${id}" width="100%" viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg"><g></g></svg>`,
      }
    },
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

type CssRule = { selectors: string[]; declarations: Map<string, string> }

/**
 * The stylesheet with its comments removed. The comments in that file quote the
 * very selectors and declarations they explain, so matching the raw text would
 * find the prose and report a rule that is not there.
 */
const stylesheetWithoutComments = (): string =>
  readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'stylesheets', '_animation.scss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** The index just past the `}` that closes the block opened at `openBrace`. */
const endOfBlock = (source: string, openBrace: number): number => {
  let depth = 0
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === '{') {
      depth++
    } else if (source[index] === '}') {
      depth--
      if (depth === 0) {
        return index + 1
      }
    }
  }
  throw new Error('unbalanced braces in _animation.scss')
}

/** The flat rules directly inside every `@media (prefers-reduced-motion: reduce)` block. */
const reducedMotionRules = (): CssRule[] => {
  const source = stylesheetWithoutComments()
  const rules: CssRule[] = []
  const media = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g
  for (let match = media.exec(source); match !== null; match = media.exec(source)) {
    const open = match.index + match[0].length - 1
    const body = source.slice(open + 1, endOfBlock(source, open) - 1)
    const rule = /([^{}]+)\{([^{}]*)\}/g
    for (let found = rule.exec(body); found !== null; found = rule.exec(body)) {
      const declarations = new Map<string, string>()
      for (const declaration of found[2].split(';')) {
        const colon = declaration.indexOf(':')
        if (colon > 0) {
          declarations.set(
            declaration.slice(0, colon).trim(),
            declaration
              .slice(colon + 1)
              .trim()
              .replace(/\s+/g, ' '),
          )
        }
      }
      rules.push({
        selectors: found[1]
          .split(',')
          .map((selector) => selector.trim().replace(/\s+/g, ' '))
          .filter((selector) => selector.length > 0),
        declarations,
      })
    }
  }
  return rules
}

/** The rules that switch transitions OFF, as opposed to shortening them. */
const exceptionRules = (): CssRule[] =>
  reducedMotionRules().filter((rule) => rule.declarations.get('transition-property') === 'none !important')

const matchesAny = (element: Element, rules: CssRule[]): boolean =>
  rules.some((rule) => rule.selectors.some((selector) => element.matches(selector)))

/**
 * What mermaid builds to measure one HTML label, as `appendDivSvgG`,
 * `labelHelper` and `addHtmlSpan` build it: a wrapper `div`, the `<svg>`
 * carrying the caller's id, and inside it the node group, its label group, the
 * `foreignObject` that is created oversized and then shrunk, and the label.
 */
const buildMeasuringTree = (parent: Element, id: string) => {
  const wrapper = document.createElement('div')
  wrapper.id = `d${id}`
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.id = id
  const node = document.createElementNS(SVG_NS, 'g')
  node.setAttribute('class', 'node default')
  const label = document.createElementNS(SVG_NS, 'g')
  label.setAttribute('class', 'label')
  const foreignObject = document.createElementNS(SVG_NS, 'foreignObject')
  const text = document.createElementNS(XHTML_NS, 'div')
  foreignObject.appendChild(text)
  label.appendChild(foreignObject)
  node.appendChild(label)
  svg.appendChild(node)
  wrapper.appendChild(svg)
  parent.appendChild(wrapper)
  return { wrapper, svg, node, label, foreignObject, text }
}

let container: HTMLElement
let root: Root | undefined
/** The id the real, mounted MermaidNode handed to `mermaid.render`. */
let id: string

/** Mount a real MermaidNode and return the id it gave mermaid. */
const idTheRealNodeHandsMermaid = async (): Promise<string> => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: 'mermaid-reduced-motion',
            nodes: [MermaidNode],
            // Seeded as the editor's initial state, so the node exists before
            // the first render and nothing has to update from inside an effect.
            editorState: () => {
              $getRoot().append($createMermaidNode('flowchart TD\n  A[Start] --> B[End]', 'app', 'preview'))
            },
            onError: (error: Error) => {
              throw error
            },
          },
        },
        createElement(RichTextPlugin, {
          contentEditable: createElement(ContentEditable, { 'aria-label': 'editor' }),
          placeholder: null,
          ErrorBoundary: LexicalErrorBoundary,
        }),
      ),
    )
  })
  // Behind the node's own 400ms debounce and a dynamic import, as in the browser.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
  const last = renderedIds[renderedIds.length - 1]
  if (typeof last !== 'string') {
    throw new Error('the mounted MermaidNode never called mermaid.render')
  }
  return last
}

beforeAll(async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  id = await idTheRealNodeHandsMermaid()
})

afterAll(() => {
  if (root) {
    const mounted = root
    act(() => mounted.unmount())
    root = undefined
  }
  container?.remove()
})

afterEach(() => {
  document.body.querySelectorAll('[data-spec-measuring]').forEach((element) => element.remove())
})

describe('what mermaid measures does not transition under reduced motion', () => {
  it('has an exception beside the clamp, and it switches transitions off outright', () => {
    const rules = exceptionRules()
    // Shortening is what the clamp already does, and 0.001ms still returns the
    // old value to a same-task read. Only `none` removes the transition, and
    // only `!important` outranks whatever mermaid's own stylesheet declares.
    expect(rules).toHaveLength(1)
    expect(rules[0].declarations.get('transition-property')).toBe('none !important')
  })

  it('names the id prefix the real MermaidNode gives mermaid', () => {
    expect(id.startsWith(MERMAID_RENDER_ID_PREFIX)).toBe(true)
    expect(exceptionRules().flatMap((rule) => rule.selectors)).toEqual([
      `svg[id^='${MERMAID_RENDER_ID_PREFIX}']`,
      `svg[id^='${MERMAID_RENDER_ID_PREFIX}'] *`,
    ])
  })

  it('covers the resized foreignObject and its groups — the 2000x2000 box', () => {
    const rules = exceptionRules()
    // Inside the block's own measuring host: the path a visible block takes.
    const host = document.createElement('div')
    host.setAttribute('data-mermaid-measure-host', 'true')
    host.setAttribute('data-spec-measuring', 'true')
    document.body.appendChild(host)
    const inHost = buildMeasuringTree(host, id)
    expect(matchesAny(inHost.foreignObject, rules)).toBe(true)
    expect(matchesAny(inHost.label, rules)).toBe(true)
    expect(matchesAny(inHost.node, rules)).toBe(true)
    expect(matchesAny(inHost.text, rules)).toBe(true)
  })

  it('covers the same elements under document.body — the path a block with no layout takes', () => {
    const rules = exceptionRules()
    const underBody = buildMeasuringTree(document.body, id)
    underBody.wrapper.setAttribute('data-spec-measuring', 'true')
    expect(matchesAny(underBody.foreignObject, rules)).toBe(true)
    expect(matchesAny(underBody.label, rules)).toBe(true)
    expect(matchesAny(underBody.node, rules)).toBe(true)
    expect(matchesAny(underBody.text, rules)).toBe(true)
  })

  it('covers the <svg> itself — the font size its labels inherit', () => {
    const rules = exceptionRules()
    const underBody = buildMeasuringTree(document.body, id)
    underBody.wrapper.setAttribute('data-spec-measuring', 'true')
    // Mermaid pins `font-size` on this element with a `<style>` it inserts only
    // AFTER an await. A descendant-only rule leaves that change a transition,
    // and every label then inherits the size the root is still leaving.
    expect(matchesAny(underBody.svg, rules)).toBe(true)
  })

  it('exempts nothing else from the clamp', () => {
    const rules = exceptionRules()
    const tree = buildMeasuringTree(document.body, id)
    tree.wrapper.setAttribute('data-spec-measuring', 'true')
    // The wrapper mermaid puts around its <svg> is not measured and not exempt.
    expect(matchesAny(tree.wrapper, rules)).toBe(false)
    // An icon, a control, and a diagram that is not mermaid's all keep the clamp.
    const others = document.createElement('div')
    others.setAttribute('data-spec-measuring', 'true')
    others.innerHTML =
      '<button class="sn-transition">Save</button>' +
      '<svg class="sn-icon" viewBox="0 0 20 20"><path d="M0 0h20v20z"></path></svg>' +
      '<svg id="timing-diagram-1"><g><rect></rect></g></svg>'
    document.body.appendChild(others)
    for (const element of Array.from(others.querySelectorAll('*'))) {
      expect(matchesAny(element, rules)).toBe(false)
    }
  })
})
