import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpDelete, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for email reminders. Every route proxies to
 * the auth server's `/email-reminders` controller behind the required cross-service
 * token middleware so the auth server receives the authenticated user on
 * `response.locals.user`.
 */
@controller('/v1/email-reminders')
export class EmailRemindersController extends BaseHttpController {
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
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'email-reminders/'),
      request.body,
    )
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'email-reminders/'),
      request.body,
    )
  }

  @httpDelete('/:reminderId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async delete(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'email-reminders/:reminderId',
        request.params.reminderId as string,
      ),
      request.body,
    )
  }
}
