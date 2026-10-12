import { detectMermaidDiagramType, MERMAID_DIAGRAM_TYPE_LABELS } from './MermaidGraphBuilder'
import {
  MERMAID_BUILTIN_THEMES,
  MERMAID_LIBRARY_THEME_IS_DARK,
  MERMAID_LIBRARY_THEMES,
  MERMAID_THEME_MODE_LABELS,
  type MermaidLibraryTheme,
  type MermaidThemeMode,
  normalizeMermaidLibraryTheme,
} from './MermaidSettings'
import {
  type MermaidConfigChange,
  type MermaidConfigPath,
  type MermaidConfigRefusal,
  type MermaidConfigScalar,
  mermaidDirectiveRefusal,
  type MermaidSourceConfigReading,
  patchMermaidSourceConfig,
  readMermaidConfigValue,
  readMermaidSourceConfig,
} from './MermaidSourceConfig'

/**
 * Standard Red Notes — the everyday options the Customise panel manages, and
 * what each of its controls reads and writes.
 *
 * The panel has five controls: theme, look, text size, spacing and line style.
 * Every one of them writes into the diagram's own text (MermaidSourceConfig.ts)
 * so the choice travels with the diagram. This file is the table between a
 * control and the keys behind it — and the table is PER KIND OF DIAGRAM,
 * because mermaid's options are. "Text size" is `themeVariables.fontSize` for a
 * flowchart, the root `fontSize` for a sequence diagram, two keys under `gantt`
 * for a Gantt chart and three theme variables for a pie.
 *
 * EVERY ROW HERE WAS MEASURED, not read off mermaid's documentation, against
 * the installed 11.17.2 in Chrome and in Firefox: a key is listed for a kind
 * only if setting it changed the picture (the viewBox, a label's font size, a
 * link's path). Three things the documentation and the type file suggest, and
 * which are NOT here because they do nothing:
 *
 *  - `sequence.actorFontSize` / `messageFontSize` / `noteFontSize`. The
 *    sequence renderer overwrites all three with the root `fontSize`.
 *  - `sequence.messageMargin`. Nothing in the sequence renderer reads it; the
 *    vertical rhythm of a sequence diagram is `boxMargin`.
 *  - `class.nodeSpacing` / `class.rankSpacing`. The class renderer takes its
 *    spacing from the `state` group. Spacing is therefore offered for a state
 *    diagram and reported as unavailable for a class diagram, rather than
 *    written under a name that only works by accident.
 *
 * A control with no working key for the diagram's kind is `unavailable`, with
 * the reason, so the panel can say so instead of offering a switch that does
 * nothing. `scripts/MermaidConfigContract.mjs` holds this file to the library:
 * every key and sample value is written and read back by the real mermaid, and
 * every default quoted here is compared with the one it ships.
 *
 * Pure: no React, no mermaid, no DOM.
 */

// --- the keys -----------------------------------------------------------------

export type MermaidCatalogControl = 'theme' | 'look' | 'textSize' | 'spacing' | 'lineStyle'

export type MermaidCatalogValueType =
  | { kind: 'choice'; values: readonly string[] }
  | { kind: 'number'; min: number; max: number }
  /** A CSS length in pixels, written as a string: `"20px"`. */
  | { kind: 'pixels'; min: number; max: number }

export type MermaidCatalogKey = {
  path: MermaidConfigPath
  control: MermaidCatalogControl
  type: MermaidCatalogValueType
  /**
   * What mermaid uses when the text says nothing, as its own `defaultConfig`
   * (or, for a theme variable, its `base` theme) reports it. `undefined` where
   * mermaid ships no default for the key and the renderer falls back in code.
   */
  default: MermaidConfigScalar | undefined
  /** Values the contract script writes and has mermaid read back. */
  samples: readonly MermaidConfigScalar[]
}

/** The line styles mermaid draws a link in — every member of its `curve` union. */
export const MERMAID_LINE_STYLES = [
  'basis',
  'linear',
  'rounded',
  'step',
  'stepBefore',
  'stepAfter',
  'natural',
  'monotoneX',
  'monotoneY',
  'cardinal',
  'catmullRom',
  'bumpX',
  'bumpY',
] as const
export type MermaidLineStyle = (typeof MERMAID_LINE_STYLES)[number]
/** What mermaid draws when the text names none. */
export const DEFAULT_MERMAID_LINE_STYLE: MermaidLineStyle = 'basis'

export const MERMAID_LINE_STYLE_LABELS: Record<MermaidLineStyle, string> = {
  basis: 'Smooth',
  linear: 'Straight',
  rounded: 'Rounded corners',
  step: 'Stepped',
  stepBefore: 'Stepped, turning first',
  stepAfter: 'Stepped, turning last',
  natural: 'Natural curve',
  monotoneX: 'Monotone, across',
  monotoneY: 'Monotone, down',
  cardinal: 'Cardinal curve',
  catmullRom: 'Catmull–Rom curve',
  bumpX: 'Bump, across',
  bumpY: 'Bump, down',
}

