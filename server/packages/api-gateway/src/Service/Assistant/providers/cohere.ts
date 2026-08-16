import { Provider, ProviderRequest, ProviderEvent, ProviderStopReason } from './types'

/** Default base URL for the native Cohere v2 API. */
export const DEFAULT_COHERE_BASE_URL = 'https://api.cohere.com'

interface CohereToolCallDelta {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface CohereStreamEvent {
  type?: string
  index?: number
  delta?: {
    message?: {
      content?: { text?: string }
      tool_calls?: CohereToolCallDelta
    }
    finish_reason?: string
    usage?: {
      billed_units?: { input_tokens?: number; output_tokens?: number }
      tokens?: { input_tokens?: number; output_tokens?: number }
    }
  }
}

interface CohereMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

/**
 * Native Cohere provider. Uses the Cohere v2 /chat endpoint with stream:true and
 * parses Cohere's typed event stream (content-delta / tool-call-* / message-end).
 * The API key is server-held (env ASSISTANT_COHERE_API_KEY), sent as a bearer
 * token, and is never echoed in any emitted event.
 */
export class CohereProvider implements Provider {
  readonly id = 'cohere'
  private readonly baseURL: string
  private readonly apiKey: string

  constructor(
    private readonly model: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.baseURL = (env.ASSISTANT_COHERE_BASE_URL ?? DEFAULT_COHERE_BASE_URL).replace(/\/$/, '')
    this.apiKey = env.ASSISTANT_COHERE_API_KEY ?? ''
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages: CohereMessage[] = [{ role: 'system', content: req.system }]
    for (const m of req.messages) {
      if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: m.toolCallId ?? 'unknown', content: m.content })
        continue
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: m.content || '',
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        })
        continue
      }
      messages.push({ role: m.role as 'user' | 'assistant', content: m.content })
    }

    const body: Record<string, unknown> = { model: this.model, messages, stream: true }
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }))
    }

    const res = await fetch(`${this.baseURL}/v2/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!res.ok || !res.body) {
      yield { kind: 'error', message: `cohere: ${res.status} ${res.statusText}` }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const pendingTools = new Map<number, { id: string; name: string; argBuf: string }>()
    let usage: ProviderEvent | undefined

    const flushTool = (idx: number): ProviderEvent | undefined => {
      const pending = pendingTools.get(idx)
      if (!pending) {
        return undefined
      }
      pendingTools.delete(idx)
      let args: unknown = {}
      try {
        args = pending.argBuf ? JSON.parse(pending.argBuf) : {}
      } catch {
        args = {}
      }
      return { kind: 'tool-call', id: pending.id, name: pending.name, args }
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }
        const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
        if (!data || data === '[DONE]') {
          continue
        }
        let event: CohereStreamEvent
        try {
          event = JSON.parse(data) as CohereStreamEvent
        } catch {
          continue
        }

        const idx = event.index ?? 0
        switch (event.type) {
          case 'content-delta': {
            const text = event.delta?.message?.content?.text
            if (text) {
              yield { kind: 'text-delta', delta: text }
            }
            break
          }
          case 'tool-call-start': {
            const tc = event.delta?.message?.tool_calls
            pendingTools.set(idx, {
              id: tc?.id ?? `cohere_call_${idx}`,
              name: tc?.function?.name ?? '',
              argBuf: tc?.function?.arguments ?? '',
            })
            break
          }
          case 'tool-call-delta': {
            const pending = pendingTools.get(idx)
            if (pending) {
              pending.argBuf += event.delta?.message?.tool_calls?.function?.arguments ?? ''
            }
            break
          }
          case 'tool-call-end': {
            const call = flushTool(idx)
            if (call) {
              yield call
            }
            break
          }
          case 'message-end': {
            for (const key of [...pendingTools.keys()]) {
              const call = flushTool(key)
              if (call) {
                yield call
              }
            }
            const billed = event.delta?.usage?.billed_units ?? event.delta?.usage?.tokens
            if (billed) {
              const input = billed.input_tokens
              const output = billed.output_tokens
              usage = {
                kind: 'usage',
                promptTokens: input,
                completionTokens: output,
                totalTokens: typeof input === 'number' && typeof output === 'number' ? input + output : undefined,
              }
            }
            if (usage) {
              yield usage
            }
            yield { kind: 'finish', stopReason: mapCohereFinish(event.delta?.finish_reason) }
            return
          }
        }
      }
    }

    yield { kind: 'finish', stopReason: 'end_turn' }
  }
}

function mapCohereFinish(reason: string | undefined): ProviderStopReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'TOOL_CALL':
      return 'tool_use'
    case 'COMPLETE':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/**
 * Lists the Cohere model names available to the server-held key. Best-effort:
 * returns [] on any non-OK response or thrown error, and never returns the key.
 */
export async function listCohereModels(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    const baseURL = (env.ASSISTANT_COHERE_BASE_URL ?? DEFAULT_COHERE_BASE_URL).replace(/\/$/, '')
    const apiKey = env.ASSISTANT_COHERE_API_KEY ?? ''
    const res = await fetch(`${baseURL}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      return []
    }
    const json = (await res.json()) as { models?: Array<{ name?: string }> }
    return (json.models ?? []).map((entry) => entry.name).filter((name): name is string => Boolean(name))
  } catch {
    return []
  }
}
