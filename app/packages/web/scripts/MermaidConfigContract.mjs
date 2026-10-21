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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
const Catalog = await import(`${NODES}/MermaidConfigCatalog.ts`)
const Presets = await import(`${NODES}/MermaidStylePresets.ts`)
const Fixtures = await import(`${NODES}/MermaidCustomise.fixtures.ts`)
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
const BACKTICK = String.fromCharCode(96)

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

// ===========================================================================
// 3. The catalogue: every key, default and choice the Customise panel relies on.
// ===========================================================================

const at2 = (config, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), config)

await check('every catalogue key and sample value is written, and read back by mermaid as written', async () => {
  // Read back TWICE over: as the configuration mermaid takes from the text, and
  // as the configuration in force afterwards — the second is what a key on the
  // app's locked list, or one mermaid has no schema entry for, would fail.
  let readBack = 0
  for (const entry of Catalog.MERMAID_CONFIG_CATALOG) {
    const name = entry.path.join('.')
    for (const sample of entry.samples) {
      for (const base of [FLOW, fm('title: Plan\nconfig:\n  layout: dagre'), SEQUENCE]) {
        const result = SourceConfig.patchMermaidSourceConfig(base, [{ path: entry.path, value: sample }])
        assert(result.ok, `${name} = ${JSON.stringify(sample)}: refused (${result.refusal?.code})`)
        const taken = await mermaidReads(result.text)
        assert(taken !== null, `${name} = ${JSON.stringify(sample)}: mermaid rejects ${JSON.stringify(result.text)}`)
        assert(
          at2(taken, entry.path) === sample,
          `${name}: wrote ${JSON.stringify(sample)}, mermaid took ${JSON.stringify(at2(taken, entry.path))}`,
        )
        const inForce = at2(api.getConfig(), entry.path)
        assert(
          inForce === sample,
          `${name}: wrote ${JSON.stringify(sample)}, and ${JSON.stringify(inForce)} is in force — mermaid refuses this key from a diagram's text`,
        )
        const mine = SourceConfig.readMermaidConfigValue(SourceConfig.readMermaidSourceConfig(result.text), entry.path)
        assert(mine.state === 'set' && mine.value === sample, `${name}: the reader says ${JSON.stringify(mine)}`)
        readBack++
      }
    }
  }
  counts.catalogueKeys = Catalog.MERMAID_CONFIG_CATALOG.length
  counts.catalogueReadBack = readBack
  return `${Catalog.MERMAID_CONFIG_CATALOG.length} keys, ${readBack} values read back`
})

await check('every default the catalogue quotes is the one mermaid ships', async () => {
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base' })
  const baseTheme = api.getConfig().themeVariables
  let compared = 0
  for (const entry of Catalog.MERMAID_CONFIG_CATALOG) {
    const name = entry.path.join('.')
    if (name === 'theme') {
      // Deliberately quoted as "none": in this app the block decides.
      assert(entry.default === undefined, 'the catalogue quotes a default theme')
      continue
    }
    const shipped = entry.path[0] === 'themeVariables' ? baseTheme[entry.path[1]] : at2(api.defaultConfig, entry.path)
    assert(
      shipped === entry.default,
      `${name}: mermaid ships ${JSON.stringify(shipped)}, the catalogue says ${JSON.stringify(entry.default)}`,
    )
    compared++
  }
  counts.catalogueDefaults = compared
  return `${compared} defaults`
})

await check('the line styles, looks and themes offered are the library’s own', async () => {
  const declared = readFileSync(
    join(dirname(require.resolve('mermaid/package.json')), 'dist', 'config.type.d.ts'),
    'utf8',
  )
  const union = (pattern, what) => {
    const found = pattern.exec(declared)
    assert(found !== null, `no ${what} union in mermaid/dist/config.type.d.ts`)
    return found[1]
      .split('|')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter((name) => name !== 'null')
      .sort()
  }
  const curves = union(/^\s*curve\?:\s*([^;]+);/m, 'curve')
  assert(
    same(curves, [...Catalog.MERMAID_LINE_STYLES].sort()),
    `mermaid ${mermaidVersion} has curves [${curves.join(', ')}]; the catalogue offers [${[...Catalog.MERMAID_LINE_STYLES].sort().join(', ')}]`,
  )
  const looks = union(/^\s*look\?:\s*([^;]+);/m, 'look')
  for (const look of Catalog.MERMAID_LOOKS) {
    assert(looks.includes(look), `mermaid has no look "${look}"`)
  }
  const themes = union(/^\s*theme\?:\s*([^;]+);/m, 'theme')
  assert(
    same(themes, Object.keys(Catalog.MERMAID_LIBRARY_THEME_LABELS).sort()),
    `mermaid ships themes [${themes.join(', ')}]; the panel labels [${Object.keys(Catalog.MERMAID_LIBRARY_THEME_LABELS).sort().join(', ')}]`,
  )
  counts.lineStyles = curves.length
  return `${curves.length} line styles, ${Catalog.MERMAID_LOOKS.length} of ${looks.length} looks, ${themes.length} themes`
})

