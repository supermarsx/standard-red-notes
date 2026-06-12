import { ChatMessage, Provider, ProviderEvent, ProviderRequest, ProviderStopReason, ToolDescriptor } from './types'

export interface DirectProviderOptions {
  /** Base URL of an OpenAI-compatible server, e.g. http://localhost:1234/v1 */
  baseURL: string
  /** Model identifier understood by the endpoint. */
  model: string
  /** Optional bearer token. Omitted from the request when empty (LM Studio / Ollama need none). */
  apiKey?: string
  signal?: AbortSignal
}

type OpenAIToolCallAccumulator = {
  id: string
  name: string
  arguments: string
}

/**
 * A Provider that talks DIRECTLY from the browser to any OpenAI-compatible
 * Chat Completions endpoint (LM Studio, Ollama, OpenRouter, OpenAI, or a custom
 * server). It POSTs to `${baseURL}/chat/completions` with `stream: true` and
 * parses the standard OpenAI SSE `data:` frames into ProviderEvents, including
 * tool-calling via the OpenAI `tools` / `tool_calls` schema.
 */
export class DirectProvider implements Provider {
  readonly id = 'direct'

  constructor(private readonly options: DirectProviderOptions) {}

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const url = `${this.options.baseURL.replace(/\/$/, '')}/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.options.apiKey && this.options.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${this.options.apiKey.trim()}`
    }

    const body: Record<string, unknown> = {
      model: this.options.model,
      stream: true,
      messages: this.toOpenAIMessages(req.system, req.messages),
    }

    const tools = this.toOpenAITools(req.tools)
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: this.options.signal,
      })
    } catch (error) {
      yield { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    if (!response.ok || !response.body) {
      let detail = ''
      try {
        detail = await response.text()
      } catch {
        /* ignore */
      }
      yield {
        kind: 'error',
        message: `assistant endpoint: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ''}`,
      }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Accumulate streamed tool_calls keyed by their `index`.
    const toolCallsByIndex = new Map<number, OpenAIToolCallAccumulator>()
    const emittedToolIndexes = new Set<number>()
    let finishReason: string | undefined

    const flushFrames = function* (this: DirectProvider): Generator<ProviderEvent> {
      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        yield* this.parseFrame(frame, toolCallsByIndex, (reason) => {
          finishReason = reason
        })
        separatorIndex = buffer.indexOf('\n\n')
      }
    }.bind(this)

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        yield { kind: 'error', message: error instanceof Error ? error.message : String(error) }
        yield { kind: 'finish', stopReason: 'error' }
        return
      }
      if (chunk.done) {
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      yield* flushFrames()
    }

    // Parse any trailing frame without a separator.
    if (buffer.trim().length > 0) {
      yield* this.parseFrame(buffer, toolCallsByIndex, (reason) => {
        finishReason = reason
      })
    }

    // Emit any tool calls that were assembled across the stream.
    const indexes = [...toolCallsByIndex.keys()].sort((a, b) => a - b)
    let hasToolCalls = false
    for (const index of indexes) {
      if (emittedToolIndexes.has(index)) {
        continue
      }
      const acc = toolCallsByIndex.get(index)
      if (!acc || !acc.name) {
        continue
      }
      hasToolCalls = true
      emittedToolIndexes.add(index)
      let args: unknown = {}
      if (acc.arguments && acc.arguments.trim()) {
        try {
          args = JSON.parse(acc.arguments)
        } catch {
          args = acc.arguments
        }
      }
      yield { kind: 'tool-call', id: acc.id || `call_${index}`, name: acc.name, args }
    }

    yield { kind: 'finish', stopReason: this.mapStopReason(finishReason, hasToolCalls) }
  }

  private *parseFrame(
    frame: string,
    toolCallsByIndex: Map<number, OpenAIToolCallAccumulator>,
    setFinishReason: (reason: string) => void,
  ): Generator<ProviderEvent> {
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) {
        continue
      }
      const data = line.slice(line.startsWith('data: ') ? 6 : 5).trim()
      if (data === '' || data === '[DONE]') {
        continue
      }

      let parsed: {
        choices?: Array<{
          delta?: {
            content?: string | null
            tool_calls?: Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
          finish_reason?: string | null
        }>
        error?: { message?: string }
      }
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      if (parsed.error) {
        yield { kind: 'error', message: parsed.error.message || 'Unknown error from endpoint' }
        continue
      }

      const choice = parsed.choices?.[0]
      if (!choice) {
        continue
      }

      const delta = choice.delta
      if (delta?.content) {
        yield { kind: 'text-delta', delta: delta.content }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0
          const existing = toolCallsByIndex.get(index) ?? { id: '', name: '', arguments: '' }
          if (tc.id) {
            existing.id = tc.id
          }
          if (tc.function?.name) {
            existing.name = tc.function.name
          }
          if (tc.function?.arguments) {
            existing.arguments += tc.function.arguments
          }
          toolCallsByIndex.set(index, existing)
        }
      }

      if (choice.finish_reason) {
        setFinishReason(choice.finish_reason)
      }
    }
  }

  private toOpenAIMessages(system: string, messages: ChatMessage[]): unknown[] {
    const result: unknown[] = []
    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
            },
          })),
        })
        continue
      }

      if (message.role === 'tool') {
        result.push({
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId,
        })
        continue
      }

      result.push({ role: message.role, content: message.content })
    }

    return result
  }

  private toOpenAITools(tools: ToolDescriptor[]): unknown[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }))
  }

  private mapStopReason(finishReason: string | undefined, hasToolCalls: boolean): ProviderStopReason {
    if (hasToolCalls || finishReason === 'tool_calls') {
      return 'tool_use'
    }
    switch (finishReason) {
      case 'length':
        return 'max_tokens'
      case 'stop':
        return 'end_turn'
      default:
        return 'end_turn'
    }
  }
}
