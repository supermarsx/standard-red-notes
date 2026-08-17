import { assistantUsageService } from './AssistantUsageService'
import { assistantHttpError, assistantNetworkError } from './AssistantHttpError'
import { directEndpointConfigurationError, openAICompatibleEndpointURL } from './OpenAICompatibleEndpoint'
import { cleanOpenAIStreamErrorMessage, openAIToolNamesForRequest } from './OpenAIToolNameMap'
import { samplingRequestFields, SamplingSettings } from './samplingSettings'
import { ChatMessage, Provider, ProviderEvent, ProviderRequest, ProviderStopReason, ToolDescriptor } from './types'

export interface DirectProviderOptions {
  /** Base URL of an OpenAI-compatible server, e.g. http://localhost:1234/v1 */
  baseURL: string
  /** Model identifier understood by the endpoint. */
  model: string
  /**
   * Optional bearer token. Omitted from the request when empty (LM Studio /
   * Ollama need none). In OpenAI Codex / ChatGPT subscription mode this is the
   * subscription access token; it is still sent as `Authorization: Bearer`.
   */
  apiKey?: string
  /**
   * Extra headers merged onto every request (e.g. a ChatGPT account id /
   * OpenAI-Beta flag in subscription mode, or any custom header).
   */
  extraHeaders?: Record<string, string>
  /**
   * Sampling parameters (temperature / top_p / max_tokens). When omitted the
   * provider reads the user's saved {@link loadSamplingSettings} values, so
   * callers that don't care about sampling get the configured defaults for free.
   */
  sampling?: SamplingSettings
  signal?: AbortSignal
}

type OpenAIToolCallAccumulator = {
  id: string
  name: string
  arguments: string
}

