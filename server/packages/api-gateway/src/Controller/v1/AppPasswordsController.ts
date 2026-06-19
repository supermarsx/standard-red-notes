import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpDelete, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for app-specific passwords. These proxy to
 * the auth server's `/app-passwords` controller and are protected by the
 * required cross-service token middleware so the auth server receives the
 * authenticated user on `response.locals.user`. App passwords let headless
 * clients (e.g. the MCP bridge) satisfy the 2FA challenge without an
 * interactive TOTP code; see the auth server's VerifyAppPassword/BaseAuthController.
 */
@controller('/v1/app-passwords')
export class AppPasswordsController extends BaseHttpController {
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
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'app-passwords/'),
      request.body,
    )
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'app-passwords/'),
      request.body,
    )
  }

  @httpDelete('/:appPasswordId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async delete(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'app-passwords/:appPasswordId',
        request.params.appPasswordId as string,
      ),
      request.body,
    )
  }
}
