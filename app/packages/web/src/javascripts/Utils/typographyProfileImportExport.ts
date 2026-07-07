/**
 * Standard Red Notes: Typography Profiles — Phase 4 (import / export).
 *
 * Serialise a single `TypographyProfile` to downloadable JSON, and parse an
 * imported JSON blob back into a SAFE profile. Import is adversarial input: the
 * schema version is checked, every `BlockStyle` is run through P3's
 * `sanitizeBlockStyle` (so `url()`/`@import`/`expression()`/etc. are stripped —
 * imported CSS is NEVER trusted, honouring the CSP), unknown keys are dropped,
 * `isDefault` is forced off and a FRESH id is minted so an import can never
 * hijack the built-in Default or collide with an existing profile.
 */
import {
  TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
  type BlockStyle,
  type BlockTypeKey,
  type TypographyProfile,
} from '@standardnotes/models'
import { isBlockStyleEmpty, newProfileId, sanitizeBlockStyle } from './typographyProfileEditor'

/** The block types an imported profile may carry (anything else is dropped). */
const BLOCK_KEYS: readonly BlockTypeKey[] = [
  'paragraph',
  'h1',
  'h2',
  'h3',
  'quote',
  'code',
  'callout',
  'bulletList',
  'numberedList',
  'checkList',
]

/** A pretty-printed JSON string for a profile, suitable for download. */
export const profileToExportJson = (profile: TypographyProfile): string => JSON.stringify(profile, null, 2)

/** A filesystem-safe filename for an exported profile (`<slug>.typography.json`). */
export const exportFileNameForProfile = (profile: TypographyProfile): string => {
  const slug = profile.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'profile'}.typography.json`
}

export type ImportResult = { ok: true; profile: TypographyProfile } | { ok: false; error: string }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parse + validate + sanitise an imported profile JSON string. On success
 * returns a brand-new SAFE `TypographyProfile` (fresh id, `isDefault: false`,
 * current schema version, only safe block declarations). On any structural
 * problem returns a human-readable error instead of throwing.
 */
export const parseImportedProfile = (text: string): ImportResult => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'The selected file is not valid JSON.' }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, error: 'The file does not contain a typography profile object.' }
  }

  const version = raw.schemaVersion
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return { ok: false, error: 'The file is missing a valid schemaVersion and cannot be imported.' }
  }
  if (version > TYPOGRAPHY_PROFILE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This profile was made with a newer version (schema ${version}) and cannot be imported.`,
    }
  }

  const rawBlocks = isPlainObject(raw.blocks) ? raw.blocks : {}
  const blocks: Partial<Record<BlockTypeKey, BlockStyle>> = {}
  for (const key of BLOCK_KEYS) {
    const rawStyle = rawBlocks[key]
    if (isPlainObject(rawStyle)) {
      const clean = sanitizeBlockStyle(rawStyle as BlockStyle)
      if (!isBlockStyleEmpty(clean)) {
        blocks[key] = clean
      }
    }
  }

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'Imported profile'

  return {
    ok: true,
    profile: {
      id: newProfileId(),
      name,
      isDefault: false,
      schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
      blocks,
    },
  }
}
