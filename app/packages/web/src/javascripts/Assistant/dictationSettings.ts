// Local, unsynced dictation + speech-to-text preferences. These live in localStorage
// rather than a synced PrefKey because adding a PrefKey would require touching
// @standardnotes/models (off-limits for this web-only change). They are device-local
// UI preferences anyway: whether live dictation is enabled, the STT model override,
// and the spoken language hint.
//
// IMPORTANT: `dictationEnabled` defaults to FALSE. Dictation listens to the microphone
// and (in Chromium) routes audio through a cloud service, so it is strictly opt-in.

const STORAGE_KEY = 'standardnotes.dictation.settings.v1'

export interface DictationSettings {
  /**
   * Master opt-in for live "type by speaking" dictation. DEFAULT OFF — the mic toggle
   * in the editor toolbar is hidden until the user enables this in preferences.
   */
  dictationEnabled: boolean
  /**
   * Optional STT model id sent to the Direct-mode /audio/transcriptions endpoint
   * (e.g. whisper-1, gpt-4o-transcribe). Empty = use the resolver's default.
   */
  sttModel: string
  /**
   * Optional BCP-47 language hint (e.g. 'en-US') for both the model endpoint and the
   * Web Speech recognizer. Empty = let the backend auto-detect.
   */
  language: string
}

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  dictationEnabled: false,
  sttModel: '',
  language: '',
}

export function loadDictationSettings(): DictationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_DICTATION_SETTINGS }
    }
    const parsed = JSON.parse(raw) as Partial<DictationSettings>
    return {
      dictationEnabled:
        typeof parsed.dictationEnabled === 'boolean'
          ? parsed.dictationEnabled
          : DEFAULT_DICTATION_SETTINGS.dictationEnabled,
      sttModel: typeof parsed.sttModel === 'string' ? parsed.sttModel : DEFAULT_DICTATION_SETTINGS.sttModel,
      language: typeof parsed.language === 'string' ? parsed.language : DEFAULT_DICTATION_SETTINGS.language,
    }
  } catch {
    return { ...DEFAULT_DICTATION_SETTINGS }
  }
}

export function saveDictationSettings(settings: DictationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage may be unavailable (private mode); features still work with defaults */
  }
}

/** Convenience: is live dictation opted in? Defaults to false. */
export function isDictationEnabled(): boolean {
  return loadDictationSettings().dictationEnabled
}
