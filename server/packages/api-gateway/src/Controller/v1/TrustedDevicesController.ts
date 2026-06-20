import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpDelete, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for the trusted-device subsystem. Every
 * route proxies to the auth server's `/trusted-devices` controller behind the
 * required cross-service token middleware, so the auth server receives the
 * authenticated user on `response.locals.user`. Marking a device trusted is
 * therefore only possible from an already authenticated (already-2FA'd) session.
 */
@controller('/v1/trusted-devices')
export class TrustedDevicesController extends BaseHttpController {
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
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'trusted-devices/'),
      request.body,
    )
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'trusted-devices/'),
      request.body,
    )
  }

  @httpDelete('/:deviceId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async delete(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'trusted-devices/:deviceId',
        request.params.deviceId as string,
      ),
      request.body,
    )
  }
}
