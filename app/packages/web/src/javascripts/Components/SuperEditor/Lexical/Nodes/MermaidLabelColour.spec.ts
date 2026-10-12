/**
 * @jest-environment jsdom
 *
 * A diagram's label is the colour its THEME gave it, not the colour of the
 * note's body text.
 *
 * Mermaid colours an HTML label on its `<span class="nodeLabel">` and leaves the
 * `<p>` inside to inherit. This app colours paragraphs by element, and a rule
 * that names an element beats a value it would only have inherited. Measured in
 * the running app's dark theme (stock Firefox 157, a block pinned to Forest):
 *
 *   mermaid's own stylesheet   .label { color: #000000 }
 *   the <span>                 rgb(0, 0, 0)
 *   the <p> inside it          rgb(234, 221, 224) — on Forest's light green, 1.05 to 1
 *
 * jsdom does not implement the cascade, so nothing here reads a computed
 * colour. What it pins is what DECIDES that colour: the three stylesheets are
 * compiled with the real sass, every rule that sets `color` on the label's
 * `<p>` is collected by running its own selector against the label's own DOM,
 * and the winner is picked the way a browser picks it — by specificity. The
 * computed values above are the browser's.
 */
import * as path from 'path'
import * as sass from 'sass'

const SOURCES = {
  // `#blocks-editor p { color }` — the rule with an id in it.
  editorParagraphs: path.resolve(__dirname, '..', 'Theme', 'custom.scss'),
  // The mermaid rules, including the one under test.
  editor: path.resolve(__dirname, '..', 'Theme', 'editor.scss'),
  // `p { color }` — every paragraph in the application.
  application: path.resolve(__dirname, '..', '..', '..', '..', '..', 'stylesheets', '_main.scss'),
}

type ColourRule = { source: string; selector: string; value: string; specificity: [number, number, number] }

/**
 * The compiled CSS with its comments removed. The comment above the rule under
 * test quotes the very selectors and declarations it explains, so matching the
 * raw text would find the prose and report rules that are not there.
 */
