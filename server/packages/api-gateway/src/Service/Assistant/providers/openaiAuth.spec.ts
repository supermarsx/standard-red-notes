import { AssistantProviderConfig } from './factory'
import {
  DEFAULT_CODEX_SUBSCRIPTION_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  openAiCompatibleConfigured,
  parseExtraHeaders,
  resolveOpenAiUpstream,
} from './openaiAuth'

describe('resolveOpenAiUpstream', () => {
  describe('api-key mode (default)', () => {
    it('defaults to OpenAI base URL and the configured API key', () => {
      const config: AssistantProviderConfig = { openaiApiKey: 'sk-test' }
      const upstream = resolveOpenAiUpstream(config)

      expect(upstream.mode).toBe('api-key')
      expect(upstream.baseURL).toBe(DEFAULT_OPENAI_BASE_URL)
      expect(upstream.apiKey).toBe('sk-test')
      expect(upstream.defaultHeaders).toEqual({})
    })

    it('honors an explicit base URL (LM Studio / custom) without a key', () => {
      const config: AssistantProviderConfig = { openaiBaseURL: 'http://localhost:1234/v1' }
      const upstream = resolveOpenAiUpstream(config)

      expect(upstream.baseURL).toBe('http://localhost:1234/v1')
      // Placeholder key so the SDK does not reject local servers.
      expect(upstream.apiKey).toBe('not-required')
    })

    it('treats an explicit api-key mode the same as the default', () => {
      const config: AssistantProviderConfig = { openaiAuthMode: 'api-key', openaiApiKey: 'sk-x' }
      expect(resolveOpenAiUpstream(config).mode).toBe('api-key')
      expect(resolveOpenAiUpstream(config).apiKey).toBe('sk-x')
    })

    it('does not use the subscription token in api-key mode', () => {
      const config: AssistantProviderConfig = {
        openaiApiKey: 'sk-real',
        openaiSubscriptionToken: 'sub-token-should-be-ignored',
      }
      expect(resolveOpenAiUpstream(config).apiKey).toBe('sk-real')
    })
  })

  describe('subscription mode (Codex / ChatGPT)', () => {
    it('uses the subscription token as the bearer and the Codex default base URL', () => {
      const config: AssistantProviderConfig = {
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 'chatgpt-access-token',
      }
      const upstream = resolveOpenAiUpstream(config)

      expect(upstream.mode).toBe('subscription')
      expect(upstream.baseURL).toBe(DEFAULT_CODEX_SUBSCRIPTION_BASE_URL)
      expect(upstream.apiKey).toBe('chatgpt-access-token')
    })

    it('does NOT fall back to the API key when the subscription token is missing', () => {
      const config: AssistantProviderConfig = {
        openaiAuthMode: 'subscription',
        openaiApiKey: 'sk-should-not-leak',
      }
      const upstream = resolveOpenAiUpstream(config)

      expect(upstream.apiKey).not.toBe('sk-should-not-leak')
      expect(upstream.apiKey).toBe('missing-subscription-token')
    })

    it('prefers an explicit subscription base URL over the default', () => {
      const config: AssistantProviderConfig = {
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 't',
        openaiSubscriptionBaseURL: 'https://example.test/codex',
      }
      expect(resolveOpenAiUpstream(config).baseURL).toBe('https://example.test/codex')
    })

    it('adds account-id and OpenAI-Beta headers when configured', () => {
      const config: AssistantProviderConfig = {
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 't',
        openaiAccountId: 'acct-123',
        openaiBeta: 'responses=v1',
      }
      const upstream = resolveOpenAiUpstream(config)

      expect(upstream.defaultHeaders['ChatGPT-Account-Id']).toBe('acct-123')
      expect(upstream.defaultHeaders['OpenAI-Beta']).toBe('responses=v1')
    })

    it('merges custom extra headers', () => {
      const config: AssistantProviderConfig = {
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 't',
        openaiExtraHeaders: '{"X-Custom":"y"}',
      }
      expect(resolveOpenAiUpstream(config).defaultHeaders['X-Custom']).toBe('y')
    })
  })
})

describe('parseExtraHeaders', () => {
  it('returns empty for undefined / blank', () => {
    expect(parseExtraHeaders(undefined)).toEqual({})
    expect(parseExtraHeaders('   ')).toEqual({})
  })

  it('parses a JSON object', () => {
    expect(parseExtraHeaders('{"A":"1","B":2}')).toEqual({ A: '1', B: '2' })
  })

  it('parses a comma-separated Key: Value list', () => {
    expect(parseExtraHeaders('X-One: a, X-Two:  b ')).toEqual({ 'X-One': 'a', 'X-Two': 'b' })
  })

  it('never throws on malformed input', () => {
    expect(parseExtraHeaders('{not json')).toEqual({})
    expect(parseExtraHeaders('no-colon-here')).toEqual({})
  })
})

describe('openAiCompatibleConfigured', () => {
  it('is true in api-key mode when a key or base URL is present', () => {
    expect(openAiCompatibleConfigured({ openaiApiKey: 'k' })).toBe(true)
    expect(openAiCompatibleConfigured({ openaiBaseURL: 'http://x/v1' })).toBe(true)
    expect(openAiCompatibleConfigured({})).toBe(false)
  })

  it('is true in subscription mode when a token or base URL is present', () => {
    expect(openAiCompatibleConfigured({ openaiAuthMode: 'subscription', openaiSubscriptionToken: 't' })).toBe(true)
    expect(
      openAiCompatibleConfigured({ openaiAuthMode: 'subscription', openaiSubscriptionBaseURL: 'https://x' }),
    ).toBe(true)
    expect(openAiCompatibleConfigured({ openaiAuthMode: 'subscription' })).toBe(false)
  })
})
