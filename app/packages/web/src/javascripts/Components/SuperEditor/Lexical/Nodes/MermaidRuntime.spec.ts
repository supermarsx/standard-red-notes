/**
 * @jest-environment jsdom
 *
 * One diagram must not be able to break, or restyle, the next one.
 *
 * Mermaid's configuration is global: one site config and one list of what the
 * diagram being rendered said about itself. Measured in the running app before
 * MermaidRuntime.ts existed, with a diagram whose frontmatter set a theme colour
 * of `#ff`: every Mermaid block after it, every block in every other note, and
 * the Gantt block all showed `Unsupported color format: "#ff"` until the page
 * was reloaded.
 *
 * The fake below models the two properties of the real library that produced
 * that — `initialize` recomputes from the stored directives, and only `reset`
 * (or the start of a `render`) drops them. The real library is exercised by
 * `scripts/MermaidContract.mjs`; this spec pins the ORDER the runtime calls it
 * in, which is the whole fix.
 */
import {
  MERMAID_APP_SECURE_KEYS,
  mermaidTextMayCarryConfig,
  renderMermaidDiagram,
  type MermaidRenderRequest,
} from './MermaidRuntime'

const BAD_COLOUR = 'Unsupported color format: "#ff"'
const SYNTAX_ERROR = 'Parse error on line 2'
const POISONED = '---\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: "#ff"\n---\nflowchart LR\n  P --> Q'
const HEALTHY = 'flowchart LR\n  A --> B'
const withFrontmatter = (theme: string): string => `---\nconfig:\n  theme: ${theme}\n---\n${HEALTHY}`
const BROKEN_WITH_FRONTMATTER = '---\ntitle: Broken\n---\nflowchart LR\n  A -->'
/** Variables and no `theme` key: a bigger font, and a `background` nobody should act on. */
const VARIABLES_ONLY = `---\nconfig:\n  themeVariables:\n    fontSize: 20px\n---\n${HEALTHY}`
/** `theme: base` with a page of its own — a dark one. */
const BASE_WITH_ITS_OWN_PAGE = `---\nconfig:\n  theme: base\n  themeVariables:\n    background: "#1A1A2E"\n---\n${HEALTHY}`
/** The same, with a page this app must not paint. */
const BASE_WITH_A_HOSTILE_PAGE = `---\nconfig:\n  theme: base\n  themeVariables:\n    background: hostile\n---\n${HEALTHY}`

/** What the fake `parse` reports each text's own config to be — mermaid's answer, not the runtime's. */
const CONFIG_IN_TEXT = new Map<string, Record<string, unknown>>([
  [withFrontmatter('forest'), { theme: 'forest' }],
  [withFrontmatter('neo-dark'), { theme: 'neo-dark' }],
  [withFrontmatter('base'), { theme: 'base', themeVariables: { primaryColor: '#ffcc00' } }],
  [withFrontmatter('nosuch'), { theme: 'nosuch' }],
  ['---\ntitle: Only a title\n---\n' + HEALTHY, {}],
  [VARIABLES_ONLY, { themeVariables: { fontSize: '20px', background: '#000000' } }],
  [BASE_WITH_ITS_OWN_PAGE, { theme: 'base', themeVariables: { background: '#1A1A2E' } }],
  [BASE_WITH_A_HOSTILE_PAGE, { theme: 'base', themeVariables: { background: 'rgb(1,2,3) url(favicon.ico)' } }],
])

/** Every call the runtime made, in order. */
let calls: string[] = []
/** What `initialize` was handed, in call order. */
let initialized: Record<string, unknown>[] = []
/** The directive a diagram left behind, as the real library keeps it. */
let storedDirective: string | null = null
/** A render that does not settle until the test says so. */
let held: { text: string; release: () => void } | null = null
let holdNextRender = false

