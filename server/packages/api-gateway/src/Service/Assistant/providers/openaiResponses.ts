import OpenAI from 'openai'
import { Buffer } from 'node:buffer'

import { AssistantToolCall, ChatMessage, Provider, ProviderEvent, ProviderReplayState, ProviderRequest } from './types'
import { openAIStreamErrorMessage, openAIToolNamesForRequest } from './OpenAIToolNameMap'

const MAX_REPLAY_OUTPUT_ITEMS = 256
const MAX_REPLAY_ENCODED_BYTES = 8 * 1024 * 1024
const REPLAY_PROTOCOL = 'openai-responses' as const
const REASONING_ITEM_FIELDS = new Set(['type', 'id', 'summary', 'content', 'encrypted_content', 'status'])
const REASONING_SUMMARY_FIELDS = new Set(['type', 'text'])
const FUNCTION_CALL_FIELDS = new Set([
  'type',
  'id',
  'call_id',
  'name',
  'arguments',
  'caller',
  'namespace',
  'status',
  'created_by',
])
const FUNCTION_CALLER_DIRECT_FIELDS = new Set(['type'])
const FUNCTION_CALLER_PROGRAM_FIELDS = new Set(['type', 'caller_id'])
const OUTPUT_MESSAGE_FIELDS = new Set(['type', 'id', 'content', 'role', 'status', 'phase'])
const OUTPUT_TEXT_FIELDS = new Set(['type', 'text', 'annotations', 'logprobs'])
const OUTPUT_REFUSAL_FIELDS = new Set(['type', 'refusal'])

type ReplayOutputItem =
  | OpenAI.Responses.ResponseReasoningItem
  | OpenAI.Responses.ResponseFunctionToolCall
  | OpenAI.Responses.ResponseOutputMessage

type ExpectedReplayToolCall = {
  id: string
  wireName: string
  args: unknown
}

type PendingResponseToolCall = {
  callId?: string
  name?: string
  arguments?: string
  emitted: boolean
}

type CompletedResponseToolCall = {
  event: Extract<ProviderEvent, { kind: 'tool-call' }>
  replay: ExpectedReplayToolCall
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidReplay(reason: string): Error {
  return new Error(`The OpenAI Responses continuation is invalid: ${reason}.`)
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('non-finite JSON number')
    }
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new Error('non-JSON value')
  }
  if (ancestors.has(value)) {
    throw new Error('cyclic JSON value')
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function canonicalFunctionArguments(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  try {
    return canonicalJson(value)
  } catch {
    return undefined
  }
}

function parseFunctionArguments(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return canonicalFunctionArguments(parsed) === undefined ? undefined : (parsed as Record<string, unknown>)
  } catch {
    return undefined
  }
}

function assertOnlyReplayFields(item: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(item).find((key) => !allowed.has(key))
  if (unknown) {
    throw invalidReplay(`${label} contains unsupported field ${unknown}`)
  }
}

function validOutputStatus(value: unknown): boolean {
  return value === undefined || value === 'in_progress' || value === 'completed' || value === 'incomplete'
}

