// The REAL mermaid, asked what a diagram's own configuration means.
//
// MermaidSourceConfig.ts reads a diagram's frontmatter and init directives with
// a small reader of its own, because the toolbar needs "what is this diagram
// set to" synchronously, and it WRITES options into that frontmatter. Both are
// claims about what mermaid will do with a text, and a jest spec cannot check
// either: jest here does not transform ESM in node_modules, so every spec fakes
// the library. This script does not. It loads the installed mermaid under Node
// with jsdom's globals and drives the app's own sources against it.
//
// What it is evidence of: what configuration mermaid takes from a text, and
// that a patched text is read back with the value that was written.
// What it is NOT evidence of: anything drawn. Whether `nodeSpacing: 30` moves a
// box is a question for a browser.
//
// Sibling of MermaidContract.mjs, and run the same way: MermaidConfigContract
// .spec.ts starts it as a child process inside the existing jest gate and reads
// its exit code and the JSON summary on its last line. By hand:
// `node scripts/MermaidConfigContract.mjs` from app/packages/web.
import { createRequire, registerHooks } from 'node:module'

const require = createRequire(import.meta.url)

if (process.features.typescript !== 'strip' && process.features.typescript !== 'transform') {
  console.error(`MermaidConfigContract needs a Node that strips TypeScript types; this is ${process.version}.`)
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

// jsdom's globals BEFORE mermaid is imported: it reads `window` at load.
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
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

const NODES = '../src/javascripts/Components/SuperEditor/Lexical/Nodes'
const mermaid = (await import('mermaid')).default
const SourceConfig = await import(`${NODES}/MermaidSourceConfig.ts`)
const Runtime = await import(`${NODES}/MermaidRuntime.ts`)
const api = mermaid.mermaidAPI
const mermaidVersion = require('mermaid/package.json').version

const checks = []
const counts = {}
const check = async (name, body) => {
  try {
    const detail = await body()
    checks.push({ name, ok: true, detail: detail ?? '' })
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error?.message ?? error) })
  }
}
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const lines = (...parts) => parts.join('\n')
const FLOW = lines('flowchart LR', '  A[Alpha] -->|feeds| B[Beta]')
const SEQUENCE = lines('sequenceDiagram', '  Alice->>Bob: Hello', '  Bob-->>Alice: Hi')
const BACKSLASH = String.fromCharCode(92)
const TAB = String.fromCharCode(9)

/**
 * What mermaid takes from a text, asked the way the app asks: configured as
 * the app configures it, and given the text the app gives it, which is the
 * trimmed one. `null` when mermaid rejects the text outright.
 */
const mermaidReads = async (text) => {
  api.reset()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    secure: [...Runtime.MERMAID_APP_SECURE_KEYS],
    theme: 'base',
  })
  try {
    return (await mermaid.parse(text.trim())).config ?? {}
  } catch {
    return null
  }
}
const at = (config, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), config)

// ===========================================================================
// 1. The small reader and mermaid read every text the same way.
// ===========================================================================

/** The keys asked about for every text. Wider than what the panel manages. */
const PROBED = [
  ['theme'],
  ['look'],
  ['handDrawnSeed'],
  ['fontSize'],
  ['themeVariables', 'fontSize'],
  ['themeVariables', 'primaryColor'],
  ['flowchart', 'curve'],
  ['flowchart', 'nodeSpacing'],
  ['sequence', 'actorMargin'],
  ['sequence', 'showSequenceNumbers'],
]

const fm = (yaml, body = FLOW) => `---\n${yaml}\n---\n${body}`

/**
 * `sure` — the reader must answer for every probed key (no `unknown`): these
 * are the forms it exists to read, and a reader that shrugs at all of them
 * would agree with mermaid about nothing.
 * `unsure` — the reader must say `unknown` for at least one probed key: these
 * are the forms it must NOT pretend to read.
 * Neither — whatever it says must still not contradict mermaid.
 */
