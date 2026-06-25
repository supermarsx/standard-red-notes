import {
  clampMaxSteps,
  clampMaxTokens,
  clampTemperature,
  clampTopP,
  DEFAULT_SAMPLING_SETTINGS,
  getMaxSteps,
  loadSamplingSettings,
  MAX_STEPS_MAX,
  MAX_STEPS_MIN,
  MAX_TOKENS_MAX,
  normalizeSamplingSettings,
  samplingRequestFields,
  saveSamplingSettings,
} from './samplingSettings'

const STORAGE_KEY = 'standardnotes.assistantSampling.settings.v1'

beforeEach(() => {
  localStorage.clear()
})

describe('sampling settings clamping', () => {
  it('clamps temperature into [0, 2]', () => {
    expect(clampTemperature(-1)).toBe(0)
    expect(clampTemperature(0.5)).toBe(0.5)
    expect(clampTemperature(5)).toBe(2)
  })

  it('falls back to the default temperature for non-finite input', () => {
    expect(clampTemperature(NaN)).toBe(DEFAULT_SAMPLING_SETTINGS.temperature)
    expect(clampTemperature('abc')).toBe(DEFAULT_SAMPLING_SETTINGS.temperature)
    expect(clampTemperature(undefined)).toBe(DEFAULT_SAMPLING_SETTINGS.temperature)
  })

  it('clamps top_p into [0, 1]', () => {
    expect(clampTopP(-0.5)).toBe(0)
    expect(clampTopP(0.3)).toBe(0.3)
    expect(clampTopP(2)).toBe(1)
  })

  it('treats max tokens of 0 or below as unset (0)', () => {
    expect(clampMaxTokens(0)).toBe(0)
    expect(clampMaxTokens(-100)).toBe(0)
    expect(clampMaxTokens(NaN)).toBe(0)
  })

  it('floors and caps positive max tokens', () => {
    expect(clampMaxTokens(123.9)).toBe(123)
    expect(clampMaxTokens(MAX_TOKENS_MAX + 1000)).toBe(MAX_TOKENS_MAX)
    expect(clampMaxTokens(0.4)).toBe(1)
  })

  it('rounds and clamps max steps into [1, 30]', () => {
    expect(clampMaxSteps(0)).toBe(MAX_STEPS_MIN)
    expect(clampMaxSteps(8)).toBe(8)
    expect(clampMaxSteps(7.6)).toBe(8)
    expect(clampMaxSteps(1000)).toBe(MAX_STEPS_MAX)
    expect(clampMaxSteps(NaN)).toBe(DEFAULT_SAMPLING_SETTINGS.maxSteps)
  })
})

describe('normalizeSamplingSettings', () => {
  it('returns defaults for null/undefined/non-object', () => {
    expect(normalizeSamplingSettings(null)).toEqual(DEFAULT_SAMPLING_SETTINGS)
    expect(normalizeSamplingSettings(undefined)).toEqual(DEFAULT_SAMPLING_SETTINGS)
  })

  it('clamps every field of a partial/out-of-range object', () => {
    expect(normalizeSamplingSettings({ temperature: 9, topP: 9, maxTokens: -5, maxSteps: 999 })).toEqual({
      temperature: 2,
      topP: 1,
      maxTokens: 0,
      maxSteps: MAX_STEPS_MAX,
    })
  })

  it('fills missing fields with defaults', () => {
    expect(normalizeSamplingSettings({ temperature: 0.2 })).toEqual({
      temperature: 0.2,
      topP: DEFAULT_SAMPLING_SETTINGS.topP,
      maxTokens: DEFAULT_SAMPLING_SETTINGS.maxTokens,
      maxSteps: DEFAULT_SAMPLING_SETTINGS.maxSteps,
    })
  })
})

describe('load/save round-trip', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSamplingSettings()).toEqual(DEFAULT_SAMPLING_SETTINGS)
    expect(getMaxSteps()).toBe(DEFAULT_SAMPLING_SETTINGS.maxSteps)
  })

  it('round-trips valid settings', () => {
    saveSamplingSettings({ temperature: 1.1, topP: 0.9, maxTokens: 500, maxSteps: 12 })
    expect(loadSamplingSettings()).toEqual({ temperature: 1.1, topP: 0.9, maxTokens: 500, maxSteps: 12 })
    expect(getMaxSteps()).toBe(12)
  })

  it('clamps out-of-range values on save', () => {
    saveSamplingSettings({ temperature: 100, topP: 100, maxTokens: -1, maxSteps: 100 })
    expect(loadSamplingSettings()).toEqual({ temperature: 2, topP: 1, maxTokens: 0, maxSteps: MAX_STEPS_MAX })
  })

  it('returns (and re-clamps) on malformed storage', () => {
    localStorage.setItem(STORAGE_KEY, '{ not json')
    expect(loadSamplingSettings()).toEqual(DEFAULT_SAMPLING_SETTINGS)
  })

  it('re-clamps a hand-edited out-of-range stored value on load', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ temperature: 50, topP: -3, maxTokens: 9e9, maxSteps: 0 }))
    expect(loadSamplingSettings()).toEqual({
      temperature: 2,
      topP: 0,
      maxTokens: MAX_TOKENS_MAX,
      maxSteps: MAX_STEPS_MIN,
    })
  })
})

describe('samplingRequestFields', () => {
  it('maps to wire field names and omits max_tokens when unset', () => {
    expect(samplingRequestFields({ temperature: 0.5, topP: 0.8, maxTokens: 0, maxSteps: 8 })).toEqual({
      temperature: 0.5,
      top_p: 0.8,
    })
  })

  it('includes max_tokens when set', () => {
    expect(samplingRequestFields({ temperature: 0.5, topP: 0.8, maxTokens: 256, maxSteps: 8 })).toEqual({
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 256,
    })
  })

  it('reads from saved settings when no argument is given', () => {
    saveSamplingSettings({ temperature: 1.5, topP: 0.5, maxTokens: 42, maxSteps: 4 })
    expect(samplingRequestFields()).toEqual({ temperature: 1.5, top_p: 0.5, max_tokens: 42 })
  })
})
