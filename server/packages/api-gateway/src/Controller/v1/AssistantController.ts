import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import {
  AssistantProviderConfig,
  configuredProviders,
  resolveProvider,
} from '../../Service/Assistant/providers/factory'
import { ChatMessage, ProviderEvent, ToolDescriptor } from '../../Service/Assistant/providers/types'

interface StreamRequestBody {
  provider?: string
  model?: string
  system?: string
  messages?: ChatMessage[]
  tools?: ToolDescriptor[]
}

/**
 * Stateless LLM streaming proxy. Standard Notes notes are end-to-end encrypted,
 * so the agent loop and ALL tools run in the browser. This controller only holds
 * the provider API key and forwards ONE model turn at a time as Server-Sent
 * Events. Tool execution never happens here.
 */
@controller('/v1/assistant', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
export class AssistantController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ASSISTANT_PROVIDER_CONFIG) private providerConfig: AssistantProviderConfig,
    @inject(TYPES.ApiGateway_ASSISTANT_DEFAULT_PROVIDER) private defaultProvider: string,
    @inject(TYPES.ApiGateway_ASSISTANT_DEFAULT_MODEL) private defaultModel: string,
  ) {
    super()
  }

  @httpGet('/config')
  async config(_request: Request, response: Response): Promise<void> {
    const providers = configuredProviders(this.providerConfig)

    response.json({
      providers,
      defaultProvider: providers.includes(this.defaultProvider) ? this.defaultProvider : (providers[0] ?? ''),
      defaultModel: this.defaultModel,
    })
  }

  @httpPost('/stream')
  async streamCompletion(request: Request, response: Response): Promise<void> {
    const body = (request.body ?? {}) as StreamRequestBody

    const providerId = body.provider || this.defaultProvider
    const model = body.model || this.defaultModel

    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()

    const writeEvent = (event: ProviderEvent): void => {
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    let provider
    try {
      provider = resolveProvider(providerId, model, this.providerConfig)
    } catch (error) {
      writeEvent({ kind: 'error', message: (error as Error).message })
      writeEvent({ kind: 'finish', stopReason: 'error' })
      response.end()
      return
    }

    let clientClosed = false
    request.on('close', () => {
      clientClosed = true
    })

    try {
      const stream = provider.send({
        system: body.system ?? '',
        messages: body.messages ?? [],
        tools: body.tools ?? [],
      })

      for await (const event of stream) {
        if (clientClosed) {
          break
        }
        writeEvent(event)
      }
    } catch (error) {
      writeEvent({ kind: 'error', message: (error as Error).message })
      writeEvent({ kind: 'finish', stopReason: 'error' })
    } finally {
      response.end()
    }
  }
}