const READING_CORPUS = [
  { name: 'no configuration at all', text: FLOW, sure: true },
  { name: 'a link of three hyphens is not a frontmatter', text: lines('graph TD', '  A --- B'), sure: true },
  { name: 'a bare theme', text: fm('config:\n  theme: forest'), sure: true },
  { name: 'a double-quoted theme', text: fm('config:\n  theme: "neo-dark"'), sure: true },
  { name: 'a single-quoted theme', text: fm("config:\n  theme: 'redux-color'"), sure: true },
  {
    name: 'a single quote doubled inside single quotes',
    text: fm("title: 'it''s'\nconfig:\n  theme: dark"),
    sure: true,
  },
  {
    name: 'nested options, numbers and booleans',
    text: fm(
      'config:\n  look: handDrawn\n  handDrawnSeed: 7\n  themeVariables:\n    fontSize: "20px"\n    primaryColor: "#ffcc00"\n  flowchart:\n    curve: linear\n    nodeSpacing: 30\n  sequence:\n    actorMargin: 80\n    showSequenceNumbers: true',
    ),
    sure: true,
  },
  { name: 'a bare font size with a unit', text: fm('config:\n  themeVariables:\n    fontSize: 20px'), sure: true },
  { name: 'a negative and a decimal number', text: fm('config:\n  handDrawnSeed: -3\n  fontSize: 12.5'), sure: true },
  { name: 'an exponent', text: fm('config:\n  handDrawnSeed: 1e2'), sure: true },
  {
    name: 'a title and a display mode beside config',
    text: fm('title: Plan\ndisplayMode: compact\nconfig:\n  theme: dark'),
    sure: true,
  },
  { name: 'config before the title', text: fm('config:\n  theme: dark\ntitle: Plan'), sure: true },
  { name: 'blank lines inside the frontmatter', text: fm('\nconfig:\n\n  theme: neutral\n\n'), sure: true },
  {
    name: 'spaces after the fences and the values',
    text: `---  \nconfig:  \n  theme:   forest   \n---   \n${FLOW}`,
    sure: true,
  },
  { name: 'a space before the colon', text: fm('config :\n  theme : forest'), sure: true },
  { name: 'Windows line endings', text: fm('config:\n  theme: forest').split('\n').join('\r\n'), sure: true },
  { name: 'old Mac line endings', text: fm('config:\n  theme: forest').split('\n').join('\r'), sure: true },
  { name: 'blank lines before the frontmatter', text: `\n\n${fm('config:\n  theme: forest')}`, sure: true },
  {
    name: 'four-space indentation',
    text: fm('config:\n    theme: forest\n    flowchart:\n        curve: step'),
    sure: true,
  },
  { name: 'the whole frontmatter indented alike', text: fm('  config:\n    theme: forest'), sure: true },
  { name: 'a null theme, two ways', text: fm('config:\n  theme: ~\n  look: null'), sure: true },
  { name: 'a key with nothing after it', text: fm('config:\n  theme:\n  look: classic'), sure: true },
  { name: 'config with nothing under it', text: fm('config:\ntitle: Plan'), sure: true },
  { name: 'an empty frontmatter', text: `---\n\n---\n${FLOW}`, sure: true },
  { name: 'a sequence diagram', text: fm('config:\n  sequence:\n    actorMargin: 20', SEQUENCE), sure: true },
  { name: 'a URL as a value', text: fm('title: https://example.com/a\nconfig:\n  theme: dark'), sure: true },
  { name: 'a value of several words', text: fm('title: The plan for today\nconfig:\n  theme: dark'), sure: true },
  { name: 'an init directive', text: `%%{init: {"theme":"forest"}}%%\n${FLOW}`, sure: true },
  {
    name: 'an init directive in single quotes',
    text: `%%{init: {'theme':'dark','flowchart':{'curve':'step'}}}%%\n${FLOW}`,
    sure: true,
  },
  { name: 'the long spelling, initialize', text: `%%{initialize: {"theme":"neutral"}}%%\n${FLOW}`, sure: true },
  {
    name: 'a directive with spaces everywhere',
    text: `%%{  init  :  { "theme" : "forest" }  }%%\n${FLOW}`,
    sure: true,
  },
  { name: 'a directive after the diagram has started', text: `${FLOW}\n%%{init: {"theme":"forest"}}%%`, sure: true },
  {
    name: 'a directive over several lines',
    text: `%%{init: {\n  "theme": "forest",\n  "look": "handDrawn"\n}}%%\n${FLOW}`,
    sure: true,
  },
  {
    name: 'a directive wins over the frontmatter',
    text: fm('config:\n  theme: dark\n  look: handDrawn', `%%{init: {"theme":"forest"}}%%\n${FLOW}`),
    sure: true,
  },
  {
    name: 'two directives, the later one wins',
    text: `%%{init: {"theme":"forest","look":"handDrawn"}}%%\n%%{init: {"theme":"dark"}}%%\n${FLOW}`,
    sure: true,
  },
  {
    name: 'two directives setting different nested keys',
    text: `%%{init: {"flowchart":{"curve":"step"}}}%%\n%%{init: {"flowchart":{"nodeSpacing":30}}}%%\n${FLOW}`,
    sure: true,
  },
  {
    name: 'a directive whose key is spelled with an escape',
    text: `%%{init: {"${BACKSLASH}u0074heme":"forest"}}%%\n${FLOW}`,
    sure: true,
  },
  {
    name: 'a directive that sets a key to null over a frontmatter that sets it',
    text: fm('config:\n  theme: dark', `%%{init: {"theme":null}}%%\n${FLOW}`),
    sure: true,
  },
  {
    name: 'a directive mermaid cannot parse is dropped, with every other one',
    text: `%%{init: {"theme":"dark"}}%%\n%%{init: {theme: forest}}%%\n${FLOW}`,
    sure: true,
  },
  { name: 'a wrap directive is not an init directive', text: `%%{wrap}%%\n${SEQUENCE}`, sure: true },
  { name: 'a comment is not a directive', text: `%% {init: {"theme":"dark"}}\n${FLOW}`, sure: true },
  { name: 'a directive type that merely ends in init', text: `%%{reinit: {"theme":"dark"}}%%\n${FLOW}` },
  { name: 'a directive with no arguments', text: `%%{init}%%\n${FLOW}` },
  { name: 'a directive with a bare word', text: `%%{init: forest}%%\n${FLOW}` },
  {
    name: 'a directive that puts a value where a group should be',
    text: fm('config:\n  flowchart:\n    curve: step', `%%{init: {"flowchart":3}}%%\n${FLOW}`),
  },
  {
    name: 'a theme variable mermaid discards',
    text: fm('config:\n  themeVariables:\n    fontSize: "calc(1px + 2px)"'),
  },
  { name: 'a directive with a config key', text: `%%{init: {"config":{"curve":"step"}}}%%\n${FLOW}`, unsure: true },
  { name: 'a YAML comment on its own line', text: fm('# mine\nconfig:\n  theme: forest'), unsure: true },
  { name: 'a YAML comment after a value', text: fm('config:\n  theme: forest # mine'), unsure: true },
  { name: 'a YAML comment after a quoted value', text: fm('config:\n  theme: "forest" # mine'), unsure: true },
  { name: 'a flow mapping', text: fm('config: { theme: forest }'), unsure: true },
  { name: 'a flow mapping one level down', text: fm('config:\n  flowchart: { curve: step }'), unsure: true },
  { name: 'a flow sequence', text: fm('config:\n  secure: [theme]'), unsure: true },
  { name: 'a block sequence', text: fm('config:\n  secure:\n    - theme'), unsure: true },
  { name: 'an anchor and an alias', text: fm('config:\n  theme: &t forest\n  look: *t'), unsure: true },
  { name: 'a tag', text: fm('config:\n  theme: !!str forest'), unsure: true },
  { name: 'a literal block scalar', text: fm('title: |\n  Plan\nconfig:\n  theme: forest'), unsure: true },
  { name: 'a folded block scalar', text: fm('title: >\n  Plan\nconfig:\n  theme: forest'), unsure: true },
  {
    name: 'a plain value continued on the next line',
    text: fm('title: Plan\n  continued\nconfig:\n  theme: forest'),
    unsure: true,
  },
  {
    name: 'a quoted value continued on the next line',
    text: fm('title: "Plan\n  continued"\nconfig:\n  theme: forest'),
    unsure: true,
  },
  { name: 'a top-level key mermaid does not define', text: fm('author: me\nconfig:\n  theme: forest'), unsure: true },
  { name: 'a quoted key', text: fm('"config":\n  theme: forest'), unsure: true },
  { name: 'a complex key', text: fm('? config\n: theme'), unsure: true },
  { name: 'config given a single value', text: fm('config: forest'), unsure: true },
  { name: 'a capitalised boolean', text: fm('config:\n  sequence:\n    showSequenceNumbers: True'), unsure: true },
  { name: 'a hexadecimal number', text: fm('config:\n  handDrawnSeed: 0x1F'), unsure: true },
  { name: 'a number with a leading plus', text: fm('config:\n  handDrawnSeed: +5'), unsure: true },
  { name: 'a number with a leading zero', text: fm('config:\n  handDrawnSeed: 012'), unsure: true },
  { name: 'a number with no digit before its point', text: fm('config:\n  fontSize: .5'), unsure: true },
  { name: 'a duplicate key', text: fm('config:\n  theme: forest\n  theme: dark'), unsure: true },
  { name: 'a tab for indentation', text: fm(`config:\n${TAB}theme: forest`), unsure: true },
  { name: 'indentation that does not line up', text: fm('config:\n    look: classic\n  theme: forest'), unsure: true },
  { name: 'a frontmatter that is never closed', text: `---\nconfig:\n  theme: forest\n${FLOW}`, unsure: true },
  { name: 'an indented opening fence', text: `  ---\nconfig:\n  theme: forest\n---\n${FLOW}`, unsure: true },
  { name: 'two fences with nothing between', text: `---\n---\n${FLOW}`, unsure: true },
  { name: 'a frontmatter with no diagram after it', text: '---\nconfig:\n  theme: forest\n---\n', unsure: true },
  { name: 'a second YAML document', text: fm('config:\n  theme: forest\n...\nconfig:\n  theme: dark'), unsure: true },
  {
    name: 'a value with an unquoted colon',
    text: fm('title: Plan: the sequel\nconfig:\n  theme: forest'),
    unsure: true,
  },
  {
    name: 'a double-quoted value with a YAML-only escape',
    text: fm(`title: "a${BACKSLASH}x41"\nconfig:\n  theme: forest`),
    unsure: true,
  },
]

