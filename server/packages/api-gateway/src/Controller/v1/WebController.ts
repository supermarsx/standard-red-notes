import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
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
  constructor(@inject(TYPES.ApiGateway_WebService) private webService: WebService) {
    super()
  }

  @httpPost('/fetch', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async fetch(request: Request, response: Response): Promise<void> {
    const body = (request.body ?? {}) as FetchRequestBody
    const url = typeof body.url === 'string' ? body.url : ''

    try {
      const result = await this.webService.fetch(url)
      response.json(result)
    } catch (error) {
      if (error instanceof WebValidationError) {
        // Blocked / malformed / timeout: a 400 with a safe message + tag.
        response.status(400).json({ error: { tag: error.tag, message: error.message } })
        return
      }
      response.status(502).json({ error: { tag: 'fetch-failed', message: 'Failed to fetch the URL.' } })
    }
  }

  @httpPost('/search', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async search(request: Request, response: Response): Promise<void> {
    const body = (request.body ?? {}) as SearchRequestBody
    const query = typeof body.query === 'string' ? body.query : ''

    // Missing/unconfigured search must NOT 500: WebService.search returns
    // { results: [], error } and we always answer 200.
    const result = await this.webService.search(query)
    response.json(result)
  }
}
