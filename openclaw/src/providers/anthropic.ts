import Anthropic from '@anthropic-ai/sdk'
import type { Provider, ProviderRequest, ProviderEvent, AssistantToolCall } from './types.js'

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic'
  private readonly client: Anthropic

  constructor(
    private readonly model: string,
    baseURL?: string,
  ) {
    this.client = new Anthropic({ baseURL })
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages = req.messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: m.toolCallId ?? 'unknown',
              content: m.content,
            },
          ],
        }
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
        > = []
        if (m.content) parts.push({ type: 'text', text: m.content })
        for (const tc of m.toolCalls) {
          parts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
        }
        return { role: 'assistant' as const, content: parts }
      }
      return { role: m.role as 'user' | 'assistant', content: m.content }
    })

    const stream = this.client.messages.stream({
      model: this.model,
      system: req.system,
      max_tokens: req.maxOutputTokens ?? 4096,
      messages,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
      })),
    })

    const pendingToolCalls = new Map<number, AssistantToolCall & { argBuf: string }>()

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          if (event.content_block.type === 'tool_use') {
            pendingToolCalls.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              args: {},
              argBuf: '',
            })
          }
          break
        }
        case 'content_block_delta': {
          if (event.delta.type === 'text_delta') {
            yield { kind: 'text-delta', delta: event.delta.text }
          } else if (event.delta.type === 'input_json_delta') {
            const pending = pendingToolCalls.get(event.index)
            if (pending) pending.argBuf += event.delta.partial_json
          }
          break
        }
        case 'content_block_stop': {
          const pending = pendingToolCalls.get(event.index)
          if (pending) {
            try {
              pending.args = pending.argBuf ? (JSON.parse(pending.argBuf) as unknown) : {}
            } catch {
              pending.args = {}
            }
            yield { kind: 'tool-call', id: pending.id, name: pending.name, args: pending.args }
            pendingToolCalls.delete(event.index)
          }
          break
        }
        case 'message_stop': {
          const final = await stream.finalMessage()
          yield { kind: 'finish', stopReason: mapStop(final.stop_reason) }
          return
        }
      }
    }
  }
}

function mapStop(reason: string | null): ProviderEvent extends { stopReason: infer R } ? R : never {
  switch (reason) {
    case 'end_turn':
      return 'end_turn' as never
    case 'max_tokens':
      return 'max_tokens' as never
    case 'tool_use':
      return 'tool_use' as never
    case 'stop_sequence':
      return 'stop' as never
    default:
      return 'end_turn' as never
  }
}