await check('the small reader and mermaid read every text the same way', async () => {
  let claims = 0
  let unknowns = 0
  let rejected = 0
  for (const entry of READING_CORPUS) {
    const reading = SourceConfig.readMermaidSourceConfig(entry.text)
    const library = await mermaidReads(entry.text)
    if (library === null) {
      rejected++
    }
    let unknownHere = 0
    for (const path of PROBED) {
      const mine = SourceConfig.readMermaidConfigValue(reading, path)
      const key = path.join('.')
      if (mine.state === 'unknown') {
        unknownHere++
        continue
      }
      claims++
      if (library === null) {
        // Mermaid draws nothing from this text, so no value can be shown wrong.
        // The reader is still not allowed to be SURE of a text mermaid rejects.
        assert(!entry.sure, `${entry.name}: marked sure, and mermaid rejects the text`)
        continue
      }
      const theirs = at(library, path)
      if (mine.state === 'unset') {
        assert(
          theirs === undefined || theirs === null,
          `${entry.name}: ${key} is ${JSON.stringify(theirs)} to mermaid and unset to the reader`,
        )
      } else {
        assert(
          same(theirs, mine.value),
          `${entry.name}: ${key} is ${JSON.stringify(theirs)} to mermaid and ${JSON.stringify(mine.value)} to the reader`,
        )
      }
    }
    unknowns += unknownHere
    assert(
      !entry.sure || unknownHere === 0,
      `${entry.name}: the reader would not answer for ${unknownHere} keys of a form it must read`,
    )
    assert(
      !entry.unsure || unknownHere > 0,
      `${entry.name}: the reader answered for every key of a form it must not pretend to read`,
    )
  }
  counts.readingTexts = READING_CORPUS.length
  counts.readingSure = READING_CORPUS.filter((entry) => entry.sure).length
  counts.readingUnsure = READING_CORPUS.filter((entry) => entry.unsure).length
  counts.readingClaims = claims
  return `${READING_CORPUS.length} texts, ${claims} claims checked, ${unknowns} answered "unknown", ${rejected} texts mermaid rejects`
})

