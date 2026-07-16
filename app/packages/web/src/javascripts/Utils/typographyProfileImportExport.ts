/**
 * Standard Red Notes: Typography Profiles — transfer layer (import / export).
 *
 * Pure, React-free contract behind the Profile Transfer wizard. Responsibilities:
 *
 *  - Serialise one OR MANY profiles to downloadable JSON. A single profile is
 *    written as a LEGACY bare profile object (backward-compatible with older
 *    builds); two or more become a `{ schemaVersion, profiles: [] }` bundle.
 *  - Parse an imported file back into SAFE profiles, accepting BOTH the new bundle
 *    AND the legacy single-profile file. Import is adversarial input: the schema
 *    version is checked, every `BlockStyle` is run through P3's `sanitizeBlockStyle`
 *    (so `url()`/`@import`/`expression()`/etc. are stripped — imported CSS is NEVER
 *    trusted, honouring the CSP), unknown keys are dropped, `isDefault` is forced
 *    off and a FRESH id is minted so an import can never hijack the built-in
 *    Default or collide with an existing profile.
 *  - Provide pure partial-selection helpers (profiles × blocks) for the wizard's
 *    checkbox tree, a truthful `computeSanitizationDiff` (what the REAL sanitiser
 *    will keep vs drop, so the preview cannot lie), and the create-new vs
 *    merge-into-existing resolution used when applying an import.
 *
 * The complete, ordered, grouped block universe lives in
 * `typographyProfileBlockCatalog.ts` (single source of truth). This module no
 * longer keeps its own block list — closing the old `BLOCK_KEYS` bug where `h4`,
 * `h5` and the paragraph variants were silently dropped on import.
 */
import {
  TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
  type BlockStyle,
  type BlockTypeKey,
  type TypographyProfile,
} from '@standardnotes/models'
import { isBlockStyleEmpty, newProfileId, sanitizeBlockStyle, uniqueProfileName } from './typographyProfileEditor'
import { BLOCK_CATALOG_KEYS, blockLabel, isBlockCatalogKey } from './typographyProfileBlockCatalog'

/* -------------------------------------------------------------- shared helpers */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate a schema version value. Returns a human-readable error string when the
 * value is missing / not a finite number / newer than we support, else `null`.
 */
const validateSchemaVersion = (version: unknown): string | null => {
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return 'The file is missing a valid schemaVersion and cannot be imported.'
  }
  if (version > TYPOGRAPHY_PROFILE_SCHEMA_VERSION) {
    return `This file was made with a newer version (schema ${version}) and cannot be imported.`
  }
  return null
}

/* ------------------------------------------------------------ export (serialise) */

/** A pretty-printed JSON string for a single profile (legacy shape). */
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

/** The multi-profile transfer bundle file shape. */
export type TransferBundle = {
  schemaVersion: number
  profiles: TypographyProfile[]
}

/** The schema version stamped into an exported bundle (the model's constant). */
export const TRANSFER_BUNDLE_SCHEMA_VERSION = TYPOGRAPHY_PROFILE_SCHEMA_VERSION

/** Filename used when exporting a multi-profile bundle. */
export const BUNDLE_EXPORT_FILE_NAME = 'typography-profiles.typography.json'

/** A pretty-printed JSON string for a `{ schemaVersion, profiles: [] }` bundle. */
export const bundleToExportJson = (profiles: TypographyProfile[]): string =>
  JSON.stringify({ schemaVersion: TRANSFER_BUNDLE_SCHEMA_VERSION, profiles } satisfies TransferBundle, null, 2)

/** The concrete bytes + filename + shape for a download. */
export type SerializedExport = {
  json: string
  fileName: string
  /** True when the file is a bundle; false when it's a legacy single-profile object. */
  isBundle: boolean
}

/**
 * Deterministic export-format rule (pinned so backward-compat can't drift): a
 * SINGLE profile is written as a LEGACY bare profile object (so older builds that
 * only understand the single-file shape can still import it); TWO OR MORE profiles
 * are written as a `{ schemaVersion, profiles: [] }` bundle. Both shapes re-import
 * through `parseImportedBundle`. An empty list also yields an (empty) bundle.
 */
export const serializeProfilesForExport = (profiles: TypographyProfile[]): SerializedExport => {
  if (profiles.length === 1) {
    return {
      json: profileToExportJson(profiles[0]),
      fileName: exportFileNameForProfile(profiles[0]),
      isBundle: false,
    }
  }
  return { json: bundleToExportJson(profiles), fileName: BUNDLE_EXPORT_FILE_NAME, isBundle: true }
}

/* ----------------------------------------------------------- sanitisation diff */

/** What the sanitiser did to one declaration on import. */
export type DeclarationStatus = 'kept' | 'altered' | 'dropped'

