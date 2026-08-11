import { TextDecoder as NodeTextDecoder } from 'node:util'
import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { DirectProvider } from './DirectProvider'
import { buildAssistantProvider } from './selectionActions'
import { Provider, ProviderEvent, ProviderRequest } from './types'

const request: ProviderRequest = {
  system: 'Be helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [],
}

const collect = async (provider: Provider): Promise<ProviderEvent[]> => {
  const events: ProviderEvent[] = []
  for await (const event of provider.send(request)) {
    events.push(event)
  }
  return events
}

const response = (options: {
  ok: boolean
  status: number
  contentType?: string
  text?: string
  json?: unknown
  body?: unknown
}): Response =>
  ({
    ok: options.ok,
    status: options.status,
    statusText: '',
    headers: { get: () => options.contentType ?? null },
    text: async () => options.text ?? '',
    json: async () => options.json,
    body: options.body ?? null,
  }) as unknown as Response

describe('DirectProvider endpoint behavior', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: jest.fn() })
    localStorage.clear()
  })

  afterAll(() => {
    if (originalFetch) {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch })
    } else {
      Reflect.deleteProperty(globalThis, 'fetch')
    }
  })

  it('normalizes a bare LM Studio host before POSTing chat completions', async () => {
    const read = jest.fn().mockResolvedValue({ done: true, value: undefined })
    const fetchMock = globalThis.fetch as jest.Mock
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }))

    await collect(new DirectProvider({ baseURL: 'http://127.0.0.1:1234', model: 'local-model' }))

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses the saved Direct-mode auth configuration through the shared runtime factory', async () => {
    const prefs: Partial<Record<PrefKey, unknown>> = {
      [PrefKey.AssistantConnectionMode]: 'direct',
      [PrefKey.AssistantBaseUrl]: 'https://models.example.test/v1',
      [PrefKey.AssistantModel]: 'model-a',
      [PrefKey.AssistantAuthMode]: 'subscription',
      [PrefKey.AssistantSubscriptionToken]: 'subscription-token',
      [PrefKey.AssistantExtraHeaders]: '{"ChatGPT-Account-Id":"acct-1"}',
    }
    const application = {
      getPreference: (key: PrefKey, defaultValue?: unknown) => prefs[key] ?? defaultValue,
    } as unknown as WebApplication
    const read = jest.fn().mockResolvedValue({ done: true, value: undefined })
    const fetchMock = globalThis.fetch as jest.Mock
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }))

    await collect(buildAssistantProvider(application))

    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.example.test/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer subscription-token',
          'ChatGPT-Account-Id': 'acct-1',
        }),
      }),
    )
  })

  it('does not POST a direct request into the Standard Red Notes SPA origin', async () => {
    const fetchMock = globalThis.fetch as jest.Mock
    const events = await collect(new DirectProvider({ baseURL: `${window.location.origin}/v1`, model: 'wrong-target' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('Choose Server proxy') }),
    )
  })

  it('turns nginx 405 HTML into bounded actionable text without rendering the HTML', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({
        ok: false,
        status: 405,
        contentType: 'text/html; charset=utf-8',
        text: '<html><body><h1>405 Not Allowed</h1></body></html>',
      }),
    )

    const events = await collect(new DirectProvider({ baseURL: 'https://models.example.test/v1', model: 'model-a' }))
    const error = events.find((event) => event.kind === 'error')

    expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining('HTTP 405') }))
    expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining('LM Studio') }))
    expect(error).not.toEqual(expect.objectContaining({ message: expect.stringContaining('<html>') }))
  })
})
