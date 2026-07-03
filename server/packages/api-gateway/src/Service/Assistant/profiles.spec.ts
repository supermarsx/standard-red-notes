import {
  effectiveProfiles,
  legacyProfilesFromConfig,
  maskProfiles,
  PersistedAiProfile,
  resolveProfileProvider,
  selectActiveProfile,
  validateProfilesPatch,
} from './profiles'

describe('assistant profiles', () => {
  const anthropic: PersistedAiProfile = {
    id: 'p1',
    name: 'Work Claude',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    enabled: true,
    apiKey: 'sk-secret',
  }
  const openai: PersistedAiProfile = {
    id: 'p2',
    name: 'OpenRouter',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'gpt-4o',
    enabled: true,
    apiKey: 'or-secret',
  }
  const codex: PersistedAiProfile = {
    id: 'p3',
    name: 'Codex',
    provider: 'codex-subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    enabled: false,
  }

  describe('maskProfiles', () => {
    it('replaces the secret with a keyConfigured boolean and never leaks the key', () => {
      const masked = maskProfiles([anthropic, openai, codex])
      expect(JSON.stringify(masked)).not.toContain('sk-secret')
      expect(JSON.stringify(masked)).not.toContain('or-secret')
      expect(masked[0]).toMatchObject({ id: 'p1', name: 'Work Claude', provider: 'anthropic', keyConfigured: true })
      expect(masked[2]).toMatchObject({ id: 'p3', keyConfigured: false, enabled: false })
    })
  })

  describe('resolveProfileProvider', () => {
    it('maps anthropic to the anthropic provider with its key', () => {
      const r = resolveProfileProvider(anthropic)
      expect(r).toMatchObject({ providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' })
      expect(r.config.anthropicApiKey).toBe('sk-secret')
    })

    it('maps openai-compatible to the openai provider (api-key mode) with base URL + key', () => {
      const r = resolveProfileProvider(openai, 'override-model')
      expect(r.providerId).toBe('openai')
      expect(r.model).toBe('override-model')
      expect(r.config).toMatchObject({
        openaiAuthMode: 'api-key',
        openaiApiKey: 'or-secret',
        openaiBaseURL: 'https://openrouter.ai/api/v1',
      })
    })

    it('maps codex-subscription to the openai provider in subscription mode', () => {
      const r = resolveProfileProvider(codex)
      expect(r.providerId).toBe('openai')
      expect(r.config).toMatchObject({
        openaiAuthMode: 'subscription',
        openaiSubscriptionBaseURL: 'https://chatgpt.com/backend-api/codex',
      })
    })

    it('maps ollama to the native ollama provider with its base URL', () => {
      const r = resolveProfileProvider({ id: 'o', name: 'Ollama', provider: 'ollama', baseUrl: 'http://x:11434', enabled: true })
      expect(r.providerId).toBe('ollama')
      expect(r.config.ollamaUrl).toBe('http://x:11434')
    })
  })

  describe('back-compat: legacyProfilesFromConfig', () => {
    it('synthesizes profiles from the legacy single-provider fields', () => {
      const profiles = legacyProfilesFromConfig({
        anthropicApiKey: 'a',
        openaiApiKey: 'o',
        openaiBaseURL: 'https://api.openai.com/v1',
        ollamaUrl: 'http://localhost:11434',
      })
      expect(profiles.map((p) => p.provider)).toEqual(['anthropic', 'openai-compatible', 'ollama'])
      expect(profiles.every((p) => p.enabled)).toBe(true)
    })

    it('maps subscription auth-mode legacy config to a codex-subscription profile', () => {
      const profiles = legacyProfilesFromConfig({
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 'tok',
        openaiSubscriptionBaseURL: 'https://chatgpt.com/backend-api/codex',
      })
      expect(profiles).toHaveLength(1)
      expect(profiles[0].provider).toBe('codex-subscription')
      expect(profiles[0].apiKey).toBe('tok')
    })

    it('returns no profiles when nothing is configured', () => {
      expect(legacyProfilesFromConfig({})).toEqual([])
    })
  })

  describe('effectiveProfiles + selectActiveProfile', () => {
    it('prefers explicit persisted profiles over legacy mapping', () => {
      const { profiles, defaultProfileId } = effectiveProfiles([anthropic, openai], 'p2', { anthropicApiKey: 'legacy' })
      expect(profiles).toHaveLength(2)
      expect(defaultProfileId).toBe('p2')
    })

    it('falls back to legacy-mapped profiles and the first enabled as default', () => {
      const { profiles, defaultProfileId } = effectiveProfiles(undefined, undefined, {
        anthropicApiKey: 'a',
        ollamaUrl: 'http://localhost:11434',
      })
      expect(profiles.map((p) => p.provider)).toEqual(['anthropic', 'ollama'])
      expect(defaultProfileId).toBe(profiles[0].id)
    })

    it('ignores a defaultProfileId that does not exist', () => {
      const { defaultProfileId } = effectiveProfiles([anthropic], 'missing', {})
      expect(defaultProfileId).toBe('p1')
    })

    it('selectActiveProfile honors a requested id, then default, then first enabled', () => {
      const profiles = [anthropic, openai, codex]
      expect(selectActiveProfile(profiles, 'p1', 'p2')?.id).toBe('p2')
      expect(selectActiveProfile(profiles, 'p2')?.id).toBe('p2')
      // codex (p3) is disabled — a request for it falls through to the default.
      expect(selectActiveProfile(profiles, 'p1', 'p3')?.id).toBe('p1')
      expect(selectActiveProfile([codex], undefined)).toBeUndefined()
    })
  })

  describe('validateProfilesPatch', () => {
    it('accepts a valid array and preserves a write-only key when apiKey is omitted', () => {
      const existing = [openai]
      const result = validateProfilesPatch(
        [{ id: 'p2', name: 'OpenRouter renamed', provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', enabled: true }],
        'p2',
        existing,
      )
      expect('error' in result).toBe(false)
      if ('error' in result) {
        return
      }
      expect(result.profiles?.[0].apiKey).toBe('or-secret') // preserved
      expect(result.profiles?.[0].name).toBe('OpenRouter renamed')
      expect(result.defaultProfileId).toBe('p2')
    })

    it('sets a new key, and clears it with apiKey null', () => {
      const setResult = validateProfilesPatch(
        [{ id: 'p2', name: 'X', provider: 'openai-compatible', apiKey: 'new-key', enabled: true }],
        undefined,
        [openai],
      )
      expect('error' in setResult ? setResult.error : setResult.profiles?.[0].apiKey).toBe('new-key')

      const clearResult = validateProfilesPatch(
        [{ id: 'p2', name: 'X', provider: 'openai-compatible', apiKey: null, enabled: true }],
        undefined,
        [openai],
      )
      expect('error' in clearResult ? 'err' : clearResult.profiles?.[0].apiKey).toBeUndefined()
    })

    it('clears everything with profiles: null', () => {
      const result = validateProfilesPatch(null, null, [openai])
      expect(result).toEqual({ profiles: null, defaultProfileId: null })
    })

    it('rejects invalid providers, missing ids/names, bad URLs, and duplicates', () => {
      expect('error' in validateProfilesPatch([{ id: 'a', name: 'a', provider: 'nope', enabled: true }], undefined, undefined)).toBe(true)
      expect('error' in validateProfilesPatch([{ id: '', name: 'a', provider: 'anthropic', enabled: true }], undefined, undefined)).toBe(true)
      expect('error' in validateProfilesPatch([{ id: 'a', name: '', provider: 'anthropic', enabled: true }], undefined, undefined)).toBe(true)
      expect(
        'error' in
          validateProfilesPatch(
            [{ id: 'a', name: 'a', provider: 'openai-compatible', baseUrl: 'ftp://x', enabled: true }],
            undefined,
            undefined,
          ),
      ).toBe(true)
      expect(
        'error' in
          validateProfilesPatch(
            [
              { id: 'dup', name: 'a', provider: 'anthropic', enabled: true },
              { id: 'dup', name: 'b', provider: 'anthropic', enabled: true },
            ],
            undefined,
            undefined,
          ),
      ).toBe(true)
    })
  })
})