/** Per-declaration diff: the raw value and what the real sanitiser turned it into. */
export type BlockDeclarationDiff = {
  /** The declaration property name (a `BlockStyle` key, or an unknown key). */
  property: string
  /** The value as it appeared in the imported file. */
  rawValue: string
  status: DeclarationStatus
  /** The value the sanitiser will actually apply (present for `kept`/`altered`). */
  cleanValue?: string
}

/** Per-block sanitisation summary. */
export type BlockSanitizationDiff = {
  key: string
  label: string
  /** False when the block key is not in the catalog (the whole block is dropped). */
  known: boolean
  declarations: BlockDeclarationDiff[]
  keptCount: number
  droppedCount: number
}

/** Whole-profile sanitisation diff — the truthful basis for the import preview. */
export type SanitizationDiff = {
  blocks: BlockSanitizationDiff[]
  totalKept: number
  totalDropped: number
}

const asDisplayValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value)

/**
 * Compute — using the REAL `sanitizeBlockStyle` — exactly what an import will keep
 * vs drop/alter for each declaration, so the wizard's preview cannot lie. Operates
 * on RAW (pre-sanitise) profile-like input. Robust to arbitrary/malformed input.
 */
export const computeSanitizationDiff = (rawProfile: unknown): SanitizationDiff => {
  const rawBlocks = isPlainObject(rawProfile) && isPlainObject(rawProfile.blocks) ? rawProfile.blocks : {}

  // Deterministic block order: catalogued keys present in the input first (in
  // catalog order), then any unknown block keys appended in their own order.
  const presentCatalogKeys = BLOCK_CATALOG_KEYS.filter((key) => key in rawBlocks)
  const unknownKeys = Object.keys(rawBlocks).filter((key) => !isBlockCatalogKey(key))
  const orderedKeys = [...presentCatalogKeys, ...unknownKeys]

  const blocks: BlockSanitizationDiff[] = []
  let totalKept = 0
  let totalDropped = 0

  for (const blockKey of orderedKeys) {
    const rawStyle = rawBlocks[blockKey]
    const known = isBlockCatalogKey(blockKey)
    const declarations: BlockDeclarationDiff[] = []

    if (isPlainObject(rawStyle)) {
      const clean = known ? (sanitizeBlockStyle(rawStyle as BlockStyle) as Record<string, unknown>) : {}
      for (const property of Object.keys(rawStyle)) {
        const rawValue = asDisplayValue(rawStyle[property])
        const cleanValue = clean[property]
        if (cleanValue === undefined) {
          declarations.push({ property, rawValue, status: 'dropped' })
        } else if (typeof rawValue === 'string' && (cleanValue === rawValue || cleanValue === rawValue.trim())) {
          declarations.push({ property, rawValue, status: 'kept', cleanValue: String(cleanValue) })
        } else {
          declarations.push({ property, rawValue, status: 'altered', cleanValue: String(cleanValue) })
        }
      }
    }

    const keptCount = declarations.filter((d) => d.status !== 'dropped').length
    const droppedCount = declarations.filter((d) => d.status === 'dropped').length
    totalKept += keptCount
    totalDropped += droppedCount

    blocks.push({
      key: blockKey,
      label: blockLabel(blockKey),
      known,
      declarations,
      keptCount,
      droppedCount,
    })
  }

  return { blocks, totalKept, totalDropped }
}

/* ------------------------------------------------------ per-profile normalisation */

/**
 * Turn a raw profile-like object into a SAFE `TypographyProfile` (fresh id,
 * `isDefault: false`, current schema version, only safe/known block declarations)
 * plus its truthful sanitisation diff. Does NOT validate schemaVersion — the
 * caller does that at the file level (bundle version governs bundle items).
 */
const normalizeProfileObject = (raw: Record<string, unknown>): { profile: TypographyProfile; diff: SanitizationDiff } => {
  const rawBlocks = isPlainObject(raw.blocks) ? raw.blocks : {}
  const blocks: Partial<Record<BlockTypeKey, BlockStyle>> = {}
  for (const key of BLOCK_CATALOG_KEYS) {
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
    profile: {
      id: newProfileId(),
      name,
      isDefault: false,
      schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
      blocks,
    },
    diff: computeSanitizationDiff(raw),
  }
}

/* --------------------------------------------------------------- import (parse) */

/** Legacy single-profile parse result (kept for existing callers). */
export type ImportResult = { ok: true; profile: TypographyProfile } | { ok: false; error: string }

/**
 * Parse + validate + sanitise a LEGACY single-profile JSON string. Preserved for
 * the existing StyleProfiles import path and its tests. New code should prefer
 * `parseImportedBundle`, which also accepts this shape.
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
  const versionError = validateSchemaVersion(raw.schemaVersion)
  if (versionError) {
    return { ok: false, error: versionError }
  }
  return { ok: true, profile: normalizeProfileObject(raw).profile }
}

/** A whole-file parse failure (bad JSON / wrong shape / unsupported version / empty). */
export type TransferParseErrorCode = 'invalid-json' | 'wrong-shape' | 'unsupported-schema-version' | 'empty'

