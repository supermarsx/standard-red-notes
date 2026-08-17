import { TextDecoder as NodeTextDecoder } from 'node:util'
import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { assistantUsageService } from './AssistantUsageService'
import { ProxyProvider } from './ProxyProvider'
import { buildAssistantProvider } from './selectionActions'
import { Provider, ProviderEvent, ProviderRequest } from './types'

const request: ProviderRequest = {
  system: 'system',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
}

const collect = async (provider: Provider, providerRequest: ProviderRequest = request): Promise<ProviderEvent[]> => {
  const events: ProviderEvent[] = []
  for await (const event of provider.send(providerRequest)) {
    events.push(event)
  }
  return events
}

describe('ProxyProvider automatic profile routing', () => {
  it('prefers the per-run request signal so a deadline aborts the upstream proxy request', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    const constructorController = new AbortController()
    const runController = new AbortController()
    const postStream = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      } as unknown as Response
    })

    await collect(
      new ProxyProvider({
        provider: '',
        model: '',
        postStream,
        signal: constructorController.signal,
      }),
      { ...request, signal: runController.signal },
    )

    expect(postStream).toHaveBeenCalledWith(expect.any(Object), runController.signal)
  })

  it('omits empty provider/model so the server can resolve the assigned/default profile', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    let submitted: unknown
    const frame = 'data: {"kind":"finish","stopReason":"end_turn"}\n\n'
    const bytes = Uint8Array.from([...frame].map((character) => character.charCodeAt(0)))
    let reads = 0
    const postStream = jest.fn(async (body: unknown) => {
      submitted = body
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: async () => (reads++ === 0 ? { done: false, value: bytes } : { done: true, value: undefined }),
          }),
        },
      } as unknown as Response
    })

    const events = await collect(new ProxyProvider({ provider: '', model: '', postStream }))

    expect(submitted).not.toHaveProperty('provider')
    expect(submitted).not.toHaveProperty('model')
    expect(submitted).not.toHaveProperty('profileId')
    expect(submitted).not.toHaveProperty('temperature')
    expect(submitted).not.toHaveProperty('top_p')
    expect(submitted).not.toHaveProperty('max_tokens')
    expect(events).toContainEqual({ kind: 'finish', stopReason: 'end_turn' })
  })

  it('marks a safety review without sending a client-controlled generation cap', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    let submitted: Record<string, unknown> | undefined
    const postStream = jest.fn(async (body: unknown) => {
      submitted = body as Record<string, unknown>
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      } as unknown as Response
    })

    await collect(new ProxyProvider({ provider: '', model: '', postStream }), {
      ...request,
      purpose: 'safety-review',
      maxOutputTokens: 8,
    })

    expect(submitted).toMatchObject({ purpose: 'safety-review' })
    expect(submitted).not.toHaveProperty('maxOutputTokens')
    expect(submitted).not.toHaveProperty('max_tokens')
  })

  it('does not send stale Direct-mode provider/model preferences in proxy mode', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    let submitted: unknown
    const application = {
      getPreference: (key: PrefKey, defaultValue?: unknown) => {
        const prefs: Partial<Record<PrefKey, unknown>> = {
          [PrefKey.AssistantConnectionMode]: 'proxy',
          [PrefKey.AssistantProvider]: 'openai',
          [PrefKey.AssistantModel]: 'stale-direct-model',
        }
        return prefs[key] ?? defaultValue
      },
      assistantStreamRequest: async (_path: string, body: unknown) => {
        submitted = body
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'text/event-stream' },
          body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
        } as unknown as Response
      },
    } as unknown as WebApplication

    await collect(buildAssistantProvider(application))

    expect(submitted).not.toHaveProperty('provider')
    expect(submitted).not.toHaveProperty('model')
    expect(submitted).not.toHaveProperty('profileId')
  })

  it('round-trips opaque provider replay without interpreting or dropping it', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    const providerReplay = {
      protocol: 'openai-responses' as const,
      version: 1 as const,
      encodedOutput: 'b3BhcXVl',
    }
    let submitted: unknown
    const finish = { kind: 'finish', stopReason: 'tool_use', providerReplay } as const
    const frame = `data: ${JSON.stringify(finish)}\n\n`
    const bytes = Uint8Array.from([...frame].map((character) => character.charCodeAt(0)))
    let reads = 0
    const postStream = jest.fn(async (body: unknown) => {
      submitted = body
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: async () => (reads++ === 0 ? { done: false, value: bytes } : { done: true, value: undefined }),
          }),
        },
      } as unknown as Response
    })
    const providerRequest: ProviderRequest = {
      ...request,
      messages: [
        request.messages[0],
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'notes.list', args: {} }],
          providerReplay,
        },
      ],
    }

    await expect(collect(new ProxyProvider({ provider: '', model: '', postStream }), providerRequest)).resolves.toEqual(
      [finish],
    )
    expect(submitted).toEqual(expect.objectContaining({ messages: providerRequest.messages }))
  })

  it.each([
    [
      'provider error',
      'data: {"kind":"usage","totalTokens":99}\n\ndata: {"kind":"error","message":"rejected"}\n\ndata: {"kind":"finish","stopReason":"error"}\n\n',
    ],
    ['truncated stream', 'data: {"kind":"text-delta","delta":"partial"}\n\n'],
  ])('does not record a %s as completed usage', async (_label, frame) => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    const bytes = Uint8Array.from([...frame].map((character) => character.charCodeAt(0)))
    let reads = 0
    const record = jest.spyOn(assistantUsageService, 'record')
    const postStream = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: async () => (reads++ === 0 ? { done: false, value: bytes } : { done: true, value: undefined }),
          }),
        },
      } as unknown as Response
    })

    const events = await collect(new ProxyProvider({ provider: '', model: '', postStream }))

    expect(events.at(-1)).toEqual({ kind: 'finish', stopReason: 'error' })
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })

  it('yields a CRLF-delimited proxy event before attempting the next read', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    const frame = 'data: {"kind":"text-delta","delta":"live"}\r\n\r\n'
    const bytes = Uint8Array.from([...frame].map((character) => character.charCodeAt(0)))
    const read = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockRejectedValueOnce(new Error('second read must not precede the first delta'))
    const cancel = jest.fn().mockResolvedValue(undefined)
    const postStream = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read, cancel }) },
      } as unknown as Response
    })
    const iterator = new ProxyProvider({ provider: '', model: '', postStream }).send(request)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { kind: 'text-delta', delta: 'live' } })
    expect(read).toHaveBeenCalledTimes(1)
    await iterator.return?.()
  })

  it('fails closed on malformed proxy data before a nominal success frame', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    const frame = 'data: {not-json}\n\n' + 'data: {"kind":"finish","stopReason":"end_turn"}\n\n'
    const bytes = Uint8Array.from([...frame].map((character) => character.charCodeAt(0)))
    const read = jest.fn().mockResolvedValue({ done: false, value: bytes })
    const cancel = jest.fn().mockResolvedValue(undefined)
    const record = jest.spyOn(assistantUsageService, 'record')
    const postStream = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read, cancel }) },
      } as unknown as Response
    })

    const events = await collect(new ProxyProvider({ provider: '', model: '', postStream }))

    expect(events).toEqual([
      { kind: 'error', message: 'The assistant proxy returned malformed stream data.' },
      { kind: 'finish', stopReason: 'error' },
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })

  it('keeps a CRLF pair intact when the chunk boundary falls between its bytes', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    const frame = 'data: {"kind":\r\ndata: "finish","stopReason":"end_turn"}\r\n\r\n'
    const splitCr = frame.indexOf('\r') + 1
    const chunks = [frame.slice(0, splitCr), frame.slice(splitCr)]
    let chunkIndex = 0
    const read = jest.fn(async () =>
      chunkIndex < chunks.length
        ? {
            done: false,
            value: Uint8Array.from([...chunks[chunkIndex++]].map((character) => character.charCodeAt(0))),
          }
        : { done: true, value: undefined },
    )
    const postStream = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read }) },
      } as unknown as Response
    })

    await expect(collect(new ProxyProvider({ provider: '', model: '', postStream }))).resolves.toEqual([
      { kind: 'finish', stopReason: 'end_turn' },
    ])
  })

  it('terminates once when the proxy stream reader fails', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    const record = jest.spyOn(assistantUsageService, 'record')
    const read = jest.fn().mockRejectedValue(new Error('socket closed'))
    const postStream = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read }) },
      } as unknown as Response
    })

    const result = await collect(new ProxyProvider({ provider: '', model: '', postStream }))

    expect(result).toEqual([
      {
        kind: 'error',
        message:
          'Could not reach the assistant proxy. Check your connection and whether the Standard Red Notes server is healthy.',
      },
      { kind: 'finish', stopReason: 'error' },
    ])
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })
})
