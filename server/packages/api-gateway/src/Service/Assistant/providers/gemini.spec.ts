import { GeminiProvider, listGeminiModels } from './gemini'
import { ProviderEvent, ProviderRequest } from './types'

const KEY = 'SENTINEL_GEMINI_KEY'
const ENV = {
  ASSISTANT_GEMINI_API_KEY: KEY,
  ASSISTANT_GEMINI_BASE_URL: 'https://gemini.test/v1beta',
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

describe('GeminiProvider.send', () => {
  it('parses text-delta, tool-call, usage and finish from an SSE stream', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] }),
        sse({
          candidates: [
            { content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] } },
          ],
        }),
        sse({
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      ]),
    )

    const events = await collect(new GeminiProvider('gemini-1.5-pro', ENV).send(baseRequest))

    expect(events).toContainEqual({ kind: 'text-delta', delta: 'Hello' })
    expect(events).toContainEqual({
      kind: 'tool-call',
      id: 'gemini_call_0',
      name: 'get_weather',
      args: { city: 'SF' },
    })
    expect(events).toContainEqual({
      kind: 'usage',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
    // A tool call was seen, so the finish reason is tool_use.
    expect(events.at(-1)).toEqual({ kind: 'finish', stopReason: 'tool_use' })
  })

  it('yields an error event (never throws) when the upstream response is not ok', async () => {
    fetchMock.mockResolvedValue(streamResponse([], { ok: false, status: 429, statusText: 'Too Many Requests' }))

    const events = await collect(new GeminiProvider('gemini-1.5-pro', ENV).send(baseRequest))

    expect(events[0].kind).toBe('error')
    expect(events.at(-1)).toEqual({ kind: 'finish', stopReason: 'error' })
  })

  it('never leaks the api key in any emitted event', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
      ]),
    )

    const events = await collect(new GeminiProvider('gemini-1.5-pro', ENV).send(baseRequest))

    expect(JSON.stringify(events)).not.toContain(KEY)
  })
})

describe('listGeminiModels', () => {
  it('parses the model list and strips the models/ prefix', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ models: [{ name: 'models/gemini-1.5-pro' }, { name: 'models/gemini-1.5-flash' }] }),
    })

    const models = await listGeminiModels(ENV)

    expect(models).toEqual(['gemini-1.5-pro', 'gemini-1.5-flash'])
    expect(JSON.stringify(models)).not.toContain(KEY)
  })

  it('returns [] when the response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', json: () => Promise.resolve({}) })
    expect(await listGeminiModels(ENV)).toEqual([])
  })

  it('returns [] when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    expect(await listGeminiModels(ENV)).toEqual([])
  })
})
