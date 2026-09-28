import {
  asCreditsResult,
  CreditsResult,
  creditsEndpointUrl,
  creditsFailureReasonForStatus,
  creditsProviderLabel,
  describeCreditsResult,
  fetchDirectProviderCredits,
  formatCreditsAge,
  formatCreditsAmount,
  parseDeepSeekBalancePayload,
  parseOpenRouterKeyPayload,
  supportsCreditsLookup,
} from './providerCredits'

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}): Response =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response

const NOW = new Date('2026-09-28T12:00:00.000Z')
const now = () => NOW

describe('creditsProviderLabel', () => {
  it('names the provider behind an openai-compatible base URL', () => {
    expect(creditsProviderLabel('openai-compatible', 'https://openrouter.ai/api/v1')).toBe('OpenRouter')
    expect(creditsProviderLabel('openai-compatible', 'https://api.deepseek.com/v1')).toBe('DeepSeek')
    expect(creditsProviderLabel('openai-compatible', 'https://api.openai.com/v1')).toBe('OpenAI')
  })

  it('names the other kinds and falls back sensibly', () => {
    expect(creditsProviderLabel('anthropic')).toBe('Anthropic')
    expect(creditsProviderLabel('codex-subscription')).toBe('ChatGPT / Codex subscription')
    expect(creditsProviderLabel('openai-compatible', 'http://localhost:1234/v1')).toBe('Local server')
    expect(creditsProviderLabel('openai-compatible', 'https://llm.internal.example/v1')).toBe('llm.internal.example')
    expect(creditsProviderLabel('openai-compatible', 'not a url')).toBe('OpenAI')
  })
})

describe('supportsCreditsLookup', () => {
  it('supports exactly OpenRouter and DeepSeek', () => {
    expect(supportsCreditsLookup('openai-compatible', 'https://openrouter.ai/api/v1')).toBe(true)
    expect(supportsCreditsLookup('openai-compatible', 'https://api.deepseek.com/v1')).toBe(true)
  })

  it('reports the rest as unsupported', () => {
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'https://api.groq.com/openai/v1',
      'https://api.mistral.ai/v1',
      'https://api.x.ai/v1',
      'http://localhost:1234/v1',
      '',
    ]) {
      expect(supportsCreditsLookup('openai-compatible', baseUrl)).toBe(false)
    }
    expect(supportsCreditsLookup('anthropic', 'https://openrouter.ai/api/v1')).toBe(false)
    expect(supportsCreditsLookup('codex-subscription', 'https://openrouter.ai/api/v1')).toBe(false)
  })
})

