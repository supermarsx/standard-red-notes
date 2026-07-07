/**
 * Standard Red Notes: Typography Profiles — apply pipeline (Phase 1).
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

/** Maps each block type to the selector(s) (relative to the scope) it targets. */
const BLOCK_SELECTORS: Record<BlockTypeKey, string[]> = {
  paragraph: ['.Lexical__paragraph'],
  h1: ['.Lexical__h1'],
  h2: ['.Lexical__h2'],
  h3: ['.Lexical__h3'],
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

/** Push a `prop: value` declaration if the value is safe. */
const pushDecl = (decls: string[], prop: string, value: string | undefined): void => {
  if (isSafeCssValue(value)) {
    decls.push(`${prop}: ${value.trim()}`)
  }
}

/**
 * Compile a single block's `BlockStyle` into a list of CSS declarations
 * (property: value), skipping unset and unsafe values.
 */
export const blockStyleToDeclarations = (style: BlockStyle): string[] => {
  const decls: string[] = []

  // Spacing / indentation (mirror blockFormatting.ts).
  pushDecl(decls, 'line-height', style.lineHeight)
  pushDecl(decls, 'margin-top', style.marginTop)
  pushDecl(decls, 'margin-bottom', style.marginBottom)
  pushDecl(decls, 'margin-left', style.marginLeft)
  pushDecl(decls, 'margin-right', style.marginRight)
  pushDecl(decls, 'padding-left', style.paddingLeft)
  pushDecl(decls, 'padding-right', style.paddingRight)
  pushDecl(decls, 'text-indent', style.textIndent)

  // Typography.
  const fontFamily = resolveFontFamily(style.fontFamily)
  if (fontFamily) {
    decls.push(`font-family: ${fontFamily}`)
  }
  pushDecl(decls, 'font-size', style.fontSize)
  pushDecl(decls, 'font-weight', style.fontWeight)
  pushDecl(decls, 'font-style', style.fontStyle)
  pushDecl(decls, 'letter-spacing', style.letterSpacing)
  pushDecl(decls, 'text-transform', style.textTransform)

  // Colour.
  pushDecl(decls, 'color', style.color)
  pushDecl(decls, 'background-color', style.backgroundColor)

  // Alignment.
  pushDecl(decls, 'text-align', style.textAlign)

  // Box props. borderSide selects which edge the colour/width/style apply to.
  const side = style.borderSide && style.borderSide !== 'all' ? `-${style.borderSide}` : ''
  pushDecl(decls, `border${side}-color`, style.borderColor)
  pushDecl(decls, `border${side}-width`, style.borderWidth)
  pushDecl(decls, `border${side}-style`, style.borderStyle)
  pushDecl(decls, 'border-radius', style.borderRadius)
  pushDecl(decls, 'padding-block', style.paddingBlock)

  // Lists.
  pushDecl(decls, 'list-style-type', style.listMarkerStyle)

  return decls
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

    const scopedSelector = BLOCK_SELECTORS[blockKey]
      .map((sel) => `${TYPOGRAPHY_SCOPE_SELECTOR} ${sel}`)
      .join(', ')

    const decls = blockStyleToDeclarations(style)
    if (decls.length > 0) {
      rules.push(`${scopedSelector} {\n  ${decls.join(';\n  ')};\n}`)
    }

    // ::marker colour needs its own rule (targets the list-item markers).
    if (isSafeCssValue(style.markerColor)) {
      const markerSelector = BLOCK_SELECTORS[blockKey]
        .map((sel) => `${TYPOGRAPHY_SCOPE_SELECTOR} ${sel} ::marker`)
        .join(', ')
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
  return (
    profiles.find((p) => p.id === activeId) ?? profiles.find((p) => p.isDefault) ?? profiles[0] ?? null
  )
}
