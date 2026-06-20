import {
  DEFAULT_DEEP_RESEARCH_SETTINGS,
  isDeepResearchEnabled,
  loadDeepResearchSettings,
  saveDeepResearchSettings,
} from './deepResearchSettings'

describe('deep research settings (web-local)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to OFF when nothing is stored', () => {
    expect(DEFAULT_DEEP_RESEARCH_SETTINGS.enabled).toBe(false)
    expect(loadDeepResearchSettings().enabled).toBe(false)
    expect(isDeepResearchEnabled()).toBe(false)
  })

  it('persists and reloads the enabled flag', () => {
    saveDeepResearchSettings({ enabled: true })
    expect(loadDeepResearchSettings().enabled).toBe(true)
    expect(isDeepResearchEnabled()).toBe(true)
  })

  it('falls back to the default for malformed storage', () => {
    localStorage.setItem('standardnotes.deepResearch.settings.v1', 'not json')
    expect(loadDeepResearchSettings().enabled).toBe(false)
  })

  it('ignores a non-boolean enabled value', () => {
    localStorage.setItem('standardnotes.deepResearch.settings.v1', JSON.stringify({ enabled: 'yes' }))
    expect(loadDeepResearchSettings().enabled).toBe(false)
  })
})