describe('creditsEndpointUrl', () => {
  it('builds each URL from the origin, not the versioned base path', () => {
    expect(creditsEndpointUrl('openai-compatible', 'https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1/key',
    )
    expect(creditsEndpointUrl('openai-compatible', 'https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/user/balance',
    )
  })

  it('tolerates a pasted full endpoint in the preference field', () => {
    expect(creditsEndpointUrl('openai-compatible', 'https://openrouter.ai/api/v1/chat/completions')).toBe(
      'https://openrouter.ai/api/v1/key',
    )
  })

  it('returns null when unsupported', () => {
    expect(creditsEndpointUrl('openai-compatible', 'https://api.openai.com/v1')).toBeNull()
  })
})

describe('payload parsers', () => {
  it('extracts OpenRouter figures and drops the key label', () => {
    const parsed = parseOpenRouterKeyPayload({
      data: { label: 'my-prod-key', limit_remaining: 12.5, usage: 7.5, is_free_tier: false },
    })
    expect(parsed).toEqual({ remaining: 12.5, usage: 7.5, currency: 'USD' })
    expect(JSON.stringify(parsed)).not.toContain('my-prod-key')
  })

  it('treats a null OpenRouter limit_remaining as "no cap", never zero', () => {
    const parsed = parseOpenRouterKeyPayload({ data: { limit_remaining: null, usage: 3 } })
    expect(parsed?.remaining).toBeNull()
    expect(parsed?.remaining).not.toBe(0)
    expect(parsed?.note).toMatch(/no credit limit set/i)
  })

  it('parses DeepSeek string amounts and validates the currency code', () => {
    expect(
      parseDeepSeekBalancePayload({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
      }),
    ).toEqual({ remaining: 110, usage: null, currency: 'CNY' })

    expect(
      parseDeepSeekBalancePayload({ is_available: true, balance_infos: [{ currency: 'oops', total_balance: '1.00' }] })
        ?.currency,
    ).toBe('USD')
  })

  it('rejects malformed payloads instead of inventing a number', () => {
    expect(parseOpenRouterKeyPayload({})).toBeNull()
    expect(parseOpenRouterKeyPayload(null)).toBeNull()
    expect(parseDeepSeekBalancePayload({ balance_infos: [] })).toBeNull()
    expect(parseDeepSeekBalancePayload({ balance_infos: [{ total_balance: 'abc' }] })).toBeNull()
  })
})

describe('creditsFailureReasonForStatus', () => {
  it('separates auth, throttling and everything else', () => {
    expect(creditsFailureReasonForStatus(401)).toBe('unauthorized')
    expect(creditsFailureReasonForStatus(403)).toBe('unauthorized')
    expect(creditsFailureReasonForStatus(429)).toBe('rate-limited')
    expect(creditsFailureReasonForStatus(503)).toBe('unreadable')
  })
})

describe('fetchDirectProviderCredits', () => {
  it('reports unsupported without touching the network', async () => {
    const fetchImpl = jest.fn()
    await expect(
      fetchDirectProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, now },
      ),
    ).resolves.toEqual({ status: 'unsupported', provider: 'OpenAI' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports not-configured without touching the network', async () => {
    const fetchImpl = jest.fn()
    await expect(
      fetchDirectProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, now },
      ),
    ).resolves.toEqual({ status: 'not-configured', provider: 'OpenRouter' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns the balance and keeps the key out of the result', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ data: { limit_remaining: 4.5, usage: 5.5 } }))
    const result = await fetchDirectProviderCredits(
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
    expect(fetchImpl.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/key')
  })

  // A browser-side call can be refused by CORS. That must land on the ordinary
  // network failure, not crash the pane and not grow a provider-specific caveat.
  it('degrades a blocked cross-origin call to the plain network failure', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(
      fetchDirectProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, now },
      ),
    ).resolves.toEqual({ status: 'unavailable', provider: 'DeepSeek', reason: 'network' })
  })

  it('maps rejection, throttling, timeout and bad JSON to distinct reasons', async () => {
    const unauthorized = jest.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 401 }))
    await expect(
      fetchDirectProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: unauthorized as unknown as typeof fetch, now },
      ),
    ).resolves.toMatchObject({ reason: 'unauthorized' })

    const throttled = jest.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 429 }))
    await expect(
      fetchDirectProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: throttled as unknown as typeof fetch, now },
      ),
    ).resolves.toMatchObject({ reason: 'rate-limited' })

    const timedOut = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'TimeoutError' }))
    await expect(
      fetchDirectProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: timedOut as unknown as typeof fetch, now },
      ),
    ).resolves.toMatchObject({ reason: 'timeout' })

    const garbage = jest.fn().mockResolvedValue(jsonResponse({ nope: 1 }))
    await expect(
      fetchDirectProviderCredits(
        { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
        { fetchImpl: garbage as unknown as typeof fetch, now },
      ),
    ).resolves.toMatchObject({ reason: 'unreadable' })
  })
})

describe('asCreditsResult', () => {
  it('accepts each valid server shape', () => {
    expect(asCreditsResult({ status: 'unsupported', provider: 'Anthropic' })).toEqual({
      status: 'unsupported',
      provider: 'Anthropic',
    })
    expect(asCreditsResult({ status: 'unavailable', provider: 'OpenRouter', reason: 'timeout' })).toEqual({
      status: 'unavailable',
      provider: 'OpenRouter',
      reason: 'timeout',
    })
    expect(
      asCreditsResult({
        status: 'ok',
        provider: 'OpenRouter',
        remaining: 3,
        usage: 1,
        currency: 'USD',
        fetchedAt: '2026-09-28T12:00:00.000Z',
      }),
    ).toMatchObject({ status: 'ok', remaining: 3 })
  })

  it('degrades an unknown failure reason rather than trusting it', () => {
    expect(asCreditsResult({ status: 'unavailable', provider: 'X', reason: 'something-new' })).toEqual({
      status: 'unavailable',
      provider: 'X',
      reason: 'unreadable',
    })
  })

  it('rejects payloads an older or misbehaving server might send', () => {
    expect(asCreditsResult(null)).toBeNull()
    expect(asCreditsResult({})).toBeNull()
    expect(asCreditsResult({ status: 'ok' })).toBeNull()
    expect(asCreditsResult({ status: 'nonsense', provider: 'X' })).toBeNull()
    expect(asCreditsResult('<html>404</html>')).toBeNull()
  })
})

