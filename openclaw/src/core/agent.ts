import type { Provider, ChatMessage, AssistantToolCall, ToolDescriptor } from '../providers/types.js'
import type { McpSession } from '../mcp/session.js'
import { SYSTEM_PROMPT } from './prompts.js'
import { log } from '../util/log.js'

export interface AgentOptions {
  provider: Provider
  session: McpSession
  maxSteps?: number
  /** Override the default system prompt. */
  systemPrompt?: string
  /** Stream final assistant text deltas to this writable (typically stdout). */
  onTextDelta?: (chunk: string) => void
}

export interface AgentResult {
  finalText: string
  steps: number
  stopReason: 'end_turn' | 'max_steps' | 'error'
}

export async function run(messages: ChatMessage[], opts: AgentOptions): Promise<AgentResult> {
  const { provider, session } = opts
  const maxSteps = opts.maxSteps ?? 8
  const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT
  const tools = describeToolsForProvider(session.tools())

  const history: ChatMessage[] = [...messages]
  let finalText = ''

  for (let step = 1; step <= maxSteps; step++) {
    log.debug('agent step', { step })
    let assistantText = ''
    const toolCalls: AssistantToolCall[] = []
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop' | 'error' = 'end_turn'

    const stream = provider.send({ system: systemPrompt, messages: history, tools })

    for await (const ev of stream) {
      if (ev.kind === 'text-delta') {
        assistantText += ev.delta
        opts.onTextDelta?.(ev.delta)
      } else if (ev.kind === 'tool-call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
      } else if (ev.kind === 'finish') {
        stopReason = ev.stopReason
      } else if (ev.kind === 'error') {
        log.error('provider error', { message: ev.message })
        return { finalText: assistantText, steps: step, stopReason: 'error' }
      }
    }

    if (toolCalls.length === 0) {
      finalText = assistantText
      return { finalText, steps: step, stopReason: 'end_turn' }
    }

    history.push({ role: 'assistant', content: assistantText, toolCalls })

    for (const tc of toolCalls) {
      try {
        const result = await session.call(tc.name, tc.args)
        history.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          toolCallId: tc.id,
          name: tc.name,
        })
      } catch (err) {
        history.push({
          role: 'tool',
          content: `error: ${String(err)}`,
          toolCallId: tc.id,
          name: tc.name,
        })
      }
    }

    if (stopReason !== 'tool_use') {
      // Provider said we should stop; obey unless we just dispatched tools.
      break
    }
  }

  // Hit max_steps. Force one final summary turn with no tools.
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
  return { finalText, steps: maxSteps, stopReason: 'max_steps' }
}

function describeToolsForProvider(entries: ReturnType<McpSession['tools']>): ToolDescriptor[] {
  return entries.map((t) => ({
    name: t.name,
    description: `[scope=${t.scope}] ${t.description}`,
    inputSchema: t.inputSchema,
  }))
}