/** The diagram type mermaid reports for each kind the app names. */
const MERMAID_TYPE_OF_KIND = {
  flowchart: 'flowchart-v2',
  sequence: 'sequence',
  class: 'classDiagram',
  state: 'stateDiagram',
  er: 'er',
  gantt: 'gantt',
  pie: 'pie',
  journey: 'journey',
  gitGraph: 'gitGraph',
  mindmap: 'mindmap',
  timeline: 'timeline',
  quadrant: 'quadrantChart',
  requirement: 'requirement',
  sankey: 'sankey',
  xychart: 'xychart',
  block: 'block',
  c4: 'c4',
  unknown: 'kanban',
}

const typeOf = async (text) => {
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base' })
  return (await mermaid.parse(text.trim())).diagramType
}

await check('every sample diagram is one mermaid accepts, of the kind the app takes it for', async () => {
  for (const [kind, text] of Object.entries(Fixtures.MERMAID_SAMPLE_DIAGRAMS)) {
    assert(
      Catalog.mermaidCustomiseKind(text) === kind,
      `${kind}: the app calls it ${Catalog.mermaidCustomiseKind(text)}`,
    )
    const type = await typeOf(text)
    assert(
      type === MERMAID_TYPE_OF_KIND[kind],
      `${kind}: mermaid calls it ${type}, expected ${MERMAID_TYPE_OF_KIND[kind]}`,
    )
  }
  counts.sampleKinds = Object.keys(Fixtures.MERMAID_SAMPLE_DIAGRAMS).length
  return `${counts.sampleKinds} kinds`
})

await check('every control and every preset, on every kind, leaves a diagram mermaid reads as chosen', async () => {
  let applied = 0
  let unavailable = 0
  for (const [kind, base] of Object.entries(Fixtures.MERMAID_SAMPLE_DIAGRAMS)) {
    const edits = [
      ['theme forest', Catalog.applyMermaidTheme(base, 'forest')],
      ['theme neo-dark', Catalog.applyMermaidTheme(base, 'neo-dark')],
      ['look handDrawn', Catalog.applyMermaidLook(base, 'app', 'handDrawn')],
      ['text size 20', Catalog.applyMermaidTextSize(base, 'app', 20)],
      ['text size 9', Catalog.applyMermaidTextSize(base, 'app', 9)],
      ['spacing 160', Catalog.applyMermaidSpacing(base, 'app', 160)],
      ['spacing 40', Catalog.applyMermaidSpacing(base, 'app', 40)],
      ['line style linear', Catalog.applyMermaidLineStyle(base, 'app', 'linear')],
      ...Presets.MERMAID_STYLE_PRESET_IDS.map((id) => [`preset ${id}`, Presets.applyMermaidStylePreset(base, id)]),
    ]
    for (const [what, edit] of edits) {
      if (!edit.ok) {
        assert(edit.refusal.code === 'invalid-change', `${kind}, ${what}: refused as ${edit.refusal.code}`)
        unavailable++
        continue
      }
      const taken = await mermaidReads(edit.code)
      assert(taken !== null, `${kind}, ${what}: mermaid rejects ${JSON.stringify(edit.code)}`)
      assert(
        (await typeOf(edit.code)) === MERMAID_TYPE_OF_KIND[kind],
        `${kind}, ${what}: no longer the same kind of diagram`,
      )
      const listed = Object.fromEntries(
        SourceConfig.listMermaidFrontmatterConfig(SourceConfig.readMermaidSourceConfig(edit.code)).map((item) => [
          item.key,
          item.value,
        ]),
      )
      assert(
        same(Object.entries(flatten(taken)).sort(), Object.entries(listed).sort()),
        `${kind}, ${what}: mermaid takes ${JSON.stringify(flatten(taken))}, the text was meant to say ${JSON.stringify(listed)}`,
      )
      applied++
    }
  }
  counts.controlsApplied = applied
  counts.controlsUnavailable = unavailable
  return `${applied} edits read back, ${unavailable} not offered for their kind`
})

// ---------------------------------------------------------------------------
// The three places the catalogue departs from mermaid's own documentation are
// each a fact about a renderer's SOURCE, which Node cannot observe by drawing.
// So the source is read. Crude, and deliberate: if an upgrade changes any of
// these the catalogue's table is wrong for that mermaid, and somebody has to
// measure again in a browser rather than find out from a control that does
// nothing.
// ---------------------------------------------------------------------------
const CHUNKS = join(dirname(require.resolve('mermaid/package.json')), 'dist', 'chunks', 'mermaid.core')
const chunkWith = (marker) => {
  const names = readdirSync(CHUNKS).filter((name) => name.endsWith('.mjs'))
  const found = names.filter((name) => readFileSync(join(CHUNKS, name), 'utf8').includes(marker))
  assert(found.length === 1, `expected one chunk containing ${JSON.stringify(marker)}, found ${found.length}`)
  return readFileSync(join(CHUNKS, found[0]), 'utf8')
}

await check('still true of this mermaid: the class renderer takes its spacing from the state group', async () => {
  const source = chunkWith('Drawing class diagram (v3)')
  const draw = source.slice(
    source.indexOf('Drawing class diagram (v3)'),
    source.indexOf('Drawing class diagram (v3)') + 900,
  )
  assert(/state:\s*conf/.test(draw), 'the class renderer no longer destructures `state: conf`')
  assert(/nodeSpacing\s*=\s*conf\?\.nodeSpacing/.test(draw), 'the class renderer no longer reads conf.nodeSpacing')
  assert(
    Catalog.readMermaidSpacing(SourceConfig.readMermaidSourceConfig(Fixtures.MERMAID_SAMPLE_DIAGRAMS.class), 'class')
      .state === 'unavailable',
    'the catalogue now offers spacing for a class diagram',
  )
  return 'spacing for a class diagram is `state.nodeSpacing`; the panel offers none'
})

