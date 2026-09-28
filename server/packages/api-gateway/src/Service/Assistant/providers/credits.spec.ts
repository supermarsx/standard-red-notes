import {
  CREDITS_TIMEOUT_MS,
  creditsEndpointUrl,
  creditsFailureReasonForStatus,
  creditsProviderLabel,
  fetchProviderCredits,
  parseDeepSeekBalancePayload,
  parseOpenRouterKeyPayload,
  supportsCreditsLookup,
} from './credits'

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}): Response =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response

describe('creditsProviderLabel', () => {
  it('names the provider behind an openai-compatible base URL', () => {
    expect(creditsProviderLabel('openai-compatible', 'https://openrouter.ai/api/v1')).toBe('OpenRouter')
    expect(creditsProviderLabel('openai-compatible', 'https://api.deepseek.com/v1')).toBe('DeepSeek')
    expect(creditsProviderLabel('openai-compatible', 'https://api.groq.com/openai/v1')).toBe('Groq')
    expect(creditsProviderLabel('openai-compatible', 'https://api.x.ai/v1')).toBe('xAI (Grok)')
  })

  it('names the non-openai-compatible kinds', () => {
    expect(creditsProviderLabel('anthropic')).toBe('Anthropic')
    expect(creditsProviderLabel('ollama', 'http://localhost:11434')).toBe('Ollama')
    expect(creditsProviderLabel('codex-subscription')).toBe('ChatGPT / Codex subscription')
  })

  it('defaults an openai-compatible profile with no base URL to OpenAI', () => {
    expect(creditsProviderLabel('openai-compatible')).toBe('OpenAI')
    expect(creditsProviderLabel('openai-compatible', '   ')).toBe('OpenAI')
  })

  it('calls a loopback endpoint a local server and falls back to the bare hostname', () => {
    expect(creditsProviderLabel('openai-compatible', 'http://localhost:1234/v1')).toBe('Local server')
    expect(creditsProviderLabel('openai-compatible', 'https://llm.internal.example/v1')).toBe('llm.internal.example')
  })

  it('does not throw on an unparseable base URL', () => {
    expect(creditsProviderLabel('openai-compatible', 'not a url')).toBe('OpenAI')
  })
})

describe('supportsCreditsLookup', () => {
  it('supports exactly the two providers with a key-readable balance', () => {
    expect(supportsCreditsLookup('openai-compatible', 'https://openrouter.ai/api/v1')).toBe(true)
    expect(supportsCreditsLookup('openai-compatible', 'https://api.deepseek.com/v1')).toBe(true)
  })

  it('reports every other documented provider as unsupported', () => {
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'https://api.groq.com/openai/v1',
      'https://api.together.xyz/v1',
      'https://api.mistral.ai/v1',
      'https://api.perplexity.ai',
      'https://api.x.ai/v1',
      'https://api.fireworks.ai/inference/v1',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'http://localhost:1234/v1',
    ]) {
      expect(supportsCreditsLookup('openai-compatible', baseUrl)).toBe(false)
    }
  })

  it('never supports a non-openai-compatible kind, even on a matching host', () => {
    expect(supportsCreditsLookup('anthropic', 'https://openrouter.ai/api/v1')).toBe(false)
    expect(supportsCreditsLookup('ollama', 'https://api.deepseek.com/v1')).toBe(false)
    expect(supportsCreditsLookup('codex-subscription', 'https://openrouter.ai/api/v1')).toBe(false)
  })
})