/**
 * The two looks offered. Mermaid has a third, `neo`; it is left to the code
 * pane for now, and a diagram that names it is shown as "set in the text".
 */
export const MERMAID_LOOKS = ['classic', 'handDrawn'] as const
export type MermaidLook = (typeof MERMAID_LOOKS)[number]
export const MERMAID_LOOK_LABELS: Record<MermaidLook, string> = { classic: 'Classic', handDrawn: 'Hand-drawn' }

/** A label for every theme mermaid ships. The first five are the block's own labels. */
export const MERMAID_LIBRARY_THEME_LABELS: Record<MermaidLibraryTheme, string> = {
  default: MERMAID_THEME_MODE_LABELS.default,
  dark: MERMAID_THEME_MODE_LABELS.dark,
  forest: MERMAID_THEME_MODE_LABELS.forest,
  neutral: MERMAID_THEME_MODE_LABELS.neutral,
  base: MERMAID_THEME_MODE_LABELS.base,
  neo: 'Neo',
  'neo-dark': 'Neo dark',
  redux: 'Redux',
  'redux-dark': 'Redux dark',
  'redux-color': 'Redux colour',
  'redux-dark-color': 'Redux dark colour',
}

/** Text size, as the pixel size body text has when mermaid's default is 16. */
export const MIN_MERMAID_TEXT_SIZE = 8
export const MAX_MERMAID_TEXT_SIZE = 40
export const DEFAULT_MERMAID_TEXT_SIZE = 16
/** The sizes offered as one click each. */
export const MERMAID_TEXT_SIZE_STEPS: readonly number[] = [12, 14, 16, 20, 24]

/** Spacing, as a percentage of mermaid's own default for each key. */
export const MIN_MERMAID_SPACING = 40
export const MAX_MERMAID_SPACING = 250
export const MERMAID_SPACING_STEP = 10
export const DEFAULT_MERMAID_SPACING = 100
export const MERMAID_SPACING_LEVELS: readonly { label: string; percent: number }[] = [
  { label: 'Compact', percent: 60 },
  { label: 'Normal', percent: DEFAULT_MERMAID_SPACING },
  { label: 'Spacious', percent: 160 },
]

/**
 * The seed written with the hand-drawn look. Mermaid's default is 0, which
 * means "a new random seed for every render" — measured: the same text drew a
 * different picture each time — and this app re-renders on every keystroke. A
 * fixed seed keeps the sketch still while its text is edited.
 */
export const DEFAULT_MERMAID_HAND_DRAWN_SEED = 7
export const MAX_MERMAID_HAND_DRAWN_SEED = 9999

const sizeType: MermaidCatalogValueType = { kind: 'number', min: 1, max: 100 }
const pixelType: MermaidCatalogValueType = { kind: 'pixels', min: 1, max: 100 }
const gapType: MermaidCatalogValueType = { kind: 'number', min: 0, max: 1000 }

/**
 * EVERY key the panel writes, and so every key Reset takes away. One list: a
 * key a control writes and this list lacks could never be reset, and the
 * catalogue spec fails for it.
 */
