/**
 * Standard Red Notes: Typography Profiles application pipeline.
 *
 * Compiles the active `TypographyProfile` (see @standardnotes/models) into a
 * single, scoped `<style id="srn-typography-profile">` element injected on
 * `document.head`. Because it lives on the head it is picked up automatically by
 * every Super-editor surface — the editable editor, the read-only viewer and
 * previews — without touching any note (no per-block inline seeding).
 *
 * Cascade design:
 *   - Rules are scoped under the editor root (`.ContentEditable__root <block>`),
 *     giving specificity (0,2,0) — HIGHER than the theme's own `.Lexical__*`
 *     rules (0,1,0) in editor.scss, so a non-default profile reliably overrides
 *     the theme.
 *   - No `!important` is used, so the per-block inline styles the toolbar (#77)
 *     writes — inline styles outrank any selector rule — always win. A profile
 *     therefore only sets the *default* for blocks the user hasn't hand-tuned.
 *
 * Security (CSP): values are sanitised — `url()`, `@import`, `expression()`,
 * `javascript:`, angle brackets, comment markers and CSS structural characters
 * are rejected, so no external fetch can be smuggled in. Font families go
 * through the same vetted `google:` grammar as the editor-font feature.
 */

import type { BlockStyle, BlockTypeKey, TypographyProfile } from '@standardnotes/models'
import { resolveEditorFontFamily } from './editorFont'

/** Id of the single injected <style> element. */
export const TYPOGRAPHY_STYLE_ELEMENT_ID = 'srn-typography-profile'

/**
 * The editor root class present on every Super-editor render surface (editable,
 * read-only and preview all render through `BlocksEditor` → `ContentEditable`).
 * Scoping under it lifts specificity above editor.scss while staying below any
 * inline style.
 */
export const TYPOGRAPHY_SCOPE_SELECTOR = '.ContentEditable__root'

/**
 * Maps each block type to the selector(s) (relative to the scope) it targets.
 * Partial: the paragraph-variant keys (title/normalSpaced/accented/strong/
 * emphasis) intentionally have NO global selector — they share `.Lexical__paragraph`
 * and are styled only per-block via the gallery descriptor's `baseStyle`, so a
 * global rule would wrongly restyle every paragraph.
 */
const BLOCK_SELECTORS: Partial<Record<BlockTypeKey, string[]>> = {
  paragraph: ['.Lexical__paragraph'],
  h1: ['.Lexical__h1'],
  h2: ['.Lexical__h2'],
  h3: ['.Lexical__h3'],
  h4: ['.Lexical__h4'],
  h5: ['.Lexical__h5'],
  quote: ['.Lexical__quote'],
  code: ['.Lexical__code'],
  callout: ['[data-callout-block="true"]'],
  bulletList: ['.Lexical__ul'],
  numberedList: ['.Lexical__ol1', '.Lexical__ol2', '.Lexical__ol3', '.Lexical__ol4', '.Lexical__ol5'],
  checkList: ['.Lexical__checkList'],
}

/**
 * Rejects any value that could smuggle an external reference or break out of the
 * declaration. Empty/whitespace values are also rejected (nothing to emit).
 */
