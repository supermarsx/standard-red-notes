// The REAL mermaid, asked directly.
//
// Every mermaid spec under src/ fakes the library, because jest here does not
// transform ESM in node_modules. A fake can pin the ORDER the app calls mermaid
// in; it cannot say what mermaid does with it. This script can: it loads the
// installed library under Node with jsdom's globals, and drives the app's own
// source files against it — MermaidRuntime.ts, MermaidSettings.ts and
// MermaidGraphBuilder.ts, imported as they are, through Node's type stripping.
//
// What it is evidence of: what a diagram's text MEANS to mermaid, what
// configuration reaches it, and whether a builder edit preserved meaning.
// What it is NOT evidence of: anything drawn. jsdom has no layout, so the one
// step replaced below is `mermaid.render`'s drawing — its configuration half,
// the half every check here is about, runs for real.
//
// It runs inside the existing gate: MermaidContract.spec.ts starts it as a child
// process and reads its exit code and the JSON summary on its last line. Run it
// by hand with `node scripts/MermaidContract.mjs` from app/packages/web.
import { createRequire, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

if (process.features.typescript !== 'strip' && process.features.typescript !== 'transform') {
  console.error(`MermaidContract needs a Node that strips TypeScript types; this is ${process.version}.`)
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
const Runtime = await import(`${NODES}/MermaidRuntime.ts`)
const Settings = await import(`${NODES}/MermaidSettings.ts`)
const Builder = await import(`${NODES}/MermaidGraphBuilder.ts`)
const api = mermaid.mermaidAPI
const mermaidVersion = require('mermaid/package.json').version

// ---------------------------------------------------------------------------
// The one substitution. `mermaidAPI.parse` and `mermaidAPI.render` share their
// first step — `processAndSetConfigs(text)`, which clears the stored directives
// and applies this text's own — and that step is all these checks read. What
// follows it in `render` is layout, which jsdom cannot do.
// ---------------------------------------------------------------------------
if (typeof api.reset !== 'function') {
  console.error('mermaidAPI.reset is gone: MermaidRuntime.ts calls it before every initialize.')
  process.exit(2)
}
mermaid.render = async (id, text) => {
  const { diagramType } = await api.parse(text)
  return { svg: `<svg id="${id}"></svg>`, diagramType }
}

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
const rejection = async (promise) => {
  try {
    await promise
    return null
  } catch (error) {
    return String(error?.message ?? error)
  }
}

const lines = (...parts) => parts.join('\n')
const BACKSLASH = String.fromCharCode(92)
const BACKTICK = String.fromCharCode(96)
const frontmatter = (yaml, body) =>
  '---\nconfig:\n' +
  yaml
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n') +
  '\n---\n' +
  body

const FLOW = lines('flowchart LR', '  A[Alpha] -->|feeds| B[Beta]')
const GANTT = lines('gantt', 'dateFormat YYYY-MM-DD', 'title Plan', 'Research :t0, 2024-01-01, 5d')

// The app's dark palette, as `mermaidAppThemeVariables` builds it from the
// tokens this product ships with.
const TOKENS = {
  background: '#16090f',
  foreground: '#eadde0',
  contrastBackground: '#241019',
  secondaryBackground: '#200c14',
  secondaryContrastBackground: '#321520',
  border: '#94636f',
  passive: '#b2939b',
}
const APP_THEME = Settings.resolveMermaidRenderTheme('app', { isDark: true, tokens: TOKENS })
const FONT = 'Georgia, serif'
let renderSequence = 0
const render = (text, theme = APP_THEME) =>
  Runtime.renderMermaidDiagram({
    id: `mermaid-contract-${renderSequence++}`,
    text,
    theme,
    fontFamily: FONT,
    measureIn: undefined,
  })

/** What mermaid computes for a theme with nothing of the app's in it. */
const pureTheme = (theme) => {
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: FONT })
  return api.getConfig().themeVariables
}
const palette = (variables) => ({
  mainBkg: variables.mainBkg,
  textColor: variables.textColor,
  primaryTextColor: variables.primaryTextColor,
  nodeTextColor: variables.nodeTextColor,
  lineColor: variables.lineColor,
  background: variables.background,
})
const hex6 = (colour) => {
  const value = String(colour).toLowerCase()
  if (value === 'white') {
    return '#ffffff'
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value)
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : value
}

