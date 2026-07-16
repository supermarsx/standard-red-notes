import {
  backendProfileFromAssistantProfile,
  effectiveBackendProfiles,
  effectiveProfiles,
  legacyProfilesFromConfig,
  maskBackendProfiles,
  maskProfiles,
  PersistedAiProfile,
  PersistedBackendProfile,
  resolveAssignedProfileId,
  resolveEffectiveAssistantProfile,
  resolveProfileProvider,
  selectActiveProfile,
  validateAssignmentsPatch,
  validateBackendProfilesPatch,
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
      const r = resolveProfileProvider({
        id: 'o',
        name: 'Ollama',
        provider: 'ollama',
        baseUrl: 'http://x:11434',
        enabled: true,
      })
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
        [
          {
            id: 'p2',
            name: 'OpenRouter renamed',
            provider: 'openai-compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
            enabled: true,
          },
        ],
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

    it('accepts an optional backendProfileId reference', () => {
      const result = validateProfilesPatch(
        [{ id: 'p2', name: 'X', provider: 'openai-compatible', enabled: true, backendProfileId: 'be-1' }],
        undefined,
        [openai],
      )
      expect('error' in result ? result.error : result.profiles?.[0].backendProfileId).toBe('be-1')
    })

    it('rejects invalid providers, missing ids/names, bad URLs, and duplicates', () => {
      expect(
        'error' in
          validateProfilesPatch([{ id: 'a', name: 'a', provider: 'nope', enabled: true }], undefined, undefined),
      ).toBe(true)
      expect(
        'error' in
          validateProfilesPatch([{ id: '', name: 'a', provider: 'anthropic', enabled: true }], undefined, undefined),
      ).toBe(true)
      expect(
        'error' in
          validateProfilesPatch([{ id: 'a', name: '', provider: 'anthropic', enabled: true }], undefined, undefined),
      ).toBe(true)
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

// ============================================================================
// Standard Red Notes: decoupled BACKEND PROFILES + ASSIGNMENTS.
// ============================================================================

describe('backend profiles', () => {
  const apiKeyBackend: PersistedBackendProfile = {
    id: 'be-anthropic',
    name: 'Anthropic connection',
    type: 'api-key',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    apiKey: 'sk-backend-secret',
  }
  const subscriptionBackend: PersistedBackendProfile = {
    id: 'be-sub',
    name: 'Team ChatGPT',
    type: 'subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    subscriptionId: 'team-1',
  }

  describe('maskBackendProfiles', () => {
    it('masks the secret to keyConfigured and never leaks the key', () => {
      const masked = maskBackendProfiles([apiKeyBackend, subscriptionBackend])
      expect(JSON.stringify(masked)).not.toContain('sk-backend-secret')
      expect(masked[0]).toMatchObject({
        id: 'be-anthropic',
        type: 'api-key',
        provider: 'anthropic',
        keyConfigured: true,
      })
      expect(masked[1]).toMatchObject({
        id: 'be-sub',
        type: 'subscription',
        subscriptionId: 'team-1',
        keyConfigured: false,
      })
    })
  })

  describe('resolveEffectiveAssistantProfile (merge of backend onto profile)', () => {
    it('merges an api-key backend credential + provider onto the referencing profile', () => {
      const profile: PersistedAiProfile = {
        id: 'p',
        name: 'Ref',
        provider: 'openai-compatible',
        enabled: true,
        backendProfileId: 'be-anthropic',
      }
      const effective = resolveEffectiveAssistantProfile(profile, [apiKeyBackend])
      expect(effective.provider).toBe('anthropic')
      expect(effective.apiKey).toBe('sk-backend-secret')
      const resolution = resolveProfileProvider(effective)
      expect(resolution.providerId).toBe('anthropic')
      expect(resolution.config.anthropicApiKey).toBe('sk-backend-secret')
    })

    it('maps a subscription backend to codex-subscription + carries the subscriptionId', () => {
      const profile: PersistedAiProfile = {
        id: 'p',
        name: 'Ref',
        provider: 'openai-compatible',
        enabled: true,
        backendProfileId: 'be-sub',
      }
      const effective = resolveEffectiveAssistantProfile(profile, [subscriptionBackend])
      expect(effective.provider).toBe('codex-subscription')
      expect(effective.subscriptionId).toBe('team-1')
      expect(effective.apiKey).toBeUndefined()
    })

    it('returns the profile unchanged when it references no backend (legacy embedded)', () => {
      const profile: PersistedAiProfile = { id: 'p', name: 'Ref', provider: 'anthropic', enabled: true, apiKey: 'x' }
      expect(resolveEffectiveAssistantProfile(profile, [apiKeyBackend])).toBe(profile)
    })

    it('returns the profile unchanged when the referenced backend is missing', () => {
      const profile: PersistedAiProfile = {
        id: 'p',
        name: 'Ref',
        provider: 'anthropic',
        enabled: true,
        backendProfileId: 'gone',
      }
      expect(resolveEffectiveAssistantProfile(profile, [apiKeyBackend])).toBe(profile)
    })
  })

  describe('migration: effectiveBackendProfiles', () => {
    it('prefers explicit persisted backend profiles', () => {
      const result = effectiveBackendProfiles([apiKeyBackend], [])
      expect(result).toEqual([apiKeyBackend])
    })

    it('synthesizes backend profiles from embedded assistant profiles when none are persisted', () => {
      const anthropic: PersistedAiProfile = {
        id: 'p1',
        name: 'Claude',
        provider: 'anthropic',
        enabled: true,
        apiKey: 'sk',
      }
      const codex: PersistedAiProfile = { id: 'p2', name: 'Codex', provider: 'codex-subscription', enabled: true }
      const synth = effectiveBackendProfiles(undefined, [anthropic, codex])
      expect(synth[0]).toMatchObject({ id: 'backend-of-p1', type: 'api-key', provider: 'anthropic', apiKey: 'sk' })
      expect(synth[1]).toMatchObject({ id: 'backend-of-p2', type: 'subscription', subscriptionId: 'default' })
    })

    it('backendProfileFromAssistantProfile maps openai-compatible providers', () => {
      const openrouter: PersistedAiProfile = {
        id: 'p',
        name: 'OR',
        provider: 'openai-compatible',
        enabled: true,
        apiKey: 'or',
      }
      expect(backendProfileFromAssistantProfile(openrouter)).toMatchObject({
        type: 'api-key',
        provider: 'openai-compatible',
      })
    })
  })

  describe('validateBackendProfilesPatch', () => {
    it('accepts a valid set and preserves a write-only key when apiKey is omitted', () => {
      const result = validateBackendProfilesPatch(
        [{ id: 'be-anthropic', name: 'Renamed', type: 'api-key', provider: 'anthropic' }],
        [apiKeyBackend],
      )
      expect('error' in result).toBe(false)
      if ('error' in result) {
        return
      }
      expect(result.backendProfiles?.[0].apiKey).toBe('sk-backend-secret') // preserved by id
      expect(result.backendProfiles?.[0].name).toBe('Renamed')
    })

    it('sets a new key and clears it with apiKey null', () => {
      const set = validateBackendProfilesPatch(
        [{ id: 'be', name: 'X', type: 'api-key', provider: 'anthropic', apiKey: 'new' }],
        undefined,
      )
      expect('error' in set ? set.error : set.backendProfiles?.[0].apiKey).toBe('new')

      const cleared = validateBackendProfilesPatch(
        [{ id: 'be-anthropic', name: 'X', type: 'api-key', provider: 'anthropic', apiKey: null }],
        [apiKeyBackend],
      )
      expect('error' in cleared ? 'err' : cleared.backendProfiles?.[0].apiKey).toBeUndefined()
    })

    it('requires a subscriptionId for subscription backends', () => {
      const bad = validateBackendProfilesPatch([{ id: 'be', name: 'X', type: 'subscription' }], undefined)
      expect('error' in bad).toBe(true)
      const ok = validateBackendProfilesPatch(
        [{ id: 'be', name: 'X', type: 'subscription', subscriptionId: 's1' }],
        undefined,
      )
      expect('error' in ok ? ok.error : ok.backendProfiles?.[0].subscriptionId).toBe('s1')
    })

    it('rejects invalid types, providers, bad URLs, duplicates; clears with null', () => {
      expect('error' in validateBackendProfilesPatch([{ id: 'a', name: 'a', type: 'nope' }], undefined)).toBe(true)
      expect(
        'error' in validateBackendProfilesPatch([{ id: 'a', name: 'a', type: 'api-key', provider: 'bad' }], undefined),
      ).toBe(true)
      expect(
        'error' in
          validateBackendProfilesPatch(
            [{ id: 'a', name: 'a', type: 'api-key', provider: 'anthropic', baseUrl: 'ftp://x' }],
            undefined,
          ),
      ).toBe(true)
      expect(
        'error' in
          validateBackendProfilesPatch(
            [
              { id: 'dup', name: 'a', type: 'api-key', provider: 'anthropic' },
              { id: 'dup', name: 'b', type: 'api-key', provider: 'anthropic' },
            ],
            undefined,
          ),
      ).toBe(true)
      expect(validateBackendProfilesPatch(null, [apiKeyBackend])).toEqual({ backendProfiles: null })
    })
  })
})

describe('assistant-profile assignments', () => {
  const profiles: PersistedAiProfile[] = [
    { id: 'user-p', name: 'User', provider: 'anthropic', enabled: true },
    { id: 'role-p', name: 'Role', provider: 'anthropic', enabled: true },
    { id: 'default-p', name: 'Default', provider: 'anthropic', enabled: true },
    { id: 'disabled-p', name: 'Disabled', provider: 'anthropic', enabled: false },
  ]

  describe('resolveAssignedProfileId precedence (USER > ROLE > default)', () => {
    const assignments = {
      users: { 'uuid-1': 'user-p', 'me@example.test': 'user-p' },
      roles: { CORE_USER: 'role-p' },
    }

    it('USER assignment wins over role and default', () => {
      expect(resolveAssignedProfileId(assignments, 'default-p', ['uuid-1'], ['CORE_USER'], profiles)).toBe('user-p')
    })

    it('matches a user assignment by email (case-insensitive)', () => {
      expect(resolveAssignedProfileId(assignments, 'default-p', ['ME@EXAMPLE.TEST'], [], profiles)).toBe('user-p')
    })

    it('ROLE assignment wins over the default when no user assignment matches', () => {
      expect(resolveAssignedProfileId(assignments, 'default-p', ['uuid-2'], ['CORE_USER'], profiles)).toBe('role-p')
    })

    it('falls back to the server default when nothing matches', () => {
      expect(resolveAssignedProfileId(assignments, 'default-p', ['uuid-2'], ['PRO_USER'], profiles)).toBe('default-p')
    })

    it('ignores a stale assignment pointing at a removed/disabled profile', () => {
      const stale = { users: { 'uuid-1': 'gone' }, roles: { CORE_USER: 'disabled-p' } }
      expect(resolveAssignedProfileId(stale, 'default-p', ['uuid-1'], ['CORE_USER'], profiles)).toBe('default-p')
    })

    it('returns the default when there are no assignments', () => {
      expect(resolveAssignedProfileId(undefined, 'default-p', ['uuid-1'], ['CORE_USER'], profiles)).toBe('default-p')
    })
  })

  describe('validateAssignmentsPatch', () => {
    it('accepts users + canonical roles and lowercases user keys', () => {
      const result = validateAssignmentsPatch({ users: { 'UUID-1': 'p1' }, roles: { ADMIN_USER: 'p2' } })
      expect('error' in result ? result.error : result.assignments).toEqual({
        users: { 'uuid-1': 'p1' },
        roles: { ADMIN_USER: 'p2' },
      })
    })

    it('rejects unknown roles and empty profile ids; clears with null', () => {
      expect('error' in validateAssignmentsPatch({ roles: { NOT_A_ROLE: 'p' } })).toBe(true)
      expect('error' in validateAssignmentsPatch({ users: { u: '' } })).toBe(true)
      expect(validateAssignmentsPatch(null)).toEqual({ assignments: null })
    })
  })
})