await check('a text the reader is sure of sets what the reader says, key for key', async () => {
  // The other direction: nothing mermaid takes from a "sure" text may be
  // missing from the reader's list of what the frontmatter sets.
  let compared = 0
  for (const entry of READING_CORPUS.filter((candidate) => candidate.sure)) {
    const reading = SourceConfig.readMermaidSourceConfig(entry.text)
    if (reading.directive.state !== 'absent' || reading.frontmatter.state !== 'read') {
      continue
    }
    const library = await mermaidReads(entry.text)
    assert(library !== null, `${entry.name}: mermaid rejects a text the reader is sure of`)
    const flat = {}
    const walk = (value, prefix) => {
      for (const [key, inner] of Object.entries(value ?? {})) {
        const name = prefix ? `${prefix}.${key}` : key
        if (inner !== null && typeof inner === 'object') {
          walk(inner, name)
        } else if (inner !== null && inner !== undefined) {
          flat[name] = inner
        }
      }
    }
    walk(library, '')
    const listed = Object.fromEntries(
      SourceConfig.listMermaidFrontmatterConfig(reading).map((item) => [item.key, item.value]),
    )
    // `displayMode` is a top-level frontmatter key mermaid files under gantt.
    delete flat['gantt.displayMode']
    assert(
      same(Object.entries(flat).sort(), Object.entries(listed).sort()),
      `${entry.name}: mermaid has ${JSON.stringify(flat)}, the reader lists ${JSON.stringify(listed)}`,
    )
    compared++
  }
  counts.listedTexts = compared
  return `${compared} frontmatters`
})