// ===========================================================================
// 1. One bad colour does not break the next diagram.
// ===========================================================================
const POISONED = frontmatter('theme: base\nthemeVariables:\n  primaryColor: "#ff"', lines('flowchart LR', '  P --> Q'))
const POISONED_BY_DIRECTIVE = '%%{init: {"theme":"base","themeVariables":{"primaryColor":"notacolor"}}}%%\n' + FLOW

await check('the defect is real in this mermaid: a bad colour makes the NEXT initialize throw', async () => {
  // Without this, check 2 could pass because mermaid stopped storing the bad
  // directive — and the runtime's reset would be guarding nothing.
  const site = { startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: FONT }
  api.reset()
  mermaid.initialize(site)
  const first = await rejection(mermaid.parse(POISONED))
  assert(first !== null && /Unsupported color format/.test(first), `the poisoned diagram parsed: ${first}`)
  let second = null
  try {
    mermaid.initialize(site)
  } catch (error) {
    second = String(error.message)
  }
  assert(
    second !== null && /Unsupported color format/.test(second),
    `initialize after the bad diagram did not throw (${second})`,
  )
  api.reset()
  mermaid.initialize(site)
  return `first: ${first}; next initialize: ${second}; after reset: ok`
})

await check('through the runtime, a healthy diagram renders after a poisoned one', async () => {
  for (const poisoned of [POISONED, POISONED_BY_DIRECTIVE]) {
    const error = await rejection(render(poisoned))
    assert(
      error !== null && /Unsupported color format/.test(error),
      `the poisoned diagram did not fail as itself: ${error}`,
    )
    const healthy = await render(FLOW)
    assert(healthy.svg.includes('<svg'), 'no svg for the healthy flowchart')
    const again = await rejection(render(poisoned))
    assert(again !== null, 'the poisoned diagram stopped failing')
    const gantt = await render(GANTT)
    assert(gantt.svg.includes('<svg'), 'no svg for the Gantt source')
  }
  return 'frontmatter and init-directive forms'
})

await check('several renders started together each get their own block theme', async () => {
  // Mermaid reads its config while it draws, so the theme in force when each
  // render's own work happens is the one that counts. The stub records it.
  const seen = []
  const original = mermaid.render
  mermaid.render = async (id, text) => {
    const result = await original(id, text)
    await new Promise((resolve) => setTimeout(resolve, 5))
    seen.push(`${id.split('-').pop()}:${api.getConfig().theme}`)
    return result
  }
  try {
    const first = renderSequence
    await Promise.all([
      render(FLOW, { theme: 'forest' }),
      render(FLOW, { theme: 'dark' }),
      render(FLOW, { theme: 'neutral' }),
    ])
    assert(
      same(seen, [`${first}:forest`, `${first + 1}:dark`, `${first + 2}:neutral`]),
      `themes in force while drawing: ${seen.join(', ')}`,
    )
  } finally {
    mermaid.render = original
  }
  return seen.join(', ')
})

// ===========================================================================
// 2. A diagram that names its own theme gets that theme.
// ===========================================================================
await check('the theme list matches the library, name for name', async () => {
  const declared = readFileSync(
    join(dirname(require.resolve('mermaid/package.json')), 'dist', 'config.type.d.ts'),
    'utf8',
  )
  const union = /^\s*theme\?:\s*([^;]+);/m.exec(declared)
  assert(union !== null, 'no `theme?:` union in mermaid/dist/config.type.d.ts')
  const library = union[1]
    .split('|')
    .map((part) => part.trim().replace(/^'|'$/g, ''))
    .filter((name) => name !== 'null')
    .sort()
  const ours = [...Settings.MERMAID_LIBRARY_THEMES].sort()
  assert(
    same(library, ours),
    `mermaid ${mermaidVersion} ships [${library.join(', ')}]; MERMAID_LIBRARY_THEMES is [${ours.join(', ')}]`,
  )
  counts.themes = ours.length
  return ours.join(', ')
})

