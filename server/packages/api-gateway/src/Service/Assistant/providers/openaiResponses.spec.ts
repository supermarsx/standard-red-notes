import OpenAI from 'openai'

import { OpenAIResponsesProvider } from './openaiResponses'
import { ProviderEvent, ProviderRequest } from './types'

jest.mock('openai')

const create = jest.fn()
const OpenAIMock = OpenAI as unknown as jest.Mock

const request: ProviderRequest = {
  system: 'Keep it brief.',
  messages: [
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'lookup', args: { q: 'x' } }],
    },
    { role: 'tool', toolCallId: 'call_1', content: '{"answer":1}' },
  ],
  tools: [{ name: 'lookup', description: 'Looks up data', inputSchema: { type: 'object' } }],
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 321,
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

function events(items: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items
    },
  }
}

describe('OpenAIResponsesProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    OpenAIMock.mockImplementation((options: unknown) => ({ responses: { create }, options }))
  })

  it('uses the Responses wire contract and maps tools, sampling, usage, and completion', async () => {
    create.mockResolvedValue(
      events([
        { type: 'response.output_text.delta', delta: 'Hi' },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'call_2',
          name: 'lookup',
          arguments: '{"q":"y"}',
        },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } },
        },
      ]),
    )

    const provider = new OpenAIResponsesProvider(
      'gpt-test',
      'SECRET_SENTINEL',
      'https://chatgpt.test/backend-api/codex',
      { 'ChatGPT-Account-ID': 'acct' },
      5_000,
      1,
    )
    const result = await collect(provider.send(request))

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-test',
        instructions: 'Keep it brief.',
        stream: true,
        store: false,
        temperature: 0.2,
        top_p: 0.9,
        max_output_tokens: 321,
        tools: [
          expect.objectContaining({ type: 'function', name: 'lookup', description: 'Looks up data', strict: false }),
        ],
        input: expect.arrayContaining([
          { role: 'user', content: 'Hello' },
          { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{"answer":1}' },
        ]),
      }),
    )
    expect(result).toEqual([
      { kind: 'text-delta', delta: 'Hi' },
      { kind: 'tool-call', id: 'call_2', name: 'lookup', args: { q: 'y' } },
      { kind: 'usage', promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      { kind: 'finish', stopReason: 'end_turn' },
    ])
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')
  })

  it('maps failed and unexpectedly truncated streams to non-success terminal events', async () => {
    create.mockResolvedValueOnce(
      events([{ type: 'response.failed', response: { error: { message: 'bad request' } } }]),
    )
    const provider = new OpenAIResponsesProvider('gpt-test', 'key')
    await expect(collect(provider.send(request))).resolves.toEqual([
      { kind: 'error', message: 'bad request' },
      { kind: 'finish', stopReason: 'error' },
    ])

    create.mockResolvedValueOnce(events([{ type: 'response.output_text.delta', delta: 'partial' }]))
    await expect(collect(provider.send(request))).resolves.toEqual([
      { kind: 'text-delta', delta: 'partial' },
      { kind: 'error', message: 'The configured assistant provider ended without completing the response.' },
      { kind: 'finish', stopReason: 'error' },
    ])
  })
})
