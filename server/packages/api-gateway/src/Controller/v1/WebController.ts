import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'
import { WebService, WebValidationError } from '../../Service/Web/WebService'

interface FetchRequestBody {
  url?: string
}

interface SearchRequestBody {
  query?: string
}

/**
 * Standard Red Notes: server-side WEB proxy for the in-browser AI agent.
 *
 * The AI agent runs in the browser (notes are E2E encrypted). To do web
 * research it needs server-side fetch (no CORS) and search with a server-held
 * key. Both routes mirror the assistant proxy: they are AUTHENTICATED with the
 * same RequiredCrossServiceTokenMiddleware (valid user session) so this is never
 * an open proxy. The fetch route additionally runs an SSRF guard in WebService
 * (see assertPublicHttpUrl).
 */
@controller('/v1/web')
export class WebController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_WebService) private webService: WebService,
    @inject(TYPES.ApiGateway_ServerSettingsResolver) private settings?: ServerSettingsResolver,
  ) {
    super()
  }

  private async admitInternetAccess(response: Response): Promise<boolean> {
    try {
      if (!this.settings) {
        throw new Error('Internet access policy resolver is unavailable.')
      }
      if (!(await this.settings.resolveAssistantInternetAccessEnabled())) {
        response
          .status(403)
          .json({ error: { tag: 'internet-access-disabled', message: 'Internet access is disabled by this server.' } })
        return false
      }
      return true
    } catch {
      response.status(503).json({
        error: { tag: 'internet-access-policy-unavailable', message: 'The internet access policy is unavailable.' },
      })
      return false
    }
  }

  @httpPost('/fetch', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async fetch(request: Request, response: Response): Promise<void> {
    if (!(await this.admitInternetAccess(response))) {
      return
    }
    const body = (request.body ?? {}) as FetchRequestBody
    const url = typeof body.url === 'string' ? body.url : ''

    try {
      const result = await this.webService.fetch(url)
      response.json(result)
    } catch (error) {
      if (error instanceof WebValidationError) {
        const status =
          error.tag === 'response-too-large'
            ? 413
            : error.tag === 'fetch-timeout'
              ? 504
              : error.tag === 'fetch-failed'
                ? 502
                : 400
        response.status(status).json({ error: { tag: error.tag, message: error.message } })
        return
      }
      response.status(502).json({ error: { tag: 'fetch-failed', message: 'Failed to fetch the URL.' } })
    }
  }

  @httpPost('/search', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async search(request: Request, response: Response): Promise<void> {
    if (!(await this.admitInternetAccess(response))) {
      return
    }
    const body = (request.body ?? {}) as SearchRequestBody
    const query = typeof body.query === 'string' ? body.query : ''

    // Missing/unconfigured search must NOT 500: WebService.search returns
    // { results: [], error } and we always answer 200.
    const result = await this.webService.search(query)
    response.json(result)
  }
}
