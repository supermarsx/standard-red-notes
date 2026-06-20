// Local, unsynced narration preferences. These live in localStorage rather than a
// synced PrefKey because adding a PrefKey would require touching @standardnotes/models
// (off-limits for this web-only change). They are device-local UI preferences anyway:
// the chosen narration style, the TTS voice, and the speaking rate.

import { DEFAULT_NARRATION_STYLE, NarrationStyleId, NARRATION_STYLES } from './narration'

const STORAGE_KEY = 'standardnotes.narration.settings.v1'

/** A narration style id OR the sentinel that means "ask me each time I narrate". */
export type NarrationStyleSetting = NarrationStyleId | 'ask'

export interface NarrationSettings {
  /** Default style, or 'ask' to prompt the user every time. */
  defaultStyle: NarrationStyleSetting
  /**
   * Preferred Web Speech voice. Identified by voiceURI (stable-ish per browser).
   * Empty means "let the browser/endpoint pick its default".
   */
  voiceURI: string
  /** Speaking rate multiplier. 1 = normal. Clamped to [0.5, 2]. */
  rate: number
  /** Preferred model-TTS voice name (e.g. OpenAI 'alloy'). Empty = endpoint default. */
  modelVoice: string
}

export const DEFAULT_NARRATION_SETTINGS: NarrationSettings = {
  defaultStyle: DEFAULT_NARRATION_STYLE,
  voiceURI: '',
  rate: 1,
  modelVoice: 'alloy',
}

const RATE_MIN = 0.5
const RATE_MAX = 2

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    return 1
  }
  return Math.min(RATE_MAX, Math.max(RATE_MIN, rate))
}

function isValidStyleSetting(value: unknown): value is NarrationStyleSetting {
  return value === 'ask' || NARRATION_STYLES.some((style) => style.id === value)
}

export function loadNarrationSettings(): NarrationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_NARRATION_SETTINGS }
    }
    const parsed = JSON.parse(raw) as Partial<NarrationSettings>
    return {
      defaultStyle: isValidStyleSetting(parsed.defaultStyle)
        ? parsed.defaultStyle
        : DEFAULT_NARRATION_SETTINGS.defaultStyle,
      voiceURI: typeof parsed.voiceURI === 'string' ? parsed.voiceURI : DEFAULT_NARRATION_SETTINGS.voiceURI,
      rate: clampRate(typeof parsed.rate === 'number' ? parsed.rate : DEFAULT_NARRATION_SETTINGS.rate),
      modelVoice: typeof parsed.modelVoice === 'string' ? parsed.modelVoice : DEFAULT_NARRATION_SETTINGS.modelVoice,
    }
  } catch {
    return { ...DEFAULT_NARRATION_SETTINGS }
  }
}

export function saveNarrationSettings(settings: NarrationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, rate: clampRate(settings.rate) }))
  } catch {
    /* storage may be unavailable (private mode); narration still works with defaults */
  }
}