await check(
  'still true of this mermaid: the sequence renderer ignores messageMargin and its own three font sizes',
  async () => {
    const source = chunkWith('conf.actorFontSize = conf.noteFontSize = conf.messageFontSize = cnf.fontSize')
    assert(!source.includes('messageMargin'), 'the sequence renderer now reads messageMargin')
    assert(
      source.includes('conf.boxMargin') && source.includes('conf.actorMargin'),
      'boxMargin / actorMargin are no longer read',
    )
    const written = Catalog.applyMermaidTextSize(Fixtures.MERMAID_SAMPLE_DIAGRAMS.sequence, 'app', 20)
    assert(
      written.ok && written.code.includes('\n  fontSize: 20\n'),
      'the catalogue no longer writes the root fontSize for a sequence diagram',
    )
    return 'text size is the root `fontSize`; spacing is `actorMargin` and `boxMargin`'
  },
)

// ===========================================================================
// 4. A string is written so that mermaid reads the identical string back.
// ===========================================================================

/**
 * Every spelling a YAML reader could take for something other than the string
 * it is: the booleans and nulls, each form of number, the YAML 1.1 words,
 * padding, and a value that starts with (or contains) each YAML indicator.
 * A simple word is written BARE by this app; these must not be.
 */
const AWKWARD_STRINGS = [
  ...['true', 'false', 'True', 'False', 'TRUE', 'FALSE', 'null', 'Null', 'NULL', '~'],
  ...['20', '-3', '0', '1e3', '1E3', '0x10', '0o17', '0b11', '.5', '5.', '+5', '1_000', '012', '.inf', '-.inf', '.NaN'],
  ...['yes', 'no', 'on', 'off', 'y', 'n', 'Yes', 'NO', 'On', 'OFF', 'Y', 'N'],
  ...[' forest', 'forest ', ' ', '  padded  '],
  ...['- x', '? x', ': x', '# x', 'x # y', 'x: y', 'x:', '[x]', '{x}', '&x', '*x', '!x', '|', '>-', '%x', '@x'],
  ...[`${BACKTICK}x${BACKTICK}`, '"x"', "'x'", "x'y", 'a,b', `a${BACKSLASH}b`, '---', '...', 'é ü'],
  // And the plain words, which ARE written bare: the control that this is not
  // a test of "everything is quoted".
  ...['forest', 'handDrawn', 'neo-dark', 'catmullRom'],
]

await check('a string is written so that mermaid reads the identical string back, however awkward', async () => {
  const stringKeys = Catalog.MERMAID_CONFIG_CATALOG.filter((entry) => entry.type.kind !== 'number')
  assert(stringKeys.length >= 7, `only ${stringKeys.length} string keys in the catalogue`)
  let readBack = 0
  let refused = 0
  let bare = 0
  for (const entry of stringKeys) {
    const name = entry.path.join('.')
    for (const value of AWKWARD_STRINGS) {
      const result = SourceConfig.patchMermaidSourceConfig(FLOW, [{ path: entry.path, value }])
      if (!SourceConfig.mermaidKeepsConfigValue(entry.path, value)) {
        // Mermaid would throw this value away, so it must not be written at all.
        assert(
          !result.ok && result.refusal.code === 'value-mermaid-discards',
          `${name} = ${JSON.stringify(value)}: written although mermaid discards it`,
        )
        refused++
        continue
      }
      assert(result.ok, `${name} = ${JSON.stringify(value)}: refused (${result.refusal?.code})`)
      const taken = await mermaidReads(result.text)
      assert(taken !== null, `${name} = ${JSON.stringify(value)}: mermaid rejects ${JSON.stringify(result.text)}`)
      const got = at(taken, entry.path)
      assert(
        typeof got === 'string' && got === value,
        `${name}: wrote the string ${JSON.stringify(value)}, mermaid read ${typeof got} ${JSON.stringify(got)} from ${JSON.stringify(result.text)}`,
      )
      if (result.text.includes(`: ${value}\n`)) {
        bare++
      }
      readBack++
    }
  }
  // The plain words went out bare — otherwise this proves only that quoting works.
  assert(bare >= stringKeys.length, `only ${bare} values were written bare`)
  counts.awkwardStrings = AWKWARD_STRINGS.length
  counts.awkwardReadBack = readBack
  counts.awkwardRefused = refused
  counts.writtenBare = bare
  return `${stringKeys.length} keys x ${AWKWARD_STRINGS.length} values: ${readBack} read back identical (${bare} of them bare), ${refused} refused because mermaid discards them`
})

