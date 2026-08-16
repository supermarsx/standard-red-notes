import OpenAI from 'openai'

import { Provider, ProviderRequest, ProviderEvent } from './types'
import { openAIStreamErrorMessage, openAIToolNamesForRequest } from './OpenAIToolNameMap'

export class OpenAIProvider implements Provider {
  readonly id = 'openai'
  private readonly client: OpenAI

  constructor(
    private readonly model: string,
    apiKey: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>,
    timeoutMs?: number,
    maxRetries?: number,
  ) {
    // defaultHeaders carries the Codex/ChatGPT subscription extras (account id,
    // OpenAI-Beta, any custom headers). Empty in the default API-key path.
    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: defaultHeaders && Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
      timeout: timeoutMs,
      maxRetries,
    })
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const toolNames = openAIToolNamesForRequest(req.tools, req.messages)
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
              function: { name: toolNames.toWireName(tc.name), arguments: JSON.stringify(tc.args) },
            })),
          }
        }
        return { role: m.role as 'user' | 'assistant', content: m.content }
      }),
    ]

    const tools = req.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: toolNames.toWireName(tool.name),
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }))
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
      temperature: req.temperature,
      top_p: req.topP,
      stop: req.stop,
      ...(tools.length > 0 ? { tools } : {}),
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
      const streamError = openAIStreamErrorMessage(chunk)
      if (streamError) {
        yield { kind: 'error', message: streamError }
        yield { kind: 'finish', stopReason: 'error' }
        return
      }
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
      if ((choice.finish_reason as string | null) === 'error') {
        yield { kind: 'error', message: 'The configured assistant provider ended with an error.' }
        yield { kind: 'finish', stopReason: 'error' }
        return
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
          yield { kind: 'tool-call', id: p.id, name: toolNames.toInternalName(p.name), args }
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
