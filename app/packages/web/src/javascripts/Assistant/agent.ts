import {
  AssistantToolCall,
  ChatMessage,
  Provider,
  ProviderStopReason,
  ToolDescriptor,
  ToolSession,
} from './types'

export interface AgentOptions {
  provider: Provider
  session: ToolSession
  maxSteps?: number
  systemPrompt: string
  signal?: AbortSignal
  /** Stream final assistant text deltas (UI rendering). */
  onTextDelta?: (chunk: string) => void
  /** Called when the model requests a tool. */
  onToolCall?: (call: AssistantToolCall) => void
  /** Called with the serialized result of a tool call. */
  onToolResult?: (callId: string, result: string, isError: boolean) => void
  /** Called when the assistant finishes a turn and a new assistant message begins. */
  onAssistantMessage?: (text: string) => void
}

export interface AgentResult {
  finalText: string
  steps: number
  stopReason: 'end_turn' | 'max_steps' | 'error' | 'aborted'
}

export async function run(messages: ChatMessage[], opts: AgentOptions): Promise<AgentResult> {
  const { provider, session } = opts
  const maxSteps = opts.maxSteps ?? 8
  const systemPrompt = opts.systemPrompt
  const tools = describeTools(session.tools())

  const history: ChatMessage[] = [...messages]
  let finalText = ''

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) {
      return { finalText, steps: step, stopReason: 'aborted' }
    }

    let assistantText = ''
    const toolCalls: AssistantToolCall[] = []
    let stopReason: ProviderStopReason = 'end_turn'

    const stream = provider.send({ system: systemPrompt, messages: history, tools })

    for await (const ev of stream) {
      if (opts.signal?.aborted) {
        return { finalText: assistantText, steps: step, stopReason: 'aborted' }
      }
      if (ev.kind === 'text-delta') {
        assistantText += ev.delta
        opts.onTextDelta?.(ev.delta)
      } else if (ev.kind === 'tool-call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
      } else if (ev.kind === 'finish') {
        stopReason = ev.stopReason
      } else if (ev.kind === 'error') {
        return { finalText: ev.message, steps: step, stopReason: 'error' }
      }
    }

    if (assistantText) {
      opts.onAssistantMessage?.(assistantText)
    }

    if (toolCalls.length === 0) {
      finalText = assistantText
      return { finalText, steps: step, stopReason: 'end_turn' }
    }

    history.push({ role: 'assistant', content: assistantText, toolCalls })

    for (const tc of toolCalls) {
      opts.onToolCall?.(tc)
      try {
        const result = await session.call(tc.name, tc.args)
        const serialized = typeof result === 'string' ? result : JSON.stringify(result)
        history.push({ role: 'tool', content: serialized, toolCallId: tc.id, name: tc.name })
        opts.onToolResult?.(tc.id, serialized, false)
      } catch (err) {
        const message = `error: ${err instanceof Error ? err.message : String(err)}`
        history.push({ role: 'tool', content: message, toolCallId: tc.id, name: tc.name })
        opts.onToolResult?.(tc.id, message, true)
      }
    }

    if (stopReason !== 'tool_use') {
      break
    }
  }

  // Hit the step cap. Force one final summary turn with no tools.
  const summaryStream = provider.send({
    system: systemPrompt + '\n\nYou have reached the step cap. Answer with what you have.',
    messages: history,
    tools: [],
  })
  for await (const ev of summaryStream) {
    if (ev.kind === 'text-delta') {
      finalText += ev.delta
      opts.onTextDelta?.(ev.delta)
    }
  }
  if (finalText) {
    opts.onAssistantMessage?.(finalText)
  }
  return { finalText, steps: maxSteps, stopReason: 'max_steps' }
}

function describeTools(entries: ReturnType<ToolSession['tools']>): ToolDescriptor[] {
  return entries.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}