await check('still true of this mermaid: a bare true, number or null is NOT a string to it', async () => {
  // What the check above guards against. If mermaid's YAML reader ever took
  // these for strings, quoting them would be ceremony.
  const typed = {}
  for (const bareWord of ['true', '20', '1e3', '0x10', '.5', '~', 'null']) {
    const taken = await mermaidReads(`---\nconfig:\n  theme: ${bareWord}\n---\n${FLOW}`)
    typed[bareWord] = taken === null ? 'rejected' : taken.theme === undefined ? 'dropped' : typeof taken.theme
  }
  for (const [bareWord, type] of Object.entries(typed)) {
    assert(type !== 'string', `mermaid now reads a bare ${bareWord} as a string`)
  }
  // And the YAML 1.1 words, which its reader does NOT type: recorded, so the
  // day that changes is visible here.
  const yes = await mermaidReads(`---\nconfig:\n  theme: yes\n---\n${FLOW}`)
  return `${JSON.stringify(typed)}; bare yes reads as ${typeof yes?.theme}`
})

// ===========================================================================
// 5. What mermaid throws away is what this app says it throws away.
// ===========================================================================

await check(
  'the characters mermaid keeps in a theme variable are exactly the ones this app says it keeps',
  async () => {
    // Written by hand, past the writer's own refusal, so that mermaid decides.
    const probe = (value) => `---\nconfig:\n  themeVariables:\n    fontSize: ${JSON.stringify(value)}\n---\n${FLOW}`
    const characters = []
    for (let code = 32; code <= 126; code++) {
      characters.push(String.fromCharCode(code))
    }
    characters.push('é', 'ß', '–', '’', '日', ' ')
    let kept = 0
    const disagreements = []
    for (const character of characters) {
      const value = `12px${character}`
      const taken = await mermaidReads(probe(value))
      assert(taken !== null, `mermaid rejects a theme variable containing ${JSON.stringify(character)}`)
      const mermaidKeeps = taken.themeVariables?.fontSize === value
      const appSays = SourceConfig.mermaidKeepsConfigValue(['themeVariables', 'fontSize'], value)
      if (mermaidKeeps !== appSays) {
        disagreements.push(
          `${JSON.stringify(character)}: mermaid ${mermaidKeeps ? 'keeps' : 'discards'}, the app says ${appSays ? 'keeps' : 'discards'}`,
        )
      }
      kept += mermaidKeeps ? 1 : 0
      // And the reader then never reports a discarded value as the setting.
      const mine = SourceConfig.readMermaidConfigValue(SourceConfig.readMermaidSourceConfig(probe(value)), [
        'themeVariables',
        'fontSize',
      ])
      assert(
        mermaidKeeps ? mine.state === 'set' && mine.value === value : mine.state === 'unknown',
        `${JSON.stringify(character)}: the reader says ${JSON.stringify(mine)}`,
      )
    }
    assert(disagreements.length === 0, disagreements.join('; '))
    assert(kept > 60 && kept < characters.length, `mermaid kept ${kept} of ${characters.length} characters`)
    counts.themeCharactersProbed = characters.length
    counts.themeCharactersKept = kept
    return `${characters.length} characters probed, mermaid keeps ${kept}`
  },
)

await check(
  'still true of this mermaid: an angle bracket or a data URL in ANY option’s value deletes the option',
  async () => {
    for (const [path, value] of [
      [['theme'], '<forest>'],
      [['look'], 'a>b'],
      [['flowchart', 'curve'], 'url(data:x)'],
    ]) {
      const name = path.join('.')
      assert(!SourceConfig.mermaidKeepsConfigValue(path, value), `the app says mermaid keeps ${name} = ${value}`)
      const refused = SourceConfig.patchMermaidSourceConfig(FLOW, [{ path, value }])
      assert(!refused.ok && refused.refusal.code === 'value-mermaid-discards', `${name} = ${value} was written`)
      const yaml =
        path.length === 1
          ? `  ${path[0]}: ${JSON.stringify(value)}`
          : `  ${path[0]}:\n    ${path[1]}: ${JSON.stringify(value)}`
      const taken = await mermaidReads(`---\nconfig:\n${yaml}\n---\n${FLOW}`)
      assert(
        taken !== null && at(taken, path) === undefined,
        `mermaid now keeps ${name} = ${value}: ${JSON.stringify(taken)}`,
      )
    }
    // The same characters elsewhere in a value are fine.
    const fine = await mermaidReads(`---\nconfig:\n  theme: "url(x)"\n---\n${FLOW}`)
    assert(fine?.theme === 'url(x)', 'mermaid now deletes a plain url()')
    return 'three options, each deleted by mermaid and refused by the writer'
  },
)

// ===========================================================================
// 6. The three keys a diagram's text may no longer set: drawn, not just parsed.
// ===========================================================================
//
// Everything above asks mermaid what it READS. This section has it DRAW, through
// the app's own MermaidRuntime, and compares the SVG it returns. jsdom has no
// layout, so every box here is a made-up size (`fakeGeometry` below) and nothing
// may be concluded about where anything is. What can be concluded is exactly
// what is asserted: two texts produced the SAME drawing, byte for byte, or they
// did not. Only kinds whose output is the same from one render to the next are
// used (a sequence diagram carries random ids).
const fakeGeometry = function () {
  const characters = (this.textContent || '').length
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 8 * characters,
    bottom: 18,
    width: 8 * Math.max(characters, 1),
    height: 18,
  }
}
for (const prototype of [
  dom.window.SVGElement.prototype,
  dom.window.HTMLElement.prototype,
  dom.window.Element.prototype,
]) {
  Object.defineProperty(prototype, 'getBBox', { value: fakeGeometry, configurable: true, writable: true })
  Object.defineProperty(prototype, 'getBoundingClientRect', { value: fakeGeometry, configurable: true, writable: true })
  Object.defineProperty(prototype, 'getComputedTextLength', {
    value() {
      return 8 * (this.textContent || '').length
    },
    configurable: true,
    writable: true,
  })
}

