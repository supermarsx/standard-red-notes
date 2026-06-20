import {
  DEFAULT_CONTEXTUAL_SEARCH_SETTINGS,
  isContextualSearchEnabled,
  loadContextualSearchSettings,
  saveContextualSearchSettings,
} from './contextualSearchSettings'

describe('contextual search settings (web-local)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to OFF when nothing is stored', () => {
    expect(DEFAULT_CONTEXTUAL_SEARCH_SETTINGS.enabled).toBe(false)
    expect(loadContextualSearchSettings().enabled).toBe(false)
    expect(isContextualSearchEnabled()).toBe(false)
  })

  it('persists and reloads the enabled flag', () => {
    saveContextualSearchSettings({ enabled: true })
    expect(loadContextualSearchSettings().enabled).toBe(true)
    expect(isContextualSearchEnabled()).toBe(true)
  })

  it('falls back to the default for malformed storage', () => {
    localStorage.setItem('standardnotes.contextualSearch.settings.v1', 'not json')
    expect(loadContextualSearchSettings().enabled).toBe(false)
  })

  it('ignores a non-boolean enabled value', () => {
    localStorage.setItem('standardnotes.contextualSearch.settings.v1', JSON.stringify({ enabled: 'yes' }))
    expect(loadContextualSearchSettings().enabled).toBe(false)
  })
})
