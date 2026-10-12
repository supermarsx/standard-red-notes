/**
 * One-click looks: what each preset writes for each kind of diagram, that it
 * replaces rather than layers, that Reset gives the text back to the byte, and
 * that "which preset is this" is read from the text and never stored.
 */
import { applyMermaidLook, applyMermaidTextSize, reshuffleMermaidSketch } from './MermaidConfigCatalog'
import { MERMAID_SAMPLE_DIAGRAMS } from './MermaidCustomise.fixtures'
import { MermaidThemeMode } from './MermaidSettings'
import { listMermaidFrontmatterConfig, readMermaidSourceConfig } from './MermaidSourceConfig'
import {
  activeMermaidStylePreset,
  applyMermaidStylePreset,
  MERMAID_STYLE_PRESET_IDS,
  MERMAID_STYLE_PRESETS,
  mermaidCustomisationCanReset,
  mermaidStylePreset,
  mermaidStylePresetAvailability,
  MermaidStylePresetId,
  resetMermaidCustomisation,
} from './MermaidStylePresets'

const DIAGRAMS = MERMAID_SAMPLE_DIAGRAMS
const KINDS = Object.keys(DIAGRAMS)
const FLOW = DIAGRAMS.flowchart

const fm = (yaml: string, body: string) => `---\n${yaml}\n---\n${body}`

const applied = (text: string, id: MermaidStylePresetId): { code: string; themeMode: MermaidThemeMode } => {
  const edit = applyMermaidStylePreset(text, id)
  if (!edit.ok) {
    throw new Error(`${id} refused (${edit.refusal.code}): ${edit.refusal.message}`)
  }
  return { code: edit.code, themeMode: edit.themeMode }
}

const written = (text: string): Record<string, unknown> =>
  Object.fromEntries(listMermaidFrontmatterConfig(readMermaidSourceConfig(text)).map((item) => [item.key, item.value]))

describe('the presets on offer', () => {
  it('are the six named ones, each with a label and a line saying what it does', () => {
    expect(MERMAID_STYLE_PRESETS.map((preset) => preset.id)).toEqual([...MERMAID_STYLE_PRESET_IDS])
    expect(MERMAID_STYLE_PRESETS.map((preset) => preset.label)).toEqual([
      'App',
      'Sketch',
      'Compact',
      'Presentation',
      'Monochrome',
      'Print-safe',
    ])
    for (const preset of MERMAID_STYLE_PRESETS) {
      expect(preset.description.trim().length).toBeGreaterThan(10)
      expect(mermaidStylePreset(preset.id)).toBe(preset)
    }
  })

  it('include one that writes nothing: the way back', () => {
    expect(mermaidStylePreset('app').bundle).toEqual({})
  })
})

/**
 * THE four kinds the owner will look at, and exactly what each preset writes
 * into each. Spelled out rather than derived, so a change to a preset or to a
 * kind's keys shows up here as the text a person would see in the code pane.
 */
