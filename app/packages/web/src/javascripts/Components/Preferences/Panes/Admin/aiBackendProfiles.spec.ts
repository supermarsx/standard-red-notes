import {
  BackendProfileRow,
  backendRowToPayload,
  emptyBackendRow,
  maskedBackendToRow,
  validateBackendRow,
} from './aiBackendProfiles'

const subscriptionRow = (subscriptionId: string): BackendProfileRow => ({
  id: 'backend-1',
  name: 'Paired subscription',
  type: 'subscription',
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  subscriptionId,
  wireProtocol: 'responses',
  timeoutMs: '',
  maxRetries: '',
  keyConfigured: false,
  newKey: '',
  clearKey: false,
})

describe('subscription backend profile identifiers', () => {
  it.each([
    '',
    ' team ',
    'team/name',
    'tëam',
    '.team',
    'team.',
    'constructor',
    'prototype',
    'toString',
    'hasOwnProperty',
    'x'.repeat(129),
  ])('rejects non-portable id %p without silently rewriting it', (subscriptionId) => {
    expect(validateBackendRow(subscriptionRow(subscriptionId)).ok).toBe(false)
  })

  it('rejects every reserved object-property name in the server contract', () => {
    for (const subscriptionId of [...Object.getOwnPropertyNames(Object.prototype), 'prototype']) {
      expect(validateBackendRow(subscriptionRow(subscriptionId)).ok).toBe(false)
    }
  })

  it('accepts and serializes the shared portable syntax byte-for-byte', () => {
    const subscriptionId = 'team_a.1-b'
    const row = subscriptionRow(subscriptionId)

    expect(validateBackendRow(row)).toEqual({ ok: true })
    expect(backendRowToPayload(row).subscriptionId).toBe(subscriptionId)
  })
})

describe('backend transport controls', () => {
  const apiKeyRow = (overrides: Partial<BackendProfileRow> = {}): BackendProfileRow => ({
    id: 'backend-openai',
    name: 'OpenAI backend',
    type: 'api-key',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    subscriptionId: '',
    wireProtocol: 'chat-completions',
    timeoutMs: '',
    maxRetries: '',
    keyConfigured: true,
    newKey: '',
    clearKey: false,
    ...overrides,
  })

  it('uses protocol defaults that match the backend kind', () => {
    expect(emptyBackendRow('api-key').wireProtocol).toBe('chat-completions')
    expect(emptyBackendRow('subscription').wireProtocol).toBe('responses')
  })

  it('loads masked transport controls without manufacturing numeric overrides', () => {
    expect(
      maskedBackendToRow({
        id: 'backend-1',
        name: 'Responses backend',
        type: 'api-key',
        provider: 'openai-compatible',
        keyConfigured: true,
        wireProtocol: 'responses',
        timeoutMs: 45_000,
        maxRetries: 3,
      }),
    ).toMatchObject({ wireProtocol: 'responses', timeoutMs: '45000', maxRetries: '3' })
  })

  it.each([
    [{ timeoutMs: '999' }, 'timeout'],
    [{ timeoutMs: '600001' }, 'timeout'],
    [{ timeoutMs: '1.5' }, 'timeout'],
    [{ maxRetries: '-1' }, 'retries'],
    [{ maxRetries: '11' }, 'retries'],
    [{ maxRetries: '1.5' }, 'retries'],
  ] as Array<[Partial<BackendProfileRow>, string]>)('rejects invalid transport override %p', (overrides, message) => {
    const result = validateBackendRow(apiKeyRow(overrides))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(message)
    }
  })

  it('serializes the exact backend transport field names', () => {
    expect(
      backendRowToPayload(apiKeyRow({ wireProtocol: 'responses', timeoutMs: '90000', maxRetries: '4' })),
    ).toMatchObject({ wireProtocol: 'responses', timeoutMs: 90_000, maxRetries: 4 })
  })

  it('does not serialize an OpenAI wire protocol for native non-OpenAI providers', () => {
    const payload = backendRowToPayload(apiKeyRow({ provider: 'anthropic', baseUrl: '' }))
    expect(payload).not.toHaveProperty('wireProtocol')
  })

  it('omits blank timeout and retry overrides', () => {
    const payload = backendRowToPayload(apiKeyRow())
    expect(payload).not.toHaveProperty('timeoutMs')
    expect(payload).not.toHaveProperty('maxRetries')
  })
})
