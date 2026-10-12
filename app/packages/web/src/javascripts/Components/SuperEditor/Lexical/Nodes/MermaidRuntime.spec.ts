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
import { MERMAID_APP_SECURE_KEYS, renderMermaidDiagram, type MermaidRenderRequest } from './MermaidRuntime'

const BAD_COLOUR = 'Unsupported color format: "#ff"'
const POISONED = '---\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: "#ff"\n---\nflowchart LR\n  P --> Q'
const HEALTHY = 'flowchart LR\n  A --> B'

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
    calls.push(`initialize ${String(config.theme)}`)
    initialized.push(config)
    // The real `setSiteConfig` recomputes the config from the stored
    // directives, and that is where a bad colour throws a second time.
    if (storedDirective === 'bad colour') {
      throw new Error(BAD_COLOUR)
    }
  },
  render: async (id: string, text: string, measureIn: unknown) => {
    calls.push(`render ${id} start`)
    if (text === POISONED) {
      // Stored FIRST, then thrown on — exactly the real order.
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
    expect(calls).toEqual(['reset', 'initialize base', 'render mermaid-7-0 start', 'render mermaid-7-0 end'])
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
    await expect(good).resolves.toEqual({ svg: '<svg id="mermaid-2-0" data-measured-in="body"></svg>' })
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