describe('what each preset writes', () => {
  const EXPECTED: Record<string, Record<MermaidStylePresetId, string | null>> = {
    flowchart: {
      app: '',
      sketch: 'config:\n  look: handDrawn\n  handDrawnSeed: 7',
      compact:
        'config:\n  themeVariables:\n    fontSize: "14px"\n  flowchart:\n    nodeSpacing: 30\n    rankSpacing: 30',
      presentation:
        'config:\n  themeVariables:\n    fontSize: "20px"\n  flowchart:\n    nodeSpacing: 80\n    rankSpacing: 80',
      monochrome: 'config:\n  theme: neutral',
      print: 'config:\n  theme: default',
    },
    sequence: {
      app: '',
      sketch: null,
      compact: 'config:\n  fontSize: 14\n  sequence:\n    actorMargin: 30\n    boxMargin: 6',
      presentation: 'config:\n  fontSize: 20\n  sequence:\n    actorMargin: 80\n    boxMargin: 16',
      monochrome: 'config:\n  theme: neutral',
      print: 'config:\n  theme: default',
    },
    pie: {
      app: '',
      sketch: null,
      compact:
        'config:\n  themeVariables:\n    pieSectionTextSize: "14.875px"\n    pieLegendTextSize: "14.875px"\n    pieTitleTextSize: "21.875px"',
      presentation:
        'config:\n  themeVariables:\n    pieSectionTextSize: "21.25px"\n    pieLegendTextSize: "21.25px"\n    pieTitleTextSize: "31.25px"',
      monochrome: 'config:\n  theme: neutral',
      print: 'config:\n  theme: default',
    },
    mindmap: {
      app: '',
      sketch: 'config:\n  look: handDrawn\n  handDrawnSeed: 7',
      compact: 'config:\n  themeVariables:\n    fontSize: "14px"\n  mindmap:\n    padding: 6',
      presentation: 'config:\n  themeVariables:\n    fontSize: "20px"\n  mindmap:\n    padding: 16',
      monochrome: 'config:\n  theme: neutral',
      print: 'config:\n  theme: default',
    },
  }

  const cases = Object.entries(EXPECTED).flatMap(([kind, byPreset]) =>
    MERMAID_STYLE_PRESET_IDS.map((id) => ({ kind, id, yaml: byPreset[id] })),
  )

  it.each(cases)('$id on a $kind', ({ kind, id, yaml }) => {
    const base = DIAGRAMS[kind]
    if (yaml === null) {
      // Mermaid draws this kind the same in either look, so the preset is not
      // offered there — and says so, rather than being a button that does nothing.
      expect(mermaidStylePresetAvailability(id, base)).toEqual({
        available: false,
        reason: expect.stringContaining(`${mermaidStylePreset(id).label} changes nothing for`),
      })
      const refused = applyMermaidStylePreset(base, id)
      expect(refused).toMatchObject({ ok: false, refusal: { code: 'invalid-change' } })
      return
    }
    expect(mermaidStylePresetAvailability(id, base)).toEqual({ available: true })
    expect(applied(base, id).code).toBe(yaml === '' ? base : fm(yaml, base))
  })

  it('covered every preset on all four kinds', () => {
    expect(cases).toHaveLength(24)
  })
})

describe('a preset is a complete look, on every kind', () => {
  const cases = KINDS.flatMap((kind) => MERMAID_STYLE_PRESET_IDS.map((id) => ({ kind, id })))

  it.each(cases)('$id on $kind: applied, recognised, and taken away again to the byte', ({ kind, id }) => {
    const base = DIAGRAMS[kind]
    const availability = mermaidStylePresetAvailability(id, base)
    if (!availability.available) {
      expect(applyMermaidStylePreset(base, id).ok).toBe(false)
      expect(activeMermaidStylePreset(base, 'app')).toBe('app')
      return
    }
    const after = applied(base, id)
    // The diagram itself is untouched.
    expect(after.code.endsWith(base)).toBe(true)
    // The panel then shows this preset as the active one — worked out from the
    // text and the block's theme, nothing stored.
    expect(activeMermaidStylePreset(after.code, after.themeMode)).toBe(id)
    // Reset gives back the original text, byte for byte, and an app-themed block.
    expect(resetMermaidCustomisation(after.code)).toEqual({ ok: true, code: base, themeMode: 'app' })
    // So does the App preset: it is the same edit.
    expect(applyMermaidStylePreset(after.code, 'app')).toEqual({ ok: true, code: base, themeMode: 'app' })
  })

  it('offers App, Monochrome and Print-safe on every kind', () => {
    for (const kind of KINDS) {
      for (const id of ['app', 'monochrome', 'print'] as MermaidStylePresetId[]) {
        expect([kind, id, mermaidStylePresetAvailability(id, DIAGRAMS[kind]).available]).toEqual([kind, id, true])
      }
    }
  })

  it('offers Sketch only where mermaid draws a hand-drawn look', () => {
    const offered = KINDS.filter((kind) => mermaidStylePresetAvailability('sketch', DIAGRAMS[kind]).available)
    expect(offered.sort()).toEqual(['class', 'er', 'flowchart', 'mindmap', 'requirement', 'state'])
  })

  it('does not offer Compact or Presentation where neither size nor spacing can be set', () => {
    for (const id of ['compact', 'presentation'] as MermaidStylePresetId[]) {
      const missing = KINDS.filter((kind) => !mermaidStylePresetAvailability(id, DIAGRAMS[kind]).available)
      expect(missing.sort()).toEqual(['c4', 'quadrant', 'sankey', 'xychart'])
    }
    expect(mermaidStylePresetAvailability('compact', DIAGRAMS.quadrant)).toEqual({
      available: false,
      reason: 'Compact changes nothing for a quadrant chart: mermaid has none of its options for that kind.',
    })
  })
})