export const MERMAID_CONFIG_CATALOG: readonly MermaidCatalogKey[] = [
  {
    path: ['theme'],
    control: 'theme',
    type: { kind: 'choice', values: MERMAID_LIBRARY_THEMES },
    // Mermaid's own default is `default`; in this app a diagram that names no
    // theme takes the block's, so there is no single value to quote.
    default: undefined,
    samples: [...MERMAID_LIBRARY_THEMES],
  },
  {
    path: ['look'],
    control: 'look',
    type: { kind: 'choice', values: MERMAID_LOOKS },
    default: 'classic',
    samples: [...MERMAID_LOOKS],
  },
  {
    path: ['handDrawnSeed'],
    control: 'look',
    type: { kind: 'number', min: 1, max: MAX_MERMAID_HAND_DRAWN_SEED },
    default: 0,
    samples: [DEFAULT_MERMAID_HAND_DRAWN_SEED, 1, MAX_MERMAID_HAND_DRAWN_SEED],
  },
  {
    path: ['themeVariables', 'fontSize'],
    control: 'textSize',
    type: pixelType,
    default: '16px',
    samples: ['12px', '20px', '13.5px'],
  },
  { path: ['fontSize'], control: 'textSize', type: sizeType, default: 16, samples: [12, 20] },
  { path: ['gantt', 'fontSize'], control: 'textSize', type: sizeType, default: 11, samples: [8.25, 13.75] },
  { path: ['gantt', 'sectionFontSize'], control: 'textSize', type: sizeType, default: 11, samples: [8.25, 13.75] },
  {
    path: ['themeVariables', 'pieSectionTextSize'],
    control: 'textSize',
    type: pixelType,
    default: '17px',
    samples: ['12.75px', '21.25px'],
  },
  {
    path: ['themeVariables', 'pieLegendTextSize'],
    control: 'textSize',
    type: pixelType,
    default: '17px',
    samples: ['12.75px', '21.25px'],
  },
  {
    path: ['themeVariables', 'pieTitleTextSize'],
    control: 'textSize',
    type: pixelType,
    default: '25px',
    samples: ['18.75px', '31.25px'],
  },
  {
    path: ['flowchart', 'curve'],
    control: 'lineStyle',
    type: { kind: 'choice', values: MERMAID_LINE_STYLES },
    default: DEFAULT_MERMAID_LINE_STYLE,
    samples: [...MERMAID_LINE_STYLES],
  },
  { path: ['flowchart', 'nodeSpacing'], control: 'spacing', type: gapType, default: 50, samples: [30, 80] },
  { path: ['flowchart', 'rankSpacing'], control: 'spacing', type: gapType, default: 50, samples: [30, 80] },
  // No default in mermaid's config: the state renderer falls back to 50 in code.
  { path: ['state', 'nodeSpacing'], control: 'spacing', type: gapType, default: undefined, samples: [30, 80] },
  { path: ['state', 'rankSpacing'], control: 'spacing', type: gapType, default: undefined, samples: [30, 80] },
  { path: ['er', 'nodeSpacing'], control: 'spacing', type: gapType, default: 140, samples: [84, 224] },
  { path: ['er', 'rankSpacing'], control: 'spacing', type: gapType, default: 80, samples: [48, 128] },
  { path: ['sequence', 'actorMargin'], control: 'spacing', type: gapType, default: 50, samples: [30, 80] },
  { path: ['sequence', 'boxMargin'], control: 'spacing', type: gapType, default: 10, samples: [6, 16] },
  { path: ['gantt', 'barHeight'], control: 'spacing', type: gapType, default: 20, samples: [12, 32] },
  { path: ['gantt', 'barGap'], control: 'spacing', type: gapType, default: 4, samples: [2.4, 6.4] },
  { path: ['mindmap', 'padding'], control: 'spacing', type: gapType, default: 10, samples: [6, 16] },
  { path: ['journey', 'taskMargin'], control: 'spacing', type: gapType, default: 50, samples: [30, 80] },
]

/** The paths Reset removes: every key any control here could have written. */
export const MERMAID_MANAGED_CONFIG_PATHS: readonly MermaidConfigPath[] = MERMAID_CONFIG_CATALOG.map((key) => key.path)

// --- which keys, for which kind of diagram ----------------------------------------

/** A key one control writes for one kind, and mermaid's default for it there. */
type ScaledKey = { path: MermaidConfigPath; base: number; unit: 'px' | '' }

const key = (dottedPath: string, base: number, unit: 'px' | '' = ''): ScaledKey => ({
  path: dottedPath.split('.'),
  base,
  unit,
})

const GENERAL_TEXT_SIZE: readonly ScaledKey[] = [key('themeVariables.fontSize', 16, 'px')]

/**
 * Text size, per kind. The FIRST key is the one the control reads; the others
 * are written with it and must agree for the control to show a value.
 */
const TEXT_SIZE_KEYS: Record<string, readonly ScaledKey[] | undefined> = {
  flowchart: GENERAL_TEXT_SIZE,
  class: GENERAL_TEXT_SIZE,
  state: GENERAL_TEXT_SIZE,
  er: GENERAL_TEXT_SIZE,
  mindmap: GENERAL_TEXT_SIZE,
  timeline: GENERAL_TEXT_SIZE,
  journey: GENERAL_TEXT_SIZE,
  gitGraph: GENERAL_TEXT_SIZE,
  requirement: GENERAL_TEXT_SIZE,
  block: GENERAL_TEXT_SIZE,
  // A kind this app has no name for. The general key is what most kinds read.
  unknown: GENERAL_TEXT_SIZE,
  sequence: [key('fontSize', 16)],
  gantt: [key('gantt.fontSize', 11), key('gantt.sectionFontSize', 11)],
  pie: [
    key('themeVariables.pieSectionTextSize', 17, 'px'),
    key('themeVariables.pieLegendTextSize', 17, 'px'),
    key('themeVariables.pieTitleTextSize', 25, 'px'),
  ],
}

/** Spacing, per kind: the gaps mermaid's layout leaves between the things it draws. */
const SPACING_KEYS: Record<string, readonly ScaledKey[] | undefined> = {
  flowchart: [key('flowchart.nodeSpacing', 50), key('flowchart.rankSpacing', 50)],
  state: [key('state.nodeSpacing', 50), key('state.rankSpacing', 50)],
  er: [key('er.nodeSpacing', 140), key('er.rankSpacing', 80)],
  sequence: [key('sequence.actorMargin', 50), key('sequence.boxMargin', 10)],
  gantt: [key('gantt.barHeight', 20), key('gantt.barGap', 4)],
  mindmap: [key('mindmap.padding', 10)],
  journey: [key('journey.taskMargin', 50)],
}

