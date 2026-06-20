import {
  DEFAULT_DICTATION_SETTINGS,
  isDictationEnabled,
  loadDictationSettings,
  saveDictationSettings,
} from './dictationSettings'

beforeEach(() => {
  localStorage.clear()
})

describe('dictation settings', () => {
  it('defaults dictationEnabled to FALSE (opt-in)', () => {
    expect(DEFAULT_DICTATION_SETTINGS.dictationEnabled).toBe(false)
    expect(loadDictationSettings().dictationEnabled).toBe(false)
    expect(isDictationEnabled()).toBe(false)
  })

  it('round-trips saved settings', () => {
    saveDictationSettings({ dictationEnabled: true, sttModel: 'whisper-1', language: 'en-US' })
    const loaded = loadDictationSettings()
    expect(loaded).toEqual({ dictationEnabled: true, sttModel: 'whisper-1', language: 'en-US' })
    expect(isDictationEnabled()).toBe(true)
  })

  it('returns defaults on malformed storage', () => {
    localStorage.setItem('standardnotes.dictation.settings.v1', '{not json')
    expect(loadDictationSettings()).toEqual(DEFAULT_DICTATION_SETTINGS)
  })

  it('ignores fields of the wrong type', () => {
    localStorage.setItem(
      'standardnotes.dictation.settings.v1',
      JSON.stringify({ dictationEnabled: 'yes', sttModel: 5, language: null }),
    )
    const loaded = loadDictationSettings()
    expect(loaded.dictationEnabled).toBe(false)
    expect(loaded.sttModel).toBe('')
    expect(loaded.language).toBe('')
  })
})