// ===========================================================================
// 2. What is written is what mermaid then reads — and nothing else moves.
// ===========================================================================

/** Diagrams a person could have, with none, some or all of a frontmatter. */
const PATCH_BASES = [
  { name: 'no frontmatter', text: FLOW },
  { name: 'one line, no line ending', text: 'graph TD; A-->B' },
  { name: 'blank lines first', text: `\n\n${FLOW}\n` },
  { name: 'Windows line endings', text: FLOW.split('\n').join('\r\n') + '\r\n' },
  { name: 'a title only', text: fm('title: Plan') },
  { name: 'config with another group', text: fm('config:\n  sequence:\n    showSequenceNumbers: true') },
  { name: 'config between two other keys', text: fm('title: Plan\nconfig:\n  layout: dagre\ndisplayMode: compact') },
  { name: 'four-space indentation', text: fm('config:\n    sequence:\n        actorMargin: 20\ntitle: Plan') },
  { name: 'the whole frontmatter indented alike', text: fm('  title: Plan\n  config:\n    layout: dagre') },
  { name: 'blank lines inside', text: fm('\ntitle: Plan\n\nconfig:\n\n  layout: dagre\n\n') },
  { name: 'an empty frontmatter', text: `---\n\n---\n${FLOW}` },
  { name: 'a directive that sets something else', text: `%%{init: {"sequence":{"actorMargin":20}}}%%\n${FLOW}` },
  { name: 'a sequence diagram', text: SEQUENCE },
]

const flatten = (config) => {
  const flat = {}
  const walk = (value, prefix) => {
    for (const [key, inner] of Object.entries(value ?? {})) {
      const name = prefix ? `${prefix}.${key}` : key
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        walk(inner, name)
      } else if (inner !== null && inner !== undefined) {
        flat[name] = inner
      }
    }
  }
  walk(config, '')
  return flat
}

