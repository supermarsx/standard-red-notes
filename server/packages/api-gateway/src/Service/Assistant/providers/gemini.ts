import { Provider, ProviderRequest, ProviderEvent, ProviderStopReason } from './types'

/** Default base URL for the native Google Gemini (Generative Language) API. */
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: unknown }
  functionResponse?: { name?: string; response?: unknown }
}

interface GeminiContent {
  role?: 'user' | 'model'
  parts?: GeminiPart[]
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: GeminiContent
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Native Google Gemini provider. Uses the Generative Language API's
 * :streamGenerateContent endpoint with alt=sse, mapping our neutral
 * ProviderRequest onto Gemini's contents / system_instruction / tools shapes.
 * The API key is server-held (env ASSISTANT_GEMINI_API_KEY) and travels only in
 * the request query string — it is never echoed in any emitted event.
 */
export class GeminiProvider implements Provider {
  readonly id = 'gemini'
  private readonly baseURL: string
  private readonly apiKey: string

  constructor(
    private readonly model: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.baseURL = (env.ASSISTANT_GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '')
    this.apiKey = env.ASSISTANT_GEMINI_API_KEY ?? ''
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const contents: GeminiContent[] = []
    for (const m of req.messages) {
      if (m.role === 'system') {
        continue
      }
      if (m.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: m.name ?? 'tool', response: { content: m.content } } }],
        })
        continue
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts: GeminiPart[] = []
        if (m.content) {
          parts.push({ text: m.content })
        }
        for (const tc of m.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.args } })
        }
        contents.push({ role: 'model', parts })
        continue
      }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: req.maxOutputTokens ?? 4096, stopSequences: req.stop },
    }
    if (req.system) {
      body.system_instruction = { parts: [{ text: req.system }] }
    }
    if (req.tools.length) {
      body.tools = [
        {
          function_declarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ]
    }

    const url = `${this.baseURL}/models/${this.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!res.ok || !res.body) {
      yield { kind: 'error', message: `gemini: ${res.status} ${res.statusText}` }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let callIdx = 0
    let sawToolCall = false
    let usage: ProviderEvent | undefined
    let finish: ProviderEvent | undefined

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
        if (!trimmed.startsWith('data:')) {
          continue
        }
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') {
          continue
        }
        let chunk: GeminiStreamChunk
        try {
          chunk = JSON.parse(data) as GeminiStreamChunk
        } catch {
          continue
        }

        if (chunk.usageMetadata && !usage) {
          usage = {
            kind: 'usage',
            promptTokens: chunk.usageMetadata.promptTokenCount,
            completionTokens: chunk.usageMetadata.candidatesTokenCount,
            totalTokens: chunk.usageMetadata.totalTokenCount,
          }
        }

        const candidate = chunk.candidates?.[0]
        if (!candidate) {
          continue
        }

        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            yield { kind: 'text-delta', delta: part.text }
          }
          if (part.functionCall) {
            sawToolCall = true
            yield {
              kind: 'tool-call',
              id: `gemini_call_${callIdx++}`,
              name: part.functionCall.name ?? '',
              args: part.functionCall.args ?? {},
            }
          }
        }

        if (candidate.finishReason && !finish) {
          finish = { kind: 'finish', stopReason: mapGeminiFinish(candidate.finishReason, sawToolCall) }
        }
      }
    }

    if (usage) {
      yield usage
    }
    yield finish ?? { kind: 'finish', stopReason: sawToolCall ? 'tool_use' : 'end_turn' }
  }
}

function mapGeminiFinish(reason: string, sawToolCall: boolean): ProviderStopReason {
  if (sawToolCall) {
    return 'tool_use'
  }
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'STOP':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/**
 * Lists the Gemini model ids available to the server-held key. Best-effort:
 * returns [] on any non-OK response or thrown error, and never returns the key.
 */
export async function listGeminiModels(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    const baseURL = (env.ASSISTANT_GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '')
    const apiKey = env.ASSISTANT_GEMINI_API_KEY ?? ''
    const res = await fetch(`${baseURL}/models?key=${encodeURIComponent(apiKey)}`)
    if (!res.ok) {
      return []
    }
    const json = (await res.json()) as { models?: Array<{ name?: string }> }
    return (json.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name))
      .map((name) => name.replace(/^models\//, ''))
  } catch {
    return []
  }
}