describe('creditsEndpointUrl', () => {
  it('builds the OpenRouter key URL from the origin', () => {
    expect(creditsEndpointUrl('openai-compatible', 'https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1/key',
    )
  })

  // The regression this guards: DeepSeek's balance route is at the ROOT while
  // its base URL ends in /v1. Appending to the base URL yields a 404.
  it('puts the DeepSeek balance at the root, not under the base URL version path', () => {
    expect(creditsEndpointUrl('openai-compatible', 'https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/user/balance',
    )
    expect(creditsEndpointUrl('openai-compatible', 'https://api.deepseek.com/v1')).not.toContain('/v1/user/balance')
  })

  it('returns null for an unsupported provider', () => {
    expect(creditsEndpointUrl('openai-compatible', 'https://api.openai.com/v1')).toBeNull()
    expect(creditsEndpointUrl('anthropic')).toBeNull()
  })
})

describe('parseOpenRouterKeyPayload', () => {
  it('extracts the remaining credit and usage', () => {
    expect(parseOpenRouterKeyPayload({ data: { limit: 20, limit_remaining: 12.5, usage: 7.5 } })).toEqual({
      remaining: 12.5,
      usage: 7.5,
      currency: 'USD',
    })
  })

  // Telling someone with an uncapped key that they have 0 credit is the exact
  // wrong-claim failure this distinction prevents.
  it('treats a null limit_remaining as "no cap set", never as a zero balance', () => {
    const parsed = parseOpenRouterKeyPayload({ data: { limit: null, limit_remaining: null, usage: 3.25 } })
    expect(parsed).not.toBeNull()
    expect(parsed?.remaining).toBeNull()
    expect(parsed?.remaining).not.toBe(0)
    expect(parsed?.usage).toBe(3.25)
    expect(parsed?.note).toMatch(/no credit limit set/i)
  })

  it('drops every field outside the allowlist, including the key label', () => {
    const parsed = parseOpenRouterKeyPayload({
      data: {
        label: 'my-production-key',
        limit_remaining: 5,
        usage: 1,
        is_free_tier: false,
        some_future_secret: 'must-not-appear',
      },
    })
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['currency', 'remaining', 'usage'])
    expect(JSON.stringify(parsed)).not.toContain('my-production-key')
    expect(JSON.stringify(parsed)).not.toContain('must-not-appear')
  })

  it('rejects a shape with no numeric fields at all', () => {
    expect(parseOpenRouterKeyPayload({ data: { label: 'x' } })).toBeNull()
    expect(parseOpenRouterKeyPayload({})).toBeNull()
    expect(parseOpenRouterKeyPayload(null)).toBeNull()
    expect(parseOpenRouterKeyPayload([1, 2])).toBeNull()
    expect(parseOpenRouterKeyPayload('nope')).toBeNull()
  })

  it('ignores non-finite numbers', () => {
    expect(
      parseOpenRouterKeyPayload({ data: { limit_remaining: Number.NaN, usage: Number.POSITIVE_INFINITY } }),
    ).toBeNull()
  })
})

describe('parseDeepSeekBalancePayload', () => {
  it('parses the documented response, whose amounts are strings', () => {
    expect(
      parseDeepSeekBalancePayload({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        ],
      }),
    ).toEqual({ remaining: 110, usage: null, currency: 'CNY' })
  })

  it('notes an insufficient balance without failing the lookup', () => {
    const parsed = parseDeepSeekBalancePayload({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: '0.00' }],
    })
    expect(parsed?.remaining).toBe(0)
    expect(parsed?.note).toMatch(/insufficient/i)
  })

  it('rejects a currency that is not a three-letter code rather than passing it through', () => {
    const parsed = parseDeepSeekBalancePayload({
      is_available: true,
      balance_infos: [{ currency: '<script>alert(1)</script>', total_balance: '5.00' }],
    })
    expect(parsed?.currency).toBe('USD')
  })

  it('drops fields outside the allowlist', () => {
    const parsed = parseDeepSeekBalancePayload({
      is_available: true,
      account_email: 'someone@example.com',
      balance_infos: [{ currency: 'USD', total_balance: '5.00', granted_balance: '1.00' }],
    })
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['currency', 'remaining', 'usage'])
    expect(JSON.stringify(parsed)).not.toContain('someone@example.com')
  })

  it('rejects malformed shapes', () => {
    expect(parseDeepSeekBalancePayload({ is_available: true, balance_infos: [] })).toBeNull()
    expect(parseDeepSeekBalancePayload({ is_available: true, balance_infos: [{ total_balance: 'abc' }] })).toBeNull()
    expect(parseDeepSeekBalancePayload({ balance_infos: 'nope' })).toBeNull()
    expect(parseDeepSeekBalancePayload(null)).toBeNull()
  })
})