/** The kinds mermaid draws differently in the hand-drawn look. */
const HAND_DRAWN_KINDS: readonly string[] = ['flowchart', 'class', 'state', 'er', 'mindmap', 'requirement']
/** The kinds whose links follow `flowchart.curve` — the flowchart's own key, read by all four. */
const LINE_STYLE_KINDS: readonly string[] = ['flowchart', 'class', 'state', 'requirement']

/** The kind of diagram a text declares, by the name `detectMermaidDiagramType` gives it. */
export function mermaidCustomiseKind(code: string): string {
  return detectMermaidDiagramType(code)
}

/**
 * The kinds whose label is said with "an". By ear, not by first letter: it is
 * "an XY chart" and "a user journey".
 */
const KINDS_SAID_WITH_AN: readonly string[] = ['er', 'xychart']

/** "a flowchart", "a sequence diagram", "an entity-relationship diagram" — for a sentence. */
export function mermaidKindPhrase(kind: string): string {
  const label = kind === 'unknown' ? undefined : MERMAID_DIAGRAM_TYPE_LABELS[kind]
  if (label === undefined) {
    return 'this kind of diagram'
  }
  return `${KINDS_SAID_WITH_AN.includes(kind) ? 'an' : 'a'} ${label}`
}

// --- what a control reads -------------------------------------------------------

/** What one control shows. */
export type MermaidControlReading<T> =
  /** Mermaid has no working option of this sort for this kind of diagram. */
  | { state: 'unavailable'; reason: string }
  /** The text says nothing: mermaid's own default. */
  | { state: 'default' }
  | { state: 'set'; value: T; directiveLine?: number }
  /** The text sets it to something the control does not offer, or in a form the reader will not vouch for. */
  | { state: 'other'; description: string }

export type MermaidEffectiveTheme =
  /** Follows the application's light or dark theme. */
  | { state: 'app' }
  | { state: 'named'; theme: MermaidLibraryTheme; from: 'frontmatter' | 'directive' | 'block'; line?: number }
  /** The text may name a theme, in a form the reader will not vouch for. */
  | { state: 'unknown'; reason: string }

/**
 * The theme a diagram is drawn in, which is the one its TEXT names when it
 * names one of mermaid's — the rule MermaidRuntime applies when it renders —
 * and otherwise the block's stored theme. This is what the Theme control
 * shows; it used to show the block's stored theme whatever the text said.
 */
export function readMermaidEffectiveTheme(
  reading: MermaidSourceConfigReading,
  blockThemeMode: MermaidThemeMode,
): MermaidEffectiveTheme {
  const inText = readMermaidConfigValue(reading, ['theme'])
  if (inText.state === 'unknown') {
    return { state: 'unknown', reason: inText.reason }
  }
  // A name mermaid does not know leaves the block's theme standing: it records
  // the name and keeps the palette it was configured with.
  const named = inText.state === 'set' ? normalizeMermaidLibraryTheme(inText.value) : undefined
  if (inText.state === 'set' && named !== undefined) {
    return { state: 'named', theme: named, from: inText.from, line: inText.line }
  }
  return blockThemeMode === 'app' ? { state: 'app' } : { state: 'named', theme: blockThemeMode, from: 'block' }
}

/**
 * Where the theme on show comes from, as one line for the control's tooltip and
 * caption. "Set in the diagram's text" is the answer to a diagram whose picture
 * and toolbar used to disagree.
 */
export function describeMermaidThemeSource(effective: MermaidEffectiveTheme): string {
  if (effective.state === 'app') {
    return 'Follows the app’s light or dark theme.'
  }
  if (effective.state === 'unknown') {
    return effective.reason
  }
  if (effective.from === 'frontmatter') {
    return `Written in the diagram’s text, line ${effective.line}.`
  }
  if (effective.from === 'directive') {
    return `Set by an init directive on line ${effective.line} of the diagram’s text.`
  }
  return 'Pinned on this block. Choosing a theme here writes it into the diagram’s text.'
}

/**
 * What the BLOCK stores when a theme is written into the text. A current build
 * ignores the block's theme whenever the text names one, so this value is for
 * an older build reading the same note: one that still lays the application's
 * palette over a theme the text names, unless the block is pinned to a theme of
 * its own. The five themes the block has always known are stored by name; the
 * six newer ones as the built-in theme of the same polarity.
 */
