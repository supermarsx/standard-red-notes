// Standard Red Notes: runtime settings for the background search indexer.
//
// Pure, application-free helpers (types + normalization + persistence keys). The
// imperative runner that actually (re)builds the index on demand and on a
// schedule lives in SearchIndexRunner.ts. The impure read/write side effects use
// the app storage K/V (see SearchIndexRunner) so we add nothing to the published
// `@standardnotes/models` PrefKey enum — the same local-store precedent used by
// Diary/Avatar.
//
// Master enable/disable: the EXISTING PrefKey.SearchIndexEnabled remains the
// source of truth for whether the fast inverted-index search PATH is consulted at
// query time (controller behavior is unchanged). These settings add the
// *background indexer* controls: a scheduler that re-indexes so a large account
// stays warm, plus a scope (whitelist/blacklist) controlling WHICH notes are
// indexed.

/**
 * How the background indexer is scheduled:
 *  - 'off'       legacy alias kept for back-compat: build on demand only.
 *  - 'manual'    only rebuild on an explicit "Rebuild now" click (no scheduler).
 *  - 'interval'  periodic full re-index every `intervalMinutes`.
 *  - 'on-change' keep the index live via the existing incremental update path
 *                (collectIndexUpdates) as items change — no scheduled full rebuild.
 *  - 'idle'      refresh the index when the app becomes idle (requestIdleCallback,
 *                or a timer fallback), so a full rebuild happens off the hot path.
 */
export type SearchIndexSchedulerMode = 'off' | 'manual' | 'interval' | 'on-change' | 'idle'

/** All scheduler modes, in the order the settings UI presents them. */
export const SEARCH_INDEX_SCHEDULER_MODES: SearchIndexSchedulerMode[] = [
  'on-change',
  'idle',
  'interval',
  'manual',
]

/** Which notes the index covers. */
export type SearchIndexScopeMode = 'all' | 'include' | 'exclude'

/**
 * Inclusion/exclusion scope for the index. In 'all' every displayable note is
 * indexed (the default). In 'include' (whitelist) only notes carrying at least
 * one of `tagIds` are indexed; in 'exclude' (blacklist) notes carrying any of
 * `tagIds` are dropped from the index.
 */
export interface SearchIndexScope {
  mode: SearchIndexScopeMode
  /** Tag uuids the include/exclude rule applies to. Ignored when mode === 'all'. */
  tagIds: string[]
}

export interface SearchIndexSettings {
  /** Master on/off for the BACKGROUND indexer (start/stop/scheduler). */
  enabled: boolean
  /** Scheduler mode — see {@link SearchIndexSchedulerMode}. */
  schedulerMode: SearchIndexSchedulerMode
  /** Re-index period in minutes when schedulerMode === 'interval'. */
  intervalMinutes: number
  /** Inclusion/exclusion scope controlling which notes are indexed. */
  scope: SearchIndexScope
}

/** App-storage K/V key under which the settings are persisted (web-only). */
export const SearchIndexSettingsKey = 'SearchIndexBackgroundIndexer'

export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 24 * 60

export const DEFAULT_SEARCH_INDEX_SCOPE: SearchIndexScope = {
  mode: 'all',
  tagIds: [],
}

export const DEFAULT_SEARCH_INDEX_SETTINGS: SearchIndexSettings = {
  enabled: true,
  schedulerMode: 'on-change',
  intervalMinutes: 15,
  scope: DEFAULT_SEARCH_INDEX_SCOPE,
}

const isSchedulerMode = (value: unknown): value is SearchIndexSchedulerMode =>
  value === 'off' ||
  value === 'manual' ||
  value === 'interval' ||
  value === 'on-change' ||
  value === 'idle'

const isScopeMode = (value: unknown): value is SearchIndexScopeMode =>
  value === 'all' || value === 'include' || value === 'exclude'

/** Coerce arbitrary/partial persisted data into a valid SearchIndexScope. Never throws. */
export function normalizeSearchIndexScope(raw: Partial<SearchIndexScope> | undefined | null): SearchIndexScope {
  const mode: SearchIndexScopeMode = isScopeMode(raw?.mode) ? raw.mode : DEFAULT_SEARCH_INDEX_SCOPE.mode
  const tagIds = Array.isArray(raw?.tagIds)
    ? Array.from(new Set(raw.tagIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
    : []
  return { mode, tagIds }
}

/**
 * Coerce arbitrary/partial persisted data into a valid SearchIndexSettings,
 * clamping the interval and falling back to defaults for any missing/invalid
 * field. Never throws.
 */
export function normalizeSearchIndexSettings(raw: Partial<SearchIndexSettings> | undefined | null): SearchIndexSettings {
  const enabled = typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_SEARCH_INDEX_SETTINGS.enabled

  const schedulerMode: SearchIndexSchedulerMode = isSchedulerMode(raw?.schedulerMode)
    ? raw.schedulerMode
    : DEFAULT_SEARCH_INDEX_SETTINGS.schedulerMode

  let intervalMinutes = DEFAULT_SEARCH_INDEX_SETTINGS.intervalMinutes
  if (typeof raw?.intervalMinutes === 'number' && Number.isFinite(raw.intervalMinutes)) {
    intervalMinutes = Math.round(raw.intervalMinutes)
  }
  intervalMinutes = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, intervalMinutes))

  const scope = normalizeSearchIndexScope(raw?.scope)

  return { enabled, schedulerMode, intervalMinutes, scope }
}

/**
 * Pure scope test: should a note carrying `noteTagIds` be included in the index
 * under `scope`? In 'all' everything passes. In 'include' the note must carry at
 * least one scope tag (an empty whitelist therefore excludes nothing — it falls
 * back to indexing all, which is the least-surprising behavior for an unconfigured
 * whitelist). In 'exclude' the note is dropped iff it carries any scope tag.
 */
export function isNoteInSearchIndexScope(scope: SearchIndexScope, noteTagIds: readonly string[]): boolean {
  if (scope.mode === 'all' || scope.tagIds.length === 0) {
    return true
  }
  const scopeSet = new Set(scope.tagIds)
  const hasScopedTag = noteTagIds.some((id) => scopeSet.has(id))
  return scope.mode === 'include' ? hasScopedTag : !hasScopedTag
}

/**
 * Filter a list of note-like items down to those that pass `scope`, resolving
 * each item's tag uuids via `tagIdsForNote`. This is the exact predicate the index
 * build applies (see ItemListController.getScopedIndexableNotes), extracted as a
 * pure function so the inclusion/exclusion behavior is directly unit-testable.
 */
export function filterNotesByScope<T extends { uuid: string }>(
  notes: readonly T[],
  scope: SearchIndexScope,
  tagIdsForNote: (note: T) => readonly string[],
): T[] {
  if (scope.mode === 'all' || scope.tagIds.length === 0) {
    return [...notes]
  }
  return notes.filter((note) => isNoteInSearchIndexScope(scope, tagIdsForNote(note)))
}

/** The runner's externally-observable state, surfaced to the settings UI. */
export type SearchIndexRunnerStatus = 'disabled' | 'idle' | 'indexing'
