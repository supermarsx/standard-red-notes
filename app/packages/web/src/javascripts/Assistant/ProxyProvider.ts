import { assistantUsageService } from './AssistantUsageService'
import { assistantHttpError, assistantNetworkError } from './AssistantHttpError'
import { samplingRequestFields, SamplingSettings } from './samplingSettings'
import { Provider, ProviderEvent, ProviderRequest } from './types'

const MALFORMED_PROXY_FRAME = Symbol('malformed-proxy-frame')

function normalizeSseBuffer(buffer: string, streamEnded = false): string {
  const hasIncompleteCrLf = !streamEnded && buffer.endsWith('\r')
  const complete = hasIncompleteCrLf ? buffer.slice(0, -1) : buffer
  return complete.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + (hasIncompleteCrLf ? '\r' : '')
}

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
  /**
   * Sampling parameters forwarded to the server proxy. When omitted the provider
   * reads the user's saved {@link loadSamplingSettings} values. The server may
   * apply or ignore these; sending them is harmless to older servers.
   */
  sampling?: SamplingSettings
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
      ...(this.options.provider ? { provider: this.options.provider } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      // User-configurable sampling (temperature / top_p / optional max_tokens);
      // the server proxy applies these to the upstream provider call.
      ...samplingRequestFields(this.options.sampling),
    }

    let response: Response
    try {
      response = await this.options.postStream(body, this.options.signal)
    } catch (error) {
      yield { kind: 'error', message: assistantNetworkError(error, 'proxy') }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    if (!response.ok || !response.body) {
      yield { kind: 'error', message: await assistantHttpError(response, 'proxy') }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: Extract<ProviderEvent, { kind: 'usage' }> | undefined
    let finished = false
    let failed = false

    const observe = (event: ProviderEvent): void => {
      if (event.kind === 'usage') {
        usage = event
      } else if (event.kind === 'error') {
        failed = true
      } else if (event.kind === 'finish') {
        finished = true
        failed = failed || event.stopReason === 'error'
      }
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          buffer = normalizeSseBuffer(buffer, true)
          break
        }
        buffer += decoder.decode(value, { stream: true })
        buffer = normalizeSseBuffer(buffer)

        // SSE frames are separated by a blank line.
        let separatorIndex = buffer.indexOf('\n\n')
        while (separatorIndex !== -1) {
          const frame = buffer.slice(0, separatorIndex)
          buffer = buffer.slice(separatorIndex + 2)

          const event = this.parseFrame(frame)
          if (event === MALFORMED_PROXY_FRAME) {
            failed = true
            try {
              await reader.cancel()
            } catch {
              // The malformed stream is already terminal; cancellation is best effort.
            }
            yield { kind: 'error', message: 'The assistant proxy returned malformed stream data.' }
            yield { kind: 'finish', stopReason: 'error' }
            return
          }
          if (event) {
            observe(event)
            yield event
          }

          separatorIndex = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      yield { kind: 'error', message: assistantNetworkError(error, 'proxy') }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }

    const trailing = this.parseFrame(buffer)
    if (trailing === MALFORMED_PROXY_FRAME) {
      yield { kind: 'error', message: 'The assistant proxy returned malformed stream data.' }
      yield { kind: 'finish', stopReason: 'error' }
      return
    }
    if (trailing) {
      observe(trailing)
      yield trailing
    }

    if (!finished) {
      if (!failed) {
        failed = true
        yield {
          kind: 'error',
          message: 'The assistant proxy ended before reporting a completion reason.',
        }
      }
      yield { kind: 'finish', stopReason: 'error' }
    }

    // Commit local counters only after a non-error terminal event. The server's
    // quota has the same success boundary, so failed/truncated requests remain
    // absent from both displays even if an upstream sent an early usage frame.
    if (!failed && finished) {
      assistantUsageService.record(
        usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : {},
      )
    }
  }

  private parseFrame(frame: string): ProviderEvent | typeof MALFORMED_PROXY_FRAME | undefined {
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
      return MALFORMED_PROXY_FRAME
    }
  }
}
