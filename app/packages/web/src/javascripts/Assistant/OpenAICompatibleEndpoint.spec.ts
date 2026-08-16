import {
  discoverableOpenAICompatibleModelIds,
  directEndpointConfigurationError,
  normalizeOpenAICompatibleBaseURL,
  openAICompatibleEndpointURL,
} from './OpenAICompatibleEndpoint'

describe('OpenAI-compatible endpoint normalization', () => {
  it('adds the conventional /v1 root to a bare LM Studio host', () => {
    expect(normalizeOpenAICompatibleBaseURL(' http://localhost:1234 ')).toBe('http://localhost:1234/v1')
    expect(openAICompatibleEndpointURL('http://localhost:1234', 'chat/completions')).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
  })

  it('does not duplicate a full Chat Completions route pasted as the base URL', () => {
    expect(openAICompatibleEndpointURL('http://localhost:1234/v1/chat/completions/', 'chat/completions')).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
    expect(openAICompatibleEndpointURL('https://root-api.example.test/chat/completions', 'chat/completions')).toBe(
      'https://root-api.example.test/chat/completions',
    )
  })

  it('preserves provider-specific API roots', () => {
    expect(openAICompatibleEndpointURL('https://openrouter.ai/api/v1/', 'models')).toBe(
      'https://openrouter.ai/api/v1/models',
    )
  })

  it('allows cleartext only for the two loopback hosts admitted by the browser CSP', () => {
    expect(normalizeOpenAICompatibleBaseURL('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1')
    for (const endpoint of [
      'http://[::1]:1234/v1',
      'http://192.168.1.50:11434/v1',
      'http://assistant.example.test/v1',
    ]) {
      expect(() => normalizeOpenAICompatibleBaseURL(endpoint)).toThrow(
        'Plain HTTP assistant URLs are allowed only on http://localhost or http://127.0.0.1',
      )
    }
    expect(normalizeOpenAICompatibleBaseURL('https://assistant.example.test/v1')).toBe(
      'https://assistant.example.test/v1',
    )
  })

  it('rejects credentials and query strings in the URL', () => {
    expect(() => normalizeOpenAICompatibleBaseURL('https://user:secret@example.test/v1')).toThrow(
      'Put credentials in the API key field',
    )
    expect(() => normalizeOpenAICompatibleBaseURL('https://example.test/v1?token=secret')).toThrow(
      'cannot contain a query string',
    )
  })

  it('recognizes the app origin as a proxy/direct-mode mix-up', () => {
    expect(directEndpointConfigurationError(`${window.location.origin}/v1`)).toContain('Standard Red Notes web address')
    expect(directEndpointConfigurationError(`${window.location.origin}/llm/v1`)).toBeUndefined()
  })
})

describe('OpenAI-compatible direct model discovery', () => {
  it('does not advertise explicit non-tool models while retaining absent or malformed metadata', () => {
    expect(
      discoverableOpenAICompatibleModelIds({
        data: [
          { id: 'tool-model', supported_parameters: ['temperature', 'tools'] },
          { id: 'no-tool-model', supported_parameters: ['temperature'] },
          { id: 'empty-capabilities', supported_parameters: [] },
          { id: 'metadata-absent' },
          { id: 'metadata-null', supported_parameters: null },
          { id: 'metadata-malformed', supported_parameters: ['tools', 7] },
          { id: 42, supported_parameters: ['tools'] },
        ],
      }),
    ).toEqual(['tool-model', 'metadata-absent', 'metadata-null', 'metadata-malformed'])
  })

  it.each([null, [], {}, { data: null }, { data: 'not-an-array' }])(
    'fails closed on malformed payload %p',
    (payload) => {
      expect(discoverableOpenAICompatibleModelIds(payload)).toEqual([])
    },
  )
})