const DRAWN_FONT = 'Georgia, serif'
let drawn = 0
/**
 * An id of constant LENGTH. The faked geometry sizes a box by its text, the id
 * is repeated through the diagram's stylesheet, and so the tenth drawing came
 * out wider than the ninth for no other reason than "10" being longer than "9".
 */
const drawingId = () => `mermaid-config-contract-${String(drawn++).padStart(6, '0')}`
/** Draw `text` through the app's runtime and return the SVG with its own id taken out. */
const draw = async (text) => {
  const id = drawingId()
  const { svg } = await Runtime.renderMermaidDiagram({
    id,
    text,
    theme: { theme: 'base' },
    fontFamily: DRAWN_FONT,
    measureIn: undefined,
  })
  return svg.split(id).join('ID')
}
/** The same, with a secure list of the caller's choosing in place of the app's. */
const drawWithSecure = async (text, secure) => {
  const id = drawingId()
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', secure, theme: 'base', fontFamily: DRAWN_FONT })
  const { svg } = await mermaid.render(id, text)
  return svg.split(id).join('ID')
}

const DRAWN_KINDS = {
  // A straight two-node edge renders identically under linear and basis curves.
  // Branch and rejoin so the curve control exercises actual bends.
  flowchart: lines(
    'flowchart LR',
    '  A[Alpha] -->|feeds| B[Beta]',
    '  A --> C[Gamma]',
    '  B --> D[Delta]',
    '  C --> D',
  ),
  state: Fixtures.MERMAID_SAMPLE_DIAGRAMS.state,
  pie: Fixtures.MERMAID_SAMPLE_DIAGRAMS.pie,
}
/** Each of the three keys, every way a text can spell it: at the root and nested, as frontmatter and as a directive. */
const LOCKED_FORMS = [
  {
    key: 'themeCSS',
    name: 'themeCSS, frontmatter',
    wrap: (body) => `---\nconfig:\n  themeCSS: ".node rect, .pieCircle { fill: red; stroke-width: 9px }"\n---\n${body}`,
  },
  {
    key: 'themeCSS',
    name: 'themeCSS, init directive',
    wrap: (body) => `%%{init: {"themeCSS": ".node rect, .pieCircle { fill: red; stroke-width: 9px }"}}%%\n${body}`,
  },
  {
    key: 'fontFamily',
    name: 'fontFamily, frontmatter',
    wrap: (body) => `---\nconfig:\n  fontFamily: "Comic Sans MS"\n---\n${body}`,
  },
  {
    key: 'fontFamily',
    name: 'fontFamily, init directive',
    wrap: (body) => `%%{init: {"fontFamily": "Comic Sans MS"}}%%\n${body}`,
  },
  {
    key: 'fontFamily',
    name: 'themeVariables.fontFamily, frontmatter',
    wrap: (body) => `---\nconfig:\n  themeVariables:\n    fontFamily: "Comic Sans MS"\n---\n${body}`,
  },
  {
    key: 'fontFamily',
    name: 'themeVariables.fontFamily, init directive',
    wrap: (body) => `%%{init: {"themeVariables": {"fontFamily": "Comic Sans MS"}}}%%\n${body}`,
  },
  {
    key: 'htmlLabels',
    name: 'htmlLabels, frontmatter',
    wrap: (body) => `---\nconfig:\n  htmlLabels: false\n---\n${body}`,
  },
  {
    key: 'htmlLabels',
    name: 'htmlLabels, init directive',
    wrap: (body) => `%%{init: {"htmlLabels": false}}%%\n${body}`,
  },
  {
    key: 'htmlLabels',
    name: 'flowchart.htmlLabels, frontmatter',
    wrap: (body) => `---\nconfig:\n  flowchart:\n    htmlLabels: false\n---\n${body}`,
  },
  {
    key: 'htmlLabels',
    name: 'flowchart.htmlLabels, init directive',
    wrap: (body) => `%%{init: {"flowchart": {"htmlLabels": false}}}%%\n${body}`,
  },
]
const APP_LOCK = ['themeCSS', 'fontFamily', 'htmlLabels']

await check('the three keys the app locks are on the list it hands mermaid', async () => {
  for (const key of APP_LOCK) {
    assert(Runtime.MERMAID_APP_SECURE_KEYS.includes(key), `${key} is not in MERMAID_APP_SECURE_KEYS`)
  }
  for (const [kind, body] of Object.entries(DRAWN_KINDS)) {
    assert(
      (await draw(body)) === (await draw(body)),
      `${kind}: two renders of the same text differ, so nothing can be compared`,
    )
  }
  return APP_LOCK.join(', ')
})