await check('each theme’s surface and polarity are the ones mermaid computes', async () => {
  const unknown = palette(pureTheme('srn-no-such-theme'))
  for (const theme of Settings.MERMAID_LIBRARY_THEMES) {
    const variables = pureTheme(theme)
    const background = hex6(variables.background)
    assert(
      background === Settings.MERMAID_LIBRARY_THEME_BACKGROUNDS[theme],
      `${theme}: mermaid's background is ${background}, the table says ${Settings.MERMAID_LIBRARY_THEME_BACKGROUNDS[theme]}`,
    )
    const isDark = Settings.isDarkMermaidSurface(background)
    assert(
      isDark === Settings.MERMAID_LIBRARY_THEME_IS_DARK[theme],
      `${theme}: polarity table disagrees with ${background}`,
    )
    // A name mermaid does not know falls back to `default`'s palette. Every
    // listed theme but `default` must therefore differ from that fallback, or
    // the name is one mermaid merely tolerates.
    assert(theme === 'default' || !same(palette(variables), unknown), `${theme}: mermaid does not know this theme`)
  }
  return `${Settings.MERMAID_LIBRARY_THEMES.length} themes`
})

await check('the defect is real in this mermaid: the app palette is forced into a named theme', async () => {
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...APP_THEME, fontFamily: FONT })
  await mermaid.parse(frontmatter('theme: forest', FLOW))
  const forced = api.getConfig().themeVariables
  assert(forced.mainBkg === pureTheme('forest').mainBkg, 'the forest fill is not there at all')
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...APP_THEME, fontFamily: FONT })
  await mermaid.parse(frontmatter('theme: forest', FLOW))
  const text = api.getConfig().themeVariables.textColor
  assert(text === TOKENS.foreground, `expected the app's text colour forced over forest, got ${text}`)
  return `forest fill ${forced.mainBkg} with text ${text}`
})

await check('through the runtime, every theme but base is drawn clean', async () => {
  let checked = 0
  for (const theme of Settings.MERMAID_LIBRARY_THEMES) {
    if (theme === 'base') {
      continue
    }
    const pure = palette(pureTheme(theme))
    for (const text of [frontmatter(`theme: ${theme}`, FLOW), `%%{init: {"theme":"${theme}"}}%%\n${FLOW}`]) {
      const result = await render(text)
      const drawn = palette(api.getConfig().themeVariables)
      assert(result.ownTheme === theme, `${theme}: the runtime reported ${result.ownTheme}`)
      assert(
        same(drawn, pure),
        `${theme}: drawn with ${JSON.stringify(drawn)}, mermaid's own is ${JSON.stringify(pure)}`,
      )
      assert(api.getConfig().fontFamily === FONT, `${theme}: the app's font did not reach mermaid`)
      checked++
    }
  }
  counts.ownThemeRenders = checked
  return `${checked} renders`
})

await check('`theme: base` and unknown names keep the app palette', async () => {
  const own = await render(frontmatter('theme: base\nthemeVariables:\n  primaryColor: "#ffcc00"', FLOW))
  let variables = api.getConfig().themeVariables
  assert(own.ownTheme === undefined, `base reported as ${own.ownTheme}`)
  assert(variables.mainBkg === '#ffcc00', `the diagram's own colour was not applied: ${variables.mainBkg}`)
  assert(variables.textColor === TOKENS.foreground, `the app's text colour was dropped: ${variables.textColor}`)
  for (const name of ['nosuch', 'null']) {
    const unknown = await render(frontmatter(`theme: "${name}"`, FLOW))
    variables = api.getConfig().themeVariables
    assert(unknown.ownTheme === undefined, `${name} reported as ${unknown.ownTheme}`)
    assert(variables.textColor === TOKENS.foreground, `${name}: the app palette was dropped`)
  }
  const plain = await render(FLOW)
  assert(
    plain.ownTheme === undefined && api.getConfig().themeVariables.background === TOKENS.background,
    'a plain diagram lost the app palette',
  )
  return 'base with its own colour, nosuch, null, and no theme at all'
})

await check('a block pinned to a theme reports the theme its text draws instead', async () => {
  const result = await render(frontmatter('theme: forest', FLOW), { theme: 'dark' })
  assert(result.ownTheme === 'forest', `reported ${result.ownTheme}`)
  assert(same(palette(api.getConfig().themeVariables), palette(pureTheme('forest'))), 'not drawn as forest')
})

