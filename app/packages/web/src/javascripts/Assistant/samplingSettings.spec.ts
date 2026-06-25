import {
  clampMaxRunTime,
  clampMaxSteps,
  clampMaxTokens,
  clampTemperature,
  clampTopP,
  DEFAULT_SAMPLING_SETTINGS,
  getMaxRunTimeMs,
  getMaxSteps,
  loadSamplingSettings,
  MAX_RUN_TIME_MAX_MINUTES,
  MAX_STEPS_MAX,
  MAX_TOKENS_MAX,
  normalizeSamplingSettings,
  SamplingSettings,
  samplingRequestFields,
  saveSamplingSettings,
} from './samplingSettings'

const STORAGE_KEY = 'standardnotes.assistantSampling.settings.v1'

/** Build a full SamplingSettings from a partial, filling the rest with defaults. */
const settings = (overrides: Partial<SamplingSettings>): SamplingSettings => ({
  ...DEFAULT_SAMPLING_SETTINGS,
  ...overrides,
})

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

  it('treats max steps of 0 or below as UNLIMITED (0)', () => {
    expect(clampMaxSteps(0)).toBe(0)
    expect(clampMaxSteps(-5)).toBe(0)
  })

  it('rounds and clamps positive max steps into [1, MAX_STEPS_MAX]', () => {
    expect(clampMaxSteps(8)).toBe(8)
    expect(clampMaxSteps(7.6)).toBe(8)
    expect(clampMaxSteps(MAX_STEPS_MAX + 1000)).toBe(MAX_STEPS_MAX)
    expect(clampMaxSteps(NaN)).toBe(DEFAULT_SAMPLING_SETTINGS.maxSteps)
  })

  it('clamps run time within [1 minute, 200 hours] regardless of unit', () => {
    expect(clampMaxRunTime(5, 'hours')).toBe(5)
    expect(clampMaxRunTime(99999, 'hours')).toBe(200)
    expect(clampMaxRunTime(0, 'minutes')).toBe(
      Math.min(MAX_RUN_TIME_MAX_MINUTES, Math.max(1, DEFAULT_SAMPLING_SETTINGS.maxRunTime)),
    )
    expect(clampMaxRunTime(99999, 'minutes')).toBe(MAX_RUN_TIME_MAX_MINUTES)
    expect(clampMaxRunTime(30, 'minutes')).toBe(30)
  })

  it('converts the run-time limit to milliseconds', () => {
    expect(getMaxRunTimeMs(settings({ maxRunTime: 2, maxRunTimeUnit: 'hours' }))).toBe(2 * 60 * 60 * 1000)
    expect(getMaxRunTimeMs(settings({ maxRunTime: 90, maxRunTimeUnit: 'minutes' }))).toBe(90 * 60 * 1000)
    // Caps at 200 hours.
    expect(getMaxRunTimeMs(settings({ maxRunTime: 999, maxRunTimeUnit: 'hours' }))).toBe(MAX_RUN_TIME_MAX_MINUTES * 60 * 1000)
  })
})

describe('normalizeSamplingSettings', () => {
  it('returns defaults for null/undefined/non-object', () => {
    expect(normalizeSamplingSettings(null)).toEqual(DEFAULT_SAMPLING_SETTINGS)
    expect(normalizeSamplingSettings(undefined)).toEqual(DEFAULT_SAMPLING_SETTINGS)
  })

  it('clamps every field of a partial/out-of-range object', () => {
    expect(normalizeSamplingSettings({ temperature: 9, topP: 9, maxTokens: -5, maxSteps: MAX_STEPS_MAX + 999 })).toEqual(
      settings({
        temperature: 2,
        topP: 1,
        maxTokens: 0,
        maxSteps: MAX_STEPS_MAX,
      }),
    )
  })

  it('fills missing fields with defaults', () => {
    expect(normalizeSamplingSettings({ temperature: 0.2 })).toEqual(settings({ temperature: 0.2 }))
  })

  it('preserves the use-server-default flags', () => {
    expect(normalizeSamplingSettings({ useServerTemperature: true, useServerTopP: true })).toEqual(
      settings({ useServerTemperature: true, useServerTopP: true }),
    )
  })
})

describe('load/save round-trip', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSamplingSettings()).toEqual(DEFAULT_SAMPLING_SETTINGS)
    expect(getMaxSteps()).toBe(DEFAULT_SAMPLING_SETTINGS.maxSteps)
  })

  it('round-trips valid settings', () => {
    const value = settings({ temperature: 1.1, topP: 0.9, maxTokens: 500, maxSteps: 12 })
    saveSamplingSettings(value)
    expect(loadSamplingSettings()).toEqual(value)
    expect(getMaxSteps()).toBe(12)
  })

  it('clamps out-of-range values on save', () => {
    saveSamplingSettings(settings({ temperature: 100, topP: 100, maxTokens: -1, maxSteps: MAX_STEPS_MAX + 100 }))
    expect(loadSamplingSettings()).toEqual(
      settings({ temperature: 2, topP: 1, maxTokens: 0, maxSteps: MAX_STEPS_MAX }),
    )
  })

  it('returns (and re-clamps) on malformed storage', () => {
    localStorage.setItem(STORAGE_KEY, '{ not json')
    expect(loadSamplingSettings()).toEqual(DEFAULT_SAMPLING_SETTINGS)
  })

  it('re-clamps a hand-edited out-of-range stored value on load', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ temperature: 50, topP: -3, maxTokens: 9e9, maxSteps: -1 }))
    expect(loadSamplingSettings()).toEqual(
      settings({
        temperature: 2,
        topP: 0,
        maxTokens: MAX_TOKENS_MAX,
        maxSteps: 0,
      }),
    )
  })
})

describe('samplingRequestFields', () => {
  it('maps to wire field names and omits max_tokens when unset', () => {
    expect(samplingRequestFields(settings({ temperature: 0.5, topP: 0.8, maxTokens: 0 }))).toEqual({
      temperature: 0.5,
      top_p: 0.8,
    })
  })

  it('includes max_tokens when set', () => {
    expect(samplingRequestFields(settings({ temperature: 0.5, topP: 0.8, maxTokens: 256 }))).toEqual({
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 256,
    })
  })

  it('omits temperature when useServerTemperature is on', () => {
    expect(samplingRequestFields(settings({ temperature: 0.5, topP: 0.8, useServerTemperature: true }))).toEqual({
      top_p: 0.8,
    })
  })

  it('omits top_p when useServerTopP is on', () => {
    expect(samplingRequestFields(settings({ temperature: 0.5, topP: 0.8, useServerTopP: true }))).toEqual({
      temperature: 0.5,
    })
  })

  it('omits both when both server-default flags are on', () => {
    expect(
      samplingRequestFields(settings({ useServerTemperature: true, useServerTopP: true, maxTokens: 0 })),
    ).toEqual({})
  })

  it('reads from saved settings when no argument is given', () => {
    saveSamplingSettings(settings({ temperature: 1.5, topP: 0.5, maxTokens: 42, maxSteps: 4 }))
    expect(samplingRequestFields()).toEqual({ temperature: 1.5, top_p: 0.5, max_tokens: 42 })
  })
})