await check(
  'a diagram that sets themeCSS, fontFamily or htmlLabels is drawn exactly as the same diagram without it',
  async () => {
    let compared = 0
    for (const [kind, body] of Object.entries(DRAWN_KINDS)) {
      const without = await draw(body)
      assert(without.includes('<svg'), `${kind}: nothing was drawn`)
      for (const form of LOCKED_FORMS) {
        const withKey = await draw(form.wrap(body))
        assert(
          withKey === without,
          `${kind}, ${form.name}: the drawing changed (${without.length} characters without the key, ${withKey.length} with it)`,
        )
        compared++
      }
    }
    counts.lockedForms = LOCKED_FORMS.length
    counts.lockedDrawings = compared
    return `${LOCKED_FORMS.length} spellings on ${Object.keys(DRAWN_KINDS).length} kinds: ${compared} drawings, each identical to the one without the key`
  },
)

await check('by the same comparison, a key the app does NOT lock changes the drawing', async () => {
  // The control: without it, "identical" above could be a comparison that can
  // never tell two drawings apart.
  const unlocked = [
    ['flowchart', 'look', (body) => `---\nconfig:\n  look: handDrawn\n  handDrawnSeed: 7\n---\n${body}`],
    ['flowchart', 'flowchart.curve', (body) => `---\nconfig:\n  flowchart:\n    curve: linear\n---\n${body}`],
    ['flowchart', 'theme', (body) => `%%{init: {"theme": "forest"}}%%\n${body}`],
    [
      'state',
      'theme base with a colour of its own',
      (body) => `---\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: "#ffcc00"\n---\n${body}`,
    ],
    ['pie', 'pie.textPosition', (body) => `---\nconfig:\n  pie:\n    textPosition: 0.5\n---\n${body}`],
  ]
  for (const [kind, name, wrap] of unlocked) {
    const without = await draw(DRAWN_KINDS[kind])
    const withKey = await draw(wrap(DRAWN_KINDS[kind]))
    assert(withKey !== without, `${kind}, ${name}: the drawing did not change`)
  }
  counts.unlockedDrawings = unlocked.length
  return unlocked.map(([kind, name]) => `${name} (${kind})`).join(', ')
})

await check('the app defaults to dagre without overriding a diagram that explicitly chooses ELK', async () => {
  const body = DRAWN_KINDS.flowchart
  const defaultDrawing = await draw(body)
  assert(defaultDrawing === (await draw(`---\nconfig:\n  layout: dagre\n---\n${body}`)), 'the app default is not dagre')
  const elkDrawing = await draw(`---\nconfig:\n  layout: elk\n---\n${body}`)
  assert(elkDrawing !== defaultDrawing, 'the diagram explicit ELK layout was overridden')
  assert(api.getConfig().layout === 'elk', 'the renderer did not receive the diagram ELK layout')
  return 'default and explicit dagre match; explicit ELK reaches the renderer and draws differently'
})

await check(
  'still true of this mermaid: it is the lock that does it — off the list, each of the three changes the drawing',
  async () => {
    // Drawn by mermaid directly, with the app's list MINUS the three. If a key
    // changed nothing here, its "identical" above would prove nothing about the
    // lock; and the day mermaid stops honouring one by itself, this says so.
    const withoutLock = Runtime.MERMAID_APP_SECURE_KEYS.filter((key) => !APP_LOCK.includes(key))
    const withLock = [...Runtime.MERMAID_APP_SECURE_KEYS]
    const effective = {}
    for (const form of LOCKED_FORMS) {
      // A pie has no boxes for a label mode to apply to; the other two keys are
      // tried on every kind.
      const kinds = form.key === 'htmlLabels' ? ['flowchart'] : Object.keys(DRAWN_KINDS)
      for (const kind of kinds) {
        const body = DRAWN_KINDS[kind]
        const changes =
          (await drawWithSecure(form.wrap(body), withoutLock)) !== (await drawWithSecure(body, withoutLock))
        const locked = (await drawWithSecure(form.wrap(body), withLock)) === (await drawWithSecure(body, withLock))
        assert(locked, `${kind}, ${form.name}: still changes the drawing with the key on the list`)
        effective[form.name] = effective[form.name] || changes
      }
    }
    const inert = Object.entries(effective)
      .filter(([, changes]) => !changes)
      .map(([name]) => name)
    assert(inert.length === 0, `unlocked, these change nothing, so their lock is unproven: ${inert.join('; ')}`)
    return `${Object.keys(effective).length} spellings, each changes a drawing when unlocked and none when locked`
  },
)

await check(
  'the lock covers a locked name at every depth, and leaves the other font options beside it alone',
  async () => {
    const inForce = async (text) => {
      await draw(text)
      return api.getConfig()
    }
    const base = await inForce(FLOW)
    const nested = await inForce(
      `---\nconfig:\n  themeVariables:\n    fontFamily: "Comic Sans MS"\n  flowchart:\n    htmlLabels: false\n---\n${FLOW}`,
    )
    assert(
      nested.themeVariables.fontFamily === base.themeVariables.fontFamily,
      `themeVariables.fontFamily reached mermaid: ${nested.themeVariables.fontFamily}`,
    )
    assert(
      nested.flowchart.htmlLabels === base.flowchart.htmlLabels,
      `flowchart.htmlLabels reached mermaid: ${nested.flowchart.htmlLabels}`,
    )
    assert(base.fontFamily === DRAWN_FONT, `the app's own font did not reach mermaid: ${base.fontFamily}`)
    // The rule is the END of the name. A diagram may still size and weight its
    // text — the Customise panel writes a size itself — and those keys sit right
    // beside the font families, differing by one word.
    const beside = await inForce(
      `---\nconfig:\n  fontSize: 31\n  sequence:\n    actorFontSize: 31\n    actorFontWeight: 700\n    actorFontFamily: "Comic Sans MS"\n---\n${FLOW}`,
    )
    assert(beside.fontSize === 31, `the root fontSize did not reach mermaid: ${beside.fontSize}`)
    assert(
      beside.sequence.actorFontSize === 31,
      `sequence.actorFontSize did not reach mermaid: ${beside.sequence.actorFontSize}`,
    )
    assert(beside.sequence.actorFontWeight === 700, 'sequence.actorFontWeight did not reach mermaid')
    assert(beside.sequence.actorFontFamily !== 'Comic Sans MS', 'sequence.actorFontFamily reached mermaid')
    return 'themeVariables.fontFamily, flowchart.htmlLabels and sequence.actorFontFamily refused; fontSize, actorFontSize and actorFontWeight honoured'
  },
)

