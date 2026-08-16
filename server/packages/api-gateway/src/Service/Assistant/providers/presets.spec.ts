import {
  configuredPresetIds,
  getPreset,
  listPresetModels,
  OPENAI_COMPATIBLE_PRESETS,
  resolvePresetUpstream,
} from './presets'

describe('OPENAI_COMPATIBLE_PRESETS', () => {
  it('covers every documented preset id', () => {
    const ids = Object.keys(OPENAI_COMPATIBLE_PRESETS)
    expect(ids).toEqual(
      expect.arrayContaining([
        'openai',
        'groq',
        'together',
        'openrouter',
        'deepseek',
        'mistral',
        'perplexity',
        'xai',
        'fireworks',
        'google-openai',
        'azure-openai',
        'lmstudio',
        'ollama-openai',
        'custom',
      ]),
    )
  })

  it('keys each preset by its own id', () => {
    for (const [key, preset] of Object.entries(OPENAI_COMPATIBLE_PRESETS)) {
      expect(preset.id).toBe(key)
    }
  })
})

describe('getPreset', () => {
  it('returns a known preset and undefined otherwise', () => {
    expect(getPreset('groq')?.label).toBe('Groq')
    expect(getPreset('nope')).toBeUndefined()
  })
})

describe('resolvePresetUpstream', () => {
  it('resolves the default base URL and bearer auth with no env', () => {
    const upstream = resolvePresetUpstream('groq', {})
    expect(upstream).not.toBeNull()
    expect(upstream?.baseURL).toBe('https://api.groq.com/openai/v1')
    expect(upstream?.authHeader).toBe('bearer')
    expect(upstream?.modelsPath).toBe('/models')
    expect(upstream?.apiKey).toBe('')
  })

  it('applies the ASSISTANT_PRESET_<ID>_API_KEY override', () => {
    const upstream = resolvePresetUpstream('groq', { ASSISTANT_PRESET_GROQ_API_KEY: 'gk-1' })
    expect(upstream?.apiKey).toBe('gk-1')
  })

  it('applies the ASSISTANT_PRESET_<ID>_BASE_URL override', () => {
    const upstream = resolvePresetUpstream('openrouter', {
      ASSISTANT_PRESET_OPENROUTER_BASE_URL: 'https://proxy.internal/v1',
    })
    expect(upstream?.baseURL).toBe('https://proxy.internal/v1')
  })

  it('maps non-alphanumeric chars in the id to `_` for env keys', () => {
    const upstream = resolvePresetUpstream('google-openai', {
      ASSISTANT_PRESET_GOOGLE_OPENAI_API_KEY: 'goog-key',
    })
    expect(upstream?.apiKey).toBe('goog-key')
    expect(upstream?.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
  })

  it('falls back to ASSISTANT_OPENAI_API_KEY for the openai preset', () => {
    const upstream = resolvePresetUpstream('openai', { ASSISTANT_OPENAI_API_KEY: 'sk-generic' })
    expect(upstream?.apiKey).toBe('sk-generic')
  })

  it('prefers the preset-specific key over the generic openai fallback', () => {
    const upstream = resolvePresetUpstream('openai', {
      ASSISTANT_PRESET_OPENAI_API_KEY: 'sk-specific',
      ASSISTANT_OPENAI_API_KEY: 'sk-generic',
    })
    expect(upstream?.apiKey).toBe('sk-specific')
  })

  it('returns null for azure when no base URL is configured', () => {
    expect(resolvePresetUpstream('azure-openai', {})).toBeNull()
  })

  it('returns null for custom when no base URL is configured', () => {
    expect(resolvePresetUpstream('custom', {})).toBeNull()
  })

  it('returns null for an unknown preset id', () => {
    expect(resolvePresetUpstream('does-not-exist', {})).toBeNull()
  })

  it('applies the azure api-key header + api-version query quirk', () => {
    const upstream = resolvePresetUpstream('azure-openai', {
      ASSISTANT_PRESET_AZURE_OPENAI_BASE_URL: 'https://res.openai.azure.com/openai/deployments/gpt4',
      ASSISTANT_PRESET_AZURE_OPENAI_API_KEY: 'az-key',
      ASSISTANT_PRESET_AZURE_OPENAI_API_VERSION: '2024-08-01-preview',
    })
    expect(upstream?.authHeader).toBe('api-key')
    expect(upstream?.baseURL).toBe('https://res.openai.azure.com/openai/deployments/gpt4')
    expect(upstream?.modelsPath).toBe('/openai/deployments?api-version=2024-08-01-preview')
  })

  it('uses the default azure api-version when none is set', () => {
    const upstream = resolvePresetUpstream('azure-openai', {
      ASSISTANT_PRESET_AZURE_OPENAI_BASE_URL: 'https://res.openai.azure.com/openai/deployments/gpt4',
    })
    expect(upstream?.modelsPath).toContain('?api-version=')
  })
})

describe('configuredPresetIds', () => {
  it('includes keyless local presets even with no env', () => {
    const ids = configuredPresetIds({})
    expect(ids).toContain('lmstudio')
    expect(ids).toContain('ollama-openai')
  })

  it('excludes a key-required preset that has no key', () => {
    const ids = configuredPresetIds({})
    expect(ids).not.toContain('groq')
  })

  it('includes a key-required preset once its key is set', () => {
    const ids = configuredPresetIds({ ASSISTANT_PRESET_GROQ_API_KEY: 'gk' })
    expect(ids).toContain('groq')
  })

  it('includes a preset whose base URL is explicitly set via env even without a key', () => {
    const ids = configuredPresetIds({ ASSISTANT_PRESET_CUSTOM_BASE_URL: 'https://x/v1' })
    expect(ids).toContain('custom')
  })

  it('excludes azure when no base URL is configured', () => {
    expect(configuredPresetIds({})).not.toContain('azure-openai')
  })

  it('never includes a key value in the returned ids', () => {
    const ids = configuredPresetIds({ ASSISTANT_PRESET_GROQ_API_KEY: 'super-secret-key' })
    expect(ids.join(' ')).not.toContain('super-secret-key')
  })
})

describe('listPresetModels', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  it('parses the { data: [{ id }] } shape', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'llama-3.1-70b' }, { id: 'mixtral-8x7b' }] }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const models = await listPresetModels('groq', { ASSISTANT_PRESET_GROQ_API_KEY: 'gk' })
    expect(models).toEqual(['llama-3.1-70b', 'mixtral-8x7b'])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/models')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer gk')
  })

  it('filters only explicit non-tool OpenRouter entries and preserves unknown metadata compatibility', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'tool-model', supported_parameters: ['tools', 'temperature'] },
          { id: 'no-tool-model', supported_parameters: ['temperature'] },
          { id: 'empty-capabilities', supported_parameters: [] },
          { id: 'metadata-absent' },
          { id: 'metadata-malformed', supported_parameters: 'tools' },
        ],
      }),
    }) as unknown as typeof fetch

    await expect(
      listPresetModels('openrouter', { ASSISTANT_PRESET_OPENROUTER_API_KEY: 'openrouter-key' }),
    ).resolves.toEqual(['tool-model', 'metadata-absent', 'metadata-malformed'])
  })

  it('parses azure deployments via the api-key header + api-version path', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 'gpt-4o' }] }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const models = await listPresetModels('azure-openai', {
      ASSISTANT_PRESET_AZURE_OPENAI_BASE_URL: 'https://res.openai.azure.com',
      ASSISTANT_PRESET_AZURE_OPENAI_API_KEY: 'az-key',
      ASSISTANT_PRESET_AZURE_OPENAI_API_VERSION: '2024-08-01-preview',
    })
    expect(models).toEqual(['gpt-4o'])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://res.openai.azure.com/openai/deployments?api-version=2024-08-01-preview')
    const headers = init.headers as Record<string, string>
    expect(headers['api-key']).toBe('az-key')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('returns [] when the upstream responds !ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch
    expect(await listPresetModels('groq', { ASSISTANT_PRESET_GROQ_API_KEY: 'gk' })).toEqual([])
  })

  it('returns [] when fetch throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    expect(await listPresetModels('groq', { ASSISTANT_PRESET_GROQ_API_KEY: 'gk' })).toEqual([])
  })

  it('returns [] for an unconfigured preset (null upstream)', async () => {
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    expect(await listPresetModels('azure-openai', {})).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never returns the key in the model list', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }] }),
    }) as unknown as typeof fetch

    const models = await listPresetModels('groq', { ASSISTANT_PRESET_GROQ_API_KEY: 'super-secret-key' })
    expect(models.join(' ')).not.toContain('super-secret-key')
  })
})
