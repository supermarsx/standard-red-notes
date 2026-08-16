import OpenAI from 'openai'

import { Provider, ProviderRequest, ProviderEvent } from './types'
import { openAIStreamErrorMessage, openAIToolNamesForRequest } from './OpenAIToolNameMap'

function mergeStreamedIdentity(current: string, next: string): string {
  if (!current || next.startsWith(current)) {
    return next
  }
  return current.endsWith(next) ? current : current + next
}

function parseFunctionArguments(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

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
    const stream = await this.client.chat.completions.create(
      {
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
      },
      { signal: req.signal },
    )

    const pendingTools = new Map<number, { id: string; name: string; argBuf: string }>()
    let usage: ProviderEvent | undefined
    // The model's finish event is deferred so that, when stream_options.include_usage
    // is honoured, the trailing usage-only chunk (which arrives AFTER finish_reason)
    // is emitted before the final 'finish'. The browser ends its read on 'finish'.
    let finish: ProviderEvent | undefined
    let completedToolCalls: Array<Extract<ProviderEvent, { kind: 'tool-call' }>> = []

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
        if (tc.id) {
          pending.id = tc.id
        }
        if (tc.function?.name) {
          pending.name = mergeStreamedIdentity(pending.name, tc.function.name)
        }
        if (tc.function?.arguments) {
          pending.argBuf += tc.function.arguments
        }
      }

      if (choice.finish_reason && !finish) {
        if (pendingTools.size > 0 && choice.finish_reason !== 'tool_calls') {
          yield {
            kind: 'error',
            message: 'The configured assistant provider returned an incomplete function call. No tools were run.',
          }
          yield { kind: 'finish', stopReason: 'error' }
          return
        }
        if (choice.finish_reason === 'tool_calls' && pendingTools.size === 0) {
          yield { kind: 'error', message: 'The configured assistant provider did not return its function call.' }
          yield { kind: 'finish', stopReason: 'error' }
          return
        }

        completedToolCalls = []
        for (const [, pending] of pendingTools) {
          const args = parseFunctionArguments(pending.argBuf)
          if (!pending.name || !args) {
            yield {
              kind: 'error',
              message: 'The configured assistant provider returned malformed function-call arguments.',
            }
            yield { kind: 'finish', stopReason: 'error' }
            return
          }
          completedToolCalls.push({
            kind: 'tool-call',
            id: pending.id,
            name: toolNames.toInternalName(pending.name),
            args,
          })
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

    if (!finish) {
      yield {
        kind: 'error',
        message: 'The configured assistant provider ended before reporting a completion reason.',
      }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }
    for (const toolCall of completedToolCalls) {
      yield toolCall
    }
    if (usage) {
      yield usage
    }
    yield finish
  }
}