const FORBIDDEN_VALUE = /url\(|@import|expression\(|javascript:|[<>{};]|\/\*|\*\/|\\/i

export const isSafeCssValue = (value: string | undefined): value is string => {
  if (value === undefined) {
    return false
  }
  const trimmed = value.trim()
  return trimmed !== '' && !FORBIDDEN_VALUE.test(trimmed)
}

/** Resolve a font-family value through the vetted editor-font grammar. */
const resolveFontFamily = (value: string | undefined): string | null => {
  const resolved = resolveEditorFontFamily(value)
  return resolved && isSafeCssValue(resolved) ? resolved : null
}

/**
 * Compile a single block's `BlockStyle` into ordered `[cssProperty, value]`
 * pairs (kebab-case property names), skipping unset and unsafe values. This is
 * the single source of truth shared by the scoped-CSS compiler
 * (`blockStyleToDeclarations`/`blockStyleToCss`), the inline-style builder for
 * the toolbar preview squares (`blockStyleToInlineStyle`), and the per-block
 * apply path (the gallery writes these pairs onto the selected block's inline
 * style via blockFormatting's `$applyBlockStyleEntries`).
 */
export const blockStyleToStyleEntries = (style: BlockStyle): Array<[string, string]> => {
  const entries: Array<[string, string]> = []
  const push = (prop: string, value: string | undefined): void => {
    if (isSafeCssValue(value)) {
      entries.push([prop, value.trim()])
    }
  }

  // Spacing / indentation (mirror blockFormatting.ts).
  push('line-height', style.lineHeight)
  push('margin-top', style.marginTop)
  push('margin-bottom', style.marginBottom)
  push('margin-left', style.marginLeft)
  push('margin-right', style.marginRight)
  push('padding-left', style.paddingLeft)
  push('padding-right', style.paddingRight)
  push('text-indent', style.textIndent)

  // Typography.
  const fontFamily = resolveFontFamily(style.fontFamily)
  if (fontFamily) {
    entries.push(['font-family', fontFamily])
  }
  push('font-size', style.fontSize)
  push('font-weight', style.fontWeight)
  push('font-style', style.fontStyle)
  push('letter-spacing', style.letterSpacing)
  push('text-transform', style.textTransform)

  // Colour.
  push('color', style.color)
  push('background-color', style.backgroundColor)

  // Alignment.
  push('text-align', style.textAlign)

  // Box props. borderSide selects which edge the colour/width/style apply to.
  const side = style.borderSide && style.borderSide !== 'all' ? `-${style.borderSide}` : ''
  push(`border${side}-color`, style.borderColor)
  push(`border${side}-width`, style.borderWidth)
  push(`border${side}-style`, style.borderStyle)
  push('border-radius', style.borderRadius)
  push('padding-block', style.paddingBlock)

  // Lists.
  push('list-style-type', style.listMarkerStyle)

  return entries
}

/**
 * Compile a single block's `BlockStyle` into a list of CSS declarations
 * (`property: value`), skipping unset and unsafe values.
 */
export const blockStyleToDeclarations = (style: BlockStyle): string[] =>
  blockStyleToStyleEntries(style).map(([prop, value]) => `${prop}: ${value}`)

/** kebab-case CSS property -> camelCase React style key (e.g. `line-height` -> `lineHeight`). */
const cssPropToCamelCase = (prop: string): string => prop.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())

/**
 * Build a React-compatible inline style object (camelCase keys) from a
 * `BlockStyle`, reusing the exact same vetted `[prop, value]` pairs the scoped
 * CSS compiler emits. Used by the toolbar's preview squares so each square is a
 * *truthful* render of the block as the active profile styles it — inline styles
 * outrank the base theme class exactly as the per-block override does in the
 * real editor. Returned as a plain string map; callers cast to `CSSProperties`.
 */
export const blockStyleToInlineStyle = (style: BlockStyle): Record<string, string> => {
  const inline: Record<string, string> = {}
  for (const [prop, value] of blockStyleToStyleEntries(style)) {
    inline[cssPropToCamelCase(prop)] = value
  }
  return inline
}

/**
 * Compile a whole profile into a scoped CSS string (one rule per block type, and
 * an extra `::marker` rule when a marker colour is set). Blocks with no safe
 * declarations emit nothing.
 */
export const blockStyleToCss = (profile: TypographyProfile): string => {
  const rules: string[] = []

  const blockKeys = Object.keys(BLOCK_SELECTORS) as BlockTypeKey[]
  for (const blockKey of blockKeys) {
    const style = profile.blocks[blockKey]
    if (!style) {
      continue
    }
    // BLOCK_SELECTORS is Partial: paragraph-variant keys have no global selector.
    const selectors = BLOCK_SELECTORS[blockKey]
    if (!selectors) {
      continue
    }

    const scopedSelector = selectors.map((sel) => `${TYPOGRAPHY_SCOPE_SELECTOR} ${sel}`).join(', ')

    const decls = blockStyleToDeclarations(style)
    if (decls.length > 0) {
      rules.push(`${scopedSelector} {\n  ${decls.join(';\n  ')};\n}`)
    }

    // ::marker colour needs its own rule (targets the list-item markers).
    if (isSafeCssValue(style.markerColor)) {
      const markerSelector = selectors.map((sel) => `${TYPOGRAPHY_SCOPE_SELECTOR} ${sel} ::marker`).join(', ')
      rules.push(`${markerSelector} {\n  color: ${style.markerColor.trim()};\n}`)
    }
  }

  return rules.join('\n\n')
}

/**
 * Injects (or updates) the single `<style id="srn-typography-profile">` element
 * on `document.head` with the CSS compiled from `profile`. Passing `null`
 * removes the element. Safe to call repeatedly (idempotent, O(1) elements).
 */
export const applyTypographyProfile = (profile: TypographyProfile | null | undefined): void => {
  if (typeof document === 'undefined') {
    return
  }

  const existing = document.getElementById(TYPOGRAPHY_STYLE_ELEMENT_ID) as HTMLStyleElement | null

  if (!profile) {
    existing?.remove()
    return
  }

  const css = blockStyleToCss(profile)

  const styleEl = existing ?? document.createElement('style')
  if (!existing) {
    styleEl.id = TYPOGRAPHY_STYLE_ELEMENT_ID
    document.head.appendChild(styleEl)
  }
  if (styleEl.textContent !== css) {
    styleEl.textContent = css
  }
}

/**
 * Resolves the active profile from the synced prefs: the profile whose id
 * matches `activeId`, else the one flagged `isDefault`, else the first, else
 * null. Never throws on malformed input.
 */
export const resolveActiveTypographyProfile = (
  profiles: TypographyProfile[] | undefined,
  activeId: string | undefined,
): TypographyProfile | null => {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return null
  }
  return profiles.find((p) => p.id === activeId) ?? profiles.find((p) => p.isDefault) ?? profiles[0] ?? null
}
