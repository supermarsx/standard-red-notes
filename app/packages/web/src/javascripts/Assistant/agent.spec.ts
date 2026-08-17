import { run, AgentControl } from './agent'
import { ChatMessage, Provider, ProviderEvent, ToolDefinition, ToolSession } from './types'

/**
 * A provider whose output is scripted per step. Each script entry receives the
 * messages the agent sent for that step (so a test can assert on injected
 * steering) and returns the events to stream back.
 */
class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  step = 0
  readonly seenMessages: ChatMessage[][] = []

  constructor(private readonly script: Array<(messages: ChatMessage[]) => ProviderEvent[]>) {}

  async *send(req: { messages: ChatMessage[] }): AsyncIterable<ProviderEvent> {
    this.seenMessages.push(req.messages.map((m) => ({ ...m })))
    const fn = this.script[this.step] ?? (() => [{ kind: 'finish', stopReason: 'end_turn' } as ProviderEvent])
    this.step++
    for (const ev of fn(req.messages)) {
      yield ev
    }
  }
}

class RecordingSession implements ToolSession {
  readonly calls: Array<{ name: string; args: unknown }> = []
  tools(): ToolDefinition[] {
    return [{ name: 'echo', description: 'echo', mutating: false, inputSchema: { type: 'object' } }]
  }
  async call(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ name, args })
    return { ok: true }
  }
}

