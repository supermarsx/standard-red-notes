import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpDelete, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for share links. The list/create/revoke
 * routes proxy to the auth server's `/shares` controller behind the required
 * cross-service token middleware so the auth server receives the authenticated
 * user on `response.locals.user`.
 *
 * The public GET `/:shareId` route is intentionally UNAUTHENTICATED: anyone with
 * the share link id can fetch the opaque, client-encrypted ciphertext. The
 * decryption key lives only in the link fragment and never reaches the server.
 */
@controller('/v1/shares')
export class SharesController extends BaseHttpController {
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
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'shares/'),
      request.body,
    )
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'shares/'),
      request.body,
    )
  }

  @httpDelete('/:shareId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async revoke(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('DELETE', 'shares/:shareId', request.params.shareId as string),
      request.body,
    )
  }

  // UNAUTHENTICATED on purpose: public read of the opaque ciphertext by link id.
  @httpGet('/:shareId')
  async get(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'shares/:shareId', request.params.shareId as string),
      request.body,
    )
  }
}