export type TransferParseError = {
  code: TransferParseErrorCode
  message: string
}

/** Per-profile outcome inside a parsed file. */
export type ImportedProfileResult =
  | { ok: true; profile: TypographyProfile; diff: SanitizationDiff; sourceName: string }
  | { ok: false; error: string; sourceName: string }

/** The result of parsing an imported file (bundle OR legacy single-profile). */
export type ParseImportedBundleResult =
  | { ok: false; error: TransferParseError }
  | {
      ok: true
      /** The successfully-parsed, sanitised profiles (convenience subset of `results`). */
      profiles: TypographyProfile[]
      /** Per-entry detail (successes carry a sanitisation diff; failures carry a message). */
      results: ImportedProfileResult[]
      /** True when the source file was a multi-profile bundle. */
      isBundle: boolean
    }

/**
 * Parse an imported file, accepting BOTH a `{ schemaVersion, profiles: [] }`
 * bundle AND a legacy bare single-profile object. Normalises to a list of SAFE
 * `TypographyProfile`s (each sanitised, fresh id, `isDefault: false`). Whole-file
 * problems (bad JSON, wrong shape, unsupported/missing schemaVersion, no profiles)
 * are returned as typed errors; per-entry problems inside an otherwise-valid
 * bundle are surfaced in `results` rather than failing the whole import.
 */
export const parseImportedBundle = (text: string): ParseImportedBundleResult => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'invalid-json', message: 'The selected file is not valid JSON.' } }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, error: { code: 'wrong-shape', message: 'The file does not contain typography profiles.' } }
  }

  // Bundle shape: distinguished by a `profiles` array.
  if (Array.isArray(raw.profiles)) {
    const versionError = validateSchemaVersion(raw.schemaVersion)
    if (versionError) {
      return { ok: false, error: { code: 'unsupported-schema-version', message: versionError } }
    }
    const rawProfiles = raw.profiles
    if (rawProfiles.length === 0) {
      return { ok: false, error: { code: 'empty', message: 'The file contains no profiles to import.' } }
    }
    const results: ImportedProfileResult[] = rawProfiles.map((entry, index) => {
      const sourceName =
        isPlainObject(entry) && typeof entry.name === 'string' && entry.name.trim() !== ''
          ? entry.name.trim()
          : `Profile ${index + 1}`
      if (!isPlainObject(entry)) {
        return { ok: false, error: 'This entry is not a typography profile object.', sourceName }
      }
      const { profile, diff } = normalizeProfileObject(entry)
      return { ok: true, profile, diff, sourceName }
    })
    const profiles = results
      .filter((result): result is Extract<ImportedProfileResult, { ok: true }> => result.ok)
      .map((result) => result.profile)
    return { ok: true, profiles, results, isBundle: true }
  }

  // Legacy single-profile shape.
  const versionError = validateSchemaVersion(raw.schemaVersion)
  if (versionError) {
    return { ok: false, error: { code: 'unsupported-schema-version', message: versionError } }
  }
  const { profile, diff } = normalizeProfileObject(raw)
  const sourceName = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'Imported profile'
  return { ok: true, profiles: [profile], results: [{ ok: true, profile, diff, sourceName }], isBundle: false }
}

/* ------------------------------------------------------ partial selection (pure) */

/**
 * A selection over (profiles × blocks): a map from profile id to the ordered list
 * of block keys chosen for that profile. A profile absent from the map (or mapped
 * to an empty list) is not selected at all.
 */
export type ProfileBlockSelection = Record<string, BlockTypeKey[]>

/** The block keys a profile actually carries (non-empty), in catalog order. */
const styledBlockKeys = (profile: TypographyProfile): BlockTypeKey[] =>
  BLOCK_CATALOG_KEYS.filter((key) => {
    const style = profile.blocks[key]
    return style !== undefined && !isBlockStyleEmpty(style)
  })

/** Re-order an arbitrary key list into canonical catalog order (dropping unknowns). */
const orderKeys = (keys: readonly BlockTypeKey[]): BlockTypeKey[] => {
  const set = new Set(keys)
  return BLOCK_CATALOG_KEYS.filter((key) => set.has(key))
}

/** Build a full selection: every profile, every block it carries. */
export const buildFullSelection = (profiles: TypographyProfile[]): ProfileBlockSelection => {
  const selection: ProfileBlockSelection = {}
  for (const profile of profiles) {
    const keys = styledBlockKeys(profile)
    if (keys.length > 0) {
      selection[profile.id] = keys
    }
  }
  return selection
}