const fakeMermaid = {
  mermaidAPI: {
    reset: () => {
      calls.push('reset')
      storedDirective = null
    },
  },
  initialize: (config: Record<string, unknown>) => {
    calls.push(`initialize ${String(config.theme)}${config.themeVariables === undefined ? '' : ' +palette'}`)
    initialized.push(config)
    // The real `setSiteConfig` recomputes the config from the stored
    // directives, and that is where a bad colour throws a second time.
    if (storedDirective === 'bad colour') {
      throw new Error(BAD_COLOUR)
    }
  },
  parse: async (text: string) => {
    calls.push('parse')
    if (text === POISONED) {
      // Stored FIRST, then thrown on — exactly the real order.
      storedDirective = 'bad colour'
      throw new Error(BAD_COLOUR)
    }
    if (text === BROKEN_WITH_FRONTMATTER) {
      throw new Error(SYNTAX_ERROR)
    }
    return { diagramType: 'flowchart-v2', config: CONFIG_IN_TEXT.get(text) ?? {} }
  },
  render: async (id: string, text: string, measureIn: unknown) => {
    calls.push(`render ${id} start`)
    if (text === POISONED) {
      storedDirective = 'bad colour'
      throw new Error(BAD_COLOUR)
    }
    if (holdNextRender) {
      holdNextRender = false
      await new Promise<void>((release) => {
        held = { text, release }
      })
    }
    calls.push(`render ${id} end`)
    return { svg: `<svg id="${id}" data-measured-in="${measureIn ? 'host' : 'body'}"></svg>` }
  },
}

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    mermaidAPI: { reset: () => fakeMermaid.mermaidAPI.reset() },
    initialize: (config: Record<string, unknown>) => fakeMermaid.initialize(config),
    parse: (text: string) => fakeMermaid.parse(text),
    render: (id: string, text: string, measureIn: unknown) => fakeMermaid.render(id, text, measureIn),
  },
}))

const request = (overrides: Partial<MermaidRenderRequest> = {}): MermaidRenderRequest => ({
  id: 'mermaid-1-0',
  text: HEALTHY,
  theme: { theme: 'base', themeVariables: { primaryColor: '#241019' } },
  fontFamily: 'Georgia, serif',
  measureIn: undefined,
  ...overrides,
})

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  calls = []
  initialized = []
  storedDirective = null
  held = null
  holdNextRender = false
})

describe('one bad diagram does not break the next', () => {
  it('drops the previous diagram before configuring: reset, initialize, render', async () => {
    await renderMermaidDiagram(request({ id: 'mermaid-7-0' }))
    expect(calls).toEqual(['reset', 'initialize base +palette', 'render mermaid-7-0 start', 'render mermaid-7-0 end'])
  })

  it('renders a healthy diagram after one whose own colour mermaid cannot parse', async () => {
    await expect(renderMermaidDiagram(request({ id: 'mermaid-1-0', text: POISONED }))).rejects.toThrow(BAD_COLOUR)
    // The directive is still stored: this is the state every later diagram used
    // to inherit.
    expect(storedDirective).toBe('bad colour')
    const healthy = await renderMermaidDiagram(request({ id: 'mermaid-2-0' }))
    expect(healthy.svg).toContain('id="mermaid-2-0"')
  })

  it('renders a Gantt chart after it too — the two blocks share the one mermaid', async () => {
    await expect(renderMermaidDiagram(request({ text: POISONED }))).rejects.toThrow(BAD_COLOUR)
    const gantt = await renderMermaidDiagram(
      request({ id: 'gantt-9-0', text: 'gantt\ndateFormat YYYY-MM-DD\nResearch :t0, 2024-01-01, 5d' }),
    )
    expect(gantt.svg).toContain('id="gantt-9-0"')
  })

  it('keeps reporting the bad diagram itself as bad', async () => {
    await expect(renderMermaidDiagram(request({ text: POISONED }))).rejects.toThrow(BAD_COLOUR)
    await expect(renderMermaidDiagram(request({ text: POISONED }))).rejects.toThrow(BAD_COLOUR)
  })
})

describe('one diagram is not drawn with another block’s settings', () => {
  it('does not configure the second diagram until the first has finished rendering', async () => {
    holdNextRender = true
    const first = renderMermaidDiagram(request({ id: 'mermaid-1-0', theme: { theme: 'forest' } }))
    const second = renderMermaidDiagram(request({ id: 'mermaid-2-0', theme: { theme: 'dark' } }))
    await settle()
    // The first is mid-render. Had the second been configured already, the
    // first would be finishing under `dark` — mermaid reads its config again
    // while it draws.
    expect(calls).toEqual(['reset', 'initialize forest', 'render mermaid-1-0 start'])
    held?.release()
    await Promise.all([first, second])
    expect(calls).toEqual([
      'reset',
      'initialize forest',
      'render mermaid-1-0 start',
      'render mermaid-1-0 end',
      'reset',
      'initialize dark',
      'render mermaid-2-0 start',
      'render mermaid-2-0 end',
    ])
  })

  it('a render that fails does not hold up the one waiting behind it', async () => {
    const bad = renderMermaidDiagram(request({ id: 'mermaid-1-0', text: POISONED }))
    const good = renderMermaidDiagram(request({ id: 'mermaid-2-0' }))
    await expect(bad).rejects.toThrow(BAD_COLOUR)
    await expect(good).resolves.toEqual({
      svg: '<svg id="mermaid-2-0" data-measured-in="body"></svg>',
      ownTheme: undefined,
      ownSurface: undefined,
    })
  })
})