// ===========================================================================
// 7. Every name mermaid gives a font, and the one it gives the label mode.
// ===========================================================================
//
// `fontFamily` is locked, and a diagram's text could still choose its font:
// mermaid has a font-family key of its own for the actors of a sequence
// diagram, the tasks of a journey, each of twenty-two parts of a C4 diagram.
// The app locks every key whose name ends in `FontFamily`, found at run time in
// the library's own default configuration (MermaidRuntime.resolveMermaidSecureKeys).

/**
 * THE exact set of names the app hands mermaid 11.17.2 as locked. Written out,
 * not computed, on purpose: the list is derived from whatever mermaid is
 * installed, so an upgrade that adds, drops or renames a font key would
 * otherwise only make it silently longer or shorter. Here it is a diff.
 */
const PINNED_LOCKED_NAMES = [
  // mermaid's own six
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  // the app's three
  'themeCSS',
  'fontFamily',
  'htmlLabels',
  // every other name mermaid gives a font: sequence, journey and timeline…
  'actorFontFamily',
  'noteFontFamily',
  'messageFontFamily',
  'taskFontFamily',
  'titleFontFamily',
  'usecaseFontFamily',
  // …and C4
  'personFontFamily',
  'external_personFontFamily',
  'systemFontFamily',
  'external_systemFontFamily',
  'system_dbFontFamily',
  'external_system_dbFontFamily',
  'system_queueFontFamily',
  'external_system_queueFontFamily',
  'boundaryFontFamily',
  'containerFontFamily',
  'external_containerFontFamily',
  'container_dbFontFamily',
  'external_container_dbFontFamily',
  'container_queueFontFamily',
  'external_container_queueFontFamily',
  'componentFontFamily',
  'external_componentFontFamily',
  'component_dbFontFamily',
  'external_component_dbFontFamily',
  'component_queueFontFamily',
  'external_component_queueFontFamily',
]

const RESOLVED_LOCKED_NAMES = Runtime.resolveMermaidSecureKeys(api.defaultConfig)

/** Every path in mermaid's default configuration whose last name ends in FontFamily. */
const fontFamilyPaths = []
const collectFontFamilyPaths = (value, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return
  }
  for (const [name, nested] of Object.entries(value)) {
    if (/fontfamily$/i.test(name)) {
      fontFamilyPaths.push([...path, name])
    }
    collectFontFamilyPaths(nested, [...path, name])
  }
}
collectFontFamilyPaths(api.defaultConfig, [])

await check('the names the app hands mermaid as locked are exactly these, for this mermaid', async () => {
  const resolved = [...RESOLVED_LOCKED_NAMES].sort()
  const pinned = [...PINNED_LOCKED_NAMES].sort()
  const added = resolved.filter((name) => !pinned.includes(name))
  const gone = pinned.filter((name) => !resolved.includes(name))
  assert(
    added.length === 0 && gone.length === 0,
    `mermaid ${mermaidVersion}: now locked and not pinned [${added.join(', ')}]; pinned and no longer found [${gone.join(', ')}]`,
  )
  assert(new Set(resolved).size === resolved.length, 'a name is on the list twice')
  for (const name of RESOLVED_LOCKED_NAMES) {
    assert(Runtime.isMermaidLockedKey(name), `${name} is on the list and isMermaidLockedKey says it is not locked`)
  }
  counts.lockedNames = resolved.length
  return `${resolved.length} names`
})

/** `['sequence', 'actorFontFamily']` + value -> the YAML and the JSON a text would carry. */
const yamlFor = (path, value) =>
  path
    .map(
      (name, depth) =>
        `${'  '.repeat(depth + 1)}${name}:${depth === path.length - 1 ? ' ' + JSON.stringify(value) : ''}`,
    )
    .join('\n')
const jsonFor = (path, value) => JSON.stringify(path.reduceRight((inner, name) => ({ [name]: inner }), value))

await check(
  'every key in mermaid’s configuration that names a font is refused from a diagram’s text, wherever it sits',
  async () => {
    const marker = 'Srn Contract Font'
    let refused = 0
    for (const path of fontFamilyPaths) {
      const name = path.join('.')
      for (const text of [
        `---\nconfig:\n${yamlFor(path, marker)}\n---\n${FLOW}`,
        `%%{init: ${jsonFor(path, marker)}}%%\n${FLOW}`,
      ]) {
        await draw(text)
        assert(
          at(api.getConfig(), path) !== marker,
          `${name} reached mermaid from ${JSON.stringify(text.split('\n')[0])}…`,
        )
        refused++
      }
    }
    assert(
      fontFamilyPaths.length >= 31,
      `only ${fontFamilyPaths.length} font-family paths found in mermaid's default configuration`,
    )
    counts.fontFamilyPaths = fontFamilyPaths.length
    counts.fontFamilyRefusals = refused
    return `${fontFamilyPaths.length} paths, each as frontmatter and as a directive`
  },
)

