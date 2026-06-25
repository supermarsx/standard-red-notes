// Web-local, unsynced settings for MODEL SAMPLING parameters (temperature,
// top_p, max output tokens) and the AGENT LOOP step cap (maxSteps).
//
// Stored in localStorage rather than a synced PrefKey because adding a PrefKey
// would require touching @standardnotes/models (off-limits for this web-only
// change) — same pattern as narrationSettings / dictationSettings /
// contextualSearchSettings / personaSettings.
//
// These shape every model call: the sampling fields are threaded into the
// request body of both the Direct and Server-proxy providers, and maxSteps is
// the default step cap the agent loop runs to. Each field is clamped to a sane
// range on save AND on load so a hand-edited localStorage value can never push
// an out-of-range / non-finite value into a request body.

const STORAGE_KEY = 'standardnotes.assistantSampling.settings.v1'

/** Unit a run-time limit is expressed in. Stored alongside the numeric value. */
export type RunTimeUnit = 'minutes' | 'hours'

export interface SamplingSettings {
  /**
   * Sampling temperature (higher = more random). Most OpenAI-compatible
   * endpoints accept 0–2. Clamped to [0, 2].
   */
  temperature: number
  /**
   * Nucleus sampling probability mass. Clamped to [0, 1]. 1 effectively
   * disables top_p filtering.
   */
  topP: number
  /**
   * Maximum number of tokens to generate per turn (request `max_tokens`).
   * 0 means "unset" — the field is omitted from the request so the endpoint
   * uses its own default. Otherwise clamped to [1, 200000].
   */
  maxTokens: number
  /**
   * Default agent-loop step cap (model turns before a forced summary).
   * 0 means UNLIMITED (no cap — not recommended). Otherwise clamped to
   * [1, MAX_STEPS_MAX]. Default 500.
   */
  maxSteps: number
  /**
   * Wall-clock run-time limit value, paired with {@link maxRunTimeUnit}. The
   * effective limit is clamped to [1 minute, 200 hours] regardless of unit.
   * Default 200 hours.
   */
  maxRunTime: number
  /** Unit the {@link maxRunTime} value is expressed in. */
  maxRunTimeUnit: RunTimeUnit
  /**
   * When true the `temperature` parameter is OMITTED from the request so the
   * provider/server uses its own default (the slider is bypassed).
   */
  useServerTemperature: boolean
  /**
   * When true the `top_p` parameter is OMITTED from the request so the
   * provider/server uses its own default (the slider is bypassed).
   */
  useServerTopP: boolean
}

export const DEFAULT_SAMPLING_SETTINGS: SamplingSettings = {
  temperature: 0.7,
  topP: 1,
  maxTokens: 0,
  maxSteps: 500,
  maxRunTime: 200,
  maxRunTimeUnit: 'hours',
  useServerTemperature: false,
  useServerTopP: false,
}

export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 2
export const TOP_P_MIN = 0
export const TOP_P_MAX = 1
/** 0 is allowed and means "omit max_tokens"; positive values are clamped to this. */
export const MAX_TOKENS_MAX = 200000
/** 0 is allowed and means "unlimited steps"; positive values clamp into this range. */
export const MAX_STEPS_MIN = 0
export const MAX_STEPS_MAX = 100000

/** Run-time limit bounds, expressed in MINUTES (the canonical internal unit). */
export const MAX_RUN_TIME_MIN_MINUTES = 1
export const MAX_RUN_TIME_MAX_MINUTES = 200 * 60 // 200 hours

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return Math.min(max, Math.max(min, n))
}

export function clampTemperature(value: unknown): number {
  return clampNumber(value, TEMPERATURE_MIN, TEMPERATURE_MAX, DEFAULT_SAMPLING_SETTINGS.temperature)
}

export function clampTopP(value: unknown): number {
  return clampNumber(value, TOP_P_MIN, TOP_P_MAX, DEFAULT_SAMPLING_SETTINGS.topP)
}

export function clampMaxTokens(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return 0
  }
  return Math.min(MAX_TOKENS_MAX, Math.max(1, Math.floor(n)))
}

export function clampMaxSteps(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    return DEFAULT_SAMPLING_SETTINGS.maxSteps
  }
  const rounded = Math.round(n)
  // 0 (or any non-positive value) means UNLIMITED — keep it as 0.
  if (rounded <= 0) {
    return 0
  }
  return Math.min(MAX_STEPS_MAX, Math.max(1, rounded))
}

