import {
  applyMermaidStyleBundle,
  mermaidBundleChanges,
  type MermaidCustomiseEdit,
  mermaidCustomiseKind,
  mermaidKindPhrase,
  MERMAID_MANAGED_CONFIG_PATHS,
  type MermaidStyleBundle,
  readMermaidEffectiveTheme,
  readMermaidManagedKeys,
} from './MermaidConfigCatalog'
import { type MermaidThemeMode } from './MermaidSettings'
import { listMermaidFrontmatterConfig, readMermaidSourceConfig } from './MermaidSourceConfig'

/**
 * Standard Red Notes — one-click looks for a Mermaid diagram.
 *
 * A preset is a NAMED BUNDLE of the same options the Customise panel's own
 * controls write, and nothing more: applying one writes ordinary lines into the
 * diagram's frontmatter, which the person can then see, adjust with the
 * controls or edit by hand. There is no stored "preset" anywhere — which one is
 * active is worked out from the text, so a diagram that arrives from another
 * mermaid tool with the same options shows the same preset.
 *
 * A PRESET REPLACES; it does not layer. Applying one takes every option the
 * panel manages out of the text and writes the bundle's, so "Monochrome" after
 * "Presentation" is Monochrome, not both. That is what makes a preset one
 * click, and what makes "App" — the bundle that writes nothing — the way back.
 *
 * Each bundle is resolved for the KIND of diagram it lands on
 * (MermaidConfigCatalog.ts): "Presentation" is larger text and more room, which
 * is `themeVariables.fontSize` and two `flowchart` keys for a flowchart and the
 * root `fontSize` and two `sequence` keys for a sequence diagram. Where a
 * bundle has nothing a kind can take — a hand-drawn pie chart — the preset is
 * unavailable there and says so, rather than being a button that does nothing.
 *
 * Pure: no React, no mermaid, no DOM.
 */

export const MERMAID_STYLE_PRESET_IDS = ['app', 'sketch', 'compact', 'presentation', 'monochrome', 'print'] as const
export type MermaidStylePresetId = (typeof MERMAID_STYLE_PRESET_IDS)[number]

export type MermaidStylePreset = {
  id: MermaidStylePresetId
  label: string
  /** One line saying what it does, shown under the label and as its tooltip. */
  description: string
  bundle: MermaidStyleBundle
}

export const MERMAID_STYLE_PRESETS: readonly MermaidStylePreset[] = [
  {
    id: 'app',
    label: 'App',
    description: 'Follows the app’s light or dark theme. Writes nothing into the diagram.',
    bundle: {},
  },
  {
    id: 'sketch',
    label: 'Sketch',
    description: 'Hand-drawn strokes, in the app’s colours.',
    bundle: { look: 'handDrawn' },
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Smaller text, closer together.',
    bundle: { textSize: 14, spacing: 60 },
  },
  {
    id: 'presentation',
    label: 'Presentation',
    description: 'Larger text, with more room round it.',
    bundle: { textSize: 20, spacing: 160 },
  },
  {
    id: 'monochrome',
    label: 'Monochrome',
    description: 'Mermaid’s neutral theme: greys on a white page.',
    bundle: { theme: 'neutral' },
  },
  {
    // Mermaid's own light theme: dark text on a white page whatever the app's
    // theme is, which is what survives a printer. A diagram that follows a dark
    // app theme carries light text into the print.
    id: 'print',
    label: 'Print-safe',
    description: 'Mermaid’s light theme: dark text on a white page, whatever the app’s theme.',
    bundle: { theme: 'default' },
  },
]

export function mermaidStylePreset(id: MermaidStylePresetId): MermaidStylePreset {
  const preset = MERMAID_STYLE_PRESETS.find((candidate) => candidate.id === id)
  if (preset === undefined) {
    throw new Error(`no Mermaid style preset "${String(id)}"`)
  }
  return preset
}

/** Can this preset change anything for the kind of diagram `code` is? */
export function mermaidStylePresetAvailability(
  id: MermaidStylePresetId,
  code: string,
): { available: true } | { available: false; reason: string } {
  const preset = mermaidStylePreset(id)
  const kind = mermaidCustomiseKind(code)
  if (mermaidBundleChanges(preset.bundle, kind) !== null) {
    return { available: true }
  }
  return {
    available: false,
    reason: `${preset.label} changes nothing for ${mermaidKindPhrase(kind)}: mermaid has none of its options for that kind.`,
  }
}

/** Apply a preset: every managed option is replaced by the preset's. */
export function applyMermaidStylePreset(code: string, id: MermaidStylePresetId): MermaidCustomiseEdit {
  const availability = mermaidStylePresetAvailability(id, code)
  if (!availability.available) {
    return { ok: false, refusal: { code: 'invalid-change', message: `${availability.reason} Nothing was changed.` } }
  }
  return applyMermaidStyleBundle(code, mermaidStylePreset(id).bundle)
}

/**
 * Take every option the panel manages out of the diagram's text, and let the
 * diagram follow the app's theme again. The same edit as the "App" preset, by
 * the name a person looks for when they want their changes gone.
 */
export function resetMermaidCustomisation(code: string): MermaidCustomiseEdit {
  return applyMermaidStyleBundle(code, {})
}

/**
 * Is there anything for Reset to take away? True also when the frontmatter
 * cannot be read: pressing Reset then says why it will not touch it, which is
 * more use than a dead button.
 */
export function mermaidCustomisationCanReset(code: string, themeMode: MermaidThemeMode): boolean {
  if (themeMode !== 'app') {
    return true
  }
  const reading = readMermaidSourceConfig(code)
  if (reading.frontmatter.state === 'unreadable') {
    return true
  }
  const managed = new Set(MERMAID_MANAGED_CONFIG_PATHS.map((path) => path.join('.')))
  return listMermaidFrontmatterConfig(reading).some((item) => managed.has(item.key))
}

/**
 * Which preset the diagram is in right now, worked out from its text and the
 * block's theme — or `null` when it matches none, which is what any adjustment
 * with the panel's own controls produces.
 *
 * The hand-drawn seed is compared by presence, not value: "Redraw" changes the
 * seed, and a redrawn sketch is still the Sketch preset.
 */
export function activeMermaidStylePreset(code: string, themeMode: MermaidThemeMode): MermaidStylePresetId | null {
  const reading = readMermaidSourceConfig(code)
  const managed = readMermaidManagedKeys(reading)
  if (managed === null) {
    return null
  }
  const theme = readMermaidEffectiveTheme(reading, themeMode)
  const kind = mermaidCustomiseKind(code)
  managed.delete('theme')
  for (const preset of MERMAID_STYLE_PRESETS) {
    const changes = mermaidBundleChanges(preset.bundle, kind)
    if (changes === null) {
      continue
    }
    const themeMatches =
      preset.bundle.theme === undefined
        ? theme.state === 'app'
        : theme.state === 'named' && theme.theme === preset.bundle.theme
    const expected = changes.filter((change) => change.path.join('.') !== 'theme')
    const optionsMatch =
      expected.length === managed.size &&
      expected.every((change) => {
        const key = change.path.join('.')
        return key === 'handDrawnSeed' ? managed.has(key) : managed.get(key) === change.value
      })
    if (themeMatches && optionsMatch) {
      return preset.id
    }
  }
  return null
}