// ===========================================================================
// 3. Which texts mermaid has to be asked about.
// ===========================================================================
await check('no text mermaid finds config in is turned away by the pre-check', async () => {
  const texts = {
    plain: FLOW,
    'open link': lines('flowchart LR', '  A --- B'),
    'comment mentioning a theme': lines('flowchart LR', '  %% theme: forest', '  A --> B'),
    'gantt block source': GANTT,
    frontmatter: frontmatter('theme: forest', FLOW),
    'frontmatter, indented': lines('  ---', '  config:', '    theme: forest', '  ---', FLOW),
    'frontmatter, title only': lines('---', 'title: T', '---', FLOW),
    'frontmatter, CRLF': frontmatter('theme: forest', FLOW).replace(/\n/g, '\r\n'),
    'init directive': '%%{init: {"theme":"neutral"}}%%\n' + FLOW,
    'initialize directive': '%%{initialize: {"theme":"dark"}}%%\n' + FLOW,
    'directive after the body': FLOW + '\n%%{init: {"theme":"dark"}}%%',
    'directive with single quotes': "%%{init: {'theme':'forest'}}%%\n" + FLOW,
    'directive with an escaped key': '%%{init: {"' + BACKSLASH + 'u0074heme":"dark"}}%%\n' + FLOW,
    'wrap directive': '%%{wrap}%%\n' + FLOW,
    'directive in a sequence diagram': '%%{init: {"theme":"forest"}}%%\nsequenceDiagram\n  A->>B: hi',
  }
  let withConfig = 0
  let asked = 0
  for (const [name, text] of Object.entries(texts)) {
    api.reset()
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    const { config } = await mermaid.parse(text)
    const carries = Object.keys(config ?? {}).length > 0
    const mayCarry = Runtime.mermaidTextMayCarryConfig(text)
    withConfig += carries ? 1 : 0
    asked += mayCarry ? 1 : 0
    assert(!carries || mayCarry, `"${name}" carries ${JSON.stringify(config)} and the pre-check would not have asked`)
  }
  assert(withConfig >= 9, `only ${withConfig} corpus texts carry config: the corpus has stopped testing the pre-check`)
  assert(asked < Object.keys(texts).length, 'the pre-check asks about everything, which defeats its purpose')
  counts.preCheckTexts = Object.keys(texts).length
  return `${withConfig} of ${Object.keys(texts).length} carry config; ${asked} would be asked`
})

await check(
  'a theme named with an escaped key is honoured, which is why the pre-check is not a word search',
  async () => {
    const text = '%%{init: {"' + BACKSLASH + 'u0074heme":"forest"}}%%\n' + FLOW
    assert(!text.includes('theme'), 'the fixture spells the word after all')
    const result = await render(text)
    assert(result.ownTheme === 'forest', `reported ${result.ownTheme}`)
  },
)

// ===========================================================================
// 4. The keys a diagram's text may not set — driven by the ONE constant.
// ===========================================================================
const PROBES = [
  {
    key: 'themeCSS',
    yaml: 'themeCSS: ".node rect { fill: red }"',
    reached: (c) => c.themeCSS === '.node rect { fill: red }',
  },
  { key: 'fontFamily', yaml: 'fontFamily: "Comic Sans MS"', reached: (c) => c.fontFamily === 'Comic Sans MS' },
  { key: 'htmlLabels', yaml: 'htmlLabels: false', reached: (c) => c.htmlLabels === false },
  { key: 'logLevel', yaml: 'logLevel: 1', reached: (c) => c.logLevel === 1 },
  { key: 'deterministicIds', yaml: 'deterministicIds: true', reached: (c) => c.deterministicIds === true },
  { key: 'arrowMarkerAbsolute', yaml: 'arrowMarkerAbsolute: true', reached: (c) => c.arrowMarkerAbsolute === true },
  { key: 'securityLevel', yaml: 'securityLevel: loose', reached: (c) => c.securityLevel === 'loose' },
  { key: 'startOnLoad', yaml: 'startOnLoad: true', reached: (c) => c.startOnLoad === true },
  { key: 'maxTextSize', yaml: 'maxTextSize: 9999999', reached: (c) => c.maxTextSize === 9999999 },
  { key: 'maxEdges', yaml: 'maxEdges: 99999', reached: (c) => c.maxEdges === 99999 },
  {
    key: 'suppressErrorRendering',
    yaml: 'suppressErrorRendering: true',
    reached: (c) => c.suppressErrorRendering === true,
  },
  { key: 'secure', yaml: 'secure: []', reached: (c) => Array.isArray(c.secure) && c.secure.length === 0 },
]
const LOCKED = [...Runtime.MERMAID_APP_SECURE_KEYS]
const knownKeys = new Set()
const collectKeys = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      knownKeys.add(key)
      collectKeys(nested)
    }
  }
}
collectKeys(api.defaultConfig)