describe('a diagram that names its own theme is drawn in that theme', () => {
  it('is configured again WITHOUT the app palette before it is rendered', async () => {
    const result = await renderMermaidDiagram(request({ id: 'mermaid-3-0', text: withFrontmatter('forest') }))
    // The second `initialize` is the fix. With the palette still in it, mermaid
    // computes Forest's colours on top of the application's — light green boxes
    // carrying the app's near-white text.
    expect(calls).toEqual([
      'reset',
      'initialize base +palette',
      'parse',
      'reset',
      'initialize base',
      'render mermaid-3-0 start',
      'render mermaid-3-0 end',
    ])
    expect(initialized[1].themeVariables).toBeUndefined()
    // Everything else the block asked for still reaches mermaid.
    expect(initialized[1]).toMatchObject({ securityLevel: 'strict', fontFamily: 'Georgia, serif' })
    expect(initialized[1].secure).toEqual([...MERMAID_APP_SECURE_KEYS])
    expect(result.ownTheme).toBe('forest')
  })

  it('knows the themes the block’s own picker does not offer', async () => {
    const result = await renderMermaidDiagram(request({ text: withFrontmatter('neo-dark') }))
    expect(initialized).toHaveLength(2)
    expect(result.ownTheme).toBe('neo-dark')
  })

  /**
   * `base` was the one exception, and it was the same defect with a different
   * fill. Measured in the running app's dark theme: `theme: base` with
   * `primaryColor: "#ffcc00"` drew the app's near-white text on that yellow,
   * 1.15 to 1 — `base` takes its text colour from the palette it is handed.
   */
  it('withholds the app palette under `theme: base` too — it is no exception', async () => {
    const result = await renderMermaidDiagram(request({ text: withFrontmatter('base') }))
    expect(calls.filter((call) => call.startsWith('initialize'))).toEqual([
      'initialize base +palette',
      'initialize base',
    ])
    expect(initialized[1].themeVariables).toBeUndefined()
    expect(result.ownTheme).toBe('base')
  })

  it('leaves the app palette alone for variables with NO theme key — mermaid recomputes nothing for those', async () => {
    const result = await renderMermaidDiagram(request({ text: VARIABLES_ONLY }))
    // A bigger font does not make a diagram somebody else's: withholding the
    // palette here would turn it into mermaid's light default for a font size.
    expect(calls.filter((call) => call.startsWith('initialize'))).toEqual(['initialize base +palette'])
    expect(result.ownTheme).toBeUndefined()
    // …and with no theme of its own, a `background` in the text decides nothing.
    expect(result.ownSurface).toBeUndefined()
  })

  it('reports the page a self-themed diagram gave itself, as a colour and nothing else', async () => {
    const dark = await renderMermaidDiagram(request({ text: BASE_WITH_ITS_OWN_PAGE }))
    expect(dark).toMatchObject({ ownTheme: 'base', ownSurface: '#1a1a2e' })
    // A value from somebody's diagram on its way into a `background`: anything
    // that is not, whole, a hex colour or an rgb() triple does not get there.
    const hostile = await renderMermaidDiagram(request({ text: BASE_WITH_A_HOSTILE_PAGE }))
    expect(hostile).toMatchObject({ ownTheme: 'base', ownSurface: undefined })
    // A theme named with no page of its own has only its stock page.
    const forest = await renderMermaidDiagram(request({ text: withFrontmatter('forest') }))
    expect(forest).toMatchObject({ ownTheme: 'forest', ownSurface: undefined })
  })

  it('keeps the app palette for a name mermaid does not know, which it would ignore', async () => {
    const result = await renderMermaidDiagram(request({ text: withFrontmatter('nosuch') }))
    expect(calls.filter((call) => call.startsWith('initialize'))).toEqual(['initialize base +palette'])
    expect(result.ownTheme).toBeUndefined()
  })

  it('has nothing to withhold from a block pinned to a theme, and still reports what was drawn', async () => {
    const result = await renderMermaidDiagram(request({ theme: { theme: 'dark' }, text: withFrontmatter('forest') }))
    expect(calls.filter((call) => call.startsWith('initialize'))).toEqual(['initialize dark'])
    // Mermaid draws Forest here whatever the block says, so the page painted
    // behind it has to be Forest's.
    expect(result.ownTheme).toBe('forest')
  })

  it('does not ask at all when the text cannot carry configuration', async () => {
    const result = await renderMermaidDiagram(request({ text: HEALTHY }))
    expect(calls).not.toContain('parse')
    expect(result.ownTheme).toBeUndefined()
  })

  it('reports mermaid’s own error for a text it cannot parse, and never reaches the render', async () => {
    await expect(renderMermaidDiagram(request({ id: 'mermaid-5-0', text: BROKEN_WITH_FRONTMATTER }))).rejects.toThrow(
      SYNTAX_ERROR,
    )
    expect(calls).toEqual(['reset', 'initialize base +palette', 'parse'])
    await expect(renderMermaidDiagram(request({ id: 'mermaid-6-0' }))).resolves.toMatchObject({ ownTheme: undefined })
  })
})

