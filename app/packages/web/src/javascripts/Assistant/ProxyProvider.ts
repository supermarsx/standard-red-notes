import { Provider, ProviderEvent, ProviderRequest } from './types'

export interface ProxyProviderOptions {
  /** Provider id understood by the server proxy (anthropic | openai | ollama). */
  provider: string
  model: string
  /**
   * Performs the authenticated POST to /v1/assistant/stream and resolves with
   * the raw streaming Response. Supplied by the React component which owns the
   * application's host + session token.
   */
  postStream: (body: unknown, signal?: AbortSignal) => Promise<Response>
  signal?: AbortSignal
}

/**
 * A Provider whose send() POSTs one model turn to the server-side LLM proxy and
 * parses the Server-Sent Events stream back into ProviderEvents. No provider API
 * key ever touches the browser.
 */
export class ProxyProvider implements Provider {
  readonly id: string

  constructor(private readonly options: ProxyProviderOptions) {
    this.id = options.provider
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const body = {
      provider: this.options.provider,
      model: this.options.model,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
    }

    let response: Response
    try {
      response = await this.options.postStream(body, this.options.signal)
    } catch (error) {
      yield { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    if (!response.ok || !response.body) {
      yield { kind: 'error', message: `assistant proxy: ${response.status} ${response.statusText}` }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line.
      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        const event = this.parseFrame(frame)
        if (event) {
          yield event
        }

        separatorIndex = buffer.indexOf('\n\n')
      }
    }

    const trailing = this.parseFrame(buffer)
    if (trailing) {
      yield trailing
    }
  }

  private parseFrame(frame: string): ProviderEvent | undefined {
    const dataLines: string[] = []
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.trimEnd()
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5))
      }
    }

    if (dataLines.length === 0) {
      return undefined
    }

    try {
      return JSON.parse(dataLines.join('\n')) as ProviderEvent
    } catch {
      return undefined
    }
  }
}
