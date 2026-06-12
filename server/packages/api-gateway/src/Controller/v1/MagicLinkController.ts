import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

@controller('/v1/mfa/magic-link')
export class MagicLinkController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private httpService: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpPost('/request')
  async request(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'mfa/magic-link/request'),
      request.body,
    )
  }

  @httpPost('/status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setStatus(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'mfa/magic-link/status'),
      request.body,
    )
  }

  @httpGet('/status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getStatus(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'mfa/magic-link/status'),
      request.body,
    )
  }
}