describe('which texts mermaid is asked about', () => {
  it.each([
    ['a frontmatter block', '---\nconfig:\n  theme: forest\n---\nflowchart LR\n  A --> B'],
    ['an indented frontmatter block', '  ---\n  config:\n    theme: forest\n  ---\nflowchart LR\n  A --> B'],
    ['an init directive', '%%{init: {"theme":"forest"}}%%\nflowchart LR\n  A --> B'],
    ['an initialize directive, mid-text', 'flowchart LR\n  A --> B\n%%{initialize: {"theme":"dark"}}%%'],
    // Three hyphens that are a link, not frontmatter: asked needlessly, never wrongly.
    ['an open link', 'flowchart LR\n  A --- B'],
  ])('%s', (_name, text) => {
    expect(mermaidTextMayCarryConfig(text)).toBe(true)
  })

  it.each([
    ['a plain flowchart', 'graph TD\n  A["Start"] --> B{"Decision"}\n  B -->|Yes| C["OK"]'],
    ['a sequence diagram', 'sequenceDiagram\n  U->>S: Request\n  S-->>U: Response'],
    ['a comment that is not a directive', 'flowchart LR\n  %% theme: forest\n  A --> B'],
    ['the Gantt block’s generated source', 'gantt\ndateFormat YYYY-MM-DD\ntitle Plan\nResearch :t0, 2024-01-01, 5d'],
  ])('not %s', (_name, text) => {
    expect(mermaidTextMayCarryConfig(text)).toBe(false)
  })
})

describe('what reaches mermaid', () => {
  it('is the block’s own theme, palette and font, at the strict security level', async () => {
    await renderMermaidDiagram(request())
    expect(initialized).toHaveLength(1)
    expect(initialized[0]).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: { primaryColor: '#241019' },
      fontFamily: 'Georgia, serif',
    })
  })

  it('carries the locked-key list, whole', async () => {
    await renderMermaidDiagram(request())
    // Mermaid unions this with its own list, so a key missing here is a key the
    // app has stopped asking for — and a list that never arrives locks nothing
    // the app adds to it.
    expect(initialized[0].secure).toEqual([...MERMAID_APP_SECURE_KEYS])
    expect(MERMAID_APP_SECURE_KEYS).toEqual(expect.arrayContaining(['securityLevel', 'maxTextSize', 'maxEdges']))
  })

  it('hands a pinned theme over with no palette at all', async () => {
    await renderMermaidDiagram(request({ theme: { theme: 'forest' } }))
    expect(initialized[0].theme).toBe('forest')
    expect(initialized[0].themeVariables).toBeUndefined()
  })

  it('passes the id, the text and the measuring element through untouched', async () => {
    const host = document.createElement('div')
    const inHost = await renderMermaidDiagram(request({ id: 'mermaid-41-3', measureIn: host }))
    const underBody = await renderMermaidDiagram(request({ id: 'gantt-41-4', measureIn: undefined }))
    // The caller's prefix is what the reduced-motion exception keys on, so the
    // runtime must not rename it on either measuring path.
    expect(inHost.svg).toBe('<svg id="mermaid-41-3" data-measured-in="host"></svg>')
    expect(underBody.svg).toBe('<svg id="gantt-41-4" data-measured-in="body"></svg>')
  })
})