describe('run() steering', () => {
  it('consumes steering that arrives during a terminal stream exactly once', async () => {
    const provider = new ScriptedProvider([
      () => [
        { kind: 'text-delta', delta: 'first answer' },
        { kind: 'finish', stopReason: 'end_turn' },
      ],
      () => [
        { kind: 'text-delta', delta: 'revised answer' },
        { kind: 'finish', stopReason: 'end_turn' },
      ],
    ])
    let supplied = false
    const injected: string[] = []
    const control: AgentControl = {
      drainSteers: () => {
        if (provider.step === 1 && !supplied) {
          supplied = true
          return ['focus on the current note']
        }
        return []
      },
    }

    const result = await run([{ role: 'user', content: 'summarize' }], {
      provider,
      session: new RecordingSession(),
      systemPrompt: 'sys',
      control,
      onSteer: (text) => injected.push(text),
    })

    expect(result).toEqual({ finalText: 'revised answer', steps: 2, stopReason: 'end_turn' })
    expect(injected).toEqual(['focus on the current note'])
    expect(provider.seenMessages[1]).toEqual([
      { role: 'user', content: 'summarize' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'focus on the current note' },
    ])
    expect(control.drainSteers()).toEqual([])
  })

  it('supersedes a pending tool turn when a steer arrives before execution', async () => {
    const provider = new ScriptedProvider([
      () => [
        { kind: 'text-delta', delta: 'I will update the note.' },
        { kind: 'tool-call', id: 't1', name: 'echo', args: {} },
        { kind: 'finish', stopReason: 'tool_use' },
      ],
      () => [
        { kind: 'text-delta', delta: 'done' },
        { kind: 'finish', stopReason: 'end_turn' },
      ],
    ])

    // The user steers only after the first step has started.
    let drainCount = 0
    const control: AgentControl = {
      drainSteers: () => {
        drainCount += 1
        return drainCount === 2 ? ['use British spelling'] : []
      },
    }

    const injected: string[] = []
    const session = new RecordingSession()
    const result = await run([{ role: 'user', content: 'write a note' }], {
      provider,
      session,
      systemPrompt: 'sys',
      control,
      onSteer: (text) => injected.push(text),
    })

    expect(result.stopReason).toBe('end_turn')
    expect(injected).toEqual(['use British spelling'])
    expect(session.calls).toEqual([])
    // The second model call must have received the steer as a user message.
    const secondCall = provider.seenMessages[1]
    expect(secondCall).toContainEqual({ role: 'assistant', content: 'I will update the note.' })
    expect(secondCall.some((m) => m.role === 'user' && m.content === 'use British spelling')).toBe(true)
    expect(secondCall.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(false)
  })

  it('skips remaining calls when a steer arrives during an earlier tool', async () => {
    const provider = new ScriptedProvider([
      () => [
        { kind: 'tool-call', id: 't1', name: 'first', args: {} },
        { kind: 'tool-call', id: 't2', name: 'stale-second', args: {} },
        { kind: 'finish', stopReason: 'tool_use' },
      ],
      () => [
        { kind: 'text-delta', delta: 'corrected' },
        { kind: 'finish', stopReason: 'end_turn' },
      ],
    ])
    let drains = 0
    const control: AgentControl = {
      drainSteers: () => (++drains === 3 ? ['do not run the second action'] : []),
    }
    const session = new RecordingSession()
    const outcomes: Array<{ id: string; outcome: string }> = []

    const result = await run([{ role: 'user', content: 'do two things' }], {
      provider,
      session,
      systemPrompt: 'sys',
      control,
      onToolResult: (id, _result, outcome) => outcomes.push({ id, outcome }),
    })

    expect(result.finalText).toBe('corrected')
    expect(session.calls.map((call) => call.name)).toEqual(['first'])
    expect(outcomes).toContainEqual({ id: 't2', outcome: 'denied' })
    expect(provider.seenMessages[1]).toContainEqual({
      role: 'user',
      content: 'do not run the second action',
    })
    expect(provider.seenMessages[1]).toContainEqual(
      expect.objectContaining({ role: 'tool', toolCallId: 't2', name: 'stale-second' }),
    )
  })

  it('ignores empty/whitespace steers', async () => {
    const provider = new ScriptedProvider([
      () => [
        { kind: 'tool-call', id: 't1', name: 'echo', args: {} },
        { kind: 'finish', stopReason: 'tool_use' },
      ],
      () => [{ kind: 'finish', stopReason: 'end_turn' }],
    ])
    const control: AgentControl = { drainSteers: () => ['   '] }
    const injected: string[] = []
    await run([{ role: 'user', content: 'hi' }], {
      provider,
      session: new RecordingSession(),
      systemPrompt: 'sys',
      control,
      onSteer: (t) => injected.push(t),
    })
    expect(injected).toEqual([])
  })

  it('carries opaque provider replay only into the next model turn', async () => {
    const providerReplay = {
      protocol: 'openai-responses' as const,
      version: 1 as const,
      encodedOutput: 'b3BhcXVl',
    }
    const provider = new ScriptedProvider([
      () => [
        { kind: 'tool-call', id: 't1', name: 'echo', args: { value: 1 } },
        { kind: 'finish', stopReason: 'tool_use', providerReplay },
      ],
      () => [
        { kind: 'text-delta', delta: 'done' },
        { kind: 'finish', stopReason: 'end_turn' },
      ],
    ])
    const assistantText: string[] = []
    const toolResults: string[] = []

    await run([{ role: 'user', content: 'use a tool' }], {
      provider,
      session: new RecordingSession(),
      systemPrompt: 'sys',
      onAssistantMessage: (text) => assistantText.push(text),
      onToolResult: (_id, result) => toolResults.push(result),
    })

    const secondTurn = provider.seenMessages[1]
    expect(secondTurn).toEqual([
      { role: 'user', content: 'use a tool' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'echo', args: { value: 1 } }],
        providerReplay,
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 't1', name: 'echo' },
    ])
    expect(assistantText).toEqual(['done'])
    expect(toolResults).toEqual(['{"ok":true}'])
    expect(JSON.stringify({ assistantText, toolResults })).not.toContain(providerReplay.encodedOutput)
  })

  it('reports a declined tool as denied rather than completed', async () => {
    const provider = new ScriptedProvider([
      () => [
        { kind: 'tool-call', id: 'denied-call', name: 'echo', args: {} },
        { kind: 'finish', stopReason: 'tool_use' },
      ],
      () => [{ kind: 'finish', stopReason: 'end_turn' }],
    ])
    const outcomes: string[] = []
    const session: ToolSession = {
      tools: () => [{ name: 'echo', description: 'echo', mutating: true, inputSchema: { type: 'object' } }],
      call: async (_name, _args, callId) => {
        expect(callId).toBe('denied-call')
        return { ok: false, cancelled: true }
      },
    }

    await run([{ role: 'user', content: 'try it' }], {
      provider,
      session,
      systemPrompt: 'sys',
      onToolResult: (_id, _result, outcome) => outcomes.push(outcome),
    })

    expect(outcomes).toEqual(['denied'])
  })

  it('never executes tool calls from a turn the provider did not complete as tool use', async () => {
    const provider = new ScriptedProvider([
      () => [
        { kind: 'tool-call', id: 'partial-call', name: 'echo', args: { destructive: true } },
        { kind: 'finish', stopReason: 'max_tokens' },
      ],
    ])
    const session = new RecordingSession()
    const observedToolCalls: string[] = []

    const result = await run([{ role: 'user', content: 'use a tool' }], {
      provider,
      session,
      systemPrompt: 'sys',
      onToolCall: (call) => observedToolCalls.push(call.id),
    })

    expect(result).toEqual({
      finalText: 'The assistant provider returned tool calls without completing a tool-use turn. No tools were run.',
      steps: 1,
      stopReason: 'error',
    })
    expect(session.calls).toEqual([])
    expect(observedToolCalls).toEqual([])
    expect(provider.step).toBe(1)
  })
})

