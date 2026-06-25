// Standard Red Notes: runtime settings for the background search indexer.
//
// Pure, application-free helpers (types + normalization + persistence keys). The
// imperative runner that actually (re)builds the index on demand and on a
// schedule lives in SearchIndexRunner.ts. The impure read/write side effects use
// the app storage K/V (see getSearchIndexSettings / setSearchIndexSettings) so we
// add nothing to the published `@standardnotes/models` PrefKey enum — the same
// local-store precedent used by Diary/Avatar.
//
// Master enable/disable: the EXISTING PrefKey.SearchIndexEnabled remains the
// source of truth for whether the fast inverted-index search PATH is consulted at
// query time (controller behavior is unchanged). These settings add the
// *background indexer* controls: a scheduler that periodically re-indexes so a
// large account stays warm, plus the persisted scheduler config.

/** How the background indexer is scheduled. */
export type SearchIndexSchedulerMode = 'off' | 'interval'

export interface SearchIndexSettings {
  /** Master on/off for the BACKGROUND indexer (start/stop/scheduler). */
  enabled: boolean
  /** Scheduler mode: 'off' = build on demand only; 'interval' = periodic re-index. */
  schedulerMode: SearchIndexSchedulerMode
  /** Re-index period in minutes when schedulerMode === 'interval'. */
  intervalMinutes: number
}

/** App-storage K/V key under which the settings are persisted (web-only). */
export const SearchIndexSettingsKey = 'SearchIndexBackgroundIndexer'

export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 24 * 60

export const DEFAULT_SEARCH_INDEX_SETTINGS: SearchIndexSettings = {
  enabled: true,
  schedulerMode: 'off',
  intervalMinutes: 15,
}

/**
 * Coerce arbitrary/partial persisted data into a valid SearchIndexSettings,
 * clamping the interval and falling back to defaults for any missing/invalid
 * field. Never throws.
 */
export function normalizeSearchIndexSettings(raw: Partial<SearchIndexSettings> | undefined | null): SearchIndexSettings {
  const enabled = typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_SEARCH_INDEX_SETTINGS.enabled

  const schedulerMode: SearchIndexSchedulerMode =
    raw?.schedulerMode === 'interval' || raw?.schedulerMode === 'off'
      ? raw.schedulerMode
      : DEFAULT_SEARCH_INDEX_SETTINGS.schedulerMode

  let intervalMinutes = DEFAULT_SEARCH_INDEX_SETTINGS.intervalMinutes
  if (typeof raw?.intervalMinutes === 'number' && Number.isFinite(raw.intervalMinutes)) {
    intervalMinutes = Math.round(raw.intervalMinutes)
  }
  intervalMinutes = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, intervalMinutes))

  return { enabled, schedulerMode, intervalMinutes }
}

/** The runner's externally-observable state, surfaced to the settings UI. */
export type SearchIndexRunnerStatus = 'disabled' | 'idle' | 'indexing'
