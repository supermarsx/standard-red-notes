/**
 * What each Customise control reads and writes, per kind of diagram.
 *
 * The claims pinned here are about TEXT: a control writes exactly its own keys
 * and no others, reads back what it wrote, writes nothing at its default, and
 * says "unavailable" where mermaid has no working option. That those keys move
 * the picture is not something jest can see — it was measured in two browsers,
 * and the file's header records what was found — and that mermaid reads each
 * key back is checked against the real library by MermaidConfigContract.spec.ts.
 */
import {
  applyMermaidLineStyle,
  applyMermaidLook,
  applyMermaidSpacing,
  applyMermaidStyleBundle,
  applyMermaidTextSize,
  applyMermaidTheme,
  DEFAULT_MERMAID_HAND_DRAWN_SEED,
  MAX_MERMAID_HAND_DRAWN_SEED,
  MAX_MERMAID_SPACING,
  MAX_MERMAID_TEXT_SIZE,
  MERMAID_CONFIG_CATALOG,
  MERMAID_LIBRARY_THEME_LABELS,
  MERMAID_LINE_STYLE_LABELS,
  MERMAID_LINE_STYLES,
  MERMAID_MANAGED_CONFIG_PATHS,
  MERMAID_SPACING_LEVELS,
  MERMAID_SPACING_STEP,
  MERMAID_TEXT_SIZE_STEPS,
  mermaidBlockThemeModeFor,
  mermaidBundleChanges,
  MermaidCustomiseEdit,
  mermaidCustomiseKind,
  mermaidKindPhrase,
  MIN_MERMAID_SPACING,
  MIN_MERMAID_TEXT_SIZE,
  readMermaidEffectiveTheme,
  readMermaidLineStyle,
  readMermaidLook,
  readMermaidManagedKeys,
  readMermaidSpacing,
  readMermaidTextSize,
  reshuffleMermaidSketch,
} from './MermaidConfigCatalog'
import { MERMAID_SAMPLE_DIAGRAMS } from './MermaidCustomise.fixtures'
import { MERMAID_APP_SECURE_KEYS } from './MermaidRuntime'
import {
  MERMAID_BUILTIN_THEMES,
  MERMAID_LIBRARY_THEME_IS_DARK,
  MERMAID_LIBRARY_THEMES,
  MERMAID_THEME_MODES,
  MermaidThemeMode,
} from './MermaidSettings'
import { listMermaidFrontmatterConfig, readMermaidSourceConfig } from './MermaidSourceConfig'

/** One small, valid diagram of every kind `detectMermaidDiagramType` can name. */
const DIAGRAMS: Record<string, string> = MERMAID_SAMPLE_DIAGRAMS

const KINDS = Object.keys(DIAGRAMS)

const code = (edit: MermaidCustomiseEdit): string => {
  if (!edit.ok) {
    throw new Error(`refused (${edit.refusal.code}): ${edit.refusal.message}`)
  }
  return edit.code
}

const refusal = (edit: MermaidCustomiseEdit) => {
  if (edit.ok) {
    throw new Error(`not refused; wrote ${JSON.stringify(edit.code)}`)
  }
  return edit.refusal
}

const written = (text: string): Record<string, unknown> =>
  Object.fromEntries(listMermaidFrontmatterConfig(readMermaidSourceConfig(text)).map((item) => [item.key, item.value]))

const fm = (yaml: string, body: string) => `---\n${yaml}\n---\n${body}`
const FLOW = DIAGRAMS.flowchart

