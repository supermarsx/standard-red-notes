import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPut } from 'inversify-express-utils'
import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for the in-app admin panel. These proxy to
 * the auth server's `/admin` controller. They are protected by the required
 * cross-service token middleware so the auth server receives the decoded roles
 * on `response.locals.roles`, where the controller enforces the
 * INTERNAL_TEAM_USER role. The proxied endpoints themselves only expose the
 * per-user feature-flag setters/getters (never the broader unprotected admin
 * routes).
 */
@controller('/v1/admin')
export class AdminController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private serviceProxy: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpGet('/lookup-user/:email', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async lookupUser(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/lookup-user/:email',
        request.params.email as string,
      ),
      request.body,
    )
  }

  @httpGet('/users/:userUuid/feature-flags', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getUserFeatureFlags(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/users/:userUuid/feature-flags',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpPut('/users/:userUuid/feature-flags', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setUserFeatureFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/users/:userUuid/feature-flags',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/registration', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getRegistrationFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/registration'),
      request.body,
    )
  }

  @httpPut('/registration', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setRegistrationFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('PUT', 'admin/registration'),
      request.body,
    )
  }
}