function normalizeSseBuffer(buffer: string, streamEnded = false): string {
  const hasIncompleteCrLf = !streamEnded && buffer.endsWith('\r')
  const complete = hasIncompleteCrLf ? buffer.slice(0, -1) : buffer
  return complete.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + (hasIncompleteCrLf ? '\r' : '')
}

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
    const configurationError = directEndpointConfigurationError(this.options.baseURL)
    if (configurationError) {
      yield { kind: 'error', message: configurationError }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    let url: string
    try {
      url = openAICompatibleEndpointURL(this.options.baseURL, 'chat/completions')
    } catch (error) {
      yield { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.options.extraHeaders ?? {}),
    }
    if (this.options.apiKey && this.options.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${this.options.apiKey.trim()}`
    }

    const toolNames = openAIToolNamesForRequest(req.tools, req.messages)
    const body: Record<string, unknown> = {
      model: this.options.model,
      stream: true,
      // Ask OpenAI-compatible endpoints to emit a final usage-only chunk so we can
      // surface token consumption in the footer. Endpoints that don't support this
      // simply ignore the option (and report no usage), which we handle gracefully.
      stream_options: { include_usage: true },
      // User-configurable sampling (temperature / top_p / optional max_tokens).
      // Defaults to the saved sampling settings when the caller passes none.
      ...samplingRequestFields(this.options.sampling),
      messages: this.toOpenAIMessages(req.system, req.messages, toolNames.toWireName),
    }
    if (Number.isSafeInteger(req.maxOutputTokens) && (req.maxOutputTokens ?? 0) > 0) {
      const requestedCap = req.maxOutputTokens as number
      const configuredCap = typeof body.max_tokens === 'number' ? body.max_tokens : undefined
      body.max_tokens = configuredCap === undefined ? requestedCap : Math.min(configuredCap, requestedCap)
    }

    const tools = this.toOpenAITools(req.tools, toolNames.toWireName)
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
        signal: req.signal ?? this.options.signal,
      })
    } catch (error) {
      yield { kind: 'error', message: assistantNetworkError(error, 'direct') }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    if (!response.ok || !response.body) {
      yield {
        kind: 'error',
        message: await assistantHttpError(response, 'direct'),
      }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const reader = response.body.getReader()
    const cancelReader = async () => {
      try {
        await reader.cancel()
      } catch {
        // The stream is already terminal; cancellation is best-effort cleanup.
      }
    }
    const decoder = new TextDecoder()
    let buffer = ''

    // Accumulate streamed tool_calls keyed by their `index`.
    const toolCallsByIndex = new Map<number, OpenAIToolCallAccumulator>()
    const emittedToolIndexes = new Set<number>()
    let finishReason: string | undefined
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
    let streamError: string | undefined

    const flushFrames = function* (this: DirectProvider): Generator<ProviderEvent> {
      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        yield* this.parseFrame(
          frame,
          toolCallsByIndex,
          (reason) => {
            finishReason = reason
          },
          (reported) => {
            usage = reported
          },
          (message) => {
            streamError = message
          },
        )
        if (streamError) {
          return
        }
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
        buffer += decoder.decode()
        buffer = normalizeSseBuffer(buffer, true)
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      buffer = normalizeSseBuffer(buffer)
      yield* flushFrames()
      if (streamError) {
        await cancelReader()
        yield { kind: 'finish', stopReason: 'error' }
        return
      }
    }

    // Parse any trailing frame without a separator.
    if (buffer.trim().length > 0) {
      yield* this.parseFrame(
        buffer,
        toolCallsByIndex,
        (reason) => {
          finishReason = reason
        },
        (reported) => {
          usage = reported
        },
        (message) => {
          streamError = message
        },
      )
      if (streamError) {
        await cancelReader()
        yield { kind: 'finish', stopReason: 'error' }
        return
      }
    }

    if (!finishReason) {
      yield {
        kind: 'error',
        message: 'The configured assistant provider ended before reporting a completion reason.',
      }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    // Emit any tool calls that were assembled across the stream.
    const indexes = [...toolCallsByIndex.keys()].sort((a, b) => a - b)
    if (indexes.length > 0 && finishReason !== 'tool_calls') {
      yield {
        kind: 'error',
        message: 'The configured assistant provider returned an incomplete function call. No tools were run.',
      }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }
    if (finishReason === 'tool_calls' && indexes.length === 0) {
      yield { kind: 'error', message: 'The configured assistant provider did not return its function call.' }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const completedToolCalls: Array<Extract<ProviderEvent, { kind: 'tool-call' }>> = []
    for (const index of indexes) {
      if (emittedToolIndexes.has(index)) {
        continue
      }
      const acc = toolCallsByIndex.get(index)
      if (!acc || !acc.name) {
        yield {
          kind: 'error',
          message: 'The configured assistant provider returned malformed function-call arguments.',
        }
        yield { kind: 'finish', stopReason: 'error' }
        return
      }
      const args = parseFunctionArguments(acc.arguments)
      if (!args) {
        yield {
          kind: 'error',
          message: 'The configured assistant provider returned malformed function-call arguments.',
        }
        yield { kind: 'finish', stopReason: 'error' }
        return
      }
      emittedToolIndexes.add(index)
      completedToolCalls.push({
        kind: 'tool-call',
        id: acc.id || `call_${index}`,
        name: toolNames.toInternalName(acc.name),
        args,
      })
    }

    for (const toolCall of completedToolCalls) {
      yield toolCall
    }

    if (usage) {
      const report = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      }
      assistantUsageService.record(report)
      yield { kind: 'usage', ...report }
    } else {
      // No usage reported by the endpoint, but a request still completed — count
      // it so the request tally (and the server cap) stays accurate.
      assistantUsageService.record({})
    }

    yield { kind: 'finish', stopReason: this.mapStopReason(finishReason, completedToolCalls.length > 0) }
  }

  private *parseFrame(
    frame: string,
    toolCallsByIndex: Map<number, OpenAIToolCallAccumulator>,
    setFinishReason: (reason: string) => void,
    setUsage: (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void,
    setStreamError: (message: string) => void,
  ): Generator<ProviderEvent> {
    const dataLines: string[] = []
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.trimEnd()
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5))
      }
    }
    const data = dataLines.join('\n').trim()
    if (data === '' || data === '[DONE]') {
      return
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
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
      error?: { message?: string } | string
    }
    try {
      parsed = JSON.parse(data)
    } catch {
      const message = cleanOpenAIStreamErrorMessage('The configured assistant provider returned malformed stream data.')
      setStreamError(message)
      yield { kind: 'error', message }
      return
    }

    if (parsed.error !== undefined && parsed.error !== null) {
      const message = cleanOpenAIStreamErrorMessage(
        typeof parsed.error === 'string' ? parsed.error : parsed.error.message,
        'Unknown error from endpoint',
      )
      setStreamError(message)
      yield { kind: 'error', message }
      return
    }

    // With stream_options.include_usage the endpoint sends a final chunk that
    // carries `usage` and an empty `choices` array. Capture it before bailing on
    // the missing choice below.
    if (parsed.usage) {
      setUsage(parsed.usage)
    }

    const choice = parsed.choices?.[0]
    if (!choice) {
      return
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
          existing.name = mergeStreamedIdentity(existing.name, tc.function.name)
        }
        if (tc.function?.arguments) {
          existing.arguments += tc.function.arguments
        }
        toolCallsByIndex.set(index, existing)
      }
    }

    if (choice.finish_reason) {
      if (choice.finish_reason === 'error') {
        const message = cleanOpenAIStreamErrorMessage('The configured assistant provider ended with an error.')
        setStreamError(message)
        yield { kind: 'error', message }
        return
      }
      setFinishReason(choice.finish_reason)
    }
  }

  private toOpenAIMessages(
    system: string,
    messages: ChatMessage[],
    toWireName: (internalName: string) => string,
  ): unknown[] {
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
              name: toWireName(tc.name),
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

  private toOpenAITools(tools: ToolDescriptor[], toWireName: (internalName: string) => string): unknown[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: toWireName(tool.name),
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