describe('run() interrupt', () => {
  it('returns stopReason "aborted" when the signal is already aborted', async () => {
    const provider = new ScriptedProvider([() => [{ kind: 'finish', stopReason: 'end_turn' }]])
    const controller = new AbortController()
    controller.abort()
    const result = await run([{ role: 'user', content: 'hi' }], {
      provider,
      session: new RecordingSession(),
      systemPrompt: 'sys',
      signal: controller.signal,
    })
    expect(result.stopReason).toBe('aborted')
  })

  it('does not start a later tool when Stop arrives during an awaited tool', async () => {
    let finishFirstTool: ((value: unknown) => void) | undefined
    let markToolStarted: (() => void) | undefined
    const firstTool = new Promise<unknown>((resolve) => {
      finishFirstTool = resolve
    })
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve
    })
    const session: ToolSession & { calls: string[] } = {
      calls: [],
      tools: () => [{ name: 'echo', description: 'echo', mutating: false, inputSchema: { type: 'object' } }],
      call(name) {
        this.calls.push(name)
        markToolStarted?.()
        return this.calls.length === 1 ? firstTool : Promise.resolve({ ok: true })
      },
    }
    const provider = new ScriptedProvider([
      () => [
        { kind: 'tool-call', id: 'first', name: 'echo', args: { order: 1 } },
        { kind: 'tool-call', id: 'second', name: 'echo', args: { order: 2 } },
        { kind: 'finish', stopReason: 'tool_use' },
      ],
    ])
    const controller = new AbortController()
    const outcomes: Array<{ id: string; outcome: string; result: string }> = []

    const resultPromise = run([{ role: 'user', content: 'run both' }], {
      provider,
      session,
      systemPrompt: 'sys',
      signal: controller.signal,
      onToolResult: (id, result, outcome) => outcomes.push({ id, result, outcome }),
    })
    await toolStarted
    expect(session.calls).toEqual(['echo'])

    controller.abort()
    finishFirstTool?.({ ok: true })

    await expect(resultPromise).resolves.toEqual({ finalText: '', steps: 1, stopReason: 'aborted' })
    expect(session.calls).toEqual(['echo'])
    expect(outcomes).toEqual([{ id: 'first', result: '{"ok":true}', outcome: 'succeeded' }])
  })

  it('enforces the wall-clock deadline while a provider stream is stalled', async () => {
    jest.useFakeTimers()
    try {
      let transportSignal: AbortSignal | undefined
      const provider: Provider = {
        id: 'never-finishes',
        send: (providerRequest) => {
          transportSignal = providerRequest.signal
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<IteratorResult<ProviderEvent>>(() => undefined),
              return: async () => ({ done: true, value: undefined }),
            }),
          }
        },
      }

      const resultPromise = run([{ role: 'user', content: 'wait forever' }], {
        provider,
        session: new RecordingSession(),
        systemPrompt: 'sys',
        maxRunTimeMs: 50,
      })
      await jest.advanceTimersByTimeAsync(50)

      expect(transportSignal?.aborted).toBe(true)
      await expect(resultPromise).resolves.toEqual({
        finalText: 'The assistant stopped after reaching the run-time limit.',
        steps: 1,
        stopReason: 'time_limit',
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('blocks the next provider/tool boundary when a background timer is delayed past deadline', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(1_000)
    try {
      const provider = new ScriptedProvider([
        () => [
          { kind: 'tool-call', id: 'first', name: 'echo', args: {} },
          { kind: 'finish', stopReason: 'tool_use' },
        ],
        () => [
          { kind: 'text-delta', delta: 'must not run' },
          { kind: 'finish', stopReason: 'end_turn' },
        ],
      ])
      const session: ToolSession & { calls: string[] } = {
        calls: [],
        tools: () => [{ name: 'echo', description: 'echo', mutating: false, inputSchema: { type: 'object' } }],
        async call(name) {
          this.calls.push(name)
          // Simulate resuming in a background tab after the deadline while the
          // scheduled timeout callback itself remains throttled and unrun.
          jest.setSystemTime(1_200)
          return { ok: true }
        },
      }

      const result = await run([{ role: 'user', content: 'use the tool' }], {
        provider,
        session,
        systemPrompt: 'sys',
        maxRunTimeMs: 100,
      })

      expect(result).toEqual({
        finalText: 'The assistant stopped after reaching the run-time limit.',
        steps: 1,
        stopReason: 'time_limit',
      })
      expect(session.calls).toEqual(['echo'])
      expect(provider.step).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('run() terminal provider state', () => {
  it('preserves max_tokens for a completed no-tool turn', async () => {
    const provider = new ScriptedProvider([
      () => [
        { kind: 'text-delta', delta: 'partial answer' },
        { kind: 'finish', stopReason: 'max_tokens' },
      ],
    ])
    const assistantMessages: string[] = []

    const result = await run([{ role: 'user', content: 'explain' }], {
      provider,
      session: new RecordingSession(),
      systemPrompt: 'sys',
      onAssistantMessage: (message) => assistantMessages.push(message),
    })

    expect(result).toEqual({ finalText: 'partial answer', steps: 1, stopReason: 'max_tokens' })
    expect(assistantMessages).toEqual(['partial answer'])
  })

  it('fails once when a no-tool stream ends without a terminal finish', async () => {
    const provider = new ScriptedProvider([() => [{ kind: 'text-delta', delta: 'uncommitted partial' }]])
    const assistantMessages: string[] = []

    const result = await run([{ role: 'user', content: 'explain' }], {
      provider,
      session: new RecordingSession(),
      systemPrompt: 'sys',
      onAssistantMessage: (message) => assistantMessages.push(message),
    })

    expect(result).toEqual({
      finalText: 'The assistant provider ended before reporting a completion reason.',
      steps: 1,
      stopReason: 'error',
    })
    expect(assistantMessages).toEqual([])
    expect(provider.step).toBe(1)
  })
})
