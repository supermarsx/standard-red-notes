import { AssistantProviderConfig, listProviderModels, resolveProvider } from './factory'
import {
  DEFAULT_CODEX_SUBSCRIPTION_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  openAiCompatibleConfigured,
  parseExtraHeaders,
  resolveOpenAiUpstream,
  safeSubscriptionBaseUrl,
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

    it('fails closed without a real token and never substitutes an API key or placeholder', () => {
      const config: AssistantProviderConfig = {
        openaiAuthMode: 'subscription',
        openaiApiKey: 'sk-should-not-leak',
      }
      expect(() => resolveOpenAiUpstream(config)).toThrow(/credential is unavailable/)
      expect(() => resolveProvider('openai', 'model', config)).toThrow(/not configured/)
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

    it('preserves exact control-free opaque bearer bytes without trimming', () => {
      const token = '  opaque-token-with-intentional-spaces  '
      expect(
        resolveOpenAiUpstream({
          openaiAuthMode: 'subscription',
          openaiSubscriptionToken: token,
        }).apiKey,
      ).toBe(token)
    })

    it.each([
      'https://user:pass@example.test/codex',
      'https://example.test/codex?token=in-query',
      'https://example.test/codex?',
      'https://example.test/codex#fragment',
      'https://example.test/codex#',
      'http://example.test/codex',
      'javascript:alert(1)',
      ' https://example.test/codex',
      'https://example.test/codex ',
      'https://example.test/\tcodex',
      String.raw`https:\\example.test\codex`,
      String.raw`https://trusted.test\@evil.test/codex`,
      'https://trusted.test@evil.test/codex',
      'https://example.test/codex\u202e',
    ])('rejects unsafe subscription credential destinations: %s', (baseURL) => {
      const config: AssistantProviderConfig = {
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 'token',
        openaiSubscriptionBaseURL: baseURL,
      }
      expect(openAiCompatibleConfigured(config)).toBe(false)
      expect(() => resolveOpenAiUpstream(config)).toThrow(/endpoint is unsafe/)
    })

    it('allows only explicit loopback hosts for cleartext subscription development', () => {
      for (const baseURL of ['http://localhost:1455/codex', 'http://127.0.0.1:1455/codex', 'http://[::1]:1455/codex']) {
        expect(safeSubscriptionBaseUrl(baseURL)).not.toBeNull()
      }
      expect(safeSubscriptionBaseUrl('http://127.0.0.2:1455/codex')).toBeNull()
      for (const baseURL of [
        'http://2130706433:1455/codex',
        'http://0x7f000001:1455/codex',
        'http://0177.0.0.1:1455/codex',
        'http://0x7f.0.0.1:1455/codex',
        'http://127.1:1455/codex',
        'http://127.0.1:1455/codex',
      ]) {
        expect(safeSubscriptionBaseUrl(baseURL)).toBeNull()
      }
    })

    it('rejects blank/control-bearing bearers and header values', () => {
      expect(openAiCompatibleConfigured({ openaiAuthMode: 'subscription', openaiSubscriptionToken: '   ' })).toBe(false)
      expect(
        openAiCompatibleConfigured({ openaiAuthMode: 'subscription', openaiSubscriptionToken: 'token\r\nbad' }),
      ).toBe(false)
      expect(() =>
        resolveOpenAiUpstream({
          openaiAuthMode: 'subscription',
          openaiSubscriptionToken: 'token',
          openaiAccountId: 'acct\r\nInjected: yes',
        }),
      ).toThrow(/account id/)
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

  it('drops invalid/control-bearing header names and values', () => {
    expect(parseExtraHeaders('{"Good":"yes","Bad\\r\\nName":"x","X-Control":"a\\r\\nb"}')).toEqual({
      Good: 'yes',
    })
  })
})

describe('openAiCompatibleConfigured', () => {
  it('is true in api-key mode when a key or base URL is present', () => {
    expect(openAiCompatibleConfigured({ openaiApiKey: 'k' })).toBe(true)
    expect(openAiCompatibleConfigured({ openaiBaseURL: 'http://x/v1' })).toBe(true)
    expect(openAiCompatibleConfigured({})).toBe(false)
  })

  it('is true in subscription mode only when a real token and safe endpoint are available', () => {
    expect(openAiCompatibleConfigured({ openaiAuthMode: 'subscription', openaiSubscriptionToken: 't' })).toBe(true)
    expect(openAiCompatibleConfigured({ openaiAuthMode: 'subscription', openaiSubscriptionBaseURL: 'https://x' })).toBe(
      false,
    )
    expect(openAiCompatibleConfigured({ openaiAuthMode: 'subscription' })).toBe(false)
  })
})

describe('subscription fail-closed network boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    {
      name: 'missing pairing credential',
      config: { openaiAuthMode: 'subscription', openaiSubscriptionBaseURL: 'https://example.test/codex' },
    },
    {
      name: 'unsafe cleartext remote endpoint',
      config: {
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 'token',
        openaiSubscriptionBaseURL: 'http://example.test/codex',
      },
    },
    {
      name: 'query-bearing endpoint',
      config: {
        openaiAuthMode: 'subscription',
        openaiSubscriptionToken: 'token',
        openaiSubscriptionBaseURL: 'https://example.test/codex?userinfo=secret',
      },
    },
  ])('performs zero model-discovery fetches for $name', async ({ config }) => {
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(listProviderModels('openai', config as AssistantProviderConfig)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
