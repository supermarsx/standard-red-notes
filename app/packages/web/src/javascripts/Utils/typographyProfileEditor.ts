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
  DEFAULT_TYPOGRAPHY_PROFILE_ID,
  TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
  type BlockBorderSide,
  type BlockStyle,
  type BlockTypeKey,
  type TypographyProfile,
} from '@standardnotes/models'
import { isSafeCssValue, resolveActiveTypographyProfile } from './typographyProfiles'
import { resolveEditorFontFamily } from './editorFont'

let profileIdCounter = 0

/**
 * Generate a fresh, reasonably-unique profile id. Uses `crypto.randomUUID` when
 * available, otherwise a time+counter fallback (keeps this module usable in
 * tests without crypto / app bootstrap). Mirrors `generateBookmarkId`.
 */
export const newProfileId = (): string => {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  profileIdCounter += 1
  return `profile-${Date.now().toString(36)}-${profileIdCounter.toString(36)}`
}

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

/** Sanitise a whole `blocks` map, dropping entries that become empty. */
const sanitizeBlocks = (
  blocks: Partial<Record<BlockTypeKey, BlockStyle>>,
): Partial<Record<BlockTypeKey, BlockStyle>> => {
  const sanitizedBlocks: Partial<Record<BlockTypeKey, BlockStyle>> = {}
  for (const key of Object.keys(blocks) as BlockTypeKey[]) {
    const sanitized = sanitizeBlockStyle(blocks[key])
    if (!isBlockStyleEmpty(sanitized)) {
      sanitizedBlocks[key] = sanitized
    }
  }
  return sanitizedBlocks
}

/**
 * Replace the whole `blocks` map of the profile identified by `profileId`,
 * sanitising each entry and dropping any that become empty. Generalises
 * `setActiveProfileBlocks` so the popup editor can target ANY profile (P4), not
 * just the active one. Immutable; other profiles are preserved untouched. A
 * `profileId` that matches nothing is a no-op (returns the list unchanged).
 */
export const setProfileBlocks = (
  profiles: TypographyProfile[] | undefined,
  profileId: string | undefined,
  blocks: Partial<Record<BlockTypeKey, BlockStyle>>,
): TypographyProfile[] => {
  const list = ensureProfiles(profiles)
  const sanitizedBlocks = sanitizeBlocks(blocks)
  return list.map((profile) => (profile.id === profileId ? { ...profile, blocks: sanitizedBlocks } : profile))
}

/**
 * Replace the ACTIVE profile's whole `blocks` map with `blocks`, sanitising each
 * entry and dropping any that become empty. Used by the modal's Save so all
 * edits made across block types persist in one write. Immutable; other profiles
 * are preserved. Delegates to `setProfileBlocks` after resolving the active id.
 */
export const setActiveProfileBlocks = (
  profiles: TypographyProfile[] | undefined,
  activeId: string | undefined,
  blocks: Partial<Record<BlockTypeKey, BlockStyle>>,
): TypographyProfile[] => {
  const list = ensureProfiles(profiles)
  const active = resolveActiveTypographyProfile(list, activeId)
  return setProfileBlocks(list, active?.id, blocks)
}

/* ------------------------------------------------------------- profile CRUD (P4) */

/** Deep-copy a profile's block map so a clone never shares nested objects. */
const cloneBlocks = (blocks: Partial<Record<BlockTypeKey, BlockStyle>>): Partial<Record<BlockTypeKey, BlockStyle>> => {
  const clone: Partial<Record<BlockTypeKey, BlockStyle>> = {}
  for (const key of Object.keys(blocks) as BlockTypeKey[]) {
    const style = blocks[key]
    if (style) {
      clone[key] = { ...style }
    }
  }
  return clone
}

/**
 * Return `base` if unused in `list`, else the first free `"base N"` (N ≥ 2), so
 * new / duplicated / imported profiles never collide by name.
 */
export const uniqueProfileName = (profiles: TypographyProfile[], base: string): string => {
  const trimmed = base.trim() || 'Profile'
  const names = new Set(profiles.map((p) => p.name))
  if (!names.has(trimmed)) {
    return trimmed
  }
  let suffix = 2
  while (names.has(`${trimmed} ${suffix}`)) {
    suffix++
  }
  return `${trimmed} ${suffix}`
}

/**
 * Create a fresh profile by cloning `DEFAULT_TYPOGRAPHY_PROFILE`'s blocks under a
 * new id and unique name (never `isDefault`). Returns the new list plus the
 * created profile so the UI can select/activate it. Immutable.
 */
