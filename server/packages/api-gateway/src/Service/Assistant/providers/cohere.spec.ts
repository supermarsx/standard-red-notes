import { CohereProvider, listCohereModels } from './cohere'
import { ProviderEvent, ProviderRequest } from './types'

const KEY = 'SENTINEL_COHERE_KEY'
const ENV = {
  ASSISTANT_COHERE_API_KEY: KEY,
  ASSISTANT_COHERE_BASE_URL: 'https://cohere.test',
} as unknown as NodeJS.ProcessEnv

const fetchMock = jest.fn()

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  jest.resetAllMocks()
})

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function streamResponse(
  chunks: string[],
  { ok = true, status = 200, statusText = 'OK' }: { ok?: boolean; status?: number; statusText?: string } = {},
): unknown {
  const encoder = new TextEncoder()
  let i = 0
  return {
    ok,
    status,
    statusText,
    body: {
      getReader() {
        return {
          read() {
            if (i < chunks.length) {
              return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) })
            }
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    },
  }
}

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = []
  for await (const event of iter) {
    out.push(event)
  }
  return out
}

const baseRequest: ProviderRequest = { system: 'You are a bot', messages: [], tools: [] }

describe('CohereProvider.send', () => {
  it('parses content-delta, tool-call-*, usage and message-end into provider events', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse({ type: 'content-delta', index: 0, delta: { message: { content: { text: 'Hi' } } } }),
        sse({
          type: 'tool-call-start',
          index: 0,
          delta: { message: { tool_calls: { id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '' } } } },
        }),
        sse({
          type: 'tool-call-delta',
          index: 0,
          delta: { message: { tool_calls: { function: { arguments: '{"q":"x"}' } } } },
        }),
        sse({ type: 'tool-call-end', index: 0 }),
        sse({
          type: 'message-end',
          delta: { finish_reason: 'COMPLETE', usage: { billed_units: { input_tokens: 12, output_tokens: 8 } } },
        }),
      ]),
    )

    const events = await collect(new CohereProvider('command-r', ENV).send(baseRequest))

    expect(events).toContainEqual({ kind: 'text-delta', delta: 'Hi' })
    expect(events).toContainEqual({ kind: 'tool-call', id: 'tc_1', name: 'lookup', args: { q: 'x' } })
    expect(events).toContainEqual({
      kind: 'usage',
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    })
    expect(events.at(-1)).toEqual({ kind: 'finish', stopReason: 'end_turn' })
  })

  it('maps a TOOL_CALL finish reason to tool_use', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([sse({ type: 'message-end', delta: { finish_reason: 'TOOL_CALL' } })]),
    )

    const events = await collect(new CohereProvider('command-r', ENV).send(baseRequest))
    expect(events.at(-1)).toEqual({ kind: 'finish', stopReason: 'tool_use' })
  })

  it('yields an error event (never throws) when the upstream response is not ok', async () => {
    fetchMock.mockResolvedValue(streamResponse([], { ok: false, status: 401, statusText: 'Unauthorized' }))

    const events = await collect(new CohereProvider('command-r', ENV).send(baseRequest))

    expect(events[0].kind).toBe('error')
    expect(events.at(-1)).toEqual({ kind: 'finish', stopReason: 'error' })
  })

  it('never leaks the api key in any emitted event', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse({ type: 'content-delta', index: 0, delta: { message: { content: { text: 'hi' } } } }),
        sse({ type: 'message-end', delta: { finish_reason: 'COMPLETE' } }),
      ]),
    )

    const events = await collect(new CohereProvider('command-r', ENV).send(baseRequest))

    expect(JSON.stringify(events)).not.toContain(KEY)
  })
})

describe('listCohereModels', () => {
  it('parses the model list', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: 'command-r' }, { name: 'command-r-plus' }] }),
    })

    const models = await listCohereModels(ENV)

    expect(models).toEqual(['command-r', 'command-r-plus'])
    expect(JSON.stringify(models)).not.toContain(KEY)
  })

  it('returns [] when the response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', json: () => Promise.resolve({}) })
    expect(await listCohereModels(ENV)).toEqual([])
  })

  it('returns [] when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    expect(await listCohereModels(ENV)).toEqual([])
  })
})
