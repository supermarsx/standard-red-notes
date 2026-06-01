import OpenAI from 'openai'
import type { Provider, ProviderRequest, ProviderEvent } from './types.js'

export class OpenAIProvider implements Provider {
  readonly id = 'openai'
  private readonly client: OpenAI

  constructor(
    private readonly model: string,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ baseURL })
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      ...req.messages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'tool' as const,
            tool_call_id: m.toolCallId ?? 'unknown',
            content: m.content,
          }
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant' as const,
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          }
        }
        return { role: m.role as 'user' | 'assistant', content: m.content }
      }),
    ]

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: req.maxOutputTokens ?? 4096,
      stop: req.stop,
      tools: req.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        },
      })),
      stream: true,
    })

    const pendingTools = new Map<number, { id: string; name: string; argBuf: string }>()

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta

      if (delta.content) {
        yield { kind: 'text-delta', delta: delta.content }
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index
        let pending = pendingTools.get(idx)
        if (!pending) {
          pending = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', argBuf: '' }
          pendingTools.set(idx, pending)
        }
        if (tc.function?.arguments) pending.argBuf += tc.function.arguments
      }

      if (choice.finish_reason) {
        for (const [, p] of pendingTools) {
          let args: unknown = {}
          try {
            args = p.argBuf ? JSON.parse(p.argBuf) : {}
          } catch {
            args = {}
          }
          yield { kind: 'tool-call', id: p.id, name: p.name, args }
        }
        yield {
          kind: 'finish',
          stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
        }
        return
      }
    }
  }
}
