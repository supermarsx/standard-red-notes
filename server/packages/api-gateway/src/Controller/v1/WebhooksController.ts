import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpDelete, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for outbound-webhook management. These
 * proxy to the auth server's `/webhooks` controller behind the required
 * cross-service token middleware, so the auth server receives the authenticated
 * user on `response.locals.user` and decoded roles on `response.locals.roles`
 * (used to authorize global/admin webhooks).
 *
 * AUTHENTICATION FOR INTEGRATIONS: n8n / Zapier / Typeform authenticate the same
 * way every other Standard Red Notes REST client does — they obtain a session
 * (e.g. via the MCP-token `/mcp-tokens/authenticate` flow, which mints a real
 * session without SRP) and present its bearer token; the gateway exchanges it
 * for a cross-service token. The webhook itself is then verified on the
 * RECEIVING side by the X-SRN-Signature HMAC, so the integration needs no extra
 * credential to trust inbound deliveries.
 */
@controller('/v1/webhooks')
export class WebhooksController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private httpService: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async list(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'webhooks/'),
      request.body,
    )
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'webhooks/'),
      request.body,
    )
  }

  @httpDelete('/:webhookId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async delete(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'webhooks/:webhookId',
        request.params.webhookId as string,
      ),
      request.body,
    )
  }
}
