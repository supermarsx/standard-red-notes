/**
 * Standard Red Notes: Typography Profiles — block catalog (single source of truth).
 *
 * The canonical, ordered, grouped list of EVERY block type a typography profile
 * can carry. This is the one place that answers "which blocks exist, what are
 * they called, and how are they grouped?" — consumed by the import/export
 * transfer layer (`typographyProfileImportExport.ts`) and the transfer wizard UI
 * (its selection tree + preview).
 *
 * WHY THIS EXISTS: the transfer layer previously hard-coded an incomplete list
 * (`BLOCK_KEYS`) that was missing `h4`, `h5` and the five paragraph variants, so
 * exporting the built-in Default profile (which styles `h4`/`h5`) and re-importing
 * it SILENTLY DROPPED those blocks. `BLOCK_META` below is a
 * `Record<BlockTypeKey, …>` — a COMPILE-TIME guarantee that every block key in the
 * model has a catalog entry. Adding a new `BlockTypeKey` without giving it an
 * entry here is now a `tsc` error, so that class of bug cannot recur silently.
 */
import type { BlockTypeKey } from '@standardnotes/models'

/** Which group a block belongs to in the selection tree. */
export type BlockGroupId = 'blocks' | 'variants'

/** A single catalog row: the block key, its display label and its group. */
export type BlockCatalogEntry = {
  key: BlockTypeKey
  label: string
  group: BlockGroupId
}

/**
 * Metadata for every block key. Typed as `Record<BlockTypeKey, …>` so the object
 * literal fails to compile if any block key is missing — the structural guard
 * against the original incomplete-list bug.
 *
 * The `variants` group holds the paragraph *variants* (Title / Normal-spaced /
 * Accented / Strong / Emphasis): they share `.Lexical__paragraph`, emit no global
 * scoped CSS on their own, and are labelled "Variants" so their nature is clear in
 * the picker. Everything else is a real block type in the "Blocks" group.
 */
const BLOCK_META: Record<BlockTypeKey, { label: string; group: BlockGroupId }> = {
  paragraph: { label: 'Normal', group: 'blocks' },
  h1: { label: 'Heading 1', group: 'blocks' },
  h2: { label: 'Heading 2', group: 'blocks' },
  h3: { label: 'Heading 3', group: 'blocks' },
  h4: { label: 'Heading 4', group: 'blocks' },
  h5: { label: 'Heading 5', group: 'blocks' },
  quote: { label: 'Quote', group: 'blocks' },
  code: { label: 'Code', group: 'blocks' },
  callout: { label: 'Callout', group: 'blocks' },
  bulletList: { label: 'Bulleted list', group: 'blocks' },
  numberedList: { label: 'Numbered list', group: 'blocks' },
  checkList: { label: 'Checklist', group: 'blocks' },
  title: { label: 'Title', group: 'variants' },
  normalSpaced: { label: 'Normal (spaced)', group: 'variants' },
  accented: { label: 'Accented', group: 'variants' },
  strong: { label: 'Strong', group: 'variants' },
  emphasis: { label: 'Emphasis', group: 'variants' },
}

/**
 * Canonical DISPLAY order. Kept as an explicit list (rather than `Object.keys`,
 * whose iteration order we don't want to depend on) so the tree + preview are
 * deterministic. Its completeness against `BLOCK_META` is asserted in the spec.
 */
const BLOCK_ORDER: readonly BlockTypeKey[] = [
  'paragraph',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'quote',
  'code',
  'callout',
  'bulletList',
  'numberedList',
  'checkList',
  'title',
  'normalSpaced',
  'accented',
  'strong',
  'emphasis',
]

/** The full, ordered catalog of block entries. */
export const BLOCK_CATALOG: readonly BlockCatalogEntry[] = BLOCK_ORDER.map((key) => ({
  key,
  label: BLOCK_META[key].label,
  group: BLOCK_META[key].group,
}))

/**
 * The ordered list of every block key an import may accept and an export may
 * carry. This REPLACES the old incomplete `BLOCK_KEYS` constant.
 */
export const BLOCK_CATALOG_KEYS: readonly BlockTypeKey[] = BLOCK_CATALOG.map((entry) => entry.key)

/** Human labels for the two groups. */
export const BLOCK_GROUP_LABELS: Record<BlockGroupId, string> = {
  blocks: 'Blocks',
  variants: 'Variants',
}

/** Group display order for the selection tree. */
export const BLOCK_GROUP_ORDER: readonly BlockGroupId[] = ['blocks', 'variants']

/** A group with its ordered entries — the shape the wizard renders as a tree section. */
export type BlockCatalogGroup = {
  id: BlockGroupId
  label: string
  entries: BlockCatalogEntry[]
}

/** The catalog pre-grouped and ordered, ready for the wizard's selection tree. */
export const BLOCK_CATALOG_GROUPS: readonly BlockCatalogGroup[] = BLOCK_GROUP_ORDER.map((id) => ({
  id,
  label: BLOCK_GROUP_LABELS[id],
  entries: BLOCK_CATALOG.filter((entry) => entry.group === id),
}))

/** The display label for a block key (falls back to the raw key if unknown). */
export const blockLabel = (key: string): string =>
  Object.prototype.hasOwnProperty.call(BLOCK_META, key) ? BLOCK_META[key as BlockTypeKey].label : key

/** Type guard: is `key` a real, catalogued block key? */
export const isBlockCatalogKey = (key: string): key is BlockTypeKey =>
  Object.prototype.hasOwnProperty.call(BLOCK_META, key)

/** The catalog index of a block key (its sort position); `-1` if unknown. */
export const blockCatalogIndex = (key: string): number =>
  BLOCK_CATALOG_KEYS.indexOf(key as BlockTypeKey)
