// Local, unsynced setting for AI DEEP RESEARCH over the user's own notes.
//
// Stored in localStorage rather than a synced PrefKey because adding a PrefKey
// would require touching @standardnotes/models (off-limits for this web-only
// change) — same pattern as narrationSettings / dictationSettings /
// contextualSearchSettings.
//
// IMPORTANT: default is OFF. Deep research runs a BOUNDED multi-step agentic loop
// that reads the content of several notes and sends it to the configured AI
// provider across multiple rounds — substantially more data exposure than a
// single query. When off, the feature is hidden and nothing changes.

const STORAGE_KEY = 'standardnotes.deepResearch.settings.v1'

export interface DeepResearchSettings {
  /**
   * When true, a "Deep research" action becomes available in the assistant that
   * runs a bounded multi-step research loop over the user's notes (search →
   * read a bounded set → optionally refine → synthesize a cited report).
   * DEFAULT FALSE. Even when true, nothing runs until the user explicitly starts
   * a research run with a question.
   */
  enabled: boolean
}

export const DEFAULT_DEEP_RESEARCH_SETTINGS: DeepResearchSettings = {
  enabled: false,
}

export function loadDeepResearchSettings(): DeepResearchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_DEEP_RESEARCH_SETTINGS }
    }
    const parsed = JSON.parse(raw) as Partial<DeepResearchSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_DEEP_RESEARCH_SETTINGS.enabled,
    }
  } catch {
    return { ...DEFAULT_DEEP_RESEARCH_SETTINGS }
  }
}

export function saveDeepResearchSettings(settings: DeepResearchSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage may be unavailable (private mode); feature stays off */
  }
}

/** Convenience: is deep research enabled right now? (Default OFF.) */
export function isDeepResearchEnabled(): boolean {
  return loadDeepResearchSettings().enabled
}
