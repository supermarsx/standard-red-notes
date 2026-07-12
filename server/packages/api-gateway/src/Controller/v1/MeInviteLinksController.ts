import { Request, Response } from 'express'
import { inject } from 'inversify'
import { controller, BaseHttpController, httpDelete, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: SELF-SERVE / REFERRAL invite links. These proxy to the auth
 * server's authenticated `/users/me/invite-links` surface and are protected by the
 * required cross-service token middleware, so the auth controller receives the
 * authenticated user on `response.locals.user` and scopes every call to that user
 * (a user may only list/revoke their OWN links). This is distinct from the ADMIN
 * invite-link CRUD on AdminController — a self-serve link can never set a role /
 * domain override or auto-approve (the auth side enforces that privilege guard).
 * The feature is gated by the `registration.invitesPerUser` overlay (0 = disabled).
 */
@controller('/v1/users/me/invite-links')
export class MeInviteLinksController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private httpService: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'users/me/invite-links'),
      request.body,
    )
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async list(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'users/me/invite-links'),
      request.body,
    )
  }

  // Soft-revoke by uuid; the auth side re-checks ownership before revoking.
  @httpDelete('/:uuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async revoke(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'users/me/invite-links/:uuid',
        request.params.uuid as string,
      ),
      request.body,
    )
  }
}