/**
 * Apply `changes` to `text` and hold mermaid to the result: every key the
 * change names now reads as written (or not at all, for a removal), and every
 * other key mermaid took from the text before is exactly what it was.
 */
const writeAndReadBack = async (name, text, changes) => {
  const before = await mermaidReads(text)
  assert(before !== null, `${name}: mermaid rejects the text before any change`)
  const result = SourceConfig.patchMermaidSourceConfig(text, changes)
  assert(result.ok, `${name}: refused (${result.refusal?.code}) ${result.refusal?.message}`)
  const after = await mermaidReads(result.text)
  assert(after !== null, `${name}: mermaid rejects the patched text ${JSON.stringify(result.text)}`)
  const expected = flatten(before)
  for (const change of changes) {
    const key = change.path.join('.')
    if (change.value === undefined) {
      delete expected[key]
    } else {
      expected[key] = change.value
    }
  }
  const got = flatten(after)
  assert(
    same(Object.entries(got).sort(), Object.entries(expected).sort()),
    `${name}: mermaid reads ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}, from ${JSON.stringify(result.text)}`,
  )
  return result.text
}

await check('an option written into any frontmatter is the option mermaid reads, and no other moves', async () => {
  const changeSets = [
    [{ path: ['theme'], value: 'forest' }],
    [
      { path: ['look'], value: 'handDrawn' },
      { path: ['handDrawnSeed'], value: 7 },
    ],
    [{ path: ['themeVariables', 'fontSize'], value: '20px' }],
    [
      { path: ['flowchart', 'curve'], value: 'linear' },
      { path: ['flowchart', 'nodeSpacing'], value: 30 },
      { path: ['flowchart', 'rankSpacing'], value: 30 },
    ],
    [
      { path: ['sequence', 'mirrorActors'], value: false },
      { path: ['sequence', 'messageMargin'], value: 60 },
    ],
  ]
  let written = 0
  for (const base of PATCH_BASES) {
    for (const changes of changeSets) {
      const name = `${base.name} + ${changes.map((change) => change.path.join('.')).join(', ')}`
      const text = await writeAndReadBack(name, base.text, changes)
      // Changed in place, then taken away again: mermaid is back to what it
      // read from the original, and so is the text.
      const replaced = changes.map((change) => ({
        ...change,
        value: typeof change.value === 'number' ? change.value + 1 : change.value,
      }))
      await writeAndReadBack(`${name} (changed)`, text, replaced)
      const removed = await writeAndReadBack(
        `${name} (removed)`,
        text,
        changes.map((change) => ({ path: change.path, value: undefined })),
      )
      assert(removed === base.text, `${name}: taking the options away again left ${JSON.stringify(removed)}`)
      written += 3
    }
  }
  counts.patchesReadBack = written
  return `${written} patches over ${PATCH_BASES.length} diagrams`
})

await check('the reason a change is refused under a directive is real: mermaid would have ignored it', async () => {
  // Without this the refusal could be guarding nothing: if mermaid ever let the
  // frontmatter win, the control would work and the message would be a lie.
  const directed = `%%{init: {"theme":"forest"}}%%\n${FLOW}`
  const refused = SourceConfig.patchMermaidSourceConfig(directed, [{ path: ['theme'], value: 'dark' }])
  assert(!refused.ok && refused.refusal.code === 'directive-sets-key', `not refused: ${JSON.stringify(refused)}`)
  const forced = `---\nconfig:\n  theme: dark\n---\n${directed}`
  const read = await mermaidReads(forced)
  assert(read.theme === 'forest', `mermaid now lets the frontmatter win: theme is ${read.theme}`)
  return `frontmatter says dark, directive says forest, mermaid draws ${read.theme}`
})

const failed = checks.filter((entry) => !entry.ok)
for (const entry of checks) {
  console.error(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail ? ' — ' + entry.detail : ''}`)
}
console.log(JSON.stringify({ ok: failed.length === 0, mermaid: mermaidVersion, node: process.version, checks, counts }))
process.exit(failed.length === 0 ? 0 : 1)