/** Clamp a run-time number for the given unit, keeping it within [1min, 200h]. */
export function clampMaxRunTime(value: unknown, unit: RunTimeUnit): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return unit === 'hours'
      ? DEFAULT_SAMPLING_SETTINGS.maxRunTime
      : Math.min(MAX_RUN_TIME_MAX_MINUTES, Math.max(MAX_RUN_TIME_MIN_MINUTES, DEFAULT_SAMPLING_SETTINGS.maxRunTime))
  }
  const minutes = unit === 'hours' ? n * 60 : n
  const clampedMinutes = Math.min(MAX_RUN_TIME_MAX_MINUTES, Math.max(MAX_RUN_TIME_MIN_MINUTES, minutes))
  return unit === 'hours' ? clampedMinutes / 60 : Math.round(clampedMinutes)
}

export function clampRunTimeUnit(value: unknown): RunTimeUnit {
  return value === 'minutes' ? 'minutes' : 'hours'
}

/** The configured run-time limit expressed in MILLISECONDS (clamped). */
export function getMaxRunTimeMs(settings: SamplingSettings = loadSamplingSettings()): number {
  const minutes =
    settings.maxRunTimeUnit === 'hours' ? settings.maxRunTime * 60 : settings.maxRunTime
  const clampedMinutes = Math.min(MAX_RUN_TIME_MAX_MINUTES, Math.max(MAX_RUN_TIME_MIN_MINUTES, minutes))
  return clampedMinutes * 60 * 1000
}

/** Normalize an arbitrary (possibly partial / malformed) object into valid settings. */
export function normalizeSamplingSettings(parsed: Partial<SamplingSettings> | null | undefined): SamplingSettings {
  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_SAMPLING_SETTINGS }
  }
  const maxRunTimeUnit = clampRunTimeUnit(parsed.maxRunTimeUnit ?? DEFAULT_SAMPLING_SETTINGS.maxRunTimeUnit)
  return {
    temperature: clampTemperature(parsed.temperature),
    topP: clampTopP(parsed.topP),
    maxTokens: clampMaxTokens(parsed.maxTokens),
    maxSteps: clampMaxSteps(parsed.maxSteps),
    maxRunTime: clampMaxRunTime(parsed.maxRunTime ?? DEFAULT_SAMPLING_SETTINGS.maxRunTime, maxRunTimeUnit),
    maxRunTimeUnit,
    useServerTemperature:
      typeof parsed.useServerTemperature === 'boolean'
        ? parsed.useServerTemperature
        : DEFAULT_SAMPLING_SETTINGS.useServerTemperature,
    useServerTopP:
      typeof parsed.useServerTopP === 'boolean' ? parsed.useServerTopP : DEFAULT_SAMPLING_SETTINGS.useServerTopP,
  }
}

export function loadSamplingSettings(): SamplingSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_SAMPLING_SETTINGS }
    }
    return normalizeSamplingSettings(JSON.parse(raw) as Partial<SamplingSettings>)
  } catch {
    return { ...DEFAULT_SAMPLING_SETTINGS }
  }
}

export function saveSamplingSettings(settings: SamplingSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSamplingSettings(settings)))
  } catch {
    /* storage may be unavailable (private mode); calls fall back to defaults */
  }
}

/**
 * The sampling fields shaped for an OpenAI-style request body. Each field is
 * OMITTED when the user opted to let the provider/server use its own default:
 *  - `temperature` is dropped when `useServerTemperature` is on (slider bypassed).
 *  - `top_p` is dropped when `useServerTopP` is on (slider bypassed).
 *  - `max_tokens` is dropped when maxTokens is 0 (unset).
 * This is the single place that maps our settings to wire field names, reused by
 * both providers, so the omission applies to Direct and Server-proxy alike.
 */
export function samplingRequestFields(settings: SamplingSettings = loadSamplingSettings()): {
  temperature?: number
  top_p?: number
  max_tokens?: number
} {
  const out: { temperature?: number; top_p?: number; max_tokens?: number } = {}
  if (!settings.useServerTemperature) {
    out.temperature = settings.temperature
  }
  if (!settings.useServerTopP) {
    out.top_p = settings.topP
  }
  if (settings.maxTokens > 0) {
    out.max_tokens = settings.maxTokens
  }
  return out
}

/** Convenience: the configured default agent-loop step cap (clamped). */
export function getMaxSteps(): number {
  return loadSamplingSettings().maxSteps
}
