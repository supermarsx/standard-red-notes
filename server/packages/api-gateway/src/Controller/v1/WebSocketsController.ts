import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: only the connection-token mint lives here. The AWS-era
 * `POST/DELETE /connections` lifecycle hooks (API Gateway `$connect` /
 * `$disconnect` callbacks) forwarded a caller-supplied `connectionid` header,
 * unencoded, into a loopback request against this same process — the DELETE
 * behind no auth at all — and the in-process gateway manages connection
 * lifecycle itself, so nothing ever called them. Deleted rather than guarded:
 * there is no consumer to keep, and with them went `WebSocketAuthMiddleware`
 * and `GRPCWebSocketAuthMiddleware`, which existed only to guard the POST.
 */
@controller('/v1/sockets')
export class WebSocketsController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private httpService: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpPost('/tokens', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async createWebSocketConnectionToken(request: Request, response: Response): Promise<void> {
    await this.httpService.callWebSocketServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'sockets/tokens'),
      request.body,
    )
  }
}