await check('a key is refused exactly when it is in MERMAID_APP_SECURE_KEYS', async () => {
  // THE test of the one-line change. Add a key to the constant and its row here
  // flips from "must reach mermaid's config" to "must not": nothing in this
  // file has to change for that key to be proved locked.
  const outcome = []
  for (const probe of PROBES) {
    await render(frontmatter(probe.yaml, FLOW))
    const reached = probe.reached(api.getConfig())
    const locked = LOCKED.includes(probe.key)
    assert(
      reached === !locked,
      `${probe.key} is ${locked ? 'in' : 'not in'} the list but ${reached ? 'reached' : 'did not reach'} mermaid's config`,
    )
    outcome.push(`${probe.key}:${locked ? 'locked' : 'honoured'}`)
  }
  counts.secureProbes = PROBES.length
  counts.lockedKeys = LOCKED.length
  return outcome.join(' ')
})

await check('every key in the list is one mermaid has, and none gets through by any spelling', async () => {
  for (const key of LOCKED) {
    assert(knownKeys.has(key), `"${key}" is not a mermaid config key: a misspelt entry locks nothing`)
    if (PROBES.some((probe) => probe.key === key)) {
      continue
    }
    // No bespoke probe for this key: set it to a marker and look for the marker.
    await render(frontmatter(`${key}: "srn-contract-marker"`, FLOW))
    assert(api.getConfig()[key] !== 'srn-contract-marker', `"${key}" is in the list and still reached mermaid's config`)
  }
  // And the marker technique can fail: an unlocked key carries it through.
  const unlocked = PROBES.find((probe) => !LOCKED.includes(probe.key) && probe.key === 'themeCSS')
  if (unlocked) {
    await render(frontmatter('themeCSS: "srn-contract-marker"', FLOW))
    assert(api.getConfig().themeCSS === 'srn-contract-marker', 'the marker did not reach config for an unlocked key')
  }
  return LOCKED.join(', ')
})

await check(
  'what a text cannot set whatever the list says: the sanitiser’s config, and keys mermaid has no default for',
  async () => {
    // Not locked by the app and not settable either: mermaid drops a directive key
    // it has no default for before the secure list is even consulted. Pinned so
    // that an upgrade which starts honouring one of them is noticed — the first
    // decides what HTML survives in a label.
    await render(frontmatter('dompurifyConfig:\n  ADD_TAGS: ["script"]\naltFontFamily: "Comic Sans MS"', FLOW))
    const config = api.getConfig()
    assert(
      config.dompurifyConfig === undefined,
      `dompurifyConfig reached mermaid's config: ${JSON.stringify(config.dompurifyConfig)}`,
    )
    assert(config.altFontFamily !== 'Comic Sans MS', 'altFontFamily reached mermaid’s config')
    return 'dompurifyConfig, altFontFamily'
  },
)

await check('mermaid unions the app’s list with its own, so adding a key locks it', async () => {
  // The library behaviour the one-line change relies on, asked directly: the
  // same text, the same call, with one more key in `secure`.
  const candidate = PROBES.find((probe) => !LOCKED.includes(probe.key))
  if (!candidate) {
    return 'every probed key is already locked'
  }
  const text = frontmatter(candidate.yaml, FLOW)
  const site = { startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: FONT }
  api.reset()
  mermaid.initialize({ ...site, secure: [...LOCKED] })
  await mermaid.parse(text)
  assert(candidate.reached(api.getConfig()), `${candidate.key} did not reach config while unlocked`)
  api.reset()
  mermaid.initialize({ ...site, secure: [...LOCKED, candidate.key] })
  await mermaid.parse(text)
  assert(!candidate.reached(api.getConfig()), `${candidate.key} reached config although it was in secure`)
  const stillLocked = api.getSiteConfig().secure
  for (const builtIn of ['securityLevel', 'maxTextSize', 'maxEdges']) {
    assert(stillLocked.includes(builtIn), `${builtIn} fell out of mermaid's own list`)
  }
  return `${candidate.key}: honoured without, refused with`
})