export function mermaidBlockThemeModeFor(theme: MermaidLibraryTheme): MermaidThemeMode {
  const builtin = MERMAID_BUILTIN_THEMES.find((candidate) => candidate === theme)
  if (builtin !== undefined) {
    return builtin
  }
  return MERMAID_LIBRARY_THEME_IS_DARK[theme] ? 'dark' : 'default'
}

const describeValue = (path: MermaidConfigPath, value: MermaidConfigScalar): string =>
  `${path.join('.')} is ${JSON.stringify(value)} in the diagram’s text`

/** Read the keys behind a scaled control as one number, when they agree on one. */
function readScaled(
  reading: MermaidSourceConfigReading,
  keys: readonly ScaledKey[],
  fromWritten: (written: number, base: number) => number,
  accept: (value: number) => boolean,
): MermaidControlReading<number> {
  let agreed: number | undefined
  let unset = 0
  let directiveLine: number | undefined
  for (const scaled of keys) {
    const current = readMermaidConfigValue(reading, scaled.path)
    if (current.state === 'unknown') {
      return { state: 'other', description: current.reason }
    }
    if (current.state === 'unset') {
      unset++
      continue
    }
    if (current.from === 'directive') {
      directiveLine = current.line
    }
    const written = parseWritten(current.value, scaled.unit)
    const value = written === undefined ? undefined : fromWritten(written, scaled.base)
    if (value === undefined || !accept(value) || (agreed !== undefined && agreed !== value)) {
      return { state: 'other', description: describeValue(scaled.path, current.value) }
    }
    agreed = value
  }
  if (unset === keys.length) {
    return { state: 'default' }
  }
  if (unset > 0 || agreed === undefined) {
    // Some of the keys this control writes together are set and some are not:
    // somebody's hand edit, and not a state a single number describes.
    return { state: 'other', description: 'only some of its options are set in the diagram’s text' }
  }
  return directiveLine === undefined ? { state: 'set', value: agreed } : { state: 'set', value: agreed, directiveLine }
}

function parseWritten(value: MermaidConfigScalar, unit: 'px' | ''): number | undefined {
  if (unit === '') {
    return typeof value === 'number' ? value : undefined
  }
  const pixels = typeof value === 'string' ? /^(\d+(?:\.\d+)?)px$/.exec(value) : null
  return pixels === null ? undefined : Number(pixels[1])
}

/** Exactly representable for every whole size and every tenth of a percent this file writes. */
const tidy = (value: number): number => Number(value.toFixed(4))

function emitScaled(scaled: ScaledKey, value: number): MermaidConfigScalar {
  return scaled.unit === 'px' ? `${tidy(value)}px` : tidy(value)
}

const isWholeBetween = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max

/** Text size, as the pixel size body text has when mermaid's default is 16. */
export function readMermaidTextSize(reading: MermaidSourceConfigReading, kind: string): MermaidControlReading<number> {
  const keys = TEXT_SIZE_KEYS[kind]
  if (keys === undefined) {
    return { state: 'unavailable', reason: `Mermaid has no single text size for ${mermaidKindPhrase(kind)}.` }
  }
  return readScaled(
    reading,
    keys,
    (written, base) => tidy((written * DEFAULT_MERMAID_TEXT_SIZE) / base),
    (value) => isWholeBetween(value, MIN_MERMAID_TEXT_SIZE, MAX_MERMAID_TEXT_SIZE),
  )
}

/**
 * What a text size comes to for one kind of diagram: its share of mermaid's
 * default, and the pixels that kind's main text is then drawn at — 20 for a
 * flowchart at 125%, 13.75 for a Gantt chart, whose own default is 11.
 */
export function describeMermaidTextSize(kind: string, size: number): { percent: number; pixels: number } | null {
  const keys = TEXT_SIZE_KEYS[kind]
  if (keys === undefined) {
    return null
  }
  return {
    percent: Math.round((size / DEFAULT_MERMAID_TEXT_SIZE) * 100),
    pixels: tidy((size * keys[0].base) / DEFAULT_MERMAID_TEXT_SIZE),
  }
}

/** Spacing, as a percentage of mermaid's default. */
export function readMermaidSpacing(reading: MermaidSourceConfigReading, kind: string): MermaidControlReading<number> {
  const keys = SPACING_KEYS[kind]
  if (keys === undefined) {
    return { state: 'unavailable', reason: `Mermaid has no spacing option for ${mermaidKindPhrase(kind)}.` }
  }
  return readScaled(
    reading,
    keys,
    (written, base) => tidy((written * 100) / base),
    (value) => isWholeBetween(value, MIN_MERMAID_SPACING, MAX_MERMAID_SPACING),
  )
}

/**
 * The seed the text fixes the sketch with, or `undefined` when it fixes none —
 * which includes zero, mermaid's word for "a new random seed every render".
 */
