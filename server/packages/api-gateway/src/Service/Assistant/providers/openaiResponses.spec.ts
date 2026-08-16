import OpenAI from 'openai'

import { OpenAIResponsesProvider } from './openaiResponses'
import { createOpenAIToolNameMap } from './OpenAIToolNameMap'
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
      toolCalls: [{ id: 'call_1', name: 'notes.list', args: { q: 'x' } }],
    },
    { role: 'tool', toolCallId: 'call_1', content: '{"answer":1}' },
  ],
  tools: [{ name: 'notes.list', description: 'Looks up data', inputSchema: { type: 'object' } }],
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
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    create.mockResolvedValue(
      events([
        { type: 'response.output_text.delta', delta: 'Hi' },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'call_2',
          name: wireName,
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
          expect.objectContaining({ type: 'function', name: wireName, description: 'Looks up data', strict: false }),
        ],
        input: expect.arrayContaining([
          { role: 'user', content: 'Hello' },
          { type: 'function_call', call_id: 'call_1', name: wireName, arguments: '{"q":"x"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{"answer":1}' },
        ]),
      }),
    )
    expect(result).toEqual([
      { kind: 'text-delta', delta: 'Hi' },
      { kind: 'tool-call', id: 'call_2', name: 'notes.list', args: { q: 'y' } },
      { kind: 'usage', promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      { kind: 'finish', stopReason: 'end_turn' },
    ])
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')
  })

  it('omits empty tools, tool controls, and an unspecified output-token limit', async () => {
    create.mockResolvedValue(events([{ type: 'response.completed', response: {} }]))

    await collect(
      new OpenAIResponsesProvider('gpt-test', 'key').send({
        system: '',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
      }),
    )

    const sent = create.mock.calls[0][0]
    expect(sent).not.toHaveProperty('tools')
    expect(sent).not.toHaveProperty('tool_choice')
    expect(sent).not.toHaveProperty('parallel_tool_calls')
    expect(sent).not.toHaveProperty('max_output_tokens')
  })

  it('terminates a top-level streamed provider error without later success or usage', async () => {
    create.mockResolvedValue(
      events([
        { type: 'response.output_text.delta', delta: 'partial' },
        { error: { message: '400 Provider returned error' } },
        { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } } },
      ]),
    )

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result).toEqual([
      { kind: 'text-delta', delta: 'partial' },
      { kind: 'error', message: '400 Provider returned error' },
      { kind: 'finish', stopReason: 'error' },
    ])
  })

  it('maps failed and unexpectedly truncated streams to non-success terminal events', async () => {
    create.mockResolvedValueOnce(events([{ type: 'response.failed', response: { error: { message: 'bad request' } } }]))
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