// ===========================================================================
// 5. A builder edit preserves what the diagram means.
// ===========================================================================
const reading = async (source) => {
  const diagram = await api.getDiagramFromText(source)
  const db = diagram.db
  return {
    direction: db.getDirection() ?? 'TB',
    nodes: [...db.getVertices().values()].map((vertex) => ({
      id: vertex.id,
      // An undeclared node has no type and a declared box is `square`; mermaid
      // draws both as the same rectangle (`getTypeFromVertex`).
      shape: vertex.type === undefined || vertex.type === 'square' ? 'square' : vertex.type,
      text: vertex.text,
      markdown: vertex.labelType === 'markdown',
      classes: [...(vertex.classes ?? [])],
      styles: [...(vertex.styles ?? [])],
    })),
    edges: db.getEdges().map((edge) => ({
      from: edge.start,
      to: edge.end,
      stroke: edge.stroke,
      type: edge.type,
      length: edge.length,
      text: edge.text ?? '',
      style: [...(edge.style ?? [])],
    })),
  }
}

/** Every flowchart form worth having an opinion about. `mustModel` entries may not be refused. */
const CORPUS = [
  ['the block’s starter', 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]\n  B -->|No| D[Rethink]', true],
  ['flowchart keyword', 'flowchart LR\n  A[Start] --> B[End]', true],
  ['TB header', 'flowchart TB\n  A --> B', true],
  ['no direction', 'flowchart\n  A --> B', true],
  [
    'every modelled shape',
    'flowchart LR\n  A[Box] --> B(Round)\n  C([Pill]) --> D[[Sub]]\n  E[(Db)] --> F((Circle))\n  G{Ask} --> H{{Hex}}',
    true,
  ],
  ['every modelled link', 'flowchart LR\n  A --> B\n  B --- C\n  C -.-> D\n  D ==> E', true],
  [
    'link labels',
    'flowchart LR\n  A[Hard edge] -->|Link text| B(Round edge)\n  B --> C{Decision}\n  C -->|One| D[Result one]',
    true,
  ],
  [
    'quoted labels with awkward starts',
    'flowchart LR\n  A["/path/to/file/"] --> B["(optional)"]\n  C(("(c)")) --> D("-dashed-")\n  E[">= 3"] --> F["|x|"]',
    true,
  ],
  ['label with parens quoted', 'flowchart LR\n  A["call(x)"] --> B', true],
  ['entity code', 'flowchart LR\n  A["a #quot;q#quot; b"] --> B', true],
  ['br in label', 'flowchart LR\n  A["line1<br/>line2"] --> B', true],
  ['markdown string label', 'flowchart LR\n  A["' + BACKTICK + '**bold** text' + BACKTICK + '"] --> B', true],
  ['spaced label', 'flowchart LR\n  A[ spaced ] --> B', true],
  ['label given twice', 'flowchart LR\n  A[Start] --> B\n  A[Renamed later]', true],
  ['shape given twice', 'flowchart LR\n  A(Round) --> B\n  A[Box later]', true],
  ['declared twice in one family', 'flowchart LR\n  A[x]\n  A --> B\n  B{y}\n  B{{z}}', true],
  ['declared after use', 'flowchart LR\n  A --> B\n  A[Start]\n  A --> C\n  A', true],
  ['node id ending in a keyword', 'graph TD\n  A["a"]\n  A --> end1\n  end1["x"]', true],
  ['classDef + class', 'flowchart LR\n  A --> B\n  classDef hot fill:#f96\n  class A hot', true],
  ['style statement', 'flowchart LR\n  A --> B\n  style A fill:#f9f,stroke:#333,stroke-width:4px', true],
  ['click statement', 'flowchart LR\n  A --> B\n  click A href "https://example.com"', true],
  ['linkStyle', 'flowchart LR\n  A --> B\n  B --> C\n  linkStyle 1 stroke:#f00', true],
  ['linkStyle list', 'flowchart LR\n  A --> B\n  B --> C\n  linkStyle 0,1 stroke:#f00', true],
  ['linkStyle default', 'flowchart LR\n  A --> B\n  B --> C\n  linkStyle default stroke:#f00', true],
  ['linkStyle interpolate', 'flowchart LR\n  A --> B\n  B --> C\n  linkStyle 1 interpolate basis stroke:#f00', true],
  ['comment mid-body', 'flowchart LR\n  A --> B\n  %% step two\n  B --> C', true],
  ['frontmatter title + config', '---\ntitle: T\nconfig:\n  theme: forest\n---\nflowchart LR\n  A --> B', true],
  ['init directive', '%%{init: {"theme":"forest"}}%%\nflowchart LR\n  A --> B', true],
  // The five the builder used to rewrite, and the rest of what it does not model.
  ['parallelogram', 'flowchart TD\n  A[/Input/] --> B[' + BACKSLASH + 'Output' + BACKSLASH + ']', false],
  ['trapezoids', 'flowchart TD\n  A[/Trap' + BACKSLASH + '] --> B[' + BACKSLASH + 'Trap/]', false],
  ['double circle', 'flowchart LR\n  A(((Stop))) --> B', false],
  ['ellipse', 'flowchart LR\n  A(-Oval-) --> B', false],
  ['box with properties', 'flowchart LR\n  A[|borders:lt|Text] --> B', false],
  ['flag', 'flowchart LR\n  A>Flag] --> B', false],
  ['chained links', 'flowchart LR\n  A --> B --> C', false],
  ['ampersand fan-out', 'flowchart TD\n  A --> B & C', false],
  ['text on the link', 'flowchart LR\n  A -- yes --> B', false],
  ['semicolons', 'graph TD;\n  A-->B;\n  A-->C;', false],
  ['subgraph', 'flowchart TB\n  subgraph one\n    a1 --> a2\n  end\n  c1 --> a2', false],
  ['class shorthand', 'flowchart LR\n  A:::hot --> B\n  classDef hot fill:#f96', false],
  ['new shape syntax', 'flowchart TD\n  A@{ shape: cyl, label: "DB" } --> B', false],
  ['circle and cross ends', 'flowchart LR\n  A --o B\n  B --x C', false],
  ['bidirectional', 'flowchart LR\n  A <--> B', false],
  ['long link', 'flowchart TD\n  A ---> B', false],
  ['invisible link', 'flowchart LR\n  A ~~~ B', false],
  ['dotted with text', 'flowchart LR\n  A -. text .-> B', false],
  ['thick with text', 'flowchart LR\n  A == text ==> B', false],
  ['hyphenated id', 'flowchart LR\n  my-node[Hi] --> other-node', false],
  ['direction in body', 'flowchart LR\n  direction TB\n  A --> B', false],
]

