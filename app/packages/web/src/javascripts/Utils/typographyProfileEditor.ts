/**
 * Standard Red Notes: Typography Profiles — Phase 3 (popup style editor logic).
 *
 * The pure, React-free core behind `TypographyStyleEditorModal`: sanitising a
 * user-edited `BlockStyle` (CSP-safe, no `url()`/`@import`/etc. can be stored)
 * and writing an edited block style back into the ACTIVE profile, producing a
 * NEW `TypographyProfile[]` array ready to hand to
 * `application.setPreference(PrefKey.TypographyProfiles, …)`.
 *
 * Reuse: sanitisation leans on P1's `isSafeCssValue` (the single CSP gate) and
 * the vetted `resolveEditorFontFamily` font grammar; active-profile resolution
 * reuses P1's `resolveActiveTypographyProfile`. No new preference keys, no
 * schema changes — this only reshapes the existing `TypographyProfiles` blob.
 */
import {
  DEFAULT_TYPOGRAPHY_PROFILE,
  type BlockBorderSide,
  type BlockStyle,
  type BlockTypeKey,
  type TypographyProfile,
} from '@standardnotes/models'
import { isSafeCssValue, resolveActiveTypographyProfile } from './typographyProfiles'
import { resolveEditorFontFamily } from './editorFont'

/**
 * Every `BlockStyle` field that carries a free-form CSS *value* string (i.e.
 * everything except `fontFamily`, which uses the editor-font grammar, and
 * `borderSide`, which is a fixed enum). Each is gated by `isSafeCssValue`.
 */
const CSS_VALUE_KEYS: Array<Exclude<keyof BlockStyle, 'fontFamily' | 'borderSide'>> = [
  'lineHeight',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'paddingLeft',
  'paddingRight',
  'textIndent',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'textTransform',
  'color',
  'backgroundColor',
  'textAlign',
  'borderColor',
  'borderWidth',
  'borderStyle',
  'borderRadius',
  'paddingBlock',
  'listMarkerStyle',
  'markerColor',
]

/** The allowed `borderSide` enum values (anything else is dropped). */
const BORDER_SIDES: readonly BlockBorderSide[] = ['all', 'left', 'right', 'top', 'bottom']

/**
 * Produce a clean `BlockStyle` containing only safe, non-empty values. Unsafe
 * values (CSP-dangerous, per `isSafeCssValue`) and empty/whitespace values
 * ("inherit") are dropped, so nothing dangerous is ever persisted. `fontFamily`
 * is validated through the vetted editor-font grammar (a `google:` value or a
 * literal stack that resolves to a safe CSS value); the raw grammar string is
 * kept so P1's apply path can resolve it. `borderSide` is whitelisted.
 */
export const sanitizeBlockStyle = (style: BlockStyle | undefined): BlockStyle => {
  const clean: BlockStyle = {}
  if (!style) {
    return clean
  }

  for (const key of CSS_VALUE_KEYS) {
    const value = style[key]
    if (typeof value === 'string' && isSafeCssValue(value)) {
      clean[key] = value.trim()
    }
  }

  if (typeof style.fontFamily === 'string' && style.fontFamily.trim() !== '') {
    const resolved = resolveEditorFontFamily(style.fontFamily.trim())
    if (resolved && isSafeCssValue(resolved)) {
      clean.fontFamily = style.fontFamily.trim()
    }
  }

  if (style.borderSide && BORDER_SIDES.includes(style.borderSide)) {
    clean.borderSide = style.borderSide
  }

  return clean
}

/** True when a (sanitised) block style contributes no declarations at all. */
export const isBlockStyleEmpty = (style: BlockStyle): boolean => Object.keys(style).length === 0

/** Ensure we always have a concrete, non-empty profile list to edit. */
const ensureProfiles = (profiles: TypographyProfile[] | undefined): TypographyProfile[] => {
  return Array.isArray(profiles) && profiles.length > 0 ? profiles : [DEFAULT_TYPOGRAPHY_PROFILE]
}

/**
 * Write a single edited `BlockStyle` back into the ACTIVE profile, returning a
 * brand-new `TypographyProfile[]` (immutable — inputs are never mutated) ready
 * for `setPreference(PrefKey.TypographyProfiles, …)`. The style is sanitised
 * first; an empty result removes that block's entry (back to "inherit"). Other
 * blocks and other profiles are preserved untouched.
 */
export const setActiveProfileBlockStyle = (
  profiles: TypographyProfile[] | undefined,
  activeId: string | undefined,
  blockKey: BlockTypeKey,
  style: BlockStyle,
): TypographyProfile[] => {
  const list = ensureProfiles(profiles)
  const active = resolveActiveTypographyProfile(list, activeId)
  const sanitized = sanitizeBlockStyle(style)

  return list.map((profile) => {
    if (profile !== active) {
      return profile
    }
    const blocks = { ...profile.blocks }
    if (isBlockStyleEmpty(sanitized)) {
      delete blocks[blockKey]
    } else {
      blocks[blockKey] = sanitized
    }
    return { ...profile, blocks }
  })
}

/**
 * Replace the ACTIVE profile's whole `blocks` map with `blocks`, sanitising each
 * entry and dropping any that become empty. Used by the modal's Save so all
 * edits made across block types persist in one write. Immutable; other profiles
 * are preserved.
 */
export const setActiveProfileBlocks = (
  profiles: TypographyProfile[] | undefined,
  activeId: string | undefined,
  blocks: Partial<Record<BlockTypeKey, BlockStyle>>,
): TypographyProfile[] => {
  const list = ensureProfiles(profiles)
  const active = resolveActiveTypographyProfile(list, activeId)

  const sanitizedBlocks: Partial<Record<BlockTypeKey, BlockStyle>> = {}
  for (const key of Object.keys(blocks) as BlockTypeKey[]) {
    const sanitized = sanitizeBlockStyle(blocks[key])
    if (!isBlockStyleEmpty(sanitized)) {
      sanitizedBlocks[key] = sanitized
    }
  }

  return list.map((profile) => (profile === active ? { ...profile, blocks: sanitizedBlocks } : profile))
}