describe('the catalogue of keys', () => {
  it('names each key once', () => {
    const paths = MERMAID_CONFIG_CATALOG.map((key) => key.path.join('.'))
    expect(new Set(paths).size).toBe(paths.length)
    expect(MERMAID_MANAGED_CONFIG_PATHS.map((path) => path.join('.'))).toEqual(paths)
  })

  it('has every sample inside its own declared type', () => {
    for (const key of MERMAID_CONFIG_CATALOG) {
      expect(key.samples.length).toBeGreaterThan(0)
      for (const sample of key.samples) {
        const name = `${key.path.join('.')} = ${JSON.stringify(sample)}`
        if (key.type.kind === 'choice') {
          expect([name, key.type.values.includes(String(sample))]).toEqual([name, true])
        } else if (key.type.kind === 'number') {
          expect([name, typeof sample === 'number' && sample >= key.type.min && sample <= key.type.max]).toEqual([
            name,
            true,
          ])
        } else {
          const pixels = /^(\d+(?:\.\d+)?)px$/.exec(String(sample))
          expect([
            name,
            pixels !== null && Number(pixels[1]) >= key.type.min && Number(pixels[1]) <= key.type.max,
          ]).toEqual([name, true])
        }
      }
    }
  })

  /**
   * The owner has not decided whether a diagram's text may set raw CSS, a font
   * or the label mode. Until then the panel must not write any of them — and it
   * must never write a key the app locks, which mermaid would silently ignore.
   */
  it('offers none of the keys that are locked or still undecided', () => {
    const forbidden = [
      ...MERMAID_APP_SECURE_KEYS,
      'themeCSS',
      'fontFamily',
      'altFontFamily',
      'htmlLabels',
      'dompurifyConfig',
      'logLevel',
      'deterministicIds',
      'deterministicIDSeed',
      'arrowMarkerAbsolute',
      'layout',
      'elk',
      'useMaxWidth',
      'useWidth',
      'defaultRenderer',
    ]
    for (const key of MERMAID_CONFIG_CATALOG) {
      for (const part of key.path) {
        expect([key.path.join('.'), forbidden.includes(part) || /fontfamily/i.test(part)]).toEqual([
          key.path.join('.'),
          false,
        ])
      }
    }
    expect(MERMAID_APP_SECURE_KEYS.length).toBeGreaterThanOrEqual(6)
  })

  it('has a label for every theme and every line style it offers', () => {
    expect(Object.keys(MERMAID_LIBRARY_THEME_LABELS).sort()).toEqual([...MERMAID_LIBRARY_THEMES].sort())
    expect(MERMAID_LIBRARY_THEMES).toHaveLength(11)
    expect(Object.keys(MERMAID_LINE_STYLE_LABELS).sort()).toEqual([...MERMAID_LINE_STYLES].sort())
    for (const label of [...Object.values(MERMAID_LIBRARY_THEME_LABELS), ...Object.values(MERMAID_LINE_STYLE_LABELS)]) {
      expect(label.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(Object.values(MERMAID_LIBRARY_THEME_LABELS)).size).toBe(11)
    expect(new Set(Object.values(MERMAID_LINE_STYLE_LABELS)).size).toBe(MERMAID_LINE_STYLES.length)
  })
})

describe('every control writes only keys the catalogue lists, for every kind', () => {
  const managed = new Set(MERMAID_MANAGED_CONFIG_PATHS.map((path) => path.join('.')))

  it.each(KINDS)('on %s', (kind) => {
    const base = DIAGRAMS[kind]
    expect(mermaidCustomiseKind(base)).toBe(kind)
    const edits: MermaidCustomiseEdit[] = [
      applyMermaidTheme(base, 'forest'),
      applyMermaidLook(base, 'app', 'handDrawn'),
      applyMermaidTextSize(base, 'app', 20),
      applyMermaidSpacing(base, 'app', 160),
      applyMermaidLineStyle(base, 'app', 'linear'),
      applyMermaidStyleBundle(base, { theme: 'neutral', look: 'handDrawn', textSize: 14, spacing: 60 }),
    ]
    let wrote = 0
    for (const edit of edits) {
      if (!edit.ok) {
        // Unavailable for this kind: it must then have written nothing at all.
        expect(edit.refusal.code).toBe('invalid-change')
        continue
      }
      for (const key of Object.keys(written(edit.code))) {
        expect([kind, key, managed.has(key)]).toEqual([kind, key, true])
        wrote++
      }
      // And the diagram itself is untouched: the text still ends with it.
      expect(edit.code.endsWith(base)).toBe(true)
    }
    // The theme, at least, is offered for every kind.
    expect(wrote).toBeGreaterThan(0)
  })
})

describe('the theme control', () => {
  const read = (text: string, blockMode: MermaidThemeMode) =>
    readMermaidEffectiveTheme(readMermaidSourceConfig(text), blockMode)

  it('shows the app theme for a diagram that names none in an app-themed block', () => {
    expect(read(FLOW, 'app')).toEqual({ state: 'app' })
  })

  it('shows the block’s pinned theme when the text names none', () => {
    expect(read(FLOW, 'forest')).toEqual({ state: 'named', theme: 'forest', from: 'block' })
  })

  it('shows the theme the TEXT names over the block’s, because that is the one drawn', () => {
    // The defect this replaces: a block pinned to Forest whose text says dark
    // was drawn dark while the toolbar said Forest.
    expect(read(fm('config:\n  theme: dark', FLOW), 'forest')).toEqual({
      state: 'named',
      theme: 'dark',
      from: 'frontmatter',
      line: 3,
    })
    expect(read(fm('config:\n  theme: neo-dark', FLOW), 'app')).toMatchObject({
      theme: 'neo-dark',
      from: 'frontmatter',
    })
  })

  it('shows a directive’s theme over the frontmatter’s', () => {
    expect(read(fm('config:\n  theme: dark', `%%{init: {"theme":"forest"}}%%\n${FLOW}`), 'app')).toEqual({
      state: 'named',
      theme: 'forest',
      from: 'directive',
      line: 5,
    })
  })

  it('leaves the block’s theme standing for a name mermaid does not know', () => {
    expect(read(fm('config:\n  theme: no-such-theme', FLOW), 'app')).toEqual({ state: 'app' })
    expect(read(fm('config:\n  theme: Forest', FLOW), 'neutral')).toEqual({
      state: 'named',
      theme: 'neutral',
      from: 'block',
    })
  })

  it('says it does not know, rather than "none", for a frontmatter it cannot read', () => {
    const reading = read(fm('# a comment\nconfig:\n  theme: forest', FLOW), 'app')
    expect(reading.state).toBe('unknown')
    expect(reading).toMatchObject({ reason: expect.stringContaining('YAML comment') })
  })

  it.each([...MERMAID_LIBRARY_THEMES])(
    'writes %s into the text, and gives the block a value an older build is safe with',
    (theme) => {
      const edit = applyMermaidTheme(FLOW, theme)
      expect(code(edit)).toBe(fm(`config:\n  theme: ${theme}`, FLOW))
      const blockMode = (edit as { themeMode: MermaidThemeMode }).themeMode
      // Never `app`: an older build would lay the app's palette over the theme.
      expect(blockMode).not.toBe('app')
      expect(MERMAID_THEME_MODES).toContain(blockMode)
      expect(blockMode).toBe(mermaidBlockThemeModeFor(theme))
      // Same theme where the block knows it; otherwise the same polarity.
      if ((MERMAID_BUILTIN_THEMES as readonly string[]).includes(theme)) {
        expect(blockMode).toBe(theme)
      } else {
        expect(blockMode).toBe(MERMAID_LIBRARY_THEME_IS_DARK[theme] ? 'dark' : 'default')
      }
      // And the control then shows what was chosen.
      expect(read(code(edit), blockMode)).toMatchObject({ state: 'named', theme, from: 'frontmatter' })
    },
  )

  it('stores the six newer themes as the built-in theme of the same polarity', () => {
    expect(
      Object.fromEntries(
        MERMAID_LIBRARY_THEMES.filter((theme) => !(MERMAID_BUILTIN_THEMES as readonly string[]).includes(theme)).map(
          (theme) => [theme, mermaidBlockThemeModeFor(theme)],
        ),
      ),
    ).toEqual({
      neo: 'default',
      'neo-dark': 'dark',
      redux: 'default',
      'redux-dark': 'dark',
      'redux-color': 'default',
      'redux-dark-color': 'dark',
    })
  })

  it('replaces a theme already in the text on its own line', () => {
    expect(code(applyMermaidTheme(fm('title: Plan\nconfig:\n  theme: dark\n  look: classic', FLOW), 'forest'))).toBe(
      fm('title: Plan\nconfig:\n  theme: forest\n  look: classic', FLOW),
    )
  })

  it('goes back to the app theme by taking the theme out of the text and unpinning the block', () => {
    const edit = applyMermaidTheme(fm('config:\n  theme: forest', FLOW), 'app')
    expect(edit).toEqual({ ok: true, code: FLOW, themeMode: 'app' })
    // A block pinned the old way, with nothing in its text, is unpinned too.
    expect(applyMermaidTheme(FLOW, 'app')).toEqual({ ok: true, code: FLOW, themeMode: 'app' })
  })

  it('refuses a theme the text’s own directive overrides, in both directions', () => {
    const directed = `%%{init: {"theme":"forest"}}%%\n${FLOW}`
    expect(refusal(applyMermaidTheme(directed, 'dark'))).toMatchObject({
      code: 'directive-sets-key',
      line: 1,
      key: 'theme',
    })
    // "Follow the app" would only remove a line and change nothing on screen.
    expect(refusal(applyMermaidTheme(directed, 'app'))).toMatchObject({
      code: 'directive-sets-key',
      line: 1,
      key: 'theme',
    })
  })

  it('refuses a frontmatter it cannot keep exactly, by name', () => {
    expect(refusal(applyMermaidTheme(fm('# mine\nconfig:\n  look: classic', FLOW), 'dark')).code).toBe('yaml-comment')
  })

  it('refuses a theme mermaid does not ship', () => {
    expect(refusal(applyMermaidTheme(FLOW, 'solarized' as never)).code).toBe('invalid-change')
  })
})

describe('the text size control', () => {
  const read = (text: string) => readMermaidTextSize(readMermaidSourceConfig(text), mermaidCustomiseKind(text))

  it('is at its default, and has written nothing, for an untouched diagram', () => {
    for (const kind of KINDS) {
      const reading = read(DIAGRAMS[kind])
      expect([kind, reading.state === 'default' || reading.state === 'unavailable']).toEqual([kind, true])
    }
  })

  it('writes the general font size, with its unit, for a flowchart', () => {
    // Without the unit mermaid drew 13px text for "20".
    expect(code(applyMermaidTextSize(FLOW, 'app', 20))).toBe(
      fm('config:\n  themeVariables:\n    fontSize: "20px"', FLOW),
    )
  })

  it('writes the ROOT font size for a sequence diagram, which is the one its renderer reads', () => {
    expect(code(applyMermaidTextSize(DIAGRAMS.sequence, 'app', 20))).toBe(
      fm('config:\n  fontSize: 20', DIAGRAMS.sequence),
    )
  })

  it('writes both Gantt sizes, scaled from the Gantt default of 11', () => {
    expect(code(applyMermaidTextSize(DIAGRAMS.gantt, 'app', 20))).toBe(
      fm('config:\n  gantt:\n    fontSize: 13.75\n    sectionFontSize: 13.75', DIAGRAMS.gantt),
    )
  })

  it('writes the three pie sizes, each scaled from its own default', () => {
    expect(code(applyMermaidTextSize(DIAGRAMS.pie, 'app', 20))).toBe(
      fm(
        'config:\n  themeVariables:\n    pieSectionTextSize: "21.25px"\n    pieLegendTextSize: "21.25px"\n    pieTitleTextSize: "31.25px"',
        DIAGRAMS.pie,
      ),
    )
  })

  it('is unavailable, with the reason, where mermaid has no single text size', () => {
    for (const kind of ['quadrant', 'xychart', 'sankey', 'c4']) {
      expect(read(DIAGRAMS[kind])).toEqual({
        state: 'unavailable',
        reason: `Mermaid has no single text size for ${mermaidKindPhrase(kind)}.`,
      })
      const refused = refusal(applyMermaidTextSize(DIAGRAMS[kind], 'app', 20))
      expect(refused.message).toContain('Nothing was changed')
    }
  })

  it('reads back every size it can write, for every kind that has one', () => {
    let checked = 0
    for (const kind of KINDS) {
      if (read(DIAGRAMS[kind]).state === 'unavailable') {
        continue
      }
      for (let size = MIN_MERMAID_TEXT_SIZE; size <= MAX_MERMAID_TEXT_SIZE; size++) {
        const after = code(applyMermaidTextSize(DIAGRAMS[kind], 'app', size))
        expect([kind, size, read(after)]).toEqual([
          kind,
          size,
          size === 16 ? { state: 'default' } : { state: 'set', value: size },
        ])
        checked++
      }
    }
    expect(checked).toBeGreaterThanOrEqual(13 * 33)
  })

  it('writes nothing at the default, and takes away what a larger size wrote, to the byte', () => {
    for (const kind of KINDS) {
      if (read(DIAGRAMS[kind]).state === 'unavailable') {
        continue
      }
      expect(code(applyMermaidTextSize(DIAGRAMS[kind], 'app', 16))).toBe(DIAGRAMS[kind])
      const larger = code(applyMermaidTextSize(DIAGRAMS[kind], 'app', 24))
      expect(larger).not.toBe(DIAGRAMS[kind])
      expect(code(applyMermaidTextSize(larger, 'app', 16))).toBe(DIAGRAMS[kind])
    }
  })

  it('offers its one-click sizes inside its own range, the default among them', () => {
    expect(MERMAID_TEXT_SIZE_STEPS).toContain(16)
    for (const size of MERMAID_TEXT_SIZE_STEPS) {
      expect(size >= MIN_MERMAID_TEXT_SIZE && size <= MAX_MERMAID_TEXT_SIZE).toBe(true)
    }
  })

  it('refuses a size outside its range, or one that is not a whole number', () => {
    for (const size of [7, 41, 16.5, Number.NaN]) {
      expect(refusal(applyMermaidTextSize(FLOW, 'app', size)).code).toBe('invalid-change')
    }
  })

  it('says what the text holds when it is not a size this control writes', () => {
    for (const yaml of [
      'config:\n  themeVariables:\n    fontSize: 20',
      'config:\n  themeVariables:\n    fontSize: 1.5em',
      'config:\n  themeVariables:\n    fontSize: "64px"',
      'config:\n  themeVariables:\n    fontSize: "16.5px"',
    ]) {
      const reading = read(fm(yaml, FLOW))
      expect([yaml, reading.state]).toEqual([yaml, 'other'])
      expect(reading).toMatchObject({ description: expect.stringContaining('themeVariables.fontSize is') })
    }
    // Only some of the keys the control writes together.
    expect(read(fm('config:\n  gantt:\n    fontSize: 13.75', DIAGRAMS.gantt))).toEqual({
      state: 'other',
      description: 'only some of its options are set in the diagram’s text',
    })
    // And they disagree.
    expect(read(fm('config:\n  gantt:\n    fontSize: 13.75\n    sectionFontSize: 8.25', DIAGRAMS.gantt)).state).toBe(
      'other',
    )
  })

  it('overwrites such a value when a size is chosen', () => {
    expect(code(applyMermaidTextSize(fm('config:\n  themeVariables:\n    fontSize: 1.5em', FLOW), 'app', 20))).toBe(
      fm('config:\n  themeVariables:\n    fontSize: "20px"', FLOW),
    )
  })

  it('shows a size an init directive sets, and refuses to change it in either direction', () => {
    const directed = `%%{init: {"themeVariables":{"fontSize":"20px"}}}%%\n${FLOW}`
    expect(read(directed)).toEqual({ state: 'set', value: 20, directiveLine: 1 })
    expect(refusal(applyMermaidTextSize(directed, 'app', 24)).code).toBe('directive-sets-key')
    expect(refusal(applyMermaidTextSize(directed, 'app', 16)).code).toBe('directive-sets-key')
  })

  it('leaves the block’s theme as it was', () => {
    expect(applyMermaidTextSize(FLOW, 'forest', 20)).toMatchObject({ ok: true, themeMode: 'forest' })
  })
})

describe('the spacing control', () => {
  const read = (text: string) => readMermaidSpacing(readMermaidSourceConfig(text), mermaidCustomiseKind(text))

  it.each([
    ['flowchart', 'config:\n  flowchart:\n    nodeSpacing: 80\n    rankSpacing: 80'],
    ['state', 'config:\n  state:\n    nodeSpacing: 80\n    rankSpacing: 80'],
    ['er', 'config:\n  er:\n    nodeSpacing: 224\n    rankSpacing: 128'],
    ['sequence', 'config:\n  sequence:\n    actorMargin: 80\n    boxMargin: 16'],
    ['gantt', 'config:\n  gantt:\n    barHeight: 32\n    barGap: 6.4'],
    ['mindmap', 'config:\n  mindmap:\n    padding: 16'],
    ['journey', 'config:\n  journey:\n    taskMargin: 80'],
  ])('writes 160%% of mermaid’s own defaults for %s', (kind, yaml) => {
    expect(code(applyMermaidSpacing(DIAGRAMS[kind], 'app', 160))).toBe(fm(yaml, DIAGRAMS[kind]))
  })

  it('is unavailable for a class diagram: mermaid reads no spacing of its own for one', () => {
    // Its class renderer takes spacing from the `state` group. Writing `state`
    // options into a class diagram would work today by accident, so the panel
    // says there is none instead.
    expect(read(DIAGRAMS.class)).toEqual({
      state: 'unavailable',
      reason: 'Mermaid has no spacing option for a class diagram.',
    })
    expect(written(DIAGRAMS.class)).toEqual({})
    expect(refusal(applyMermaidSpacing(DIAGRAMS.class, 'app', 160)).code).toBe('invalid-change')
  })

  it('is unavailable for a pie chart and the other kinds with no layout gaps to set', () => {
    for (const kind of [
      'pie',
      'timeline',
      'gitGraph',
      'quadrant',
      'requirement',
      'sankey',
      'xychart',
      'block',
      'c4',
      'unknown',
    ]) {
      expect([kind, read(DIAGRAMS[kind]).state]).toEqual([kind, 'unavailable'])
    }
  })

  it('reads back every percentage its slider can reach, for every kind that has spacing', () => {
    let checked = 0
    for (const kind of KINDS) {
      if (read(DIAGRAMS[kind]).state === 'unavailable') {
        continue
      }
      for (let percent = MIN_MERMAID_SPACING; percent <= MAX_MERMAID_SPACING; percent += MERMAID_SPACING_STEP) {
        const after = code(applyMermaidSpacing(DIAGRAMS[kind], 'app', percent))
        expect([kind, percent, read(after)]).toEqual([
          kind,
          percent,
          percent === 100 ? { state: 'default' } : { state: 'set', value: percent },
        ])
        checked++
      }
    }
    expect(checked).toBe(7 * 22)
  })

  it('writes nothing at 100%, and takes away what another level wrote, to the byte', () => {
    for (const kind of KINDS) {
      if (read(DIAGRAMS[kind]).state === 'unavailable') {
        continue
      }
      expect(code(applyMermaidSpacing(DIAGRAMS[kind], 'app', 100))).toBe(DIAGRAMS[kind])
      expect(code(applyMermaidSpacing(code(applyMermaidSpacing(DIAGRAMS[kind], 'app', 60)), 'app', 100))).toBe(
        DIAGRAMS[kind],
      )
    }
  })

  it('names its three levels, with Normal the one that writes nothing', () => {
    expect(MERMAID_SPACING_LEVELS.map((level) => level.label)).toEqual(['Compact', 'Normal', 'Spacious'])
    expect(MERMAID_SPACING_LEVELS.find((level) => level.label === 'Normal')?.percent).toBe(100)
    for (const level of MERMAID_SPACING_LEVELS) {
      expect(level.percent % MERMAID_SPACING_STEP).toBe(0)
      expect(level.percent >= MIN_MERMAID_SPACING && level.percent <= MAX_MERMAID_SPACING).toBe(true)
    }
  })

  it('says what the text holds when the gaps do not share one percentage', () => {
    expect(read(fm('config:\n  flowchart:\n    nodeSpacing: 80\n    rankSpacing: 30', FLOW)).state).toBe('other')
    expect(read(fm('config:\n  flowchart:\n    nodeSpacing: 80', FLOW))).toEqual({
      state: 'other',
      description: 'only some of its options are set in the diagram’s text',
    })
  })

  it('refuses a percentage outside its range', () => {
    for (const percent of [39, 251, 100.5]) {
      expect(refusal(applyMermaidSpacing(FLOW, 'app', percent)).code).toBe('invalid-change')
    }
  })
})

describe('the look control', () => {
  const read = (text: string) => readMermaidLook(readMermaidSourceConfig(text), mermaidCustomiseKind(text))

  it('writes the hand-drawn look WITH a fixed seed, so the sketch does not move as you type', () => {
    expect(code(applyMermaidLook(FLOW, 'app', 'handDrawn'))).toBe(
      fm(`config:\n  look: handDrawn\n  handDrawnSeed: ${DEFAULT_MERMAID_HAND_DRAWN_SEED}`, FLOW),
    )
    expect(DEFAULT_MERMAID_HAND_DRAWN_SEED).toBeGreaterThanOrEqual(1)
  })

  it('keeps a seed the diagram already has', () => {
    const before = fm('config:\n  handDrawnSeed: 42', FLOW)
    expect(code(applyMermaidLook(before, 'app', 'handDrawn'))).toBe(
      fm('config:\n  handDrawnSeed: 42\n  look: handDrawn', FLOW),
    )
  })

  it('replaces a seed of zero, which is mermaid’s word for "random every time"', () => {
    expect(written(code(applyMermaidLook(fm('config:\n  handDrawnSeed: 0', FLOW), 'app', 'handDrawn')))).toEqual({
      handDrawnSeed: DEFAULT_MERMAID_HAND_DRAWN_SEED,
      look: 'handDrawn',
    })
  })

  it('goes back to classic by taking the look and its seed away, to the byte', () => {
    const sketched = code(applyMermaidLook(FLOW, 'app', 'handDrawn'))
    expect(read(sketched)).toEqual({ state: 'set', value: 'handDrawn', seed: DEFAULT_MERMAID_HAND_DRAWN_SEED })
    expect(code(applyMermaidLook(sketched, 'app', 'classic'))).toBe(FLOW)
  })

  it('redraws by moving to the next seed, and wraps at the top', () => {
    const sketched = code(applyMermaidLook(FLOW, 'app', 'handDrawn'))
    const redrawn = code(reshuffleMermaidSketch(sketched, 'app'))
    expect(written(redrawn)).toEqual({ look: 'handDrawn', handDrawnSeed: DEFAULT_MERMAID_HAND_DRAWN_SEED + 1 })
    const atTop = fm(`config:\n  look: handDrawn\n  handDrawnSeed: ${MAX_MERMAID_HAND_DRAWN_SEED}`, FLOW)
    expect(written(code(reshuffleMermaidSketch(atTop, 'app')))).toEqual({ look: 'handDrawn', handDrawnSeed: 1 })
  })

  it('will not redraw a diagram that is not hand-drawn', () => {
    expect(refusal(reshuffleMermaidSketch(FLOW, 'app')).message).toContain('Only a hand-drawn diagram')
  })

  it('is offered for exactly the kinds mermaid draws differently in it', () => {
    const offered = KINDS.filter((kind) => read(DIAGRAMS[kind]).state !== 'unavailable')
    expect(offered.sort()).toEqual(['class', 'er', 'flowchart', 'mindmap', 'requirement', 'state'])
    expect(read(DIAGRAMS.sequence)).toEqual({
      state: 'unavailable',
      reason: 'Mermaid draws a sequence diagram the same in either look.',
    })
    expect(refusal(applyMermaidLook(DIAGRAMS.pie, 'app', 'handDrawn')).message).toContain('a pie chart')
  })

  it('shows a look it does not offer as set in the text, and does not call it classic', () => {
    expect(read(fm('config:\n  look: neo', FLOW))).toEqual({
      state: 'other',
      description: 'look is "neo" in the diagram’s text',
    })
  })
})

describe('the line style control', () => {
  const read = (text: string) => readMermaidLineStyle(readMermaidSourceConfig(text), mermaidCustomiseKind(text))

  it.each(MERMAID_LINE_STYLES.filter((style) => style !== 'basis'))('writes %s under the flowchart group', (style) => {
    const after = code(applyMermaidLineStyle(FLOW, 'app', style))
    expect(after).toBe(fm(`config:\n  flowchart:\n    curve: ${style}`, FLOW))
    expect(read(after)).toEqual({ state: 'set', value: style })
    expect(code(applyMermaidLineStyle(after, 'app', 'basis'))).toBe(FLOW)
  })

  it('writes nothing for the smooth default', () => {
    expect(code(applyMermaidLineStyle(FLOW, 'app', 'basis'))).toBe(FLOW)
    expect(read(FLOW)).toEqual({ state: 'default' })
  })

  it('is offered for the four kinds whose links follow that key, under that same key', () => {
    const offered = KINDS.filter((kind) => read(DIAGRAMS[kind]).state !== 'unavailable')
    expect(offered.sort()).toEqual(['class', 'flowchart', 'requirement', 'state'])
    expect(written(code(applyMermaidLineStyle(DIAGRAMS.class, 'app', 'linear')))).toEqual({
      'flowchart.curve': 'linear',
    })
    expect(read(DIAGRAMS.er)).toEqual({
      state: 'unavailable',
      reason: 'Mermaid has no line style for an entity-relationship diagram.',
    })
  })

  it('refuses a style mermaid does not have', () => {
    expect(refusal(applyMermaidLineStyle(FLOW, 'app', 'wavy' as never)).code).toBe('invalid-change')
  })
})

describe('a bundle of options, which is what a preset is', () => {
  it('writes only the parts a kind has an option for', () => {
    const bundle = { look: 'handDrawn' as const, textSize: 20, spacing: 160 }
    expect((mermaidBundleChanges(bundle, 'flowchart') ?? []).map((change) => change.path.join('.'))).toEqual([
      'look',
      'handDrawnSeed',
      'themeVariables.fontSize',
      'flowchart.nodeSpacing',
      'flowchart.rankSpacing',
    ])
    expect((mermaidBundleChanges(bundle, 'sequence') ?? []).map((change) => change.path.join('.'))).toEqual([
      'fontSize',
      'sequence.actorMargin',
      'sequence.boxMargin',
    ])
    expect((mermaidBundleChanges(bundle, 'pie') ?? []).map((change) => change.path.join('.'))).toEqual([
      'themeVariables.pieSectionTextSize',
      'themeVariables.pieLegendTextSize',
      'themeVariables.pieTitleTextSize',
    ])
  })

  it('is null where it would change nothing, and empty where it asks for nothing', () => {
    expect(mermaidBundleChanges({ look: 'handDrawn' }, 'pie')).toBeNull()
    expect(mermaidBundleChanges({ textSize: 20, spacing: 160 }, 'quadrant')).toBeNull()
    expect(mermaidBundleChanges({}, 'pie')).toEqual([])
  })

  it('replaces every managed option and keeps every other line of the frontmatter', () => {
    const before = fm(
      'title: Plan\nconfig:\n  theme: forest\n  layout: dagre\n  themeVariables:\n    fontSize: "24px"\n    primaryColor: "#ffcc00"\n  flowchart:\n    curve: step\n    wrappingWidth: 120',
      FLOW,
    )
    const edit = applyMermaidStyleBundle(before, { look: 'handDrawn' })
    expect(code(edit)).toBe(
      fm(
        'title: Plan\nconfig:\n  layout: dagre\n  themeVariables:\n    primaryColor: "#ffcc00"\n  flowchart:\n    wrappingWidth: 120\n  look: handDrawn\n  handDrawnSeed: 7',
        FLOW,
      ),
    )
    // No theme in the bundle: the block follows the app again.
    expect(edit).toMatchObject({ themeMode: 'app' })
  })

  it('takes everything away for the empty bundle, leaving what the panel does not manage', () => {
    const before = fm('config:\n  theme: forest\n  layout: dagre\n  flowchart:\n    curve: step', FLOW)
    expect(applyMermaidStyleBundle(before, {})).toEqual({
      ok: true,
      code: fm('config:\n  layout: dagre', FLOW),
      themeMode: 'app',
    })
    expect(applyMermaidStyleBundle(fm('config:\n  theme: forest', FLOW), {})).toEqual({
      ok: true,
      code: FLOW,
      themeMode: 'app',
    })
  })

  it('still applies under a directive that sets a key the bundle leaves alone, and not one it writes', () => {
    const directed = `%%{init: {"theme":"forest"}}%%\n${FLOW}`
    expect(written(code(applyMermaidStyleBundle(directed, { look: 'handDrawn' })))).toEqual({
      look: 'handDrawn',
      handDrawnSeed: 7,
    })
    expect(refusal(applyMermaidStyleBundle(directed, { theme: 'neutral' })).code).toBe('directive-sets-key')
  })

  it('unpins the block of an empty diagram without touching its (empty) text', () => {
    expect(applyMermaidStyleBundle('', {})).toEqual({ ok: true, code: '', themeMode: 'app' })
  })

  it('lists what the text sets among the managed keys, or null when it cannot vouch for the text', () => {
    const text = fm('config:\n  theme: forest\n  layout: dagre\n  flowchart:\n    curve: step', FLOW)
    expect(Object.fromEntries(readMermaidManagedKeys(readMermaidSourceConfig(text)) ?? [])).toEqual({
      theme: 'forest',
      'flowchart.curve': 'step',
    })
    expect(readMermaidManagedKeys(readMermaidSourceConfig(fm('# c\nconfig:\n  theme: forest', FLOW)))).toBeNull()
  })
})

describe('naming a kind in a sentence', () => {
  it('uses the right article, and does not pretend to know an unknown kind', () => {
    expect(mermaidKindPhrase('flowchart')).toBe('a flowchart')
    expect(mermaidKindPhrase('er')).toBe('an entity-relationship diagram')
    expect(mermaidKindPhrase('xychart')).toBe('an XY chart')
    expect(mermaidKindPhrase('unknown')).toBe('this kind of diagram')
    expect(mermaidKindPhrase('no-such-kind')).toBe('this kind of diagram')
  })
})
