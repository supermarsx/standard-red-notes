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
  it('injects a queued steer message as a user turn before the next step', async () => {
    // Step 0 makes a tool call (loop continues); step 1 should see the steer.
    const provider = new ScriptedProvider([
      () => [
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
    const result = await run([{ role: 'user', content: 'write a note' }], {
      provider,
      session: new RecordingSession(),
      systemPrompt: 'sys',
      control,
      onSteer: (text) => injected.push(text),
    })

    expect(result.stopReason).toBe('end_turn')
    expect(injected).toEqual(['use British spelling'])
    // The second model call must have received the steer as a user message.
    const secondCall = provider.seenMessages[1]
    expect(secondCall.some((m) => m.role === 'user' && m.content === 'use British spelling')).toBe(true)
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
})