describe('creditsFailureReasonForStatus', () => {
  it('maps auth, throttling and everything else to distinct reasons', () => {
    expect(creditsFailureReasonForStatus(401)).toBe('unauthorized')
    expect(creditsFailureReasonForStatus(403)).toBe('unauthorized')
    expect(creditsFailureReasonForStatus(429)).toBe('rate-limited')
    expect(creditsFailureReasonForStatus(500)).toBe('unreadable')
    expect(creditsFailureReasonForStatus(404)).toBe('unreadable')
  })
})

describe('fetchProviderCredits', () => {
  const now = () => new Date('2026-09-28T12:00:00.000Z')

  it('returns unsupported, naming the provider, without any network call', async () => {
    const fetchImpl = jest.fn()
    const result = await fetchProviderCredits(
      { kind: 'anthropic', apiKey: 'sk-ant-secret' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    )
    expect(result).toEqual({ status: 'unsupported', provider: 'Anthropic' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns not-configured when the profile holds no key, without any network call', async () => {
    const fetchImpl = jest.fn()
    const result = await fetchProviderCredits(
      { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '  ' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    )
    expect(result).toEqual({ status: 'not-configured', provider: 'OpenRouter' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends the key as a bearer and returns only the allowlisted figures', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ data: { label: 'prod-key', limit_remaining: 4.5, usage: 5.5 } }))
    const result = await fetchProviderCredits(
      { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-secret' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    )

    expect(result).toEqual({
      status: 'ok',
      provider: 'OpenRouter',
      remaining: 4.5,
      usage: 5.5,
      currency: 'USD',
      fetchedAt: '2026-09-28T12:00:00.000Z',
    })
    expect(JSON.stringify(result)).not.toContain('sk-or-v1-secret')
    expect(JSON.stringify(result)).not.toContain('prod-key')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-or-v1-secret' })
    expect((init as RequestInit).signal).toBeDefined()
  })

  it('reaches DeepSeek at the root balance path', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] }),
      )
    const result = await fetchProviderCredits(
      { kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    )

    expect(result).toMatchObject({ status: 'ok', provider: 'DeepSeek', remaining: 12.34, currency: 'USD' })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/user/balance')
  })

  it('maps an upstream rejection to a specific reason and never leaks the body', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: 'Your api key: ****-000 is invalid' } }, { ok: false, status: 401 }),
      )
    const result = await fetchProviderCredits(
      { kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    )

    expect(result).toEqual({ status: 'unavailable', provider: 'DeepSeek', reason: 'unauthorized' })
    expect(JSON.stringify(result)).not.toContain('****-000')
  })

  it('maps throttling to rate-limited', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 429 }))
    const result = await fetchProviderCredits(
      { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    )
    expect(result).toEqual({ status: 'unavailable', provider: 'OpenRouter', reason: 'rate-limited' })
  })

  it('never throws when the transport fails', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(
      fetchProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, now },
      ),
    ).resolves.toEqual({ status: 'unavailable', provider: 'OpenRouter', reason: 'network' })
  })

  it('distinguishes a timeout from a transport failure', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const fetchImpl = jest.fn().mockRejectedValue(timeout)
    await expect(
      fetchProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, now },
      ),
    ).resolves.toEqual({ status: 'unavailable', provider: 'OpenRouter', reason: 'timeout' })
  })

  it('never throws when the body is not JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    } as unknown as Response)
    await expect(
      fetchProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, now },
      ),
    ).resolves.toEqual({ status: 'unavailable', provider: 'OpenRouter', reason: 'unreadable' })
  })

  it('reports an unexpected payload shape as unreadable rather than ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ unexpected: true }))
    await expect(
      fetchProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, now },
      ),
    ).resolves.toEqual({ status: 'unavailable', provider: 'OpenRouter', reason: 'unreadable' })
  })

  it('bounds the upstream call so a slow provider cannot block the caller', () => {
    expect(CREDITS_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CREDITS_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
  })
})