await check(
  'still true of this mermaid: with only the fixed names locked, a per-diagram font key reaches it',
  async () => {
    // The control. `fontFamily` alone on the list — which is what the app shipped
    // for a day — left every one of these open.
    const marker = 'Srn Contract Font'
    const open = []
    for (const path of fontFamilyPaths) {
      if (Runtime.MERMAID_APP_SECURE_KEYS.includes(path[path.length - 1])) {
        continue
      }
      await drawWithSecure(`---\nconfig:\n${yamlFor(path, marker)}\n---\n${FLOW}`, [...Runtime.MERMAID_APP_SECURE_KEYS])
      if (at(api.getConfig(), path) === marker) {
        open.push(path.join('.'))
      }
    }
    assert(open.length >= 20, `only ${open.length} per-diagram font keys reach mermaid when they are not on the list`)
    assert(
      open.includes('sequence.actorFontFamily'),
      'sequence.actorFontFamily does not reach mermaid even when unlocked',
    )
    counts.fontFamilyOpenWithoutRule = open.length
    return `${open.length} keys reach mermaid when only the fixed names are locked`
  },
)

await check('a diagram that chooses a per-diagram font is drawn exactly as the same diagram without it', async () => {
  // A journey and a timeline, whose output is the same from one render to the next.
  const cases = [
    ['journey', ['journey', 'taskFontFamily']],
    ['journey', ['journey', 'titleFontFamily']],
    ['timeline', ['timeline', 'taskFontFamily']],
  ]
  for (const [kind, path] of cases) {
    const body = Fixtures.MERMAID_SAMPLE_DIAGRAMS[kind]
    const text = `---\nconfig:\n${yamlFor(path, 'Comic Sans MS')}\n---\n${body}`
    assert((await draw(body)) === (await draw(body)), `${kind}: two renders of the same text differ`)
    assert((await draw(text)) === (await draw(body)), `${path.join('.')}: the drawing changed`)
  }
  // And it is the rule that does it: with only the fixed names locked, a font
  // chosen this way changes a drawing.
  const fixedOnly = [...Runtime.MERMAID_APP_SECURE_KEYS]
  let changed = 0
  for (const [kind, path] of cases) {
    const body = Fixtures.MERMAID_SAMPLE_DIAGRAMS[kind]
    const text = `---\nconfig:\n${yamlFor(path, 'Comic Sans MS')}\n---\n${body}`
    changed += (await drawWithSecure(text, fixedOnly)) === (await drawWithSecure(body, fixedOnly)) ? 0 : 1
  }
  assert(changed > 0, 'no per-diagram font key changes a drawing even when unlocked, so identical proves nothing')
  return `${cases.length} keys drawn; ${changed} of them change the drawing when only the fixed names are locked`
})

await check('no name in mermaid’s type file is a font or a label mode a diagram’s text can still set', async () => {
  const declared = readFileSync(
    join(dirname(require.resolve('mermaid/package.json')), 'dist', 'config.type.d.ts'),
    'utf8',
  )
  const fontNames = [
    ...new Set([...declared.matchAll(/^\s*(\w*[Ff]ont[Ff]amily)\??:/gm)].map((match) => match[1])),
  ].sort()
  assert(fontNames.length >= 27, `only ${fontNames.length} font-family names in the type file`)
  const unlocked = fontNames.filter((name) => !RESOLVED_LOCKED_NAMES.includes(name))
  // Declared, not locked: allowed only if mermaid will not take it from a text
  // at all (it has no default for it, and drops such keys first).
  for (const name of unlocked) {
    await draw(`---\nconfig:\n  ${name}: "Srn Contract Font"\n---\n${FLOW}`)
    assert(api.getConfig()[name] !== 'Srn Contract Font', `${name} is declared, not locked, and reaches mermaid`)
  }
  // The label mode has exactly one name. Another spelling of it would be a way
  // round the lock on `htmlLabels`.
  const htmlNames = [
    ...new Set([...declared.matchAll(/^\s*(\w*(?:[Hh]tml|HTML)\w*)\??:/gm)].map((match) => match[1])),
  ].sort()
  assert(same(htmlNames, ['htmlLabels']), `the type file now has these names for label modes: ${htmlNames.join(', ')}`)
  assert(RESOLVED_LOCKED_NAMES.includes('htmlLabels'), 'htmlLabels is not locked')
  return `${fontNames.length} font names declared, ${unlocked.length} not locked and not settable (${unlocked.join(', ') || 'none'}); label mode: ${htmlNames.join(', ')}`
})

const failed = checks.filter((entry) => !entry.ok)
for (const entry of checks) {
  console.error(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail ? ' — ' + entry.detail : ''}`)
}
console.log(JSON.stringify({ ok: failed.length === 0, mermaid: mermaidVersion, node: process.version, checks, counts }))
process.exit(failed.length === 0 ? 0 : 1)
