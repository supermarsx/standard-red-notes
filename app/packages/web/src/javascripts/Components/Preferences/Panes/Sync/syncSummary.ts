/**
 * Pure (React-free, app-free) helpers backing the Sync control pane. Kept separate
 * so the "what is synced vs. local-only" derivation can be unit-tested from plain
 * sample data with no service mocks.
 *
 * Everything here is derived synchronously from already-in-memory items. An item
 * counts as SYNCED only when it has genuinely reached the server, which requires
 * ALL of:
 *   - there is an account/session (`hasAccount`) — with no account nothing can be
 *     on the server, so everything is local-only;
 *   - it is not excluded via the `localOnly` AppData flag (AppDataField.LocalOnly),
 *     the exact flag SyncService.excludeLocalOnlyItems uses to keep an item off the
 *     upload set; and
 *   - it is not `neverSynced` — i.e. the server has stamped it with a
 *     `serverUpdatedAt` (GenericItem.neverSynced is `!serverUpdatedAt`). A brand
 *     new / dirty-never-uploaded item has not reached the server yet and is
 *     therefore local-only until it does.
 *
 * We do NOT reimplement any sync logic — we only READ these existing item fields
 * to MIRROR, in the UI, what has and hasn't reached the account.
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
  /**
   * Whether the item has never reached the server (GenericItem.neverSynced —
   * `!serverUpdatedAt`). A never-synced item is local-only until it uploads.
   * Optional so plain test fixtures / already-synced items default to `false`.
   */
  neverSynced?: boolean
  /** Best-effort display title (note title / tag name / file name). May be empty. */
  title?: string
  /** Whether this item is in the trash (trashed items are excluded from counts). */
  trashed?: boolean
}

/** Options controlling the synced/local-only partition. */
export type SummarizeSyncOptions = {
  /**
   * Whether there is an account/session that items can sync TO. When false there
   * is no server relationship at all, so nothing counts as synced and every item
   * is local-only. Defaults to `true` so existing callers/fixtures partition on
   * the per-item fields alone.
   */
  hasAccount?: boolean
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
 *
 * An item is counted as SYNCED only when it has reached the server:
 * `hasAccount && !localOnly && !neverSynced`. Everything else — no account, an
 * item excluded via the local-only flag, or one that hasn't uploaded yet — is
 * counted as local-only, so the numbers can never claim something is synced that
 * isn't actually on the account.
 *
 * The `localOnlyItems` display list is intentionally the DELIBERATELY excluded
 * set (the `localOnly` flag) — the actionable "switch back to syncing" items —
 * not the wider local-only COUNT (which also includes not-yet-uploaded items).
 * The pane hides that list entirely when there is no account.
 */
export function summarizeSync(items: SyncItemLike[], options: SummarizeSyncOptions = {}): SyncSummary {
  const hasAccount = options.hasAccount ?? true
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

    // Reached the server iff there is an account, the item isn't excluded, and
    // the server has stamped it (not never-synced).
    const isSynced = hasAccount && !item.localOnly && !item.neverSynced
    const bucket = isSynced ? synced : localOnly
    bucket[kind] += 1
    bucket.total += 1

    // The actionable "kept on this device only" list tracks the explicit
    // local-only FLAG (what the user can toggle back on), regardless of account.
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