export const createProfile = (
  profiles: TypographyProfile[] | undefined,
  name?: string,
): { profiles: TypographyProfile[]; created: TypographyProfile } => {
  const list = ensureProfiles(profiles)
  const created: TypographyProfile = {
    id: newProfileId(),
    name: uniqueProfileName(list, name ?? 'New profile'),
    isDefault: false,
    schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
    blocks: cloneBlocks(DEFAULT_TYPOGRAPHY_PROFILE.blocks),
  }
  return { profiles: [...list, created], created }
}

/**
 * Duplicate the profile identified by `profileId` (a deep copy of its blocks)
 * under a new id and a `"… copy"` unique name (never `isDefault`). Falls back to
 * cloning the Default profile when `profileId` matches nothing. Immutable.
 */
export const duplicateProfile = (
  profiles: TypographyProfile[] | undefined,
  profileId: string,
): { profiles: TypographyProfile[]; created: TypographyProfile } => {
  const list = ensureProfiles(profiles)
  const source = list.find((p) => p.id === profileId) ?? DEFAULT_TYPOGRAPHY_PROFILE
  const created: TypographyProfile = {
    id: newProfileId(),
    name: uniqueProfileName(list, `${source.name} copy`),
    isDefault: false,
    schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
    blocks: cloneBlocks(source.blocks),
  }
  return { profiles: [...list, created], created }
}

/**
 * Rename the profile identified by `profileId`. Empty/whitespace names are
 * rejected (the list is returned unchanged). Immutable.
 */
export const renameProfile = (
  profiles: TypographyProfile[] | undefined,
  profileId: string,
  name: string,
): TypographyProfile[] => {
  const list = ensureProfiles(profiles)
  const trimmed = name.trim()
  if (trimmed === '') {
    return list
  }
  return list.map((profile) => (profile.id === profileId ? { ...profile, name: trimmed } : profile))
}

/**
 * Mark the profile identified by `profileId` as the single `isDefault` winner
 * (every other profile's flag is cleared). A `profileId` that matches nothing is
 * a no-op so we never end up with zero defaults. Immutable.
 */
export const setDefaultProfile = (
  profiles: TypographyProfile[] | undefined,
  profileId: string,
): TypographyProfile[] => {
  const list = ensureProfiles(profiles)
  if (!list.some((p) => p.id === profileId)) {
    return list
  }
  return list.map((profile) => ({ ...profile, isDefault: profile.id === profileId }))
}

/**
 * Whether a profile may be deleted: never the built-in Default (id `default`,
 * kept always-present) and never the last remaining profile.
 */
export const canDeleteProfile = (profiles: TypographyProfile[] | undefined, profileId: string): boolean => {
  const list = ensureProfiles(profiles)
  return list.length > 1 && profileId !== DEFAULT_TYPOGRAPHY_PROFILE_ID && list.some((p) => p.id === profileId)
}

/**
 * Delete the profile identified by `profileId`, guarding destructive edge cases:
 *   - refuses to delete the built-in Default or the last remaining profile
 *     (`canDeleteProfile`), returning the inputs untouched;
 *   - if the deleted profile was the ACTIVE one, reassigns `activeId` to the
 *     remaining default (else the first remaining profile);
 *   - guarantees a default still exists among the survivors.
 * Returns the new list and the (possibly reassigned) active id. Immutable.
 */
export const deleteProfile = (
  profiles: TypographyProfile[] | undefined,
  activeId: string | undefined,
  profileId: string,
): { profiles: TypographyProfile[]; activeId: string | undefined } => {
  const list = ensureProfiles(profiles)
  if (!canDeleteProfile(list, profileId)) {
    return { profiles: list, activeId }
  }

  const remaining = list.filter((p) => p.id !== profileId)

  // Guarantee a default survives (should already hold since Default is undeletable).
  let normalized = remaining
  if (!remaining.some((p) => p.isDefault)) {
    const fallbackId = remaining.find((p) => p.id === DEFAULT_TYPOGRAPHY_PROFILE_ID)?.id ?? remaining[0].id
    normalized = remaining.map((p) => ({ ...p, isDefault: p.id === fallbackId }))
  }

  // Reassign the active id only when the profile we removed was the active one.
  const removedWasActive = resolveActiveTypographyProfile(list, activeId)?.id === profileId
  const nextActiveId = removedWasActive
    ? (normalized.find((p) => p.isDefault) ?? normalized[0]).id
    : activeId

  return { profiles: normalized, activeId: nextActiveId }
}