describe('applying one preset after another', () => {
  it('replaces the first: Monochrome after Presentation is Monochrome alone', () => {
    const presentation = applied(FLOW, 'presentation')
    const monochrome = applied(presentation.code, 'monochrome')
    expect(monochrome.code).toBe(fm('config:\n  theme: neutral', FLOW))
    expect(written(monochrome.code)).toEqual({ theme: 'neutral' })
  })

  it('reaches every preset from every preset in one step, with the same text either way', () => {
    for (const from of MERMAID_STYLE_PRESET_IDS) {
      for (const to of MERMAID_STYLE_PRESET_IDS) {
        const direct = applied(FLOW, to)
        const viaFrom = applied(applied(FLOW, from).code, to)
        expect([from, to, viaFrom]).toEqual([from, to, direct])
      }
    }
  })

  it('keeps everything in the frontmatter that the panel does not manage', () => {
    const before = fm(
      'title: Plan\nconfig:\n  layout: dagre\n  themeVariables:\n    primaryColor: "#ffcc00"\n  sequence:\n    mirrorActors: false',
      FLOW,
    )
    for (const id of MERMAID_STYLE_PRESET_IDS) {
      const after = applied(before, id).code
      const kept = written(after)
      expect([id, kept.layout, kept['themeVariables.primaryColor'], kept['sequence.mirrorActors']]).toEqual([
        id,
        'dagre',
        '#ffcc00',
        false,
      ])
      expect(after.startsWith('---\ntitle: Plan\nconfig:\n  layout: dagre\n')).toBe(true)
      // And Reset from there is the frontmatter the person had.
      expect(resetMermaidCustomisation(after)).toEqual({ ok: true, code: before, themeMode: 'app' })
    }
  })
})

describe('the block’s own theme', () => {
  it('follows the app for a preset with no theme, unpinning a block that was pinned', () => {
    for (const id of ['app', 'sketch', 'compact', 'presentation'] as MermaidStylePresetId[]) {
      expect([id, applied(FLOW, id).themeMode]).toEqual([id, 'app'])
    }
  })

  it('is given the theme a themed preset names, for an older build reading the same note', () => {
    expect(applied(FLOW, 'monochrome').themeMode).toBe('neutral')
    expect(applied(FLOW, 'print').themeMode).toBe('default')
  })
})

describe('which preset a diagram is in', () => {
  it('is App for a diagram nobody has customised', () => {
    for (const kind of KINDS) {
      expect([kind, activeMermaidStylePreset(DIAGRAMS[kind], 'app')]).toEqual([kind, 'app'])
    }
  })

  it('is none once a control has moved away from it', () => {
    const sketch = applied(FLOW, 'sketch')
    const larger = applyMermaidTextSize(sketch.code, sketch.themeMode, 20)
    expect(larger.ok && activeMermaidStylePreset(larger.code, larger.themeMode)).toBeNull()
  })

  it('is none for a block still pinned to a theme the old way, whatever its text', () => {
    expect(activeMermaidStylePreset(FLOW, 'forest')).toBeNull()
  })

  it('is read from the text alone, so the same options typed by hand are the same preset', () => {
    expect(activeMermaidStylePreset(fm('config:\n  theme: "neutral"', FLOW), 'app')).toBe('monochrome')
    expect(activeMermaidStylePreset(`%%{init: {"theme":"neutral"}}%%\n${FLOW}`, 'app')).toBe('monochrome')
    expect(activeMermaidStylePreset(fm('config:\n  look: handDrawn\n  handDrawnSeed: 7', FLOW), 'app')).toBe('sketch')
  })

  it('is still Sketch after the sketch has been redrawn with another seed', () => {
    const sketch = applied(FLOW, 'sketch')
    const redrawn = reshuffleMermaidSketch(sketch.code, sketch.themeMode)
    expect(redrawn.ok && written(redrawn.code)).toEqual({ look: 'handDrawn', handDrawnSeed: 8 })
    expect(redrawn.ok && activeMermaidStylePreset(redrawn.code, redrawn.themeMode)).toBe('sketch')
  })

  it('is not Sketch for the hand-drawn look written without a seed, plus anything else', () => {
    const withTheme = applyMermaidLook(fm('config:\n  theme: forest', FLOW), 'forest', 'handDrawn')
    expect(withTheme.ok && activeMermaidStylePreset(withTheme.code, withTheme.themeMode)).toBeNull()
  })

  it('is none when the frontmatter cannot be read, rather than a guess', () => {
    expect(activeMermaidStylePreset(fm('# mine\nconfig:\n  theme: neutral', FLOW), 'app')).toBeNull()
  })

  it('ignores options the panel does not manage', () => {
    expect(activeMermaidStylePreset(fm('title: Plan\nconfig:\n  layout: dagre\n  theme: neutral', FLOW), 'app')).toBe(
      'monochrome',
    )
  })
})