await check(
  'a no-op round trip through the builder preserves mermaid’s reading of every source it accepts',
  async () => {
    let modelled = 0
    let refused = 0
    const changed = []
    const wronglyRefused = []
    for (const [name, source, mustModel] of CORPUS) {
      const before = await reading(source)
      const analysis = Builder.analyzeMermaidSource(source)
      if (!analysis.model) {
        refused++
        if (mustModel) {
          wronglyRefused.push(`${name}: ${analysis.blockers.join(' | ')}`)
        }
        continue
      }
      modelled++
      const regenerated = Builder.buildFlowchartSource(analysis.model)
      let after
      try {
        after = await reading(regenerated)
      } catch (error) {
        changed.push(`${name}: mermaid rejects the regenerated source (${String(error.message).split('\n')[0]})`)
        continue
      }
      if (!same(before, after)) {
        changed.push(
          `${name}: ${JSON.stringify(before.nodes)} ${JSON.stringify(before.edges)} became ${JSON.stringify(after.nodes)} ${JSON.stringify(after.edges)}`,
        )
      }
    }
    counts.roundTripSources = CORPUS.length
    counts.roundTripModelled = modelled
    counts.roundTripRefused = refused
    assert(changed.length === 0, `meaning changed for ${changed.length}: ${changed.join(' || ')}`)
    assert(wronglyRefused.length === 0, `refused what it must model: ${wronglyRefused.join(' || ')}`)
    assert(modelled >= 25, `only ${modelled} sources were modelled: the round trip has stopped being exercised`)
    return `${modelled} modelled and unchanged, ${refused} refused, of ${CORPUS.length}`
  },
)

