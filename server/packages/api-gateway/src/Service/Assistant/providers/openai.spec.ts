import OpenAI from 'openai'

import { OpenAIProvider } from './openai'
import { createOpenAIToolNameMap } from './OpenAIToolNameMap'
import { ProviderEvent, ProviderRequest } from './types'

jest.mock('openai')

const create = jest.fn()
const OpenAIMock = OpenAI as unknown as jest.Mock

function events(items: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items
    },
  }
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = []
  for await (const event of iterable) {
    result.push(event)
  }
  return result
}

const dottedRequest = (): ProviderRequest => ({
  system: 'Be helpful.',
  messages: [
    { role: 'user', content: 'List notes' },
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
})

describe('OpenAIProvider wire contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    OpenAIMock.mockImplementation((options: unknown) => ({ chat: { completions: { create } }, options }))
  })

  it('round-trips dotted production tool names through safe deterministic aliases', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list', 'delegate']).toWireName('notes.list')
    create.mockResolvedValue(
      events([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-1', function: { name: wireName, arguments: '{"limit":' } }],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' },
          ],
        },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]),
    )

    const result = await collect(new OpenAIProvider('openrouter/model', 'key').send(dottedRequest()))
    const request = create.mock.calls[0][0]

    expect(wireName).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(wireName).not.toBe('notes.list')
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      wireName,
      'delegate',
    ])
    expect(request.messages[2].tool_calls[0].function.name).toBe(wireName)
    expect(request).not.toHaveProperty('max_tokens')
    expect(result).toEqual([
      { kind: 'tool-call', id: 'call-1', name: 'notes.list', args: { limit: 2 } },
      { kind: 'usage', promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      { kind: 'finish', stopReason: 'tool_use' },
    ])
  })

  it('omits empty tools and an unspecified output-token limit', async () => {
    create.mockResolvedValue(events([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]))

    await collect(
      new OpenAIProvider('openrouter/model', 'key').send({
        system: '',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
      }),
    )

    expect(create.mock.calls[0][0]).not.toHaveProperty('tools')
    expect(create.mock.calls[0][0]).not.toHaveProperty('max_tokens')
  })

  it.each([
    { error: { message: '400 Provider returned error' }, choices: [] },
    { choices: [{ delta: {}, finish_reason: 'error' }] },
  ])('terminates upstream streamed errors without a later success or usage event', async (errorChunk) => {
    create.mockResolvedValue(
      events([
        { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
        errorChunk,
        { choices: [{ delta: { content: 'must not appear' }, finish_reason: 'stop' }] },
        { choices: [], usage: { total_tokens: 99 } },
      ]),
    )

    const result = await collect(new OpenAIProvider('openrouter/model', 'key').send(dottedRequest()))

    expect(result[0]).toEqual({ kind: 'text-delta', delta: 'partial' })
    expect(result.at(-1)).toEqual({ kind: 'finish', stopReason: 'error' })
    expect(result.some((event) => event.kind === 'error')).toBe(true)
    expect(result.some((event) => event.kind === 'usage')).toBe(false)
    expect(result).not.toContainEqual({ kind: 'text-delta', delta: 'must not appear' })
  })
})
