import {
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
  })

  it('preserves provider-specific API roots', () => {
    expect(openAICompatibleEndpointURL('https://openrouter.ai/api/v1/', 'models')).toBe(
      'https://openrouter.ai/api/v1/models',
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
