import OpenAI from 'openai'

import { ChatMessage, Provider, ProviderEvent, ProviderRequest } from './types'

/**
 * OpenAI Responses transport used by ChatGPT/Codex subscription backends and
 * optionally by modern OpenAI-compatible API-key profiles. It intentionally
 * keeps conversation state client-owned (`store: false`) because note content
 * is end-to-end encrypted and the browser already sends the complete turn.
 */
export class OpenAIResponsesProvider implements Provider {
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
    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: defaultHeaders && Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
      timeout: timeoutMs,
      maxRetries,
    })
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.client.responses.create({
      model: this.model,
      instructions: req.system,
      input: this.toResponseInput(req.messages),
      max_output_tokens: req.maxOutputTokens ?? 4096,
      temperature: req.temperature,
      top_p: req.topP,
      tools: req.tools.map((tool) => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
        strict: false,
      })),
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
      stream: true,
    })

    let finished = false
    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          yield { kind: 'text-delta', delta: event.delta }
          break
        case 'response.function_call_arguments.done': {
          let args: unknown = {}
          try {
            args = event.arguments ? JSON.parse(event.arguments) : {}
          } catch {
            args = {}
          }
          yield { kind: 'tool-call', id: event.item_id, name: event.name, args }
          break
        }
        case 'response.completed': {
          const usage = event.response.usage
          if (usage) {
            yield {
              kind: 'usage',
              promptTokens: usage.input_tokens,
              completionTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
            }
          }
          yield { kind: 'finish', stopReason: 'end_turn' }
          finished = true
          break
        }
        case 'response.incomplete': {
          const usage = event.response.usage
          if (usage) {
            yield {
              kind: 'usage',
              promptTokens: usage.input_tokens,
              completionTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
            }
          }
          yield { kind: 'finish', stopReason: 'max_tokens' }
          finished = true
          break
        }
        case 'response.failed':
          yield {
            kind: 'error',
            message: event.response.error?.message || 'The configured assistant provider rejected the request.',
          }
          yield { kind: 'finish', stopReason: 'error' }
          finished = true
          break
        case 'error':
          yield { kind: 'error', message: event.message || 'The configured assistant provider failed.' }
          yield { kind: 'finish', stopReason: 'error' }
          finished = true
          break
      }
    }

    if (!finished) {
      yield { kind: 'error', message: 'The configured assistant provider ended without completing the response.' }
      yield { kind: 'finish', stopReason: 'error' }
    }
  }

  private toResponseInput(messages: ChatMessage[]): OpenAI.Responses.ResponseInput {
    const input: OpenAI.Responses.ResponseInput = []
    for (const message of messages) {
      if (message.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId ?? 'unknown',
          output: message.content,
        })
        continue
      }

      if (message.role === 'assistant' && message.toolCalls?.length) {
        if (message.content) {
          input.push({ role: 'assistant', content: message.content })
        }
        for (const toolCall of message.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.args),
          })
        }
        continue
      }

      input.push({
        role: message.role === 'system' ? 'developer' : (message.role as 'user' | 'assistant'),
        content: message.content,
      })
    }
    return input
  }
}
