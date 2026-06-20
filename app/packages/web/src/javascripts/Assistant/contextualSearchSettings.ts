// Local, unsynced setting for AI-assisted CONTEXTUAL search re-ranking.
//
// Stored in localStorage rather than a synced PrefKey because adding a PrefKey
// would require touching @standardnotes/models (off-limits for this web-only
// change) — same pattern as narrationSettings / dictationSettings.
//
// IMPORTANT: default is OFF. When off, note search behaves exactly as today
// (algorithmic operator filter + local relevance / index / BM25 ordering), and no
// note content is ever sent to an AI provider for search.

const STORAGE_KEY = 'standardnotes.contextualSearch.settings.v1'

export interface ContextualSearchSettings {
  /**
   * When true, a "Search with AI" action becomes available that sends the top
   * algorithmic candidates to the configured AI provider to be re-ranked by
   * semantic relevance. DEFAULT FALSE. Even when true, no model call fires on
   * keystroke — only on the explicit action / search submit.
   */
  enabled: boolean
}

export const DEFAULT_CONTEXTUAL_SEARCH_SETTINGS: ContextualSearchSettings = {
  enabled: false,
}

export function loadContextualSearchSettings(): ContextualSearchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_CONTEXTUAL_SEARCH_SETTINGS }
    }
    const parsed = JSON.parse(raw) as Partial<ContextualSearchSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_CONTEXTUAL_SEARCH_SETTINGS.enabled,
    }
  } catch {
    return { ...DEFAULT_CONTEXTUAL_SEARCH_SETTINGS }
  }
}

export function saveContextualSearchSettings(settings: ContextualSearchSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage may be unavailable (private mode); search still works (AI off) */
  }
}

/** Convenience: is AI contextual search enabled right now? (Default OFF.) */
export function isContextualSearchEnabled(): boolean {
  return loadContextualSearchSettings().enabled
}