describe('reset', () => {
  it('has nothing to do on an untouched, app-themed diagram', () => {
    for (const kind of KINDS) {
      expect([kind, mermaidCustomisationCanReset(DIAGRAMS[kind], 'app')]).toEqual([kind, false])
    }
    expect(mermaidCustomisationCanReset(fm('title: Plan\nconfig:\n  layout: dagre', FLOW), 'app')).toBe(false)
  })

  it('has something to do after any preset but App, and nothing after it has run', () => {
    for (const id of MERMAID_STYLE_PRESET_IDS) {
      const after = applied(FLOW, id)
      expect([id, mermaidCustomisationCanReset(after.code, after.themeMode)]).toEqual([id, id !== 'app'])
      const reset = resetMermaidCustomisation(after.code)
      expect(reset).toMatchObject({ ok: true, code: FLOW, themeMode: 'app' })
      expect(mermaidCustomisationCanReset(FLOW, 'app')).toBe(false)
    }
  })

  it('unpins a block pinned to a theme the old way, with nothing in its text', () => {
    expect(mermaidCustomisationCanReset(FLOW, 'forest')).toBe(true)
    expect(resetMermaidCustomisation(FLOW)).toEqual({ ok: true, code: FLOW, themeMode: 'app' })
  })

  it('is offered, and then says why not, on a frontmatter it cannot keep exactly', () => {
    const text = fm('# mine\nconfig:\n  theme: neutral', FLOW)
    expect(mermaidCustomisationCanReset(text, 'app')).toBe(true)
    expect(resetMermaidCustomisation(text)).toMatchObject({ ok: false, refusal: { code: 'yaml-comment', line: 2 } })
  })

  it('takes away what the frontmatter sets and leaves an init directive as it is', () => {
    const text = fm('config:\n  look: handDrawn\n  handDrawnSeed: 7', `%%{init: {"theme":"forest"}}%%\n${FLOW}`)
    expect(resetMermaidCustomisation(text)).toEqual({
      ok: true,
      code: `%%{init: {"theme":"forest"}}%%\n${FLOW}`,
      themeMode: 'app',
    })
  })
})

describe('a preset under an init directive', () => {
  const DIRECTED = `%%{init: {"theme":"forest"}}%%\n${FLOW}`

  it('is refused when it would write the key the directive sets', () => {
    for (const id of ['monochrome', 'print'] as MermaidStylePresetId[]) {
      expect(applyMermaidStylePreset(DIRECTED, id)).toMatchObject({
        ok: false,
        refusal: { code: 'directive-sets-key', key: 'theme', line: 1 },
      })
    }
  })

  it('is applied when it writes other keys, and is then not shown as active: the directive’s theme is still drawn', () => {
    const sketch = applied(DIRECTED, 'sketch')
    expect(written(sketch.code)).toEqual({ look: 'handDrawn', handDrawnSeed: 7 })
    expect(activeMermaidStylePreset(sketch.code, sketch.themeMode)).toBeNull()
  })
})
