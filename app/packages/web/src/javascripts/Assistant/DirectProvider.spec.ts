import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util'
import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { assistantUsageService } from './AssistantUsageService'
import { DirectProvider } from './DirectProvider'
import { createOpenAIToolNameMap } from './OpenAIToolNameMap'
import { buildAssistantProvider } from './selectionActions'
import { TOOL_DEFINITIONS } from './tools'
import { Provider, ProviderEvent, ProviderRequest } from './types'

const request: ProviderRequest = {
  system: 'Be helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [],
}

const collect = async (provider: Provider, providerRequest: ProviderRequest = request): Promise<ProviderEvent[]> => {
  const events: ProviderEvent[] = []
  for await (const event of provider.send(providerRequest)) {
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

  it('prefers the per-run request signal so a deadline aborts the upstream fetch', async () => {
    const constructorController = new AbortController()
    const runController = new AbortController()
    const read = jest.fn().mockResolvedValue({ done: true, value: undefined })
    const fetchMock = globalThis.fetch as jest.Mock
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }))

    await collect(
      new DirectProvider({
        baseURL: 'https://models.example.test/v1',
        model: 'model-a',
        signal: constructorController.signal,
      }),
      { ...request, signal: runController.signal },
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.example.test/v1/chat/completions',
      expect.objectContaining({ signal: runController.signal }),
    )
  })

  it('honors a narrower per-request output cap for safety reviews', async () => {
    const read = jest.fn().mockResolvedValue({ done: true, value: undefined })
    const fetchMock = globalThis.fetch as jest.Mock
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }))

    await collect(
      new DirectProvider({
        baseURL: 'https://models.example.test/v1',
        model: 'model-a',
        sampling: {
          temperature: 0.7,
          topP: 1,
          maxTokens: 200,
          maxSteps: 16,
          maxRunTime: 10,
          maxRunTimeUnit: 'minutes',
          useServerTemperature: true,
          useServerTopP: true,
        },
      }),
      { ...request, maxOutputTokens: 8 },
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as { max_tokens?: number }
    expect(body.max_tokens).toBe(8)
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

  it('encodes dotted tool and history names on the wire, then decodes streamed calls', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list', 'delegate']).toWireName('notes.list')
    const frame =
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: wireName, arguments: '{"limit":2}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\n` + 'data: [DONE]\n\n'
    const bytes = new NodeTextEncoder().encode(frame)
    const read = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined })
    const fetchMock = globalThis.fetch as jest.Mock
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }))
    const providerRequest: ProviderRequest = {
      system: 'Be helpful.',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'prior-call', name: 'notes.list', args: { limit: 1 } }],
        },
        { role: 'tool', toolCallId: 'prior-call', content: '[]' },
      ],
      tools: [
        { name: 'notes.list', description: 'List notes', inputSchema: { type: 'object' } },
        { name: 'delegate', description: 'Delegate work', inputSchema: { type: 'object' } },
      ],
    }

    const result = await collect(
      new DirectProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/model' }),
      providerRequest,
    )
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body) as {
      tools: Array<{ function: { name: string } }>
      messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>
      max_tokens?: number
    }

    expect(wireName).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(sent.tools.map((tool) => tool.function.name)).toEqual([wireName, 'delegate'])
    expect(sent.messages[1].tool_calls?.[0].function.name).toBe(wireName)
    expect(sent).not.toHaveProperty('max_tokens')
    expect(result).toContainEqual({ kind: 'tool-call', id: 'call-1', name: 'notes.list', args: { limit: 2 } })
    expect(result.at(-1)).toEqual({ kind: 'finish', stopReason: 'tool_use' })
  })

  it('maps every production assistant tool to a unique reversible OpenAI-safe wire name', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name)
    const toolNames = createOpenAIToolNameMap(names)
    const reorderedToolNames = createOpenAIToolNameMap([...names].reverse())
    const wireNames = names.map((name) => toolNames.toWireName(name))

    expect(wireNames).toHaveLength(new Set(wireNames).size)
    for (const name of names) {
      const wireName = toolNames.toWireName(name)
      expect(wireName).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(toolNames.toInternalName(wireName)).toBe(name)
      expect(reorderedToolNames.toWireName(name)).toBe(wireName)
      if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        expect(wireName).toBe(name)
      }
    }
  })

  it.each([
    ['top-level error', { error: { message: `400\u0000 Provider returned error ${'x'.repeat(600)}` } }],
    ['error finish reason', { choices: [{ delta: {}, finish_reason: 'error' }] }],
  ])('terminates a streamed %s exactly once without recording usage', async (_label, payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify({
      choices: [{ delta: { content: 'must not appear' }, finish_reason: 'stop' }],
      usage: { total_tokens: 99 },
    })}\n\n`
    const read = jest.fn().mockResolvedValue({ done: false, value: new NodeTextEncoder().encode(frame) })
    const cancel = jest.fn().mockResolvedValue(undefined)
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({ ok: true, status: 200, body: { getReader: () => ({ read, cancel }) } }),
    )
    const record = jest.spyOn(assistantUsageService, 'record')

    const result = await collect(
      new DirectProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/model' }),
    )

    expect(result).toHaveLength(2)
    expect(result[0]?.kind).toBe('error')
    expect(result[1]).toEqual({ kind: 'finish', stopReason: 'error' })
    if (result[0]?.kind === 'error') {
      expect(result[0].message.length).toBeLessThanOrEqual(512)
      expect(result[0].message).not.toMatch(/[\u0000-\u001f\u007f]/)
    }
    expect(record).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    record.mockRestore()
  })

  it('fails a truncated stream without recording the request or reported usage', async () => {
    const frame = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'partial' }, finish_reason: null }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })}\n\ndata: [DONE]\n\n`
    const read = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: new NodeTextEncoder().encode(frame) })
      .mockResolvedValueOnce({ done: true, value: undefined })
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }),
    )
    const record = jest.spyOn(assistantUsageService, 'record')

    const result = await collect(
      new DirectProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/model' }),
    )

    expect(result).toEqual([
      { kind: 'text-delta', delta: 'partial' },
      {
        kind: 'error',
        message: 'The configured assistant provider ended before reporting a completion reason.',
      },
      { kind: 'finish', stopReason: 'error' },
    ])
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })

  it('fails malformed stream data even when a later frame claims success', async () => {
    const frame =
      'data: {not-json}\n\n' +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'must not appear' }, finish_reason: 'stop' }] })}\n\n`
    const read = jest.fn().mockResolvedValue({ done: false, value: new NodeTextEncoder().encode(frame) })
    const cancel = jest.fn().mockResolvedValue(undefined)
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({ ok: true, status: 200, body: { getReader: () => ({ read, cancel }) } }),
    )
    const record = jest.spyOn(assistantUsageService, 'record')

    const result = await collect(
      new DirectProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/model' }),
    )

    expect(result).toEqual([
      { kind: 'error', message: 'The configured assistant provider returned malformed stream data.' },
      { kind: 'finish', stopReason: 'error' },
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })

  it('yields a complete CRLF frame before attempting the next read', async () => {
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'live' }, finish_reason: null }] })}\r\n\r\n`
    const read = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: new NodeTextEncoder().encode(frame) })
      .mockRejectedValueOnce(new Error('second read must not precede the first delta'))
    const cancel = jest.fn().mockResolvedValue(undefined)
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({ ok: true, status: 200, body: { getReader: () => ({ read, cancel }) } }),
    )
    const iterator = new DirectProvider({
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'openrouter/model',
    })
      .send(request)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { kind: 'text-delta', delta: 'live' } })
    expect(read).toHaveBeenCalledTimes(1)
    await iterator.return?.()
  })

  it('joins multiline SSE data and late tool identity fragments', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const splitAt = Math.max(1, Math.floor(wireName.length / 2))
    const frames = [
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"limit":' } }] }, finish_reason: null }],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-late', function: { name: wireName.slice(0, splitAt), arguments: '2' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: wireName, arguments: '}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]
    const first = JSON.stringify(frames[0])
    const firstSplit = first.indexOf('[') + 1
    const multilineFirst = `data: ${first.slice(0, firstSplit)}\r\ndata: ${first.slice(firstSplit)}\r\n\r\n`
    const stream = `${multilineFirst}${frames
      .slice(1)
      .map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`)
      .join('')}data: [DONE]\r\n\r\n`
    const splitCr = stream.indexOf('\r') + 1
    const chunks = [stream.slice(0, splitCr), stream.slice(splitCr)]
    let chunkIndex = 0
    const read = jest.fn(async () =>
      chunkIndex < chunks.length
        ? { done: false, value: new NodeTextEncoder().encode(chunks[chunkIndex++]) }
        : { done: true, value: undefined },
    )
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }),
    )

    const result = await collect(
      new DirectProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/model' }),
      { ...request, tools: [{ name: 'notes.list', description: 'List notes', inputSchema: { type: 'object' } }] },
    )

    expect(result).toContainEqual({ kind: 'tool-call', id: 'call-late', name: 'notes.list', args: { limit: 2 } })
    expect(result.at(-1)).toEqual({ kind: 'finish', stopReason: 'tool_use' })
  })

  it('treats malformed function arguments as a terminal error without emitting a tool call', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const frame = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call-malformed', function: { name: wireName, arguments: '{"limit":' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\ndata: [DONE]\n\n`
    const read = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: new NodeTextEncoder().encode(frame) })
      .mockResolvedValueOnce({ done: true, value: undefined })
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }),
    )
    const record = jest.spyOn(assistantUsageService, 'record')

    const result = await collect(
      new DirectProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/model' }),
      { ...request, tools: [{ name: 'notes.list', description: 'List notes', inputSchema: { type: 'object' } }] },
    )

    expect(result).toEqual([
      {
        kind: 'error',
        message: 'The configured assistant provider returned malformed function-call arguments.',
      },
      { kind: 'finish', stopReason: 'error' },
    ])
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })

  it('fails a length-truncated function call without emitting it', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const frame = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call-partial', function: { name: wireName, arguments: '{"limit":2}' } }],
          },
          finish_reason: 'length',
        },
      ],
    })}\n\ndata: [DONE]\n\n`
    const read = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: new NodeTextEncoder().encode(frame) })
      .mockResolvedValueOnce({ done: true, value: undefined })
    ;(globalThis.fetch as jest.Mock).mockResolvedValue(
      response({ ok: true, status: 200, body: { getReader: () => ({ read }) } }),
    )
    const record = jest.spyOn(assistantUsageService, 'record')

    const result = await collect(
      new DirectProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/model' }),
      { ...request, tools: [{ name: 'notes.list', description: 'List notes', inputSchema: { type: 'object' } }] },
    )

    expect(result).toEqual([
      {
        kind: 'error',
        message: 'The configured assistant provider returned an incomplete function call. No tools were run.',
      },
      { kind: 'finish', stopReason: 'error' },
    ])
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })
})