describe('formatCreditsAmount', () => {
  it('formats a known currency', () => {
    expect(formatCreditsAmount(12.5, 'USD')).toContain('12.50')
  })

  it('still renders a well-formed but unknown code', () => {
    // Intl accepts any three-letter code, so this does not reach the fallback.
    expect(formatCreditsAmount(12.5, 'ZZZ')).toContain('12.50')
    expect(formatCreditsAmount(12.5, 'ZZZ')).toContain('ZZZ')
  })

  it('falls back instead of throwing when the runtime rejects the code', () => {
    // Intl throws RangeError on a malformed code; the currency validator should
    // keep these out, so this guards the defensive path behind it.
    expect(formatCreditsAmount(12.5, 'US')).toBe('12.50 US')
  })
})

describe('formatCreditsAge', () => {
  it('ages the figure so a number never appears without its staleness', () => {
    expect(formatCreditsAge('2026-09-28T12:00:00.000Z', NOW)).toBe('checked just now')
    expect(formatCreditsAge('2026-09-28T11:55:00.000Z', NOW)).toBe('checked 5 min ago')
    expect(formatCreditsAge('2026-09-28T09:00:00.000Z', NOW)).toBe('checked 3 h ago')
    expect(formatCreditsAge('2026-09-20T12:00:00.000Z', NOW)).toMatch(/^checked on /)
  })

  it('does not throw on an unparseable stamp', () => {
    expect(formatCreditsAge('', NOW)).toBe('checked just now')
  })
})

describe('describeCreditsResult', () => {
  const describe_ = (result: CreditsResult) => describeCreditsResult(result, NOW)

  it('names the provider in the unsupported message', () => {
    expect(describe_({ status: 'unsupported', provider: 'Anthropic' })).toBe(
      'Anthropic does not publish a credit balance that an API key can read.',
    )
  })

  it('keeps the three failure kinds distinct', () => {
    const unsupported = describe_({ status: 'unsupported', provider: 'OpenAI' })
    const missing = describe_({ status: 'not-configured', provider: 'OpenRouter' })
    const failed = describe_({ status: 'unavailable', provider: 'OpenRouter', reason: 'unauthorized' })

    expect(new Set([unsupported, missing, failed]).size).toBe(3)
    expect(missing).toMatch(/no api key is configured/i)
    expect(failed).toMatch(/rejected/i)
    expect(unsupported).not.toMatch(/failed|error/i)
  })

  it('gives each failure reason its own wording', () => {
    const reasons = ['unauthorized', 'rate-limited', 'network', 'timeout', 'unreadable'] as const
    const messages = reasons.map((reason) => describe_({ status: 'unavailable', provider: 'OpenRouter', reason }))
    expect(new Set(messages).size).toBe(reasons.length)
  })

  it('states the balance together with how old it is', () => {
    const message = describe_({
      status: 'ok',
      provider: 'OpenRouter',
      remaining: 8.25,
      usage: 1.75,
      currency: 'USD',
      fetchedAt: '2026-09-28T11:57:00.000Z',
    })
    expect(message).toContain('8.25')
    expect(message).toContain('remaining on OpenRouter')
    expect(message).toContain('checked 3 min ago')
  })

  it('explains an uncapped key instead of claiming a zero balance', () => {
    const message = describe_({
      status: 'ok',
      provider: 'OpenRouter',
      remaining: null,
      usage: 3.5,
      currency: 'USD',
      note: 'This key has no credit limit set, so no remaining balance is reported.',
      fetchedAt: '2026-09-28T12:00:00.000Z',
    })
    expect(message).toMatch(/no credit limit set/i)
    expect(message).toContain('3.50')
    expect(message).not.toMatch(/\$0\.00 remaining/)
  })
})