function validateReplayOutputItems(value: unknown): ReplayOutputItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPLAY_OUTPUT_ITEMS) {
    throw invalidReplay('the output item count is outside the supported range')
  }

  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string') {
      throw invalidReplay('an output item is malformed')
    }

    if (item.type === 'reasoning') {
      assertOnlyReplayFields(item, REASONING_ITEM_FIELDS, 'a reasoning item')
      if (
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        !Array.isArray(item.summary) ||
        typeof item.encrypted_content !== 'string' ||
        item.encrypted_content.length === 0
      ) {
        throw invalidReplay('a reasoning item is missing encrypted continuation data')
      }
      if (!validOutputStatus(item.status)) {
        throw invalidReplay('a reasoning item has an invalid status')
      }
      for (const summary of item.summary) {
        if (!isRecord(summary)) {
          throw invalidReplay('a reasoning summary is malformed')
        }
        assertOnlyReplayFields(summary, REASONING_SUMMARY_FIELDS, 'a reasoning summary')
        if (summary.type !== 'summary_text' || typeof summary.text !== 'string') {
          throw invalidReplay('a reasoning summary is malformed')
        }
      }
      if (
        item.content !== undefined &&
        item.content !== null &&
        (!Array.isArray(item.content) || item.content.length > 0)
      ) {
        throw invalidReplay('plaintext reasoning content cannot leave the server')
      }
      continue
    }

    if (item.type === 'function_call') {
      assertOnlyReplayFields(item, FUNCTION_CALL_FIELDS, 'a function call')
      if (
        typeof item.call_id !== 'string' ||
        item.call_id.length === 0 ||
        typeof item.name !== 'string' ||
        item.name.length === 0 ||
        typeof item.arguments !== 'string'
      ) {
        throw invalidReplay('a function call is malformed')
      }
      if (
        (item.id !== undefined && (typeof item.id !== 'string' || item.id.length === 0)) ||
        (item.namespace !== undefined && typeof item.namespace !== 'string') ||
        (item.created_by !== undefined && typeof item.created_by !== 'string') ||
        !validOutputStatus(item.status)
      ) {
        throw invalidReplay('a function call is malformed')
      }
      if (item.caller !== undefined && item.caller !== null) {
        if (!isRecord(item.caller)) {
          throw invalidReplay('a function call caller is malformed')
        }
        if (item.caller.type === 'direct') {
          assertOnlyReplayFields(item.caller, FUNCTION_CALLER_DIRECT_FIELDS, 'a function call caller')
        } else if (item.caller.type === 'program') {
          assertOnlyReplayFields(item.caller, FUNCTION_CALLER_PROGRAM_FIELDS, 'a function call caller')
          if (typeof item.caller.caller_id !== 'string' || item.caller.caller_id.length === 0) {
            throw invalidReplay('a function call caller is malformed')
          }
        } else {
          throw invalidReplay('a function call caller is malformed')
        }
      }
      continue
    }

    if (item.type === 'message') {
      assertOnlyReplayFields(item, OUTPUT_MESSAGE_FIELDS, 'an output message')
      if (
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        item.role !== 'assistant' ||
        !Array.isArray(item.content)
      ) {
        throw invalidReplay('an output message is malformed')
      }
      if (
        !validOutputStatus(item.status) ||
        (item.phase !== undefined &&
          item.phase !== null &&
          item.phase !== 'commentary' &&
          item.phase !== 'final_answer')
      ) {
        throw invalidReplay('an output message is malformed')
      }
      for (const content of item.content) {
        if (!isRecord(content)) {
          throw invalidReplay('output message content is malformed')
        }
        if (content.type === 'output_text') {
          assertOnlyReplayFields(content, OUTPUT_TEXT_FIELDS, 'output text')
          if (
            typeof content.text !== 'string' ||
            !Array.isArray(content.annotations) ||
            (content.logprobs !== undefined && !Array.isArray(content.logprobs))
          ) {
            throw invalidReplay('output message content is malformed')
          }
        } else if (content.type === 'refusal') {
          assertOnlyReplayFields(content, OUTPUT_REFUSAL_FIELDS, 'output refusal')
          if (typeof content.refusal !== 'string') {
            throw invalidReplay('output message content is malformed')
          }
        } else {
          throw invalidReplay('output message content is malformed')
        }
      }
      continue
    }

    throw invalidReplay(`unsupported output item type ${item.type}`)
  }

  return value as ReplayOutputItem[]
}