function readFixedSketchSeed(reading: MermaidSourceConfigReading): number | undefined {
  const seed = readMermaidConfigValue(reading, ['handDrawnSeed'])
  return seed.state === 'set' && typeof seed.value === 'number' && seed.value >= 1 ? seed.value : undefined
}

export function readMermaidLook(
  reading: MermaidSourceConfigReading,
  kind: string,
): MermaidControlReading<MermaidLook> & { seed?: number } {
  if (!HAND_DRAWN_KINDS.includes(kind)) {
    return { state: 'unavailable', reason: `Mermaid draws ${mermaidKindPhrase(kind)} the same in either look.` }
  }
  const look = readMermaidConfigValue(reading, ['look'])
  if (look.state === 'unknown') {
    return { state: 'other', description: look.reason }
  }
  if (look.state === 'unset') {
    return { state: 'default' }
  }
  const offered = MERMAID_LOOKS.find((candidate) => candidate === look.value)
  if (offered === undefined) {
    return { state: 'other', description: describeValue(['look'], look.value) }
  }
  const fixed = readFixedSketchSeed(reading)
  return {
    state: 'set',
    value: offered,
    ...(look.from === 'directive' ? { directiveLine: look.line } : {}),
    ...(fixed === undefined ? {} : { seed: fixed }),
  }
}

export function readMermaidLineStyle(
  reading: MermaidSourceConfigReading,
  kind: string,
): MermaidControlReading<MermaidLineStyle> {
  if (!LINE_STYLE_KINDS.includes(kind)) {
    return { state: 'unavailable', reason: `Mermaid has no line style for ${mermaidKindPhrase(kind)}.` }
  }
  const curve = readMermaidConfigValue(reading, ['flowchart', 'curve'])
  if (curve.state === 'unknown') {
    return { state: 'other', description: curve.reason }
  }
  if (curve.state === 'unset') {
    return { state: 'default' }
  }
  const offered = MERMAID_LINE_STYLES.find((candidate) => candidate === curve.value)
  if (offered === undefined) {
    return { state: 'other', description: describeValue(['flowchart', 'curve'], curve.value) }
  }
  return curve.from === 'directive'
    ? { state: 'set', value: offered, directiveLine: curve.line }
    : { state: 'set', value: offered }
}

// --- what a control writes ------------------------------------------------------

/**
 * One edit, whole: the diagram's new text AND the block's theme, because a
 * theme choice changes both and they must land in one editor update — one undo
 * step, and never a moment where the text names a theme the block contradicts.
 */
export type MermaidCustomiseEdit =
  { ok: true; code: string; themeMode: MermaidThemeMode } | { ok: false; refusal: MermaidConfigRefusal }

const refuse = (refusal: MermaidConfigRefusal): MermaidCustomiseEdit => ({ ok: false, refusal })

const notOffered = (what: string): MermaidCustomiseEdit =>
  refuse({ code: 'invalid-change', message: `${what} is not something this panel offers. Nothing was changed.` })

const unavailable = (reason: string): MermaidCustomiseEdit =>
  refuse({ code: 'invalid-change', message: `${reason} Nothing was changed.` })

const remove = (path: MermaidConfigPath): MermaidConfigChange => ({ path, value: undefined })

/**
 * Write `changes`, refusing first if any key being TAKEN AWAY is one an init
 * directive decides. `patchMermaidSourceConfig` refuses that for a key being
 * set and deliberately not for a removal — but a control that goes back to the
 * default removes its key in order to change the picture, and with a directive
 * still naming the option it would change nothing and say nothing.
 */
function write(
  code: string,
  themeMode: MermaidThemeMode,
  changes: readonly MermaidConfigChange[],
): MermaidCustomiseEdit {
  const reading = readMermaidSourceConfig(code)
  for (const change of changes) {
    const refused = change.value === undefined ? mermaidDirectiveRefusal(reading, change.path) : null
    if (refused !== null) {
      return refuse(refused)
    }
  }
  const result = patchMermaidSourceConfig(code, changes)
  return result.ok ? { ok: true, code: result.text, themeMode } : refuse(result.refusal)
}

/**
 * Choose a theme. A named theme goes into the diagram's text and the block is
 * given the matching stored value (see `mermaidBlockThemeModeFor`); "follow the
 * app" takes the theme out of the text and sets the block to `app`.
 */
export function applyMermaidTheme(code: string, choice: 'app' | MermaidLibraryTheme): MermaidCustomiseEdit {
  if (choice === 'app') {
    return write(code, 'app', [remove(['theme'])])
  }
  if (normalizeMermaidLibraryTheme(choice) === undefined) {
    return notOffered(`The theme "${String(choice)}"`)
  }
  return write(code, mermaidBlockThemeModeFor(choice), [{ path: ['theme'], value: choice }])
}