await check('the four silent corruptions: refused, or read as mermaid reads them', async () => {
  const refusedNow = ['parallelogram', 'trapezoids', 'double circle']
  for (const name of refusedNow) {
    const source = CORPUS.find((entry) => entry[0] === name)[1]
    const analysis = Builder.analyzeMermaidSource(source)
    assert(analysis.model === null, `${name} is modelled again`)
    assert(
      analysis.blockers.every((blocker) => /a shape the builder does not model/.test(blocker)),
      `${name}: ${analysis.blockers.join(' | ')}`,
    )
  }
  const relabelled = CORPUS.find((entry) => entry[0] === 'label given twice')[1]
  const before = await reading(relabelled)
  const after = await reading(Builder.buildFlowchartSource(Builder.analyzeMermaidSource(relabelled).model))
  assert(
    before.nodes[0].text === 'Renamed later' && after.nodes[0].text === 'Renamed later',
    `label: ${before.nodes[0].text} -> ${after.nodes[0].text}`,
  )

  // Renaming B to A2 beside a node A: one commit, and only the name changes.
  const three = 'graph TD\n  A["Start"]\n  B["End"]\n  C["Other"]\n  A --> B\n  C --> A'
  const model = Builder.analyzeMermaidSource(three).model
  const renamed = Builder.commitGraphNodeId(model, 1, 'A2')
  assert(renamed.refusal === null, `refused: ${renamed.refusal}`)
  const original = await reading(three)
  const result = await reading(Builder.buildFlowchartSource(renamed.model))
  const expected = JSON.parse(JSON.stringify(original).replace(/"B"/g, '"A2"'))
  expected.nodes[1].text = 'End'
  assert(same(result, expected), `rename changed more than the name: ${JSON.stringify(result.edges)}`)
  assert(Builder.commitGraphNodeId(model, 1, 'A').refusal !== null, 'a duplicate id was accepted')
  assert(Builder.commitGraphNodeId(model, 1, '').refusal !== null, 'an empty id was accepted')
  return 'three refused by shape, the label kept, the rename exact'
})

await check('removing a link leaves every surviving link with the style it had', async () => {
  const sources = [
    'flowchart LR\n  A --> B\n  B --> C\n  linkStyle 1 stroke:#f00,stroke-width:4px',
    'flowchart LR\n  A --> B\n  B --> C\n  C --> D\n  linkStyle 1 stroke:#f00\n  linkStyle 0,2 stroke-width:4px\n  linkStyle default stroke:#333',
    'flowchart LR\n  A --> B\n  B --> C\n  C --> D\n  linkStyle 2 interpolate basis stroke:#00f',
  ]
  let removals = 0
  const key = (edge) => `${edge.from}>${edge.to}`
  for (const source of sources) {
    const model = Builder.analyzeMermaidSource(source).model
    const before = await reading(source)
    const operations = model.edges.map((_, index) => ['link ' + index, Builder.removeGraphEdge(model, index)])
    model.nodes.forEach((_, index) => operations.push(['node ' + index, Builder.removeGraphNode(model, index)]))
    for (const [what, next] of operations) {
      const regenerated = Builder.buildFlowchartSource(next)
      let after
      try {
        after = await reading(regenerated)
      } catch (error) {
        throw new Error(
          `removing ${what}: mermaid rejects ${JSON.stringify(regenerated)} (${String(error.message).split('\n')[0]})`,
        )
      }
      for (const edge of after.edges) {
        const was = before.edges.find((candidate) => key(candidate) === key(edge))
        assert(
          was && same(was.style, edge.style),
          `removing ${what}: ${key(edge)} was styled ${JSON.stringify(was?.style)}, now ${JSON.stringify(edge.style)}`,
        )
      }
      removals++
    }
  }
  counts.styledRemovals = removals
  return `${removals} removals over ${sources.length} styled diagrams`
})

await check('the defect is real in this mermaid: a linkStyle past the end stops the diagram', async () => {
  const error = await rejection(reading('flowchart LR\n  B --> C\n  linkStyle 1 stroke:#f00'))
  assert(error !== null, 'mermaid now tolerates a linkStyle naming a link that is not there')
  return error.split('\n')[0]
})

await check('every template is a diagram mermaid accepts', async () => {
  for (const template of Builder.MERMAID_TEMPLATES) {
    await mermaid.parse(template.source)
  }
  return `${Builder.MERMAID_TEMPLATES.length} templates`
})

const failed = checks.filter((entry) => !entry.ok)
for (const entry of checks) {
  console.error(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail ? ' — ' + entry.detail : ''}`)
}
console.log(JSON.stringify({ ok: failed.length === 0, mermaid: mermaidVersion, node: process.version, checks, counts }))
process.exit(failed.length === 0 ? 0 : 1)
