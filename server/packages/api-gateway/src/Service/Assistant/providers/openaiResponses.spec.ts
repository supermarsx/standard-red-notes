import OpenAI from 'openai'
import { Buffer } from 'node:buffer'

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
    const reasoningItem = {
      type: 'reasoning' as const,
      id: 'rs_2',
      summary: [],
      encrypted_content: 'encrypted-reasoning-2',
      status: 'completed' as const,
    }
    const messageItem = {
      type: 'message' as const,
      id: 'msg_2',
      role: 'assistant' as const,
      status: 'completed' as const,
      phase: 'final_answer' as const,
      content: [{ type: 'output_text' as const, text: 'Hi', annotations: [], logprobs: [] }],
    }
    const functionItem = {
      type: 'function_call' as const,
      id: 'fc_item_2',
      call_id: 'call_2',
      name: wireName,
      arguments: '{"q":"y"}',
      status: 'completed' as const,
      caller: { type: 'direct' as const },
    }
    create.mockResolvedValue(
      events([
        { type: 'response.output_text.delta', delta: 'Hi' },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'fc_item_2',
            call_id: 'call_2',
            name: wireName,
            arguments: '',
            status: 'in_progress',
          },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_item_2',
          name: wireName,
          arguments: '{"q":"y"}',
        },
        {
          type: 'response.output_item.done',
          output_index: 2,
          item: functionItem,
        },
        {
          type: 'response.completed',
          response: {
            output: [reasoningItem, messageItem, functionItem],
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          },
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
    const controller = new AbortController()
    const result = await collect(provider.send({ ...request, signal: controller.signal }))

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
      { signal: controller.signal },
    )
    expect(result.slice(0, 3)).toEqual([
      { kind: 'text-delta', delta: 'Hi' },
      { kind: 'tool-call', id: 'call_2', name: 'notes.list', args: { q: 'y' } },
      { kind: 'usage', promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    ])
    const finish = result[3]
    expect(finish).toEqual({
      kind: 'finish',
      stopReason: 'tool_use',
      providerReplay: expect.objectContaining({ protocol: 'openai-responses', version: 1 }),
    })
    if (finish?.kind !== 'finish' || !finish.providerReplay) {
      throw new Error('Expected an opaque Responses replay payload')
    }
    const replayOutput = JSON.parse(Buffer.from(finish.providerReplay.encodedOutput, 'base64url').toString('utf8'))
    expect(replayOutput).toEqual([reasoningItem, messageItem, functionItem])
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')

    create.mockResolvedValueOnce(events([{ type: 'response.completed', response: { output: [] } }]))
    await collect(
      provider.send({
        ...request,
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: 'Hi',
            toolCalls: [{ id: 'call_2', name: 'notes.list', args: { q: 'y' } }],
            providerReplay: finish.providerReplay,
          },
          { role: 'tool', toolCallId: 'call_2', content: '{"answer":2}' },
        ],
      }),
    )
    expect(create.mock.calls[1][0].input).toEqual([
      { role: 'user', content: 'Hello' },
      reasoningItem,
      messageItem,
      functionItem,
      { type: 'function_call_output', call_id: 'call_2', output: '{"answer":2}' },
    ])
  })

  it('omits empty tools, tool controls, and an unspecified output-token limit', async () => {
    create.mockResolvedValue(events([{ type: 'response.completed', response: { output: [] } }]))

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

  it('joins an out-of-order function item to its call id and emits it exactly once', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const functionItem = {
      type: 'function_call' as const,
      id: 'fc_out_of_order',
      call_id: 'call_out_of_order',
      name: wireName,
      arguments: '{"q":"late"}',
      status: 'completed' as const,
    }
    create.mockResolvedValue(
      events([
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_out_of_order',
          name: wireName,
          arguments: '{"q":"late"}',
        },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'fc_out_of_order',
            call_id: 'call_out_of_order',
            name: wireName,
            arguments: '',
            status: 'in_progress',
          },
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: functionItem,
        },
        { type: 'response.completed', response: { output: [] } },
      ]),
    )

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result[0]).toEqual({ kind: 'tool-call', id: 'call_out_of_order', name: 'notes.list', args: { q: 'late' } })
    expect(result[1]).toEqual({
      kind: 'finish',
      stopReason: 'tool_use',
      providerReplay: expect.objectContaining({ protocol: 'openai-responses', version: 1 }),
    })
    if (result[1]?.kind !== 'finish' || !result[1].providerReplay) {
      throw new Error('Expected fallback output to become replay state')
    }
    expect(JSON.parse(Buffer.from(result[1].providerReplay.encodedOutput, 'base64url').toString('utf8'))).toEqual([
      functionItem,
    ])
  })

  it('compares streamed and replayed function arguments as canonical parsed JSON', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const functionItem = {
      type: 'function_call' as const,
      id: 'fc_canonical',
      call_id: 'call_canonical',
      name: wireName,
      arguments: '{"limit":2,"query":"notes"}',
      status: 'completed' as const,
    }
    create.mockResolvedValue(
      events([
        {
          type: 'response.output_item.added',
          item: { ...functionItem, arguments: '', status: 'in_progress' },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: functionItem.id,
          name: wireName,
          arguments: '{"query":"notes","limit":2}',
        },
        { type: 'response.completed', response: { output: [functionItem] } },
      ]),
    )

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result[0]).toEqual({
      kind: 'tool-call',
      id: 'call_canonical',
      name: 'notes.list',
      args: { query: 'notes', limit: 2 },
    })
    expect(result.at(-1)).toEqual(
      expect.objectContaining({ kind: 'finish', stopReason: 'tool_use', providerReplay: expect.any(Object) }),
    )
  })

  it('fails closed when streamed and completed function arguments disagree', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const functionItem = {
      type: 'function_call' as const,
      id: 'fc_mismatch',
      call_id: 'call_mismatch',
      name: wireName,
      arguments: '{"query":"completed"}',
      status: 'completed' as const,
    }
    create.mockResolvedValue(
      events([
        {
          type: 'response.output_item.added',
          item: { ...functionItem, arguments: '', status: 'in_progress' },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: functionItem.id,
          name: wireName,
          arguments: '{"query":"streamed"}',
        },
        { type: 'response.completed', response: { output: [functionItem], usage: { total_tokens: 9 } } },
      ]),
    )

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('arguments do not match') }),
      { kind: 'finish', stopReason: 'error' },
    ])
  })

  it('does not expose or execute function calls from an incomplete response', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const functionItem = {
      type: 'function_call' as const,
      id: 'fc_incomplete',
      call_id: 'call_incomplete',
      name: wireName,
      arguments: '{"limit":2}',
      status: 'completed' as const,
    }
    create.mockResolvedValue(
      events([
        { type: 'response.output_item.added', item: { ...functionItem, arguments: '', status: 'in_progress' } },
        {
          type: 'response.function_call_arguments.done',
          item_id: functionItem.id,
          name: wireName,
          arguments: functionItem.arguments,
        },
        { type: 'response.incomplete', response: { output: [functionItem], usage: { total_tokens: 9 } } },
      ]),
    )

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result).toEqual([
      {
        kind: 'error',
        message: 'The configured assistant provider returned an incomplete function call. No tools were run.',
      },
      { kind: 'finish', stopReason: 'error' },
    ])
  })

  it('treats malformed function arguments as a terminal provider error', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    create.mockResolvedValue(
      events([
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'function_call',
                id: 'fc_malformed',
                call_id: 'call_malformed',
                name: wireName,
                arguments: '{"limit":',
                status: 'completed',
              },
            ],
            usage: { total_tokens: 9 },
          },
        },
      ]),
    )

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result).toEqual([
      {
        kind: 'error',
        message: 'The configured assistant provider returned malformed function-call arguments.',
      },
      { kind: 'finish', stopReason: 'error' },
    ])
  })

  it('preserves interleaved reasoning and parallel function calls in exact output order', async () => {
    const wireName = createOpenAIToolNameMap(['notes.list', 'delegate']).toWireName('notes.list')
    const output = [
      {
        type: 'reasoning' as const,
        id: 'rs_parallel_1',
        summary: [],
        encrypted_content: 'encrypted-parallel-1',
        status: 'completed' as const,
      },
      {
        type: 'function_call' as const,
        id: 'fc_parallel_1',
        call_id: 'call_parallel_1',
        name: wireName,
        arguments: '{"limit":1}',
        status: 'completed' as const,
      },
      {
        type: 'reasoning' as const,
        id: 'rs_parallel_2',
        summary: [],
        encrypted_content: 'encrypted-parallel-2',
        status: 'completed' as const,
      },
      {
        type: 'function_call' as const,
        id: 'fc_parallel_2',
        call_id: 'call_parallel_2',
        name: 'delegate',
        arguments: '{"task":"summarize"}',
        status: 'completed' as const,
      },
    ]
    create.mockResolvedValue(events([{ type: 'response.completed', response: { output } }]))

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result.slice(0, 2)).toEqual([
      { kind: 'tool-call', id: 'call_parallel_1', name: 'notes.list', args: { limit: 1 } },
      { kind: 'tool-call', id: 'call_parallel_2', name: 'delegate', args: { task: 'summarize' } },
    ])
    const finish = result[2]
    if (finish?.kind !== 'finish' || !finish.providerReplay) {
      throw new Error('Expected parallel output replay state')
    }
    expect(JSON.parse(Buffer.from(finish.providerReplay.encodedOutput, 'base64url').toString('utf8'))).toEqual(output)
  })

  it.each([
    ['missing encrypted reasoning', { type: 'reasoning', id: 'rs_missing', summary: [], status: 'completed' }],
    [
      'plaintext reasoning',
      {
        type: 'reasoning',
        id: 'rs_plaintext',
        summary: [],
        encrypted_content: 'encrypted',
        content: [{ type: 'reasoning_text', text: 'SECRET_COT' }],
        status: 'completed',
      },
    ],
    [
      'plaintext reasoning in an unknown field',
      {
        type: 'reasoning',
        id: 'rs_unknown_plaintext',
        summary: [],
        encrypted_content: 'encrypted',
        raw_reasoning: 'SECRET_COT',
        status: 'completed',
      },
    ],
    [
      'non-array plaintext reasoning content',
      {
        type: 'reasoning',
        id: 'rs_string_plaintext',
        summary: [],
        encrypted_content: 'encrypted',
        content: 'SECRET_COT',
        status: 'completed',
      },
    ],
    ['unsupported output', { type: 'computer_call', id: 'computer_1', status: 'completed' }],
  ])('fails closed on %s instead of emitting an unusable tool continuation', async (_label, outputItem) => {
    const wireName = createOpenAIToolNameMap(['notes.list']).toWireName('notes.list')
    const functionItem = {
      type: 'function_call',
      id: 'fc_unsafe',
      call_id: 'call_unsafe',
      name: wireName,
      arguments: '{}',
      status: 'completed',
    }
    create.mockResolvedValue(events([{ type: 'response.completed', response: { output: [outputItem, functionItem] } }]))

    const result = await collect(new OpenAIResponsesProvider('gpt-test', 'key').send(request))

    expect(result.at(-1)).toEqual({ kind: 'finish', stopReason: 'error' })
    expect(result.some((event) => event.kind === 'error')).toBe(true)
    expect(result.some((event) => event.kind === 'tool-call')).toBe(false)
    expect(result.some((event) => event.kind === 'usage')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('SECRET_COT')
  })

  it.each([
    ['malformed base64url', 'not*base64url', 'call_1'],
    ['oversized payload', 'A'.repeat(8 * 1024 * 1024 + 1), 'call_1'],
    [
      'mismatched function call',
      Buffer.from(
        JSON.stringify([
          {
            type: 'function_call',
            id: 'fc_other',
            call_id: 'call_other',
            name: createOpenAIToolNameMap(['notes.list']).toWireName('notes.list'),
            arguments: '{}',
            status: 'completed',
          },
        ]),
        'utf8',
      ).toString('base64url'),
      'call_1',
    ],
  ])('rejects %s replay before contacting the upstream', async (_label, encodedOutput, callId) => {
    const result = await collect(
      new OpenAIResponsesProvider('gpt-test', 'key').send({
        ...request,
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: callId, name: 'notes.list', args: {} }],
            providerReplay: { protocol: 'openai-responses', version: 1, encodedOutput },
          },
          { role: 'tool', toolCallId: callId, content: '{}' },
        ],
      }),
    )

    expect(result.at(-1)).toEqual({ kind: 'finish', stopReason: 'error' })
    expect(result.some((event) => event.kind === 'error')).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects replay whose function arguments differ from the browser tool turn', async () => {
    const encodedOutput = Buffer.from(
      JSON.stringify([
        {
          type: 'function_call',
          id: 'fc_arguments',
          call_id: 'call_1',
          name: createOpenAIToolNameMap(['notes.list']).toWireName('notes.list'),
          arguments: '{"query":"trusted"}',
          status: 'completed',
        },
      ]),
      'utf8',
    ).toString('base64url')

    const result = await collect(
      new OpenAIResponsesProvider('gpt-test', 'key').send({
        ...request,
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'notes.list', args: { query: 'tampered' } }],
            providerReplay: { protocol: 'openai-responses', version: 1, encodedOutput },
          },
          { role: 'tool', toolCallId: 'call_1', content: '{}' },
        ],
      }),
    )

    expect(result.at(-1)).toEqual({ kind: 'finish', stopReason: 'error' })
    expect(result).toContainEqual(
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('arguments') }),
    )
    expect(create).not.toHaveBeenCalled()
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