export function applyMermaidLook(code: string, themeMode: MermaidThemeMode, look: MermaidLook): MermaidCustomiseEdit {
  const reading = readMermaidSourceConfig(code)
  const current = readMermaidLook(reading, mermaidCustomiseKind(code))
  if (current.state === 'unavailable') {
    return unavailable(current.reason)
  }
  if (look === 'classic') {
    return write(code, themeMode, [remove(['look']), remove(['handDrawnSeed'])])
  }
  if (look !== 'handDrawn') {
    return notOffered(`The look "${String(look)}"`)
  }
  return write(code, themeMode, [
    { path: ['look'], value: 'handDrawn' },
    // A seed the diagram already carries is kept, whether or not it had a look.
    { path: ['handDrawnSeed'], value: readFixedSketchSeed(reading) ?? DEFAULT_MERMAID_HAND_DRAWN_SEED },
  ])
}

/** Draw the same sketch with different strokes: the next seed. */
export function reshuffleMermaidSketch(code: string, themeMode: MermaidThemeMode): MermaidCustomiseEdit {
  const current = readMermaidLook(readMermaidSourceConfig(code), mermaidCustomiseKind(code))
  if (current.state === 'unavailable') {
    return unavailable(current.reason)
  }
  if (current.state !== 'set' || current.value !== 'handDrawn') {
    return unavailable('Only a hand-drawn diagram can be redrawn.')
  }
  const seed = current.seed ?? DEFAULT_MERMAID_HAND_DRAWN_SEED
  return write(code, themeMode, [
    { path: ['handDrawnSeed'], value: seed >= MAX_MERMAID_HAND_DRAWN_SEED ? 1 : Math.floor(seed) + 1 },
  ])
}

function applyScaled(
  code: string,
  themeMode: MermaidThemeMode,
  keys: readonly ScaledKey[],
  isDefault: boolean,
  toWritten: (base: number) => number,
): MermaidCustomiseEdit {
  const changes = keys.map((scaled): MermaidConfigChange => {
    if (isDefault) {
      return remove(scaled.path)
    }
    return { path: scaled.path, value: emitScaled(scaled, toWritten(scaled.base)) }
  })
  return write(code, themeMode, changes)
}

/** Set the text size, in pixels at mermaid's default of 16. 16 itself writes nothing. */
export function applyMermaidTextSize(code: string, themeMode: MermaidThemeMode, size: number): MermaidCustomiseEdit {
  const kind = mermaidCustomiseKind(code)
  const keys = TEXT_SIZE_KEYS[kind]
  if (keys === undefined) {
    return unavailable(`Mermaid has no single text size for ${mermaidKindPhrase(kind)}.`)
  }
  if (!isWholeBetween(size, MIN_MERMAID_TEXT_SIZE, MAX_MERMAID_TEXT_SIZE)) {
    return notOffered(`A text size of ${String(size)}`)
  }
  return applyScaled(
    code,
    themeMode,
    keys,
    size === DEFAULT_MERMAID_TEXT_SIZE,
    (base) => (size * base) / DEFAULT_MERMAID_TEXT_SIZE,
  )
}

/** Set the spacing, as a percentage of mermaid's default. 100 itself writes nothing. */
export function applyMermaidSpacing(code: string, themeMode: MermaidThemeMode, percent: number): MermaidCustomiseEdit {
  const kind = mermaidCustomiseKind(code)
  const keys = SPACING_KEYS[kind]
  if (keys === undefined) {
    return unavailable(`Mermaid has no spacing option for ${mermaidKindPhrase(kind)}.`)
  }
  if (!isWholeBetween(percent, MIN_MERMAID_SPACING, MAX_MERMAID_SPACING)) {
    return notOffered(`A spacing of ${String(percent)}%`)
  }
  return applyScaled(code, themeMode, keys, percent === DEFAULT_MERMAID_SPACING, (base) => (base * percent) / 100)
}

export function applyMermaidLineStyle(
  code: string,
  themeMode: MermaidThemeMode,
  style: MermaidLineStyle,
): MermaidCustomiseEdit {
  const kind = mermaidCustomiseKind(code)
  if (!LINE_STYLE_KINDS.includes(kind)) {
    return unavailable(`Mermaid has no line style for ${mermaidKindPhrase(kind)}.`)
  }
  if (!MERMAID_LINE_STYLES.includes(style)) {
    return notOffered(`The line style "${String(style)}"`)
  }
  return write(code, themeMode, [
    style === DEFAULT_MERMAID_LINE_STYLE
      ? remove(['flowchart', 'curve'])
      : { path: ['flowchart', 'curve'], value: style },
  ])
}

/**
 * The managed options an init directive decides — the ones no control here can
 * change, because the directive wins over the frontmatter the controls write.
 * `null` when no directive touches any of them. `unreadable` is a directive
 * mermaid applies in a way the reader does not follow: it may decide any.
 */
