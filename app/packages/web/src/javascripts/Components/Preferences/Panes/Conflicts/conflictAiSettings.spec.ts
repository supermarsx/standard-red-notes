import { DEFAULT_CONFLICT_AI_SETTINGS, normalizeConflictAiSettings } from './conflictAiSettings'

describe('conflictAiSettings defaults', () => {
  it('defaults both flags OFF', () => {
    expect(DEFAULT_CONFLICT_AI_SETTINGS.enabled).toBe(false)
    expect(DEFAULT_CONFLICT_AI_SETTINGS.autoApply).toBe(false)
  })
})

describe('normalizeConflictAiSettings', () => {
  it('coerces missing/garbage input to all-off defaults', () => {
    expect(normalizeConflictAiSettings(undefined)).toEqual({ enabled: false, autoApply: false })
    expect(normalizeConflictAiSettings(null)).toEqual({ enabled: false, autoApply: false })
    expect(normalizeConflictAiSettings('nope' as unknown)).toEqual({ enabled: false, autoApply: false })
    expect(normalizeConflictAiSettings({})).toEqual({ enabled: false, autoApply: false })
  })

  it('only treats strictly-true values as enabled', () => {
    expect(normalizeConflictAiSettings({ enabled: 'yes' }).enabled).toBe(false)
    expect(normalizeConflictAiSettings({ enabled: 1 }).enabled).toBe(false)
    expect(normalizeConflictAiSettings({ enabled: true }).enabled).toBe(true)
  })

  it('forces autoApply OFF when AI is not enabled (invariant)', () => {
    expect(normalizeConflictAiSettings({ enabled: false, autoApply: true })).toEqual({
      enabled: false,
      autoApply: false,
    })
  })

  it('allows autoApply only when enabled is also true', () => {
    expect(normalizeConflictAiSettings({ enabled: true, autoApply: true })).toEqual({
      enabled: true,
      autoApply: true,
    })
  })
})
