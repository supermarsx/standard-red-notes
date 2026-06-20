/**
 * Pure (React-free, app-free) helpers backing the Sync control pane. Kept separate
 * so the "what is synced vs. local-only" derivation can be unit-tested from plain
 * sample data with no service mocks.
 *
 * Everything here is derived synchronously from already-in-memory items. The flag
 * we partition on is the existing `localOnly` AppData flag (AppDataField.LocalOnly),
 * which is exactly what SyncService.excludeLocalOnlyItems uses to keep an item off
 * the sync upload set. We do NOT reimplement that logic — we only read the same
 * boolean to MIRROR, in the UI, what the sync engine already does.
 */

/** The three content-type buckets we surface counts for. */
export type SyncItemKind = 'note' | 'tag' | 'file'

/** Content-type string constants (mirrors ContentType.TYPES, kept literal so this
 * module stays free of any snjs import and is trivially unit-testable). */
export const NOTE_CONTENT_TYPE = 'Note'
export const TAG_CONTENT_TYPE = 'Tag'
export const FILE_CONTENT_TYPE = 'SN|File'

/**
 * Minimal shape of an item this summary needs. Real items (SNNote / SNTag /
 * FileItem) all satisfy this, but the pure helper only depends on these fields so
 * tests can pass plain objects.
 */
export type SyncItemLike = {
  uuid: string
  content_type: string
  localOnly: boolean
  /** Best-effort display title (note title / tag name / file name). May be empty. */
  title?: string
  /** Whether this item is in the trash (trashed items are excluded from counts). */
  trashed?: boolean
}

/** Counts split by content-type bucket. */
export type SyncKindCounts = {
  note: number
  tag: number
  file: number
  /** note + tag + file. */
  total: number
}

/** A single local-only item, display-ready for the "what isn't syncing" list. */
export type LocalOnlyItem = {
  uuid: string
  content_type: string
  kind: SyncItemKind | 'other'
  title: string
}

export type SyncSummary = {
  /** Items that WILL sync to the server (not local-only), by type. */
  synced: SyncKindCounts
  /** Items kept on this device only (excluded from sync), by type. */
  localOnly: SyncKindCounts
  /** Flat, display-ready list of every local-only item (notes/tags/files), sorted. */
  localOnlyItems: LocalOnlyItem[]
}

/** Map a content-type string to its bucket, or `other` for anything we don't count. */
export function kindForContentType(contentType: string): SyncItemKind | 'other' {
  switch (contentType) {
    case NOTE_CONTENT_TYPE:
      return 'note'
    case TAG_CONTENT_TYPE:
      return 'tag'
    case FILE_CONTENT_TYPE:
      return 'file'
    default:
      return 'other'
  }
}

/** Friendly singular/plural label for a bucket. */
export function labelForKind(kind: SyncItemKind, count: number): string {
  const plural = count === 1 ? '' : 's'
  switch (kind) {
    case 'note':
      return `Note${plural}`
    case 'tag':
      return `Tag${plural}`
    case 'file':
      return `File${plural}`
  }
}

const emptyCounts = (): SyncKindCounts => ({ note: 0, tag: 0, file: 0, total: 0 })

/**
 * Partition a flat list of items into synced vs. local-only, counted by type, and
 * build the display list of local-only items.
 *
 * Pure: it only reads the passed array and never triggers any side effect. Trashed
 * items are skipped entirely (they're on their way out and shouldn't inflate either
 * count). Only Note / Tag / File content types contribute to the counts; other
 * content types (vault listings, key items, user prefs, ...) are ignored so the
 * numbers match what a user thinks of as "their stuff".
 */
export function summarizeSync(items: SyncItemLike[]): SyncSummary {
  const synced = emptyCounts()
  const localOnly = emptyCounts()
  const localOnlyItems: LocalOnlyItem[] = []

  for (const item of items) {
    if (item.trashed) {
      continue
    }

    const kind = kindForContentType(item.content_type)
    if (kind === 'other') {
      continue
    }

    const bucket = item.localOnly ? localOnly : synced
    bucket[kind] += 1
    bucket.total += 1

    if (item.localOnly) {
      localOnlyItems.push({
        uuid: item.uuid,
        content_type: item.content_type,
        kind,
        title: item.title && item.title.length > 0 ? item.title : 'Untitled',
      })
    }
  }

  // Stable, friendly ordering: notes first, then tags, then files; alpha within.
  const kindOrder: Record<SyncItemKind | 'other', number> = { note: 0, tag: 1, file: 2, other: 3 }
  localOnlyItems.sort((a, b) => {
    const delta = kindOrder[a.kind] - kindOrder[b.kind]
    return delta !== 0 ? delta : a.title.localeCompare(b.title)
  })

  return { synced, localOnly, localOnlyItems }
}