export function readMermaidDirectiveOverrides(
  reading: MermaidSourceConfigReading,
): { line: number; keys: string[]; unreadable: boolean } | null {
  if (reading.directive.state === 'absent') {
    return null
  }
  if (reading.directive.state === 'unreadable') {
    return { line: reading.directive.line, keys: [], unreadable: true }
  }
  const keys = MERMAID_MANAGED_CONFIG_PATHS.filter((path) => mermaidDirectiveRefusal(reading, path) !== null).map(
    (path) => path.join('.'),
  )
  return keys.length === 0 ? null : { line: reading.directive.line, keys, unreadable: false }
}

// --- what a preset is made of ---------------------------------------------------

/** The parts of a look a preset may fix. Anything it leaves out is mermaid's default. */
export type MermaidStyleBundle = {
  theme?: MermaidLibraryTheme
  look?: 'handDrawn'
  textSize?: number
  spacing?: number
}

/**
 * The keys a bundle writes for one kind of diagram — only the parts that kind
 * has a working option for. `null` when the bundle would change nothing there:
 * a hand-drawn look for a pie chart, say.
 */
export function mermaidBundleChanges(bundle: MermaidStyleBundle, kind: string): MermaidConfigChange[] | null {
  const changes: MermaidConfigChange[] = []
  if (bundle.theme !== undefined) {
    changes.push({ path: ['theme'], value: bundle.theme })
  }
  if (bundle.look === 'handDrawn' && HAND_DRAWN_KINDS.includes(kind)) {
    changes.push({ path: ['look'], value: 'handDrawn' })
    changes.push({ path: ['handDrawnSeed'], value: DEFAULT_MERMAID_HAND_DRAWN_SEED })
  }
  const sizeKeys = TEXT_SIZE_KEYS[kind]
  if (bundle.textSize !== undefined && bundle.textSize !== DEFAULT_MERMAID_TEXT_SIZE && sizeKeys !== undefined) {
    for (const scaled of sizeKeys) {
      const written = (bundle.textSize * scaled.base) / DEFAULT_MERMAID_TEXT_SIZE
      changes.push({ path: scaled.path, value: emitScaled(scaled, written) })
    }
  }
  const spacingKeys = SPACING_KEYS[kind]
  if (bundle.spacing !== undefined && bundle.spacing !== DEFAULT_MERMAID_SPACING && spacingKeys !== undefined) {
    for (const scaled of spacingKeys) {
      changes.push({ path: scaled.path, value: emitScaled(scaled, (scaled.base * bundle.spacing) / 100) })
    }
  }
  const asked =
    bundle.theme !== undefined ||
    bundle.look !== undefined ||
    bundle.textSize !== undefined ||
    bundle.spacing !== undefined
  return asked && changes.length === 0 ? null : changes
}

/**
 * Replace everything the panel manages with one bundle: every managed key the
 * bundle does not set is taken out of the text, so a preset is a complete look
 * and not a layer on whatever was there.
 */
export function applyMermaidStyleBundle(code: string, bundle: MermaidStyleBundle): MermaidCustomiseEdit {
  const kind = mermaidCustomiseKind(code)
  const sets = mermaidBundleChanges(bundle, kind)
  if (sets === null) {
    return unavailable(`Mermaid has none of these options for ${mermaidKindPhrase(kind)}.`)
  }
  if (sets.length === 0 && code.trim() === '') {
    // Nothing to take out of an empty diagram; the block can still go back to
    // following the app.
    return { ok: true, code, themeMode: 'app' }
  }
  const written = new Set(sets.map((change) => change.path.join('.')))
  const removals = MERMAID_MANAGED_CONFIG_PATHS.filter((path) => !written.has(path.join('.'))).map(remove)
  // Through `patchMermaidSourceConfig` directly, not `write`: a removal here is
  // tidying, not the point of the edit, so a directive that sets a key the
  // bundle leaves alone does not stop the bundle. One that sets a key the
  // bundle WRITES still does.
  const result = patchMermaidSourceConfig(code, [...removals, ...sets])
  if (!result.ok) {
    return refuse(result.refusal)
  }
  return {
    ok: true,
    code: result.text,
    themeMode: bundle.theme === undefined ? 'app' : mermaidBlockThemeModeFor(bundle.theme),
  }
}

/**
 * Every managed key the FRONTMATTER sets, dotted, with its value — or `null`
 * when the text cannot be vouched for, and so cannot be said to match anything.
 */
export function readMermaidManagedKeys(reading: MermaidSourceConfigReading): Map<string, MermaidConfigScalar> | null {
  const managed = new Map<string, MermaidConfigScalar>()
  for (const path of MERMAID_MANAGED_CONFIG_PATHS) {
    const current = readMermaidConfigValue(reading, path)
    if (current.state === 'unknown') {
      return null
    }
    if (current.state === 'set') {
      managed.set(path.join('.'), current.value)
    }
  }
  return managed
}