/** Whether a specific block of a specific profile is selected. */
export const isBlockSelected = (selection: ProfileBlockSelection, profileId: string, key: BlockTypeKey): boolean =>
  (selection[profileId] ?? []).includes(key)

/** Toggle a single block on/off for a profile, returning a NEW selection. */
export const setBlockSelected = (
  selection: ProfileBlockSelection,
  profileId: string,
  key: BlockTypeKey,
  selected: boolean,
): ProfileBlockSelection => {
  const current = selection[profileId] ?? []
  const has = current.includes(key)
  let next = current
  if (selected && !has) {
    next = orderKeys([...current, key])
  } else if (!selected && has) {
    next = current.filter((existing) => existing !== key)
  }
  const out = { ...selection }
  if (next.length > 0) {
    out[profileId] = next
  } else {
    delete out[profileId]
  }
  return out
}

/** Select/deselect a whole profile (all its carried blocks), returning a NEW selection. */
export const setProfileSelected = (
  selection: ProfileBlockSelection,
  profile: TypographyProfile,
  selected: boolean,
): ProfileBlockSelection => {
  const out = { ...selection }
  if (!selected) {
    delete out[profile.id]
    return out
  }
  const keys = styledBlockKeys(profile)
  if (keys.length > 0) {
    out[profile.id] = keys
  }
  return out
}

/** Total number of selected blocks across all profiles (for the preview summary). */
export const countSelectedBlocks = (selection: ProfileBlockSelection): number =>
  Object.values(selection).reduce((total, keys) => total + keys.length, 0)

/** A profile carrying ONLY the chosen (and actually-present) blocks. Immutable. */
export const pickProfileBlocks = (profile: TypographyProfile, keys: readonly BlockTypeKey[]): TypographyProfile => {
  const keep = new Set(keys)
  const blocks: Partial<Record<BlockTypeKey, BlockStyle>> = {}
  for (const key of BLOCK_CATALOG_KEYS) {
    const style = profile.blocks[key]
    if (keep.has(key) && style !== undefined) {
      blocks[key] = { ...style }
    }
  }
  return { ...profile, blocks }
}

/**
 * Resolve a selection into the concrete list of profiles to transfer: each
 * selected profile reduced to its chosen blocks. Preserves input profile order;
 * profiles that end up with no blocks are omitted. Deterministic, immutable.
 */
export const selectFromBundle = (
  profiles: TypographyProfile[],
  selection: ProfileBlockSelection,
): TypographyProfile[] => {
  const result: TypographyProfile[] = []
  for (const profile of profiles) {
    const keys = selection[profile.id]
    if (!keys || keys.length === 0) {
      continue
    }
    const picked = pickProfileBlocks(profile, keys)
    if (Object.keys(picked.blocks).length > 0) {
      result.push(picked)
    }
  }
  return result
}

/* ----------------------------------------------- import apply: create vs merge */

/**
 * Where an import lands:
 *  - `create`  → each incoming profile becomes a NEW profile (default, safe).
 *  - `merge`   → the incoming blocks are merged INTO the existing profile with
 *                `targetProfileId`, overwriting those block entries only; the
 *                target's other blocks and every other profile are preserved.
 */
export type ImportTarget = { mode: 'create' } | { mode: 'merge'; targetProfileId: string }

/**
 * Apply already-selected, already-sanitised `incoming` profiles to the existing
 * profile list per `target`. Returns a NEW list ready for
 * `setPreference(PrefKey.TypographyProfiles, …)`. Immutable; never mutates inputs.
 */
export const resolveImport = (
  existingProfiles: TypographyProfile[],
  incoming: TypographyProfile[],
  target: ImportTarget,
): TypographyProfile[] => {
  if (incoming.length === 0) {
    return existingProfiles
  }

  if (target.mode === 'merge') {
    const mergedBlocks: Partial<Record<BlockTypeKey, BlockStyle>> = {}
    for (const profile of incoming) {
      for (const key of BLOCK_CATALOG_KEYS) {
        const style = profile.blocks[key]
        if (style !== undefined) {
          mergedBlocks[key] = { ...style }
        }
      }
    }
    return existingProfiles.map((profile) =>
      profile.id === target.targetProfileId
        ? { ...profile, blocks: { ...profile.blocks, ...mergedBlocks } }
        : profile,
    )
  }

  // create-new: append each incoming as a fresh profile with a unique name. Names
  // are made unique against the growing list so a batch never self-collides.
  let list = [...existingProfiles]
  for (const profile of incoming) {
    const created: TypographyProfile = {
      id: newProfileId(),
      name: uniqueProfileName(list, profile.name),
      isDefault: false,
      schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
      blocks: { ...profile.blocks },
    }
    list = [...list, created]
  }
  return list
}
