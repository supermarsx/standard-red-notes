import OpenAI from 'openai'

import { Provider, ProviderRequest, ProviderEvent } from './types'

export class OpenAIProvider implements Provider {
  readonly id = 'openai'
  private readonly client: OpenAI

  constructor(
    private readonly model: string,
    apiKey: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>,
  ) {
    // defaultHeaders carries the Codex/ChatGPT subscription extras (account id,
    // OpenAI-Beta, any custom headers). Empty in the default API-key path.
    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: defaultHeaders && Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    })
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      ...req.messages.map((m): OpenAI.ChatCompletionMessageParam => {
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
      // Emit a final usage-only chunk so the proxy can forward token consumption
      // to the browser footer. Upstreams that don't support it ignore the option.
      stream_options: { include_usage: true },
    })

    const pendingTools = new Map<number, { id: string; name: string; argBuf: string }>()
    let usage: ProviderEvent | undefined
    // The model's finish event is deferred so that, when stream_options.include_usage
    // is honoured, the trailing usage-only chunk (which arrives AFTER finish_reason)
    // is emitted before the final 'finish'. The browser ends its read on 'finish'.
    let finish: ProviderEvent | undefined

    for await (const chunk of stream) {
      // The include_usage final chunk carries `usage` and an empty `choices`.
      if (chunk.usage && !usage) {
        usage = {
          kind: 'usage',
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        }
      }

      const choice = chunk.choices[0]
      if (!choice) {
        continue
      }
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
        if (tc.function?.arguments) {
          pending.argBuf += tc.function.arguments
        }
      }

      if (choice.finish_reason && !finish) {
        for (const [, p] of pendingTools) {
          let args: unknown = {}
          try {
            args = p.argBuf ? JSON.parse(p.argBuf) : {}
          } catch {
            args = {}
          }
          yield { kind: 'tool-call', id: p.id, name: p.name, args }
        }
        finish = {
          kind: 'finish',
          stopReason:
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
                : 'end_turn',
        }
        // Don't return: keep draining so a trailing usage chunk is captured.
      }
    }

    if (usage) {
      yield usage
    }
    yield finish ?? { kind: 'finish', stopReason: 'end_turn' }
  }
}