function assertReplayToolLinkage(
  items: ReplayOutputItem[],
  expectedToolCalls: ReadonlyArray<ExpectedReplayToolCall>,
): void {
  const expected = new Map<string, { wireName: string; canonicalArguments: string }>()
  for (const call of expectedToolCalls) {
    if (!call.id || expected.has(call.id)) {
      throw invalidReplay('assistant tool call ids are missing or duplicated')
    }
    const canonicalArguments = canonicalFunctionArguments(call.args)
    if (canonicalArguments === undefined) {
      throw invalidReplay('assistant function call arguments are malformed')
    }
    expected.set(call.id, { wireName: call.wireName, canonicalArguments })
  }

  const actual = items.filter(
    (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
  )
  if (actual.length !== expected.size) {
    throw invalidReplay('function calls do not match the assistant turn')
  }

  const seen = new Set<string>()
  for (const call of actual) {
    const expectedCall = expected.get(call.call_id)
    const actualArguments = parseFunctionArguments(call.arguments)
    const canonicalArguments = actualArguments && canonicalFunctionArguments(actualArguments)
    if (
      seen.has(call.call_id) ||
      !expectedCall ||
      expectedCall.wireName !== call.name ||
      canonicalArguments === undefined ||
      expectedCall.canonicalArguments !== canonicalArguments
    ) {
      throw invalidReplay('function call ids, names, or arguments do not match the assistant turn')
    }
    seen.add(call.call_id)
  }
}

function encodeProviderReplay(
  output: unknown,
  expectedToolCalls: ReadonlyArray<ExpectedReplayToolCall>,
): ProviderReplayState {
  const items = validateReplayOutputItems(output)
  assertReplayToolLinkage(items, expectedToolCalls)
  const encodedOutput = Buffer.from(JSON.stringify(items), 'utf8').toString('base64url')
  if (encodedOutput.length === 0 || encodedOutput.length > MAX_REPLAY_ENCODED_BYTES) {
    throw invalidReplay('the encoded output is outside the supported size')
  }
  return { protocol: REPLAY_PROTOCOL, version: 1, encodedOutput }
}

function decodeProviderReplay(
  replay: ProviderReplayState,
  toolCalls: AssistantToolCall[],
  toWireName: (internalName: string) => string,
): OpenAI.Responses.ResponseInput {
  if (
    !isRecord(replay) ||
    replay.protocol !== REPLAY_PROTOCOL ||
    replay.version !== 1 ||
    typeof replay.encodedOutput !== 'string' ||
    replay.encodedOutput.length === 0 ||
    replay.encodedOutput.length > MAX_REPLAY_ENCODED_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(replay.encodedOutput)
  ) {
    throw invalidReplay('the envelope is malformed')
  }

  const decoded = Buffer.from(replay.encodedOutput, 'base64url')
  if (decoded.toString('base64url') !== replay.encodedOutput) {
    throw invalidReplay('the payload is not canonical base64url')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw invalidReplay('the payload is not valid JSON')
  }

  const items = validateReplayOutputItems(parsed)
  assertReplayToolLinkage(
    items,
    toolCalls.map((call) => ({ id: call.id, wireName: toWireName(call.name), args: call.args })),
  )
  return items as OpenAI.Responses.ResponseInput
}

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
    const toolNames = openAIToolNamesForRequest(req.tools, req.messages)
    const tools = req.tools.map((tool) => ({
      type: 'function' as const,
      name: toolNames.toWireName(tool.name),
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
      strict: false,
    }))
    let input: OpenAI.Responses.ResponseInput
    try {
      input = this.toResponseInput(req.messages, toolNames.toWireName)
    } catch (error) {
      yield {
        kind: 'error',
        message: error instanceof Error ? error.message : 'The OpenAI Responses continuation is invalid.',
      }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const stream = await this.client.responses.create(
      {
        model: this.model,
        instructions: req.system,
        input,
        ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
        temperature: req.temperature,
        top_p: req.topP,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const, parallel_tool_calls: true } : {}),
        store: false,
        stream: true,
      },
      { signal: req.signal },
    )

    const pendingToolCalls = new Map<string, PendingResponseToolCall>()
    const completedOutputItems = new Map<number, OpenAI.Responses.ResponseOutputItem>()
    const takeCompletedToolCall = (itemId: string): CompletedResponseToolCall | undefined => {
      const pending = pendingToolCalls.get(itemId)
      if (!pending || pending.emitted || !pending.callId || !pending.name || pending.arguments === undefined) {
        return undefined
      }
      const args = parseFunctionArguments(pending.arguments)
      if (!args) {
        throw new Error('The configured assistant provider returned malformed function-call arguments.')
      }
      pending.emitted = true
      return {
        event: {
          kind: 'tool-call',
          id: pending.callId,
          name: toolNames.toInternalName(pending.name),
          args,
        },
        replay: { id: pending.callId, wireName: pending.name, args },
      }
    }
    const mergeFunctionItem = (
      item: {
        id?: string
        call_id: string
        name: string
        arguments: string
      },
      argumentsFinalized: boolean,
    ): string => {
      const itemKey =
        item.id ??
        [...pendingToolCalls.entries()].find(([, pending]) => pending.callId === item.call_id)?.[0] ??
        `call:${item.call_id}`
      const pending = pendingToolCalls.get(itemKey) ?? { emitted: false }
      pending.callId = item.call_id
      pending.name = item.name
      if (argumentsFinalized && pending.arguments === undefined) {
        pending.arguments = item.arguments
      }
      pendingToolCalls.set(itemKey, pending)
      return itemKey
    }

    for await (const event of stream) {
      const streamError = openAIStreamErrorMessage(event)
      if (streamError) {
        yield { kind: 'error', message: streamError }
        yield { kind: 'finish', stopReason: 'error' }
        return
      }
      switch (event.type) {
        case 'response.output_text.delta':
          yield { kind: 'text-delta', delta: event.delta }
          break
        case 'response.output_item.added': {
          if (event.item.type !== 'function_call') {
            break
          }
          mergeFunctionItem(event.item, false)
          break
        }
        case 'response.function_call_arguments.done': {
          const pending = pendingToolCalls.get(event.item_id) ?? { emitted: false }
          pending.name = event.name
          if (pending.arguments === undefined) {
            pending.arguments = event.arguments
          }
          pendingToolCalls.set(event.item_id, pending)
          break
        }
        case 'response.output_item.done': {
          completedOutputItems.set(event.output_index, event.item)
          if (event.item.type !== 'function_call') {
            break
          }
          mergeFunctionItem(event.item, true)
          break
        }
        case 'response.completed': {
          const responseOutput =
            event.response.output.length > 0
              ? event.response.output
              : [...completedOutputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
          const completedToolCalls: CompletedResponseToolCall[] = []
          try {
            for (const item of responseOutput) {
              if (item.type !== 'function_call') {
                continue
              }
              const itemKey = mergeFunctionItem(item, true)
              const toolCall = takeCompletedToolCall(itemKey)
              if (toolCall) {
                completedToolCalls.push(toolCall)
              }
            }
          } catch (error) {
            yield {
              kind: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : 'The configured assistant provider returned malformed function-call arguments.',
            }
            yield { kind: 'finish', stopReason: 'error' }
            return
          }
          if ([...pendingToolCalls.values()].some((pending) => !pending.emitted)) {
            yield {
              kind: 'error',
              message: 'The configured assistant provider returned an incomplete function call.',
            }
            yield { kind: 'finish', stopReason: 'error' }
            return
          }
          let providerReplay: ProviderReplayState | undefined
          if (completedToolCalls.length > 0) {
            try {
              providerReplay = encodeProviderReplay(
                responseOutput,
                completedToolCalls.map((toolCall) => toolCall.replay),
              )
            } catch (error) {
              yield {
                kind: 'error',
                message: error instanceof Error ? error.message : 'The OpenAI Responses continuation is invalid.',
              }
              yield { kind: 'finish', stopReason: 'error' }
              return
            }
          }
          for (const toolCall of completedToolCalls) {
            yield toolCall.event
          }
          const usage = event.response.usage
          if (usage) {
            yield {
              kind: 'usage',
              promptTokens: usage.input_tokens,
              completionTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
            }
          }
          yield {
            kind: 'finish',
            stopReason: completedToolCalls.length > 0 ? 'tool_use' : 'end_turn',
            ...(providerReplay ? { providerReplay } : {}),
          }
          return
        }
        case 'response.incomplete': {
          const incompleteHasFunctionCalls =
            pendingToolCalls.size > 0 || (event.response.output ?? []).some((item) => item.type === 'function_call')
          if (incompleteHasFunctionCalls) {
            yield {
              kind: 'error',
              message: 'The configured assistant provider returned an incomplete function call. No tools were run.',
            }
            yield { kind: 'finish', stopReason: 'error' }
            return
          }
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
          return
        }
        case 'response.failed':
          yield {
            kind: 'error',
            message: event.response.error?.message || 'The configured assistant provider rejected the request.',
          }
          yield { kind: 'finish', stopReason: 'error' }
          return
        case 'error':
          yield { kind: 'error', message: event.message || 'The configured assistant provider failed.' }
          yield { kind: 'finish', stopReason: 'error' }
          return
      }
    }

    yield { kind: 'error', message: 'The configured assistant provider ended without completing the response.' }
    yield { kind: 'finish', stopReason: 'error' }
  }

  private toResponseInput(
    messages: ChatMessage[],
    toWireName: (internalName: string) => string,
  ): OpenAI.Responses.ResponseInput {
    const input: OpenAI.Responses.ResponseInput = []
    for (const message of messages) {
      if (message.providerReplay) {
        if (message.role !== 'assistant') {
          throw invalidReplay('only assistant turns can carry provider output')
        }
        input.push(...decodeProviderReplay(message.providerReplay, message.toolCalls ?? [], toWireName))
        continue
      }

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
            name: toWireName(toolCall.name),
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
