// Local, unsynced settings for AI-assisted conflict resolution. These live in
// localStorage rather than a synced PrefKey because adding a PrefKey would require
// touching @standardnotes/models (off-limits for this web-only change), and the
// snjs ConflictResolutionStrategyValue type can't gain an 'ai' member here either.
//
// SAFETY DEFAULTS: both flags default OFF. AI conflict resolution is strictly
// opt-in, and fully-automatic apply (no human review) is behind a SEPARATE,
// additional opt-in because an AI merge can be wrong and silently overwrite a note.

const STORAGE_KEY = 'standardnotes.conflicts.ai.settings.v1'

export interface ConflictAiSettings {
  /**
   * Master switch: when true, the AI merge action is offered and AI can be used as
   * a resolution strategy for new conflicts. Default OFF.
   */
  enabled: boolean
  /**
   * EXTRA opt-in: when true (and `enabled` is also true), an AI auto-resolution may
   * apply its merge WITHOUT human review. When false, the AI merge is always shown
   * for review/edit before applying. Default OFF (review-first).
   */
  autoApply: boolean
}

export const DEFAULT_CONFLICT_AI_SETTINGS: ConflictAiSettings = {
  enabled: false,
  autoApply: false,
}

/**
 * Normalize a possibly-partial/garbage parsed object into valid settings, enforcing
 * the invariant that autoApply can only be true when enabled is also true. Pure.
 */
export function normalizeConflictAiSettings(value: unknown): ConflictAiSettings {
  const parsed = (value ?? {}) as Partial<ConflictAiSettings>
  const enabled = parsed.enabled === true
  // autoApply is only meaningful (and only allowed) when AI is enabled at all.
  const autoApply = enabled && parsed.autoApply === true
  return { enabled, autoApply }
}

export function loadConflictAiSettings(): ConflictAiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_CONFLICT_AI_SETTINGS }
    }
    return normalizeConflictAiSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFLICT_AI_SETTINGS }
  }
}

export function saveConflictAiSettings(settings: ConflictAiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeConflictAiSettings(settings)))
  } catch {
    /* storage may be unavailable (private mode); AI conflict merge stays opt-in/off */
  }
}
