// Local, unsynced setting for AI RESEARCH MODE (write a structured research note
// on a topic from the model's knowledge).
//
// Stored in localStorage rather than a synced PrefKey because adding a PrefKey
// would require touching @standardnotes/models (off-limits for this web-only
// change) — same pattern as narrationSettings / dictationSettings /
// deepResearchSettings.
//
// DEFAULT OFF. Research mode sends the topic to the configured AI provider and
// writes the result into a new note. When off, the feature is hidden.

const STORAGE_KEY = 'standardnotes.researchMode.settings.v1'

export interface ResearchModeSettings {
  /**
   * When true, a "Research mode" panel becomes available in the assistant that
   * takes a topic/question and writes a structured research note (title,
   * sections, a Sources list) into a new note. DEFAULT FALSE. Even when true,
   * nothing runs until the user explicitly starts a research run.
   */
  enabled: boolean
}

export const DEFAULT_RESEARCH_MODE_SETTINGS: ResearchModeSettings = {
  enabled: false,
}

export function loadResearchModeSettings(): ResearchModeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_RESEARCH_MODE_SETTINGS }
    }
    const parsed = JSON.parse(raw) as Partial<ResearchModeSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_RESEARCH_MODE_SETTINGS.enabled,
    }
  } catch {
    return { ...DEFAULT_RESEARCH_MODE_SETTINGS }
  }
}

export function saveResearchModeSettings(settings: ResearchModeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage may be unavailable (private mode); feature stays off */
  }
}

/** Convenience: is research mode enabled right now? (Default OFF.) */
export function isResearchModeEnabled(): boolean {
  return loadResearchModeSettings().enabled
}