const compile = (file: string): string =>
  sass.compile(file, { style: 'expanded', logger: sass.Logger.silent }).css.replace(/\/\*[\s\S]*?\*\//g, '')

/** `[ids, classes + attributes + pseudo-classes, elements]`, for the selectors these sheets use. */
const specificityOf = (selector: string): [number, number, number] => {
  const withoutAttributes = selector.replace(/\[[^\]]*\]/g, ' [] ')
  const ids = (withoutAttributes.match(/#[\w-]+/g) ?? []).length
  const classes =
    (withoutAttributes.match(/\.[\w-]+/g) ?? []).length +
    (withoutAttributes.match(/\[\]/g) ?? []).length +
    (withoutAttributes.match(/(?<!:):[\w-]+/g) ?? []).length
  const elements = (
    withoutAttributes
      .replace(/#[\w-]+|\.[\w-]+|::?[\w-]+(\([^)]*\))?|\[\]/g, ' ')
      .match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []
  ).length
  return [ids, classes, elements]
}

/** Every TOP-LEVEL rule that declares `color`. Rules inside `@media` (print) are not in play on screen. */
const colourRules = (source: string, css: string): ColourRule[] => {
  const rules: ColourRule[] = []
  let index = 0
  while (index < css.length) {
    const open = css.indexOf('{', index)
    if (open === -1) {
      break
    }
    let depth = 0
    let close = open
    for (; close < css.length; close++) {
      if (css[close] === '{') {
        depth++
      } else if (css[close] === '}') {
        depth--
        if (depth === 0) {
          break
        }
      }
    }
    const prelude = css.slice(index, open).trim()
    const body = css.slice(open + 1, close)
    index = close + 1
    if (prelude.startsWith('@')) {
      continue
    }
    const declaration = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(body)
    if (!declaration) {
      continue
    }
    for (const selector of prelude.split(',').map((part) => part.trim().replace(/\s+/g, ' '))) {
      rules.push({ source, selector, value: declaration[1].trim(), specificity: specificityOf(selector) })
    }
  }
  return rules
}

const compare = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

let allRules: ColourRule[] = []

beforeAll(() => {
  allRules = Object.entries(SOURCES).flatMap(([source, file]) => colourRules(source, compile(file)))
})

afterEach(() => {
  document.body.innerHTML = ''
})

/** A label exactly as mermaid 11.17.2 writes one, mounted where the viewport mounts it. */
const mountLabel = (wrapInEditor: boolean): { label: Element; span: Element; noteParagraph: Element } => {
  const diagram =
    '<div data-mermaid-block="true"><div data-mermaid-viewport="true"><div data-mermaid-svg-host="true">' +
    '<svg id="mermaid-7-0" class="flowchart" xmlns="http://www.w3.org/2000/svg"><g class="node default"><g class="label">' +
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Alpha</p></span></div></foreignObject>' +
    '</g></g></svg></div></div></div>'
  document.body.innerHTML = wrapInEditor
    ? `<div id="blocks-editor"><div class="editor"><div class="ContentEditable__root"><p id="note-paragraph">Body text</p>${diagram}</div></div></div>`
    : `<p id="note-paragraph">Body text</p>${diagram}`
  const label = document.querySelector('span.nodeLabel > p')
  const span = document.querySelector('span.nodeLabel')
  const noteParagraph = document.getElementById('note-paragraph')
  if (!label || !span || !noteParagraph) {
    throw new Error('the label fixture did not mount')
  }
  return { label, span, noteParagraph }
}

/**
 * The rules that set this element's colour, strongest first. A selector with a
 * pseudo-ELEMENT (`::selection`) styles a fragment of an element, never the
 * element, so it is skipped rather than handed to jsdom, which refuses it. Any
 * other selector jsdom cannot evaluate is an error, not a non-match.
 */
const rulesFor = (element: Element): ColourRule[] =>
  allRules
    .filter((rule) => !rule.selector.includes('::') && element.matches(rule.selector))
    .sort((a, b) => compare(b.specificity, a.specificity))

describe('the colour of a mermaid label', () => {
  it('is contested: the app really does colour a label’s <p> by element', () => {
    const { label } = mountLabel(true)
    const contenders = rulesFor(label).map((rule) => `${rule.source}: ${rule.selector}`)
    // If either of these stops matching, the exception below has nothing left to
    // outrank and this whole spec is describing a cascade that no longer exists.
    expect(contenders).toContain('editorParagraphs: #blocks-editor p')
    expect(contenders).toContain('application: p')
  })

  it('inherits inside the editor — outranking the rule that has an id in it', () => {
    const { label } = mountLabel(true)
    const [winner, runnerUp] = rulesFor(label)
    expect(winner.value).toBe('inherit')
    expect(winner.source).toBe('editor')
    // Strictly: a tie would be settled by which stylesheet happens to load
    // last, and that is not something a spec here can see.
    expect(compare(winner.specificity, runnerUp.specificity)).toBeGreaterThan(0)
    expect(runnerUp.selector).toBe('#blocks-editor p')
  })

  it('inherits outside the editor wrapper too — wherever the diagram is mounted', () => {
    const { label } = mountLabel(false)
    const [winner, runnerUp] = rulesFor(label)
    expect(winner.value).toBe('inherit')
    expect(compare(winner.specificity, runnerUp.specificity)).toBeGreaterThan(0)
    expect(runnerUp.selector).toBe('p')
  })

  it('leaves the <span> mermaid colours alone — nothing of the app’s names it', () => {
    const { span } = mountLabel(true)
    // What the <p> inherits FROM. A rule colouring this element would put the
    // app's colour back one level up.
    expect(rulesFor(span)).toEqual([])
  })

  it('changes no other paragraph in the note', () => {
    const { noteParagraph } = mountLabel(true)
    const [winner] = rulesFor(noteParagraph)
    expect(winner.selector).toBe('#blocks-editor p')
    expect(winner.value).toBe('var(--sn-stylekit-editor-foreground-color)')
  })

  it('counts specificity the way the cascade does', () => {
    expect(specificityOf('p')).toEqual([0, 0, 1])
    expect(specificityOf('#blocks-editor p')).toEqual([1, 0, 1])
    expect(specificityOf("[data-mermaid-svg-host='true'] p")).toEqual([0, 1, 1])
    expect(specificityOf("#blocks-editor [data-mermaid-svg-host='true'] p")).toEqual([1, 1, 1])
    expect(specificityOf('.ContentEditable__root > p.a:hover')).toEqual([0, 3, 1])
  })
})
